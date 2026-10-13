import { describe, expect, test } from "vitest";
import { paydayReadings, type PaydayReading } from "./per-payday";
import {
  atTodaysRate,
  nettedToNothing,
  occurrencesOf,
  perPaydayEvidence,
  postedAsWord,
  postedAverage,
  readsPerOccurrence,
} from "./posted-average";
import type { RateSchedule } from "./series-kind";

/** the day the rate in force is read on — his ledger copy's, 2026-10-12 */
const TODAY = "2026-10-12";
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

const payday = (readings: ReadonlyMap<string, PaydayReading>) => ({ per: "payday", readings }) as const;
const PER_OCCURRENCE = { per: "occurrence" } as const;
const AS_POSTED = { per: "row" } as const;
const rowsOf = (pairs: readonly (readonly [string, number])[]) =>
  pairs.map(([postedOn, amountCents], i) => ({ id: `r${i}`, postedOn, amountCents }));

/** rent's five rows on a copy of his ledger, 2026-10-12: Jun 16's two are ONE payment the card posted as two */
const RENT_ROWS = rowsOf([
  ["2026-06-16", -110_000],
  ["2026-06-16", -133_480],
  ["2026-07-08", -228_570],
  ["2026-08-04", -223_711],
  ["2026-09-02", -229_121],
]);

/**
 * A series with a schedule averages what each OCCURRENCE was paid: a day's rows are one payment, one sample. 🔴 Read
 * row by row, his rent averaged -$1,849.76 ± $583.58 under "-$2,109.00" though every month he paid more.
 */
describe("postedAverage — a series read per occurrence", () => {
  test("his rent: Jun 16's two rows are one payment — -$2,312.20 ± $85.27 over four", () => {
    expect(postedAverage(RENT_ROWS, PER_OCCURRENCE, FLAT, TODAY)).toEqual({ avgCents: -231_220, stddevCents: 8_527 });
  });

  /* Car insurance: Aug 12's $357.58 and Sep 3's $1,000.00 early payment are an occurrence each */
  test("rows that are each one occurrence read exactly as they posted", () => {
    const car = rowsOf([
      ["2026-08-12", -35_758],
      ["2026-09-03", -100_000],
    ]);
    expect(postedAverage(car, PER_OCCURRENCE, FLAT, TODAY)).toEqual(postedAverage(car, AS_POSTED, FLAT, TODAY));
    expect(postedAverage(car, PER_OCCURRENCE, FLAT, TODAY)).toEqual({ avgCents: -67_879, stddevCents: 45_426 });
  });

  /* ⛔ a payment is a day's rows: a day later is the next payment, however near — no window the rows can chain across */
  test("the next day's row is another payment", () => {
    const rows = rowsOf([
      ["2026-06-16", -110_000],
      ["2026-06-17", -133_480],
    ]);
    expect(postedAverage(rows, PER_OCCURRENCE, FLAT, TODAY).avgCents).toBe(Math.round((-110_000 - 133_480) / 2));
  });

  test("one payment of two rows is one sample: no spread", () => {
    expect(postedAverage(RENT_ROWS.slice(0, 2), PER_OCCURRENCE, FLAT, TODAY)).toEqual({
      avgCents: -243_480,
      stddevCents: null,
    });
  });
});

/**
 * ⚖️ Owner decision 2026-10-12 (§6A 63): a bill or subscription with a rate history averages ONLY the payments made at
 * the rate in force now, as his pay does (§6A 55) — a dated rate change is not a change in what a payment pays. Latent
 * on his ledger, where only his pay has a history: the rent's increase here is hypothetical, -$2,000.00 through Jul 31.
 */
