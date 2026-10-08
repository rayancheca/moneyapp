import { describe, expect, test } from "vitest";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";
import {
  annualizedCaveat,
  annualizedEndNote,
  shortAgo,
  staleComponentEntries,
  staleFooterHint,
  staleFooterIsWarning,
  staleLabel,
  staleMarkTone,
  staleOccurrenceEntries,
  stalenessSentence,
  stalePartLabel,
  staleSummaryLabel,
  type StaleEntry,
  overdueNote,
  perPaydayWord,
  postedSpreadReading,
  seriesVerb,
  futureDateLabel,
  mergedToastTitle,
  mergeFilingClause,
  unsettledReasonWord,
  upcomingEvidenceWord,
} from "./labels";

describe("unsettledReasonWord", () => {
  /*
   * 🔴 "due date not established" over a date the owner TYPED. Car insurance on
   * the real ledger on 2026-09-14, before another session's write at 19:38:33Z
   * (which typed a next date of 2026-12-11): next expected 2026-09-11,
   * registered by hand, one charge linked by hand. The check behind the word
   * counts linked charges; it never asks where the date came from, so the word
   * claimed more than the check measured — and /budgets, the forecast and the
   * series page all said "came due Sep 11" of the same bill.
   */
  test("a schedule with too few charges says what was counted, not that the date is unknown", () => {
    expect(unsettledReasonWord("schedule_unproven")).toBe("too few charges to grade yet");
    expect(unsettledReasonWord("schedule_unproven")).not.toContain("due date");
  });

  test("the coverage and cash reasons keep their words", () => {
    expect(unsettledReasonWord("not_imported")).toBe("not imported yet");
    expect(unsettledReasonWord("unbanked")).toBe("not banked yet");
  });
});

describe("upcomingEvidenceWord", () => {
  test("a series that has never charged is 'never billed', in the All tab's word", () => {
    expect(upcomingEvidenceWord({ isStale: false, neverBilled: true })).toBe("never billed");
  });

  test("a series running late keeps 'evidence stale'", () => {
    expect(upcomingEvidenceWord({ isStale: true, neverBilled: false })).toBe("evidence stale");
  });

  test("fresh evidence needs no word", () => {
    expect(upcomingEvidenceWord({ isStale: false, neverBilled: false })).toBeNull();
  });
});

const staleness = (over: Partial<SeriesStaleness> = {}): SeriesStaleness => ({
  lastMatchedOn: "2026-06-16",
  daysSinceLastMatch: 22,
  checkedDaysSinceLastMatch: 22,
  stepDays: 7,
  toleranceDays: 12.5,
  isStale: true,
  awaitingStatements: false,
  ...over,
});

describe("shortAgo", () => {
  test("a positive gap reads in days", () => {
    expect(shortAgo(22)).toBe("22d ago");
    expect(shortAgo(1)).toBe("1d ago");
  });

  test("no gap reads as today, never as '0d ago'", () => {
    expect(shortAgo(0)).toBe("today");
  });
});

describe("staleLabel", () => {
  test("a measured gap names how long ago the evidence was", () => {
    expect(staleLabel(staleness())).toBe("last seen 22d ago");
  });

  /**
   * 🔴 "never seen", in a WARNING badge, on the Upcoming list and the forecast's
   * math table — for Car lease, Gym and Rent utilities & fees, measured on the
   * real ledger 2026-09-15 — while the calendar a tab away called the same
   * three "never billed" in a neutral badge. The owner chose the All tab's word
   * (2026-09-14): `SERIES_EVIDENCE_LABEL`, not a third spelling of it.
   */
  test("a series nothing ever matched is never billed, in the word every other surface uses", () => {
    const never = staleness({ lastMatchedOn: null, daysSinceLastMatch: null });
    expect(staleLabel(never)).toBe("never billed");
    expect(staleLabel(never)).toBe(upcomingEvidenceWord({ isStale: true, neverBilled: true }));
    expect(staleLabel(never)).not.toBe("never seen");
  });
});

/* A bill the bank has not charged yet is not late — the Day Sheet's own rule:
   "not a warning: nothing is late about a bill the bank has not charged yet". */
describe("staleMarkTone", () => {
  test("late evidence is a warning", () => {
    expect(staleMarkTone(staleness())).toBe("warning");
  });

  test("no evidence at all is not", () => {
    expect(staleMarkTone(staleness({ lastMatchedOn: null, daysSinceLastMatch: null }))).toBe("neutral");
  });
});

