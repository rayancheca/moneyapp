import { describe, expect, test } from "vitest";
import { formatDayLong, formatDayShort, formatMonthYear } from "./format-date";

describe("format-date", () => {
  test("formatDayShort", () => {
    expect(formatDayShort("2026-07-03")).toBe("Jul 3");
    expect(formatDayShort("2026-12-25")).toBe("Dec 25");
  });

  test("formatDayLong includes the weekday, date, and year", () => {
    // 2026-07-03 is a Friday
    expect(formatDayLong("2026-07-03")).toBe("Fri, Jul 3, 2026");
    // 2026-01-01 is a Thursday
    expect(formatDayLong("2026-01-01")).toBe("Thu, Jan 1, 2026");
  });

  test("formatMonthYear", () => {
    expect(formatMonthYear("2026-07-03")).toBe("Jul 2026");
  });

  test("throws on a malformed date", () => {
    expect(() => formatDayShort("not-a-date")).toThrow();
  });
});