describe("postedAverage — a series read per occurrence, with a rate history", () => {
  /** the rent as if raised Aug 1, 2026: Jun 16's and Jul 8's payments were at the rate before */
  const RAISED_AUG_1: RateSchedule = {
    nextExpectedAmountCents: -210_900,
    amountHistory: [{ throughOn: "2026-07-31", amountCents: -200_000 }],
  };

  test("payments either side of the change: only Aug 4's and Sep 2's are averaged — -$2,264.16 ± $38.25", () => {
    expect(postedAverage(RENT_ROWS, PER_OCCURRENCE, RAISED_AUG_1, TODAY)).toEqual({
      avgCents: -226_416,
      stddevCents: 3_825,
    });
    expect(atTodaysRate(occurrencesOf(RENT_ROWS), RAISED_AUG_1, TODAY).map((o) => o.postedOn)).toEqual([
      "2026-08-04",
      "2026-09-02",
    ]);
  });

  /* ⛔ never the old rate's average in its place: no payment at the rate in force now is no posted average */
  test("only old-rate payments: no average at all", () => {
    const raisedOct1 = { ...RAISED_AUG_1, amountHistory: [{ throughOn: "2026-09-30", amountCents: -200_000 }] };
    expect(postedAverage(RENT_ROWS, PER_OCCURRENCE, raisedOct1, TODAY)).toEqual({ avgCents: null, stddevCents: null });
    expect(atTodaysRate(occurrencesOf(RENT_ROWS), raisedOct1, TODAY)).toEqual([]);
  });

  test("a history that ends before the first payment, or none, reads every payment", () => {
    const raisedLongAgo = { ...RAISED_AUG_1, amountHistory: [{ throughOn: "2025-12-31", amountCents: -200_000 }] };
    for (const schedule of [raisedLongAgo, FLAT]) {
      expect(postedAverage(RENT_ROWS, PER_OCCURRENCE, schedule, TODAY)).toEqual({
        avgCents: -231_220,
        stddevCents: 8_527,
      });
      expect(atTodaysRate(occurrencesOf(RENT_ROWS), schedule, TODAY)).toEqual(occurrencesOf(RENT_ROWS));
    }
  });

  /* the payday rule's own era test, on a payment's one day: the day a period runs through is still that period's */
  test("a payment ON the last day of the old rate is the old rate's", () => {
    const raisedAug5 = { ...RAISED_AUG_1, amountHistory: [{ throughOn: "2026-08-04", amountCents: -200_000 }] };
    expect(atTodaysRate(occurrencesOf(RENT_ROWS), raisedAug5, TODAY).map((o) => o.postedOn)).toEqual(["2026-09-02"]);
  });

  /*
   * …and the boundary's other end: a payment ON the first day of the new rate is the new rate's. 🔴 Untested, a filter
   * that dropped it passed all 217 tests of this rule (review of a64b99a, 2026-10-12).
   */
  test("a payment ON the first day of the new rate is the new rate's", () => {
    const raisedAug4 = { ...RAISED_AUG_1, amountHistory: [{ throughOn: "2026-08-03", amountCents: -200_000 }] };
    expect(atTodaysRate(occurrencesOf(RENT_ROWS), raisedAug4, TODAY).map((o) => o.postedOn)).toEqual([
      "2026-08-04",
      "2026-09-02",
    ]);
    expect(postedAverage(RENT_ROWS, PER_OCCURRENCE, raisedAug4, TODAY)).toEqual({
      avgCents: -226_416,
      stddevCents: 3_825,
    });
  });

  /*
   * ⚖️ "the rate in force NOW" (§6A 63) is the rate of today's era, not the last one recorded: an increase recorded
   * before its first day — -$2,300.00 from Nov 1, -$2,109.00 through Oct 31 — is not in force on Oct 12, and every
   * payment so far was made at the rate that is. 🔴 Held to the last era recorded, the rent read NO posted average on
   * Oct 12, on a copy of his ledger with that history (review of 442de07, 2026-10-12).
   */
  test("a rate change recorded before its first day: every payment at today's rate is still averaged", () => {
    const raisedNov1 = {
      nextExpectedAmountCents: -230_000,
      amountHistory: [{ throughOn: "2026-10-31", amountCents: -210_900 }],
    };
    expect(postedAverage(RENT_ROWS, PER_OCCURRENCE, raisedNov1, TODAY)).toEqual({
      avgCents: -231_220,
      stddevCents: 8_527,
    });
    expect(atTodaysRate(occurrencesOf(RENT_ROWS), raisedNov1, TODAY)).toEqual(occurrencesOf(RENT_ROWS));
    // …and from Nov 1, those four are the earlier rate's
    expect(atTodaysRate(occurrencesOf(RENT_ROWS), raisedNov1, "2026-11-01")).toEqual([]);
    // with a period before the one in force today too, the era in force is the middle one
    const twice = {
      ...raisedNov1,
      amountHistory: [{ throughOn: "2026-07-31", amountCents: -200_000 }, ...raisedNov1.amountHistory],
    };
    expect(atTodaysRate(occurrencesOf(RENT_ROWS), twice, TODAY).map((o) => o.postedOn)).toEqual([
      "2026-08-04",
      "2026-09-02",
    ]);
  });

  /* ⛔ the pay rule is its own (§6A 55), and as posted is as posted: neither reading is narrowed here */
  test("a series read as it posted keeps every row, whatever its history", () => {
    expect(postedAverage(RENT_ROWS, AS_POSTED, RAISED_AUG_1, TODAY)).toEqual(
      postedAverage(RENT_ROWS, AS_POSTED, FLAT, TODAY),
    );
  });
});

