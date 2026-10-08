import { describe, expect, test } from "vitest";
import { addCalendarMonths, addDays } from "./dates";
import { statementCadence, type StatementCadence } from "./statement-cadence";
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
 * The cycle in force is read from the close that opens the hole, so neither
 * case below needs the cadence to remember the old day (see the next block).
 */
describe("a cycle that moved", () => {
  /** Discover's real cadence on 2026-10-08: the 9th since Aug 9, the 2nd on the ten closes before. */
  const CAPITAL_ONE: StatementCadence = {
    rhythm: { kind: "day-of-month", day: 9 },
    toleranceDays: 2,
    closes: 2,
    movedFrom: { day: 2, closes: 10 },
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
      movedFrom: { day: 18, closes: 9 },
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

/*
 * ⛔ A HOLE IS BOUNDED BY TWO CLOSES, and the count is how many cycles sit between them. The close before
 * it (`from − 1`) ends the last statement imported; `to` ends the last one missing, because the next
 * imported period starts the day after it. The walk counts from the first of them on that close's OWN day.
 *
 * 🔴 Found by a second reader on a copy of the owner's ledger, 2026-10-08: the walk started from the day
 * before the hole and stepped on TODAY's day. Once Capital One's closes on the 9th fill Discover's
 * twelve-close window (the May 2027 import), nothing remembers the 2nd: the 2025 hole (Jul 2 → Sep 2)
 * was walked Jul 2 → Aug 9 → Sep 9, past its end, and the Missing-statements line read 4 for 5.
 */
describe("the cycle a hole was on, read from the hole itself", () => {
  /** Every Discover statement period on the real ledger (statement_periods, 2026-10-08 copy), oldest first. */
  const DISCOVER_PERIODS: StatementPeriodRef[] = [
    { start: "2023-10-01", end: "2023-11-18" }, { start: "2023-11-19", end: "2023-12-18" },
    { start: "2023-12-19", end: "2024-01-18" }, { start: "2024-01-19", end: "2024-02-18" },
    { start: "2024-02-19", end: "2024-03-18" }, { start: "2024-03-19", end: "2024-04-18" },
    { start: "2024-04-19", end: "2024-05-18" }, { start: "2024-05-19", end: "2024-06-18" },
    { start: "2024-06-19", end: "2024-07-18" }, { start: "2024-07-19", end: "2024-08-18" },
    { start: "2024-09-19", end: "2024-10-18" }, { start: "2024-11-19", end: "2024-12-18" },
    { start: "2024-12-19", end: "2025-01-18" }, { start: "2025-01-19", end: "2025-02-18" },
    { start: "2025-03-19", end: "2025-05-02" }, { start: "2025-05-03", end: "2025-06-02" },
    { start: "2025-06-03", end: "2025-07-02" }, { start: "2025-09-03", end: "2025-10-02" },
    { start: "2025-10-03", end: "2025-11-02" }, { start: "2025-11-03", end: "2025-12-02" },
    { start: "2025-12-03", end: "2026-01-02" }, { start: "2026-01-03", end: "2026-02-02" },
    { start: "2026-02-03", end: "2026-03-02" }, { start: "2026-03-03", end: "2026-04-02" },
    { start: "2026-04-03", end: "2026-05-02" }, { start: "2026-05-03", end: "2026-06-02" },
    { start: "2026-06-03", end: "2026-07-02" }, { start: "2026-07-03", end: "2026-08-09" },
    { start: "2026-08-10", end: "2026-09-08" },
  ];

  /** The holes as the gaps service finds them: the cadence measured from the same periods' ends. */
  const holesOf = (periods: readonly StatementPeriodRef[]) =>
    statementHoles(periods, statementCadence(periods.map((p) => p.end)));

  test("Discover's four holes are five statements, on every month the Capital One cycle takes the window", () => {
    expect(holesOf(DISCOVER_PERIODS)).toEqual([
      { from: "2024-08-19", to: "2024-09-18", days: 31, closes: 1 },
      { from: "2024-10-19", to: "2024-11-18", days: 31, closes: 1 },
      { from: "2025-02-19", to: "2025-03-18", days: 28, closes: 1 },
      { from: "2025-07-03", to: "2025-09-02", days: 62, closes: 2 },
    ]);
    // the months to come, each closing on the 9th as Capital One's two closes so far do — through May 2027,
    // when its tenth close leaves two on the 2nd in the window, and on past the last of them
    let periods = DISCOVER_PERIODS;
    for (let month = 1; month <= 16; month++) {
      const end = addCalendarMonths("2026-09-09", month);
      periods = [...periods, { start: addDays(periods.at(-1)!.end, 1), end }];
      expect({ end, closes: holesOf(periods).map((h) => h.closes) }).toEqual({ end, closes: [1, 1, 1, 2] });
    }
    // by then the window holds no close on the 2nd at all
    const settled = statementCadence(periods.map((p) => p.end));
    expect(settled.rhythm).toEqual({ kind: "day-of-month", day: 9 });
    expect(settled.movedFrom).toBeUndefined();
  });

  /** Every Chase Checking statement period on the real ledger (2026-10-08 copy): the cycle wanders 10th–13th. */
  const CHASE_CHECKING_PERIODS: StatementPeriodRef[] = [
    { start: "2022-08-25", end: "2022-09-13" }, { start: "2022-09-14", end: "2022-10-13" },
    { start: "2022-10-14", end: "2022-11-10" }, { start: "2022-11-11", end: "2022-12-12" },
    { start: "2022-12-13", end: "2023-01-12" }, { start: "2023-01-13", end: "2023-02-10" },
    { start: "2023-02-11", end: "2023-03-10" }, { start: "2023-03-11", end: "2023-04-12" },
    { start: "2023-04-13", end: "2023-05-10" }, { start: "2023-05-11", end: "2023-06-12" },
    { start: "2023-06-13", end: "2023-07-13" }, { start: "2023-07-14", end: "2023-08-10" },
    { start: "2023-08-11", end: "2023-09-13" }, { start: "2023-09-14", end: "2023-10-12" },
    { start: "2023-10-13", end: "2023-11-10" }, { start: "2023-11-11", end: "2023-12-12" },
    { start: "2023-12-13", end: "2024-01-11" }, { start: "2024-01-12", end: "2024-02-12" },
    { start: "2024-02-13", end: "2024-03-12" }, { start: "2024-03-13", end: "2024-04-10" },
    { start: "2024-04-11", end: "2024-05-10" }, { start: "2024-05-11", end: "2024-06-12" },
    { start: "2024-06-13", end: "2024-07-11" }, { start: "2024-07-12", end: "2024-08-12" },
    { start: "2024-08-13", end: "2024-09-12" }, { start: "2024-09-13", end: "2024-10-10" },
    { start: "2024-10-11", end: "2024-11-13" }, { start: "2024-11-14", end: "2024-12-11" },
    { start: "2024-12-12", end: "2025-01-13" }, { start: "2025-01-14", end: "2025-02-12" },
    { start: "2025-02-13", end: "2025-03-12" }, { start: "2025-03-13", end: "2025-04-10" },
    { start: "2025-04-11", end: "2025-05-12" }, { start: "2025-05-13", end: "2025-06-11" },
    { start: "2025-06-12", end: "2025-07-11" }, { start: "2025-07-12", end: "2025-08-12" },
    { start: "2025-08-13", end: "2025-09-11" }, { start: "2025-09-12", end: "2025-10-10" },
    { start: "2025-10-11", end: "2025-11-13" }, { start: "2025-11-14", end: "2025-12-10" },
    { start: "2025-12-11", end: "2026-01-13" }, { start: "2026-01-14", end: "2026-02-11" },
    { start: "2026-02-12", end: "2026-03-11" }, { start: "2026-03-12", end: "2026-04-10" },
    { start: "2026-04-11", end: "2026-05-12" }, { start: "2026-05-13", end: "2026-06-10" },
    { start: "2026-06-11", end: "2026-07-10" }, { start: "2026-07-11", end: "2026-08-12" },
  ];

  /*
   * ⚠️ Why the walk does not simply count the rhythm's days inside the window: on a cycle that wanders, a
   * close that landed EARLY opens a hole before the rhythm's own day that month, and that day belongs to the
   * close already imported. Chase Checking's Dec 11 → Jan 13 statement is one statement, and the 11th falls
   * inside it twice. The far end wanders too: its Nov 14 → Dec 10 statement ends the day before the 11th,
   * so a walk that must land on or before `to` exactly finds nothing in it.
   */
  test("on a cycle that wanders, one missing statement is one and two are two — wherever they fall", () => {
    expect(CHASE_CHECKING_PERIODS).toHaveLength(48);
    for (let i = 1; i < CHASE_CHECKING_PERIODS.length - 1; i++) {
      const missing = CHASE_CHECKING_PERIODS[i]!;
      const one = holesOf(CHASE_CHECKING_PERIODS.filter((_, j) => j !== i)).map((h) => h.closes);
      expect({ missing, one }).toEqual({ missing, one: [1] });
      if (i + 1 === CHASE_CHECKING_PERIODS.length - 1) continue;
      const two = holesOf(CHASE_CHECKING_PERIODS.filter((_, j) => j !== i && j !== i + 1)).map((h) => h.closes);
      expect({ missing, two }).toEqual({ missing, two: [2] });
    }
  });
});