/**
 * 🔴 "In the next 30 days, 4 series are running late and 3 have never charged —
 * all still projected · why these numbers rest on old evidence" — measured on
 * the real ledger 2026-09-15. Three of the seven have no evidence at all to be
 * old.
 */
describe("staleFooterHint", () => {
  const late: StaleEntry = { key: "l", name: "Late", staleness: staleness() };
  const never: StaleEntry = {
    key: "n",
    name: "Never",
    staleness: staleness({ lastMatchedOn: null, daysSinceLastMatch: null }),
  };

  test("only late evidence is old evidence", () => {
    expect(staleFooterHint([late])).toBe("why these numbers rest on old evidence");
  });

  test("only never-billed rests on the schedule, and says nothing is old", () => {
    expect(staleFooterHint([never])).toBe("why these numbers rest on the schedule alone");
    expect(staleFooterHint([never])).not.toContain("old");
  });

  test("a mix names both", () => {
    expect(staleFooterHint([late, never])).toBe("why these numbers rest on old evidence or on the schedule alone");
  });

  test("the footer is a warning only when something is actually late", () => {
    expect(staleFooterIsWarning([late, never])).toBe(true);
    expect(staleFooterIsWarning([never])).toBe(false);
  });
});

describe("stalenessSentence", () => {
  test("names the cadence, the last match, the gap, and the tolerance it passed", () => {
    const sentence = stalenessSentence(staleness());
    expect(sentence).toContain("every 7 days");
    expect(sentence).toContain("Jun 16, 2026");
    expect(sentence).toContain("22 days");
    expect(sentence).toContain("12-day tolerance"); // 12.5 prints as its floor — see wholeToleranceDays
    expect(sentence).toContain("Still projected");
  });

  test("the day that passed a fractional tolerance is never printed AS the tolerance", () => {
    // stale at 13 days against 12.5 — rounding printed "13 days, past the 13-day tolerance"
    const sentence = stalenessSentence(staleness({ daysSinceLastMatch: 13, toleranceDays: 12.5 }));
    expect(sentence).toContain("13 days, past the 12-day tolerance");
  });

  test("a fractional detected interval renders as a whole number of days", () => {
    expect(stalenessSentence(staleness({ stepDays: 30.2, toleranceDays: 48.3 }))).toContain(
      "every 30 days",
    );
  });

  test("with no match at all it says so instead of formatting a null date", () => {
    const sentence = stalenessSentence(staleness({ lastMatchedOn: null, daysSinceLastMatch: null }));
    expect(sentence).toContain("no charge has ever matched it");
    expect(sentence).not.toContain("null");
  });
});

describe("staleOccurrenceEntries", () => {
  const occurrence = (over: Partial<SeriesOccurrence>): SeriesOccurrence => ({
    seriesId: "s1",
    name: "Cash job",
    kind: "income",
    cadence: "weekly",
    date: "2026-07-09",
    amountCents: 104600,
    anchorDayOfMonth: null, // weekly: day-stepped, so it never clamps
    ...over,
  });

  test("a weekly series named once, not once per projected occurrence", () => {
    const entries = staleOccurrenceEntries([
      occurrence({ date: "2026-07-09", staleness: staleness() }),
      occurrence({ date: "2026-07-16", staleness: staleness() }),
      occurrence({ date: "2026-07-23", staleness: staleness() }),
    ]);
    expect(entries).toEqual([{ key: "s1", name: "Cash job", staleness: staleness() }]);
  });

  test("fresh and unmeasured occurrences never reach the footer", () => {
    expect(
      staleOccurrenceEntries([
        occurrence({ seriesId: "fresh", staleness: staleness({ isStale: false }) }),
        occurrence({ seriesId: "unmeasured" }),
      ]),
    ).toEqual([]);
  });

  test("distinct stale series each get a line, in first-occurrence order", () => {
    const entries = staleOccurrenceEntries([
      occurrence({ seriesId: "b", name: "Gym", staleness: staleness() }),
      occurrence({ seriesId: "a", name: "Cash job", staleness: staleness() }),
      occurrence({ seriesId: "b", name: "Gym", staleness: staleness() }),
    ]);
    expect(entries.map((e) => e.name)).toEqual(["Gym", "Cash job"]);
  });
});

