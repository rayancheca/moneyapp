import { describe, expect, test } from "vitest";
import {
  amountPerPayday,
  comparableCents,
  expectedCentsOf,
  paydayReadings,
  paydaysPaidAloneByDeposit,
  spreadSampleCents,
} from "./per-payday";
import type { RateSchedule } from "./series-kind";

const WEEK = 114_192;
/** a series whose rate has never changed */
const FLAT: RateSchedule = { nextExpectedAmountCents: WEEK, amountHistory: null };
/** his series once its history is set (§6A 55): the cash weeks through Aug 26 at $1,047.00 */
const HIS: RateSchedule = {
  nextExpectedAmountCents: WEEK,
  amountHistory: [{ throughOn: "2026-08-26", amountCents: 104_700 }],
};
/** what a reading says, field by field — `ratePeriod` is the era of HIS: 0 the cash weeks, 1 the payroll weeks */
const reads = (
  isPaydaySample: boolean,
  expectedCents: number | null,
  towardNoPayday: boolean,
  ratePeriod: number,
) => ({
  perPayday: null,
  isPaydaySample,
  expectedCents,
  ratePeriod,
  towardNoPayday,
});

describe("paydaysPaidAloneByDeposit", () => {
  test("counts, per deposit day, the paydays only that day's money went into", () => {
    const counts = paydaysPaidAloneByDeposit([
      { paydayOn: "2026-09-24", depositOn: "2026-09-23", cents: WEEK },
      { paydayOn: "2026-09-17", depositOn: "2026-09-23", cents: WEEK },
      { paydayOn: "2026-09-03", depositOn: "2026-09-03", cents: WEEK },
      // a payday two deposits' money met is neither's on its own
      { paydayOn: "2026-08-27", depositOn: "2026-09-23", cents: 113_424 },
      { paydayOn: "2026-08-27", depositOn: "2026-09-03", cents: 768 },
    ]);
    expect([...counts.entries()].sort()).toEqual([
      ["2026-09-03", 1],
      ["2026-09-23", 2],
    ]);
  });
});

describe("amountPerPayday", () => {
  test("a deposit spread over paydays is measured per payday, to the cent", () => {
    expect(amountPerPayday(WEEK * 4, 4)).toBe(WEEK);
    expect(amountPerPayday(400_000, 3)).toBe(133_333);
  });

  test("one payday, or none settlement spent it on, leaves the amount as it is", () => {
    expect(amountPerPayday(120_000, 1)).toBe(120_000);
    expect(amountPerPayday(120_000, 0)).toBe(120_000);
  });
});

/**
 * His ledger as settlement spends it once his rate history is set (§6A 55, 55a, 55b), over the paydays the ledger
 * draws for his series today (from its anchor, Jul 23): June's $1,047.00 and $400.00 pay nothing, the lump of Sep 23
 * pays Sep 3 through Sep 24 on its own, and Sep 24's week pays Aug 27 on its own.
 */
describe("paydayReadings — his ledger", () => {
  const rows = [
    { id: "jun4", postedOn: "2026-06-04", amountCents: 104_700 },
    { id: "jun5", postedOn: "2026-06-05", amountCents: 40_000 },
    { id: "lump", postedOn: "2026-09-23", amountCents: WEEK * 4 },
    { id: "sep24", postedOn: "2026-09-24", amountCents: WEEK },
  ];
  const portions = [
    ...["2026-09-24", "2026-09-17", "2026-09-10", "2026-09-03"].map((paydayOn) => ({
      paydayOn,
      depositOn: "2026-09-23",
      cents: WEEK,
    })),
    { paydayOn: "2026-08-27", depositOn: "2026-09-24", cents: WEEK },
  ];
  const readings = paydayReadings(rows, portions, HIS);
  const row = (id: string) => rows.find((r) => r.id === id)!;

  test("the lump is four paydays at a week each, held to the expectation as one week", () => {
    expect(readings.get("lump")).toEqual({
      perPayday: { paydays: 4, cents: WEEK },
      isPaydaySample: true,
      expectedCents: WEEK,
      ratePeriod: 1,
      towardNoPayday: false,
    });
    expect(comparableCents(row("lump").amountCents, readings.get("lump"))).toBe(WEEK);
  });

  /* ⚖️ held to the rate of the payday its money PAID — Aug 27, the first payroll week — not to its own date's */
  test("a week that paid one payday is read as the amount it is, against that payday's rate", () => {
    expect(readings.get("sep24")).toEqual({
      perPayday: null,
      isPaydaySample: true,
      expectedCents: WEEK,
      ratePeriod: 1,
      towardNoPayday: false,
    });
    expect(comparableCents(WEEK, readings.get("sep24"))).toBe(WEEK);
  });

  /*
   * ⛔ June's money paid NO payday (55b: it reaches Jun 8 and no further, and these portions draw no payday before
   * Jul 23). The calendar says so — "toward no payday" — and does not grade it; as a sample of what a payday pays it
   * is none at all. And it is held to NOTHING: it answers no week, so no week's rate is its expectation. 🔴 Held to
   * its own day's rate, the series page graded Jun 5's $400.00 "-$647.00" against $1,047.00, one tab over from a
   * calendar that drew the same row paid toward no payday.
   */
  test("money that paid no payday reads toward no payday, held to no rate, and is no sample", () => {
    for (const [id, cents] of [["jun4", 104_700], ["jun5", 40_000]] as const) {
      expect(readings.get(id)).toEqual(reads(false, null, true, 0));
      expect(spreadSampleCents(cents, readings.get(id))).toBeNull();
      expect(expectedCentsOf(readings.get(id), HIS, row(id).postedOn)).toBeNull();
    }
  });

  test("the spread's samples are every row's per-payday figure — the lump as one week", () => {
    const samples = rows.map((r) => spreadSampleCents(r.amountCents, readings.get(r.id)));
    expect(samples).toEqual([null, null, WEEK, WEEK]);
  });
});

