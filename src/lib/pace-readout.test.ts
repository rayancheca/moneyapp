import { describe, expect, test } from "vitest";
import { notImportedYet, paceReadout } from "./pace-readout";

/**
 * 🔴 S12. On 2026-09-14 /spending's cash-flow readout printed "On pace for
 * ~$3,066.54 spent this period · $1,431.05 so far" for September 2026, while the
 * dashboard tile that links to it printed "at least $1,431.05 spent · at least
 * $3,066.54 projected" and "2 days of September 2026 not imported yet" over the
 * same days. Two surfaces grading one window must not grade it two ways.
 */
describe("paceReadout", () => {
  test("a window with unimported days reads as the lower bound it is", () => {
    expect(
      paceReadout({ projectedCents: 306_654, actualToDateCents: 143_105, uncoveredDays: 2, periodLabel: "September 2026" }),
    ).toEqual({
      projected: "at least $3,066.54",
      soFar: "at least $1,431.05 so far",
      notImported: "2 days of September 2026 not imported yet",
    });
  });

  test("a window imported through today keeps its estimate mark and says nothing more", () => {
    expect(
      paceReadout({ projectedCents: 306_654, actualToDateCents: 143_105, uncoveredDays: 0, periodLabel: "September 2026" }),
    ).toEqual({ projected: "~$3,066.54", soFar: "$1,431.05 so far", notImported: null });
  });

  test("one day is a day", () => {
    expect(notImportedYet(1, "September 2026")).toBe("1 day of September 2026 not imported yet");
    expect(notImportedYet(2, "2026")).toBe("2 days of 2026 not imported yet");
  });
});
