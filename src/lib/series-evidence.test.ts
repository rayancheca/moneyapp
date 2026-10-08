import { describe, expect, test } from "vitest";
import {
  SERIES_EVIDENCE_LABEL,
  SERIES_EVIDENCE_NOTE,
  SUGGESTION_NOTE,
  seriesEvidenceTone,
  suggestionNote,
  seriesRowLabel,
  type SeriesEvidence,
  noScheduleReason,
  seriesIsOver,
  seriesIsProjected,
  seriesDrawsAsRecurring,
  RECURRING_HISTORY_STATUSES,
} from "./series-evidence";

const EVERY: readonly SeriesEvidence[] = ["active", "never-billed", "awaiting-statements", "running-late", "lapsed"];

describe("the evidence vocabulary", () => {
  test("every state has a label and a note, and none of them is the word 'inactive'", () => {
    for (const e of EVERY) {
      expect(SERIES_EVIDENCE_LABEL[e].length).toBeGreaterThan(0);
      expect(SERIES_EVIDENCE_NOTE[e].length).toBeGreaterThan(0);
      // 🔴 the word the All tab used for three different facts at once
      expect(SERIES_EVIDENCE_LABEL[e].toLowerCase()).not.toContain("inactive");
    }
  });

  /*
   * 🔴 His pay's page wore an amber "Running late" for a payday on a day no import covered, under the sentence
   * "so the ledger has not looked for its deposit" (2026-10-08). Awaiting statements is quiet, and says why.
   *
   * 🔴 …and its first words, "Not looked for yet" over "the charge each is waiting on falls after the last day its
   * account has been checked through", were false once a statement covered the due day but not the end of the
   * grace — the real Breezeline row, due Oct 11, checked through Oct 13 (2026-10-08 copy). The state is decided by
   * when the tolerance runs out, so that is what it says; the label is /budgets' word for a verdict withheld until
   * the days are covered.
   */
  test("awaiting statements is never called late, never unread, and is the one quiet tone", () => {
    expect(SERIES_EVIDENCE_LABEL["awaiting-statements"]).toBe("Awaiting statements");
    expect(SERIES_EVIDENCE_LABEL["awaiting-statements"].toLowerCase()).not.toContain("late");
    expect(SERIES_EVIDENCE_NOTE["awaiting-statements"]).toContain(
      "each one's tolerance runs out after the last day its accounts have been checked through",
    );
    expect(SERIES_EVIDENCE_NOTE["awaiting-statements"]).toContain("none can be called late yet");
    expect(SERIES_EVIDENCE_NOTE["awaiting-statements"]).not.toContain("looked for");
    expect(seriesEvidenceTone("awaiting-statements")).toBe("neutral");
    for (const e of EVERY.filter((x) => x !== "awaiting-statements")) expect(seriesEvidenceTone(e)).toBe("warning");
    expect(seriesRowLabel("confirmed", "awaiting-statements")).toBe("awaiting statements");
    expect(seriesRowLabel("detected", "awaiting-statements")).toBe("suggested · awaiting statements");
  });

  test("a state that is still forecast says so, and the one that is not says that", () => {
    expect(SERIES_EVIDENCE_NOTE["awaiting-statements"]).toContain("still forecast");
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

  /*
   * 🔴 …EXCEPT ONE THE FORECAST HAS LET GO. On a copy of the owner's ledger 2026-10-08 the note read "already in the
   * forecast above" over two cards, Rocket Money (running late, forecast) and Amazon Prime — "· lapsed" on its own
   * card, in no figure above it: Committed was $3,569.98 over 8 lines without it. The note is true of every
   * suggestion the page projects (`seriesIsProjected`) and must say which ones those are when they are not all.
   */
  test("a note over a lapsed suggestion does not claim every suggestion is forecast — it names the exception", () => {
    for (const e of EVERY) {
      const note = suggestionNote([e]);
      if (seriesIsProjected("detected", e)) {
        expect(note, e).toBe(SUGGESTION_NOTE);
      } else {
        expect(note, e).not.toBe(SUGGESTION_NOTE);
        expect(note, e).toContain("not yet confirmed");
        // the exception, in the word the suggestion card marks it with
        expect(note, e).toContain(`unless marked ${SERIES_EVIDENCE_LABEL[e].toLowerCase()}`);
      }
    }
    expect(suggestionNote(["running-late", "lapsed"])).toBe(suggestionNote(["lapsed"]));
    expect(suggestionNote(["active", "running-late", "never-billed"])).toBe(SUGGESTION_NOTE);
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
    expect(noScheduleReason("ended", "lapsed")).toContain("has ended");
    expect(noScheduleReason("ended", "lapsed")).toContain("stay in the ledger");
  });

  /* ⛔ Dismissed is HIS decision, not the app's — the sentence says so. */
  test("a dismissed series is described as the owner's decision", () => {
    expect(noScheduleReason("dismissed", "active")).toContain("You said");
  });

  test("a live series that is still forecast has no reason to give — it still has a schedule", () => {
    for (const e of ["active", "never-billed", "awaiting-statements", "running-late"] as const) {
      expect(noScheduleReason("confirmed", e)).toBeNull();
      expect(noScheduleReason("detected", e)).toBeNull();
    }
  });

  /*
   * 🔴 A LAPSED series lost its "Next expected" card (the forecast let it go, so its page stopped projecting it) and
   * nothing took the card's place: `/recurring/<Amazon Prime>` would read "Lapsed" over no schedule and no word why.
   * The sentence is the evidence's — the app's reading, not his decision — and says what brings it back.
   */
  test("a live series the forecast has let go says why nothing is expected, and that a charge brings it back", () => {
    for (const status of ["confirmed", "detected"] as const) {
      const reason = noScheduleReason(status, "lapsed");
      expect(reason).toContain("no longer forecast");
      expect(reason).toContain("a new charge brings it back");
      expect(reason).toContain("stay in the ledger");
      expect(reason).not.toContain("You said");
    }
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

  test("seriesIsProjected: a live status whose evidence the forecast has not let go — and nothing else", () => {
    for (const e of EVERY) {
      expect(seriesIsProjected("ended", e)).toBe(false);
      expect(seriesIsProjected("dismissed", e)).toBe(false);
      expect(seriesIsProjected("confirmed", e)).toBe(e !== "lapsed");
      expect(seriesIsProjected("detected", e)).toBe(e !== "lapsed");
    }
  });

  /*
   * 🔴 THE SAME DEFECT, A SECOND TIME. The lapse was carried into `noScheduleReason` privately (`e === "lapsed"`) and
   * this linkage was loosened to accept it, while `CadenceSentence` kept asking `seriesIsOver` alone — so on a copy
   * of the owner's ledger 2026-10-08 `/recurring/<Amazon Prime>` read "charges monthly around the 5th, about $4.99"
   * above "Nothing expected · …nothing more is expected from it". Both sentences ask `seriesIsProjected` now; the
   * sentence's half of the linkage is asserted on its render (CadenceSentence.test).
   */
  test("noScheduleReason speaks for exactly the series the page does not project", () => {
    // the linkage, not two lists that happen to agree today
    for (const s of ["detected", "confirmed", "dismissed", "ended"] as const) {
      for (const e of EVERY) {
        expect(noScheduleReason(s, e) !== null, `${s} · ${e}`).toBe(!seriesIsProjected(s, e));
      }
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