describe("postedAverage — a series read as it posted", () => {
  test("is the rows' own mean and sample spread", () => {
    expect(postedAverage(RENT_ROWS, AS_POSTED, FLAT, TODAY)).toEqual({ avgCents: -184_976, stddevCents: 58_358 });
  });

  test("names no average with nothing linked, and no spread under two rows", () => {
    for (const reading of [AS_POSTED, PER_OCCURRENCE]) {
      expect(postedAverage([], reading, FLAT, TODAY)).toEqual({ avgCents: null, stddevCents: null });
      const one = [{ id: "a", postedOn: "2025-06-02", amountCents: -183_527 }];
      expect(postedAverage(one, reading, FLAT, TODAY)).toEqual({
        avgCents: -183_527,
        stddevCents: null,
      });
    }
  });
});

/**
 * What each payment paid — the samples of the average, and what the popover counts and the Amount history draws beside
 * it (`occurrencesOf`), so none of the three can count a payment another does not.
 */
describe("occurrencesOf — a day's rows are one payment", () => {
  test("his rent: four payments oldest first, Jun 16's of two rows", () => {
    expect(occurrencesOf([...RENT_ROWS].reverse())).toEqual([
      { postedOn: "2026-06-16", amountCents: -243_480, postings: 2 },
      { postedOn: "2026-07-08", amountCents: -228_570, postings: 1 },
      { postedOn: "2026-08-04", amountCents: -223_711, postings: 1 },
      { postedOn: "2026-09-02", amountCents: -229_121, postings: 1 },
    ]);
  });

  test("a payment posted as several says so; one posted whole says nothing", () => {
    expect(occurrencesOf(RENT_ROWS).map(postedAsWord)).toEqual(["posted as 2", null, null, null]);
  });
});

/**
 * ⛔ A day whose rows net to $0.00 paid nothing: a charge and its same-day reversal are no payment — no sample of the
 * average, no bar of the Amount history, no payment the popover counts — and are named for what they are instead
 * (`nettedToNothing`). 🔴 Summed as a day, they were one more payment, of $0.00: his rent with a -$50.00 charge and its
 * reversal on Jul 20 (hypothetical — no day on his ledger nets to $0.00, a copy of it 2026-10-12) averaged -$1,849.76
 * ± $1,036.68 over five "payments" at 7904ee2 — the very mean a row-by-row reading printed before payments were read.
 */
