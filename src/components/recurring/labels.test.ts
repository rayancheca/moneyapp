import { describe, expect, test } from "vitest";
import { DAYS_TO_POST_NOT_OVER, NO_STATEMENT_YET } from "@/lib/arrears-reading";
import { projectedEvidence, seriesEvidenceTone, seriesPostingWords, type SeriesEvidence } from "@/lib/series-evidence";
import { notLookedForDeposits } from "@/lib/unbanked-income";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";
import {
  alreadyDueWords,
  annualizedCaveat,
  annualizedEndNote,
  annualizedFigure,
  cadenceLabel,
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
  seriesEndBadge,
  seriesAccountWord,
  seriesVerb,
  futureDateLabel,
  attachedToastTitle,
  filedToastTitle,
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

  test("the cash reason keeps its word", () => {
    expect(unsettledReasonWord("unbanked")).toBe("not banked yet");
  });

  /*
   * 🔴 Since a due day is read only with its grace (§6A 60, `dueDayIsRead`), `not_imported` is also the reason of a
   * day an import HAS reached short of its grace: the e2e fixture's Meal Kit, due Jul 5 on a card imported through
   * Jul 5, read "not yet known (not imported yet)" of an imported day. ⚖️ His decision 60 (2026-10-08): until the day
   * and its grace are imported, the runway's unread words, shared, so the calendar's "?" and every arrears surface say
   * one thing of one Oct 1. ⚖️ His decision 65 (2026-10-12): read to each account's last CHECKED statement balance, so
   * "no statement has covered it yet" — true too of a day the imported rows have passed and no statement has.
   */
  test("the coverage reason is the arrears' unread words — true of a day imported short of its grace", () => {
    expect(unsettledReasonWord("not_imported")).toBe(NO_STATEMENT_YET);
    expect(unsettledReasonWord("not_imported")).toBe("no statement has covered it yet");
  });

  /*
   * 🔴 …and of a day on an archived card or a cash wallet, read through today, whose grace runs past it (review of the
   * 2026-10-08 batch): "no import has covered it yet" of an import that will never come. Its days to post are what it
   * waits for — the arrears' words for the same money (`DAYS_TO_POST_NOT_OVER`).
   */
  test("the grace reason says its days to post are not over — the arrears' words, never 'no import'", () => {
    expect(unsettledReasonWord("in_grace")).toBe(DAYS_TO_POST_NOT_OVER);
    expect(unsettledReasonWord("in_grace")).toBe("the days a payment has to post are not over yet");
  });

  /*
   * ⚖️ A payday nobody has looked for, in every pay sentence's words (`notLookedForDeposits`) — the forecast's note,
   * /budgets, the dashboard and /spending say "the ledger has not looked for its deposit". 🔴 It read a bill's words,
   * "no statement has covered it yet": of pay landing where no statement is coming (archived, a cash wallet) a promise
   * of one, and beside a pay sentence naming an account with no checked record, a statement it does not name.
   */
  test("the payday reason is the pay sentences' words — no statement promised", () => {
    expect(unsettledReasonWord("not_looked_for")).toBe(notLookedForDeposits(1));
    expect(unsettledReasonWord("not_looked_for")).toBe("the ledger has not looked for its deposit");
  });
});

