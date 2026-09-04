import { describe, expect, test } from "vitest";
import {
  SERIES_EVIDENCE_LABEL,
  SERIES_EVIDENCE_NOTE,
  SUGGESTION_NOTE,
  seriesRowLabel,
  type SeriesEvidence,
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
