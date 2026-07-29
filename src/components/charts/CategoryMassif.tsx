"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { SpendDelta } from "@/components/spending/SpendDelta";
import { SPENDING_SURFACE } from "@/components/spending/spending-view-spec";
import { useViewState } from "@/hooks/useViewState";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { categoryHueVar, isCategoryHueName } from "@/lib/category-palette";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { type ViewState } from "@/lib/view-state";
import {
  MASSIF_VIEWPOINTS,
  WHERE_VIEW_LABELS,
  WHERE_VIEW_SPEC,
  computeMassifLayout,
  pointsAttr,
  reconcileMassif,
  type MassifBlock,
  type MassifReconciliation,
  type MassifTotalsInput,
  type MassifViewpoint,
} from "@/lib/massif-layout";

/**
 * "Where it went", set in relief (Direction A+). The category massif is the
 * spending card's SPATIAL lens: every category is a block pressed into or
 * embossed off a sheet of paper, and all three of its dimensions carry money.
 *
 *   footprint WIDTH  share of the period's spend (the table's own denominator)
 *   footprint DEPTH  grows with the number of ledger entries it holds
 *   HEIGHT           the change against the prior period — a block that SANK
 *                    below the plane cost less than it did last period
 *   COLOUR           category identity, never the only carrier of a fact
 *
 * The geometry is pure and unit-tested (`lib/massif-layout.ts`); this file owns
 * colour, the readout, hover, and the two escape hatches legibility demands: a
 * ranked list beside the plate that states every block's exact figures and is
 * the keyboard/AT path to each category page, and a Table lens with the prior
 * period and the percentage change in full.
 *
 * The SVG is `role="img"` with a label naming the encodings, so its shapes are
 * one described figure rather than a hundred unlabelled polygons — which is why
 * the drill-through links live in the list, not inside the drawing.
 */

// ── The three lenses of the "Where it went" card ──────────────────────

export interface WhereItWentRow {
  categoryId: string;
  name: string;
  /** category hue name (categories.color) */
  hue: string | null;
  /** net money out this period (outflows − refunds) */
  spentCents: number;
  /** the same figure for the previous period */
  priorCents: number;
  txnCount: number;
}

interface WhereItWentPanelProps {
  rows: readonly WhereItWentRow[];
  /** the period totals this figure must reconcile against */
  totals: MassifTotalsInput;
  periodLabel: string;
  priorLabel: string;
  /** the RSC-resolved active lens (URL > persisted > default) */
  viewState: ViewState;
  /** URL params to preserve across a lens switch */
  baseParams: Record<string, string>;
  /** the ranked list this card has always shown — the default lens */
  children: ReactNode;
}

export function WhereItWentPanel({
  rows,
  totals,
  periodLabel,
  priorLabel,
  viewState,
  baseParams,
  children,
}: WhereItWentPanelProps) {
  const { state, setView } = useViewState({
    surface: SPENDING_SURFACE,
    spec: WHERE_VIEW_SPEC,
    state: viewState,
    basePath: "/spending",
    baseParams,
  });
  const dim = WHERE_VIEW_SPEC[0]!; // "where"
  const active = state[dim.key] ?? "list";

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <ViewSwitcher
          dimension={dim}
          value={active}
          onSelect={(v) => setView(dim.key, v)}
          labels={WHERE_VIEW_LABELS}
          ariaLabel="Where it went view"
        />
      </div>
      {active === "relief" ? (
        <CategoryMassif rows={rows} totals={totals} periodLabel={periodLabel} priorLabel={priorLabel} />
      ) : active === "table" ? (
        <MassifTable rows={rows} periodLabel={periodLabel} priorLabel={priorLabel} />
      ) : (
        children
      )}
    </div>
  );
}

// ── The relief ───────────────────────────────────────────────────────

interface CategoryMassifProps {
  rows: readonly WhereItWentRow[];
  totals: MassifTotalsInput;
  periodLabel: string;
  priorLabel: string;
}

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 320;
/**
 * How many blocks a plate of this width can hold and still be read. Past the
 * budget the smallest categories are SUMMED into one block (never dropped), and
 * the rail says so — 12 footprints on a phone are a row of slivers, not a
 * figure. Deterministic in the measured width, so the layout stays stable.
 */
