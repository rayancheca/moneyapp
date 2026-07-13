import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import type { LedgerRow } from "@/components/transactions/TransactionsLedger";
import { activeTxnsInRange, loadCategoryIndex, spendingBucket } from "./analytics";
import { recentLedgerRows, type CategoryRow } from "./ledger-rows";

/**
 * The dashboard's linked "activity in this period" model (dashboard-dynamic §2).
 * Brushing the net-worth chart selects an absolute [from, to] window; this
 * assembles the cross-filtered detail: a cash-flow summary, the top spending
 * categories, a transaction count, and the newest rows in the window (the same
 * interactive LedgerRows the ledger shows). The "view all" href carries the
 * exact window so the drill-down lists precisely these rows.
 *
 * "Spent" is GROSS outflow (debits only) so refunds/statement-credits in a
 * category never make it negative — on real data a window can carry tens of
 * thousands in expense-category credits (returns, reward redemptions), which
 * would drag a NET figure below zero and make "money out" read smaller than its
 * own top categories. Gross spending is always ≥ 0 and reconciles with them.
 */

export interface PeriodTopCategory {
  /** top-level category id, or null for the Uncategorized bucket */
  categoryId: string | null;
  name: string;
  hue: string | null;
  icon: string | null;
  /** gross spending magnitude (debits only) in the window, positive */
  spentCents: number;
}

export interface PeriodActivitySummary {
  from: string;
  to: string;
  /** income (money in) over the window, positive */
  inCents: number;
  /** gross spending (money out, debits only) over the window, positive */
  outCents: number;
  /** count of ALL active transactions posted in the window */
  txnCount: number;
  /** the largest spending categories in the window (top 3, gross) */
  topCategories: PeriodTopCategory[];
}

export interface PeriodActivity {
  summary: PeriodActivitySummary;
  /** the newest rows in the window, capped at the caller's limit */
  rows: LedgerRow[];
  /** /transactions filtered to exactly this window */
  href: string;
}

const TOP_CATEGORY_COUNT = 3;

/** Assembles the linked panel model for one [from, to] window. */
export function periodActivity(
  db: AppDatabase,
  from: string,
  to: string,
  rowLimit: number,
): PeriodActivity {
  const idx = loadCategoryIndex(db);
  const catById = new Map<string, CategoryRow>(
    db.select().from(categories).all().map((c) => [c.id, c]),
  );

  // one pass over the window: income, gross spending, and per-category gross
  const inRange = activeTxnsInRange(db, from, to);
  let inCents = 0;
  let outCents = 0;
  const grossByCategory = new Map<string | null, number>();
  for (const txn of inRange) {
    const bucket = spendingBucket(idx, txn);
    if (bucket) {
      // debits are money out; a credit in an expense category (a refund) is not
      // "spending" and must not net the outflow down
      if (txn.amountCents < 0) {
        const gross = -txn.amountCents;
        outCents += gross;
        grossByCategory.set(bucket.categoryId, (grossByCategory.get(bucket.categoryId) ?? 0) + gross);
      }
      continue;
    }
    // income = a positive amount in an income-kind category (matches /spending)
    if (
      txn.categoryId !== null &&
      txn.amountCents > 0 &&
      idx.topLevelOf(txn.categoryId).kind === "income"
    ) {
      inCents += txn.amountCents;
    }
  }

  const topCategories: PeriodTopCategory[] = [...grossByCategory.entries()]
    .sort((a, b) => b[1] - a[1] || labelOf(a[0], catById).localeCompare(labelOf(b[0], catById)))
    .slice(0, TOP_CATEGORY_COUNT)
    .map(([categoryId, spentCents]) => {
      const cat = categoryId ? catById.get(categoryId) : undefined;
      return {
        categoryId,
        name: cat?.name ?? "Uncategorized",
        hue: cat?.color ?? null,
        icon: cat?.icon ?? null,
        spentCents,
      };
    });

  const rows = recentLedgerRows(db, { from, to, limit: rowLimit });

  return {
    summary: { from, to, inCents, outCents, txnCount: inRange.length, topCategories },
    rows,
    href: `/transactions?${new URLSearchParams({ from, to }).toString()}`,
  };
}

/** Stable label for a top-level spending bucket (id → name, null → Uncategorized). */
function labelOf(categoryId: string | null, catById: ReadonlyMap<string, CategoryRow>): string {
  return (categoryId && catById.get(categoryId)?.name) || "Uncategorized";
}
