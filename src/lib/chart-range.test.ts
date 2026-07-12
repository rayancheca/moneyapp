import { describe, expect, test } from "vitest";
import { CHART_RANGES, rangeLabel, rangeStartDay } from "./chart-range";

const TODAY = "2026-07-08";

describe("rangeStartDay", () => {
  test("trailing windows count back in days", () => {
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
      "1 month",
      "3 months",
      "year to date",
      "1 year",
      "all time",
    ]);
  });
});
