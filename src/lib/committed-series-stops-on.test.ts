import { describe, expect, test } from "vitest";
import { endsInsideHorizon, seriesStopsOn } from "./committed";

/**
 * ⚖️ (B) The day a series STOPS (`seriesStopsOn`) — ONE day for its page's badge, its Annualized qualifier, the All
 * tab, its End dialog and the committed books (`termsBySeries`): the end he typed, or, billed inside another, the later
 * day its last charge inside it falls due on. 🔴 The books read the end he typed (review of 78d64f6a): the runway's
 * "evidenced through Feb 10, 2027" beside a page reading "Ends Feb 16, 2027" (his ledger copy 2026-11-05, the rent
 * retyped Nov 16, the utilities' end typed Feb 10). The pages and the books read it pinned in
 * SeriesDetail-carried-end.test.ts.
 */
describe("seriesStopsOn — the day every reader names a series stopping on", () => {
  test("billed inside another, the later day its last charge falls due on; else the end he typed", () => {
    expect(seriesStopsOn({ endsOn: "2027-02-10", lastFallsDueOn: "2027-02-16" })).toBe("2027-02-16");
    expect(seriesStopsOn({ endsOn: "2027-01-11", lastFallsDueOn: null })).toBe("2027-01-11");
    expect(seriesStopsOn({ endsOn: null, lastFallsDueOn: null })).toBeNull();
  });

  // ⛔ …and the gate both surfaces ask (`endsInsideHorizon`) is asked of that day: a last charge due past the window
  // stops no rate inside it, though the end he typed lies inside it
  test("the window's gate is asked of the day it stops", () => {
    const to = "2027-11-12";
    const days = { endsOn: "2027-11-10", lastFallsDueOn: "2027-11-16" };
    expect(endsInsideHorizon(days.endsOn, to)).toBe(true);
    expect(endsInsideHorizon(seriesStopsOn(days), to)).toBe(false);
  });
});
