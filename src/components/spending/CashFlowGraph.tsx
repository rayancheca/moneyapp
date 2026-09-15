"use client";

import type { ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from "recharts";
import {
  cashFlowCumulative,
  ghostRowLabel,
  isLonePoint,
  plottedRunningTotals,
  type CashCumulativePoint,
} from "@/lib/cash-flow-cumulative";
import { UNREACHED_PHRASE, type UnreachedKind } from "@/lib/empty-period";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { CashFlow, SpendingProjection } from "@/services/spending";

/**
 * The cash-flow GRAPH view (user ask): the period's running totals as clean
 * cumulative lines — earned, spent, and net — where the bar chart shows each
 * bucket's composition. The prior period's cumulative spend rides along as the
 * dashed ghost, so "are we ahead of last period" is readable at a glance.
 *
 * ⛔ THE NET LINE IS NOT THE GAP BETWEEN EARNED AND SPENT. A refund is money in
 * and never nets "Spent" down (spending.ts's sign convention), so net is
 * `earned + refunds − spent` and the gap understates it by the refunds. The
 * arithmetic lives in `cashFlowCumulative` now, which is where that — and the
 * ghost's own total — are pinned; this file only draws what it returns.
 */

function formatTick(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const sign = cents < 0 ? "-" : "";
  if (dollars >= 1000) return `${sign}$${Math.round(dollars / 100) / 10}k`;
  return `${sign}$${Math.round(dollars)}`;
}

interface CashFlowGraphProps {
  data: CashFlow;
  projection?: SpendingProjection | null;
}

/**
 * One point's hover card: the running totals THROUGH it, or — when the ledger has
 * not reached it — the world it sits in instead.
 *
 * 🔴 S11, the graph lens. On the owner's ledger 2026-09-14 (newest row Sep 12)
 * every point of September after the 12th carried the 12th's totals forward, and
 * the tooltip read "Through 13 … Spent $1,431.05" of a day nobody has imported
 * and "Through 30" of one that has not happened. A running total "through" a day
 * is a claim that the day was read.
 *
 * ⛔ The prior period's figure stays: it is a fact about that period (owner
 * decision E1a).
 */
export function RunningTotalTooltip({
  point: row,
  unreached,
  hasRefunds,
  priorLabel,
}: {
  point: CashCumulativePoint;
  unreached: UnreachedKind | null;
  hasRefunds: boolean;
  priorLabel: string | null;
}) {
  return (
    <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-sm">
      {unreached !== null ? (
        <>
          <div className="text-ink-faint">{row.label}</div>
          <div className="mt-1 text-ink-muted first-letter:uppercase">{UNREACHED_PHRASE[unreached]}</div>
        </>
      ) : (
        <>
          <div className="text-ink-faint">Through {row.label}</div>
          <div className="mt-1 flex items-center justify-between gap-4">
            <span className="text-positive">Earned</span>
            <span className="figures">{formatCents(row.earnedCum)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-negative">Spent</span>
            <span className="figures">{formatCents(row.spentCum)}</span>
          </div>
          {hasRefunds && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-positive">Refunded</span>
              <span className="figures">{formatCents(row.refundsCum)}</span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 font-medium">
            <span>Net</span>
            <span className="figures">{formatCentsSigned(row.netCum)}</span>
          </div>
        </>
      )}
      {row.ghostCum !== null && (
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 text-ink-faint">
          <span>{ghostRowLabel(row, priorLabel)}</span>
          <span className="figures">{formatCents(row.ghostCum)}</span>
        </div>
      )}
    </div>
  );
}

/** recharts' own dot radius — the size it gives a series of a single point */
const LONE_POINT_R = 3;

/**
 * A line's `dot`: a mark at a point no segment reaches, nothing anywhere else.
 * The lines end where the ledger does, so a window with ONE bucket read has a
 * point on each line and no segment to draw it with — see `isLonePoint`. In the
 * line's own colour, so the mark reads as the line it stands in for.
 *
 * ⛔ The prior period's line keeps `dot={false}`: it carries a figure at every
 * point or at none, so it is never broken into a lone point.
 */
function lonePointDot(values: readonly (number | null)[], color: string): (props: DotItemDotProps) => ReactNode {
  return function LonePoint({ index, cx, cy }) {
    if (!isLonePoint(values, index) || typeof cx !== "number" || typeof cy !== "number") return null;
    return <circle cx={cx} cy={cy} r={LONE_POINT_R} fill={color} />;
  };
}

export function CashFlowGraph({ data, projection }: CashFlowGraphProps) {
  const { buckets } = data;
  const priorLabel = projection?.prior?.label ?? null;

  // ⛔ `prior.aligned`, never `prior.ghost`: the ghost is a SHAPE resample, and a
  // running total over it lands on a figure the prior period never spent.
  const rows = cashFlowCumulative(
    buckets,
    projection?.prior?.aligned ?? null,
    projection?.prior?.spentCents ?? 0,
  );
  const hasGhost = rows.some((r) => r.ghostCum !== null);
  const hasRefunds = buckets.some((b) => b.refundsCents !== 0);

  if (buckets.length === 0) return null;
  // ⛔ the LINES stop where the ledger does; `rows` keeps every figure for the tooltip
  const plotted = plottedRunningTotals(rows, buckets);
  const labelByKey = new Map(rows.map((r) => [r.key, r.label]));
  const unreachedByKey = new Map(buckets.map((b) => [b.key, b.unreached]));

  return (
    <figure className="m-0" aria-label="Running totals for the period — cumulative earned, spent, and net">
      <div className="h-72 md:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={plotted} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="key"
              tickFormatter={(k: string) => labelByKey.get(k) ?? k}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--line)" }}
              interval="preserveStartEnd"
              minTickGap={12}
            />
            <YAxis
              tickFormatter={formatTick}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ReferenceLine y={0} stroke="var(--line-strong)" />
            <Tooltip
              /* ⛔ KEEP THE NULLS. An unreached point's four lines are null now,
                 and recharts' default `filterNull` drops those entries — with
                 no prior-period line the payload empties and the bounding box
                 hides (`hasPayload`, recharts 3.9.2), taking the "not imported
                 yet" card with it. The content reads `rows` by label, never the
                 payload's values. */
              filterNull={false}
              cursor={{ stroke: "var(--line-strong)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = rows.find((r) => r.key === String(label));
                if (!row) return null;
                return (
                  <RunningTotalTooltip
                    point={row}
                    unreached={unreachedByKey.get(row.key) ?? null}
                    hasRefunds={hasRefunds}
                    priorLabel={priorLabel}
                  />
                );
              }}
            />
            {hasGhost && (
              <Line
                type="monotone"
                dataKey="ghostCum"
                name={`Spent in ${priorLabel ?? "the prior period"} (cumulative)`}
                stroke="var(--ink-faint)"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                strokeDasharray="2 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              type="monotone"
              dataKey="earnedCum"
              name="Earned (cumulative)"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={lonePointDot(plotted.map((p) => p.earnedCum), "var(--chart-2)")}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="spentCum"
              name="Spent (cumulative)"
              stroke="var(--negative)"
              strokeWidth={2}
              dot={lonePointDot(plotted.map((p) => p.spentCum), "var(--negative)")}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="netCum"
              name="Net (cumulative)"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={lonePointDot(plotted.map((p) => p.netCum), "var(--accent)")}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3" style={{ backgroundColor: "var(--chart-2)" }} />
          Earned, running total
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3" style={{ backgroundColor: "var(--negative)" }} />
          Spent, running total
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3 bg-accent" />
          Net, running total
        </span>
        {hasGhost && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0 w-3 border-t border-dashed border-ink-faint" />
            Spent in {priorLabel}, running total
          </span>
        )}
      </figcaption>
    </figure>
  );
}