/* The same four deposits over the paydays from his first deposit on (§6A 55, step B): Jun 4 pays Jun 4 in full. */
describe("paydayReadings — his ledger, from his first deposit's payday", () => {
  const readings = paydayReadings(
    [
      { id: "jun4", postedOn: "2026-06-04", amountCents: 104_700 },
      { id: "jun5", postedOn: "2026-06-05", amountCents: 40_000 },
    ],
    [{ paydayOn: "2026-06-04", depositOn: "2026-06-04", cents: 104_700 }],
    HIS,
  );

  test("Jun 4's cash week is a sample held to the cash rate — on plan, not $94.92 short", () => {
    expect(readings.get("jun4")).toEqual(reads(true, 104_700, false, 0));
  });

  test("Jun 5's $400.00 still paid no payday, and is held to no rate", () => {
    expect(readings.get("jun5")).toEqual(reads(false, null, true, 0));
  });
});

/*
 * ⛔ A PART of a payday's pay. One week sent as two transfers on different days — $500.00 on Fri Sep 25, after Sep 24
 * was paid, and $641.92 on Sat Sep 26 — pays Sep 17 together. As samples of what a payday pays they measure how his
 * payer split a transfer, not his pay, so the spread leaves them out; each is still held to the expectation.
 */
describe("paydayReadings — money that only went into a payday another deposit also paid", () => {
  const readings = paydayReadings(
    [
      { id: "fri", postedOn: "2026-09-25", amountCents: 50_000 },
      { id: "sat", postedOn: "2026-09-26", amountCents: 64_192 },
    ],
    [
      { paydayOn: "2026-09-17", depositOn: "2026-09-26", cents: 64_192 },
      { paydayOn: "2026-09-17", depositOn: "2026-09-25", cents: 50_000 },
    ],
    FLAT,
  );

  test("is no sample of a payday's pay, and is not 'toward no payday'", () => {
    expect(readings.get("fri")).toEqual(reads(false, WEEK, false, 0));
    expect(spreadSampleCents(50_000, readings.get("fri"))).toBeNull();
    expect(comparableCents(50_000, readings.get("fri"))).toBe(50_000);
  });
});

/* ⚖️ Held to the rate of the payday its money paid: a payroll deposit of Sep 24 that paid the payroll week of Aug 27
   is held to $1,141.92 — and a deposit dated in the cash era that paid a payroll week is held to the payroll rate. */
describe("paydayReadings — the expectation is the rate of the payday the money paid", () => {
  test("Wed Aug 26's deposit that paid Thu Aug 27 is held to the payroll rate, not its own date's cash rate", () => {
    const readings = paydayReadings(
      [{ id: "wed", postedOn: "2026-08-26", amountCents: WEEK }],
      [{ paydayOn: "2026-08-27", depositOn: "2026-08-26", cents: WEEK }],
      HIS,
    );
    expect(readings.get("wed")?.expectedCents).toBe(WEEK);
    // …and read in the payroll era, which the posted average reads (`lib/posted-average`)
    expect(readings.get("wed")?.ratePeriod).toBe(1);
  });

  test("a series with no rate at all holds its rows to nothing", () => {
    const readings = paydayReadings(
      [{ id: "a", postedOn: "2026-09-24", amountCents: WEEK }],
      [],
      { nextExpectedAmountCents: null, amountHistory: null },
    );
    expect(readings.get("a")?.expectedCents).toBeNull();
  });
});

/**
 * ⛔ SETTLEMENT NAMES MONEY BY ITS DEPOSIT'S DAY, so a day's deposits are read
 * as the ONE deposit settlement sees: the day's money, divided by the paydays it
 * paid on its own. 🔴 Read row by row, a lump landing beside the week's own
 * deposit was held to one week as $4,567.68 — "rose by $3,425.76" again.
 */
