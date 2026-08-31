import { describe, expect, test } from "vitest";
import { splitAdjustedDeltas, type SplitAdjustableEvent } from "./split-adjust";

const trade = (deltaE8: number): SplitAdjustableEvent => ({ deltaE8, isSplit: false });
const split = (deltaE8: number): SplitAdjustableEvent => ({ deltaE8, isSplit: true });

/** e8 units from a share count, the way the ledger stores them. */
const q = (shares: number): number => Math.round(shares * 1e8);

describe("splitAdjustedDeltas", () => {
  /**
   * COKE as the real ledger holds it, reduced to the three events that matter:
   * 1.001455 shares accumulated by 2025-05-27, the 10-for-1 that day recorded
   * as `+9.013095`, and the buying that continued after.
   */
  test("restates pre-split trades in today's shares and zeroes the split itself", () => {
    const out = splitAdjustedDeltas([
      trade(q(1.001455)),
      split(q(9.013095)),
      trade(q(0.089806)),
    ]);

    expect(out[0]).toEqual({ adjustedDeltaE8: q(10.01455), splitFactor: 10 });
    expect(out[1]!.adjustedDeltaE8).toBe(0);
    expect(out[2]).toEqual({ adjustedDeltaE8: q(0.089806), splitFactor: 1 });
  });

  /**
   * ⛔ The invariant, and the reason the change is safe: today's position is
   * unmoved. Only the PATH to it changes.
   */
  test("the adjusted deltas sum to exactly the as-traded total", () => {
    const events = [trade(q(1.001455)), split(q(9.013095)), trade(q(23.944872))];
    const asTraded = events.reduce((s, e) => s + e.deltaE8, 0);
    const adjusted = splitAdjustedDeltas(events).reduce((s, e) => s + e.adjustedDeltaE8, 0);

    expect(asTraded).toBe(q(33.959422)); // the holdings row, to the 1e-8
    expect(adjusted).toBe(asTraded);
  });

  /**
   * ⛔ The same-day case, which day-level bucketing would get wrong. He bought
   * $10 of COKE on 2025-05-27 and the split landed later the same day, so that
   * buy is a PRE-split share. Valued unscaled against the adjusted close it
   * reads $0.99 against the $10.00 he actually spent.
   */
  test("a trade earlier on the split's own day is still a pre-split share", () => {
    const out = splitAdjustedDeltas([
      trade(q(0.992728)), //  everything up to 2025-05-23
      trade(q(0.008727)), //  the $10 buy, 2025-05-27, before the split
      split(q(9.013095)), //  the split, 2025-05-27
    ]);

    expect(out[0]!.splitFactor).toBe(10);
    expect(out[1]!.splitFactor).toBe(10);
    expect(out[1]!.adjustedDeltaE8).toBe(q(0.08727));
    expect(out[2]!.adjustedDeltaE8).toBe(0);
  });

  test("a trade after the split is left exactly alone", () => {
    const out = splitAdjustedDeltas([trade(q(1)), split(q(9)), trade(q(5)), trade(q(-2))]);
    expect(out[2]).toEqual({ adjustedDeltaE8: q(5), splitFactor: 1 });
    expect(out[3]).toEqual({ adjustedDeltaE8: q(-2), splitFactor: 1 });
  });

  test("a sale before a split is scaled like a purchase", () => {
    const out = splitAdjustedDeltas([trade(q(3)), trade(q(-1)), split(q(18))]);
    expect(out[1]!.adjustedDeltaE8).toBe(q(-10));
    expect(out[0]!.adjustedDeltaE8 + out[1]!.adjustedDeltaE8).toBe(q(20));
  });

  test("no splits leaves every delta untouched at factor 1", () => {
    const events = [trade(q(1)), trade(q(-0.5)), trade(q(2))];
    const out = splitAdjustedDeltas(events);
    expect(out.map((e) => e.splitFactor)).toEqual([1, 1, 1]);
    expect(out.map((e) => e.adjustedDeltaE8)).toEqual(events.map((e) => e.deltaE8));
  });

  /** Two splits compound: an event before both carries their product. */
  test("successive splits multiply", () => {
    const out = splitAdjustedDeltas([
      trade(q(1)), //     1 share
      split(q(1)), //     2-for-1 → 2
      split(q(4)), //     3-for-1 → 6
      trade(q(1)),
    ]);
    expect(out[0]).toEqual({ adjustedDeltaE8: q(6), splitFactor: 6 });
    expect(out[1]!.splitFactor).toBe(3);
    expect(out[3]!.splitFactor).toBe(1);
    const total = out.reduce((s, e) => s + e.adjustedDeltaE8, 0);
    expect(total).toBe(q(7)); // 6 + 1, and the as-traded sum is 1+1+4+1 = 7
  });

  /** A reverse split shrinks the count; the ratio is simply below 1. */
  test("a reverse split has a ratio under one and still balances", () => {
    const events = [trade(q(10)), split(q(-9))]; // 1-for-10
    const out = splitAdjustedDeltas(events);
    expect(out[0]).toEqual({ adjustedDeltaE8: q(1), splitFactor: 0.1 });
    expect(out.reduce((s, e) => s + e.adjustedDeltaE8, 0)).toBe(q(1));
  });

  /**
   * ⛔ A split recorded before anything was held. Without the zero guard the
   * ratio is `delta / 0` — Infinity, or NaN when the delta is 0 too — and it
   * would not throw. It would multiply every earlier quantity into a NaN and
   * publish a net worth of "NaN" with total confidence.
   */
  test("a split of an empty position is inert, never a division by zero", () => {
    /*
     * The events BEFORE the split are what prove the guard. A split at index 0
     * divides by zero too, but its Infinity has nothing behind it to poison —
     * the suffix product only reaches earlier events. Here the position is
     * opened and closed first, so `asTraded` is 0 at the split and both earlier
     * factors go Infinite without the guard, taking every quantity to NaN.
     */
    const out = splitAdjustedDeltas([trade(q(1)), trade(q(-1)), split(q(5)), trade(q(2))]);
    for (const e of out) {
      expect(Number.isFinite(e.splitFactor)).toBe(true);
      expect(Number.isFinite(e.adjustedDeltaE8)).toBe(true);
      expect(Number.isNaN(e.adjustedDeltaE8)).toBe(false);
    }
    expect(out.map((e) => e.splitFactor)).toEqual([1, 1, 1, 1]);
    expect(out[0]!.adjustedDeltaE8).toBe(q(1));
    expect(out[2]!.adjustedDeltaE8).toBe(0);
  });

  test("an empty timeline adjusts to nothing", () => {
    expect(splitAdjustedDeltas([])).toEqual([]);
  });

  test("does not mutate the caller's events", () => {
    const events = [trade(q(1)), split(q(9))];
    const copy = events.map((e) => ({ ...e }));
    splitAdjustedDeltas(events);
    expect(events).toEqual(copy);
  });

  /**
   * ⚠️ A ratio that does not divide the deltas evenly. 4-for-3 on a position
   * built from 1 + 2 units gives factors of 4/3, and `1e8 × 4/3` is
   * 133,333,333.33… — not a quantity. `quantity_delta_e8` is an INTEGER column
   * and `formatQuantityE8` throws on a non-integer, so an unrounded value would
   * reach a render path and take the page down.
   */
  test("a ratio that does not divide evenly still yields integer e8 quantities", () => {
    const out = splitAdjustedDeltas([trade(1e8), trade(2e8), split(1e8)]); // 3 → 4
    expect(out[0]!.splitFactor).toBeCloseTo(4 / 3, 12);
    expect(out[0]!.adjustedDeltaE8).toBe(133_333_333);
    expect(out[1]!.adjustedDeltaE8).toBe(266_666_667);
    for (const e of out) expect(Number.isInteger(e.adjustedDeltaE8)).toBe(true);
    // and it still lands on the as-traded total, 1 + 2 + 1 = 4
    expect(out.reduce((s, e) => s + e.adjustedDeltaE8, 0)).toBe(4e8);
  });

  test("a clean fractional ratio is exact", () => {
    const out = splitAdjustedDeltas([trade(q(2)), split(q(1))]); // 3-for-2
    expect(out[0]!.splitFactor).toBeCloseTo(1.5, 10);
    expect(out[0]!.adjustedDeltaE8).toBe(q(3));
  });
});
