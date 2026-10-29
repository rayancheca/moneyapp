import { describe, expect, test } from "vitest";
import {
  cashFlowCumulative,
  ghostRowLabel,
  isLonePoint,
  plottedRunningTotals,
  runningIncomeUnread,
  runningIncomeUnreadDays,
  type CashCumulativeInput,
} from "./cash-flow-cumulative";
import type { UnreachedKind } from "./empty-period";

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

/**
 * 🔴 THE LINES CLAIMED WHAT THE TOOLTIP UNDER THEM REFUSES. The graph lens's
 * tooltip stopped printing "Through 30 … Spent $1,431.05" of a day nobody has
 * imported, and the Spent line went on running flat through it at $1,431.05
 * anyway — a running total drawn "through" a day is the same claim. Measured on
 * the owner's ledger 2026-09-15 (first row 2022-08-25, newest 2026-09-12): 52
 * points on 4 of 55 month/year periods — `?period=2026-09` Sep 13–30 (18),
 * `?period=2026` Oct–Dec (3), `?period=2022-08` Aug 1–24 (24), `?period=2022`
 * Jan–Jul (7).
 */
describe("plottedRunningTotals — a line is drawn only through buckets the ledger has read", () => {
  const withKinds = (kinds: readonly (UnreachedKind | null)[]) => {
    const buckets = kinds.map((unreached, i) => ({
      ...bucket(`d${i + 1}`, 0, 1_000 * (i + 1)),
      unreached,
      incomeUnread: false,
    }));
    return { buckets, points: cashFlowCumulative(buckets, [500, 500, 500, 500], 2_000) };
  };

  test("an unreached bucket carries no running total to draw", () => {
    const { buckets, points } = withKinds([null, null, "after-records", "future"]);
    const plotted = plottedRunningTotals(points, buckets);
    expect(plotted.map((p) => p.spentCum)).toEqual([1_000, 3_000, null, null]);
    for (const p of plotted.slice(2)) {
      expect([p.earnedCum, p.refundsCum, p.spentCum, p.netCum]).toEqual([null, null, null, null]);
    }
  });

  test("the days before the records begin are not drawn either — the line starts where the ledger does", () => {
    const { buckets, points } = withKinds(["before-records", "before-records", null, null]);
    expect(plottedRunningTotals(points, buckets).map((p) => p.netCum)).toEqual([null, null, -6_000, -10_000]);
  });

  /* ⛔ the prior period's running total is a fact about THAT period, and stays (owner decision E1a) */
  test("the prior period's line still runs beside an unreached point", () => {
    const { buckets, points } = withKinds([null, "after-records", "after-records", "future"]);
    const plotted = plottedRunningTotals(points, buckets);
    expect(plotted.map((p) => p.ghostCum)).toEqual([500, 1_000, 1_500, 2_000]);
    expect(plotted[3]!.ghostWhole).toBe(true);
  });

  test("a reached point plots exactly what the arithmetic computed, and the arithmetic is not touched", () => {
    const { buckets, points } = withKinds([null, null, "after-records", "future"]);
    const before = structuredClone(points);
    const plotted = plottedRunningTotals(points, buckets);
    expect(plotted.slice(0, 2)).toEqual(points.slice(0, 2));
    expect(points).toEqual(before);
    expect(points[3]!.spentCum).toBe(10_000); // the totals themselves still carry forward
  });

  test("a bucket is matched by its key, not by where it sits", () => {
    const { buckets, points } = withKinds([null, "after-records"]);
    expect(plottedRunningTotals(points, [...buckets].reverse()).map((p) => p.spentCum)).toEqual([1_000, null]);
  });
});

/**
 * ⚖️ §6A 68 on the graph lens: a running Income through a point is no measurement while no income has been found
 * through it and not one of its days is checked where his pay lands — every reached bucket up to it `incomeUnread`. Its
 * Income and its Net (Income's arithmetic) carry nothing to draw; Spent and the refunds are what was found, and stay.
 * 🔴 On his ledger copy 2026-10-21 `/spending?cash=graph` drew October's Income line flat at $0 and its Net at
 * −$1,603.00 through Oct 14, Wells Fargo checked through Sep 24 — the figures the cards, the table and the hover dash.
 */
