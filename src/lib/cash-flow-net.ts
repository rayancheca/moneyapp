import type { UnreachedKind } from "./empty-period";

/** what a cash-flow bucket's Net needs to know beyond its figure — the service's `CashFlowBucket` carries all three */
export interface NetBucket {
  unreached: UnreachedKind | null;
  /** ⚖️ decisions 64 + 72: "spending imported through Aug 12" — no spending found past the day all of it is read */
  spendingUnaccounted: string | null;
  /** ⚖️ §6A 68: no income found in the bucket and not one of its days checked where his pay lands */
  incomeUnread: boolean;
}

/**
 * Whether one cash-flow bucket's Net is a measurement: the ledger has reached the bucket (S11, `unreached`), its
 * Spent is one (decisions 64 + 72, `spendingUnaccounted`), and so is its Income (§6A 68, `incomeUnread`) — Net is
 * the arithmetic of both. Where it is not, the figure stays in the bucket (`CashFlowBucket.netCents`, ADDITIVE) and
 * nothing prints or draws it.
 *
 * ⛔ THE ONE RULE for a bucket's Net: the table lens's Net column, the chart lens's hover (`CashFlowBucketTooltip`) and
 * its Net line all read it, so the line never runs where the hover and the table give no Net. 🔴 On his ledger copy
 * 2026-10-29 `/spending` drew October's Net through Oct 1–14 at −$216.61 … −$48.19, Wells Fargo checked through Sep 24,
 * and on flat at $0.00 through Oct 15–31, days not imported yet or not happened; `?period=2026-08` drew Aug 30 at $0.00
 * under "nothing found so far — spending imported through Aug 12" — 78 points over 10 of the 76 windows the chart draws
 * (every month, quarter and year of 2022 – 2026, YTD and All time). The graph lens's lines had stopped there since S11
 * and §6A 68 (`plottedRunningTotals`); this one had not.
 */
export function bucketNetMeasured(b: NetBucket): boolean {
  return b.unreached === null && b.spendingUnaccounted === null && !b.incomeUnread;
}
