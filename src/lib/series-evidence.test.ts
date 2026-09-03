import { describe, expect, test } from "vitest";
import { SERIES_EVIDENCE_LABEL, SERIES_EVIDENCE_NOTE, type SeriesEvidence } from "./series-evidence";

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
});
