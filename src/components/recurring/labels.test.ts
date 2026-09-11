import { describe, expect, test } from "vitest";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";
import {
  annualizedCaveat,
  shortAgo,
  staleComponentEntries,
  staleLabel,
  staleOccurrenceEntries,
  stalenessSentence,
  stalePartLabel,
  staleSummaryLabel,
  type StaleEntry,
  overdueNote,
  postedSpreadReading,
  seriesVerb,
  futureDateLabel,
} from "./labels";

const staleness = (over: Partial<SeriesStaleness> = {}): SeriesStaleness => ({
  lastMatchedOn: "2026-06-16",
  daysSinceLastMatch: 22,
  stepDays: 7,
  toleranceDays: 12.5,
  isStale: true,
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

  test("a series nothing ever matched says so rather than inventing a date", () => {
    expect(staleLabel(staleness({ lastMatchedOn: null, daysSinceLastMatch: null }))).toBe("never seen");
  });
});

describe("stalenessSentence", () => {
  test("names the cadence, the last match, the gap, and the tolerance it passed", () => {
    const sentence = stalenessSentence(staleness());
    expect(sentence).toContain("every 7 days");
    expect(sentence).toContain("Jun 16, 2026");
    expect(sentence).toContain("22 days");
    expect(sentence).toContain("13-day tolerance"); // 12.5 rounds for display
    expect(sentence).toContain("Still projected");
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
    staleness: { lastMatchedOn: "2026-06-05", daysSinceLastMatch: days, stepDays: 7, toleranceDays: 14, isStale: true },
  });
  const never = (n: number): StaleEntry => ({
    key: `never-${n}`,
    name: `Never ${n}`,
    staleness: { lastMatchedOn: null, daysSinceLastMatch: null, stepDays: 30, toleranceDays: 48, isStale: true },
  });

  test("the real ledger's mix names both, and neither count is the other's", () => {
    expect(staleSummaryLabel([late(88), late(58), late(53), never(1), never(2), never(3), never(4)], "In September")).toBe(
      "In September, 3 series are running late and 4 have never charged — all still projected",
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
      "In September, 2 series have never charged — still projected");
    expect(staleSummaryLabel([never(1)], "In September")).toBe(
      "In September, 1 series has never charged — still projected");
    expect(staleSummaryLabel([never(1)], "In September")).not.toContain("late");
  });

  test("one of each still says one of each", () => {
    expect(staleSummaryLabel([late(88), never(1)], "In September")).toBe(
      "In September, 1 series is running late and 1 has never charged — all still projected",
    );
  });

  /**
   * 🔴 THE DEFECT THIS ARGUMENT EXISTS FOR. `/recurring` renders this sentence
   * twice — once over the September forecast, once under the 30-day list — and
   * on 2026-09-02 they read "…3 have never charged" and "…4 have never charged"
   * a screen apart, in identical words. Both were true: `Rent utilities & fees`
   * first falls due on 1 October, inside thirty days and outside September.
   *
   * ⛔ The window LEADS the sentence. Trailing it — "…3 have never charged in
   * September" — would say they had never charged IN SEPTEMBER, a different and
   * weaker claim than the true one.
   */
  test("the same counts over two windows are two different sentences", () => {
    const september = staleSummaryLabel([late(88), never(1)], "In September");
    const thirtyDays = staleSummaryLabel([late(88), never(1), never(2)], "In the next 30 days");
    expect(september).toBe("In September, 1 series is running late and 1 has never charged — all still projected");
    expect(thirtyDays).toBe(
      "In the next 30 days, 1 series is running late and 2 have never charged — all still projected",
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

  test("the year's far end is EXCLUSIVE — a series ending on it runs the whole year", () => {
    expect(annualizedCaveat("2027-09-11", TODAY)).toBeNull();
    expect(annualizedCaveat("2027-09-10", TODAY)).not.toBeNull();
  });

  test("a series that has ALREADY stopped is still qualified, not silently excused", () => {
    expect(annualizedCaveat("2026-08-01", TODAY)).toBe(
      "the twelve months from today — this one stops on Aug 1, 2026, inside them",
    );
  });
});
