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
    };
  });
}
