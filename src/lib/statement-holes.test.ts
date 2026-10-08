import { describe, expect, test } from "vitest";
import type { StatementCadence } from "./statement-cadence";
import { MAX_CLOSES_PER_HOLE, statementHoles, type StatementPeriodRef } from "./statement-holes";

const monthly = (day: number): StatementCadence => ({
  rhythm: { kind: "day-of-month", day },
  toleranceDays: 1,
  closes: 12,
});
const unknown: StatementCadence = { rhythm: { kind: "unknown" }, toleranceDays: 1, closes: 1 };

/** Discover's real shape: periods that abut, with one whole cycle absent. */
const DISCOVER: StatementPeriodRef[] = [
  { start: "2024-06-19", end: "2024-07-18" },
  { start: "2024-07-19", end: "2024-08-18" },
  // 2024-08-19 → 2024-09-18 never imported
  { start: "2024-09-19", end: "2024-10-18" },
  { start: "2024-10-19", end: "2024-11-18" },
];

describe("what abuts, and what does not", () => {
  test("⚠️ periods that abut are NOT a hole", () => {
    // `next.start === prev.end + 1` is how this app's importers write them;
    // testing `next.start > prev.end` would report a hole between every pair
    expect(
      statementHoles(
        [
          { start: "2024-06-19", end: "2024-07-18" },
          { start: "2024-07-19", end: "2024-08-18" },
        ],
        monthly(18),
      ),
    ).toEqual([]);
  });

  test("a missing cycle is one hole, named by its exact window", () => {
    expect(statementHoles(DISCOVER, monthly(18))).toEqual([
      { from: "2024-08-19", to: "2024-09-18", days: 31, closes: 1 },
    ]);
  });

  test("a longer hole counts the closes the account's own rhythm puts in it", () => {
    // 2025-07-03 → 2025-09-02 on a monthly rhythm is TWO statements, and only
    // the rhythm knows that — dividing 62 days by an assumed month is a guess
    const holes = statementHoles(
      [
        { start: "2025-06-03", end: "2025-07-02" },
        { start: "2025-09-03", end: "2025-10-02" },
      ],
      monthly(2),
    );
    expect(holes).toEqual([{ from: "2025-07-03", to: "2025-09-02", days: 62, closes: 2 }]);
  });

  test("an unknown rhythm reports the window and refuses to count", () => {
    // a count from a flat 30-day assumption is a number nobody measured
    const holes = statementHoles(
      [
        { start: "2024-01-01", end: "2024-01-31" },
        { start: "2024-04-01", end: "2024-04-30" },
      ],
      unknown,
    );
    expect(holes).toEqual([{ from: "2024-02-01", to: "2024-03-31", days: 60, closes: null }]);
  });

  test("several holes are reported in order", () => {
    const holes = statementHoles(
      [
        { start: "2024-01-19", end: "2024-02-18" },
        { start: "2024-04-19", end: "2024-05-18" },
        { start: "2024-08-19", end: "2024-09-18" },
      ],
      monthly(18),
    );
    expect(holes.map((h) => h.from)).toEqual(["2024-02-19", "2024-05-19"]);
  });
});