describe("upcomingEvidenceWord", () => {
  test("a series that has never charged is 'never billed', in the All tab's word", () => {
    expect(upcomingEvidenceWord({ isStale: false, neverBilled: true, billedWith: null })).toBe("never billed");
  });

  test("a series running late keeps 'evidence stale'", () => {
    expect(upcomingEvidenceWord({ isStale: true, neverBilled: false, billedWith: null })).toBe("evidence stale");
  });

  test("fresh evidence needs no word", () => {
    expect(upcomingEvidenceWord({ isStale: false, neverBilled: false, billedWith: null })).toBeNull();
  });

  /*
   * ⚖️ His decision 59 (2026-10-08): `Rent utilities & fees` is paid inside the rent. 🔴 Its upcoming entry read
   * "(scheduled, never billed)"; it says whose postings its evidence is, and what they say.
   */
  test("a series billed inside another's payment says so — and what its carrier's evidence says", () => {
    const rent = "billed with the rent";
    expect(upcomingEvidenceWord({ isStale: false, neverBilled: false, billedWith: rent })).toBe("billed with the rent");
    expect(upcomingEvidenceWord({ isStale: true, neverBilled: false, billedWith: rent })).toBe(
      "billed with the rent, evidence stale",
    );
    expect(upcomingEvidenceWord({ isStale: false, neverBilled: true, billedWith: rent })).toBe(
      "billed with the rent, which has never been billed",
    );
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
  scheduleEnded: false,
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
    expect(staleLabel(never)).toBe(upcomingEvidenceWord({ isStale: true, neverBilled: true, billedWith: null }));
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

/*
 * 🔴 Review of 2026-10-08: the series page wore "Never billed" in amber while this chip called the same state neutral,
 * and the forecast's footer said "running late" of a series the All tab on the same page filed as lapsed — one state
 * with two tones, one word from two predicates. The chip, the footer and the badge read ONE word (`projectedEvidence`)
 * and wear ONE tone (`seriesEvidenceTone`).
 */
describe("one word, one tone — the chip, the footer and the series page's badge", () => {
  const states: [SeriesEvidence, SeriesStaleness][] = [
    ["running-late", staleness()],
    ["never-billed", staleness({ lastMatchedOn: null, daysSinceLastMatch: null, checkedDaysSinceLastMatch: null })],
    ["awaiting-statements", staleness({ isStale: false, awaitingStatements: true, checkedThrough: "2026-06-30" })],
    ["active", staleness({ daysSinceLastMatch: 3, checkedDaysSinceLastMatch: 3, isStale: false })],
  ];

  test.each(states)("%s: the chip reads the badge's word, in the badge's tone", (word, s) => {
    expect(projectedEvidence(s)).toBe(word);
    expect(staleMarkTone(s)).toBe(seriesEvidenceTone(word));
  });

  test("the footer counts each under the word the All tab files it under", () => {
    const entries = states.filter(([w]) => w !== "active").map(([w, s]) => ({ key: w, name: w, staleness: s }));
    expect(staleSummaryLabel(entries, "In October 2026")).toBe(
      "In October 2026, 1 series is running late, 1 has never been billed and 1 is awaiting statements — all still projected",
    );
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

  /*
   * ⚖️ Since §6A 57 (owner, 2026-10-08) late is counted on READ days (`seriesStaleness`): a late import makes a series
   * "Awaiting statements", never running late — the reason fcdd51b re-documented `LAPSED_MISS_LIMIT` by. What keeps a
   * late series projected now is that a statement read without a match does not yet prove it stopped: one posted to
   * another account, or under a description not linked to it, reads the same. 🔴 The sentence still said "a late
   * import looks exactly like a cancelled series" — of a series whose days had been read.
   *
   * …in words true of a deposit as of a charge, as its siblings' "nothing has matched since" (below): the sentence
   * carries no sign, and the forecast's money-in band discloses a pay series running late with it. 🔴 It said "one paid
   * from another account" — of a payroll deposit too (review of the late-lapse batch, 2026-10-14).
   */
  test("running late gives the read-day reason it is still projected — never import lag", () => {
    const sentence = stalenessSentence(staleness());
    expect(sentence).not.toMatch(/import/);
    expect(sentence).not.toMatch(/paid from/);
    expect(sentence).toContain(
      "Still projected: statements read without a match are not yet proof it stopped — one posted to another " +
        "account, or under a description not linked to it, reads the same — so this says which numbers rest on old " +
        "evidence rather than dropping them.",
    );
  });

  /*
   * ⚖️ §6A 56 (2026-10-08): a schedule of ONE charge is "once · Nov 11" wherever a cadence prints. 🔴 Visible on his
   * ledger copy 2026-10-13: Upcoming's footer read "Car insurance — Nov 11 balance … — expected about every 30 days".
   */
  test("a one-charge series is expected once, on its day — its rhythm is no rhythm, whatever the stored step", () => {
    const never = staleness({ lastMatchedOn: null, daysSinceLastMatch: null, stepDays: 30, oneChargeOn: "2026-11-11" });
    expect(stalenessSentence(never)).toBe(
      "expected once on Nov 11, 2026, but nothing has ever matched it — still projected, on the schedule alone",
    );
    expect(stalenessSentence({ ...never, lastMatchedOn: "2026-06-16", daysSinceLastMatch: 22 })).toMatch(
      /^expected once on Nov 11, 2026, but nothing has matched since Jun 16, 2026/,
    );
    // not one charge, or not asked: its step, as ever
    expect(stalenessSentence({ ...never, oneChargeOn: null })).toMatch(/^expected about every 30 days/);
    expect(stalenessSentence({ ...never, oneChargeOn: undefined })).toMatch(/^expected about every 30 days/);
  });

  test("a fractional detected interval renders as a whole number of days", () => {
    expect(stalenessSentence(staleness({ stepDays: 30.2, toleranceDays: 48.3 }))).toContain(
      "every 30 days",
    );
  });

  /*
   * …in its siblings' words — "nothing has matched since …" — true of a deposit as of a charge. 🔴 It said "no charge
   * has ever matched it" of every series nothing ever matched, a hand-registered pay included (review of 2026-10-08:
   * the evidence words said "charge" of his payroll deposit).
   */
  test("with no match at all it says so instead of formatting a null date — of a deposit as of a charge", () => {
    const sentence = stalenessSentence(staleness({ lastMatchedOn: null, daysSinceLastMatch: null }));
    expect(sentence).toContain("nothing has ever matched it");
    expect(sentence).not.toMatch(/charge|deposit/);
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
    staleness: { lastMatchedOn: "2026-06-05", daysSinceLastMatch: days, checkedDaysSinceLastMatch: days, stepDays: 7, toleranceDays: 14, isStale: true, awaitingStatements: false, scheduleEnded: false },
  });
  const never = (n: number): StaleEntry => ({
    key: `never-${n}`,
    name: `Never ${n}`,
    staleness: { lastMatchedOn: null, daysSinceLastMatch: null, checkedDaysSinceLastMatch: null, stepDays: 30, toleranceDays: 48, isStale: true, awaitingStatements: false, scheduleEnded: false },
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
    expect(overdueNote("2026-09-01", 1, { owedCents: 210900, unreadCents: 0 })).toEqual({
      text: "Sep 1 — not posted",
      warning: true,
    });
  });

  test("a weekly bill in arrears counts the ones behind it", () => {
    expect(overdueNote("2026-09-01", 3, { owedCents: 3000, unreadCents: 0 }).text).toBe("Sep 1 and 2 more — not posted");
  });

  /*
   * 🔴 "Oct 1 — not posted" in warning colour under rent and its utilities on `/recurring?tab=all`, and the same under
   * `/categories/<Housing>` (a copy of his ledger, 2026-10-08) — of a day no import had reached: rent posts from Wells
   * Fargo, read through Sep 24. ⚖️ Over unread days never "not posted"; staleness between uploads is normal, never a
   * warning (his words 2026-08-05; the class approved 2026-10-07).
   */
  test("a day no checked statement has reached is quiet, and says no statement has covered it yet", () => {
    const note = overdueNote("2026-10-01", 1, { owedCents: 210900, unreadCents: 210900 });
    expect(note).toEqual({ text: "Oct 1 — no statement has covered it yet", warning: false });
    expect(note.text).not.toMatch(/not posted/);
  });

  test("part read and part unread says both, by amount, and keeps the warning for the part that is late", () => {
    expect(overdueNote("2026-07-01", 3, { owedCents: 3000, unreadCents: 1000 })).toEqual({
      text: "Jul 1 and 2 more — $20.00 not posted, and no statement has covered the other $10.00 yet",
      warning: true,
    });
  });
});

/**
 * The rent's own page, `/recurring/<Flamingo South Beach (rent)>`, on a copy of his ledger 2026-10-08:
 *
 *     Already due, and not posted          (warning colour)
 *     Inside this calendar month, with no posting within 3 days of it. …
 *     Oct 1, 2026   -$2,109.00
 *
 * 🔴 Oct 1 is a day no import has covered — the runway on the same ledger: "A further $2,291.21 came due earlier this
 * month and no import has covered it yet." The heading follows the runway's split (`arrearsSplit`).
 */
describe("alreadyDueWords", () => {
  test("read and unposted keeps 'Already due, and not posted', in warning", () => {
    const w = alreadyDueWords({ owedCents: 210900, unreadCents: 0 }, 3, 1, null);
    expect(w.heading).toBe("Already due, and not posted");
    expect(w.warning).toBe(true);
  });

  /*
   * ⚖️ WHAT WAS READ IS NOW THE GRACE TOO — his decision 60 (2026-10-08). A due day counts as read once the records
   * reach it PLUS the `toleranceDays` a posting may still land within (`dueDayIsRead`), so the body can say what the
   * rule checked: they reach that far past it and hold no posting within the tolerance. 🔴 It used to be read on the
   * day ITSELF, so the body could only say "which reach its day" (review of 2e6c74b) — while the heading said "not
   * posted" of Jul 6–8 for the e2e fixture's Meal Kit (due Jul 5, its card imported through Jul 5). ⚖️ The records are
   * the checked statements (his decision 65, 2026-10-12), and the body names them.
   */
  test("the read body says what was read: statements reach the grace past its day and hold no posting in it", () => {
    expect(alreadyDueWords({ owedCents: 210900, unreadCents: 0 }, 3, 1, null).body).toBe(
      "Inside this calendar month, and the statements reach 3 days past it with no posting within 3 days of it. " +
        "The forecast counts it, and so does this month's budget.",
    );
  });

  test("a bill with no grace is read on its day, and says so", () => {
    expect(alreadyDueWords({ owedCents: 5000, unreadCents: 0 }, 0, 1, null).body).toBe(
      "Inside this calendar month, and the statements reach its day with no posting on it. " +
        "The forecast counts it, and so does this month's budget.",
    );
  });

  /*
   * 🔴 THE READ BODY SAID "it" OF EVERY BILL, AND SAID IT AWKWARDLY: "Inside this calendar month, and the statements,
   * which reach 3 days past it, hold no posting within 3 days of it." A weekly bill owes this month's arrears on two,
   * three or four due days (`occurrenceCount`, the card's own "and N more"), and the statements were said to reach
   * past "it" and to hold nothing within days "of it" — one day of several. Each due day is read the same way
   * (`dueDayIsRead`), so the body says it of each.
   */
  test("several due days, read: the statements reach past each and hold no posting near any of them", () => {
    expect(alreadyDueWords({ owedCents: 14000, unreadCents: 0 }, 3, 2, null).body).toBe(
      "Both due days are inside this calendar month, and the statements reach 3 days past each with no posting " +
        "within 3 days of either. The forecast counts both, and so does this month's budget.",
    );
    expect(alreadyDueWords({ owedCents: 22001, unreadCents: 0 }, 3, 3, null).body).toBe(
      "All 3 due days are inside this calendar month, and the statements reach 3 days past each with no posting " +
        "within 3 days of any of them. The forecast counts all 3, and so does this month's budget.",
    );
    expect(alreadyDueWords({ owedCents: 14000, unreadCents: 0 }, 0, 2, null).body).toBe(
      "Both due days are inside this calendar month, and the statements reach both with no posting on either. " +
        "The forecast counts both, and so does this month's budget.",
    );
  });

  test("several due days, unread: no statement reaches past any of them, so they may well have posted", () => {
    expect(alreadyDueWords({ owedCents: 14000, unreadCents: 14000 }, 3, 2, null).body).toBe(
      "Both due days are inside this calendar month, and no statement reaches 3 days past either yet — the days a " +
        "payment has to post — so both may well have posted. The forecast counts both, and so does this month's budget.",
    );
    expect(alreadyDueWords({ owedCents: 22001, unreadCents: 22001 }, 3, 3, null).body).toBe(
      "All 3 due days are inside this calendar month, and no statement reaches 3 days past any of them yet — the " +
        "days a payment has to post — so all 3 may well have posted. The forecast counts all 3, and so does this " +
        "month's budget.",
    );
  });

  test("no body for several due days speaks of one", () => {
    for (const n of [2, 3, 4]) {
      for (const unreadCents of [0, 3000]) {
        for (const grace of [0, 3]) {
          const body = alreadyDueWords({ owedCents: 3000, unreadCents }, grace, n, null).body;
          expect(body, `${n} · ${unreadCents} · ${grace}`).not.toMatch(/\bit\b/);
        }
      }
    }
  });

  /*
   * ⚖️ Unread now includes a day the statements HAVE reached, short of its grace (§6A 60) — so the body cannot say "on
   * a day no statement has reached": it says how far they must reach, and why the money may be there.
   */
  test("unread is quiet and says it in the runway's words", () => {
    const w = alreadyDueWords({ owedCents: 210900, unreadCents: 210900 }, 3, 1, null);
    expect(w.heading).toBe("Already due — no statement has covered it yet");
    expect(w.warning).toBe(false);
    expect(`${w.heading} ${w.body}`).not.toMatch(/not posted|no posting/);
    expect(w.body).toBe(
      "Inside this calendar month, and no statement reaches 3 days past it yet — the days a payment has to post — " +
        "so it may well have posted. The forecast counts it, and so does this month's budget.",
    );
  });

  /*
   * 🔴 An archived card's bill due Oct 6, on Oct 8: "Already due — no import has covered it yet" and "no import reaches
   * 3 days past it yet" — of an import that will never come (review of the 2026-10-08 batch). Its account is read
   * through today (`silenceReadThrough`); all it waits for is its days to post.
   */
  test("unread with nothing left to import says its days to post are not over — quiet, no 'import' or 'statement'", () => {
    const w = alreadyDueWords({ owedCents: 229121, unreadCents: 229121, inGraceCents: 229121 }, 3, 1, null);
    expect(w.heading).toBe("Already due — the days a payment has to post are not over yet");
    expect(w.warning).toBe(false);
    expect(w.body).toBe(
      "Inside this calendar month, and the 3 days past it a payment has to post are not over yet, so it may still " +
        "post. The forecast counts it, and so does this month's budget.",
    );
    expect(`${w.heading} ${w.body}`).not.toMatch(/import|statement|not posted|no posting/);
  });

  test("a mix with nothing left to import names the rest by its days to post", () => {
    const w = alreadyDueWords({ owedCents: 3000, unreadCents: 1000, inGraceCents: 1000 }, 6, 1, null);
    expect(w.heading).toBe(
      "Already due: $20.00 not posted, and the days a payment has to post for the other $10.00 are not over yet",
    );
    expect(w.warning).toBe(true);
    expect(w.body).toBe(
      "Inside this calendar month. Where the statements reach 6 days past a due day, they hold no posting within 6 " +
        "days of it; for the rest, the days a payment has to post are not over yet. The forecast counts all of it, and " +
        "so does this month's budget.",
    );
  });

  /*
   * 🔴 ONE FIGURE FOR TWO WINDOWS (review of 44eb3e7). A bill billed inside another's payment is paid by a posting of its
   * own within its own tolerance, or by its carrier's within the carrier's (`paymentFor`, each by its own series') — and
   * its grace is the wider. With the rent's 5 and the utilities' own 3, their page read "hold no posting within 5 days
   * of it" beside a posting of their own four days off Oct 1, which paid them nothing.
   */
  test("billed inside the rent with its own narrower window: the read body names each window", () => {
    const carried = { ownDays: 3, carrierName: "Flamingo South Beach (rent)", carrierDays: 5 };
    expect(alreadyDueWords({ owedCents: 18221, unreadCents: 0 }, 5, 1, carried).body).toBe(
      "Inside this calendar month, and the statements reach 5 days past it with no posting of its own within 3 days " +
        "of it, and none of the rent's payments within 5 days of it. The forecast counts it, and so does this month's " +
        "budget.",
    );
  });

  test("…its own the wider: still each window — and a mix names them where the statements reach", () => {
    const carried = { ownDays: 5, carrierName: "Flamingo South Beach (rent)", carrierDays: 3 };
    expect(alreadyDueWords({ owedCents: 18221, unreadCents: 0 }, 5, 1, carried).body).toContain(
      "with no posting of its own within 5 days of it, and none of the rent's payments within 3 days of it.",
    );
    expect(alreadyDueWords({ owedCents: 36442, unreadCents: 18221 }, 5, 1, carried).body).toBe(
      "Inside this calendar month. Where the statements reach 5 days past a due day, they hold no posting of its own " +
        "within 5 days of it, and none of the rent's payments within 3 days of it; for the rest, no statement reaches " +
        "that far yet. The forecast counts all of it, and so does this month's budget.",
    );
  });

  // ⚖️ his ledger: rent and utilities both 3 days — one window, one figure, exactly as before
  test("billed inside the rent on the same days: one window, one figure", () => {
    const carried = { ownDays: 3, carrierName: "Flamingo South Beach (rent)", carrierDays: 3 };
    expect(alreadyDueWords({ owedCents: 18221, unreadCents: 0 }, 3, 1, carried).body).toBe(
      alreadyDueWords({ owedCents: 18221, unreadCents: 0 }, 3, 1, null).body,
    );
  });

  test("a mix names both halves by amount", () => {
    const w = alreadyDueWords({ owedCents: 3000, unreadCents: 1000 }, 1, 3, null);
    expect(w.heading).toBe("Already due: $20.00 not posted, and no statement has covered the other $10.00 yet");
    expect(w.warning).toBe(true);
    // the read half, like the read body, only as far as the statements reach
    expect(w.body).toBe(
      "Inside this calendar month. Where the statements reach 1 day past a due day, they hold no posting within 1 " +
        "day of it; for the rest, no statement reaches that far yet. The forecast counts all of it, and so does this " +
        "month's budget.",
    );
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
    expect(r.text).toBe("± $610.65");
  });

  /** ⛔ one number, one place for the band — and no row repeating the headline */
  test("leaves the ± on the headline when the two agree", () => {
    const r = postedSpreadReading(-1_775, -1_775, 134);
    expect(r.attachedToHeadline).toBe(true);
    expect(r.avgLine).toBeNull();
    expect(r.text).toBe("± $1.34");
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

  /**
   * 🔴 A BARE NUMBER BESIDE MONEY. The band printed `toFixed(2)` beside figures printed as money: on a copy of his
   * ledger 2026-10-08 `/recurring/<Flamingo South Beach (rent)>` read "posted avg -$1,849.76 ± 583.58", and his pay
   * "posted avg +$1,789.15 ± 1881.46" — no "$", no thousands separator. The band is money, printed as money.
   */
  test("prints the band as money — the sign, the dollar and the separator", () => {
    expect(postedSpreadReading(-210_900, -184_976, 58_358).text).toBe("± $583.58");
    expect(postedSpreadReading(114_192, 178_915, 188_146).text).toBe("± $1,881.46");
  });
});

/*
 * 🔴 His pay's page read "deposits weekly on Thursdays, about $1,141.92 from Wells Fargo Everyday Checking." (a copy of
 * his ledger, 2026-10-13). The word before the account says which way the money moves through it.
 */
describe("seriesAccountWord — into the account money lands in, from the one it leaves", () => {
  test("pay lands into its account; a bill, a subscription and any other payment leave from theirs", () => {
    expect(seriesAccountWord("income", 114_192)).toBe("into");
    for (const kind of ["bill", "subscription", "other"] as const) expect(seriesAccountWord(kind, -499), kind).toBe("from");
  });

  test("a transfer is one leg of a move between his accounts, and its sign says which", () => {
    expect(seriesAccountWord("transfer", -99_302)).toBe("from");
    expect(seriesAccountWord("transfer", 99_302)).toBe("into");
  });

  test("with no amount to read a sign from, the kind decides — pay into, everything else from", () => {
    expect(seriesAccountWord("income", null)).toBe("into");
    expect(seriesAccountWord("transfer", null)).toBe("from");
    expect(seriesAccountWord("bill", null)).toBe("from");
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
    expect(seriesVerb("bill", { posted: true })).toBe("charged");
    expect(seriesVerb("income", { posted: true })).toBe("deposited");
    expect(seriesVerb("transfer", { posted: true })).toBe("moved");
  });

  /*
   * 🔴 Review of 49cc98f: "charged once on Nov 11, about $72.74" over "Linked transactions · 0" — the Nov 11 balance's
   * schedule had ended and the bank had never charged it (a copy of his ledger, 2026-10-12, asked about 2026-11-12).
   * Past tense says the schedule is over; a posting it never made is no past it has.
   */
  test("…and one that never posted was expected, whatever its kind — never 'charged', 'deposited' or 'moved'", () => {
    for (const kind of ["bill", "subscription", "income", "transfer", "other"] as const) {
      expect(seriesVerb(kind, { posted: false }), kind).toBe("was expected");
    }
  });

  test("the default is present, so no caller silently changes tense", () => {
    expect(seriesVerb("bill", false)).toBe(seriesVerb("bill"));
  });

  /*
   * ⚖️ An `other` series' postings are PAYMENTS — it may be money in, a monthly credit (`seriesPostingWords`, the merge
   * choice of 6cae7c5): "Per payment", "Its payments below stay in the ledger", "paid monthly" once over. 🔴 Its present
   * tense still said "charges monthly around the 8th" on the same page — the one verb that table did not give.
   */
  test("an `other` series pays and paid — present and past from the one posting-words table, for every kind", () => {
    expect(seriesVerb("other")).toBe("pays");
    expect(seriesVerb("other", { posted: true })).toBe("paid");
    // a bill's and a subscription's words are as he has always read them
    expect(seriesVerb("subscription")).toBe("charges");
    for (const kind of ["bill", "subscription", "income", "transfer", "other"] as const) {
      expect(seriesVerb(kind), kind).toBe(seriesPostingWords(kind).present);
      expect(seriesVerb(kind, { posted: true }), kind).toBe(seriesPostingWords(kind).past);
    }
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
    expect(annualizedEndNote("2026-08-01", TODAY)).toBeNull();
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
   * not stop inside those twelve months; it stopped before them.
   *
   * ⛔ …and since 0af5689 such a series HAS no annualized figure to qualify: `annualizedCentsOf` is null for every end
   * before today (the proof is in recurring.test.ts), and both printers print the qualifier only under a figure. The
   * "a year this series no longer bills — it stopped on …" sentence written for it could never render, and its comment
   * said Car insurance would reach it on 2027-01-12 — that day its row reads "—". Silence, not a dead sentence.
   */
  test("a series that has ALREADY stopped is not qualified — it has no year ahead, and no figure to qualify", () => {
    for (const endsOn of ["2026-08-01", "2026-09-10"]) {
      expect(annualizedCaveat(endsOn, TODAY), endsOn).toBeNull();
      expect(annualizedEndNote(endsOn, TODAY), endsOn).toBeNull();
    }
  });

  test("the near end is TODAY, and a series ending today still has a year to say something about", () => {
    expect(annualizedCaveat(TODAY, TODAY)).toBe(
      "the twelve months from today — this one stops on Sep 11, 2026, inside them",
    );
    expect(annualizedEndNote(TODAY, TODAY)).toBe("ends Sep 11, 2026");
  });
});

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 54): a merge files the source's rows not filed yet under the target's category, and
 * the confirmation says so before he presses — a merge has no undo button. Nothing to file → the sentence he has
 * always read, unchanged.
 */
/*
 * ⛔ One tense for one fact: the badge says "Ended" exactly when the card says "Its schedule has ended", with the day
 * the schedule ran out. 🔴 An end between two due days read "Ends Jan 5, 2027" beside "Its schedule has ended".
 */
describe("seriesEndBadge — the end in the tense of the schedule", () => {
  test("a date still to come: the end ahead, in the future tense", () => {
    expect(seriesEndBadge("2027-01-11", null, "2026-10-13", false)).toBe("Ends Jan 11, 2027");
  });

  test("ran out: Ended, on the day it ran out — never the end day still to come", () => {
    expect(seriesEndBadge("2027-01-05", "2026-12-11", "2026-12-12", true)).toBe("Ended Dec 11, 2026");
    // …and the same day after the end has passed: no jump to the end on Jan 6
    expect(seriesEndBadge("2027-01-05", "2026-12-11", "2027-01-20", true)).toBe("Ended Dec 11, 2026");
    // the Nov 11 balance, its end its one day: as it has read since 0af5689
    expect(seriesEndBadge("2026-11-11", "2026-11-11", "2026-11-12", true)).toBe("Ended Nov 11, 2026");
  });

  test("no day it ran out (no date to step from): the end day's own tense", () => {
    expect(seriesEndBadge("2027-01-05", null, "2027-01-06", false)).toBe("Ended Jan 5, 2027");
  });

  /*
   * 🔴 An anchor TYPED past its end (Feb 11 on a Jan 11 end, asked Oct 13): its schedule holds no date, so the card reads
   * "Its schedule has ended", and its rhythm's last day before the end is still ahead, so it ran out on no day yet
   * (`scheduleRanOutOn`). The badge read "Ends Jan 11, 2027" beside the card (review of the late-lapse batch; his ledger
   * copy 2026-10-13, Car insurance's anchor typed Feb 11). Ended — before the end it names, still to come.
   */
  test("its schedule ended, no day it ran out, the end still ahead: 'Ended before', never 'Ends'", () => {
    expect(seriesEndBadge("2027-01-11", null, "2026-10-13", true)).toBe("Ended before Jan 11, 2027");
    // on the end day itself it has not passed either
    expect(seriesEndBadge("2027-01-11", null, "2027-01-11", true)).toBe("Ended before Jan 11, 2027");
  });
});

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): ONE charge reads as one charge — its Annualized slot names that charge, never
 * a year of it. 🔴 The Nov 11 balance's page read "Annualized ~$72.74/yr — the twelve months from today — this one
 * stops on Nov 11, 2026, inside them", and its All-tab row "~$72.74/yr ends Nov 11, 2026", beside "Once" (his ledger
 * copy, 2026-10-13).
 */
describe("annualizedFigure — a year at today's amounts, or its one charge", () => {
  const monthly = { annualizedCents: 71516, oneChargeOn: null, nextExpectedAmountCents: -35758 };
  const once = { annualizedCents: 7274, oneChargeOn: "2026-11-11", nextExpectedAmountCents: -7274 };

  test("a schedule that repeats: ~ and /yr around its year", () => {
    expect(annualizedFigure(monthly)).toEqual({ lead: "~", cents: 71516, tail: "/yr", once: false });
  });

  test("one charge: 'once · ' before the charge itself, nothing after", () => {
    expect(annualizedFigure(once)).toEqual({ lead: "once · ", cents: 7274, tail: "", once: true });
  });

  // its one charge more than a year out projects nothing inside the year — the charge is still the charge
  test("one charge past the year ahead: the charge, never $0.00", () => {
    expect(annualizedFigure({ ...once, annualizedCents: 0, oneChargeOn: "2027-11-11" })!.cents).toBe(7274);
  });

  test("no year, no figure: the slot's dash", () => {
    expect(annualizedFigure({ ...monthly, annualizedCents: null })).toBeNull();
    expect(annualizedFigure({ ...once, annualizedCents: null })).toBeNull();
  });
});

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

  /*
   * 🔴 Review of §6A 54 (2026-10-08): the merge's toast named what it filed while attaching — the same rule (§6A 47) —
   * said only "2 attached". Every hand link's toast now ends in the one clause, read from its action's own result.
   */
  test("attaching's toasts name what they filed in the merge's own words — and read as before when nothing was", () => {
    expect(attachedToastTitle({ attached: 3, filed: filing })).toBe("3 attached · 2 filed under Car > Lease");
    expect(attachedToastTitle({ attached: 3, filed: null })).toBe("3 attached");
    expect(filedToastTitle("Attached to Car lease", { filed: { ...filing, count: 1 } })).toBe(
      "Attached to Car lease · 1 filed under Car > Lease",
    );
    expect(filedToastTitle("Attached to Car lease", { filed: null })).toBe("Attached to Car lease");
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

  /*
   * ⚖️ A day read at its NET (decision 75) says so: $1,141.92 in and $500.00 back the same day is one payday at
   * $641.92, and the deposit's own $1,141.92 stands beside it — the words say why.
   */
  test("a day with money back the same day names it", () => {
    expect(perPaydayWord({ paydays: 1, cents: 64192, returns: 1 })).toBe("1 payday at $641.92, net of the day's return");
    expect(perPaydayWord({ paydays: 3, cents: 135589, deposits: 2, returns: 2 })).toBe(
      "3 paydays at $1,355.89 each, with the day's other deposit, net of the day's 2 returns",
    );
  });
});

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): a series whose whole schedule holds one charge reads "Once" in the slot
 * every other series fills with its cadence. 🔴 The Nov 11 car-insurance balance's own page said "Cadence Monthly".
 */
describe("cadenceLabel — a schedule of one charge is not monthly", () => {
  test("a one-charge series reads Once, whatever cadence it is stored with", () => {
    expect(cadenceLabel("monthly", "2026-11-11")).toBe("Once");
    expect(cadenceLabel("weekly", "2026-11-11")).toBe("Once");
  });

  test("every other series reads its cadence", () => {
    expect(cadenceLabel("monthly", null)).toBe("Monthly");
    expect(cadenceLabel("annual", null)).toBe("Annual");
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
