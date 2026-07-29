"use client";

import { useRouter } from "next/navigation";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { formatCents } from "@/lib/money";
import { computeSpineLayout, spineDescription, type SpineArc } from "@/lib/transfer-flow-layout";
import type { TransferFlowData } from "@/services/transfer-flow";

/**
 * "The Spine" — the 2D transfer-flow renderer.
 *
 * Geometry is pure (`transfer-flow-layout.ts`); this owns colour, hover, focus
 * and drill, exactly as `SankeyChart` does for the Sankey.
 *
 * Read the chart like this: accounts are stacked by net position, sources at the
 * top and sinks at the bottom. An arc bulging RIGHT is money moving toward its
 * net destination; an arc bulging LEFT is money coming back. So the left-hand
 * region IS the round-trip churn — flip to Net and watch it empty out.
 *
 * A11Y NOTE — deliberately NOT `role="img"`. The spec proposed it, but this
 * codebase already learned (see SankeyChart) that `role="img"` PRUNES nested
 * interactive content from the accessibility tree, which would silently destroy
 * the keyboard path to every arc and node. A `<title>` + `<desc>` pair names the
 * chart without pruning anything, and each arc is its own focusable button.
 */

const DEFAULT_WIDTH = 860;
const DIM_OPACITY = 0.1;
const REST_OPACITY = 0.62;
const HOT_OPACITY = 1;

