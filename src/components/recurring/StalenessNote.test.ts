import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { SeriesStaleness } from "@/services/recurring";
import { StaleFooter, StaleMark } from "./StalenessNote";

const late: SeriesStaleness = {
  lastMatchedOn: "2026-07-05",
  daysSinceLastMatch: 72,
  stepDays: 30,
  toleranceDays: 48,
  isStale: true,
  awaitingStatements: false,
};
const never: SeriesStaleness = {
  lastMatchedOn: null,
  daysSinceLastMatch: null,
  stepDays: 30,
  toleranceDays: 48,
  isStale: true,
  awaitingStatements: false,
};

/**
 * 🔴 The Upcoming list and the forecast's math table badged Car lease, Gym and
 * Rent utilities & fees "never seen" in WARNING tone — measured on the real
 * ledger 2026-09-15 — on a page whose calendar tab calls the same three "never
 * billed" in a neutral badge, with the comment "not a warning: nothing is late
 * about a bill the bank has not charged yet". One page, two words and two
 * tones for one fact.
 */
describe("StaleMark", () => {
  test("a never-billed series reads never billed, and is not a warning", () => {
    const html = renderToStaticMarkup(createElement(StaleMark, { staleness: never }));
    expect(html).toContain(">never billed<");
    expect(html).not.toContain("never seen");
    expect(html).not.toContain("text-warning");
  });

  test("a late series keeps its age and its warning", () => {
    const html = renderToStaticMarkup(createElement(StaleMark, { staleness: late }));
    expect(html).toContain(">last seen 72d ago<");
    expect(html).toContain("text-warning");
  });
});

describe("StaleFooter", () => {
  test("series with no evidence are not said to rest on old evidence", () => {
    const html = renderToStaticMarkup(
      createElement(StaleFooter, {
        window: "In the next 30 days",
        entries: [
          { key: "a", name: "Car lease", staleness: never },
          { key: "b", name: "Gym", staleness: never },
        ],
      }),
    );
    expect(html).not.toContain("old evidence");
    expect(html).toContain("the schedule alone");
    expect(html).not.toContain("text-warning");
  });

  test("the owner's mix names both, and stays a warning", () => {
    const html = renderToStaticMarkup(
      createElement(StaleFooter, {
        window: "In the next 30 days",
        entries: [
          { key: "a", name: "Amazon Prime", staleness: late },
          { key: "b", name: "Car lease", staleness: never },
        ],
      }),
    );
    expect(html).toContain("why these numbers rest on old evidence or on the schedule alone");
    expect(html).toContain("text-warning");
  });

  /* 🔴 The summary read "…and 3 have never charged" over the rows this footer
     lists as "never billed" (real ledger, 2026-09-15). One card, one verb. */
  test("the summary over the list says never billed, not never charged", () => {
    const html = renderToStaticMarkup(
      createElement(StaleFooter, {
        window: "In the next 30 days",
        entries: [
          { key: "a", name: "Amazon Prime", staleness: late },
          { key: "b", name: "Car lease", staleness: never },
          { key: "c", name: "Gym", staleness: never },
        ],
      }),
    );
    expect(html).toContain("In the next 30 days, 1 series is running late and 2 have never been billed — all still projected");
    expect(html).not.toContain("never charged");
  });
});

/**
 * 🔴 His ledger 2026-10-08: "It America LLC (weekly pay) … last seen 14d ago" in an amber badge, counted in "4 series
 * are running late", for a payday on a day Wells Fargo had not been checked through. The age stays; the warning goes.
 */
describe("awaiting statements", () => {
  const unread: SeriesStaleness = {
    lastMatchedOn: "2026-09-24",
    daysSinceLastMatch: 14,
    stepDays: 7,
    toleranceDays: 12.5,
    isStale: false,
    checkedThrough: "2026-09-24",
    awaitingStatements: true,
  };

  test("the chip keeps the fact, never the warning", () => {
    const html = renderToStaticMarkup(createElement(StaleMark, { staleness: unread }));
    expect(html).toContain(">last seen 14d ago<");
    expect(html).not.toContain("text-warning");
  });

  test("the footer names it without calling it late", () => {
    const html = renderToStaticMarkup(
      createElement(StaleFooter, {
        window: "In October 2026",
        entries: [{ key: "p", name: "It America LLC (weekly pay)", staleness: unread }],
      }),
    );
    expect(html).toContain("In October 2026, 1 series is awaiting statements — still projected");
    expect(html).toContain("Sep 24, 2026 is the last day every account it posts to has been checked through");
    expect(html).toContain("why these cannot be called late yet");
    expect(html).not.toContain("running late");
    expect(html).not.toContain("text-warning");
  });
});
