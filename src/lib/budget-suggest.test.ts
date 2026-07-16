import { describe, expect, test } from "vitest";
import { suggestBudgetAmounts, type CategorySpendMonths } from "./budget-suggest";

function cat(categoryId: string, label: string, monthly: number[]): CategorySpendMonths {
  return { categoryId, label, monthly };
}

describe("suggestBudgetAmounts", () => {
  test("suggests the monthly average, rounded UP to the nearest $10", () => {
    const out = suggestBudgetAmounts([cat("c1", "Food", [80_000, 92_000, 86_300])]);
    // avg = $861.00 → rounds up to $870
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      categoryId: "c1",
      label: "Food",
      avgCents: 86_100,
      amountCents: 87_000,
      activeMonths: 3,
    });
  });

  test("an exact multiple of $10 stays put — rounding never inflates a clean average", () => {
    const out = suggestBudgetAmounts([cat("c1", "Rent", [200_000, 200_000, 200_000])]);
    expect(out[0]!.amountCents).toBe(200_000);
  });

  test("a month with no spending counts as a real $0 month in the average", () => {
    const out = suggestBudgetAmounts([cat("c1", "Travel", [0, 60_000, 30_000])]);
    expect(out[0]!.avgCents).toBe(30_000); // (0+600+300)/3
    expect(out[0]!.activeMonths).toBe(2);
  });

  test("a one-off (spending in a single month) earns no budget", () => {
    expect(suggestBudgetAmounts([cat("c1", "One-off", [0, 0, 90_000])])).toEqual([]);
  });

  test("noise below the floor earns no budget", () => {
    expect(suggestBudgetAmounts([cat("c1", "Tiny", [500, 700, 600])])).toEqual([]);
  });

  test("net-refund months (negative) are clamped to $0, never poisoning the average", () => {
    const out = suggestBudgetAmounts([cat("c1", "Shopping", [-20_000, 60_000, 60_000])]);
    expect(out[0]!.avgCents).toBe(40_000); // (0+600+600)/3
  });

  test("sorted by suggested amount, largest first", () => {
    const out = suggestBudgetAmounts([
      cat("small", "Coffee", [3_000, 4_000, 3_500]),
      cat("big", "Rent", [200_000, 200_000, 200_000]),
    ]);
    expect(out.map((s) => s.categoryId)).toEqual(["big", "small"]);
  });

  test("empty input → empty; a category with no months → skipped", () => {
    expect(suggestBudgetAmounts([])).toEqual([]);
    expect(suggestBudgetAmounts([cat("c1", "Empty", [])])).toEqual([]);
  });
});
