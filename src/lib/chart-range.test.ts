import { describe, expect, test } from "vitest";
import { CHART_RANGES, rangeAggregateStartDay, rangeLabel, rangeStartDay } from "./chart-range";
import { diffDays } from "./dates";

const TODAY = "2026-07-08";

describe("rangeStartDay", () => {
  test("trailing windows count back in days", () => {
    expect(rangeStartDay("1D", TODAY)).toBe("2026-07-07");
    expect(rangeStartDay("1W", TODAY)).toBe("2026-07-01");
    expect(rangeStartDay("1M", TODAY)).toBe("2026-06-08");
    expect(rangeStartDay("3M", TODAY)).toBe("2026-04-08");
    expect(rangeStartDay("1Y", TODAY)).toBe("2025-07-08");
  });
  test("YTD anchors to Jan 1 of the year", () => {
    expect(rangeStartDay("YTD", TODAY)).toBe("2026-01-01");
  });
  test("ALL has no lower bound", () => {
    expect(rangeStartDay("ALL", TODAY)).toBeNull();
  });
});

describe("rangeLabel", () => {
  test("labels every range", () => {
    expect(CHART_RANGES.map(rangeLabel)).toEqual([
      "1 day",
      "1 week",
      "1 month",
      "3 months",
      "year to date",
      "1 year",
      "all time",
    ]);
  });
});

describe("the pill order", () => {
  /**
   * Shortest-to-longest, and ALL last. The order is what the pill row renders, so
   * an insertion in the wrong place silently reshuffles the UI on every chart —
   * cheaper to pin here than to notice in a screenshot.
   */
  test("runs shortest to longest with ALL last", () => {
    expect([...CHART_RANGES]).toEqual(["1D", "1W", "1M", "3M", "YTD", "1Y", "ALL"]);
  });

  test("every trailing window is strictly shorter than the next", () => {
    const TODAY_ = "2026-07-08";
    const starts = ["1D", "1W", "1M", "3M", "1Y"].map((r) => rangeStartDay(r as never, TODAY_)!);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]!.localeCompare(starts[i - 1]!)).toBeLessThan(0);
    }
  });
});

/*
 * 🔴 ONE PILL, TWO KINDS OF WINDOW, and the dashboard used the same day for
 * both.
 *
 * A chart and a bridge answer a DIFFERENCE between two endpoints, so "1 month"
 * needs 31 daily points to hold 30 daily changes — `rangeStartDay` is right for
 * them, and `netWorthAttribution` sums its flows over `(from, to]` for exactly
 * that reason. The money-flow Sankey answers a SUM OVER DAYS, and summing
 * `[from, to]` inclusive over the same `from` gives it thirty-ONE days.
 *
 * Measured on the real ledger, the dashboard's Flow view at the "1 month" pill:
 *
 *     today = 2025-08-06   [2025-07-07 … 2025-08-06]  31 days   $9,148.10
 *                          [2025-07-08 … 2025-08-06]  30 days   $5,353.72
 *     today = 2025-12-04   31 days $10,890.62 / 30 days $7,183.04
 *
 * The extra day on 2025-08-06 is 2025-07-07, which holds `Direct Payment
 * Hoffman LL` −$1,779.49 — the previous landlord's rent — while 2025-08-04
 * inside the window holds the next one. Rent twice in a window labelled one
 * month, and the total 71% high.
 */
describe("rangeAggregateStartDay — a sum over days, not a difference between endpoints", () => {
  test("an N-day window holds exactly N days", () => {
    for (const [range, days] of [["1W", 7], ["1M", 30], ["3M", 91], ["1Y", 365]] as const) {
      const from = rangeAggregateStartDay(range, "2026-09-01")!;
      expect(diffDays(from, "2026-09-01") + 1, range).toBe(days);
    }
  });

  test("it is exactly one day after the point-window start, and never the same", () => {
    for (const range of ["1W", "1M", "3M", "1Y"] as const) {
      const points = rangeStartDay(range, "2026-09-01")!;
      const days = rangeAggregateStartDay(range, "2026-09-01")!;
      expect(diffDays(points, days), range).toBe(1);
    }
  });

  test("YTD and ALL are anchored, not trailing, so both agree about them", () => {
    expect(rangeAggregateStartDay("YTD", "2026-09-01")).toBe(rangeStartDay("YTD", "2026-09-01"));
    expect(rangeAggregateStartDay("ALL", "2026-09-01")).toBeNull();
    expect(rangeStartDay("ALL", "2026-09-01")).toBeNull();
  });

  test("1D is a single day — today", () => {
    expect(rangeAggregateStartDay("1D", "2026-09-01")).toBe("2026-09-01");
  });
});
