import { describe, expect, test } from "vitest";
import { formatCents } from "@/lib/money";
import { seriesEndLines, type SeriesEndInput } from "./end-radius";

const base: SeriesEndInput = {
  annualizedCents: -2_530_800,
  overdueCents: 0,
  overdueOn: null,
  overdueCount: 0,
  nextChargeOn: "2026-10-01",
  endsOn: null,
  linkedCount: 4,
};

const labels = (i: SeriesEndInput) => seriesEndLines(i, formatCents).map((l) => l.label);
const value = (i: SeriesEndInput, label: string) =>
  seriesEndLines(i, formatCents).find((l) => l.label === label)?.value;

/**
 * 🔴 `/recurring/<Flamingo South Beach (rent)>`, 2026-09-10: the dialog read
 * "Upcoming charges off the calendar: 3 charges" — Oct 1, Nov 1, Dec 1 — over a
 * Sep 1 charge of $2,109.00 the same page shows as "Already due, and not
 * posted … The forecast counts it, and so does this month's budget", and which
 * ending the series removes too.
 */
describe("seriesEndLines", () => {
  test("nothing overdue names no arrears line at all", () => {
    expect(labels(base)).toEqual([
      "Leaving the forecast",
      "Upcoming charges off the calendar",
      "Linked transactions kept",
    ]);
  });

  test("the arrears come BEFORE the future, as they do on /budgets", () => {
    const late = { ...base, overdueCents: 210_900, overdueOn: "2026-09-01", overdueCount: 1 };
    expect(labels(late)).toEqual([
      "Leaving the forecast",
      "Already due this month, not imported",
      "Upcoming charges off the calendar",
      "Linked transactions kept",
    ]);
    expect(value(late, "Already due this month, not imported")).toBe("$2,109.00");
  });

  test("more than one late occurrence says how many", () => {
    const late = { ...base, overdueCents: 421_800, overdueOn: "2026-09-01", overdueCount: 2 };
    expect(value(late, "Already due this month, not imported")).toBe("$4,218.00 across 2 charges");
  });

  test("an open-ended series loses EVERY charge, not three", () => {
    // 🔴 NEXT_EXPECTED_COUNT = 3 caps the preview; "3 charges" was that cap
    expect(value(base, "Upcoming charges off the calendar")).toBe(
      "every charge from Oct 1, 2026 on",
    );
  });

  test("a series with an end date names the span it really loses", () => {
    expect(value({ ...base, endsOn: "2027-06-01" }, "Upcoming charges off the calendar")).toBe(
      "every charge from Oct 1, 2026 to Jun 1, 2027",
    );
  });

  test("nothing projected says so rather than naming a span", () => {
    expect(value({ ...base, nextChargeOn: null }, "Upcoming charges off the calendar")).toBe(
      "none scheduled",
    );
  });

  test("the forecast line is dropped when the series carries no annual figure", () => {
    expect(labels({ ...base, annualizedCents: null })).toEqual([
      "Upcoming charges off the calendar",
      "Linked transactions kept",
    ]);
  });

  test("one linked transaction is singular", () => {
    expect(value({ ...base, linkedCount: 1 }, "Linked transactions kept")).toBe("1 transaction");
    expect(value(base, "Linked transactions kept")).toBe("4 transactions");
  });
});