describe("paydayReadings — two deposits on one day are read as the day", () => {
  /** A lump of four weeks and its week on Sep 24, as settlement spends the day: Sep 24 back to Aug 27. */
  const lumpAndWeek = paydayReadings(
    [
      { id: "lump", postedOn: "2026-09-24", amountCents: WEEK * 4 },
      { id: "week", postedOn: "2026-09-24", amountCents: WEEK },
    ],
    ["2026-09-24", "2026-09-17", "2026-09-10", "2026-09-03", "2026-08-27"].map((paydayOn) => ({
      paydayOn,
      depositOn: "2026-09-24",
      cents: WEEK,
    })),
    FLAT,
  );

  test("a lump and a week on one day: each is held to the expectation as the day's five paydays at a week each", () => {
    for (const id of ["lump", "week"]) {
      expect(lumpAndWeek.get(id)?.perPayday).toEqual({ paydays: 5, cents: WEEK, deposits: 2 });
    }
    expect(comparableCents(WEEK * 4, lumpAndWeek.get("lump"))).toBe(WEEK);
    expect(comparableCents(WEEK, lumpAndWeek.get("week"))).toBe(WEEK);
  });

  test("the day is ONE sample of a payday's pay, as one lump is", () => {
    const samples = ["lump", "week"].map((id) => spreadSampleCents(WEEK, lumpAndWeek.get(id)));
    expect(samples.filter((s) => s !== null)).toEqual([WEEK]);
  });

  test("two weeks on one day that paid two paydays read a week each", () => {
    const readings = paydayReadings(
      [
        { id: "a", postedOn: "2026-09-24", amountCents: WEEK },
        { id: "b", postedOn: "2026-09-24", amountCents: WEEK },
      ],
      [
        { paydayOn: "2026-09-24", depositOn: "2026-09-24", cents: WEEK },
        { paydayOn: "2026-09-17", depositOn: "2026-09-24", cents: WEEK },
      ],
      FLAT,
    );
    expect(readings.get("a")?.perPayday).toEqual({ paydays: 2, cents: WEEK, deposits: 2 });
    expect(comparableCents(WEEK, readings.get("b"))).toBe(WEEK);
  });

  /*
   * One week's pay sent as two transfers paid one payday: what that payday was
   * paid is the day's $1,141.92, not $600.00 and $541.92 — the split is his
   * payer's, not a change in his pay.
   */
  test("one week sent as two transfers on one day is the one payday's pay it is", () => {
    const readings = paydayReadings(
      [
        { id: "a", postedOn: "2026-09-24", amountCents: 60_000 },
        { id: "b", postedOn: "2026-09-24", amountCents: WEEK - 60_000 },
      ],
      [{ paydayOn: "2026-09-24", depositOn: "2026-09-24", cents: 60_000 }],
      FLAT,
    );
    expect(readings.get("a")?.perPayday).toEqual({ paydays: 1, cents: WEEK, deposits: 2 });
    expect(comparableCents(WEEK - 60_000, readings.get("b"))).toBe(WEEK);
  });

  test("money the day spent on no payday of its own still counts against it, as it does a lump's", () => {
    const readings = paydayReadings(
      [
        { id: "lump", postedOn: "2026-09-24", amountCents: WEEK * 4 },
        { id: "week", postedOn: "2026-09-24", amountCents: WEEK },
      ],
      ["2026-09-24", "2026-09-17", "2026-09-10", "2026-09-03"].map((paydayOn) => ({
        paydayOn,
        depositOn: "2026-09-24",
        cents: WEEK,
      })),
      FLAT,
    );
    expect(comparableCents(WEEK, readings.get("week"))).toBe(Math.round((WEEK * 5) / 4));
  });
});

describe("paydayReadings — what is read as the one amount it is", () => {
  /* ⚖️ §6A 55: money that paid no payday is no sample of what a payday pays — each deposit is still the amount it is,
     and reads toward no payday. 🔴 It was a sample: before the reach bound June's $400.00 was a part of Aug 27's pay,
     and money settlement spent on nothing at all weighed in the spread as a week. */
  test("two deposits on one day that paid no payday are each the amount they are, toward no payday", () => {
    const readings = paydayReadings(
      [
        { id: "a", postedOn: "2026-09-24", amountCents: WEEK },
        { id: "b", postedOn: "2026-09-24", amountCents: 40_000 },
      ],
      [],
      FLAT,
    );
    for (const id of ["a", "b"]) {
      expect(readings.get(id)).toEqual(reads(false, null, true, 0));
    }
  });

  test("a deposit settlement spent on nothing reads toward no payday; money out is the one amount it is", () => {
    const readings = paydayReadings(
      [
        { id: "unspent", postedOn: "2026-06-04", amountCents: WEEK },
        { id: "clawback", postedOn: "2026-09-23", amountCents: -5_000 },
      ],
      [{ paydayOn: "2026-09-24", depositOn: "2026-09-23", cents: WEEK }],
      HIS,
    );
    // held to nothing — it answers no week — though its era is still its own day's, a cash week's
    expect(readings.get("unspent")).toEqual(reads(false, null, true, 0));
    expect(readings.get("clawback")).toEqual(reads(true, WEEK, false, 1));
  });

  test("a row with no reading at all — a bill — is the amount it is", () => {
    expect(comparableCents(-200_000, undefined)).toBe(-200_000);
    expect(spreadSampleCents(-200_000, undefined)).toBe(-200_000);
  });
});