describe("occurrencesOf — a day that nets to $0.00 is no payment", () => {
  const REVERSED = [
    ...RENT_ROWS,
    ...rowsOf([
      ["2026-07-20", -5_000],
      ["2026-07-20", 5_000],
    ]).map((r) => ({ ...r, id: `rev-${r.id}` })),
  ];

  test("his rent's four payments, without Jul 20's charge and its reversal", () => {
    expect(occurrencesOf(REVERSED)).toEqual(occurrencesOf(RENT_ROWS));
    expect(nettedToNothing(REVERSED)).toEqual([{ postedOn: "2026-07-20", amountCents: 0, postings: 2 }]);
  });

  test("…so the average is the four payments' — -$2,312.20 ± $85.27, not -$1,849.76 over five", () => {
    expect(postedAverage(REVERSED, PER_OCCURRENCE, FLAT, TODAY)).toEqual({ avgCents: -231_220, stddevCents: 8_527 });
  });

  test("a charge partly reversed the same day is the payment it nets to", () => {
    const partly = rowsOf([
      ["2026-07-20", -5_000],
      ["2026-07-20", 2_000],
    ]);
    expect(occurrencesOf(partly)).toEqual([{ postedOn: "2026-07-20", amountCents: -3_000, postings: 2 }]);
    expect(nettedToNothing(partly)).toEqual([]);
  });

  test("a series whose every day paid something has nothing netted", () => {
    expect(nettedToNothing(RENT_ROWS)).toEqual([]);
  });
});

/**
 * Which reading a series' rows take: per payday while it is pay (`readsPerPayday`, untouched), per occurrence for a
 * series with a schedule of charges, and as posted for the rest — money in that has ended, whose rule is the pay rule's
 * (§6A 55), and a series he dismissed, which has no occurrence at all.
 */
describe("readsPerOccurrence — a series with a schedule of charges", () => {
  test("a bill, a subscription or a transfer, live or ended, is read per occurrence", () => {
    for (const kind of ["bill", "subscription", "transfer", "other"] as const) {
      for (const status of ["detected", "confirmed", "ended"] as const) {
        expect(readsPerOccurrence({ kind, status })).toBe(true);
      }
    }
  });

  test("money in is not, nor a series he dismissed", () => {
    for (const status of ["detected", "confirmed", "ended", "dismissed"] as const) {
      expect(readsPerOccurrence({ kind: "income", status })).toBe(false);
    }
    expect(readsPerOccurrence({ kind: "bill", status: "dismissed" })).toBe(false);
  });
});

/**
 * ⚖️ A pay series averages what a PAYDAY paid, at the rate in force now (§6A 55). 🔴 Read raw, his four deposits
 * averaged $1,789.15 ± $1,881.46 — an amount no payday ever paid, under a headline of $1,141.92.
 */
