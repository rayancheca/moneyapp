import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories, type CategoryKind } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { addDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { activeSplitsInRange } from "./transaction-splits";

/**
 * Spending & income analytics (master-plan Phase 4).
 *
 * Authoritative semantics (schema.md invariant 7):
 * - Only `status='active'` transactions count — quarantined/excluded/
 *   superseded never appear.
 * - Categories of kind transfer/investment/rewards/system are excluded
 *   from both spending and income.
 * - Spending = expense-kind categories, netted: purchases (negative) and
 *   merchant refunds (positive) roll up together, displayed as positive
 *   "money out" cents.
 * - Uncategorized (category_id NULL) NEGATIVE amounts form an explicit
 *   "Uncategorized" spending bucket — never hidden. Uncategorized positive
 *   amounts are excluded everywhere (the review queue owns them).
 * - Income = POSITIVE transactions in income-kind categories, split by the
 *   assigned (sub)category. Investment-account dividends/interest appear by
 *   construction — they are income-kind transactions, not market movement.
 *
 * Exact reconciliation: every aggregate has a sibling transaction-list
 * function taking identical filters, and cent totals are computed from the
 * very same rows — a displayed number is always a visitable list.
 */

// ── Category index ───────────────────────────────────────────────────

export interface CategoryNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  sortOrder: number;
}

export interface CategoryIndex {
  byId: ReadonlyMap<string, CategoryNode>;
  topLevelOf(id: string): CategoryNode;
  /** The category plus all descendants (one level in practice, general here). */
  subtreeIds(id: string): string[];
}

export function loadCategoryIndex(db: AppDatabase): CategoryIndex {
  const rows = db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      kind: categories.kind,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .all();
  const byId = new Map<string, CategoryNode>(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    childrenOf.set(r.parentId, [...(childrenOf.get(r.parentId) ?? []), r.id]);
  }

  const topLevelOf = (id: string): CategoryNode => {
    let node = byId.get(id);
    if (!node) throw new Error(`Unknown category ${id}`);
    while (node.parentId) {
      const parent = byId.get(node.parentId);
      if (!parent) throw new Error(`Broken category tree at ${node.id}`);
      node = parent;
    }
    return node;
  };

  const subtreeIds = (id: string): string[] => {
    if (!byId.has(id)) throw new Error(`Unknown category ${id}`);
    const out: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      out.push(current);
      queue.push(...(childrenOf.get(current) ?? []));
    }
    return out;
  };

  return { byId, topLevelOf, subtreeIds };
}

/**
 * The recurring series whose linked ACTIVE transactions fall in a category's
 * subtree. A series carries no category column — its category IS the category
 * of its linked rows (schema.md). This is the ONE bridge used by both the
 * category page's "Recurring series" list and the budget "expected tail", so a
 * series can never appear in a budget's forecast without also appearing on its
 * category page (drill-down contract).
 */
export function recurringSeriesIdsForCategory(db: AppDatabase, categoryId: string): Set<string> {
  const subtree = loadCategoryIndex(db).subtreeIds(categoryId);
  // Series-to-category MEMBERSHIP keys on the parent row's (stamped) categoryId,
  // NOT the split parts. A recurring bill split across categories (rent+utilities)
  // must belong to ONE category — its dominant/representative one — or budgetTail
  // and predictWith would project the WHOLE bill amount into every category the
  // split touches (double-counting). Spend ACTUALS still follow the split parts
  // via activeTxnsInRange/recurringPostedCents; only forecast membership does not.
  const rows = db
    .selectDistinct({ seriesId: transactions.recurringSeriesId })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNotNull(transactions.recurringSeriesId),
        inArray(transactions.categoryId, subtree),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.seriesId).filter((v): v is string => v !== null));
}

// ── Month helpers ────────────────────────────────────────────────────

/** Last `months` month keys (oldest first), ending at refDate's month. */
export function monthKeysBack(refDate: string, months: number): string[] {
  const keys: string[] = [];
  let cursor = periodBounds(refDate, "monthly").start;
  for (let i = 0; i < months; i += 1) {
    keys.unshift(monthKey(cursor));
    cursor = periodBounds(addDays(cursor, -1), "monthly").start;
  }
  return keys;
}