function blockBudget(width: number): number {
  if (width < 560) return 6;
  if (width < 820) return 8;
  return 12;
}
/** world units a hovered block rises — the projector turns it into a translate */
const HOVER_LIFT = 9;
const DIM_OPACITY = 0.3;
/** a footprint narrower than this cannot hold its own name */
const LABEL_MIN_PX = 46;

const VIEWPOINT_DIMENSION = {
  key: "viewpoint",
  options: ["quarter", "front", "plan"] as const,
};
const VIEWPOINT_LABELS: Record<string, string> = {
  quarter: "Quarter",
  front: "Front",
  plan: "Plan",
};

export function CategoryMassif({ rows, totals, periodLabel, priorLabel }: CategoryMassifProps) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const [viewpoint, setViewpoint] = useState<MassifViewpoint>("quarter");
  const [hovered, setHovered] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setSize({ w: Math.max(el.clientWidth, 240), h: Math.max(el.clientHeight, 180) });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const inputs = useMemo(
    () =>
      rows.map((r) => ({
        id: r.categoryId,
        label: r.name,
        hue: r.hue,
        spentCents: r.spentCents,
        priorCents: r.priorCents,
        txnCount: r.txnCount,
        href: `/categories/${r.categoryId}`,
      })),
    [rows],
  );

  const layout = useMemo(
    () =>
      computeMassifLayout(inputs, {
        width: size.w,
        height: size.h,
        camera: MASSIF_VIEWPOINTS[viewpoint],
        maxBlocks: blockBudget(size.w),
      }),
    [inputs, size.w, size.h, viewpoint],
  );

  const reconciliation = reconcileMassif(totals);
  const active = hovered === null ? null : (layout.blocks.find((b) => b.id === hovered) ?? null);
  const lift = reducedMotion ? 0 : HOVER_LIFT * layout.liftPerUnit;
  // compositor-friendly only: the lift is a transform, the focus is opacity
  const motion = reducedMotion ? "" : "transition-[transform,opacity] duration-(--duration-fast)";

  if (rows.length === 0) {
    return <p className="text-sm text-ink-muted">No categorized spending in this period.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Slug layout={layout} active={active} periodLabel={periodLabel} priorLabel={priorLabel} />
        <ViewSwitcher
          dimension={VIEWPOINT_DIMENSION}
          value={viewpoint}
          onSelect={(v) => setViewpoint(v as MassifViewpoint)}
          labels={VIEWPOINT_LABELS}
          ariaLabel="Massif viewpoint"
        />
      </div>

      {/* `*:min-w-0` is load-bearing below `lg`, and was measured missing: the
          explicit `minmax(0,1fr)` only exists in the `lg` rule, so on the
          implicit single-column track below it each item's automatic minimum
          fell back to min-content — and the stage's <svg> carries a literal
          `width={DEFAULT_WIDTH}` (720) until the ResizeObserver has run, which
          pinned the track at 722px (720 + the stage's 1px borders) whatever the
          window was. /spending?where=relief scrolled sideways by +323px at 440
          and +227px at 768. `overflow-hidden` on the stage clips the drawing
          but does NOT zero a BLOCK child's min-content contribution — only a
          flex/grid item's — so the guard has to be here, on the track.
          CategoryMassif.test.ts gates it. */}
      <div className="grid gap-4 *:min-w-0 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div>
          <div
            ref={stageRef}
            // the plate: a pressed sheet. `--press-1` is the letterpress depth
            // scale; the `none` fallback keeps this correct if the token is not
            // (yet) declared, so the stage degrades to a plain ruled panel.
            className="relative h-[17rem] w-full overflow-hidden rounded-lg border border-line bg-surface-sunken sm:h-[21rem]"
            style={{ boxShadow: "var(--press-1, none)" }}
            onPointerLeave={() => setHovered(null)}
          >
            <svg
              width={size.w}
              height={size.h}
              viewBox={`0 0 ${size.w} ${size.h}`}
              role="img"
              aria-label={massifDescription(layout, periodLabel, priorLabel)}
              focusable="false"
              className="block"
            >
              {layout.plane && (
                // the sheet: a pale leaf laid on the pressed stage, ruled all
                // round and ruled STRONGLY along its front edge — which is the
                // zero line the whole figure is read against, and the only
                // thing left of the sheet once the camera folds it away
                <g aria-hidden="true">
                  {/* --surface-raised, not a leaf token: it is the ONE surface
                      guaranteed lighter than the sunken stage in BOTH themes,
                      so the sheet reads as paper laid on paper either way */}
                  <polygon
                    points={pointsAttr(layout.plane.sheet)}
                    fill="var(--surface-raised)"
                    stroke="var(--line)"
                    strokeWidth={1}
                  />
                  <polyline
                    points={pointsAttr(layout.plane.frontEdge)}
                    fill="none"
                    stroke="var(--line-strong)"
                    strokeWidth={1.4}
                  />
                </g>
              )}
              {layout.blocks.map((block) => (
                <Relief
                  key={block.id}
                  block={block}
                  hovered={hovered === block.id}
                  lift={hovered === block.id ? lift : 0}
                  dimmed={hovered !== null && hovered !== block.id}
                  motion={motion}
                  onHover={() => setHovered(block.id)}
                  onOpen={() => block.href && router.push(block.href)}
                />
              ))}
            </svg>
          </div>

          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
            <li>
              <b className="font-medium text-ink-muted">Width</b> share of spend
            </li>
            <li>
              <b className="font-medium text-ink-muted">Depth</b> entries
            </li>
            <li>
              <b className="font-medium text-ink-muted">Height</b> change vs {priorLabel}
            </li>
            <li>
              <b className="font-medium text-ink-muted">Colour</b> category
            </li>
          </ul>
        </div>

        <MassifRail layout={layout} hovered={hovered} onHover={setHovered} priorLabel={priorLabel} />
      </div>

      <p className="mt-3 border-t border-line pt-2 text-[11px] text-ink-faint">
        {reconciliationNote(layout.totalSpentCents, totals, reconciliation)}
      </p>
    </div>
  );
}

