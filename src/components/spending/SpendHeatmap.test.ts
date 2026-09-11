import { describe, expect, test } from "vitest";
import type { HeatDay } from "@/services/spending";
import { heatCellLabel } from "./SpendHeatmap";

const TODAY = "2026-09-10";
const REACHES = "2026-08-31";

const cell = (iso: string, day: HeatDay | null = null, over: Partial<Parameters<typeof heatCellLabel>[0]> = {}) =>
  heatCellLabel({
    iso,
    monthKey: "2026-09",
    monthName: "September 2026",
    day,
    today: TODAY,
    ledgerReaches: REACHES,
    ...over,
  });

const heat = (spentCents: number, incomeCents = 0, txnCount = 1, refundedCents = 0): HeatDay => ({
  iso: "2026-08-04",
  spentCents,
  incomeCents,
  txnCount,
  topCategories: [],
  topMerchants: [],
  refundedCents,
});

/**
 * 🔴 Measured 2026-09-10: `/spending` opens its heatmap on September and all 30
 * cells read "no activity" — ten of days nobody has imported, twenty of days
 * that have not happened — one card under the page's own "That is a window
 * nobody has looked at, not one in which nothing happened."
 */
describe("heatCellLabel — three worlds, three sentences", () => {
  /**
   * ⛔ …AND THE MEASUREMENT IS OF THREE THINGS, NOT OF EVERYTHING. The chart
   * counts expense-kind outflows, income-kind positives and expense-kind
   * credits; a day holding only a transfer, a card payment or an investment
   * flow falls through all three. "no activity" claimed the whole ledger for
   * it. Measured 2026-09-11: **79 days, covering 298 real transactions.**
   */
  test("a day the ledger walked through and found empty is a measurement", () => {
    expect(cell("2026-08-04", null, { monthKey: "2026-08", monthName: "August 2026" })).toBe(
      "Aug 4: nothing spent or earned",
    );
  });

  test("a past day the import has not reached says nobody has looked", () => {
    expect(cell("2026-09-04")).toBe("Sep 4: not imported yet");
  });

  test("a day after today says it has not happened", () => {
    expect(cell("2026-09-11")).toBe("Sep 11: has not happened yet");
  });

  test("today itself is not the future — it is merely unimported here", () => {
    expect(cell("2026-09-10")).toBe("Sep 10: not imported yet");
  });

  test("the last reached day is a measurement, the next one is not", () => {
    expect(cell("2026-08-31", null, { monthKey: "2026-08", monthName: "August 2026" })).toBe(
      "Aug 31: nothing spent or earned",
    );
    expect(cell("2026-09-01")).toBe("Sep 1: not imported yet");
  });

  test("an empty ledger has reached nothing at all", () => {
    expect(cell("2026-08-04", null, { monthKey: "2026-08", monthName: "August 2026", ledgerReaches: null })).toBe(
      "Aug 4: not imported yet",
    );
  });

  /* ⛔ the padding half, fixed 2026-09-04 and still load-bearing */
  test("a padding day from a neighbouring month is never described at all", () => {
    expect(cell("2026-08-31")).toBe("Aug 31: not part of September 2026 — open its ledger");
  });

  test("a day with money reports it, and the frontier never overrides a measurement", () => {
    expect(
      cell("2026-08-04", heat(12_50, 0, 2), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: $12.50 spent across 2 transactions");
  });
});

describe("a day whose only row is a return", () => {
  /* 🔴 The service skips a credit in an expense category from both buckets on
     purpose, so such a day arrived with two zeroes and read "no activity" over
     a posted row. Two days on the owner's ledger: 2025-05-10 ($18.00 back) and
     2025-11-22 ($5.58). */
  test("names the refund instead of calling the day empty", () => {
    expect(
      cell("2026-08-04", heat(0, 0, 0, 1_800), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: $18.00 refunded");
  });

  test("a day with spending is unaffected by a refund on it", () => {
    expect(
      cell("2026-08-04", heat(5_000, 0, 1, 1_800), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: $50.00 spent across 1 transaction");
  });

  test("a covered day with nothing in this chart's three buckets says exactly that", () => {
    expect(
      cell("2026-08-04", heat(0, 0, 0, 0), { monthKey: "2026-08", monthName: "August 2026" }),
    ).toBe("Aug 4: nothing spent or earned");
  });
});
