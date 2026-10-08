import { describe, expect, test } from "vitest";
import { formatCents } from "@/lib/money";
import { seriesEndLines, type SeriesEndInput } from "./end-radius";

const base: SeriesEndInput = {
  annualizedCents: -2_530_800,
  overdueCents: 0,
  overdueUnreadCents: 0,
  overdueOn: null,
  overdueCount: 0,
  nextChargeOn: "2026-10-01",
  endsOn: null,
  linkedCount: 4,
};

/** Arrears of `cents` on days no import has reached. */
const unread = (cents: number): SeriesEndInput => ({ ...base, overdueCents: cents, overdueUnreadCents: cents });
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
    // rent's Sep 1, on a day no import had reached
    const late = { ...unread(210_900), overdueOn: "2026-09-01", overdueCount: 1 };
    expect(labels(late)).toEqual([
      "Leaving the forecast",
      "Already due this month, no import has covered it yet",
      "Upcoming charges off the calendar",
      "Linked transactions kept",
    ]);
    expect(value(late, "Already due this month, no import has covered it yet")).toBe("$2,109.00");
  });

  test("more than one late occurrence says how many", () => {
    const late = { ...unread(421_800), overdueOn: "2026-09-01", overdueCount: 2 };
    expect(value(late, "Already due this month, no import has covered it yet")).toBe("$4,218.00 across 2 charges");
  });

  /*
   * 🔴 "Already due this month, not imported" whatever the ledger had read. Where an import HAD covered the day, the
   * page's own card said "Already due, and not posted" in warning colour while this dialog, on the same page, said
   * "not imported" — false of a day that was imported (review of 2e6c74b, 2026-10-08). ⛔ The card's split, the
   * runway's (`arrearsClause`): "not posted" only of read days, "no import has covered it yet" of the rest.
   */
  test("a due day the ledger has read says not posted — the card's words, not 'not imported'", () => {
    const late = { ...base, overdueCents: 210_900, overdueUnreadCents: 0, overdueOn: "2026-07-01", overdueCount: 1 };
    expect(labels(late)).toContain("Already due this month, not posted");
    expect(labels(late).join(" ")).not.toMatch(/not imported|no import/);
    expect(value(late, "Already due this month, not posted")).toBe("$2,109.00");
  });

  test("a mix names both halves by amount, as the card does", () => {
    const late = { ...base, overdueCents: 3_000, overdueUnreadCents: 1_000, overdueOn: "2026-07-01", overdueCount: 3 };
    const label = "Already due this month, $20.00 not posted, and no import has covered the other $10.00 yet";
    expect(labels(late)).toContain(label);
    expect(value(late, label)).toBe("$30.00 across 3 charges");
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
