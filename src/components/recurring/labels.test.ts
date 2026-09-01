import { describe, expect, test } from "vitest";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";
import {
  shortAgo,
  staleComponentEntries,
  staleLabel,
  staleOccurrenceEntries,
  stalenessSentence,
  stalePartLabel,
  staleSummaryLabel,
  type StaleEntry,
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
    expect(staleSummaryLabel([late(88), late(58), late(53), never(1), never(2), never(3), never(4)])).toBe(
      "3 series are running late and 4 have never charged — all still projected",
    );
  });

  test("only late reads as it always did", () => {
    expect(staleSummaryLabel([late(88), late(58)])).toBe("2 series are running late — still projected");
    expect(staleSummaryLabel([late(88)])).toBe("1 series is running late — still projected");
  });

  test("only never-charged does not claim anything is late", () => {
    expect(staleSummaryLabel([never(1), never(2)])).toBe("2 series have never charged — still projected");
    expect(staleSummaryLabel([never(1)])).toBe("1 series has never charged — still projected");
    expect(staleSummaryLabel([never(1)])).not.toContain("late");
  });

  test("one of each still says one of each", () => {
    expect(staleSummaryLabel([late(88), never(1)])).toBe(
      "1 series is running late and 1 has never charged — all still projected",
    );
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
