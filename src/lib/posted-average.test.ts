import { describe, expect, test } from "vitest";
import { paydayReadings } from "./per-payday";
import { postedAverage } from "./posted-average";
import type { RateSchedule } from "./series-kind";

const WEEK = 114_192;
const CASH = 104_700;
/** a series whose rate has never changed */
const FLAT: RateSchedule = { nextExpectedAmountCents: WEEK, amountHistory: null };
/** his series once its history is set (§6A 55): the cash weeks through Aug 26 at $1,047.00 */
const HIS: RateSchedule = {
  nextExpectedAmountCents: WEEK,
  amountHistory: [{ throughOn: "2026-08-26", amountCents: CASH }],
};

/** His four deposits, as he linked them. */
const HIS_ROWS = [
  { id: "jun4", postedOn: "2026-06-04", amountCents: CASH },
  { id: "jun5", postedOn: "2026-06-05", amountCents: 40_000 },
  { id: "lump", postedOn: "2026-09-23", amountCents: WEEK * 4 },
  { id: "sep24", postedOn: "2026-09-24", amountCents: WEEK },
];
/** …as settlement spends them over the paydays his ledger draws today (from Jul 23): June's money pays nothing. */
const HIS_PORTIONS = [
  ...["2026-09-24", "2026-09-17", "2026-09-10", "2026-09-03"].map((paydayOn) => ({
    paydayOn,
    depositOn: "2026-09-23",
    cents: WEEK,
  })),
  { paydayOn: "2026-08-27", depositOn: "2026-09-24", cents: WEEK },
];

describe("postedAverage — a series not read per payday", () => {
  /* rent's five charges on a copy of his ledger, 2026-10-08: the mean and the sample spread of the rows as posted */
  test("is the rows' own mean and sample spread", () => {
    const rows = (
      [
        ["2026-06-16", -110_000],
        ["2026-06-16", -133_480],
        ["2026-07-08", -228_570],
        ["2026-08-04", -223_711],
        ["2026-09-02", -229_121],
      ] as const
    ).map(([postedOn, amountCents], i) => ({ id: `r${i}`, postedOn, amountCents }));
    expect(postedAverage(rows, null, FLAT)).toEqual({ avgCents: -184_976, stddevCents: 58_358 });
  });

  test("names no average with nothing linked, and no spread under two rows", () => {
    expect(postedAverage([], null, FLAT)).toEqual({ avgCents: null, stddevCents: null });
    expect(postedAverage([{ id: "a", postedOn: "2025-06-02", amountCents: -183_527 }], null, FLAT)).toEqual({
      avgCents: -183_527,
      stddevCents: null,
    });
  });
});

/**
 * ⚖️ A pay series averages what a PAYDAY paid, at the rate in force now (§6A 55). 🔴 Read raw, his four deposits
 * averaged $1,789.15 ± $1,881.46 — an amount no payday ever paid, under a headline of $1,141.92.
 */
describe("postedAverage — his pay, read per payday", () => {
  test("his ledger with its history set: the lump is one week, June paid no payday — $1,141.92, no spread", () => {
    const readings = paydayReadings(HIS_ROWS, HIS_PORTIONS, HIS);
    expect(postedAverage(HIS_ROWS, readings, HIS)).toEqual({ avgCents: WEEK, stddevCents: 0 });
  });

  test("his ledger as it stands, before the history is written — the same reading", () => {
    const readings = paydayReadings(HIS_ROWS, HIS_PORTIONS, FLAT);
    expect(postedAverage(HIS_ROWS, readings, FLAT)).toEqual({ avgCents: WEEK, stddevCents: 0 });
  });

  /* ⛔ Only the rate era in force now: Jun 4's cash week, paid in full at $1,047.00, is no sample of a payroll week. */
  test("a payday of an earlier rate era is not averaged with today's", () => {
    const portions = [...HIS_PORTIONS, { paydayOn: "2026-06-04", depositOn: "2026-06-04", cents: CASH }];
    const readings = paydayReadings(HIS_ROWS, portions, HIS);
    expect(readings.get("jun4")?.isPaydaySample).toBe(true);
    expect(postedAverage(HIS_ROWS, readings, HIS)).toEqual({ avgCents: WEEK, stddevCents: 0 });
    // with no history there is one era, and the cash week is a sample of it
    const flat = paydayReadings(HIS_ROWS, portions, FLAT);
    expect(postedAverage(HIS_ROWS, flat, FLAT).avgCents).toBe(Math.round((CASH + WEEK + WEEK) / 3));
  });

  /* Wed Aug 26's deposit paid Thu Aug 27, the first payroll week: it is held — and averaged — in the payroll era. */
  test("a deposit belongs to the era of the payday it paid, not of its own date", () => {
    const rows = [
      { id: "wed", postedOn: "2026-08-26", amountCents: 115_000 },
      { id: "sep3", postedOn: "2026-09-03", amountCents: WEEK },
    ];
    const portions = [
      { paydayOn: "2026-08-27", depositOn: "2026-08-26", cents: 115_000 },
      { paydayOn: "2026-09-03", depositOn: "2026-09-03", cents: WEEK },
    ];
    const readings = paydayReadings(rows, portions, HIS);
    expect(postedAverage(rows, readings, HIS).avgCents).toBe(Math.round((115_000 + WEEK) / 2));
  });

  /* A third weekly deposit and a $1,200.00 week: the samples are the lump, Sep 24, Oct 1 and Oct 8. */
  test("a raise is averaged with the weeks it follows, and spreads them", () => {
    const rows = [
      ...HIS_ROWS,
      { id: "oct1", postedOn: "2026-10-01", amountCents: WEEK },
      { id: "oct8", postedOn: "2026-10-08", amountCents: 120_000 },
    ];
    const portions = [
      ...HIS_PORTIONS,
      { paydayOn: "2026-10-01", depositOn: "2026-10-01", cents: WEEK },
      { paydayOn: "2026-10-08", depositOn: "2026-10-08", cents: 120_000 },
    ];
    expect(postedAverage(rows, paydayReadings(rows, portions, HIS), HIS)).toEqual({
      avgCents: 115_644,
      stddevCents: 2_904,
    });
  });

  /* a row the reading does not cover is held on its own day, as `expectedCentsOf` holds it */
  test("a row with no reading is averaged in its own day's era", () => {
    const rows = [HIS_ROWS[0]!, HIS_ROWS[3]!];
    expect(postedAverage(rows, new Map(), HIS)).toEqual({ avgCents: WEEK, stddevCents: null });
  });

  test("a pay series with no payday paid names no average", () => {
    const rows = HIS_ROWS.slice(0, 2);
    expect(postedAverage(rows, paydayReadings(rows, [], HIS), HIS)).toEqual({ avgCents: null, stddevCents: null });
  });
});
