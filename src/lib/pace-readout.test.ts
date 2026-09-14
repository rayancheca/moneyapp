import { describe, expect, test } from "vitest";
import { notImportedYet, paceReadout, paceWindowName } from "./pace-readout";
import { resolvePeriod } from "./period";

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
      paceReadout({ projectedCents: 306_654, actualToDateCents: 143_105, uncoveredDays: 2, windowName: "September 2026" }),
    ).toEqual({
      projected: "at least $3,066.54",
      soFar: "at least $1,431.05 so far",
      notImported: "2 days of September 2026 not imported yet",
    });
  });

  test("a window imported through today keeps its estimate mark and says nothing more", () => {
    expect(
      paceReadout({ projectedCents: 306_654, actualToDateCents: 143_105, uncoveredDays: 0, windowName: "September 2026" }),
    ).toEqual({ projected: "~$3,066.54", soFar: "$1,431.05 so far", notImported: null });
  });

  test("one day is a day", () => {
    expect(notImportedYet(1, "September 2026")).toBe("1 day of September 2026 not imported yet");
    expect(notImportedYet(2, "2026")).toBe("2 days of 2026 not imported yet");
  });
});

/**
 * 🔴 /spending's readout took the period's pill label. On 2026-09-14 (newest
 * row Sep 12, so 2 elapsed days unimported on every current period) it printed
 * "2 days of All time not imported yet" and "2 days of 2026 to date not
 * imported yet". The ledger opens 2022-08-25.
 */
describe("paceWindowName", () => {
  const TODAY = "2026-09-14";
  const OPENS = "2022-08-25";
  const phrase = (key: string) => notImportedYet(2, paceWindowName(resolvePeriod({ period: key }, TODAY, OPENS)));

  test("All time counts its days alone, and year-to-date's days are days of its year", () => {
    expect(phrase("ALL")).toBe("2 days not imported yet");
    expect(phrase("YTD")).toBe("2 days of 2026 not imported yet");
    // the whole readout, with All time's measured figures
    expect(
      paceReadout({
        projectedCents: 17_971_794,
        actualToDateCents: 17_971_794,
        uncoveredDays: 2,
        windowName: paceWindowName(resolvePeriod({ period: "ALL" }, TODAY, OPENS)),
      }).notImported,
    ).toBe("2 days not imported yet");
  });

  test("a calendar window keeps its own name, so the tile's month wording is unchanged", () => {
    expect(phrase("2026-09")).toBe("2 days of September 2026 not imported yet");
    expect(phrase("2026-Q3")).toBe("2 days of Q3 2026 not imported yet");
    expect(phrase("2026")).toBe("2 days of 2026 not imported yet");
    expect(phrase("W2026-09-14")).toBe("2 days of Sep 14 – 20, 2026 not imported yet");
  });
});
