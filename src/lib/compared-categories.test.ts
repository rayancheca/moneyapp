import { describe, expect, test } from "vitest";
import { comparedCategories } from "./compared-categories";
import { DEVIATION_UNCATEGORIZED_KEY, computeDeviationLayout, deviationRowsFrom } from "./deviation-layout";

/**
 * 🔴 "Where it went" mapped THIS period's categories alone, and looked each one's
 * prior figure up beside it — so a category that stopped spending had no row to
 * look anything up for. Measured on the owner's ledger 2026-09-15,
 * `/spending?period=2026-07` against June 2026: Government $2,250.00, Personal
 * Care $375.89 and Gambling $20.00 were in no lens of that card, while "What
 * moved" directly above counted them — Government as the largest move of the
 * fifteen. The relief said "+$588.75 against June 2026"; the change was -$2,057.14.
 *
 * The same fall `deviationRowsFrom` was written for on 2026-09-04, for What moved
 * only. This reads that rule rather than keeping a second union.
 */

const row = (categoryId: string | null, name: string, spentCents: number, txnCount: number) => ({
  categoryId,
  name,
  spentCents,
  txnCount,
});

// the categories' own July and June figures are illustrative; the three that stopped are the ledger's
const JULY = [row("travel", "Travel", 244_888, 9), row("food", "Food", 181_559, 60), row(null, "Uncategorized", 4_000, 2)];
const JUNE = [
  row("gov", "Government", 225_000, 1),
  row("food", "Food", 204_091, 70),
  row("travel", "Travel", 59_024, 3),
  row("pc", "Personal Care", 37_589, 1),
  row(null, "Uncategorized", 3_000, 1),
  row("gambling", "Gambling", 2_000, 2),
];

describe("comparedCategories — the one population Where it went compares", () => {
  test("a category that stopped spending is a row: nothing now, no entries, its prior", () => {
    const rows = comparedCategories(JULY, JUNE);

    expect(rows.map((c) => [c.categoryId, c.name, c.spentCents, c.txnCount, c.priorCents])).toEqual([
      ["travel", "Travel", 244_888, 9, 59_024],
      ["food", "Food", 181_559, 60, 204_091],
      ["gov", "Government", 0, 0, 225_000],
      ["pc", "Personal Care", 0, 0, 37_589],
      ["gambling", "Gambling", 0, 0, 2_000],
    ]);
  });

  test("its change is What moved's change: every categorized move is a row, and the sums agree", () => {
    const rows = comparedCategories(JULY, JUNE);
    const moves = deviationRowsFrom(JULY, JUNE).filter((m) => m.key !== DEVIATION_UNCATEGORIZED_KEY);
    const bars = computeDeviationLayout(deviationRowsFrom(JULY, JUNE), { width: 620, limit: 99 }).bars.filter(
      (b) => b.key !== DEVIATION_UNCATEGORIZED_KEY,
    );

    const ids = rows.map((c) => c.categoryId);
    expect(bars.map((b) => b.key).every((key) => ids.includes(key))).toBe(true);
    const change = rows.reduce((s, c) => s + c.spentCents - c.priorCents!, 0);
    expect(change).toBe(moves.reduce((s, m) => s + m.currentCents - m.previousCents, 0));
    // +$1,858.64 − $225.32 − $2,250.00 − $375.89 − $20.00
    expect(change).toBe(-101_257);
  });

  test("Uncategorized is never a row — it is the Honesty check's, in either window", () => {
    expect(comparedCategories(JULY, JUNE).some((c) => c.categoryId === DEVIATION_UNCATEGORIZED_KEY)).toBe(false);
    expect(comparedCategories([row(null, "Uncategorized", 4_000, 2)], [row(null, "Uncategorized", 1_000, 1)])).toEqual([]);
    expect(comparedCategories(JULY, null).map((c) => c.categoryId)).toEqual(["travel", "food"]);
  });

  test("this period's breakdown row rides through — the List still opens its subcategories", () => {
    const rows = comparedCategories(JULY, JUNE);

    expect(rows[0]!.current).toBe(JULY[0]);
    expect(rows[1]!.current).toBe(JULY[1]);
    expect(rows.slice(2).every((c) => c.current === null)).toBe(true);
  });

  test("with no whole comparison, this period's categories alone — and a null prior, never a zero", () => {
    expect(comparedCategories(JULY, null).map((c) => [c.categoryId, c.spentCents, c.txnCount, c.priorCents])).toEqual([
      ["travel", 244_888, 9, null],
      ["food", 181_559, 60, null],
    ]);
  });

  test("a stopped category whose prior netted a refund is a row too, and its change is a rise", () => {
    // `?period=2025-03`: Gambling netted -$84.63 in February 2025 and had no March row
    const rows = comparedCategories([row("food", "Food", 10_000, 4)], [row("gambling", "Gambling", -8_463, 3)]);

    expect(rows.map((c) => [c.categoryId, c.spentCents, c.txnCount, c.priorCents])).toEqual([
      ["food", 10_000, 4, 0],
      ["gambling", 0, 0, -8_463],
    ]);
    expect(rows[1]!.spentCents - rows[1]!.priorCents!).toBe(8_463);
  });
});
