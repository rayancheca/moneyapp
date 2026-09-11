import { describe, expect, test } from "vitest";
import { dayChangeLabel, dayChangeTerm, asOfSpanTerm } from "./day-change-label";
import { formatDayShort } from "./format-date";

describe("dayChangeLabel", () => {
  const call = (asOf: string | null, vsDay: string | null, today: string) =>
    dayChangeLabel(asOf, vsDay, today, formatDayShort);

  test("spends the word 'Today' only when the newest covered day IS today", () => {
    // the e2e fixture's state: seeded priced through its own fake today
    expect(call("2026-07-08", "2026-07-07", "2026-07-08")).toEqual({ label: "Today", interval: null });
  });

  /*
   * The real ledger's state, and the whole reason this exists: prices last
   * refreshed 2026-08-06, read on 2026-08-13. No Playwright run can reach this
   * branch — the fixture is never stale — so this test is the only thing that
   * executes it.
   */
  test("names the two days it actually measured when the closes are stale", () => {
    expect(call("2026-08-06", "2026-08-05", "2026-08-13")).toEqual({
      label: "Last close",
      interval: "Aug 6 vs Aug 5",
    });
  });

  test("does not assume the prior day is the calendar day before", () => {
    // a gap in coverage makes the interval wider than one day; the label must
    // report the days it used, never subtract one from the other
    expect(call("2026-08-06", "2026-07-31", "2026-08-13").interval).toBe("Aug 6 vs Jul 31");
  });

  test("falls back to a neutral label rather than naming a date it cannot support", () => {
    // one covered day: portfolioOverview leaves BOTH vsDay and the figure null
    expect(call("2026-08-06", null, "2026-08-13")).toEqual({ label: "Day change", interval: null });
    // no covered days at all
    expect(call(null, null, "2026-08-13")).toEqual({ label: "Day change", interval: null });
    // vsDay without asOf cannot happen upstream, but must not produce "Last close"
    expect(call(null, "2026-08-05", "2026-08-13")).toEqual({ label: "Day change", interval: null });
  });

  test("never says 'Today' about a day that is not today", () => {
    for (const asOf of ["2026-08-05", "2026-08-12", "2026-08-14"]) {
      expect(call(asOf, "2026-08-01", "2026-08-13").label).not.toBe("Today");
    }
  });
});

describe("dayChangeTerm — the inline form the dashboard teaser renders", () => {
  const term = (asOf: string | null, vsDay: string | null, today: string) =>
    dayChangeTerm(asOf, vsDay, today, formatDayShort);

  test("keeps the word 'today' when the newest close really is today's", () => {
    // the e2e fixture's state, and the string the teaser rendered before this
    // existed — so the fixture, and its 8 dashboard baselines, are unchanged
    expect(term("2026-07-08", "2026-07-07", "2026-07-08")).toBe("today");
  });

  test("names the two measured days instead, once the closes are stale", () => {
    // the real ledger's state. No Playwright run reaches it: the fixture is
    // never stale, so the teaser would have gone on saying "today" about a
    // week-old figure with every rendered test green.
    expect(term("2026-08-06", "2026-08-05", "2026-08-13")).toBe("Aug 6 vs Aug 5");
  });

  test("degrades to a neutral phrase, never a bare heading, with nothing to compare", () => {
    // lower-cased on purpose — "Day change" is a <dt>, and reads as a label
    // rather than a trailing phrase after a figure
    expect(term("2026-08-06", null, "2026-08-13")).toBe("day change");
    expect(term(null, null, "2026-08-13")).toBe("day change");
  });
});

/**
 * ⛔ No rendered test reaches the span branch. The e2e fixture covers every
 * account through one day (its §10 "unreachable in the fixture" list says so),
 * so an institution group there always shares an `asOf` and only the middle
 * branch below ever paints.
 */
describe("asOfSpanTerm", () => {
  test("names ONE date only when the parts really share one", () => {
    expect(asOfSpanTerm("2026-08-17", null)).toBe("as of Aug 17, 2026");
  });

  /**
   * 🔴 The Chase card's total is Aug 14's $3,007.60 plus Sep 3's $82.72, and
   * three weeks of evidence must not be dated to one day.
   */
  test("names the span when they do not", () => {
    expect(asOfSpanTerm("2026-09-03", "2026-08-14")).toBe(
      "each as of its own last covered day, Aug 14 – Sep 3, 2026",
    );
  });

  /*
   * 🔴 The raw key, in a sentence, beside a formatted one. `/accounts/<id>`
   * printed "since Aug 12 +$211.71 as of 2026-09-11 · derived" in a single
   * paragraph, and `AccountsTable` says the identical fact one lens away
   * through `formatDayLong`. `dayWindowLabel` is the rule both read now, and it
   * drops only what genuinely repeats — the year, across a span inside one.
   */
  test("never a raw month key, and a cross-year span keeps both years", () => {
    expect(asOfSpanTerm("2026-08-17", null)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(asOfSpanTerm("2026-09-03", "2026-08-14")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(asOfSpanTerm("2026-02-03", "2025-11-15")).toBe(
      "each as of its own last covered day, Nov 15, 2025 – Feb 3, 2026",
    );
  });

  /** nothing in the group has a balance — the caller must add no separator */
  test("says nothing at all when no part carries a date", () => {
    expect(asOfSpanTerm(null, null)).toBe("");
    expect(asOfSpanTerm(null, "2026-08-14")).toBe("");
  });
});
