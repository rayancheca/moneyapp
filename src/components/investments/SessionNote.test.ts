import { describe, expect, test } from "vitest";
import { formatDayLong } from "@/lib/format-date";
import { newestQuotedOn } from "@/lib/holding-price-age";
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

/**
 * 🔴 …and /investments handed it the wrong day. The page passed
 * `PortfolioOverview.asOf`, the series' newest day, which
 * `rebuildInvestmentHistory` carries to today whatever the newest close.
 * Measured on the real ledger, Tue 2026-09-15: every held close is Mon Sep 14,
 * no intraday prices were stored, and the 1D note read "this is the change
 * within today's own close" — of a figure measured between two days valued at
 * Monday's closes.
 *
 * The close is the newest one the holdings were quoted on — the population the
 * page's price-age note reads (`newestQuotedOn`).
 */
describe("the close the 1D note names is the newest stored one, not the carried day", () => {
  const MON = "2026-09-14";
  const TUE = "2026-09-15";

  test("read the day after Monday's closes, the note names Monday", () => {
    const rows = [{ quotedOn: MON }, { quotedOn: MON }];
    expect(sinceCloseClause(newestQuotedOn(rows), TUE, formatDayLong)).toBe(
      "this is the change since the close on Mon, Sep 14, 2026",
    );
  });

  test("once any holding is quoted today, the move within that close is today's", () => {
    // a coin quoted Tuesday beside stocks still on Monday: the carried day moved by the coin alone
    const rows = [{ quotedOn: MON }, { quotedOn: TUE }, { quotedOn: null }];
    expect(sinceCloseClause(newestQuotedOn(rows), TUE, formatDayLong)).toBe(
      "this is the change within today's own close",
    );
  });
});
