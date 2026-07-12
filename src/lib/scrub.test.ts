import { describe, expect, test } from "vitest";
import { clampIndex, ratioToIndex, scrubValueText, stepScrubIndex } from "./scrub";

describe("clampIndex", () => {
  test("empty series clamps to -1", () => {
    expect(clampIndex(5, 0)).toBe(-1);
  });
  test("clamps below and above the range", () => {
    expect(clampIndex(-3, 10)).toBe(0);
    expect(clampIndex(99, 10)).toBe(9);
  });
  test("passes an in-range index through", () => {
    expect(clampIndex(4, 10)).toBe(4);
  });
});

describe("stepScrubIndex", () => {
  test("returns null for an empty series", () => {
    expect(stepScrubIndex(0, "ArrowRight", 0)).toBeNull();
  });
  test("arrows step one day and clamp at the ends", () => {
    expect(stepScrubIndex(3, "ArrowRight", 10)).toBe(4);
    expect(stepScrubIndex(3, "ArrowLeft", 10)).toBe(2);
    expect(stepScrubIndex(9, "ArrowRight", 10)).toBe(9); // clamp at end
    expect(stepScrubIndex(0, "ArrowLeft", 10)).toBe(0); // clamp at start
  });
  test("up/down step a week", () => {
    expect(stepScrubIndex(3, "ArrowUp", 20)).toBe(10);
    expect(stepScrubIndex(10, "ArrowDown", 20)).toBe(3);
    expect(stepScrubIndex(2, "ArrowDown", 20)).toBe(0); // clamps
  });
  test("Home and End jump to the ends", () => {
    expect(stepScrubIndex(5, "Home", 10)).toBe(0);
    expect(stepScrubIndex(5, "End", 10)).toBe(9);
  });
  test("returns null for a non-scrub key", () => {
    expect(stepScrubIndex(5, "Enter", 10)).toBeNull();
  });
});

describe("ratioToIndex", () => {
  test("empty series → -1", () => {
    expect(ratioToIndex(0.5, 0)).toBe(-1);
  });
  test("single point is always index 0", () => {
    expect(ratioToIndex(0.9, 1)).toBe(0);
  });
  test("maps position to the nearest index", () => {
    expect(ratioToIndex(0, 11)).toBe(0);
    expect(ratioToIndex(0.5, 11)).toBe(5);
    expect(ratioToIndex(1, 11)).toBe(10);
    expect(ratioToIndex(0.51, 11)).toBe(5); // rounds
  });
  test("clamps out-of-range ratios", () => {
    expect(ratioToIndex(-0.2, 11)).toBe(0);
    expect(ratioToIndex(1.4, 11)).toBe(10);
  });
});

describe("scrubValueText", () => {
  test("no change clause when changePct is null", () => {
    expect(scrubValueText("Jul 8, 2026", "$48,210", null)).toBe("Jul 8, 2026: $48,210");
  });
  test("up / down direction with one decimal", () => {
    expect(scrubValueText("Jul 8, 2026", "$48,210", 1.23)).toBe("Jul 8, 2026: $48,210, up 1.2%");
    expect(scrubValueText("Jul 8, 2026", "$48,210", -4.62)).toBe("Jul 8, 2026: $48,210, down 4.6%");
  });
  test("exactly flat reads 'unchanged'", () => {
    expect(scrubValueText("Jul 8, 2026", "$48,210", 0)).toBe("Jul 8, 2026: $48,210, unchanged");
  });
});