export interface TransferSpineProps {
  data: TransferFlowData;
  measure: "gross" | "net";
  /** hover is LIFTED so the spine and the rhythm rail can highlight together */
  hoveredEdgeId?: string | null;
  onHoverEdge?: (id: string | null) => void;
  /** where an arc drills to; omit to make arcs non-navigable */
  hrefForEdge?: (arc: SpineArc) => string;
  heightClass?: string;
  emptyLabel?: string;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

export function TransferSpine({
  data,
  measure,
  hoveredEdgeId,
  onHoverEdge,
  hrefForEdge,
  heightClass = "h-[26rem]",
  emptyLabel = "No transfers between your accounts in this period.",
}: TransferSpineProps) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [innerHover, setInnerHover] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  // controlled when the page lifts hover, uncontrolled otherwise
  const hovered = hoveredEdgeId !== undefined ? hoveredEdgeId : innerHover;
  const setHovered = (id: string | null) => {
    if (onHoverEdge) onHoverEdge(id);
    else setInnerHover(id);
  };

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measureEl = () => setWidth(el.clientWidth || DEFAULT_WIDTH);
    measureEl();
    const ro = new ResizeObserver(measureEl);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () => computeSpineLayout(data, measure, { width }),
    [data, measure, width],
  );
  const description = useMemo(() => spineDescription(data, formatCents), [data]);

  const nodeById = useMemo(
    () => new Map(layout.nodes.map((n) => [n.id, n])),
    [layout.nodes],
  );
  const labelFor = (id: string) => nodeById.get(id)?.label ?? id;

  if (layout.arcs.length === 0) {
    return (
      <div className={`flex w-full items-center justify-center ${heightClass}`}>
        <p className="text-sm text-ink-muted">{emptyLabel}</p>
      </div>
    );
  }

  const isLit = (arc: SpineArc) => hovered === null || hovered === arc.id;

  function arcLabel(arc: SpineArc): string {
    const from = labelFor(arc.fromAccountId);
    const to = labelFor(arc.toAccountId);
    const plural = arc.count === 1 ? "transfer" : "transfers";
    const base = `${from} to ${to}, ${formatCents(arc.cents)} over ${arc.count} ${plural}`;
    if (measure === "net" && arc.returnedCents > 0) {
      return `${base} net; ${formatCents(arc.grossCents)} gross, ${formatCents(arc.returnedCents)} came back.${hrefForEdge ? " Activate to view the transactions." : ""}`;
    }
    return `${base}.${hrefForEdge ? " Activate to view the transactions." : ""}`;
  }

  function tooltipLines(arc: SpineArc): string[] {
    if (measure === "net" && arc.returnedCents > 0) {
      return [
        `${formatCents(arc.cents)} net`,
        `${formatCents(arc.grossCents)} gross · ${formatCents(arc.returnedCents)} came back`,
        `${arc.count} transfers`,
      ];
    }
    const avg = arc.count > 0 ? Math.round(arc.cents / arc.count) : 0;
    return [
      formatCents(arc.cents),
      `${arc.count} ${arc.count === 1 ? "transfer" : "transfers"} · avg ${formatCents(avg)}`,
    ];
  }

  function moveTooltip(e: ReactPointerEvent, arc: SpineArc) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      title: `${labelFor(arc.fromAccountId)} → ${labelFor(arc.toAccountId)}`,
      lines: tooltipLines(arc),
    });
  }

  function drill(arc: SpineArc, e: ReactMouseEvent) {
    if (!hrefForEdge) return;
    // honour modified / non-primary clicks so ⌘/Ctrl/middle-click keep their
    // native open-in-new-tab behaviour on the real <a href>
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    router.push(hrefForEdge(arc));
  }

  function onArcKey(arc: SpineArc, e: ReactKeyboardEvent) {
    if (!hrefForEdge) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    router.push(hrefForEdge(arc));
  }

  const motion = reducedMotion ? "" : "transition-opacity duration-(--duration-fast)";
  // The dash GAP encodes count and is static. Only the DRIFT is motion, so
  // turning motion off costs nothing that carries meaning.
  const drift = !reducedMotion;

  return (
    // The height is the LAYOUT's, not a fixed class: the spine grows by one
    // NODE_GAP per account, so a fixed h-[26rem] silently clipped the bottom
    // node the moment a sixth account appeared. `heightClass` is kept only as
    // the empty-state and focus-dialog hook.
    <div ref={containerRef} className="relative w-full">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-labelledby={`${titleId} ${descId}`}
        className="block max-w-full overflow-visible"
        onPointerLeave={() => {
          setHovered(null);
          setTooltip(null);
        }}
      >
        <title id={titleId}>
          {measure === "net" ? "Net transfers between your accounts" : "All transfers between your accounts"}
        </title>
        <desc id={descId}>{description}</desc>

        {/* the return region: tinted only when something actually returns, so an
            empty left side never implies missing data */}
        {layout.leftRegion > 0 && (
          <rect
            x={Math.max(0, layout.spineX - layout.leftRegion - 8)}
            y={0}
            width={layout.leftRegion + 8}
            height={layout.height}
            fill="var(--surface-sunken)"
            opacity={0.5}
            aria-hidden="true"
          />
        )}

        {/* the spine itself */}
        <line
          x1={layout.spineX}
          y1={8}
          x2={layout.spineX}
          y2={layout.height - 8}
          stroke="var(--line)"
          strokeWidth={1}
          aria-hidden="true"
        />

        {/* arcs — each is focusable and carries its own complete label */}
        <g fill="none">
          {layout.arcs.map((arc) => {
            const lit = isLit(arc);
            const color = nodeById.get(arc.fromAccountId)?.color ?? "var(--ink-muted)";
            const href = hrefForEdge?.(arc);
            return (
              <g
                key={arc.id}
                role={href ? "button" : undefined}
                tabIndex={href ? 0 : undefined}
                aria-label={href ? arcLabel(arc) : undefined}
                data-edge={arc.id}
                data-onward={arc.isOnward ? "true" : "false"}
                className={href ? "cursor-pointer focus-visible:outline-none" : undefined}
                onPointerEnter={() => setHovered(arc.id)}
                onPointerMove={(e) => moveTooltip(e, arc)}
                onClick={(e) => drill(arc, e)}
                onKeyDown={(e) => onArcKey(arc, e)}
                onFocus={() => setHovered(arc.id)}
                onBlur={() => setHovered(null)}
              >
                {/* a fat invisible hit area — a 2px stroke is not a pointer target */}
                <path d={arc.path} stroke="transparent" strokeWidth={Math.max(arc.width, 18)} />
                <path
                  d={arc.path}
                  stroke={color}
                  strokeWidth={arc.width}
                  strokeLinecap="round"
                  opacity={lit ? (hovered === arc.id ? HOT_OPACITY : REST_OPACITY) : DIM_OPACITY}
                  strokeDasharray={arc.dashGap > 0 ? `${arc.dashLength} ${arc.dashGap}` : undefined}
                  className={motion}
                  style={
                    drift && arc.dashGap > 0
                      ? { animation: `transfer-drift ${arc.dashDurationS}s linear infinite` }
                      : undefined
                  }
                />
              </g>
            );
          })}
        </g>

        {/* nodes: a dot on the spine plus a label, each a real link */}
        <g>
          {layout.nodes.map((n) => {
            const share =
              data.totals.grossCents > 0
                ? Math.round((Math.abs(n.netCents) / data.totals.grossCents) * 100)
                : 0;
            const direction = n.netCents < 0 ? "net source" : n.netCents > 0 ? "net destination" : "net flat";
            return (
              <a
                key={n.id}
                href={n.href}
                aria-label={`${n.label}, ${direction} ${formatCents(n.netCents)}, ${share}% of all transfer volume — view transactions`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  router.push(n.href);
                }}
              >
                <circle cx={layout.spineX} cy={n.y} r={n.radius} fill={n.color} />
                <text
                  x={n.labelX}
                  y={n.y - 4}
                  textAnchor="end"
                  className="fill-ink text-[11px] font-medium"
                >
                  {n.label}
                </text>
                <text
                  x={n.labelX}
                  y={n.y + 10}
                  textAnchor="end"
                  className="fill-ink-muted text-[10px] figures"
                >
                  {formatCents(n.netCents)}
                </text>
              </a>
            );
          })}
        </g>
      </svg>

      {/* aria-hidden and NOT a live region: announcing a new flow for every arc
          the cursor crosses would be hostile. Every fact here is in the table. */}
      {tooltip && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs shadow-press-2"
          style={{ left: Math.min(tooltip.x + 12, layout.width - 190), top: tooltip.y + 12 }}
        >
          <p className="font-medium text-ink-display">{tooltip.title}</p>
          {tooltip.lines.map((l) => (
            <p key={l} className="figures text-ink-muted">
              {l}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
