"use client";

import { renderPercent } from "@/lib/insight-facts";
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
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import {
  SANKEY_LENS_DIMENSION,
  SANKEY_LENS_LABELS,
} from "@/components/dashboard/dashboard-view-spec";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { formatCents } from "@/lib/money";
import { computeSankeyLayout, type SankeyGraph, type SankeyLayoutNode } from "@/lib/sankey-layout";

/**
 * The money-flow Sankey renderer (dashboard hero + /spending). Pure geometry
 * comes from `sankey-layout.ts`; this owns colour, labels, hover-highlight,
 * pointer tooltips, and click-drill. Interaction parity with the dashboard
 * chart, adapted to a flow diagram:
 *  - hover a node → its ribbons light up, the rest dim
 *  - hover a ribbon → a floating card names the flow, amount, and share
 *  - click a node → drills to the exact ledger rows behind it (a real <a href>
 *    so it is keyboard- and screen-reader-navigable; intercepted for SPA nav)
 *  - an optional chart⇄table toggle — the honest "show me the numbers" view
 * Deterministic layout + `isAnimationActive`-free transitions keep the e2e
 * visual baselines stable; motion is opacity-only and dropped under
 * prefers-reduced-motion. The canvas is measured (width + height) so the same
 * component fills an inline card or the taller focus dialog via `heightClass`.
 */

const NODE_WIDTH = 16;
const NODE_PADDING = 16;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 352;
const LABEL_GAP = 8;
const DIM_OPACITY = 0.12;
const LINK_REST = 0.42;
const LINK_HOT = 0.8;

interface SankeyChartProps {
  graph: SankeyGraph;
  /** Tailwind height for the measured canvas (default h-[22rem]); focus mode passes a taller one */
  heightClass?: string;
  /** value formatter (default formatCents) */
  formatValue?: (cents: number) => string;
  /** describes the flow for assistive tech + the empty state */
  ariaLabel?: string;
  emptyLabel?: string;
  /**
   * The flow⇄table lens, when the SURFACE owns it — the dashboard does;
   * /spending owns a surface-level table instead and passes neither, which is
   * what hides the toggle there.
   *
   * 🔴 This used to be a `showTableToggle` boolean over a local `useState`, and
   * the dimension beside it declared a URL key named `sankey` that nothing
   * read. Passing the value and its setter is what makes the key true.
   */
  lens?: string;
  onSelectLens?: (value: string) => void;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  amount: string;
  /** `sankeyShareClause` — null for the hub, or when nothing passed through */
  share: string | null;
}

// The dimension and its labels live with the SURFACE that owns them
// (`dashboard-view-spec`), so the spec the RSC resolves and the pill rendered
// here cannot name different options.

/**
 * The chart's one sentence.
 *
 * 🔴 THE PLUG IS NOT A SOURCE, AND WHAT IT CARRIES DID NOT FLOW IN.
 * `sankey.ts` adds a `drawdown` node — "From outside this period" — only when
 * the window spent more than its recorded income, and its own comment says
 * "all this node knows is that the balancing amount came from outside it." The
 * summary counted it among the sources and folded its cents into "flows in".
 *
 * Measured 2026-09-10 over all time: the page's own stat cards read Earned
 * $117,925.41 and Refunds +$7,031.51, so $124,956.92 actually came in. The
 * sentence said "$176,762.37 flows in from 9 sources" — which is the GROSS
 * SPEND, the figure the stat card beside it labels "Spent", because
 * 117,925.41 + 7,031.51 + 51,805.45 = 176,762.37 and the last of those three
 * is the plug.
 */