describe("staleComponentEntries", () => {
  const component = (over: Partial<ForecastComponent>): ForecastComponent => ({
    label: "Cash job",
    kind: "fixed",
    cents: 418400,
    detail: "4 × $1,046.00 (weekly), next 2026-07-09",
    ...over,
  });

  test("only the stale fixed components are named", () => {
    const entries = staleComponentEntries([
      component({ label: "Cash job", staleness: staleness() }),
      component({ label: "Netflix", staleness: staleness({ isStale: false }) }),
      component({ label: "Groceries", kind: "variable" }),
    ]);
    expect(entries).toEqual([{ key: "Cash job", name: "Cash job", staleness: staleness() }]);
  });

  /*
   * 🔴 The docstring said "keyed by label ... one per series" and nothing keyed
   * anything. It was harmless while `fixedComponents` emitted exactly one
   * component per series — and stopped being harmless the moment the forecast
   * grew an ARREARS leg, because a weekly bill that came due on the 1st and
   * falls due again on the 8th produces two components with one name. The
   * footer would then have counted one series as two running late.
   */
  test("a series with two components is named once, not twice", () => {
    const entries = staleComponentEntries([
      component({ label: "Rent", staleness: staleness(), detail: "came due 2026-07-01" }),
      component({ label: "Rent", staleness: staleness(), detail: "1 × ..., next 2026-07-08" }),
    ]);
    expect(entries).toEqual([{ key: "Rent", name: "Rent", staleness: staleness() }]);
  });

  test("nothing stale means no footer at all", () => {
    expect(staleComponentEntries([component({ staleness: staleness({ isStale: false }) })])).toEqual([]);
  });
});

/*
 * 🔴 "7 SERIES ARE RUNNING LATE" OVER THREE THAT WERE, AND FOUR THAT HAVE NEVER
 * CHARGED — three of which are not due yet.
 *
 * `seriesStaleness.isStale` is true for both "the evidence is past tolerance"
 * and "there is no evidence at all", which is right: both mean the projection
 * rests on something other than a recent charge. The per-row sentence already
 * says which — `stalenessSentence` has a branch for each, and the inline badge
 * reads "never seen". The SUMMARY conflated them.
 *
 * Measured on the real ledger at today = 2026-09-01:
 *
 *   running late (3)  Cash job (weekly pay) 88d · Amazon Prime 58d · FPL 53d
 *   never charged (4) Rent utilities & fees (first due 2026-09-01) ·
 *                     Car insurance (2026-09-11) · Car lease (2026-09-15) ·
 *                     Gym (2026-09-22)
 *
 * Three of those four are not late by any reading — they are due in the FUTURE.
 * The car lease's first payment is a fortnight away and the page called it late.
 */