describe("runningIncomeUnread / plottedRunningTotals — a running Income nobody has looked for", () => {
  const day = (
    key: string,
    incomeCents: number,
    spendingCents: number,
    incomeUnread: boolean,
    unreached: UnreachedKind | null = null,
  ) => ({ ...bucket(key, incomeCents, spendingCents), unreached, incomeUnread });

  test("October on his copy: every day unread, so no point carries a running Income or Net — Spent runs on", () => {
    const october = [day("01", 0, 21_661, true), day("02", 0, 19_758, true), day("14", 0, 4_819, true)];
    const plotted = plottedRunningTotals(cashFlowCumulative(october, null, 0), october);
    expect(plotted.map((p) => p.earnedCum)).toEqual([null, null, null]);
    expect(plotted.map((p) => p.netCum)).toEqual([null, null, null]);
    expect(plotted.map((p) => p.spentCum)).toEqual([21_661, 41_419, 46_238]);
    expect([...runningIncomeUnread(october)]).toEqual(["01", "02", "14"]);
  });

  test("a day read, or income found, makes every running total from it a figure — a lower bound past it", () => {
    // September on his copy: pay found Sep 24, Sep 25 – 30 unread — the total through Sep 30 holds what was found
    const september = [day("23", 456_768, 3_440, false), day("24", 114_192, 25_261, false), day("25", 0, 5_863, true)];
    expect(runningIncomeUnread(september).size).toBe(0);
    expect(plottedRunningTotals(cashFlowCumulative(september, null, 0), september).map((p) => p.earnedCum)).toEqual([
      456_768, 570_960, 570_960,
    ]);
    // …and a day checked with nothing in it is a measured $0.00, from which every later point is a figure
    const checked = [day("01", 0, 1_000, false), day("02", 0, 1_000, true)];
    expect(runningIncomeUnread(checked).size).toBe(0);
  });

  test("the run ends at the first bucket that is a figure; buckets before the records neither start nor end it", () => {
    const window = [
      day("01", 0, 0, false, "before-records"),
      day("02", 0, 1_000, true),
      day("03", 50_000, 1_000, false),
      day("04", 0, 1_000, true),
      day("05", 0, 0, false, "after-records"),
    ];
    expect([...runningIncomeUnread(window)]).toEqual(["02"]);
    const plotted = plottedRunningTotals(cashFlowCumulative(window, null, 0), window);
    expect(plotted.map((p) => p.earnedCum)).toEqual([null, null, 50_000, 50_000, null]);
    expect(plotted.map((p) => p.netCum)).toEqual([null, null, 48_000, 47_000, null]);
    expect(plotted.map((p) => p.refundsCum)).toEqual([null, 0, 0, 0, null]);
  });
});

/**
 * ⚖️ §6A 68: the DAYS each of those points sums — the run's first day through the point's own last — which its hover
 * names as not checked (2026-10-29). 🔴 His ledger copy 2026-10-29: the hover named a point by its axis label,
 * "not one day through Sep 26–30 has been checked …" and "… through Oct …" over `?from=2026-09-26&to=2026-12-31`, and
 * "… through Oct '26 …" over `?from=2026-09-25&to=2027-03-31`.
 */
