import { describe, expect, test } from "vitest";
import { historyLine } from "./TransactionSheet";

describe("historyLine — the mean's denominator is named", () => {
  /*
   * 🔴 `Zelle`: "140 transactions · avg $76.48 · $4,053.69 total" — $4,053.69 ÷
   * 140 is $28.95, and ÷ 53 (its outflows) is $76.48, so the three figures
   * could not be reconciled with each other. `ACH Deposit`: 83 rows, no
   * outflow, +$16,386.82 net, and the line read "avg $0.00 · $0.00 total".
   * Measured 2026-09-10: 1,328 active rows sit in a group where the two counts
   * differ, 551 of them in groups with no outflow at all.
   */
  test("a group where every row spent keeps the plain sentence", () => {
    expect(historyLine({ count: 12, outCount: 12, avgCents: 1_250, totalCents: 15_000 })).toBe(
      "12 transactions · avg $12.50 · $150.00 spent",
    );
  });

  test("a mixed group names how many of them spent", () => {
    expect(historyLine({ count: 140, outCount: 53, avgCents: 7_648, totalCents: 405_369 })).toBe(
      "140 transactions, 53 of them spending · avg $76.48 · $4,053.69 spent",
    );
  });

  test("a group with no outflow says so instead of averaging nothing", () => {
    expect(historyLine({ count: 83, outCount: 0, avgCents: 0, totalCents: 0 })).toBe(
      "83 transactions, none of them spending",
    );
  });

  test("one transaction is singular", () => {
    expect(historyLine({ count: 1, outCount: 0, avgCents: 0, totalCents: 0 })).toBe(
      "1 transaction, none of them spending",
    );
  });

  test("the mean is always total ÷ the count the sentence names", () => {
    const h = { count: 140, outCount: 53, avgCents: 7_648, totalCents: 405_369 };
    expect(Math.round(h.totalCents / h.outCount)).toBe(h.avgCents);
  });
});
