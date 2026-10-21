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
      paceReadout({ projectedCents: 306_654, actualToDateCents: 143_105, partlyRead: { uncoveredDays: 2, line: LINE } }),
    ).toEqual({
      projected: "at least $3,066.54",
      soFar: "at least $1,431.05 so far",
      partlyRead: LINE,
    });
  });

  test("a window read in full keeps its estimate mark and says nothing more", () => {
    expect(paceReadout({ projectedCents: 306_654, actualToDateCents: 143_105, partlyRead: null })).toEqual({
      projected: "~$3,066.54",
      soFar: "$1,431.05 so far",
      partlyRead: null,
    });
  });
});
