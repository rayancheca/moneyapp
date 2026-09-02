"use client";

import { useRouter } from "next/navigation";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import {
  FLOW_TOWER_VIEW_DIMENSION,
  FLOW_TOWER_VIEW_LABELS,
} from "@/components/charts/transfer-flow-view-spec";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { formatCents, formatCentsSigned } from "@/lib/money";
import {
  TOWER_VIEWPOINTS,
  TOWER_VIEWPOINT_ORDER,
  computeTowerLayout,
  towerDescription,
  type TowerArcShape,
  type TowerViewpoint,
} from "@/lib/transfer-tower-layout";
import type { TransferFlowData } from "@/services/transfer-flow";

/**
 * "The Tower" — the 3D transfer view.
 *
 * Geometry is pure (`lib/transfer-tower-layout.ts`); this owns colour, hover,
 * the viewpoint and the drill, exactly as `TransferSpine` does for the spine and
 * `NetWorthTerrain` does for the terrain.
 *
 * READ IT LIKE THIS. Six account pillars stand on a ring. Time runs UPWARD —
 * the oldest month at the base, the newest at the top — and each arc is one
 * month of one route. A route used constantly reads as a rope running the
 * tower's whole height; a route used once for a large sum reads as a lone strut
 * at one altitude. That contrast is the reason this view exists, and it is the
 * one thing the spine cannot show, because the spine has no time axis.
 *
 * A11Y — THE PLATE IS NOT THE ONLY PATH, AND IS NOT A TAB TRAP. There is one
 * arc per (edge, month), which on the real data is a couple of hundred. Making
 * each one focusable would put a couple of hundred tab stops between the
 * viewpoint pills and the rest of the page, which is hostile — so the arcs are
 * POINTER-ONLY and the drawing is `aria-hidden`. Everything it says is reachable
 * two other ways: the RAIL beside it names every account with its exact figures
 * and is a real link to that account's ledger, and the Table lens carries every
 * number. That is the terrain's bargain, and it is why the terrain does the
 * same thing.
 *
 * Which is also why this SVG carries `role="img"` and `TransferSpine` refuses
 * it. `role="img"` PRUNES nested interactive content from the accessibility
 * tree — a disaster next door, where each of thirteen arcs is a focusable
 * button and pruning would silently delete the keyboard path to all of them.
 * Here there is deliberately nothing inside to prune, so the role is exactly
 * right: it presents one figure with one description instead of leaking a few
 * hundred anonymous `<polyline>`s into the tree.
 *
 * The rail is also why the plate is not asked to fill a wide card on its own:
 * the tower is a roughly square object and a 1440px card would otherwise leave
 * half its width dead — the exact defect the spine shipped with once.
 */

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 420;
const DIM_OPACITY = 0.06;
const HOT_OPACITY = 1;
/** the near/far cue: the farthest arc still has to be visible */
const REST_MIN_OPACITY = 0.24;
const REST_MAX_OPACITY = 0.72;
/** a 1px stroke is not a pointer target */
const MIN_HIT_WIDTH = 14;
/**
 * The tooltip's own box, so it can be kept inside a plate that clips. The
 * height is only the FIRST-PAINT estimate — it is measured after that, because
 * a constant is a guess and this one was wrong: at 375px the card wraps to 98px
 * and a 74px estimate let it hang 21px through the bottom of the plate.
 */
const TOOLTIP_W = 210;
const TOOLTIP_H_ESTIMATE = 74;

// The camera's options and labels live with the SURFACE that owns them
// (`transfer-flow-view-spec`), so the spec the RSC resolves and the pills this
// file renders name one set of options.

