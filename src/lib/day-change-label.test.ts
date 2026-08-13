import { describe, expect, test } from "vitest";
import { dayChangeLabel } from "./day-change-label";
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
    // one covered day: portfolioOverview leaves vsDay null and the figure 0
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
