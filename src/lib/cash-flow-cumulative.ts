/**
 * The cash-flow GRAPH's running totals — the one place the period's four terms
 * become curves.
 *
 * 🔴 TWO FIGURES ON THE GRAPH DISAGREED WITH THE PAGE AROUND IT, both because
 * the arithmetic lived inline in the chart component and re-derived what the
 * service had already computed. Measured on the real ledger, 2026-09-11:
 *
 *   1. `netCum` was `earnedCum − spentCum`. But a period's Net is
 *      `earned + refunds − spent` (spending.ts's sign convention: a refund is
 *      money in, and never nets "Spent" down). So `/spending?period=2026-07&cash=graph`
 *      drew its Net ending at −$10,301.01 under a page whose own Net card read
 *      −$10,187.90 — the $113.11 of refunds, missing from one of two figures on
 *      one screen. **83 of 1,936 buckets across all periods carry a refund.**
 *   2. `ghostCum` summed the RESAMPLED prior series. Resampling duplicates and
 *      drops buckets, so the dashed line's last point was not the prior period's
 *      spend: on **33 of 53 periods** it contradicted the page's own
 *      "$X in <prior month>" readout — `?period=2023-03` ended at $2,943.05
 *      against a stated $2,541.21.
 *
 * Both terms come from the service now: `netCum` accumulates each bucket's own
 * `netCents`, and the ghost accumulates `prior.aligned` (index-aligned, see
 * `alignByIndex`) and is pinned to `priorSpentCents` at the final point — the
 * only point where "by here" means "all of it", and the only way a prior period
 * LONGER than this window can show its tail at all.
 */

import type { UnreachedKind } from "./empty-period";

/** the minimum a bucket must carry to be drawn as running totals */
export interface CashCumulativeInput {
  key: string;
  label: string;
  incomeCents: number;
  spendingCents: number;
  refundsCents: number;
  netCents: number;
}

export interface CashCumulativePoint {
  key: string;
  label: string;
  earnedCum: number;
  /** refunds are money in — the term that makes earned − spent ≠ net */
  refundsCum: number;
  spentCum: number;
  /** the period's OWN net, accumulated — never re-derived from the other two */
  netCum: number;
  /** the prior period's cumulative spend at this point; null when there is no ghost */
  ghostCum: number | null;
  /**
   * `ghostCum` here is the prior period WHOLE, not its running total at this
   * position — true only at the pinned last point of a ghosted series.
   */
  ghostWhole: boolean;
}

/**
 * The words beside a point's ghost figure — decided where the figure is.
 *
 * 🔴 The tooltip printed "Spent by here, August 2026" at every point, including
 * the last, whose figure is August WHOLE (the tail no September bucket can
 * carry included). "By here" names a running total and that point is not one:
 * 19 of 49 month periods, every 30-day month under a 31-day one. The figure is
 * right — only its sentence was wrong.
 */
export function ghostRowLabel(point: Pick<CashCumulativePoint, "ghostWhole">, priorLabel: string | null): string {
  return point.ghostWhole
    ? `Spent in ${priorLabel ?? "the prior period"}`
    : `Spent by here, ${priorLabel ?? "prior period"}`;
}

/**
 * Running totals per bucket. `priorAligned` must be index-aligned to `buckets`
 * (one entry per bucket, `null` where the prior period had no such bucket); a
 * length mismatch, or a null series, draws no ghost at all.
 */
export function cashFlowCumulative(
  buckets: readonly CashCumulativeInput[],
  priorAligned: readonly (number | null)[] | null,
  priorSpentCents: number,
): CashCumulativePoint[] {
  const hasGhost = priorAligned !== null && priorAligned.length === buckets.length && buckets.length > 0;
  let earnedCum = 0;
  let refundsCum = 0;
  let spentCum = 0;
  let netCum = 0;
  let ghostCum = 0;
  const last = buckets.length - 1;
  return buckets.map((b, i) => {
    earnedCum += b.incomeCents;
    refundsCum += b.refundsCents;
    spentCum += b.spendingCents;
    netCum += b.netCents;
    if (hasGhost) ghostCum += priorAligned[i] ?? 0;
    return {
      key: b.key,
      label: b.label,
      earnedCum,
      refundsCum,
      spentCum,
      netCum,
      // the window's last point carries the prior period WHOLE — including the
      // buckets a shorter current window has no room for
      ghostCum: hasGhost ? (i === last ? priorSpentCents : ghostCum) : null,
      // decided by POSITION, so the wording never flips with whether a tail exists
      ghostWhole: hasGhost && i === last,
    };
  });
}

