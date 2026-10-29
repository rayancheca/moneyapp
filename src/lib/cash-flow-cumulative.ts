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
 *
 * ⚖️ §6A 68: …and a point whose running Income is no measurement (`runningIncomeUnread`) carries no Income and no Net
 * to draw — Net is Income's arithmetic. Spent and the refunds were found, and run on. 🔴 On his ledger copy 2026-10-21
 * `?cash=graph` drew October's Income flat at $0 and its Net down to −$1,603.00 through Oct 14, beside cards, a table and
 * a chart hover dashing both (5a6d9b0); `?period=2026-Q4` drew the same at Oct.
 */
export function plottedRunningTotals(
  points: readonly CashCumulativePoint[],
  buckets: readonly RunningTotalBucket[],
): PlottedRunningTotal[] {
  const unreachedByKey = new Map(buckets.map((b) => [b.key, b.unreached]));
  const incomeUnread = runningIncomeUnread(buckets);
  return points.map((p) =>
    (unreachedByKey.get(p.key) ?? null) !== null
      ? { ...p, earnedCum: null, refundsCum: null, spentCum: null, netCum: null }
      : incomeUnread.has(p.key)
        ? { ...p, earnedCum: null, netCum: null }
        : p,
  );
}

/** what a running total needs to know of its bucket beyond the arithmetic — the service's `CashFlowBucket` carries both */
export interface RunningTotalBucket {
  key: string;
  unreached: UnreachedKind | null;
  /** ⚖️ §6A 68: no income found in the bucket and not one of its days checked where his pay lands */
  incomeUnread: boolean;
}

/**
 * The keys of the points whose running Income is NO MEASUREMENT (§6A 68): no income found through the point and not one
 * of its days checked where his pay lands — every reached bucket up to it `incomeUnread`. The run ends at the first
 * reached bucket that is a figure (income found, or a day checked): from there the running total holds money found or
 * days read, and past the pay's frontier it is a lower bound, as Spent's is past spending's (decision 72) — kept.
 * Buckets the ledger has not reached carry no figure either way and neither start nor end the run. Walked in the
 * service's calendar order: a running total is a question of what came BEFORE a point.
 *
 * ⛔ THE ONE RULE for a running Income: the graph's lines (`plottedRunningTotals`) and its hover
 * (`RunningTotalTooltip`, through `runningIncomeUnreadDays`) both read it, so a line never runs where the hover dashes.
 * The window's own rule is `CashFlow.incomeUnread`, the bucket's `CashFlowBucket.incomeUnread` — both
 * `noIncomeDayReadOf`, the dashboard's and /budgets' reading.
 */
export function runningIncomeUnread(buckets: readonly RunningTotalBucket[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const b of buckets) {
    if (b.unreached !== null) continue;
    if (!b.incomeUnread) break;
    keys.add(b.key);
  }
  return keys;
}

/**
 * ⚖️ §6A 68: the DAYS each of `runningIncomeUnread`'s points sums — the run's first day, where the ledger starts the
 * line, through the point's own last — which its hover names as not checked (`noIncomeDayCheckedIn`, 2026-10-29).
 * 🔴 His ledger copy 2026-10-29: the hover named a point by its bucket's axis label instead, "not one day through Sep
 * 26–30 has been checked …" and "… through Oct …" over `?from=2026-09-26&to=2026-12-31`, and "… through Oct '26 …"
 * over `?from=2026-09-25&to=2027-03-31` — a sentence that read only for a day ("through 14").
 */
export function runningIncomeUnreadDays(
  buckets: readonly (RunningTotalBucket & { from: string; to: string })[],
): ReadonlyMap<string, { from: string; to: string }> {
  const keys = runningIncomeUnread(buckets);
  const run = buckets.filter((b) => keys.has(b.key));
  const from = run[0]?.from;
  return new Map(from === undefined ? [] : run.map((b) => [b.key, { from, to: b.to }]));
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
