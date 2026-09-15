import { describe, expect, test } from "vitest";
import { postedInsidePeriod } from "./statement-period";

describe("postedInsidePeriod — a statement's row posted inside the period whose balance counts it", () => {
  const period = { start: "2025-09-03", end: "2025-10-02" };

  test("a day inside the period, both ends included, is the day", () => {
    expect(postedInsidePeriod("2025-09-03", period)).toBe("2025-09-03");
    expect(postedInsidePeriod("2025-09-20", period)).toBe("2025-09-20");
    expect(postedInsidePeriod("2025-10-02", period)).toBe("2025-10-02");
  });

  test("a day before the period opens posts on the opening day", () => {
    expect(postedInsidePeriod("2025-09-02", period)).toBe("2025-09-03");
    expect(postedInsidePeriod("2024-12-31", period)).toBe("2025-09-03");
  });

  test("a day after the period closes posts on the closing day", () => {
    expect(postedInsidePeriod("2025-10-03", period)).toBe("2025-10-02");
  });
});
