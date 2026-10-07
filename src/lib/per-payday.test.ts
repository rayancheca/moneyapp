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

describe("paydayReadings — what is read as the one amount it is", () => {
  test("two deposits on one day — settlement names money by its day, so neither's can be told apart", () => {
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