/** One block. The lift is a pure translate — orthographic projection makes it exact. */
function Relief({
  block,
  hovered,
  lift,
  dimmed,
  motion,
  onHover,
  onOpen,
}: {
  block: MassifBlock;
  hovered: boolean;
  lift: number;
  dimmed: boolean;
  motion: string;
  onHover: () => void;
  onOpen: () => void;
}) {
  const fill = blockFill(block.hue);
  // a sliver too narrow to hold its own name is named on hover — and always in
  // the list beside the plate, which is the reading that never depends on aim
  const named = !dimmed && (block.footprintPx >= LABEL_MIN_PX || hovered);
  return (
    <g
      // the drawing is one described figure (role="img" above); every block's
      // numbers and its link live in the ranked list beside the plate
      aria-hidden="true"
      className={`${motion} ${block.href ? "cursor-pointer" : ""}`}
      style={{ opacity: dimmed ? DIM_OPACITY : 1, transform: `translateY(${-lift}px)` }}
      onPointerEnter={onHover}
      onClick={onOpen}
    >
      {block.faces.map((face, i) => (
        <polygon key={`${face.kind}-${i}`} points={pointsAttr(face.points)} fill={fill} fillOpacity={face.tone} />
      ))}
      {block.rim.length > 0 && (
        <polyline
          points={pointsAttr(block.rim)}
          fill="none"
          stroke="var(--surface-raised)"
          strokeWidth={block.relief === "sunken" ? 1.4 : 1}
          strokeLinejoin="round"
        />
      )}
      {block.hairline.length > 0 && (
        <polyline points={pointsAttr(block.hairline)} fill="none" stroke="var(--line-strong)" strokeWidth={1} />
      )}
      {named && (
        <text
          x={block.labelAnchor.x}
          y={block.labelAnchor.y}
          textAnchor="middle"
          className="fill-ink text-[11px] font-medium"
          style={{ paintOrder: "stroke", stroke: "var(--surface-raised)", strokeWidth: 3.5 }}
        >
          {fitLabel(block.label, block.footprintPx, hovered)}
        </text>
      )}
    </g>
  );
}