/**
 * ⚖️ OWNER DECISION 2026-09-11 — the diagram keeps its GROSS flows and says so.
 *
 * 🔴 One page, one month, two figures for Housing. `/spending?period=2026-07`:
 * this chart's node read **$2,763.79 · 26.7%** while the insight sentence, the
 * Where-it-went list, the relief, the table lens and every `/categories` page
 * read **$2,653.58 · 25.9%**. Both are right — SQL over the Housing subtree for
 * July: gross out $2,763.79, refunds $110.21, net $2,653.58 over 7 rows — and
 * the chart is internally consistent, because it draws the $113.11 that came
 * back as its own inflow (110.21 Housing + 2.90 Subscriptions) rather than
 * subtracting it. A Sankey draws money MOVING; netting here would make the
 * Refunds node double-count.
 *
 * ⛔ So the figure was right and the label was silent about its frame, which is
 * the defect. Put to the owner with the measurement; he chose "Label the frame".
 *
 * Null when nothing came back: with no refunds gross IS net, and a note
 * explaining a difference that does not exist is noise.
 */
export function sankeyFrameNote(
  nodes: readonly { valueCents: number; meta?: { kind?: string } }[],
  formatValue: (cents: number) => string,
): string | null {
  const refund = nodes.find((n) => n.meta?.kind === "refund");
  if (refund === undefined || refund.valueCents <= 0) return null;
  return (
    `Categories here are what was charged. The ${formatValue(refund.valueCents)} that came back ` +
    `is its own source rather than a subtraction, so these run above the netted figures elsewhere.`
  );
}

/** Which leg of the hub a share is a share of — see `sankeyNodeLabel`. */
export type SankeySide = "in" | "out";

/**
 * The leg a node's share belongs to.
 *
 * ⛔ Read off the node's POSITION, not off whether it spends. The side used to
 * be inferred from `kind === "category" || kind === "uncategorized"` — the
 * FRAME question ("is this figure what was charged?") answered in place of the
 * SIDE question. The two part company at Net saved, which leaves the hub
 * without being a charge, so its share read "on the way in". Sources sit in the
 * first column by construction (`sankey.ts`, and `sankeySummary` counts them
 * there), everything past the hub is on the way out, and the hub IS the
 * throughput rather than a share of it.
 */
export function sankeyNodeSide(node: { column: number; meta?: { kind?: string } }): SankeySide | null {
  if (node.meta?.kind === "hub") return null;
  return node.column === 0 ? "in" : "out";
}

/** A ribbon's leg is the leg of whichever end is not the hub. */
export function sankeyLinkSide(
  link: { source: string; target: string },
  nodes: readonly { id: string; column: number; meta?: { kind?: string } }[],
): SankeySide | null {
  const source = nodes.find((n) => n.id === link.source);
  const end = source?.meta?.kind === "hub" ? nodes.find((n) => n.id === link.target) : source;
  return end === undefined ? null : sankeyNodeSide(end);
}

/**
 * "26.7% of the $10,353.96 that passed through, on the way out" — THE phrasing
 * of a share, spoken by a node's aria-label and printed by the pointer tooltip.
 *
 * 🔴 It had two. `sankeyNodeLabel` was made to name its leg and the tooltip on
 * the very same node kept "26.7% of flow". Measured on the owner's ledger
 * 2026-09-15, `/spending?period=2026-07`: the left column's tooltips read
 * 98.4% + 1.1% + 0.3% + 0.1% + 0.1% of flow, and the right column's another
 * 100.0% — every reader's addition came to 200%.
 *
 * Null when nothing passed through (a 0% would state a measurement) and for the
 * hub, which is the whole denominator rather than a share of it.
 */
export function sankeyShareClause(
  cents: number,
  side: SankeySide | null,
  formatValue: (cents: number) => string,
  share: (cents: number) => string,
  totalFlow: number,
): string | null {
  if (side === null || totalFlow <= 0) return null;
  return `${share(cents)} of the ${formatValue(totalFlow)} that passed through, on the way ${side}`;
}

/**
 * The table lens's Share cell: the percent AND its leg.
 *
 * 🔴 Every row of that table is a ribbon into or out of the hub, so a bare
 * column of percents reads as one whole and sums to 200% — measured 2026-09-15
 * over July 2026's 17 rows, to the tenth.
 */
export function sankeyShareCell(cents: number, side: SankeySide | null, share: (cents: number) => string): string {
  return side === null ? share(cents) : `${share(cents)} ${side}`;
}

