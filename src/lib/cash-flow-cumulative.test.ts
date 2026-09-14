import { describe, expect, test } from "vitest";
import { cashFlowCumulative, ghostRowLabel, type CashCumulativeInput } from "./cash-flow-cumulative";

/** a bucket in the service's sign convention: net = income + refunds − spending */
function bucket(
  key: string,
  incomeCents: number,
  spendingCents: number,
  refundsCents = 0,
): CashCumulativeInput {
  return {
    key,
    label: key,
    incomeCents,
    spendingCents,
    refundsCents,
    netCents: incomeCents + refundsCents - spendingCents,
  };
}

describe("cashFlowCumulative", () => {
  test("no buckets → no points", () => {
    expect(cashFlowCumulative([], null, 0)).toEqual([]);
  });

  test("accumulates each term across the window", () => {
    const rows = cashFlowCumulative([bucket("a", 10_000, 3_000), bucket("b", 0, 4_000)], null, 0);
    expect(rows.map((r) => r.earnedCum)).toEqual([10_000, 10_000]);
    expect(rows.map((r) => r.spentCum)).toEqual([3_000, 7_000]);
    expect(rows.map((r) => r.netCum)).toEqual([7_000, 3_000]);
    expect(rows.map((r) => r.ghostCum)).toEqual([null, null]);
    expect(rows[1]!.label).toBe("b");
  });

  /**
   * 🔴 `/spending?period=2026-07&cash=graph` drew −$10,301.01 under a page whose
   * own Net card read −$10,187.90 — exactly the period's $113.11 of refunds.
   */
  test("Net is the period's own net, not earned − spent", () => {
    const rows = cashFlowCumulative([bucket("a", 10_000, 20_000, 500)], null, 0);
    expect(rows[0]!.netCum).toBe(-9_500);
    expect(rows[0]!.earnedCum - rows[0]!.spentCum).toBe(-10_000); // what the graph used to draw
    expect(rows[0]!.refundsCum).toBe(500); // and the term that explains the gap
  });

  test("the refund term accumulates alongside the others", () => {
    const rows = cashFlowCumulative([bucket("a", 0, 1_000, 200), bucket("b", 0, 1_000, 300)], null, 0);
    expect(rows.map((r) => r.refundsCum)).toEqual([200, 500]);
    expect(rows[1]!.netCum).toBe(rows[1]!.earnedCum + rows[1]!.refundsCum - rows[1]!.spentCum);
  });

  describe("the prior-period ghost", () => {
    const three = [bucket("a", 0, 100), bucket("b", 0, 200), bucket("c", 0, 300)];

    test("a mismatched-length series draws no ghost", () => {
      const rows = cashFlowCumulative(three, [1_000, 2_000], 3_000);
      expect(rows.map((r) => r.ghostCum)).toEqual([null, null, null]);
    });

    test("accumulates the aligned prior spend", () => {
      const rows = cashFlowCumulative(three, [1_000, 2_000, 3_000], 6_000);
      expect(rows.map((r) => r.ghostCum)).toEqual([1_000, 3_000, 6_000]);
    });

    /**
     * 🔴 The last point is the page's own "$X in <prior month>" readout. A
     * prior period LONGER than this window (March 31 days under April's 30)
     * has a tail no bucket can carry; without this it ended below the figure
     * printed beside it, on 33 of 53 periods.
     */
    test("the final point carries the prior period whole, tail included", () => {
      const rows = cashFlowCumulative(three, [1_000, 2_000, 3_000], 9_500);
      expect(rows[2]!.ghostCum).toBe(9_500);
      expect(rows[1]!.ghostCum).toBe(3_000); // earlier points stay honest running totals
    });

    /** a SHORTER prior period leaves trailing nulls — the running total holds flat */
    test("a null bucket contributes nothing and never breaks the running total", () => {
      const rows = cashFlowCumulative(three, [1_000, null, 2_000], 3_000);
      expect(rows.map((r) => r.ghostCum)).toEqual([1_000, 1_000, 3_000]);
    });

    /**
     * 🔴 THE PIN WAS RIGHT AND THE SENTENCE ON IT WAS NOT. The tooltip printed
     * "Spent by here, August 2026" at every point — including the last, whose
     * figure is August WHOLE, the $337.03 of Aug 31 that no September bucket can
     * carry included. "By here" is a running total; that point is not one.
     * Measured 2026-09-14: 19 of 49 month periods, every 30-day month after a
     * 31-day one. ⛔ The pin itself stays — reverting it reopens the 33-of-53
     * disagreement with the page's own readout.
     */
    test("the pinned last point says it is the whole prior period, not a running total", () => {
      const rows = cashFlowCumulative(three, [1_000, 2_000, 3_000], 9_500);
      expect(rows[2]!.ghostCum).toBe(9_500);
      expect(rows[2]!.ghostCum).not.toBe(6_000); // the fixture really has a tail
      expect(rows[2]!.ghostWhole).toBe(true);
      expect(ghostRowLabel(rows[2]!, "August 2026")).toBe("Spent in August 2026");
      expect(rows[1]!.ghostWhole).toBe(false);
      expect(ghostRowLabel(rows[1]!, "August 2026")).toBe("Spent by here, August 2026");
    });

    test("the wording is decided by position, not by whether the prior period had a tail", () => {
      for (const [aligned, whole] of [
        [[1_000, 2_000, 3_000], 6_000], // the same length
        [[1_000, null, 2_000], 3_000], // shorter
      ] as const) {
        const rows = cashFlowCumulative(three, aligned, whole);
        expect(rows.map((r) => r.ghostWhole)).toEqual([false, false, true]);
      }
    });

    test("no ghost, no claim about one", () => {
      for (const rows of [cashFlowCumulative(three, null, 0), cashFlowCumulative(three, [1_000, 2_000], 3_000)]) {
        expect(rows.every((r) => r.ghostWhole === false)).toBe(true);
      }
    });

    test("an unnamed prior period still reads as a sentence", () => {
      const rows = cashFlowCumulative(three, [1_000, 2_000, 3_000], 9_500);
      expect(ghostRowLabel(rows[2]!, null)).toBe("Spent in the prior period");
      expect(ghostRowLabel(rows[0]!, null)).toBe("Spent by here, prior period");
    });
  });
});
