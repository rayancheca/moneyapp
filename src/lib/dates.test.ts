import { describe, expect, test } from "vitest";
import {
  DateParseError,
  addDays,
  compareDates,
  diffDays,
  fromEpochDay,
  isValidIsoDate,
  isoWeekday,
  monthKey,
  periodBounds,
  todayIso,
  toEpochDay,
} from "./dates";

describe("validation", () => {
  test.each(["2026-07-08", "2024-02-29", "1999-12-31", "2026-01-01"])(
    "accepts %s",
    (s) => expect(isValidIsoDate(s)).toBe(true),
  );

  test.each([
    "2025-02-29", // not a leap year
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "26-04-01",
    "2026/04/01",
    "2026-4-1",
    "",
    "garbage",
  ])("rejects %s", (s) => expect(isValidIsoDate(s)).toBe(false));

  test("operations throw DateParseError on invalid input", () => {
    expect(() => toEpochDay("2025-02-29")).toThrow(DateParseError);
    expect(() => addDays("nope", 1)).toThrow(DateParseError);
  });
});

describe("epoch-day round trip and arithmetic", () => {
  test("round trips", () => {
    for (const d of ["1970-01-01", "2024-02-29", "2026-07-08", "2099-12-31"]) {
      expect(fromEpochDay(toEpochDay(d))).toBe(d);
    }
  });

  test("addDays crosses months, years, leap day", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-01-01", -1)).toBe("2024-12-31");
    expect(addDays("2026-07-08", 0)).toBe("2026-07-08");
  });

  test("diffDays is signed (b − a)", () => {
    expect(diffDays("2026-01-01", "2026-01-31")).toBe(30);
    expect(diffDays("2026-01-31", "2026-01-01")).toBe(-30);
    expect(diffDays("2024-12-31", "2025-01-01")).toBe(1);
  });

  test("compareDates orders", () => {
    expect(compareDates("2026-01-01", "2026-01-02")).toBeLessThan(0);
    expect(compareDates("2026-01-02", "2026-01-02")).toBe(0);
  });
});

describe("ISO weekday", () => {
  test.each([
    ["2026-07-06", 0], // Monday
    ["2026-07-09", 3], // Thursday (payday)
    ["2026-07-12", 6], // Sunday
    ["1970-01-01", 3], // epoch Thursday
    ["2024-12-30", 0], // Monday
  ])("%s -> %d", (date, expected) => {
    expect(isoWeekday(date)).toBe(expected);
  });
});

describe("periodBounds", () => {
  test("daily is the date itself", () => {
    expect(periodBounds("2026-07-08", "daily")).toEqual({
      start: "2026-07-08",
      end: "2026-07-08",
    });
  });

  test("weekly is ISO Monday..Sunday", () => {
    expect(periodBounds("2026-07-08", "weekly")).toEqual({
      start: "2026-07-06",
      end: "2026-07-12",
    });
    // a Monday starts its own week
    expect(periodBounds("2026-07-06", "weekly").start).toBe("2026-07-06");
    // a Sunday ends its week
    expect(periodBounds("2026-07-12", "weekly").start).toBe("2026-07-06");
  });

  test("weekly across the year boundary (the Dec 29 – Jan 4 oracle)", () => {
    // 2024-12-30 is a Monday; the week spans into 2025
    expect(periodBounds("2024-12-31", "weekly")).toEqual({
      start: "2024-12-30",
      end: "2025-01-05",
    });
    expect(periodBounds("2025-01-01", "weekly")).toEqual({
      start: "2024-12-30",
      end: "2025-01-05",
    });
  });

  test("monthly handles 28/29/30/31-day months and December", () => {
    expect(periodBounds("2026-02-10", "monthly")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
    expect(periodBounds("2024-02-10", "monthly")).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
    });
    expect(periodBounds("2026-12-25", "monthly")).toEqual({
      start: "2026-12-01",
      end: "2026-12-31",
    });
    expect(periodBounds("2026-04-01", "monthly")).toEqual({
      start: "2026-04-01",
      end: "2026-04-30",
    });
  });

  test("annual is the calendar year", () => {
    expect(periodBounds("2026-07-08", "annual")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });
});

describe("monthKey / todayIso", () => {
  test("monthKey buckets", () => {
    expect(monthKey("2026-07-08")).toBe("2026-07");
    expect(monthKey("2026-12-31")).toBe("2026-12");
  });

  test("todayIso formats a provided clock in local time", () => {
    expect(todayIso(new Date(2026, 6, 8, 23, 59))).toBe("2026-07-08");
    expect(todayIso(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});
