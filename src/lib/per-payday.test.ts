import { describe, expect, test } from "vitest";
import {
  amountPerPayday,
  comparableCents,
  paydayReadings,
  paydaysPaidAloneByDeposit,
  spreadSampleCents,
} from "./per-payday";

const WEEK = 114_192;

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
 * His ledger as settlement spends it on 2026-10-07: June's $1,047.00 and $400.00
 * pay Aug 27 together, the lump of Sep 23 pays Sep 3 through Sep 24 on its own,
 * and Sep 24's week pays Aug 20 on its own.
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
    { paydayOn: "2026-08-27", depositOn: "2026-06-05", cents: 40_000 },
    { paydayOn: "2026-08-27", depositOn: "2026-06-04", cents: 74_192 },
    { paydayOn: "2026-08-20", depositOn: "2026-09-24", cents: WEEK },
  ];
  const readings = paydayReadings(rows, portions);
  const row = (id: string) => rows.find((r) => r.id === id)!;

  test("the lump is four paydays at a week each, held to the expectation as one week", () => {
    expect(readings.get("lump")).toEqual({ perPayday: { paydays: 4, cents: WEEK }, isPaydaySample: true });
    expect(comparableCents(row("lump").amountCents, readings.get("lump"))).toBe(WEEK);
  });

  test("a week that paid one payday is read as the amount it is", () => {
    expect(readings.get("sep24")).toEqual({ perPayday: null, isPaydaySample: true });
    expect(comparableCents(WEEK, readings.get("sep24"))).toBe(WEEK);
  });

  /*
   * ⛔ June's two deposits are PARTS of one payday's pay. As samples of what a
   * payday pays they read $1,047.00 and $400.00 — a spread of their split, not
   * of his pay — so the spread leaves them out. Each is still held to the
   * expectation as the amount it is.
   */
  test("money that only went into paydays another deposit also paid is no sample of a payday's pay", () => {
    expect(readings.get("jun5")).toEqual({ perPayday: null, isPaydaySample: false });
    expect(spreadSampleCents(40_000, readings.get("jun5"))).toBeNull();
    expect(comparableCents(40_000, readings.get("jun5"))).toBe(40_000);
  });

  test("the spread's samples are every row's per-payday figure — the lump as one week", () => {
    const samples = rows.map((r) => spreadSampleCents(r.amountCents, readings.get(r.id)));
    expect(samples).toEqual([null, null, WEEK, WEEK]);
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
    );
    expect(comparableCents(WEEK, readings.get("week"))).toBe(Math.round((WEEK * 5) / 4));
  });
});

describe("paydayReadings — what is read as the one amount it is", () => {
  test("two deposits on one day that paid no payday of their own are each the amount they are", () => {
    const readings = paydayReadings(
      [
        { id: "a", postedOn: "2026-09-24", amountCents: WEEK },
        { id: "b", postedOn: "2026-09-24", amountCents: 40_000 },
      ],
      [],
    );
    expect(readings.get("a")).toEqual({ perPayday: null, isPaydaySample: true });
    expect(readings.get("b")).toEqual({ perPayday: null, isPaydaySample: true });
  });

  test("a deposit settlement spent on nothing, and money out, are each the one amount they are", () => {
    const readings = paydayReadings(
      [
        { id: "unspent", postedOn: "2026-06-04", amountCents: WEEK },
        { id: "clawback", postedOn: "2026-09-23", amountCents: -5_000 },
      ],
      [{ paydayOn: "2026-09-24", depositOn: "2026-09-23", cents: WEEK }],
    );
    expect(readings.get("unspent")).toEqual({ perPayday: null, isPaydaySample: true });
    expect(readings.get("clawback")).toEqual({ perPayday: null, isPaydaySample: true });
  });

  test("a row with no reading at all — a bill — is the amount it is", () => {
    expect(comparableCents(-200_000, undefined)).toBe(-200_000);
    expect(spreadSampleCents(-200_000, undefined)).toBe(-200_000);
  });
});
