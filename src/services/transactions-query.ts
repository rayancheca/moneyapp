import { and, count, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import type { TxnFilters, TxnView } from "@/components/transactions/query";

/**
 * The transactions filter/view SQL, extracted as a service (ux-overhaul-plan
 * §3.5) so bulk "select all matching filter" and blast-radius counts share
 * ONE predicate with the page. The page keeps its local copy until the
 * Stage-1 UI package consumes this — the duplication is deliberate and
 * lives for exactly one package-cycle.
 */

export interface CategoryRef {
  id: string;
  parentId: string | null;
}

export function viewCondition(view: TxnView): SQL {
  switch (view) {
    case "review":
      return and(eq(transactions.status, "active"), eq(transactions.needsReview, true)) as SQL;
    case "quarantined":
      return eq(transactions.status, "quarantined");
    case "excluded":
      return eq(transactions.status, "excluded");
    case "all":
      return eq(transactions.status, "active");
  }
}

/** Shared filter conditions (everything except the view tab). */
export function filterConditions(
  filters: TxnFilters,
  allCategories: readonly CategoryRef[],
): SQL[] {
  const conds: SQL[] = [];
  if (filters.account) conds.push(eq(transactions.accountId, filters.account));
  if (filters.merchant) conds.push(eq(transactions.merchantId, filters.merchant));
  if (filters.category) {
    const subtreeIds = allCategories
      .filter((c) => c.id === filters.category || c.parentId === filters.category)
      .map((c) => c.id);
    // A shown category filter must scope the mutated set (blast-radius honesty).
    // If the id resolves to no rows (stale/deleted id from a bookmarked URL),
    // the scoped set is EMPTY, never the whole ledger — so force an always-false
    // predicate instead of silently dropping the condition.
    conds.push(
      subtreeIds.length > 0 ? inArray(transactions.categoryId, subtreeIds) : sql`0 = 1`,
    );
  }
  if (filters.from) conds.push(gte(transactions.postedOn, filters.from));
  if (filters.to) conds.push(lte(transactions.postedOn, filters.to));
  if (filters.q) {
    // Escape LIKE wildcards so q='_' / q='%' are literal, not match-everything.
    // Escape the backslash first, then the SQLite wildcards; ESCAPE '\' below
    // tells SQLite the backslash is the escape character.
    const escaped = filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const clause = or(
      sql`${transactions.rawDescription} LIKE ${pattern} ESCAPE '\\'`,
      sql`${transactions.normalizedDescription} LIKE ${pattern} ESCAPE '\\'`,
    );
    if (clause) conds.push(clause);
  }
  // amount filters are magnitude filters — users think "$15–$60", not signs
  // (mirrors the rule engine's amountMinCents/amountMaxCents semantics)
  if (filters.amountMinCents !== null) {
    conds.push(sql`abs(${transactions.amountCents}) >= ${filters.amountMinCents}`);
  }
  if (filters.amountMaxCents !== null) {
    conds.push(sql`abs(${transactions.amountCents}) <= ${filters.amountMaxCents}`);
  }
  return conds;
}

function loadCategoryRefs(db: AppDatabase): CategoryRef[] {
  return db.select({ id: categories.id, parentId: categories.parentId }).from(categories).all();
}

/** Server-computed blast radius for bulk confirms and the select-all copy. */
export function countMatching(db: AppDatabase, filters: TxnFilters, view: TxnView): number {
  const conds = [...filterConditions(filters, loadCategoryRefs(db)), viewCondition(view)];
  return (
    db
      .select({ n: count() })
      .from(transactions)
      .where(and(...conds))
      .get()?.n ?? 0
  );
}

/** The ids bulkApplyByFilter operates on — the exact countMatching set. */
export function matchingTransactionIds(
  db: AppDatabase,
  filters: TxnFilters,
  view: TxnView,
): string[] {
  const conds = [...filterConditions(filters, loadCategoryRefs(db)), viewCondition(view)];
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(...conds))
    .all()
    .map((r) => r.id);
}