describe("runningIncomeUnreadDays — the days a running Income nobody has looked for sums", () => {
  const span = (
    key: string,
    from: string,
    to: string,
    incomeUnread: boolean,
    unreached: UnreachedKind | null = null,
  ) => ({
    ...bucket(key, 0, 1_000),
    from,
    to,
    unreached,
    incomeUnread,
  });

  test("his copy's Sep 26 – Dec 31: each point sums from the run's first day through its own last", () => {
    const window = [
      span("2026-09", "2026-09-26", "2026-09-30", true),
      span("2026-10", "2026-10-01", "2026-10-31", true),
      span("2026-11", "2026-11-01", "2026-11-30", false, "future"),
      span("2026-12", "2026-12-01", "2026-12-31", false, "future"),
    ];
    expect([...runningIncomeUnreadDays(window)]).toEqual([
      ["2026-09", { from: "2026-09-26", to: "2026-09-30" }],
      ["2026-10", { from: "2026-09-26", to: "2026-10-31" }],
    ]);
  });

  test("its points are runningIncomeUnread's, and their days start where the ledger does", () => {
    const window = [
      span("01", "2022-08-01", "2022-08-01", false, "before-records"),
      span("02", "2022-08-02", "2022-08-02", true),
      span("03", "2022-08-03", "2022-08-03", false),
      span("04", "2022-08-04", "2022-08-04", true),
    ];
    expect([...runningIncomeUnreadDays(window).keys()]).toEqual([...runningIncomeUnread(window)]);
    expect(runningIncomeUnreadDays(window).get("02")).toEqual({ from: "2022-08-02", to: "2022-08-02" });
  });

  test("a running Income that is a figure from its first point has no such days", () => {
    expect(runningIncomeUnreadDays([span("2026-09-24", "2026-09-24", "2026-09-24", false)]).size).toBe(0);
  });
});

/**
 * 🔴 ONE BUCKET READ, NO LINE AT ALL. `plottedRunningTotals` ends each line at
 * the frontier, and each of the graph's lines is drawn with no dots — so a window
 * with exactly one bucket read drew axes and a legend naming three lines with
 * nothing on them: d3 draws a lone defined point as a moveto, which paints
 * nothing. Reachable on the e2e fixture at `?period=2026-Q3` (seeded fresh, fake
 * today 2026-07-08, newest row 2026-07-04: three months, July alone read); on
 * the owner's ledger (read 2026-09-15, newest row 2026-09-12) over
 * `?from=2026-09-01&to=2026-11-30`, `?from=2026-09-12&to=2026-09-30`,
 * `?from=2022-06-01&to=2022-08-31` and `?from=2022-08-01&to=2022-08-25`.
 */
describe("isLonePoint — a drawn point no segment reaches", () => {
  const lonesOf = (values: readonly (number | null)[]) => values.map((_, i) => isLonePoint(values, i));

  // the SHAPE of the fixture's `?period=2026-Q3`; the cents are constructed
  const quarter = [
    { ...bucket("2026-07", 100_000, 40_000), unreached: null, incomeUnread: false },
    { ...bucket("2026-08", 0, 0), unreached: "future" as const, incomeUnread: false },
    { ...bucket("2026-09", 0, 0), unreached: "future" as const, incomeUnread: false },
  ];

  test("one month read of three: each of the period's own lines is that one point", () => {
    const plotted = plottedRunningTotals(cashFlowCumulative(quarter, null, 0), quarter);
    for (const key of ["earnedCum", "spentCum", "netCum"] as const) {
      expect(lonesOf(plotted.map((p) => p[key]))).toEqual([true, false, false]);
    }
  });

  test("two points read are a segment, not two lone points", () => {
    expect(lonesOf([1_000, 3_000, null])).toEqual([false, false, false]);
  });

  test("the one point read can sit at the window's close — a range the ledger opens on its last day", () => {
    expect(lonesOf([null, null, 138_810])).toEqual([false, false, true]);
  });

  test("…or between two unread buckets", () => {
    expect(lonesOf([null, 475, null])).toEqual([false, true, false]);
  });

  test("a one-bucket window's only point stands alone", () => {
    expect(lonesOf([0])).toEqual([true]);
  });

  /* ⛔ the prior period's line carries a figure at every point or at none, so it is never broken */
  test("the prior period's line beside a lone point is a whole line", () => {
    const plotted = plottedRunningTotals(cashFlowCumulative(quarter, [5_000, 6_000, 7_000], 18_000), quarter);
    expect(lonesOf(plotted.map((p) => p.ghostCum))).toEqual([false, false, false]);
  });
});
