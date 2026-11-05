import { describe, expect, test } from "vitest";
import { averagedPayments, daysThatPaid, moneyBackDays, occurrencesOf, postedAverage } from "./posted-average";
import type { RateSchedule } from "./series-kind";

/**
 * ⚖️ default built, not asked (2026-11-04) — MONEY BACK IS NO PAYMENT OF THE AVERAGE either: a series read per
 * occurrence averages the days that PAID a charge (`daysThatPaid`, every grader's one rule) at the rate in force now
 * (`averagedPayments`), as his pay's averages the rows that paid a payday and never one "toward no payday"
 * (`perPaydayEvidence`). The days it leaves out are named (`moneyBackDays`), as a day netted to nothing is. Its own
 * file by subject: posted-average.test.ts is past the 800-line cap.
 *
 * 🔴 Review of 23e9c5d1: +$50.00 linked to Breezeline (internet) on Oct 12 — its page's Amount history drew the bar
 * "toward no due day" while the posted avg beside it read "-$31.72 ± $40.22" over six "payments", the credit among
 * them; the All tab read -$31.72 too. Its five payments average -$48.06 (his ledger copy 2026-11-04, the credit added
 * on Venture X, read Nov 4). Latent on his ledger: no day of any series of his read per occurrence nets to $0.00 or
 * against its rate (0 of 28 series, 2026-11-04).
 */

const TODAY = "2026-11-04";
const RATE = -5_000;
/** a series whose rate has never changed */
const FLAT: RateSchedule = { nextExpectedAmountCents: RATE, amountHistory: null };
const rowsOf = (pairs: readonly (readonly [string, number])[]) =>
  pairs.map(([postedOn, amountCents], i) => ({ id: `r${i}`, postedOn, amountCents }));

/** Breezeline's five rows on his ledger copy 2026-11-04 — a prorated first bill, four at its rate — and a credit */
const BREEZELINE = rowsOf([
  ["2026-06-20", -4_032],
  ["2026-07-10", RATE],
  ["2026-08-10", RATE],
  ["2026-09-10", RATE],
  ["2026-10-10", RATE],
  ["2026-10-12", -RATE],
]);

describe("postedAverage — money back is no payment a series read per occurrence averages", () => {
  test("Breezeline's +$50.00 back on Oct 12: its five payments, -$48.06 ± $4.33 — never -$31.72 over six", () => {
    expect(postedAverage(BREEZELINE, { per: "occurrence", rateCents: RATE }, FLAT, TODAY)).toEqual({
      avgCents: -4_806,
      stddevCents: 433,
    });
  });

  test("…held to the rate's way, whichever that is; with no rate, every day that did not net to nothing", () => {
    // money in at its rate: the money out is what went back
    const back = BREEZELINE.map((r) => ({ ...r, amountCents: -r.amountCents }));
    expect(postedAverage(back, { per: "occurrence", rateCents: -RATE }, FLAT, TODAY).avgCents).toBe(4_806);
    expect(postedAverage(BREEZELINE, { per: "occurrence", rateCents: null }, FLAT, TODAY)).toEqual({
      avgCents: -3_172,
      stddevCents: 4_022,
    });
  });
});

describe("averagedPayments and moneyBackDays — what the average is of, and the money back it leaves out", () => {
  test("the payments the average averages are the days that paid, at the rate in force now", () => {
    expect(averagedPayments(BREEZELINE, RATE, FLAT, TODAY)).toEqual(daysThatPaid(BREEZELINE, RATE));
    // a rate raised from Aug 1: the payments before it are an earlier rate's
    const raised: RateSchedule = { ...FLAT, amountHistory: [{ throughOn: "2026-07-31", amountCents: -4_000 }] };
    expect(averagedPayments(BREEZELINE, RATE, raised, TODAY).map((o) => o.postedOn)).toEqual([
      "2026-08-10",
      "2026-09-10",
      "2026-10-10",
    ]);
  });

  test("the days netting against the rate — money back — oldest first; with no rate to run by, none", () => {
    const rows = [
      ...BREEZELINE,
      ...rowsOf([
        ["2026-07-20", RATE],
        ["2026-07-20", -RATE],
        ["2026-09-01", 1_250],
      ]),
    ];
    expect(moneyBackDays(rows, RATE)).toEqual([
      { postedOn: "2026-09-01", amountCents: 1_250, postings: 1 },
      { postedOn: "2026-10-12", amountCents: 5_000, postings: 1 },
    ]);
    expect(moneyBackDays(rows, null)).toEqual([]);
    expect(moneyBackDays(rows, 0)).toEqual([]);
    // ⛔ …so every day that did not net to nothing is one or the other: paid, or money back
    const split = [...daysThatPaid(rows, RATE), ...moneyBackDays(rows, RATE)].map((o) => o.postedOn).sort();
    expect(split).toEqual(occurrencesOf(rows).map((o) => o.postedOn));
  });
});
