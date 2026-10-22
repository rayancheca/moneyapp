import { describe, expect, test } from "vitest";
import { paceReadout } from "./pace-readout";

/**
 * 🔴 S12. On 2026-09-14 /spending's cash-flow readout printed "On pace for
 * ~$3,066.54 spent this period · $1,431.05 so far" for September 2026, while the
 * dashboard tile that links to it printed "at least $1,431.05 spent · at least
 * $3,066.54 projected" and "2 days of September 2026 not imported yet" over the
 * same days. Two surfaces grading one window must not grade it two ways.
 *
 * ⚖️ His decision 72 (2026-10-13): the reason is the period proof's line. 🔴 The readout counted only the days NO
 * account had read: on his ledger copy 2026-10-21 "7 days of October 2026 not imported yet" above "Where it went"'s
 * "spending imported through Aug 12 · 21 days of this period unaccounted". "Of this period" needs no window's name, so
 * the phrase that had to learn what All time is "of" ("2 days of All time not imported yet", 2026-09-14) is gone.
 */
describe("paceReadout", () => {
  const LINE = "spending imported through Sep 12 · 2 days of this period unaccounted";

  test("a window read only in part reads as the lower bound it is, and says why in /budgets' words", () => {
    expect(
      paceReadout({
        projectedCents: 306_654,
        actualToDateCents: 143_105,
        partlyRead: { uncoveredDays: 2, line: LINE },
        spendingUnaccounted: null,
      }),
    ).toEqual({
      projected: "at least $3,066.54",
      soFar: "at least $1,431.05 so far",
      partlyRead: LINE,
    });
  });

  test("a window read in full keeps its estimate mark and says nothing more", () => {
    expect(
      paceReadout({ projectedCents: 306_654, actualToDateCents: 143_105, partlyRead: null, spendingUnaccounted: null }),
    ).toEqual({
      projected: "~$3,066.54",
      soFar: "$1,431.05 so far",
      partlyRead: null,
    });
  });

  test("a window with no pace projects nothing", () => {
    const words = paceReadout({ projectedCents: null, actualToDateCents: 0, partlyRead: null, spendingUnaccounted: null });
    expect(words.projected).toBeNull();
  });

  /*
   * ⚖️ Decision 64 (2026-10-12): no spending found and not one elapsed day read by spending's day is no "$0.00". 🔴 Review
   * of 1042f71 (today 2026-07-08, checking read through Jun 20, payroll found on Jul 3): the dashboard tile dashed "Free
   * to spend — nothing found so far — spending imported through Jun 20" while this readout, the tile's twin, printed "On
   * pace for at least $0.00 … at least $0.00 so far · spending imported through Jun 20 · 8 days of this period
   * unaccounted". The dash's words stand in for both figures; the fact names the day, so no count repeats it.
   */
  test("a window with no spending found past spending's day prints the tile's words in place of both figures", () => {
    expect(
      paceReadout({
        projectedCents: 0,
        actualToDateCents: 0,
        partlyRead: { uncoveredDays: 8, line: "spending imported through Jun 20 · 8 days of this period unaccounted" },
        spendingUnaccounted: "spending imported through Jun 20",
      }),
    ).toEqual({
      projected: null,
      soFar: "nothing found so far — spending imported through Jun 20",
      partlyRead: null,
    });
  });
});