describe("staleSummaryLabel", () => {
  const late = (days: number): StaleEntry => ({
    key: `late-${days}`,
    name: `Late ${days}`,
    staleness: { lastMatchedOn: "2026-06-05", daysSinceLastMatch: days, checkedDaysSinceLastMatch: days, stepDays: 7, toleranceDays: 14, isStale: true, awaitingStatements: false },
  });
  const never = (n: number): StaleEntry => ({
    key: `never-${n}`,
    name: `Never ${n}`,
    staleness: { lastMatchedOn: null, daysSinceLastMatch: null, checkedDaysSinceLastMatch: null, stepDays: 30, toleranceDays: 48, isStale: true, awaitingStatements: false },
  });

  test("the real ledger's mix names both, and neither count is the other's", () => {
    expect(staleSummaryLabel([late(88), late(58), late(53), never(1), never(2), never(3), never(4)], "In September")).toBe(
      "In September, 3 series are running late and 4 have never been billed — all still projected",
    );
  });

  test("only late reads as it always did", () => {
    expect(staleSummaryLabel([late(88), late(58)], "In September")).toBe(
      "In September, 2 series are running late — still projected");
    expect(staleSummaryLabel([late(88)], "In September")).toBe(
      "In September, 1 series is running late — still projected");
  });

  test("only never-charged does not claim anything is late", () => {
    expect(staleSummaryLabel([never(1), never(2)], "In September")).toBe(
      "In September, 2 series have never been billed — still projected");
    expect(staleSummaryLabel([never(1)], "In September")).toBe(
      "In September, 1 series has never been billed — still projected");
    expect(staleSummaryLabel([never(1)], "In September")).not.toContain("late");
  });

  test("one of each still says one of each", () => {
    expect(staleSummaryLabel([late(88), never(1)], "In September")).toBe(
      "In September, 1 series is running late and 1 has never been billed — all still projected",
    );
  });

  /**
   * 🔴 "In the next 30 days, 4 series are running late and 3 have never charged —
   * all still projected" — measured on the real ledger 2026-09-15, directly over
   * rows badged "never billed", on a forecast card whose composition band also
   * says "never billed". The owner chose "billed" on 2026-09-14; the summary
   * was the one line on the card still saying "charged".
   */
  test("the summary says it in the badges' verb", () => {
    const neverEntry = never(1);
    for (const entries of [[neverEntry], [neverEntry, never(2)], [late(88), neverEntry]]) {
      const summary = staleSummaryLabel(entries, "In the next 30 days");
      expect(summary).not.toContain("charged");
      // "never billed" is the badge; the clause needs a verb, so the same participle
      expect(summary).toContain(`never been ${staleLabel(neverEntry.staleness).replace(/^never /, "")}`);
    }
  });

  /**
   * 🔴 THE DEFECT THIS ARGUMENT EXISTS FOR. `/recurring` renders this sentence
   * twice — once over the September forecast, once under the 30-day list — and
   * on 2026-09-02 they read "…3 have never charged" and "…4 have never charged"
   * a screen apart, in identical words. Both were true: `Rent utilities & fees`
   * first falls due on 1 October, inside thirty days and outside September.
   *
   * ⛔ The window LEADS the sentence. Trailing it — "…3 have never been billed in
   * September" — would say they had never been billed IN SEPTEMBER, a different
   * and weaker claim than the true one.
   */
  test("the same counts over two windows are two different sentences", () => {
    const september = staleSummaryLabel([late(88), never(1)], "In September");
    const thirtyDays = staleSummaryLabel([late(88), never(1), never(2)], "In the next 30 days");
    expect(september).toBe("In September, 1 series is running late and 1 has never been billed — all still projected");
    expect(thirtyDays).toBe(
      "In the next 30 days, 1 series is running late and 2 have never been billed — all still projected",
    );
    // neither can be read as the other, which is the whole point
    expect(september).not.toBe(thirtyDays.replace("In the next 30 days", "In September"));
  });
});


/*
 * The composition band's half of the same conflation. Measured on the real
 * ledger at today = 2026-09-01, September's committed MONEY OUT read
 * "$1,402.60 of it running late" over $1,338.74 that had never been billed.
 */
describe("stalePartLabel separates late money from never-billed money", () => {
  test("all of a side late, and none of it never-billed, reads as it always did", () => {
    expect(
      stalePartLabel({ fixedCents: 418800, fixedStaleCents: 418800, fixedStaleCount: 1, fixedNeverChargedCents: 0, fixedNeverChargedCount: 0 }),
    ).toBe("all of it running late");
  });

  test("part late, part never billed, names both", () => {
    expect(
      stalePartLabel({ fixedCents: -356760, fixedStaleCents: -140260, fixedStaleCount: 6, fixedNeverChargedCents: -133874, fixedNeverChargedCount: 4 }),
    ).toBe("$63.86 of it running late · $1,338.74 never billed");
  });

  test("stale money that has ALL never been billed does not claim anything is late", () => {
    const label = stalePartLabel({ fixedCents: -200000, fixedStaleCents: -100000, fixedStaleCount: 2, fixedNeverChargedCents: -100000, fixedNeverChargedCount: 2 })!;
    expect(label).toBe("$1,000.00 of it never billed");
    expect(label).not.toContain("late");
  });

  test("all of it never billed says so, rather than 'all of it running late'", () => {
    expect(
      stalePartLabel({ fixedCents: -100000, fixedStaleCents: -100000, fixedStaleCount: 2, fixedNeverChargedCents: -100000, fixedNeverChargedCount: 2 }),
    ).toBe("all of it never billed");
  });

  test("nothing stale is still no sentence at all", () => {
    expect(
      stalePartLabel({ fixedCents: -100000, fixedStaleCents: 0, fixedStaleCount: 0, fixedNeverChargedCents: 0, fixedNeverChargedCount: 0 }),
    ).toBeNull();
  });
});

describe("overdueNote", () => {
  /*
   * ⛔ THE WHOLE POINT. On 2026-09-04, `/recurring?tab=all` said, of one bill,
   * on one screen:
   *
   *   the math table   "1 × -$2,109.00 (monthly), came due 2026-09-01 and has not posted"
   *   the Next column  "Oct 1"          under a section headed "Active — charged
   *                                      within their cadence, and forecast"
   */
  test("names the day the charge was due and never came", () => {
    expect(overdueNote("2026-09-01", 1)).toBe("Sep 1 — not posted");
  });

  test("a weekly bill in arrears counts the ones behind it", () => {
    expect(overdueNote("2026-09-01", 3)).toBe("Sep 1 and 2 more — not posted");
  });
});

