import { describe, expect, test } from "vitest";
import { MonthKeyParseError, addMonths, daysInMonthOf, monthLabel, monthMatrix, type CalendarDay, type WeekStart, weekdayLabels } from "./calendar-math";
import { addDays } from "./dates";

const INVALID_KEYS = ["", "2026", "2026-7", "202607", "2026-00", "2026-13", "2026-07-01", "abc"];

describe("addMonths", () => {
  test.each([
    ["2026-12", 1, "2027-01"],
    ["2026-01", -1, "2025-12"],
    ["2026-07", 0, "2026-07"],
    ["2026-07", 18, "2028-01"],
    ["2026-07", -19, "2024-12"],
    ["2026-06", 12, "2027-06"],
    ["2026-06", -12, "2025-06"],
    ["0999-03", 2, "0999-05"],
  ])("addMonths(%s, %d) -> %s", (key, delta, expected) => {
    expect(addMonths(key, delta)).toBe(expected);
  });

  test.each(INVALID_KEYS)("rejects invalid month key %j", (key) => {
    expect(() => addMonths(key, 1)).toThrow(MonthKeyParseError);
  });
});

describe("monthLabel", () => {
  test.each([
    ["2026-01", "January 2026"],
    ["2026-07", "July 2026"],
    ["2026-12", "December 2026"],
    ["1999-02", "February 1999"],
  ])("labels %s as %s", (key, expected) => {
    expect(monthLabel(key)).toBe(expected);
  });

  test("rejects invalid month keys", () => {
    expect(() => monthLabel("2026-13")).toThrow(MonthKeyParseError);
  });
});

describe("weekdayLabels", () => {
  test("Sunday start", () => {
    expect(weekdayLabels(0)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  test("Monday start", () => {
    expect(weekdayLabels(1)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });
});

function flat(matrix: CalendarDay[][]): CalendarDay[] {
  return matrix.flat();
}

function inMonthCount(matrix: CalendarDay[][]): number {
  return flat(matrix).filter((d) => d.inMonth).length;
}

describe("monthMatrix", () => {
  test("February 2026 (starts Sunday, 28 days) is exactly 4 rows with no padding", () => {
    const matrix = monthMatrix("2026-02"); // default weekStartsOn = 0
    expect(matrix).toHaveLength(4);
    expect(matrix[0]?.[0]?.iso).toBe("2026-02-01");
    expect(matrix[3]?.[6]?.iso).toBe("2026-02-28");
    expect(flat(matrix).every((d) => d.inMonth)).toBe(true);
  });

  test("February 2026 with Monday-start weeks pads 6 leading + 1 trailing day", () => {
    const matrix = monthMatrix("2026-02", 1);
    expect(matrix).toHaveLength(5);
    expect(matrix[0]?.[0]).toEqual({ iso: "2026-01-26", inMonth: false });
    expect(matrix[0]?.[6]).toEqual({ iso: "2026-02-01", inMonth: true });
    expect(matrix[4]?.[6]).toEqual({ iso: "2026-03-01", inMonth: false });
    expect(inMonthCount(matrix)).toBe(28);
  });

  test("leap February 2024 holds 29 in-month days", () => {
    const matrix = monthMatrix("2024-02", 0);
    expect(matrix).toHaveLength(5);
    expect(matrix[0]?.[0]?.iso).toBe("2024-01-28");
    expect(matrix[4]?.[6]?.iso).toBe("2024-03-02");
    expect(inMonthCount(matrix)).toBe(29);
  });

  test("non-leap February 2025 holds 28 in-month days", () => {
    const matrix = monthMatrix("2025-02", 0);
    expect(matrix).toHaveLength(5);
    expect(inMonthCount(matrix)).toBe(28);
  });

  test("century leap February 2000 holds 29 in-month days", () => {
    const matrix = monthMatrix("2000-02", 0);
    expect(inMonthCount(matrix)).toBe(29);
  });

  test("August 2026 (starts Saturday, 31 days) needs 6 rows", () => {
    const matrix = monthMatrix("2026-08", 0);
    expect(matrix).toHaveLength(6);
    expect(matrix[0]?.[0]?.iso).toBe("2026-07-26");
    expect(matrix[5]?.[6]?.iso).toBe("2026-09-05");
    expect(inMonthCount(matrix)).toBe(31);
  });

  test("June 2026 with Monday-start weeks starts on the 1st (no leading pad)", () => {
    const matrix = monthMatrix("2026-06", 1);
    expect(matrix).toHaveLength(5);
    expect(matrix[0]?.[0]).toEqual({ iso: "2026-06-01", inMonth: true });
    expect(matrix[4]?.[6]).toEqual({ iso: "2026-07-05", inMonth: false });
  });

  const DAYS_IN_2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  test.each<[WeekStart]>([[0], [1]])(
    "every month of 2026 is structurally sound with weekStartsOn %d",
    (weekStartsOn) => {
      for (let m = 1; m <= 12; m++) {
        const key = `2026-${m.toString().padStart(2, "0")}`;
        const matrix = monthMatrix(key, weekStartsOn);

        expect(matrix.length).toBeGreaterThanOrEqual(4);
        expect(matrix.length).toBeLessThanOrEqual(6);
        expect(matrix.every((week) => week.length === 7)).toBe(true);

        // days are contiguous across the whole grid
        const days = flat(matrix);
        const start = days[0]?.iso ?? "";
        expect(days.map((d) => d.iso)).toEqual(days.map((_, i) => addDays(start, i)));

        expect(inMonthCount(matrix)).toBe(DAYS_IN_2026[m - 1]);
        expect(days.some((d) => d.iso === `${key}-01`)).toBe(true);
      }
    },
  );

  test.each(INVALID_KEYS)("rejects invalid month key %j", (key) => {
    expect(() => monthMatrix(key)).toThrow(MonthKeyParseError);
  });
});

describe("daysInMonthOf", () => {
  test.each([
    ["2026-01", 31],
    ["2026-04", 30],
    ["2026-02", 28],
    ["2028-02", 29],
    ["2026-12", 31],
  ])("%s has %i days", (key, expected) => {
    expect(daysInMonthOf(key)).toBe(expected);
  });

  test("agrees with the matrix it sits beside", () => {
    // The two derive the same fact by different routes; if they ever disagree,
    // the strip and the grid are drawing different months.
    for (const key of ["2026-02", "2028-02", "2026-08", "2026-11"]) {
      const inMonth = monthMatrix(key, 1).flat().filter((d) => d.inMonth).length;
      expect(daysInMonthOf(key)).toBe(inMonth);
    }
  });
});
