import { describe, expect, test } from "vitest";
import { formatDayLong } from "@/lib/format-date";
import { sinceCloseClause } from "./SessionNote";

const TODAY = "2026-09-10";

/**
 * 🔴 `/investments?range=1D` asserted "this is the change since yesterday's
 * close" whatever the newest close was. Measured 2026-09-10: `price_cache`'s
 * newest quote is 2026-09-03 and `price_intraday` holds zero rows, so there is
 * no yesterday close and none for the six days before it — while the same page
 * says "carried forward from the close on Thu, Sep 3, 2026" and "still carries
 * its close from Thu, Sep 3, 2026 — 7 days ago". `dayChangeLabel` states the
 * rule two files over: "naming a date the figure was not measured over would be
 * worse than the vaguer word."
 */
describe("sinceCloseClause", () => {
  test("names the close the figure is really measured against", () => {
    expect(sinceCloseClause("2026-09-03", TODAY, formatDayLong)).toBe(
      "this is the change since the close on Thu, Sep 3, 2026",
    );
  });

  test("yesterday is named as a date too, never as 'yesterday'", () => {
    // the old sentence was right on exactly this one day and wrong on every
    // other; naming the date is right on all of them
    expect(sinceCloseClause("2026-09-09", TODAY, formatDayLong)).toBe(
      "this is the change since the close on Wed, Sep 9, 2026",
    );
  });

  test("no stored close at all says so rather than naming a day", () => {
    expect(sinceCloseClause(null, TODAY, formatDayLong)).toBe(
      "there is no stored close to measure against yet",
    );
  });

  test("a close dated today is not a change since a previous one", () => {
    expect(sinceCloseClause(TODAY, TODAY, formatDayLong)).toBe(
      "this is the change within today's own close",
    );
  });
});