describe("postedSpreadReading", () => {
  /**
   * 🔴 The defect, measured 2026-09-08: `Per charge` read "-$2,109.00 ± 610.65"
   * of a series whose four charges average -$1,739.40, so the band was centred
   * on a figure nothing in it was drawn from.
   */
  test("moves the ± onto the average when the headline is not it", () => {
    const r = postedSpreadReading(-210_900, -173_940, 61_065);
    expect(r.attachedToHeadline).toBe(false);
    expect(r.avgLine).toBe(-173_940);
    expect(r.text).toBe("610.65");
  });

  /** ⛔ one number, one place for the band — and no row repeating the headline */
  test("leaves the ± on the headline when the two agree", () => {
    const r = postedSpreadReading(-1_775, -1_775, 134);
    expect(r.attachedToHeadline).toBe(true);
    expect(r.avgLine).toBeNull();
    expect(r.text).toBe("1.34");
  });

  /** a series with nothing linked has no centre and no spread to publish */
  test("says nothing at all with no linked postings", () => {
    expect(postedSpreadReading(-69_504, null, null)).toEqual({
      text: null,
      attachedToHeadline: false,
      avgLine: null,
    });
  });

  /**
   * One linked charge: `postedStddevCents` is null under two rows, but the
   * average is real and still disagrees with the entered figure — Hoffman LL,
   * "-$1,786.46" over a single charge of -$1,835.27.
   */
  test("names an average that differs even with no spread to hang on it", () => {
    const r = postedSpreadReading(-178_646, -183_527, null);
    expect(r.text).toBeNull();
    expect(r.avgLine).toBe(-183_527);
    expect(r.attachedToHeadline).toBe(false);
  });

  /** a spread of exactly zero is not a spread — every charge was identical */
  test("draws no band when every posting was the same amount", () => {
    expect(postedSpreadReading(-499, -499, 0).text).toBeNull();
  });
});

describe("seriesVerb — a series that is over is described in the past", () => {
  test("a running series is present tense, by kind", () => {
    expect(seriesVerb("bill")).toBe("charges");
    expect(seriesVerb("income")).toBe("deposits");
    expect(seriesVerb("transfer")).toBe("moves");
  });

  test("a series that is over is past tense, by kind", () => {
    // 🔴 27 ended or dismissed series read "charges monthly around the 8th"
    // above their own "nothing more is expected from it", 2026-09-10.
    expect(seriesVerb("bill", true)).toBe("charged");
    expect(seriesVerb("income", true)).toBe("deposited");
    expect(seriesVerb("transfer", true)).toBe("moved");
  });

  test("the default is present, so no caller silently changes tense", () => {
    expect(seriesVerb("bill", false)).toBe(seriesVerb("bill"));
  });
});

describe("futureDateLabel — a Next date that is next year says so", () => {
  const TODAY = "2026-09-10";

  /*
   * 🔴 All three annual series carry a 2027 date whose day-and-month is EXACTLY
   * the day they last charged in 2026 — Venture X 2027-01-16 / 2026-01-16,
   * Chase Sapphire 2027-03-01 / 2026-03-01, HBO Max 2027-07-18 / 2026-07-18 —
   * so a bare "Jan 16" in the Next column read as 237 days AGO, and every
   * other cell in the same table really was this year.
   */
  test("a date inside this year stays bare", () => {
    expect(futureDateLabel("2026-10-08", TODAY)).toBe("Oct 8");
    expect(futureDateLabel("2026-01-16", TODAY)).toBe("Jan 16");
  });

  test("a date in another year carries it", () => {
    expect(futureDateLabel("2027-01-16", TODAY)).toBe("Jan 16, 2027");
    expect(futureDateLabel("2027-07-18", TODAY)).toBe("Jul 18, 2027");
  });

  test("a date in a PAST year carries it too — the ambiguity runs both ways", () => {
    expect(futureDateLabel("2025-12-31", TODAY)).toBe("Dec 31, 2025");
  });

  test("the two annual dates that share a day-of-year are distinguishable", () => {
    expect(futureDateLabel("2027-01-16", TODAY)).not.toBe(futureDateLabel("2026-01-16", TODAY));
  });
});