describe("postedAverage — his pay, read per payday", () => {
  test("his ledger with its history set: the lump is one week, June paid no payday — $1,141.92, no spread", () => {
    const readings = paydayReadings(HIS_ROWS, HIS_PORTIONS, HIS);
    expect(postedAverage(HIS_ROWS, payday(readings), HIS, TODAY)).toEqual({ avgCents: WEEK, stddevCents: 0 });
  });

  test("his ledger as it stands, before the history is written — the same reading", () => {
    const readings = paydayReadings(HIS_ROWS, HIS_PORTIONS, FLAT);
    expect(postedAverage(HIS_ROWS, payday(readings), FLAT, TODAY)).toEqual({ avgCents: WEEK, stddevCents: 0 });
  });

  /* ⛔ Only the rate era in force now: Jun 4's cash week, paid in full at $1,047.00, is no sample of a payroll week. */
  test("a payday of an earlier rate era is not averaged with today's", () => {
    const portions = [...HIS_PORTIONS, { paydayOn: "2026-06-04", depositOn: "2026-06-04", cents: CASH }];
    const readings = paydayReadings(HIS_ROWS, portions, HIS);
    expect(readings.get("jun4")?.isPaydaySample).toBe(true);
    expect(postedAverage(HIS_ROWS, payday(readings), HIS, TODAY)).toEqual({ avgCents: WEEK, stddevCents: 0 });
    // with no history there is one era, and the cash week is a sample of it
    const flat = paydayReadings(HIS_ROWS, portions, FLAT);
    expect(postedAverage(HIS_ROWS, payday(flat), FLAT, TODAY).avgCents).toBe(Math.round((CASH + WEEK + WEEK) / 3));
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
    expect(postedAverage(rows, payday(readings), HIS, TODAY).avgCents).toBe(Math.round((115_000 + WEEK) / 2));
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
    expect(postedAverage(rows, payday(paydayReadings(rows, portions, HIS)), HIS, TODAY)).toEqual({
      avgCents: 115_644,
      stddevCents: 2_904,
    });
  });

  /*
   * ⚖️ One "in force now" for pay and bills (§6A 55, §6A 63): a raise recorded before its first day — $1,200.00 from
   * Nov 1, $1,141.92 through Oct 31 — is not in force on Oct 12. 🔴 Held to the last era recorded, his pay would read
   * no posted average until a week at $1,200.00 had been paid.
   */
  test("a raise recorded before its first day: the weeks at today's rate are still averaged", () => {
    const raisedNov1: RateSchedule = {
      nextExpectedAmountCents: 120_000,
      amountHistory: [...HIS.amountHistory!, { throughOn: "2026-10-31", amountCents: WEEK }],
    };
    const readings = paydayReadings(HIS_ROWS, HIS_PORTIONS, raisedNov1);
    expect(postedAverage(HIS_ROWS, payday(readings), raisedNov1, TODAY)).toEqual({ avgCents: WEEK, stddevCents: 0 });
    expect(postedAverage(HIS_ROWS, payday(readings), raisedNov1, "2026-11-01").avgCents).toBeNull();
  });

  /* a row the reading does not cover is held on its own day, as `expectedCentsOf` holds it */
  test("a row with no reading is averaged in its own day's era", () => {
    const rows = [HIS_ROWS[0]!, HIS_ROWS[3]!];
    expect(postedAverage(rows, payday(new Map()), HIS, TODAY)).toEqual({ avgCents: WEEK, stddevCents: null });
  });

  test("a pay series with no payday paid names no average", () => {
    const rows = HIS_ROWS.slice(0, 2);
    expect(postedAverage(rows, payday(paydayReadings(rows, [], HIS)), HIS, TODAY)).toEqual({
      avgCents: null,
      stddevCents: null,
    });
  });
});

/**
 * ⚖️ WHAT A PAY SERIES' AVERAGE IS OF, and what it leaves out — the one reading the average and the amount popover's
 * words take (§6A 55). 🔴 The popover described the rows as they posted: his pay's read "Its 4 tagged postings since
 * Jun 4, 2026 were 4 different amounts, from $400.00 to $4,567.68 — so any single figure for it is an average, not a
 * repeat." beside an average of $1,141.92 that every payday at the rate in force paid exactly (a copy of his ledger,
 * 2026-10-12).
 */