export interface TransferTowerProps {
  data: TransferFlowData;
  measure: "gross" | "net";
  /** hover is LIFTED, so lighting an arc here lights the same route elsewhere */
  hoveredEdgeId?: string | null;
  onHoverEdge?: (id: string | null) => void;
  /** where an arc drills to; omit to make arcs non-navigable */
  hrefForEdge?: (arc: TowerArcShape) => string;
  heightClass?: string;
  emptyLabel?: string;
  /**
   * The camera is the /flow surface's view state (URL > persisted > default),
   * not a local `useState` that a reload forgets while declaring a URL key
   * nothing read.
   */
  viewpoint: string;
  onSelectViewpoint: (value: string) => void;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

export function TransferTower({
  data,
  measure,
  hoveredEdgeId,
  onHoverEdge,
  hrefForEdge,
  // Tall on purpose: the vertical axis carries ~34 months on the real data, and
  // a 400px plate leaves ~11px between months — close enough that a 7px stroke
  // touches its neighbour and the months stop being separable.
  heightClass = "h-[26rem] sm:h-[34rem] lg:h-[38rem]",
  emptyLabel = "No transfers between your accounts in this period.",
  viewpoint: viewpointValue,
  onSelectViewpoint,
}: TransferTowerProps) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const gradientId = useId();
  const titleId = useId();
  const descId = useId();

  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  // the resolver only returns a declared option; anything else falls to the
  // default rather than indexing the camera table with it
  const viewpoint: TowerViewpoint =
    viewpointValue in TOWER_VIEWPOINTS ? (viewpointValue as TowerViewpoint) : "quarter";
  const [innerHover, setInnerHover] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipHeight, setTipHeight] = useState(TOOLTIP_H_ESTIMATE);

  const hovered = hoveredEdgeId !== undefined ? hoveredEdgeId : innerHover;
  const setHovered = (id: string | null) => {
    if (onHoverEdge) onHoverEdge(id);
    else setInnerHover(id);
  };

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () =>
      setSize({
        w: Math.max(el.clientWidth, 240),
        h: Math.max(el.clientHeight, 220),
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measured, not assumed — and in a LAYOUT effect, so the correction lands
  // before the browser paints and the card never visibly jumps.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (el) setTipHeight(el.offsetHeight);
  }, [tooltip]);

  const layout = useMemo(
    () =>
      computeTowerLayout(data, measure, {
        width: size.w,
        height: size.h,
        camera: TOWER_VIEWPOINTS[viewpoint],
      }),
    [data, measure, size.w, size.h, viewpoint],
  );
  const description = useMemo(() => towerDescription(data, measure, formatCents), [data, measure]);

  const pillarById = useMemo(() => new Map(layout.pillars.map((p) => [p.id, p])), [layout.pillars]);
  const pillarIndex = useMemo(
    () => new Map(layout.pillars.map((p, i) => [p.id, i])),
    [layout.pillars],
  );
  const arcByKey = useMemo(() => new Map(layout.arcs.map((a) => [a.key, a])), [layout.arcs]);
  /** edge id → the two accounts it joins, so a hover is O(1) rather than a scan */
  const edgeEnds = useMemo(
    () => new Map(layout.arcs.map((a) => [a.edgeId, [a.fromAccountId, a.toAccountId] as const])),
    [layout.arcs],
  );
  /** edge id → the route's whole-window totals, from the SERVICE, not re-summed */
  const edgeTotals = useMemo(
    () =>
      new Map(
        (measure === "net" ? data.netEdges : data.edges).map((e) => [
          e.id,
          { cents: e.cents, count: e.count },
        ]),
      ),
    [data, measure],
  );
  const labelFor = (id: string) => pillarById.get(id)?.label ?? id;
  const colorFor = (id: string) => pillarById.get(id)?.color ?? "var(--ink-muted)";

  const isLit = (edgeId: string) => hovered === null || hovered === edgeId;
  const touchesHovered = (id: string) =>
    hovered === null || (edgeEnds.get(hovered)?.includes(id) ?? false);

  function moveTooltip(e: ReactPointerEvent, arc: TowerArcShape) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const plural = (n: number) => (n === 1 ? "transfer" : "transfers");
    // Hovering lights the whole ROUTE — every month of it — because seeing a
    // route's entire history at once is the reason the time axis is here. But
    // the figure under the cursor is ONE month of it, and with twenty arcs lit
    // a single number invites being read as their total. So say both.
    const route = edgeTotals.get(arc.edgeId);
    const lines = [`${formatCents(arc.cents)} in ${arc.month} · ${arc.count} ${plural(arc.count)}`];
    if (route) {
      lines.push(
        `${formatCents(route.cents)} on this route · ${route.count} ${plural(route.count)}`,
      );
    }
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      title: `${labelFor(arc.fromAccountId)} → ${labelFor(arc.toAccountId)}`,
      lines,
    });
  }

  function drill(arc: TowerArcShape, e: ReactMouseEvent) {
    if (!hrefForEdge) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    router.push(hrefForEdge(arc));
  }

  const motion = reducedMotion ? "" : "transition-opacity duration-(--duration-fast)";
  const first = layout.months[0];
  const last = layout.months[layout.months.length - 1];

  return (
    <figure className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewSwitcher
          dimension={FLOW_TOWER_VIEW_DIMENSION}
          value={viewpoint}
          onSelect={onSelectViewpoint}
          labels={FLOW_TOWER_VIEW_LABELS}
          ariaLabel="Tower viewpoint"
        />
        <p className="text-xs text-ink-muted">
          Time runs upward. Thicker means more money that month.
        </p>
      </div>

      {/* `*:min-w-0` is load-bearing: a grid item's automatic minimum is its
          min-content size, and without this the plate's own width would floor
          the track and scroll the page sideways on a phone. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem] *:min-w-0">
        <div ref={stageRef} className={`relative overflow-hidden rounded-xl bg-surface-sunken ${heightClass}`}>
          {layout.arcs.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-ink-muted">{emptyLabel}</p>
            </div>
          ) : (
            <svg
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-labelledby={`${titleId} ${descId}`}
              role="img"
              className="block"
              onPointerLeave={() => {
                setHovered(null);
                setTooltip(null);
              }}
            >
              <title id={titleId}>
                {measure === "net" ? "Net transfers over time, as a tower" : "All transfers over time, as a tower"}
              </title>
              <desc id={descId}>{description}</desc>

              <defs>
                {layout.pillars.map((p, i) => (
                  <linearGradient
                    key={p.id}
                    id={`${gradientId}-${i}`}
                    gradientUnits="userSpaceOnUse"
                    x1={p.bottom.x}
                    y1={p.bottom.y}
                    x2={p.top.x}
                    y2={p.top.y}
                  >
                    {/* the gradient reads TIME: faint at the base, solid at today */}
                    <stop offset="0" stopColor={p.color} stopOpacity="0.12" />
                    <stop offset="0.28" stopColor={p.color} stopOpacity="0.6" />
                    <stop offset="1" stopColor={p.color} stopOpacity="1" />
                  </linearGradient>
                ))}
              </defs>

              {/* the floor rings: one every six months, the tower's time grid */}
              <g aria-hidden="true">
                {layout.rings.map((ring) => (
                  <g key={ring.month}>
                    <polyline
                      points={ring.outline}
                      fill="none"
                      stroke="var(--line)"
                      strokeWidth={1}
                      opacity={0.6}
                    />
                    <text
                      x={ring.label.x}
                      y={ring.label.y + 3}
                      textAnchor="end"
                      className="fill-ink-faint text-[9px] figures"
                    >
                      {ring.month}
                    </text>
                  </g>
                ))}
                <line
                  x1={layout.axisBottom.x}
                  y1={layout.axisBottom.y}
                  x2={layout.axisTop.x}
                  y2={layout.axisTop.y}
                  stroke="var(--line-strong)"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  opacity={0.5}
                />
              </g>

              {/* everything else, painted FARTHEST FIRST — the painter's algorithm
                  is what makes a near arc occlude a far one, and it is also what
                  makes the browser's own hit-test pick the nearest arc for free */}
              <g>
                {layout.order.map((item) => {
                  if (item.kind === "pillar") {
                    const p = pillarById.get(item.id);
                    const i = pillarIndex.get(item.id);
                    if (!p || i === undefined) return null;
                    return (
                      <line
                        key={item.sortKey}
                        x1={p.bottom.x}
                        y1={p.bottom.y}
                        x2={p.top.x}
                        y2={p.top.y}
                        stroke={`url(#${gradientId}-${i})`}
                        strokeWidth={p.width}
                        strokeLinecap="round"
                        opacity={touchesHovered(p.id) ? 1 : 0.25}
                        className={motion}
                        aria-hidden="true"
                      />
                    );
                  }
                  const arc = arcByKey.get(item.id);
                  if (!arc) return null;
                  const lit = isLit(arc.edgeId);
                  const color = colorFor(arc.fromAccountId);
                  const rest =
                    REST_MIN_OPACITY + arc.nearness * (REST_MAX_OPACITY - REST_MIN_OPACITY);
                  return (
                    <g
                      key={item.sortKey}
                      data-arc={arc.key}
                      data-edge={arc.edgeId}
                      className={hrefForEdge ? "cursor-pointer" : undefined}
                      onPointerEnter={() => setHovered(arc.edgeId)}
                      onPointerMove={(e) => moveTooltip(e, arc)}
                      onClick={(e) => drill(arc, e)}
                    >
                      <polyline
                        points={arc.polyline}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={Math.max(arc.width, MIN_HIT_WIDTH)}
                      />
                      <polyline
                        points={arc.polyline}
                        fill="none"
                        stroke={color}
                        strokeWidth={arc.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={lit ? (hovered === arc.edgeId ? HOT_OPACITY : rest) : DIM_OPACITY}
                        className={motion}
                      />
                      {arc.arrowhead !== null && (
                        <polygon
                          points={arc.arrowhead}
                          fill={color}
                          opacity={lit ? (hovered === arc.edgeId ? HOT_OPACITY : rest) : DIM_OPACITY}
                          className={motion}
                        />
                      )}
                    </g>
                  );
                })}
              </g>

              {/* Pillar labels last, so no arc bundle can paint over them — and
                  haloed, because "last" only wins where they do not also have to
                  read THROUGH a hundred strokes of their own colour. `paint-order:
                  stroke` draws the halo behind the glyph in one element, which a
                  backdrop rect per label would need two of. */}
              <g aria-hidden="true">
                {layout.pillars.map((p) => (
                  <text
                    key={p.id}
                    x={p.labelX}
                    y={p.labelY}
                    textAnchor="middle"
                    className="fill-ink text-[10px] font-medium"
                    stroke="var(--surface-sunken)"
                    strokeWidth={3.5}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    opacity={touchesHovered(p.id) ? 1 : 0.35}
                  >
                    {p.label}
                  </text>
                ))}
              </g>
            </svg>
          )}

          {/* aria-hidden and NOT a live region: announcing a new bucket for every
              arc the cursor crosses would be hostile. It is all in the table. */}
          {tooltip && (
            <div
              ref={tipRef}
              aria-hidden="true"
              className="pointer-events-none absolute z-10 max-w-[min(15rem,calc(100%-1rem))] rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs shadow-press-2"
              style={{
                left: Math.min(tooltip.x + 12, Math.max(size.w - TOOLTIP_W, 0)),
                // FLIP ABOVE THE CURSOR NEAR THE BASE, then clamp. Unlike the
                // spine's plain `relative w-full`, this plate is
                // `overflow-hidden` — it has to be, or the SVG sets the grid
                // track and scrolls the page sideways — so a card placed below
                // the pointer on a bottom arc is CLIPPED, not merely
                // overhanging. The base of the tower is the OLDEST months,
                // which is exactly what the time axis exists to let you read.
                top: Math.max(
                  0,
                  Math.min(
                    tooltip.y + tipHeight + 12 > size.h
                      ? tooltip.y - tipHeight - 12
                      : tooltip.y + 12,
                    size.h - tipHeight,
                  ),
                ),
              }}
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

        {/* THE RAIL — the keyboard and screen-reader path, and the legend that
            maps a colour on the plate back to an account. */}
        <ul aria-label="Accounts in this tower" className="space-y-1 text-xs">
          {layout.pillars.map((p) => (
            <li key={p.id}>
              <a
                href={p.href}
                onPointerEnter={() => setHovered(null)}
                className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-sunken focus-visible:bg-surface-sunken"
              >
                <span
                  aria-hidden="true"
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: p.color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{p.label}</span>
                  <span className="figures block text-ink-muted">
                    {formatCentsSigned(p.netCents)} net · {formatCents(p.throughputCents)} through
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>

      <figcaption className="flex flex-wrap justify-between gap-x-4 text-[10px] text-ink-muted">
        <span>{first} at the base</span>
        {/* `peakMonthCents` is the heaviest SINGLE (route, month) bucket — the
            widest stroke on the plate — not a month's total across every route.
            "biggest month" said the second thing and meant the first. */}
        <span className="figures">
          {layout.arcs.length} arcs · heaviest arc {formatCents(layout.peakMonthCents)}
        </span>
        <span>{last} at the top</span>
      </figcaption>
    </figure>
  );
}