/** ~6.2px per character at 11px — a name wider than its own block is noise. */
function fitLabel(label: string, footprintPx: number, hovered: boolean): string {
  const max = hovered ? 28 : Math.max(6, Math.floor(footprintPx / 6.2));
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** The hero readout — the whole period, or whatever the pointer is on. */
function Slug({
  layout,
  active,
  periodLabel,
  priorLabel,
}: {
  layout: ReturnType<typeof computeMassifLayout>;
  active: MassifBlock | null;
  periodLabel: string;
  priorLabel: string;
}) {
  const spent = active ? active.spentCents : layout.totalSpentCents;
  const delta = active ? active.deltaCents : layout.totalDeltaCents;
  const entries = active ? active.txnCount : layout.totalTxnCount;
  const key = active
    ? `${active.label} · ${(active.share * 100).toFixed(1)}% of ${periodLabel}`
    : `${periodLabel} · all ${layout.categoryCount} categories`;
  return (
    // NOT a live region: this changes on every block the pointer crosses, and
    // AT would announce a new category each time. The figure's own aria-label
    // and the ranked list carry these numbers for a screen reader.
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        {active && (
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: blockFill(active.hue) }} />
        )}
        <span className="truncate">{key}</span>
      </div>
      <div className="figures text-xl font-medium">{formatCents(spent)}</div>
      <div className="text-xs">
        <SpendDelta cents={delta} />
        <span className="text-ink-faint">
          {" "}
          against {priorLabel} · {entries} {entries === 1 ? "entry" : "entries"}
        </span>
      </div>
    </div>
  );
}

/**
 * The ranked list beside the plate. This is where the exact numbers are, and
 * where the keyboard and a screen reader reach each category page — the drawing
 * itself is one labelled figure, so it can never be the only route.
 */
function MassifRail({
  layout,
  hovered,
  onHover,
  priorLabel,
}: {
  layout: ReturnType<typeof computeMassifLayout>;
  hovered: string | null;
  onHover: (id: string | null) => void;
  priorLabel: string;
}) {
  // bars share ONE scale — the largest block is full width, as the design sets
  // it — so a glance down the rail ranks the month without reading a figure
  const widest = Math.max(0, ...layout.blocks.map((b) => b.share));
  const aggregated = layout.blocks.some((b) => b.memberCount > 1);
  return (
    <div>
      <ul className="divide-y divide-line lg:max-h-[22rem] lg:overflow-y-auto">
      {layout.blocks.map((block, i) => {
        const on = hovered === block.id;
        const body = (
          <>
            <span className="figures w-5 shrink-0 text-[11px] text-ink-faint">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ background: blockFill(block.hue) }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-sm">{block.label}</span>
                <span className="figures shrink-0 text-[11px] text-ink-faint">
                  {(block.share * 100).toFixed(1)}%
                </span>
              </span>
              <span className="block text-[11px] text-ink-faint">
                {block.deltaCents === 0 ? `level with ${priorLabel}` : `${formatCentsSigned(block.deltaCents)} on ${priorLabel}`}
                {" · "}
                {block.txnCount} {block.txnCount === 1 ? "entry" : "entries"}
              </span>
              {/* decorative: the share is already set in figures above */}
              <span aria-hidden className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-sunken">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${widest > 0 ? (block.share / widest) * 100 : 0}%`,
                    background: blockFill(block.hue),
                    opacity: 0.75,
                  }}
                />
              </span>
            </span>
            <span className="figures shrink-0 text-sm font-medium">{formatCents(block.spentCents)}</span>
          </>
        );
        const shared = `flex w-full items-start gap-2 rounded px-1 py-2 text-left ${
          on ? "bg-surface-sunken" : ""
        }`;
        return (
          <li
            key={block.id}
            onPointerEnter={() => onHover(block.id)}
            onPointerLeave={() => onHover(null)}
          >
            {block.href ? (
              <Link
                href={block.href}
                className={`${shared} hover:bg-surface-sunken`}
                onFocus={() => onHover(block.id)}
                onBlur={() => onHover(null)}
              >
                {body}
              </Link>
            ) : (
              <div className={shared}>{body}</div>
            )}
          </li>
        );
      })}
      </ul>
      {aggregated && (
        <p className="mt-2 text-[11px] text-ink-faint">
          The smallest categories share one block so the rest stay readable. Every category is named
          on its own, with its own figures, in the List and Table lenses.
        </p>
      )}
    </div>
  );
}

// ── The table lens ───────────────────────────────────────────────────

interface MassifTableRow extends WhereItWentRow {
  share: number;
  deltaCents: number;
  deltaPct: number | null;
}