/*
 * 🔴 The gate was `endsOn !== null` — the EXISTENCE of an end date, not an end
 * date inside the year being annualized. Exactly two series on the real ledger
 * carry one, and the caveat was false on one of them.
 */
describe("annualizedCaveat — a year is qualified only when the series stops inside it", () => {
  const TODAY = "2026-09-11";

  test("a lease ending 704 days out bills the whole year, so nothing is said", () => {
    // Car lease, ends 2028-08-15: 12 × $695.04 = $8,340.48 in the twelve months
    // from today — the annualized figure to the cent. It read "a full year —
    // this one is scheduled only to 2028-08-15".
    expect(annualizedCaveat("2028-08-15", TODAY)).toBeNull();
  });

  test("a policy ending inside the year names the window and the day it stops", () => {
    // Car insurance, ends 2027-01-11, against an annualized $4,337.88
    expect(annualizedCaveat("2027-01-11", TODAY)).toBe(
      "the twelve months from today — this one stops on Jan 11, 2027, inside them",
    );
  });

  test("a series with no end date is never qualified", () => {
    expect(annualizedCaveat(null, TODAY)).toBeNull();
  });

  /* The All tab's short form reads the same gate — measured 2026-09-15, its
     "~$715.16/yr" and "~$72.74/yr" had no end date on the row at all. */
  test("the table's short form says the same thing on the same days", () => {
    expect(annualizedEndNote("2027-01-11", TODAY)).toBe("ends Jan 11, 2027");
    expect(annualizedEndNote("2026-11-11", TODAY)).toBe("ends Nov 11, 2026");
    expect(annualizedEndNote("2026-08-01", TODAY)).toBe("ended Aug 1, 2026");
    for (const endsOn of [null, "2028-08-15", "2027-09-11", "2027-09-10", "2026-08-01", "2027-01-11"]) {
      expect(annualizedEndNote(endsOn, TODAY) === null, String(endsOn)).toBe(annualizedCaveat(endsOn, TODAY) === null);
    }
  });

  test("the year's far end is EXCLUSIVE — a series ending on it runs the whole year", () => {
    expect(annualizedCaveat("2027-09-11", TODAY)).toBeNull();
    expect(annualizedCaveat("2027-09-10", TODAY)).not.toBeNull();
  });

  /*
   * 🔴 A WINDOW HAS TWO ENDS. The first version checked only the far one, so a
   * series that had already stopped read "stops on Aug 1, 2026, inside them" of
   * a window beginning Sep 11 — and this test pinned that as correct. It does
   * not stop inside those twelve months; it stopped before them, and the
   * annualized figure over them is a fiction rather than a partial year.
   */
  test("a series that has ALREADY stopped gets the STRONGER sentence, not the same one", () => {
    expect(annualizedCaveat("2026-08-01", TODAY)).toBe(
      "a year this series no longer bills — it stopped on Aug 1, 2026",
    );
    expect(annualizedCaveat("2026-08-01", TODAY)).not.toContain("inside them");
  });

  test("the near end is TODAY, and a series ending today still has a year to say something about", () => {
    expect(annualizedCaveat(TODAY, TODAY)).toBe(
      "the twelve months from today — this one stops on Sep 11, 2026, inside them",
    );
    expect(annualizedCaveat("2026-09-10", TODAY)).toContain("no longer bills");
  });
});

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 54): a merge files the source's rows not filed yet under the target's category, and
 * the confirmation says so before he presses — a merge has no undo button. Nothing to file → the sentence he has
 * always read, unchanged.
 */
describe("merge sentences (§6A 54)", () => {
  const filing = { categoryId: "c1", categoryPath: "Car > Lease", count: 2 };

  test("the confirmation names the exact count and the category path", () => {
    expect(mergeFilingClause(filing)).toBe("2 not filed yet will be filed under Car > Lease.");
    expect(mergeFilingClause({ ...filing, count: 1, categoryPath: "Rent" })).toBe(
      "1 not filed yet will be filed under Rent.",
    );
  });

  test("with nothing to file the confirmation adds nothing", () => {
    expect(mergeFilingClause(null)).toBeNull();
  });

  /*
   * 🔴 Review 2026-10-08: the toast took `relinked` and `filed` as two loose arguments, so the page could drop the
   * filing (`null`) and every test stayed green. It now reads the merge's own result, whole.
   */
  test("the toast adds the filing in the same voice — and reads as before when nothing was filed", () => {
    expect(mergedToastTitle("Car lease 2", { relinked: 3, filed: filing })).toBe(
      "Car lease 2 merged in · 3 moved · 2 filed under Car > Lease",
    );
    expect(mergedToastTitle("Car lease 2", { relinked: 3, filed: null })).toBe("Car lease 2 merged in · 3 moved");
  });
});

