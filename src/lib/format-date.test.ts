import { describe, expect, test } from "vitest";
import { formatDayLong, formatDayShort, formatDayShortIn, formatMonthYear, monthWindowLabel } from "./format-date";

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

describe("formatDayShortIn", () => {
  test("stays short inside the reference year", () => {
    expect(formatDayShortIn("2026-08-09", "2026-09-02")).toBe("Aug 9");
    expect(formatDayShortIn("2026-01-01", "2026-12-31")).toBe("Jan 1");
  });

  /**
   * 🔴 The measured case: a September 2024 charge printed as a bare "Sep 18" in
   * September 2026, beside the words "714 days ago". Read as this year it is a
   * date sixteen days in the FUTURE, so one phrase contradicted itself.
   */
  test("names the year outside it, in both directions", () => {
    expect(formatDayShortIn("2024-09-18", "2026-09-02")).toBe("Sep 18, 2024");
    expect(formatDayShortIn("2027-01-16", "2026-09-02")).toBe("Jan 16, 2027");
  });

  /** ⛔ The boundary is the YEAR, not a number of days: 1 January is a new year. */
  test("a day either side of new year is a different year, however close", () => {
    expect(formatDayShortIn("2025-12-31", "2026-01-01")).toBe("Dec 31, 2025");
    expect(formatDayShortIn("2026-01-01", "2025-12-31")).toBe("Jan 1, 2026");
  });
});

/*
 * 🔴 The dashboard named ONE window two ways on one screen. The runway,
 * eating-out and subscriptions cards printed the raw key — "6 complete months,
 * 2026-03 to 2026-08" — while the fees and transfers cards beside them, over
 * the identical window, read "Mar 2026 to Aug 2026". This is the spelling the
 * correct siblings already used, not a new one.
 */
describe("monthWindowLabel", () => {
  test("names both ends the way the cards that were right already did", () => {
    expect(monthWindowLabel("2026-03", "2026-08")).toBe("Mar 2026 to Aug 2026");
  });

  test("one month is not a range", () => {
    expect(monthWindowLabel("2022-09", "2022-09")).toBe("Sep 2022");
  });

  test("a window whose ends are in different years says both", () => {
    expect(monthWindowLabel("2025-11", "2026-02")).toBe("Nov 2025 to Feb 2026");
  });

  test("never a raw month key", () => {
    for (const [a, b] of [["2026-03", "2026-08"], ["2022-09", "2022-09"], ["2025-11", "2026-02"]]) {
      expect(monthWindowLabel(a!, b!)).not.toMatch(/\d{4}-\d{2}/);
    }
  });
});
