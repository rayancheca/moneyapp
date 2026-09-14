import { describe, expect, test } from "vitest";
import {
  SERIES_EVIDENCE_LABEL,
  SERIES_EVIDENCE_NOTE,
  SUGGESTION_NOTE,
  seriesRowLabel,
  type SeriesEvidence,
  noScheduleReason,
  seriesIsOver,
  seriesDrawsAsRecurring,
  RECURRING_HISTORY_STATUSES,
} from "./series-evidence";

const EVERY: readonly SeriesEvidence[] = ["active", "never-billed", "running-late", "lapsed"];

describe("the evidence vocabulary", () => {
  test("every state has a label and a note, and none of them is the word 'inactive'", () => {
    for (const e of EVERY) {
      expect(SERIES_EVIDENCE_LABEL[e].length).toBeGreaterThan(0);
      expect(SERIES_EVIDENCE_NOTE[e].length).toBeGreaterThan(0);
      // 🔴 the word the All tab used for three different facts at once
      expect(SERIES_EVIDENCE_LABEL[e].toLowerCase()).not.toContain("inactive");
    }
  });

  test("a state that is still forecast says so, and the one that is not says that", () => {
    expect(SERIES_EVIDENCE_NOTE["running-late"]).toContain("still forecast");
    expect(SERIES_EVIDENCE_NOTE["never-billed"]).toContain("forecast");
    expect(SERIES_EVIDENCE_NOTE.lapsed).toContain("no longer forecast");
  });

  /*
   * ⛔ EVERY BUCKET ON THE TAB SAYS WHETHER IT IS FORECAST, suggestions
   * included. A detected series projects like a confirmed one, and the section
   * offering to Confirm it is the one a reader would assume is not counted yet.
   */
  test("the suggestions note says they are already forecast", () => {
    expect(SUGGESTION_NOTE).toContain("forecast");
    expect(SUGGESTION_NOTE).toContain("not yet confirmed");
  });
});

describe("seriesRowLabel — evidence for a live series, status for one that is not", () => {
  /*
   * 🔴 THE MEASURED CASE. /categories/<Food> listed five DISMISSED series under
   * "Recurring series", every one labelled "lapsed" — the owner's own
   * rejections printed back to him as bills that had gone quiet. "Lapsed" is an
   * evidence state and evidence is only meaningful for a live series.
   */
  test("a dismissed series is never described by its evidence", () => {
    for (const e of EVERY) {
      expect(seriesRowLabel("dismissed", e)).toBe("not recurring");
    }
  });

  test("an ended series says it ended, whatever its evidence", () => {
    for (const e of EVERY) {
      expect(seriesRowLabel("ended", e)).toBe("ended");
    }
  });

  test("a confirmed series is described by its evidence, and an active one needs no word", () => {
    expect(seriesRowLabel("confirmed", "active")).toBeNull();
    expect(seriesRowLabel("confirmed", "running-late")).toBe("running late");
    expect(seriesRowLabel("confirmed", "never-billed")).toBe("never billed");
    expect(seriesRowLabel("confirmed", "lapsed")).toBe("lapsed");
  });

  /* A detection is not yet a decision, and the row says so — it is the same
     fact the All tab's Suggestions section carries. */
  test("a detected series says it is only suggested, and still carries its evidence", () => {
    expect(seriesRowLabel("detected", "active")).toBe("suggested");
    expect(seriesRowLabel("detected", "running-late")).toBe("suggested · running late");
  });

  test("no label is ever the word the All tab retired", () => {
    for (const status of ["detected", "confirmed", "dismissed", "ended"] as const) {
      for (const e of EVERY) {
        expect(seriesRowLabel(status, e)?.toLowerCase() ?? "").not.toContain("inactive");
      }
    }
  });
});

describe("noScheduleReason", () => {
  test("an ended series says its future is over and its past is not", () => {
    expect(noScheduleReason("ended")).toContain("has ended");
    expect(noScheduleReason("ended")).toContain("stay in the ledger");
  });

  /* ⛔ Dismissed is HIS decision, not the app's — the sentence says so. */
  test("a dismissed series is described as the owner's decision", () => {
    expect(noScheduleReason("dismissed")).toContain("You said");
  });

  test("a live series has no reason to give — it still has a schedule", () => {
    expect(noScheduleReason("confirmed")).toBeNull();
    expect(noScheduleReason("detected")).toBeNull();
  });
});

describe("seriesIsOver — the one predicate two sentences on the page turn on", () => {
  /*
   * 🔴 `noScheduleReason` owned this test privately and the cadence sentence at
   * the top of the same page did not ask it. Measured 2026-09-10: all 27 ended
   * or dismissed series opened with "charges monthly around the 8th, about
   * $1,786.46 from Chase Checking" three cards above "nothing more is expected
   * from it."
   */
  test("ended and dismissed are over; detected and confirmed are not", () => {
    expect(seriesIsOver("ended")).toBe(true);
    expect(seriesIsOver("dismissed")).toBe(true);
    expect(seriesIsOver("confirmed")).toBe(false);
    expect(seriesIsOver("detected")).toBe(false);
  });

  test("noScheduleReason speaks for exactly the statuses this names", () => {
    // the linkage, not two lists that happen to agree today
    for (const s of ["detected", "confirmed", "dismissed", "ended"] as const) {
      expect(noScheduleReason(s) !== null).toBe(seriesIsOver(s));
    }
  });
});

describe("seriesDrawsAsRecurring — dismissed is never drawn as recurring", () => {
  /*
   * 🔴 The calendar, /categories and the evidence vocabulary each restated this
   * rule, and the ledger's "R" badge did not ask any of them: 60 rows linked to
   * dismissed series wore "Recurring" on 2026-09-14.
   */
  test("dismissed is the only status not drawn as recurring", () => {
    expect(seriesDrawsAsRecurring("dismissed")).toBe(false);
    expect(seriesDrawsAsRecurring("ended")).toBe(true);
    expect(seriesDrawsAsRecurring("confirmed")).toBe(true);
    expect(seriesDrawsAsRecurring("detected")).toBe(true);
  });

  test("the history statuses are exactly the ones it draws", () => {
    expect([...RECURRING_HISTORY_STATUSES].sort()).toEqual(["confirmed", "detected", "ended"]);
    for (const s of ["detected", "confirmed", "dismissed", "ended"] as const) {
      expect((RECURRING_HISTORY_STATUSES as readonly string[]).includes(s)).toBe(seriesDrawsAsRecurring(s));
    }
  });
});