// ── Shared row fetch ─────────────────────────────────────────────────

export interface AnalyticsTxn {
  id: string;
  accountId: string;
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  merchantId: string | null;
  categoryId: string | null;
  /** null = the whole transaction; set = one split part of it (its own category/amount). */
  splitId: string | null;
}

/**
 * The shared row source for every category/income aggregate. A SPLIT
 * transaction is exploded into one pseudo-row per part — each carrying the
 * part's own categoryId/amountCents (and the parent's id/date/merchant) — so
 * the per-row classifiers (spendingBucket/isIncome) attribute each part
 * independently. Parts sum to the parent, so grand totals are unchanged; only
 * category attribution moves. Unsplit transactions pass through whole.
 */
export function activeTxnsInRange(db: AppDatabase, from: string, to: string): AnalyticsTxn[] {
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      rawDescription: transactions.rawDescription,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();

  const splits = activeSplitsInRange(db, from, to);
  if (splits.size === 0) return rows.map((r) => ({ ...r, splitId: null }));

  const out: AnalyticsTxn[] = [];
  for (const r of rows) {
    const parts = splits.get(r.id);
    if (!parts || parts.length === 0) {
      out.push({ ...r, splitId: null });
      continue;
    }
    for (const p of parts) {
      out.push({ ...r, categoryId: p.categoryId, amountCents: p.amountCents, splitId: p.id });
    }
  }
  return out;
}

export interface SpendingBucket {
  categoryId: string | null;
  categoryName: string;
}

/** Which spending bucket a transaction belongs to, or null if excluded. */
export function spendingBucket(idx: CategoryIndex, txn: AnalyticsTxn): SpendingBucket | null {
  if (txn.categoryId === null) {
    // only negatives — uncategorized credits belong to the review queue
    return txn.amountCents < 0 ? { categoryId: null, categoryName: "Uncategorized" } : null;
  }
  const top = idx.topLevelOf(txn.categoryId);
  if (top.kind !== "expense") return null;
  return { categoryId: top.id, categoryName: top.name };
}

// ── Monthly spending (stacked-bar source) ────────────────────────────

export interface SpendingCell {
  month: string;
  /** null = the explicit Uncategorized bucket */
  categoryId: string | null;
  categoryName: string;
  /** positive = money out; refunds net against purchases */
  spentCents: number;
  txnCount: number;
}

export interface MonthsWindow {
  months: number;
  refDate?: string;
}

function windowBounds(opts: MonthsWindow): { from: string; to: string; keys: string[] } {
  const refDate = opts.refDate ?? todayIso();
  const keys = monthKeysBack(refDate, opts.months);
  return { from: `${keys[0]}-01`, to: periodBounds(refDate, "monthly").end, keys };
}

/** Per-month totals by TOP-LEVEL category (subcategories rolled up). */
export function monthlySpending(db: AppDatabase, opts: MonthsWindow): SpendingCell[] {
  const { from, to } = windowBounds(opts);
  const idx = loadCategoryIndex(db);
  const cells = new Map<string, SpendingCell>();

  for (const txn of activeTxnsInRange(db, from, to)) {
    const bucket = spendingBucket(idx, txn);
    if (!bucket) continue;
    const month = monthKey(txn.postedOn);
    const key = `${month}|${bucket.categoryId ?? "∅"}`;
    const cell =
      cells.get(key) ??
      ({ month, categoryId: bucket.categoryId, categoryName: bucket.categoryName, spentCents: 0, txnCount: 0 } satisfies SpendingCell);
    cells.set(key, {
      ...cell,
      spentCents: cell.spentCents - txn.amountCents,
      txnCount: cell.txnCount + 1,
    });
  }

  return [...cells.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || a.categoryName.localeCompare(b.categoryName),
  );
}

// ── Category breakdown (drill-down table source) ─────────────────────