/**
 * A node's complete spoken name. The spend destinations say which FRAME their
 * figure is in — see `sankeyFrameNote` — and every node names the denominator
 * of its percent AND which side of the hub it is a share of.
 *
 * ⛔ THE SIDE IS NOT DECORATION. Both columns partition the same throughput:
 * the hub's in-flow (income + refunds + the drawdown plug) and its out-flow
 * (categories + uncategorized + net saved) are each the whole of it, so a bare
 * "26.7% of the flow" on every node invites an addition that comes to 200%.
 * `spineNodeLabel` was fixed for exactly this on the same day and its remedy is
 * the one used here: every share names its leg — in `sankeyShareClause`, which
 * the pointer tooltip prints too.
 *
 * ⚠️ The denominator is the THROUGHPUT, not "what came in" — on `/spending` for
 * July 2026 only $166.06 flowed in and $10,187.90 was drawn from outside the
 * period, which `sankeySummary` says in so many words. "Passed through" is the
 * one description true of both.
 */
export function sankeyNodeLabel(
  node: { label: string; valueCents: number; column: number; meta?: { kind?: string } },
  formatValue: (cents: number) => string,
  share: (cents: number) => string,
  totalFlow: number,
): string {
  const spends = node.meta?.kind === "category" || node.meta?.kind === "uncategorized";
  const amount = spends ? `${formatValue(node.valueCents)} charged` : formatValue(node.valueCents);
  const head = `${node.label}, ${amount}`;
  const clause = sankeyShareClause(node.valueCents, sankeyNodeSide(node), formatValue, share, totalFlow);
  return clause === null ? `${head} — view transactions` : `${head}, ${clause} — view transactions`;
}

export function sankeySummary(
  nodes: readonly { column: number; valueCents: number; meta?: { kind?: string } }[],
  totalFlow: number,
  ariaLabel: string,
  formatValue: (cents: number) => string,
): string {
  const plug = nodes.find((n) => n.meta?.kind === "drawdown") ?? null;
  const sources = nodes.filter((n) => n.column === 0 && n.meta?.kind !== "drawdown").length;
  const dests = nodes.filter((n) => n.meta?.kind === "category" || n.meta?.kind === "uncategorized").length;
  const came = totalFlow - (plug?.valueCents ?? 0);
  const drawn = plug
    ? ` A further ${formatValue(plug.valueCents)} is drawn from outside this period — it did not flow in.`
    : "";
  const frame = sankeyFrameNote(nodes, formatValue);
  return (
    `${ariaLabel}: ${formatValue(came)} flows in from ${sources} source${sources === 1 ? "" : "s"} ` +
    `across ${dests} spending categor${dests === 1 ? "y" : "ies"}.${drawn}${frame === null ? "" : ` ${frame}`}`
  );
}

