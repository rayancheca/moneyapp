import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DateParseError,
  addCalendarMonths,
  addDays,
  calendarMonthsToReach,
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
    // An ISO INSTANT is not a day, and must never become one here. This is the
    // zod refinement guarding writes to `posted_on` / `occurred_on`, columns the
    // whole ledger reads as bank-local calendar days. Relaxing it to accept a
    // leading date prefix — the shortcut the 1D intraday view invites — would
    // let an instant be stored as a day. The chart substitutes its window
    // instead; see chart-window.test.ts's refusal guards.
    "2026-07-31T13:30:00.000Z",
  ])("rejects %s", (s) => expect(isValidIsoDate(s)).toBe(false));

  // The parser reads digits off the string by char code instead of running a
  // regex, so the shape checks are hand-written and each needs its own case.
  test.each([
    ["2026-0a-01", "a digit position holding a char ABOVE '9'"],
    ["2026-0/-01", "a digit position holding a char BELOW '0'"],
    ["2026-07x01", "the second separator not being a dash"],
    ["2026x07-01", "the first separator not being a dash"],
    ["٢٠٢٦-٠٧-٠١", "non-ASCII digits"],
  ])("rejects %s — %s", (s) => expect(isValidIsoDate(s)).toBe(false));

  // Years 0000-0099 have never been accepted: the original implementation built
  // the date with Date.UTC, which maps them into 1900-1999, so its own
  // round-trip check rejected them. Pinned because five server actions use
  // isValidIsoDate as their zod refinement for user input.
  test.each(["0000-01-01", "0001-01-01", "0099-12-31"])(
    "rejects year %s (below the Date.UTC two-digit-year boundary)",
    (s) => expect(isValidIsoDate(s)).toBe(false),
  );
  test("accepts the first year above that boundary", () => {
    expect(isValidIsoDate("0100-01-01")).toBe(true);
  });

  test.each([
    ["2000-02-29", true], // divisible by 400
    ["1900-02-29", false], // divisible by 100, not 400
    ["2024-02-29", true], // divisible by 4
    ["2023-02-29", false],
  ])("leap-year rule: %s -> %s", (s, valid) => expect(isValidIsoDate(s)).toBe(valid));

  test("periodBounds and monthKey reject a malformed date rather than guessing", () => {
    expect(() => monthKey("2026-13-01")).toThrow(DateParseError);
    expect(() => periodBounds("nope", "monthly")).toThrow(DateParseError);
  });

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

describe("addCalendarMonths", () => {
  test("keeps the day-of-month across months and years", () => {
    expect(addCalendarMonths("2026-08-08", 1)).toBe("2026-09-08");
    expect(addCalendarMonths("2026-12-11", 1)).toBe("2027-01-11");
    expect(addCalendarMonths("2026-09-11", 23)).toBe("2028-08-11");
    expect(addCalendarMonths("2026-07-08", 0)).toBe("2026-07-08");
  });

  test("steps backwards, including across a year boundary", () => {
    expect(addCalendarMonths("2026-01-11", -1)).toBe("2025-12-11");
    expect(addCalendarMonths("2026-01-11", -13)).toBe("2024-12-11");
  });

  test("clamps a day the target month does not have", () => {
    expect(addCalendarMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addCalendarMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap
    expect(addCalendarMonths("2026-03-31", 1)).toBe("2026-04-30");
    expect(addCalendarMonths("2026-05-31", -1)).toBe("2026-04-30");
  });

  test("clamping is LOSSY when iterated, exact from the anchor", () => {
    // the trap this function's contract exists to name: two hops of one lose the
    // 31st for good, one hop of two keeps it
    expect(addCalendarMonths(addCalendarMonths("2026-01-31", 1), 1)).toBe("2026-03-28");
    expect(addCalendarMonths("2026-01-31", 2)).toBe("2026-03-31");
  });

  test("rejects a non-date the same way every other reader does", () => {
    expect(() => addCalendarMonths("2026-02-30", 1)).toThrow(DateParseError);
  });
});

describe("calendarMonthsToReach", () => {
  test("an anchor already on or after the boundary needs no steps", () => {
    expect(calendarMonthsToReach("2026-09-11", "2026-08-14")).toBe(0); // later month
    expect(calendarMonthsToReach("2026-08-20", "2026-08-14")).toBe(0); // same month
    expect(calendarMonthsToReach("2026-08-14", "2026-08-14")).toBe(0); // exactly on it
  });

  test("lands on the first occurrence on or after the boundary", () => {
    expect(calendarMonthsToReach("2026-08-05", "2026-08-14")).toBe(1); // same month, earlier day
    expect(calendarMonthsToReach("2026-01-05", "2026-03-20")).toBe(3);
    expect(calendarMonthsToReach("2026-01-25", "2026-03-20")).toBe(2);
  });

  test("a years-stale anchor resolves in one hop", () => {
    // UBER *ONE's real shape: stored 2025-06-25, read on 2026-08-14
    expect(calendarMonthsToReach("2025-06-25", "2026-08-14")).toBe(14);
    expect(addCalendarMonths("2025-06-25", 14)).toBe("2026-08-25");
  });

  test("a clamped candidate still counts as reaching its own month", () => {
    // 1 step from Jan 31 is Feb 28; the boundary is inside February, and Feb 28
    // is on or after it, so the answer must be 1 and not 2
    expect(calendarMonthsToReach("2026-01-31", "2026-02-10")).toBe(1);
    // but a boundary LATER in February than the clamp needs the next month
    expect(calendarMonthsToReach("2026-01-31", "2026-03-01")).toBe(2);
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

describe("MONEYAPP_FAKE_TODAY (frozen e2e clock)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a valid pinned date wins on the zero-argument path", () => {
    vi.stubEnv("MONEYAPP_FAKE_TODAY", "2026-07-08");
    expect(todayIso()).toBe("2026-07-08");
  });

  test("an invalid format is ignored, never thrown", () => {
    vi.stubEnv("MONEYAPP_FAKE_TODAY", "2026-7-8");
    expect(todayIso()).toBe(todayIso(new Date()));
  });

  test("unset env keeps the real clock", () => {
    vi.stubEnv("MONEYAPP_FAKE_TODAY", undefined);
    expect(todayIso()).toBe(todayIso(new Date()));
  });

  test("an explicit now beats the env", () => {
    vi.stubEnv("MONEYAPP_FAKE_TODAY", "2026-07-08");
    expect(todayIso(new Date(2025, 0, 2, 12, 0))).toBe("2025-01-02");
  });
});