describe("perPaydayEvidence — his pay, what the average is of", () => {
  /* His paydays open on Jun 4 (§6A 55 step B), so Jun 4's cash week is a payday of the earlier rate, paid in full. */
  test("his ledger with its history set: the lump and Sep 24, each per payday; Jun 4 at an earlier rate", () => {
    const portions = [...HIS_PORTIONS, { paydayOn: "2026-06-04", depositOn: "2026-06-04", cents: CASH }];
    const readings = paydayReadings(HIS_ROWS, portions, HIS);
    expect(perPaydayEvidence(HIS_ROWS, readings, HIS, TODAY)).toEqual({
      samples: [
        { postedOn: "2026-09-23", cents: WEEK, paydays: 4, dayCents: WEEK * 4, deposits: 1 },
        { postedOn: "2026-09-24", cents: WEEK, paydays: 1, dayCents: WEEK, deposits: 1 },
      ],
      earlier: 1,
      later: 0,
      noPaydayOfTheirOwn: 1,
      moneyOut: 0,
      netted: [],
    });
  });

  /*
   * ⛔ Money that paid NO payday is held to no rate (`PaydayReading.expectedCents`): it answers no week, whatever era
   * its day falls in — so it is no earlier rate's either. 🔴 At 78c21ee the era was read first, and his Jun 5 $400.00
   * was "at an earlier rate" in the popover while the calendar and the Amount history drew it toward no payday (a copy
   * of his ledger, 2026-10-12).
   */
  test("June's money, toward no payday, is no earlier rate's: it paid no payday of its own", () => {
    const readings = paydayReadings(HIS_ROWS, HIS_PORTIONS, HIS);
    expect(readings.get("jun5")).toMatchObject({ towardNoPayday: true, ratePeriod: 0 });
    const e = perPaydayEvidence(HIS_ROWS, readings, HIS, TODAY);
    expect([e.earlier, e.later, e.noPaydayOfTheirOwn]).toEqual([0, 0, 2]);
  });

  /*
   * ⛔ A payday of a raise recorded AHEAD, paid early — his payroll lands the Wednesday before the Thursday it pays —
   * is of a LATER era than today's: left out of the average, and never counted as an earlier rate's. 🔴 At 78c21ee
   * every era but today's was `earlier`, and the popover said Wed Sep 30's $1,200.00 was "before Aug 27, 2026 … at an
   * earlier rate".
   */
  test("a payday of a raise recorded ahead, paid the day before it begins, is a later rate's", () => {
    const raisedOct1: RateSchedule = {
      nextExpectedAmountCents: 120_000,
      amountHistory: [...HIS.amountHistory!, { throughOn: "2026-09-30", amountCents: WEEK }],
    };
    const rows = [...HIS_ROWS, { id: "sep30", postedOn: "2026-09-30", amountCents: 120_000 }];
    const portions = [
      ...HIS_PORTIONS,
      { paydayOn: "2026-06-04", depositOn: "2026-06-04", cents: CASH },
      { paydayOn: "2026-10-01", depositOn: "2026-09-30", cents: 120_000 },
    ];
    const readings = paydayReadings(rows, portions, raisedOct1);
    const e = perPaydayEvidence(rows, readings, raisedOct1, "2026-09-30");
    expect(e.samples.map((s) => s.postedOn)).toEqual(["2026-09-23", "2026-09-24"]);
    expect([e.earlier, e.later, e.noPaydayOfTheirOwn]).toEqual([1, 1, 1]);
    expect(postedAverage(rows, payday(readings), raisedOct1, "2026-09-30").avgCents).toBe(WEEK);
    // on Oct 1 the raise is in force, and Sep 30's deposit is its one sample
    const oct1 = perPaydayEvidence(rows, readings, raisedOct1, "2026-10-01");
    expect(oct1.samples.map((s) => [s.postedOn, s.cents])).toEqual([["2026-09-30", 120_000]]);
    expect([oct1.earlier, oct1.later, oct1.noPaydayOfTheirOwn]).toEqual([3, 0, 1]);
  });

  /* With no history there is one era: Jun 4's cash week is a sample of it, and Jun 5's $400.00 paid no payday. */
  test("one era: Jun 4's week is a sample, and Jun 5's $400.00 paid no payday of its own", () => {
    const portions = [...HIS_PORTIONS, { paydayOn: "2026-06-04", depositOn: "2026-06-04", cents: CASH }];
    const e = perPaydayEvidence(HIS_ROWS, paydayReadings(HIS_ROWS, portions, FLAT), FLAT, TODAY);
    expect(e.samples.map((s) => [s.postedOn, s.cents])).toEqual([
      ["2026-06-04", CASH],
      ["2026-09-23", WEEK],
      ["2026-09-24", WEEK],
    ]);
    expect([e.earlier, e.noPaydayOfTheirOwn]).toEqual([0, 1]);
  });

  /* ⛔ THE UNIT IS THE DAY: a lump and its week on one day are one sample of the day's money, made of two deposits. */
  test("a lump and the week on one day are one sample, of two deposits and the day's money", () => {
    const rows = [
      { id: "lump", postedOn: "2026-09-24", amountCents: WEEK * 4 },
      { id: "week", postedOn: "2026-09-24", amountCents: WEEK },
    ];
    const portions = ["2026-09-24", "2026-09-17", "2026-09-10", "2026-09-03", "2026-08-27"].map((paydayOn) => ({
      paydayOn,
      depositOn: "2026-09-24",
      cents: WEEK,
    }));
    const e = perPaydayEvidence(rows, paydayReadings(rows, portions, FLAT), FLAT, TODAY);
    expect(e).toEqual({
      samples: [{ postedOn: "2026-09-24", cents: WEEK, paydays: 5, dayCents: WEEK * 5, deposits: 2 }],
      earlier: 0,
      later: 0,
      noPaydayOfTheirOwn: 0,
      moneyOut: 0,
      netted: [],
    });
  });

  /*
   * ⛔ MONEY OUT IS NO DEPOSIT, and a day that nets to $0.00 paid nothing (`nettedToNothing`, the rule a bill's
   * payments are read by): neither is a sample of what a payday paid. 🔴 Read as a deposit, a payroll returned the same
   * day was a sample of -$1,141.92, and two weeks at $1,141.92 averaged $380.64 (review of 6c59cdb, hypothetical: no
   * money out is linked to his pay, a copy of his ledger 2026-10-12).
   */
  test("a week returned the same day nets to nothing; one returned the day after is money out", () => {
    const rows = [
      { id: "sep10", postedOn: "2026-09-10", amountCents: WEEK },
      { id: "sep17", postedOn: "2026-09-17", amountCents: WEEK },
      { id: "sep17back", postedOn: "2026-09-17", amountCents: -WEEK },
      { id: "sep24", postedOn: "2026-09-24", amountCents: WEEK },
      { id: "sep25back", postedOn: "2026-09-25", amountCents: -WEEK },
    ];
    // settlement reads deposits only: each week's deposit pays its own payday
    const portions = ["2026-09-10", "2026-09-17", "2026-09-24"].map((paydayOn) => ({
      paydayOn,
      depositOn: paydayOn,
      cents: WEEK,
    }));
    const readings = paydayReadings(rows, portions, FLAT);
    expect(perPaydayEvidence(rows, readings, FLAT, TODAY)).toEqual({
      samples: [
        { postedOn: "2026-09-10", cents: WEEK, paydays: 1, dayCents: WEEK, deposits: 1 },
        { postedOn: "2026-09-24", cents: WEEK, paydays: 1, dayCents: WEEK, deposits: 1 },
      ],
      earlier: 0,
      later: 0,
      noPaydayOfTheirOwn: 0,
      moneyOut: 1,
      netted: [{ postedOn: "2026-09-17", amountCents: 0, postings: 2 }],
    });
    expect(postedAverage(rows, payday(readings), FLAT, TODAY)).toEqual({ avgCents: WEEK, stddevCents: 0 });
  });

  /* ⛔ ONE READING: the average is the mean of exactly these samples, whatever the rows. */
  test("the average averages exactly its samples", () => {
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
    const readings = paydayReadings(rows, portions, HIS);
    const { samples } = perPaydayEvidence(rows, readings, HIS, TODAY);
    const mean = samples.reduce((sum, s) => sum + s.cents, 0) / samples.length;
    expect(postedAverage(rows, payday(readings), HIS, TODAY).avgCents).toBe(Math.round(mean));
    expect(samples).toHaveLength(4);
  });
});