/** a point as the graph DRAWS it — its own running totals null where the ledger has not read its bucket */
export type PlottedRunningTotal = Omit<CashCumulativePoint, "earnedCum" | "refundsCum" | "spentCum" | "netCum"> & {
  earnedCum: number | null;
  refundsCum: number | null;
  spentCum: number | null;
  netCum: number | null;
};

/**
 * The running totals as LINES: a bucket the ledger has not read carries none to
 * draw, so each line starts at the first bucket read and ends at the last.
 *
 * 🔴 THE LINES CLAIMED WHAT THE TOOLTIP UNDER THEM REFUSES. The graph's tooltip
 * stopped printing "Through 30 … Spent $1,431.05" of a day nobody has imported
 * (S11), and the Spent line went on running flat through that day at $1,431.05
 * anyway — a running total drawn "through" a day is the same claim. Measured on
 * the owner's ledger 2026-09-15 (first row 2022-08-25, newest 2026-09-12): 52
 * drawn points on 4 of 55 month/year periods — `?period=2026-09` Sep 13–30,
 * `?period=2026` Oct–Dec, `?period=2022-08` Aug 1–24, `?period=2022` Jan–Jul.
 *
 * ⛔ The prior period's line stays: its running total is a fact about THAT
 * period (owner decision E1a). ⛔ The arithmetic is not touched —
 * `cashFlowCumulative` still carries the totals forward, so the tooltip, the
 * pinned ghost and every figure beside the graph read exactly what they read.
 * Matched by KEY: the kinds come from the service's buckets, the points from the
 * arithmetic, and position is not a contract between them.
 */
export function plottedRunningTotals(
  points: readonly CashCumulativePoint[],
  buckets: readonly { key: string; unreached: UnreachedKind | null }[],
): PlottedRunningTotal[] {
  const unreachedByKey = new Map(buckets.map((b) => [b.key, b.unreached]));
  return points.map((p) =>
    (unreachedByKey.get(p.key) ?? null) === null
      ? p
      : { ...p, earnedCum: null, refundsCum: null, spentCum: null, netCum: null },
  );
}

/**
 * Whether the value at `index` is drawn with neither neighbour drawn — a point
 * no segment reaches, which a line drawn without dots paints as nothing at all.
 *
 * 🔴 ONE BUCKET READ, NO LINE AT ALL. `plottedRunningTotals` ends each line at
 * the frontier and the graph draws its lines dot-free, so a window with exactly
 * one bucket read showed axes and a legend naming Earned, Spent and Net over no
 * line: d3's curve draws a lone defined point as a bare moveto, and recharts sets
 * no line cap. Reachable on the e2e fixture at `?period=2026-Q3` (seeded fresh,
 * fake today 2026-07-08, newest row 2026-07-04: July alone read of three
 * months); on the owner's ledger (read 2026-09-15, newest row 2026-09-12) over
 * `?from=2026-09-01&to=2026-11-30`, `?from=2026-09-12&to=2026-09-30`,
 * `?from=2022-06-01&to=2022-08-31` and `?from=2022-08-01&to=2022-08-25`.
 *
 * ⛔ Asked of the NEIGHBOURS, not of how many points a line has: d3 joins only
 * adjacent defined points, so this is the rule wherever the point sits.
 */
export function isLonePoint(values: readonly (number | null)[], index: number): boolean {
  const drawn = (i: number): boolean => i >= 0 && i < values.length && values[i] != null;
  return drawn(index) && !drawn(index - 1) && !drawn(index + 1);
}