export interface BreakdownChild {
  categoryId: string;
  name: string;
  spentCents: number;
  txnCount: number;
}

export interface BreakdownRow {
  /** null = the explicit Uncategorized bucket */
  categoryId: string | null;
  name: string;
  spentCents: number;
  txnCount: number;
  /** subcategory detail; direct-to-parent assignments count in the total only */
  children: BreakdownChild[];
}

export function categoryBreakdown(
  db: AppDatabase,
  range: { from: string; to: string },
): BreakdownRow[] {
  const idx = loadCategoryIndex(db);
  const tops = new Map<string, BreakdownRow>();
  const subs = new Map<string, BreakdownChild>();

  for (const txn of activeTxnsInRange(db, range.from, range.to)) {
    const bucket = spendingBucket(idx, txn);
    if (!bucket) continue;
    const topKey = bucket.categoryId ?? "∅";
    const top =
      tops.get(topKey) ??
      ({ categoryId: bucket.categoryId, name: bucket.categoryName, spentCents: 0, txnCount: 0, children: [] } satisfies BreakdownRow);
    tops.set(topKey, {
      ...top,
      spentCents: top.spentCents - txn.amountCents,
      txnCount: top.txnCount + 1,
    });

    if (txn.categoryId !== null && txn.categoryId !== bucket.categoryId) {
      const node = idx.byId.get(txn.categoryId)!;
      const child =
        subs.get(txn.categoryId) ??
        ({ categoryId: node.id, name: node.name, spentCents: 0, txnCount: 0 } satisfies BreakdownChild);
      subs.set(txn.categoryId, {
        ...child,
        spentCents: child.spentCents - txn.amountCents,
        txnCount: child.txnCount + 1,
      });
    }
  }

  const byDescendingSpend = (a: { spentCents: number }, b: { spentCents: number }) =>
    b.spentCents - a.spentCents;

  return [...tops.values()]
    .map((top) => ({
      ...top,
      children:
        top.categoryId === null
          ? []
          : [...subs.values()]
              .filter((c) => idx.byId.get(c.categoryId)?.parentId === top.categoryId)
              .sort(byDescendingSpend),
    }))
    .sort(byDescendingSpend);
}

// ── Income ───────────────────────────────────────────────────────────

export interface IncomeCell {
  month: string;
  /** the assigned income (sub)category — Salary, Interest, Dividends, … */
  categoryId: string;
  categoryName: string;
  incomeCents: number;
  txnCount: number;
}

/** Per-month income split by Income subcategory (positive income-kind txns). */
export function incomeByMonth(db: AppDatabase, opts: MonthsWindow): IncomeCell[] {
  const { from, to } = windowBounds(opts);
  const idx = loadCategoryIndex(db);
  const cells = new Map<string, IncomeCell>();

  for (const txn of activeTxnsInRange(db, from, to)) {
    if (txn.categoryId === null || txn.amountCents <= 0) continue;
    if (idx.topLevelOf(txn.categoryId).kind !== "income") continue;
    const node = idx.byId.get(txn.categoryId)!;
    const month = monthKey(txn.postedOn);
    const key = `${month}|${node.id}`;
    const cell =
      cells.get(key) ??
      ({ month, categoryId: node.id, categoryName: node.name, incomeCents: 0, txnCount: 0 } satisfies IncomeCell);
    cells.set(key, {
      ...cell,
      incomeCents: cell.incomeCents + txn.amountCents,
      txnCount: cell.txnCount + 1,
    });
  }

  return [...cells.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || a.categoryName.localeCompare(b.categoryName),
  );
}

// ── Trends (MoM + trailing 3-month) ──────────────────────────────────

export interface CategoryTrend {
  categoryId: string | null;
  categoryName: string;
  currentMonthCents: number;
  previousMonthCents: number;
  /** current − previous; positive = spending increased */
  momDeltaCents: number;
  /** mean of the 3 completed months before the current one, rounded */
  trailing3moAvgCents: number;
}