export function SankeyChart({
  graph,
  heightClass = "h-[22rem]",
  formatValue = formatCents,
  ariaLabel = "Money-flow diagram",
  emptyLabel = "No money flow in this period.",
  lens,
  onSelectLens,
}: SankeyChartProps) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const mode = lens === "table" ? "table" : "flow";
  const titleId = useId();

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: Math.max(el.clientWidth, 240), h: Math.max(el.clientHeight, 200) });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () => computeSankeyLayout(graph, { width: size.w, height: size.h, nodeWidth: NODE_WIDTH, nodePadding: NODE_PADDING }),
    [graph, size.w, size.h],
  );

  const labelOf = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n.label])), [layout]);
  // total throughput = the hub's flow (in == out); fall back to the largest node
  const totalFlow = useMemo(() => {
    const hub = layout.nodes.find((n) => n.meta?.kind === "hub");
    return hub?.valueCents ?? Math.max(0, ...layout.nodes.map((n) => n.valueCents));
  }, [layout]);
  // ⛔ `renderPercent` — "$10.43 of $81,850.20" is 0.013% and toFixed(1)
  // printed it "0.0%", a measured zero about money that really moved
  const share = (cents: number) => (totalFlow > 0 ? renderPercent(cents / totalFlow) : "—");

  const flowRows = useMemo(
    () =>
      [...graph.links]
        .map((l) => ({
          id: `${l.source}→${l.target}`,
          from: labelOf.get(l.source) ?? l.source,
          to: labelOf.get(l.target) ?? l.target,
          cents: l.valueCents,
          side: sankeyLinkSide(l, layout.nodes),
        }))
        .sort((a, b) => b.cents - a.cents),
    [graph.links, labelOf, layout.nodes],
  );

  const summary = useMemo(
    () => sankeySummary(layout.nodes, totalFlow, ariaLabel, formatValue),
    [ariaLabel, formatValue, layout.nodes, totalFlow],
  );

  if (graph.nodes.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-muted">{emptyLabel}</p>;
  }

  const isConnected = (linkSource: string, linkTarget: string) =>
    hovered === null || hovered === linkSource || hovered === linkTarget;

  function moveTooltip(e: ReactPointerEvent, title: string, cents: number, side: SankeySide | null) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      title,
      amount: formatValue(cents),
      share: sankeyShareClause(cents, side, formatValue, share, totalFlow),
    });
  }

  function drill(node: SankeyLayoutNode, e: ReactMouseEvent) {
    if (!node.href) return;
    // honour modified / non-primary clicks — Cmd/Ctrl/Shift/middle-click keep
    // their native "open in new tab/window" behaviour on the real <a href>
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    router.push(node.href);
  }

  const motion = reducedMotion ? "" : "transition-opacity duration-(--duration-fast)";

  const frameNote = sankeyFrameNote(layout.nodes, formatValue);

  const diagram = (
    <div>
    <div ref={containerRef} className={`relative w-full ${heightClass}`}>
      <svg
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        aria-labelledby={titleId}
        className="block max-w-full overflow-visible"
        onPointerLeave={() => {
          setHovered(null);
          setTooltip(null);
        }}
      >
        {/* a <title> (not role="img") names the chart WITHOUT pruning the nested
            drill <a> links from the a11y tree — ribbon amounts are reachable via
            the Table view, node values via each link's aria-label */}
        <title id={titleId}>{summary}</title>
        {/* ribbons (behind nodes) — decorative; values live in the tooltip + Table */}
        <g fill="none" aria-hidden="true">
          {layout.links.map((l) => (
            <path
              key={`${l.source}→${l.target}`}
              d={l.path}
              stroke={l.color ?? "var(--ink-muted)"}
              strokeWidth={Math.max(l.width, 1)}
              className={motion}
              style={{ opacity: isConnected(l.source, l.target) ? (hovered ? LINK_HOT : LINK_REST) : DIM_OPACITY }}
              onPointerMove={(e) =>
                moveTooltip(
                  e,
                  `${labelOf.get(l.source) ?? l.source} → ${labelOf.get(l.target) ?? l.target}`,
                  l.valueCents,
                  sankeyLinkSide(l, layout.nodes),
                )
              }
              onPointerLeave={() => setTooltip(null)}
            />
          ))}
        </g>

        {/* nodes + labels */}
        {layout.nodes.map((n) => {
          const dim = hovered !== null && hovered !== n.id && !touches(layout, hovered, n.id);
          const isLast = n.column === layout.columns - 1;
          const isFirst = n.column === 0;
          // labels sit in the inter-column gaps: first column → right of node,
          // last column → left of node, middle columns → above the node
          const labelX = isFirst ? n.x1 + LABEL_GAP : isLast ? n.x0 - LABEL_GAP : (n.x0 + n.x1) / 2;
          const anchor = isFirst ? "start" : isLast ? "end" : "middle";
          const labelY = isFirst || isLast ? (n.y0 + n.y1) / 2 : n.y0 - 6;
          const NodeShape = (
            <g
              className={motion}
              style={{ opacity: dim ? 0.35 : 1 }}
              onPointerEnter={() => setHovered(n.id)}
              onPointerMove={(e) => moveTooltip(e, n.label, n.valueCents, sankeyNodeSide(n))}
            >
              <rect x={n.x0} y={n.y0} width={n.x1 - n.x0} height={Math.max(n.y1 - n.y0, 1)} rx={2.5} fill={n.color ?? "var(--ink-muted)"} />
              <text
                x={labelX}
                y={labelY}
                textAnchor={anchor}
                dominantBaseline={isFirst || isLast ? "middle" : "auto"}
                className="fill-ink text-[11px] font-medium"
                style={{ paintOrder: "stroke", stroke: "var(--surface-raised)", strokeWidth: 3 }}
              >
                {truncate(n.label)}
                <tspan className="fill-ink-faint" dx={6} style={{ fontWeight: 400 }}>
                  {formatValue(n.valueCents)}
                </tspan>
              </text>
            </g>
          );
          return n.href ? (
            <a
              key={n.id}
              href={n.href}
              aria-label={sankeyNodeLabel(n, formatValue, share, totalFlow)}
              onClick={(e) => drill(n, e)}
              className="cursor-pointer outline-none [&:focus-visible>g>rect]:stroke-accent [&:focus-visible>g>rect]:stroke-2"
            >
              {NodeShape}
            </a>
          ) : (
            <g key={n.id} aria-hidden>
              {NodeShape}
            </g>
          );
        })}
      </svg>

      {tooltip ? (
        <div
          // purely a pointer affordance (no keyboard trigger) — NOT a live region,
          // or AT would announce a new flow on every ribbon the cursor crosses.
          // Capped in width: the share clause names its denominator and its leg,
          // and wraps rather than running off the card's edge
          aria-hidden="true"
          className="pointer-events-none absolute z-20 w-max max-w-[15rem] -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-md"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-medium">{tooltip.title}</div>
          <div className="figures mt-0.5">{tooltip.amount}</div>
          {tooltip.share !== null ? <div className="text-ink-faint">{tooltip.share}</div> : null}
        </div>
      ) : null}
    </div>
      {/* ⛔ VISIBLE, not only in the <title>. `/spending` mounts this chart with
          no lens, so the summary renders as an SVG <title> a sighted reader
          never sees — and it is a sighted reader who is handed $2,763.79 here
          and $2,653.58 in the five other places the same month's Housing is
          printed. See `sankeyFrameNote`. */}
      {frameNote !== null ? <p className="mt-2 text-[11px] text-ink-faint">{frameNote}</p> : null}
    </div>
  );

  const table = (
    <DataTable
      columns={FLOW_COLUMNS(formatValue, share)}
      rows={flowRows}
      rowKey={(r) => r.id}
      caption={summary}
      emptyState={emptyLabel}
    />
  );

  // no lens handed down means the surface does not own this dimension, and a
  // control the surface cannot remember is exactly what was wrong before
  if (lens === undefined || onSelectLens === undefined) return diagram;

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <ViewSwitcher
          dimension={SANKEY_LENS_DIMENSION}
          value={mode}
          onSelect={onSelectLens}
          labels={SANKEY_LENS_LABELS}
          ariaLabel="Sankey view"
        />
      </div>
      {mode === "table" ? table : diagram}
    </div>
  );
}

type FlowRow = { id: string; from: string; to: string; cents: number; side: SankeySide | null };

function FLOW_COLUMNS(formatValue: (c: number) => string, share: (c: number) => string): Column<FlowRow>[] {
  return [
    { key: "flow", header: "Flow", render: (r) => `${r.from} → ${r.to}` },
    { key: "amount", header: "Amount", align: "right", render: (r) => <span className="figures">{formatValue(r.cents)}</span> },
    {
      key: "share",
      // the denominator in the header, the leg in every cell — see `sankeyShareCell`
      header: "Share of what passed through",
      align: "right",
      render: (r) => <span className="text-ink-faint">{sankeyShareCell(r.cents, r.side, share)}</span>,
    },
  ];
}

/** whether hovered node id and node id are directly linked (share a ribbon) */
function touches(layout: ReturnType<typeof computeSankeyLayout>, a: string, b: string): boolean {
  return layout.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
}

function truncate(label: string, max = 22): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}
