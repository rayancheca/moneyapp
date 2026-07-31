import { describe, expect, test } from "vitest";
import { CHART_RANGES, rangeLabel, rangeStartDay } from "./chart-range";

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
