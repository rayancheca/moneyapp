import { and, count, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories, type CategoryKind } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import type { TxnFilters, TxnView } from "@/components/transactions/query";

/**
 * The transactions filter/view SQL, extracted as a service (ux-overhaul-plan
 * §3.5) so the page's tab counts, the ledger rows, bulk "select all matching",
 * and blast-radius counts all share ONE predicate. The page consumes these
 * directly (its former local copy is gone), so the displayed count is exactly
 * the set a bulk-by-filter action mutates.
 */

export interface CategoryRef {
  id: string;
  parentId: string | null;
  kind: CategoryKind;
}

/** Ids whose TOP-LEVEL category has the given kind (walks the one-deep tree). */
function idsWithTopKind(allCategories: readonly CategoryRef[], kind: CategoryKind): string[] {
  const byId = new Map(allCategories.map((c) => [c.id, c]));
  return allCategories
    .filter((c) => {
      let node: CategoryRef | undefined = c;
      while (node?.parentId) node = byId.get(node.parentId);
      return node?.kind === kind;
    })
    .map((c) => c.id);
}

export function viewCondition(view: TxnView): SQL {
  switch (view) {
    case "review":
      return and(eq(transactions.status, "active"), eq(transactions.needsReview, true)) as SQL;
    case "duplicates":
      // Deliberately NOT gated on status='active'. A pair can legitimately hold
      // an `excluded` row — excluded hides a row from analytics but its money
      // still moves through balance replay, which is exactly why an excluded
      // twin double-counts net worth and why the detector admits one. Filtering
      // to active here would hide the side that makes the pair worth showing.
      return sql`${transactions.id} IN (
        SELECT transaction_id_a FROM duplicate_candidates WHERE resolution = 'unresolved'
        UNION ALL
        SELECT transaction_id_b FROM duplicate_candidates WHERE resolution = 'unresolved'
      )`;
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
  // NULL, or filed on the system "Uncategorized" category — the same set the
  // analytics index calls uncategorized (CategoryIndex.uncategorizedIds)
  const systemIds = allCategories.filter((c) => c.kind === "system").map((c) => c.id);
  const uncategorized = (): SQL =>
    systemIds.length === 0
      ? isNull(transactions.categoryId)
      : (or(isNull(transactions.categoryId), inArray(transactions.categoryId, systemIds)) as SQL);
  if (filters.category === "uncategorized") {
    // The explicit Uncategorized honesty bucket (Spending §5.4 / analytics
    // ledgerHref): land on the category-less rows, never on an empty ledger.
    conds.push(uncategorized());
  } else if (
    filters.category === "spending" ||
    filters.category === "income" ||
    filters.category === "cashflow"
  ) {
    // Kind-scoped StatCard drill-downs (Spending §5.1). These EXACTLY mirror
    // analytics' spending / income classification so the Spent / Earned cards'
    // numbers reconcile to the list they open: spending = expense-kind rows of
    // either sign (refunds net) PLUS uncategorized outflows; income = income-kind
    // positive rows.
    //
    // 🔴 `cashflow` is their UNION — the population NET is a figure over, and
    // the one card of the four whose link had no scope at all. Measured on the
    // real ledger 2026-09-11: `/spending?period=2026` printed
    // "Net -$31,733.19" over a link opening 2,682 rows that sum to
    // +$27,961.36. Its three sibling cards — Earned, Spent, Refunds — all
    // opened exactly the rows behind them; Net and Savings rate opened the
    // whole ledger for the window, transfers, card payments and investment
    // flows included.
    const expenseIds = idsWithTopKind(allCategories, "expense");
    const incomeIds = idsWithTopKind(allCategories, "income");
    const spendingScope = or(
      expenseIds.length > 0 ? inArray(transactions.categoryId, expenseIds) : sql`0 = 1`,
      and(uncategorized(), lt(transactions.amountCents, 0)),
    ) as SQL;
    const incomeScope =
      incomeIds.length > 0
        ? (and(inArray(transactions.categoryId, incomeIds), gt(transactions.amountCents, 0)) as SQL)
        : (sql`0 = 1` as SQL);
    if (filters.category === "spending") conds.push(spendingScope);
    else if (filters.category === "income") conds.push(incomeScope);
    else conds.push(or(spendingScope, incomeScope) as SQL);
  } else if (filters.category) {
    const subtreeIds = allCategories
      .filter((c) => c.id === filters.category || c.parentId === filters.category)
      .map((c) => c.id);
    // A shown category filter must scope the mutated set (blast-radius honesty).
    // If the id resolves to no rows (stale/deleted id from a bookmarked URL),
    // the scoped set is EMPTY, never the whole ledger — so force an always-false
    // predicate instead of silently dropping the condition.
    if (subtreeIds.length === 0) {
      conds.push(sql`0 = 1`);
    } else {
      // Split-aware: an UNSPLIT row matches on its own category; a SPLIT row
      // matches only when one of its parts is in the subtree (its parent
      // category is a stale display 'primary', ignored — mirrors analytics).
      conds.push(
        or(
          and(
            inArray(transactions.categoryId, subtreeIds),
            sql`NOT EXISTS (SELECT 1 FROM ${transactionSplits} WHERE ${transactionSplits.transactionId} = ${transactions.id})`,
          ),
          sql`${transactions.transferGroupId} IS NULL AND EXISTS (SELECT 1 FROM ${transactionSplits} WHERE ${transactionSplits.transactionId} = ${transactions.id} AND ${inArray(
            transactionSplits.categoryId,
            subtreeIds,
          )})`,
        ) as SQL,
      );
    }
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
  // direction filter — makes negatives-only aggregates (uncategorized outflows,
  // positive-only income segments) reconcile to their exact drill-down list
  if (filters.flow === "out") conds.push(lt(transactions.amountCents, 0));
  else if (filters.flow === "in") conds.push(gt(transactions.amountCents, 0));
  return conds;
}

function loadCategoryRefs(db: AppDatabase): CategoryRef[] {
  return db
    .select({ id: categories.id, parentId: categories.parentId, kind: categories.kind })
    .from(categories)
    .all();
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
