import { DEVIATION_UNCATEGORIZED_KEY, deviationRowsFrom, type DeviationSourceRow } from "./deviation-layout";

/**
 * The categories /spending's "Where it went" card compares — the List, the relief
 * and the Table — over the SAME population "What moved" reads.
 *
 * 🔴 The card mapped THIS period's breakdown alone and looked each category's
 * prior figure up beside it, so a category that stopped spending had no row to
 * look anything up for. Measured on the owner's ledger 2026-09-15,
 * `/spending?period=2026-07` against June 2026: Government $2,250.00, Personal
 * Care $375.89 and Gambling $20.00 were in none of the card's three lenses while
 * What moved, directly above, counted all fifteen categories and named
 * Government's fall the largest move. The relief read "+$588.75 against June
 * 2026" over a change of -$2,057.14, and the Table's June column summed to
 * $9,652.10 of June's $12,297.99. 50 of the ledger's 62 whole comparisons left at
 * least one category out.
 *
 * ⛔ Not a second union: `deviationRowsFrom` owns that rule (it was written for
 * this exact fall, for What moved only), and this reads it. Uncategorized is not a
 * row here — it is the Honesty check's.
 */

export interface ComparedCategory<Row extends DeviationSourceRow> {
  categoryId: string;
  name: string;
  /** net money out this period — 0 for a category with no entries in it */
  spentCents: number;
  /** this period's entries — 0 for a category that stopped */
  txnCount: number;
  /**
   * The prior window's net for the same category, 0 when it had none there — or
   * NULL when there is no whole prior window to compare (`periodComparison`):
   * a zero is a measurement, and nothing was measured.
   */
  priorCents: number | null;
  /** this period's breakdown row, or null when the category has none (it stopped) */
  current: Row | null;
}

export function comparedCategories<Row extends DeviationSourceRow>(
  current: readonly Row[],
  /** the prior window's breakdown, or null when there is no whole prior window */
  previous: readonly DeviationSourceRow[] | null,
): ComparedCategory<Row>[] {
  const categorized = current.filter((r) => r.categoryId !== null);
  if (previous === null) {
    return categorized.map((r) => ({
      categoryId: r.categoryId!,
      name: r.name,
      spentCents: r.spentCents,
      txnCount: r.txnCount,
      priorCents: null,
      current: r,
    }));
  }
  const byId = new Map(categorized.map((r) => [r.categoryId!, r]));
  // this period's categories in their own order, then the ones that stopped
  return deviationRowsFrom(current, previous)
    .filter((move) => move.key !== DEVIATION_UNCATEGORIZED_KEY)
    .map((move) => {
      const row = byId.get(move.key) ?? null;
      return {
        categoryId: move.key,
        name: move.label,
        spentCents: move.currentCents,
        txnCount: row?.txnCount ?? 0,
        priorCents: move.previousCents,
        current: row,
      };
    });
}
