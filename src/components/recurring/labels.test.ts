import { describe, expect, test } from "vitest";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";
import {
  shortAgo,
  staleComponentEntries,
  staleLabel,
  staleOccurrenceEntries,
  stalenessSentence,
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