/*
 * A day read per payday says so: settlement names money by its day, so the
 * figure under a $4,567.68 deposit dated beside a week of pay is the DAY's five
 * paydays, and a row reading "5 paydays" alone would claim the lump paid five.
 */
describe("perPaydayWord — a lump, and a day of several deposits", () => {
  test("a lump alone on its day names its paydays", () => {
    expect(perPaydayWord({ paydays: 4, cents: 114192 })).toBe("4 paydays at $1,141.92 each");
  });

  test("a day of two deposits names the other one", () => {
    expect(perPaydayWord({ paydays: 5, cents: 114192, deposits: 2 })).toBe(
      "5 paydays at $1,141.92 each, with the day's other deposit",
    );
  });

  test("a day of three, and a day that paid one payday", () => {
    expect(perPaydayWord({ paydays: 3, cents: 114192, deposits: 3 })).toBe(
      "3 paydays at $1,141.92 each, with the day's 2 other deposits",
    );
    expect(perPaydayWord({ paydays: 1, cents: 114192, deposits: 2 })).toBe(
      "1 payday at $1,141.92, with the day's other deposit",
    );
  });
});

/*
 * 🔴 VISIBLE on his ledger 2026-10-08: the Upcoming list badged "It America LLC (weekly pay) … last seen 14d ago" in
 * amber under "In October 2026, 4 series are running late — still projected", while /recurring said two lines up
 * that its payday "falls after Thu, Sep 24, 2026, the last day every account that pay lands in has been checked
 * through — so the ledger has not looked for its deposit". The age stays a fact; it is not counted or toned as late.
 */