function MassifTable({
  rows,
  periodLabel,
  priorLabel,
}: {
  rows: readonly WhereItWentRow[];
  periodLabel: string;
  priorLabel: string;
}) {
  const shareBase = rows.reduce((s, r) => s + Math.max(0, r.spentCents), 0);
  const tableRows: MassifTableRow[] = rows.map((r) => ({
    ...r,
    share: shareBase > 0 ? Math.max(0, r.spentCents) / shareBase : 0,
    deltaCents: r.spentCents - r.priorCents,
    deltaPct: r.priorCents !== 0 ? ((r.spentCents - r.priorCents) / Math.abs(r.priorCents)) * 100 : null,
  }));

  const columns: Column<MassifTableRow>[] = [
    {
      key: "category",
      header: "Category",
      render: (r) => (
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: blockFill(r.hue) }} />
          <span className="truncate">{r.name}</span>
        </span>
      ),
    },
    { key: "entries", header: "Entries", align: "right", render: (r) => <span className="figures">{r.txnCount}</span> },
    {
      key: "share",
      header: "Share",
      align: "right",
      render: (r) => <span className="figures text-ink-faint">{(r.share * 100).toFixed(1)}%</span>,
    },
    {
      key: "prior",
      header: priorLabel,
      align: "right",
      render: (r) => <span className="figures text-ink-faint">{formatCents(r.priorCents)}</span>,
    },
    {
      key: "spent",
      header: periodLabel,
      align: "right",
      render: (r) => <span className="figures font-medium">{formatCents(r.spentCents)}</span>,
    },
    { key: "change", header: "Change", align: "right", render: (r) => <SpendDelta cents={r.deltaCents} /> },
    {
      key: "pct",
      header: "%",
      align: "right",
      render: (r) => (
        <span className="figures text-ink-faint">
          {r.deltaPct === null ? "—" : `${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%`}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={tableRows}
      rowKey={(r) => r.categoryId}
      rowHref={(r) => `/categories/${r.categoryId}`}
      caption={`${periodLabel} against ${priorLabel}, by category — every figure the relief is cut from.`}
      emptyState="No categorized spending in this period."
    />
  );
}

// ── Words ────────────────────────────────────────────────────────────

function blockFill(hue: string | null): string {
  return isCategoryHueName(hue) ? categoryHueVar(hue) : "var(--ink-muted)";
}

/** The figure, described. Names every encoding and points at the exact numbers. */
function massifDescription(
  layout: ReturnType<typeof computeMassifLayout>,
  periodLabel: string,
  priorLabel: string,
): string {
  const n = layout.blocks.length;
  const move =
    layout.totalDeltaCents === 0
      ? `level with ${priorLabel}`
      : `${formatCentsSigned(layout.totalDeltaCents)} against ${priorLabel}`;
  return (
    `Where ${periodLabel} went, as a relief. ${n} category block${n === 1 ? "" : "s"} set on a plane. ` +
    `A block's footprint width is its share of the ${formatCents(layout.totalSpentCents)} spent, its footprint ` +
    `depth grows with the number of entries it holds, and its height is the change against ${priorLabel} — blocks pressed ` +
    `below the plane cost less than they did then. The ${n} heights sum to ${move}. ` +
    `Exact figures for every category are in the ranked list beside the chart and in the Table lens.`
  );
}

/**
 * The card says out loud how its total relates to the stat cards above it, and
 * says so LOUDEST when it does not balance. A silent disagreement between a
 * chart and the ledger is the failure this line exists to prevent.
 */
function reconciliationNote(
  blocksCents: number,
  totals: MassifTotalsInput,
  check: MassifReconciliation,
): string {
  const head = `${formatCents(blocksCents)} across these categories`;
  if (!check.balanced) {
    return `${head}. That is ${formatCentsSigned(check.residualCents)} away from the ${formatCents(check.netOutCents)} of money out in the stat cards above — the figure and the ledger are counting different rows, so read the ledger.`;
  }
  const uncat =
    totals.uncategorizedCents === 0
      ? ""
      : ` and ${formatCents(totals.uncategorizedCents)} uncategorized (Honesty check)`;
  const refunds =
    totals.refundsCents === 0 ? "" : `, less ${formatCents(totals.refundsCents)} refunded`;
  return `${head}${uncat} — the ${formatCents(check.netOutCents)} of money out this period (${formatCents(totals.grossSpentCents)} spent${refunds}).`;
}
