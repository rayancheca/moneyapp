/**
 * Stock splits, for a quantity timeline valued against ADJUSTED prices.
 *
 * ## The defect this exists to remove
 *
 * `rebuildInvestmentHistory` values a position as cumulative-sum(holding_events)
 * × the cached daily close. The two halves of that product disagree about when
 * a split happened:
 *
 *   - the QUANTITY is as-traded. The ledger records Coca-Cola Consolidated's
 *     10-for-1 on 2025-05-27 as a quantity delta of `+9.013095`, so the running
 *     count is ~1.0 before that day and ~10.0 after.
 *   - the PRICE is split-ADJUSTED, all the way back. Yahoo returns adjusted
 *     history, and the proof is in the cache: COKE closes $114.36 on 2025-05-23
 *     and $112.93 on 2025-05-27, continuous across a 10-for-1. A raw series
 *     would have fallen off a cliff there.
 *
 * So for every day before the split the app multiplied one pre-split share by a
 * tenth of what that share cost, and published a TENTH of the truth. Measured on
 * the real ledger: 60 trading days, 2025-02-28 → 2025-05-23, COKE contributing
 * $3,835.95 in total where the truth is $38,359.50 — an average understatement
 * of $575.39 a day, peaking at $1,021.71, against an account NAV of $16,886.10.
 *
 * ## ⛔ There are TWO defects and they currently CANCEL
 *
 * `flowsByDay` values the same `+9.013095` delta at the split-day close and
 * calls it money going IN: a phantom **$1,017.85 contribution** on a day nothing
 * was bought. The real trades that day came to $1,109.89; the app reports
 * $2,127.74.
 *
 * Because `return = ΔNAV − flow`, the fake $1,017.42 step in the level and the
 * fake $1,017.85 of flow very nearly annihilate, and the return series looks
 * fine. **Fixing either one alone would therefore CREATE a defect** — repair the
 * NAV and the flow's $1,017.85 becomes a $1,017.85 loss on a day the market was
 * closed to it. That is why both come through one function.
 *
 * ## What is adjusted, and what is deliberately not
 *
 * The running quantity is carried in TODAY's share terms: every delta before a
 * split is multiplied by that split's ratio, and the split event itself
 * contributes NOTHING, because its whole effect is already in those factors.
 * The stored events keep saying what he actually traded — source rows are not
 * rewritten to make a chart continuous.
 *
 * ⚠️ The ratio is DERIVED, never stored beside the delta. `Q → Q + delta` is a
 * ratio of `(Q + delta) / Q` and nothing else can be true; storing it as well
 * would be two numbers that must agree about one event, which is exactly the
 * defect pass 54 was written to stop. The event only has to say that it IS a
 * split.
 *
 * ⚠️ COST is untouched, and it was already right. A split moves no money, so the
 * COKE event carries no cost; the running average therefore divides an unchanged
 * $4,341.53 basis across ten times the shares, which is what a split does to a
 * per-share cost. Measured: stored basis $4,341.37 against $4,341.53 of events,
 * 16¢ apart from rounding the average to whole cents.
 */

/** One quantity change, in the order it occurred. */
export interface SplitAdjustableEvent {
  /** signed 1e-8 units, exactly as traded */
  deltaE8: number;
  /** this event is a corporate split rather than a trade */
  isSplit: boolean;
}

export interface SplitAdjustedEvent {
  /**
   * The delta restated in today's share terms: `deltaE8 × splitFactor`, or ZERO
   * for a split event. Value it against an adjusted close and both the level and
   * the flow come out right.
   */
  adjustedDeltaE8: number;
  /**
   * The product of every split ratio that comes AFTER this event — 1 for an
   * event with no split ahead of it. Reported so a caller can explain a figure
   * rather than only publish it.
   */
  splitFactor: number;
}

/**
 * Restates a quantity timeline in today's share terms.
 *
 * ⛔ Order is the caller's, and it is load-bearing TWICE over. A split's ratio
 * depends on the quantity standing when it happened, and which events precede
 * it decides which get scaled. Same-day ordering matters as much as day
 * ordering: the owner bought $10 of COKE on 2025-05-27 BEFORE the split landed
 * the same day, so that buy is a pre-split share and must be scaled like every
 * other. Valued as it stands today it reads $0.99 against $10.00 actually spent.
 *
 * ⚠️ The adjusted deltas sum to exactly the as-traded total, and that is a
 * theorem rather than a hope: a split contributes `Q × (R − 1)`, which is
 * precisely what scaling the preceding `Q` by `R` adds. Integer rounding is the
 * only thing that can disturb it, and only for a ratio that is not a whole
 * number.
 */
export function splitAdjustedDeltas(
  events: readonly SplitAdjustableEvent[],
): SplitAdjustedEvent[] {
  // pass 1 — as-traded running quantity, and each split's ratio at its index
  const ratioAt = new Map<number, number>();
  let asTraded = 0;
  for (const [i, e] of events.entries()) {
    if (e.isSplit) {
      /*
       * A split of nothing is nothing. Without this a `0 → 0 + delta` event
       * divides by zero and every earlier factor becomes Infinity or NaN, which
       * would not throw — it would silently publish a NaN net worth.
       */
      ratioAt.set(i, asTraded === 0 ? 1 : (asTraded + e.deltaE8) / asTraded);
    }
    asTraded += e.deltaE8;
  }

  // pass 2 — suffix product: the splits still AHEAD of each event
  const factors = new Array<number>(events.length).fill(1);
  let ahead = 1;
  for (let i = events.length - 1; i >= 0; i--) {
    factors[i] = ahead;
    const ratio = ratioAt.get(i);
    if (ratio !== undefined) ahead *= ratio;
  }

  return events.map((e, i) => ({
    splitFactor: factors[i]!,
    // the split's own effect lives in the factors above; counting it here too
    // would apply the ratio twice
    adjustedDeltaE8: e.isSplit ? 0 : Math.round(e.deltaE8 * factors[i]!),
  }));
}