describe("awaiting statements: the age stays, the lateness goes", () => {
  // his pay: last Sep 24, 14 days to Oct 8 against 12.5, Wells Fargo checked through Sep 24
  const unread = staleness({
    lastMatchedOn: "2026-09-24",
    daysSinceLastMatch: 14,
    isStale: false,
    checkedThrough: "2026-09-24",
    awaitingStatements: true,
  });
  const entry = (key: string, s: SeriesStaleness): StaleEntry => ({ key, name: key, staleness: s });
  const late = entry("Late", staleness());
  const never = entry("Never", staleness({ lastMatchedOn: null, daysSinceLastMatch: null }));
  const pay = entry("Pay", unread);

  test("the chip keeps its age and is not a warning", () => {
    expect(staleLabel(unread)).toBe("last seen 14d ago");
    expect(staleMarkTone(unread)).toBe("neutral");
  });

  /*
   * 🔴 It said "its account has been checked only through …, inside the 43-day tolerance — so the ledger has not
   * looked for the next one yet" — false once a statement covers the due day but not the end of the grace (the
   * real Breezeline row, 2026-10-08 copy: due Oct 11, checked through Oct 13), and "its account" of a series with
   * several. The claim the state can make on both sides of the due day: the tolerance has not run out on checked
   * days, so it cannot be called late yet — in the passed-payday sentence's own words for the checked day.
   */
  test("its sentence names the checked day and says it cannot be called late yet — never that nobody looked", () => {
    const sentence = stalenessSentence(unread);
    expect(sentence).toContain("nothing has matched since Sep 24, 2026 (14 days)");
    expect(sentence).toContain("Sep 24, 2026 is the last day every account it posts to has been checked through");
    expect(sentence).toContain("0 of the 12 days its tolerance allows");
    expect(sentence).toContain("so it cannot be called late yet");
    expect(sentence).toContain("Still projected");
    expect(sentence).not.toContain("past the");
    expect(sentence).not.toContain("not looked for");
    expect(sentence).not.toContain("its account");
    // the due day checked, the grace not yet: the real Breezeline row at today = Oct 25
    const dueDayChecked = staleness({
      lastMatchedOn: "2026-09-10",
      daysSinceLastMatch: 45,
      stepDays: 27.33,
      toleranceDays: 43.995,
      isStale: false,
      checkedThrough: "2026-10-13",
      awaitingStatements: true,
    });
    expect(stalenessSentence(dueDayChecked)).toContain("33 of the 43 days its tolerance allows");
    expect(stalenessSentence(dueDayChecked)).not.toContain("not looked for");
    const nothingChecked = stalenessSentence({ ...unread, checkedThrough: null });
    expect(nothingChecked).toContain("the ledger has not checked every account it posts to");
    expect(nothingChecked).toContain("so it cannot be called late yet");
    expect(nothingChecked).not.toContain("null");
  });

  test("it reaches the footer, so the chip's why is keyboard-reachable", () => {
    const occurrence: SeriesOccurrence = {
      seriesId: "pay",
      name: "Pay",
      kind: "income",
      cadence: "weekly",
      date: "2026-10-08",
      amountCents: 114_192,
      anchorDayOfMonth: null,
      staleness: unread,
    };
    expect(staleOccurrenceEntries([occurrence]).map((e) => e.key)).toEqual(["pay"]);
    const component: ForecastComponent = { label: "Pay", kind: "fixed", cents: 456_768, detail: "4 × …", staleness: unread };
    expect(staleComponentEntries([component]).map((e) => e.key)).toEqual(["Pay"]);
  });

  test("the count names it apart from the late ones, and never calls it late", () => {
    expect(staleSummaryLabel([pay], "In October 2026")).toBe(
      "In October 2026, 1 series is awaiting statements — still projected",
    );
    expect(staleSummaryLabel([pay, entry("Rocket", unread)], "In October 2026")).toBe(
      "In October 2026, 2 series are awaiting statements — still projected",
    );
    expect(staleSummaryLabel([late, pay], "In October 2026")).toBe(
      "In October 2026, 1 series is running late and 1 is awaiting statements — all still projected",
    );
    expect(staleSummaryLabel([late, never, pay], "In October 2026")).toBe(
      "In October 2026, 1 series is running late, 1 has never been billed and 1 is awaiting statements — all still projected",
    );
    // the two existing phrasings are untouched
    expect(staleSummaryLabel([late, never], "In October 2026")).toBe(
      "In October 2026, 1 series is running late and 1 has never been billed — all still projected",
    );
  });

  test("the footer is no warning when nothing is late, and its hint does not call the evidence old", () => {
    expect(staleFooterIsWarning([pay])).toBe(false);
    expect(staleFooterIsWarning([pay, never])).toBe(false);
    expect(staleFooterIsWarning([pay, late])).toBe(true);
    expect(staleFooterHint([pay])).toBe("why these cannot be called late yet");
    expect(staleFooterHint([pay])).not.toContain("old");
  });

  /*
   * 🔴 The hint reached its awaiting words only when nothing else was in the list. On his ledger copy (2026-10-08)
   * the Upcoming footer read "In the next 30 days, 3 series have never been billed and 3 have not been looked for
   * yet — all still projected" over the hint "why these numbers rest on the schedule alone" — false of the pay, FPL
   * and Rocket Money, which rest on Sep 24, Jul 28 and Jul 15 evidence — and October's forecast footer named old
   * evidence and the schedule but not them. The half-true hint fixed on 2026-09-15, one kind over.
   */
  test("the hint names every kind its list holds", () => {
    const why = "why some cannot be called late yet";
    expect(staleFooterHint([pay, never])).toBe(`why these numbers rest on the schedule alone, and ${why}`);
    expect(staleFooterHint([never, pay])).toBe(`why these numbers rest on the schedule alone, and ${why}`);
    expect(staleFooterHint([pay, late])).toBe(`why these numbers rest on old evidence, and ${why}`);
    expect(staleFooterHint([late, never, pay])).toBe(
      `why these numbers rest on old evidence or on the schedule alone, and ${why}`,
    );
    // the three without it are untouched
    expect(staleFooterHint([late])).toBe("why these numbers rest on old evidence");
    expect(staleFooterHint([never])).toBe("why these numbers rest on the schedule alone");
    expect(staleFooterHint([late, never])).toBe("why these numbers rest on old evidence or on the schedule alone");
  });

  /*
   * ⛔ The MONEY IN/OUT band is not tested here. 🔴 A test here fed `stalePartLabel` zero stale cents, which returned
   * null before the band learned the state too, and stayed green with `isStale || awaitingStatements` back in
   * `ForecastCard` (review of 2ed1e79). The card maps the components into the band, so the guard renders the card:
   * services/late-over-unread-days.test.ts, "the forecast card's MONEY IN/OUT band, as the card renders it".
   */
});