export function categoryTrends(db: AppDatabase, opts: { refDate?: string } = {}): CategoryTrend[] {
  const refDate = opts.refDate ?? todayIso();
  const keys = monthKeysBack(refDate, 4); // [m−3, m−2, m−1, current]
  const cells = monthlySpending(db, { months: 4, refDate });

  const byCategory = new Map<string, { name: string; byMonth: Map<string, number> }>();
  for (const cell of cells) {
    const key = cell.categoryId ?? "∅";
    const entry = byCategory.get(key) ?? { name: cell.categoryName, byMonth: new Map<string, number>() };
    entry.byMonth.set(cell.month, cell.spentCents);
    byCategory.set(key, entry);
  }

  return [...byCategory.entries()]
    .map(([key, { name, byMonth }]) => {
      const at = (i: number) => byMonth.get(keys[i]!) ?? 0;
      const current = at(3);
      const previous = at(2);
      return {
        categoryId: key === "∅" ? null : key,
        categoryName: name,
        currentMonthCents: current,
        previousMonthCents: previous,
        momDeltaCents: current - previous,
        trailing3moAvgCents: Math.round((at(0) + at(1) + at(2)) / 3),
      };
    })
    .sort((a, b) => b.currentMonthCents - a.currentMonthCents || a.categoryName.localeCompare(b.categoryName));
}

// ── Exact-reconciliation siblings ────────────────────────────────────

export interface TxnFilter {
  /** null = the Uncategorized bucket (negative, category-less txns) */
  categoryId: string | null;
  from: string;
  to: string;
}

/** A shared inclusive [from, to] date window. */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * The exact transactions behind a spending cell. A top-level categoryId
 * includes its whole subtree; null lists uncategorized negatives.
 */
export function spendingTransactions(db: AppDatabase, filter: TxnFilter): AnalyticsTxn[] {
  const rows = activeTxnsInRange(db, filter.from, filter.to);
  if (filter.categoryId === null) {
    return rows.filter((r) => r.categoryId === null && r.amountCents < 0);
  }
  const subtree = new Set(loadCategoryIndex(db).subtreeIds(filter.categoryId));
  return rows.filter((r) => r.categoryId !== null && subtree.has(r.categoryId));
}

/** The exact transactions behind an income cell (positive txns in the subtree). */
export function incomeTransactions(
  db: AppDatabase,
  filter: { categoryId: string; from: string; to: string },
): AnalyticsTxn[] {
  const subtree = new Set(loadCategoryIndex(db).subtreeIds(filter.categoryId));
  return activeTxnsInRange(db, filter.from, filter.to).filter(
    (r) => r.amountCents > 0 && r.categoryId !== null && subtree.has(r.categoryId),
  );
}

/**
 * Subtree spending for one category over a range — computed from the SAME
 * row list the drill-down shows, so budgets and analytics can never drift.
 */
export function categorySpending(
  db: AppDatabase,
  filter: TxnFilter,
): { spentCents: number; txnCount: number } {
  const txns = spendingTransactions(db, filter);
  return {
    spentCents: txns.reduce((sum, t) => sum - t.amountCents, 0),
    // distinct PARENT transactions — a split row explodes into one part-row per
    // part, so txns.length would over-count a transaction split within one subtree
    txnCount: new Set(txns.map((t) => t.id)).size,
  };
}

/**
 * /transactions link carrying the identical filter params as the aggregate.
 * The Uncategorized bucket (categoryId null) is negatives-only in the aggregate
 * (spendingTransactions), so its link adds flow=out — the drill-down then lists
 * exactly the rows behind the number (drill-down contract).
 */
export function transactionsHref(filter: TxnFilter): string {
  const params = new URLSearchParams({
    category: filter.categoryId ?? "uncategorized",
    from: filter.from,
    to: filter.to,
  });
  if (filter.categoryId === null) params.set("flow", "out");
  return `/transactions?${params.toString()}`;
}

// The pure /transactions deep-link builder lives in @/lib/ledger-href so client
// components can import it without pulling this DB-coupled module. Re-exported
// here for the many server-side callers that already import it from analytics.
export { ledgerHref, type LedgerHrefParams } from "@/lib/ledger-href";