describe("what it refuses to call a hole", () => {
  test("one period alone has no holes", () => {
    expect(statementHoles([{ start: "2024-01-01", end: "2024-01-31" }], monthly(31))).toEqual([]);
  });

  test("no periods at all is silence, not a hole covering all of time", () => {
    expect(statementHoles([], monthly(1))).toEqual([]);
  });

  test("⛔ an overlapping period cannot manufacture a hole behind itself", () => {
    /*
     * The frontier only moves forward. A nested period — 2024-02-01→02-10
     * inside 2024-01-01→03-31 — would otherwise pull `covered` back to Feb 10
     * and report March as missing when it is fully covered.
     */
    expect(
      statementHoles(
        [
          { start: "2024-01-01", end: "2024-03-31" },
          { start: "2024-02-01", end: "2024-02-10" },
          { start: "2024-04-01", end: "2024-04-30" },
        ],
        monthly(31),
      ),
    ).toEqual([]);
  });

  test("two periods sharing a start day are ordered by their end", () => {
    // a re-import can produce a corrected period beside the original; the
    // shorter one must not set the frontier and open a hole behind the longer
    expect(
      statementHoles(
        [
          { start: "2024-01-01", end: "2024-03-31" },
          { start: "2024-01-01", end: "2024-01-31" },
          { start: "2024-04-01", end: "2024-04-30" },
        ],
        monthly(31),
      ),
    ).toEqual([]);
  });

  test("periods given out of order are sorted before the walk", () => {
    const holes = statementHoles(
      [
        { start: "2024-04-19", end: "2024-05-18" },
        { start: "2024-01-19", end: "2024-02-18" },
      ],
      monthly(18),
    );
    // 2024 is a leap year: Feb 19–29 is 11 days, not 10
    expect(holes).toEqual([{ from: "2024-02-19", to: "2024-04-18", days: 60, closes: 2 }]);
  });
});

describe("the loop bound", () => {
  test("a pathological rhythm cannot spin over a four-year hole", () => {
    // `statementCadence` can return every-n-days: 1 from degenerate data, and
    // a four-year hole would then walk about 1,400 times
    const daily: StatementCadence = { rhythm: { kind: "every-n-days", days: 1 }, toleranceDays: 1, closes: 12 };
    const holes = statementHoles(
      [
        { start: "2020-01-01", end: "2020-01-31" },
        { start: "2024-01-01", end: "2024-01-31" },
      ],
      daily,
    );
    expect(holes[0]!.closes).toBe(MAX_CLOSES_PER_HOLE);
    // the day count is still exactly true, whatever the close count was capped to
    expect(holes[0]!.days).toBe(1430);
  });
});

/*
 * ⛔ A HOLE IS COUNTED ON THE CYCLE IN FORCE WHEN IT HAPPENED. Once the newest
 * closes move the rhythm (`statementCadence`'s moved-cycle rule), the rhythm
 * describes the closes since the move — and walking it through an older hole
 * counts the wrong days.
 *
 * 🔴 Measured on a copy of the owner's ledger on 2026-10-08: Discover's 2025 hole
 * (Aug 2 and Sep 2 never imported) walked on the Capital One 9th counted only
 * Aug 9, and /imports' Missing-statements line dropped from 5 statements to 4.
 */
describe("a cycle that moved", () => {
  /** Discover's real cadence on 2026-10-08: the 9th since Aug 9, the 2nd on the ten closes before. */
  const CAPITAL_ONE: StatementCadence = {
    rhythm: { kind: "day-of-month", day: 9 },
    toleranceDays: 2,
    closes: 2,
    movedFrom: { day: 2, closes: 10, since: "2026-08-09" },
  };

  test("a hole from before the move is counted on the old cycle", () => {
    const holes = statementHoles(
      [
        { start: "2025-06-03", end: "2025-07-02" },
        { start: "2025-09-03", end: "2025-10-02" },
      ],
      CAPITAL_ONE,
    );
    expect(holes).toEqual([{ from: "2025-07-03", to: "2025-09-02", days: 62, closes: 2 }]);
  });

  test("a hole after the move is counted on the new cycle", () => {
    // Discover's earlier move, the 18th to the 2nd in 2025: walked on the 18th,
    // the same 2025 hole would count Aug 18 alone
    const moved: StatementCadence = {
      rhythm: { kind: "day-of-month", day: 2 },
      toleranceDays: 1,
      closes: 3,
      movedFrom: { day: 18, closes: 9, since: "2025-05-02" },
    };
    const holes = statementHoles(
      [
        { start: "2025-06-03", end: "2025-07-02" },
        { start: "2025-09-03", end: "2025-10-02" },
      ],
      moved,
    );
    expect(holes).toEqual([{ from: "2025-07-03", to: "2025-09-02", days: 62, closes: 2 }]);
  });
});
