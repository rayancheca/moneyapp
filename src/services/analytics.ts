import { cache } from "react";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories, type CategoryKind } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { activeSplitsInRange } from "./transaction-splits";

/**
 * Spending & income analytics (master-plan Phase 4).
 *
 * Authoritative semantics (schema.md invariant 7, as amended by the owner
 * decision of 2026-09-03 on `uncategorizedIds` below):
 * - Only `status='active'` transactions count — quarantined/excluded/
 *   superseded never appear.
 * - Categories of kind transfer/investment/rewards are excluded from both
 *   spending and income.
 * - Spending = expense-kind categories, netted per category: purchases
 *   (negative) and merchant refunds (positive) roll up together, displayed as
 *   positive "money out" cents. (`periodTotals`' Spent is GROSS and reports
 *   refunds apart — see spending.ts.)
 * - Uncategorized = category_id NULL OR filed on a system-kind category
 *   (`isUncategorized`). Its NEGATIVE amounts form the explicit
 *   "Uncategorized" spending bucket — never hidden, and counted in Spent. Its
 *   positive amounts are excluded everywhere (the review queue owns them).
 * - Income = POSITIVE transactions in income-kind categories, split by the
 *   assigned (sub)category; a negative row in one is left out of the figure,
 *   never subtracted from it. Investment-account dividends/interest appear by
 *   construction — they are income-kind transactions, not market movement —
 *   EXCEPT on the agent's cash account, whose income is not his (owner decision
 *   2026-09-28; `isIncome`).
 *
 * 🔴 S21, measured 2026-09-15: this header still said system-kind was excluded
 * from spending and that only NULL formed the Uncategorized bucket — three
 * weeks after `spendingBucket` began bucketing system-filed outflows. `jargon.ts`
 * grounded /categories' kind definitions in it and inherited the stale rule.
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
  /**
   * The system-kind categories — the seed's "Uncategorized" row. A transaction
   * filed on one of these IS uncategorized: it belongs to the NULL bucket.
   *
   * 🔴 Owner decision, 2026-09-03. Six rows he had filed on "Uncategorized"
   * ($92.72 of 2024 debits) were in NO total: a system-kind category is not
   * expense-kind, so the headline skipped them, and it is not NULL, so the
   * honesty bucket skipped them too. Three surfaces counted "uncategorized"
   * three ways (31 on the dashboard, 6 on /categories, 31 in the ledger's
   * filter). One word, one set: NULL or system-kind, everywhere.
   */
  uncategorizedIds: ReadonlySet<string>;
  isUncategorized(id: string | null): boolean;
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
  const uncategorizedIds: ReadonlySet<string> = new Set(rows.filter((r) => r.kind === "system").map((r) => r.id));
  const isUncategorized = (id: string | null): boolean => id === null || uncategorizedIds.has(id);
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

  return { byId, topLevelOf, subtreeIds, uncategorizedIds, isUncategorized };
}

/**
 * The SQL form of `isUncategorized`, for the queries that do not go through
 * `activeTxnsInRange`: NULL, or filed on a system-kind category. One predicate,
 * so the ledger's filter, the dashboard's count and the coverage figure cannot
 * answer "how many are uncategorized" three ways again.
 */
export function uncategorizedWhere(idx: CategoryIndex): SQL {
  const ids = [...idx.uncategorizedIds];
  return ids.length === 0
    ? isNull(transactions.categoryId)
    : (or(isNull(transactions.categoryId), inArray(transactions.categoryId, ids)) as SQL);
}

/**
 * The recurring series belonging to a category's subtree.
 *
 * Normally a series has no category of its own — its category IS the category
 * of its linked ACTIVE transactions (schema.md). `user_category_id` is the one
 * exception, for commitments that have not charged yet; see the block comment
 * inside.
 *
 * This is the ONE bridge used by the category page's "Recurring series" list,
 * the budget "expected tail" and — through `recurringSeriesIdsForSubtree` —
 * /spending's category forecast and Predict budgets, so a series can never appear in a
 * budget's forecast without also appearing on its category page (drill-down
 * contract) — which is why the override has to be applied here rather than in
 * budgetTail, or the two surfaces would disagree.
 */
export function recurringSeriesIdsForCategory(db: AppDatabase, categoryId: string): Set<string> {
  return recurringSeriesIdsForSubtree(db, loadCategoryIndex(db).subtreeIds(categoryId));
}

/**
 * `recurringSeriesIdsForCategory` for a caller already holding the subtree —
 * the /spending forecast walks every category over one index, and reloading
 * it per category is the query-building cost the perf doctrine measured.
 */
export function recurringSeriesIdsForSubtree(db: AppDatabase, subtree: readonly string[]): Set<string> {
  // Series-to-category MEMBERSHIP keys on the parent row's (stamped) categoryId,
  // NOT the split parts. A recurring bill split across categories (rent+utilities)
  // must belong to ONE category — its dominant/representative one — or budgetTail
  // and predictWith would project the WHOLE bill amount into every category the
  // split touches (double-counting). Spend ACTUALS still follow the split parts
  // via activeTxnsInRange/recurringPostedCents; only forecast membership does not.
  /*
   * `user_category_id` is an OVERRIDE, not a union, and the distinction is the
   * whole point. A commitment the owner has entered but which has not charged
   * yet — a lease signed today, first payment next month — has no posted rows,
   * so the derivation below can never find it and its budget would read "no
   * data" while he pays it. But a series that ALSO has posted rows under some
   * other category must not appear in both: budgetTail would then project the
   * full amount into each. So an overridden series is removed from the
   * posted-row set entirely and counted only where the owner put it.
   */
  const overridden = db
    .select({ id: recurringSeries.id, categoryId: recurringSeries.userCategoryId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.userCategoryId))
    .all();
  const overriddenIds = new Set(overridden.map((r) => r.id));

  const rows = db
    .selectDistinct({ seriesId: transactions.recurringSeriesId })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNotNull(transactions.recurringSeriesId),
        inArray(transactions.categoryId, [...subtree]),
      ),
    )
    .all();

  const ids = new Set(
    rows
      .map((r) => r.seriesId)
      .filter((v): v is string => v !== null)
      .filter((seriesId) => !overriddenIds.has(seriesId)),
  );
  for (const row of overridden) {
    if (row.categoryId !== null && subtree.includes(row.categoryId)) ids.add(row.id);
  }
  return ids;
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
  /** the recurring series this row is attributed to, when it is one's payment */
  recurringSeriesId: string | null;
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
/**
 * ⚡ MEMOISED FOR ONE SERVER RENDER — `react`'s `cache`, for the reason spelled
 * out on `buildPortfolio` in `services/portfolio`: a result that outlives the
 * request is a wrong number the moment an import lands, and this app has no
 * invalidation signal worth trusting. `cache()` measurably does not memoise
 * outside a render, so tests and scripts behave exactly as before.
 */
const activeTxnsInRangeCached = cache(function activeTxnsInRangeCached(
  db: AppDatabase,
  from: string,
  to: string,
): AnalyticsTxn[] {
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      rawDescription: transactions.rawDescription,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      recurringSeriesId: transactions.recurringSeriesId,
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

  // ⛔ NORMALISED AT THE SOURCE: a row filed on the system "Uncategorized"
  // category reads as category-less to every aggregate built on these rows —
  // see CategoryIndex.uncategorizedIds. Split parts are judged the same way.
  const idx = loadCategoryIndex(db);
  const bucketOf = (id: string | null): string | null => (idx.isUncategorized(id) ? null : id);

  const splits = activeSplitsInRange(db, from, to);
  if (splits.size === 0) return rows.map((r) => ({ ...r, categoryId: bucketOf(r.categoryId), splitId: null }));

  const out: AnalyticsTxn[] = [];
  for (const r of rows) {
    const parts = splits.get(r.id);
    if (!parts || parts.length === 0) {
      out.push({ ...r, categoryId: bucketOf(r.categoryId), splitId: null });
      continue;
    }
    for (const p of parts) {
      out.push({ ...r, categoryId: bucketOf(p.categoryId), amountCents: p.amountCents, splitId: p.id });
    }
  }
  return out;
});

/**
 * ⛔ RETURNS A COPY, and the copy is the point. The cached array is shared by
 * every caller inside one render, and one caller sorting or splicing it in
 * place would silently rewrite what the next one reads. A `.slice()` of a few
 * thousand references costs a fraction of the 5ms query it replaces; the row
 * objects themselves are shared, which is safe under this codebase's own
 * no-mutation rule and was already true within a single caller.
 *
 * Measured on the owner's ledger: fourteen calls per dashboard render at ~5ms
 * each, for at most a handful of distinct ranges.
 */
export function activeTxnsInRange(db: AppDatabase, from: string, to: string): AnalyticsTxn[] {
  return activeTxnsInRangeCached(db, from, to).slice();
}

export interface SpendingBucket {
  categoryId: string | null;
  categoryName: string;
}

/** Which spending bucket a transaction belongs to, or null if excluded. */
export function spendingBucket(idx: CategoryIndex, txn: AnalyticsTxn): SpendingBucket | null {
  // rows from activeTxnsInRange arrive normalised; a caller handing in its own
  // rows gets the same answer
  if (txn.categoryId === null || idx.uncategorizedIds.has(txn.categoryId)) {
    // only negatives — uncategorized credits belong to the review queue
    return txn.amountCents < 0 ? { categoryId: null, categoryName: "Uncategorized" } : null;
  }
  const top = idx.topLevelOf(txn.categoryId);
  if (top.kind !== "expense") return null;
  return { categoryId: top.id, categoryName: top.name };
}

/**
 * Whether a row is Income — money HE received: a positive amount in an income-kind category, on an account whose
 * money is his. The one classifier behind every figure that says "Income": /spending's card, its chart, heatmap and
 * Sankey, /budgets' "$X in so far", the dashboard's period panel.
 *
 * ⚖️ Owner decision 2026-09-28 (§6A 27): what the AGENT'S account is paid — a dividend its shares pay, interest on
 * its uninvested cash — is not his income. `agentsCash` is `outsidePortfolioCashAccountIds` (services/accounts), the
 * rule /summary already reads, and it is POSITIONAL AND REQUIRED for the reason it is there (`lineFor`): a surface
 * cannot count income without answering whose it is. 🔴 Until then /summary refused the agent's dividend while
 * /spending's Income card, /budgets' header and the Sankey's "Dividends → Money in" all counted it as his.
 *
 * ⛔ The net-worth bridge does NOT use this. Net worth holds the agent's money, so the bridge names it on a band of
 * its own (`attribution.ts`) rather than dropping it — an exhaustive bridge cannot leave a row out.
 */
export function isIncome(
  idx: CategoryIndex,
  agentsCash: ReadonlySet<string>,
  txn: Pick<AnalyticsTxn, "accountId" | "categoryId" | "amountCents">,
): boolean {
  return (
    txn.categoryId !== null &&
    txn.amountCents > 0 &&
    idx.topLevelOf(txn.categoryId).kind === "income" &&
    !agentsCash.has(txn.accountId)
  );
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
  /**
   * Keep only the rows this returns true for — asked of each exploded row after
   * the window and before the bucket, so a split part is judged on its own.
   */
  filter?: (txn: AnalyticsTxn) => boolean;
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
    if (opts.filter && !opts.filter(txn)) continue;
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
  /**
   * What was filed on the parent ITSELF, netted like `spentCents`; 0 for the
   * Uncategorized bucket, whose rows have no parent to sit on.
   *
   * 🔴 S20. `children` skips these rows, and `/spending`'s expander listed the
   * children alone under a total that counts them — measured on the real ledger
   * 2026-09-15, `?period=2026-07` Travel $2,448.88 over Flights $2,394.89.
   * ⛔ Accumulated directly, never taken as `spentCents − Σchildren`: a
   * difference would silently absorb a child row this loop failed to count.
   */
  ownSpentCents: number;
  /** the rows behind `ownSpentCents`, counted like `txnCount` (a split part is a row) */
  ownTxnCount: number;
  /** subcategory detail — rows filed on a child; rows filed on the parent are `ownSpentCents` */
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
      ({
        categoryId: bucket.categoryId,
        name: bucket.categoryName,
        spentCents: 0,
        txnCount: 0,
        ownSpentCents: 0,
        ownTxnCount: 0,
        children: [],
      } satisfies BreakdownRow);
    const isOwn = bucket.categoryId !== null && txn.categoryId === bucket.categoryId;
    tops.set(topKey, {
      ...top,
      spentCents: top.spentCents - txn.amountCents,
      txnCount: top.txnCount + 1,
      ownSpentCents: isOwn ? top.ownSpentCents - txn.amountCents : top.ownSpentCents,
      ownTxnCount: isOwn ? top.ownTxnCount + 1 : top.ownTxnCount,
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

/** Per-month income split by Income subcategory — `isIncome`'s rows, so never the agent's. */
export function incomeByMonth(db: AppDatabase, opts: MonthsWindow): IncomeCell[] {
  const { from, to } = windowBounds(opts);
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const cells = new Map<string, IncomeCell>();

  for (const txn of activeTxnsInRange(db, from, to)) {
    if (!isIncome(idx, agentsCash, txn)) continue;
    const node = idx.byId.get(txn.categoryId!)!;
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
 * ⛔ THE NORMALISATION RUNS ONE WAY, AND THIS IS THE OTHER END OF IT.
 * `activeTxnsInRange` rewrites a row filed on the system "Uncategorized"
 * category to `categoryId: null`, so no row can ever carry that id into an
 * aggregate — and a query that ASKS for that id therefore matched nothing at
 * all. `/categories` lists "Uncategorized · Locked · 37 txn" and links to
 * `/categories/019f4c7d-…`, which read `$0.00 · 0 transactions` for every
 * period the selector can reach, and for November 2023 — a month holding three
 * of those rows — printed the empty state that asserts a measured zero in so
 * many words: "This window sits inside what has been imported, so nothing
 * posted in it — a measured zero rather than an unread window."
 *
 * The system row IS the NULL bucket (owner decision 2026-09-03, and
 * `categoryTouchCounts` already counts it that way), so asking for it asks for
 * the bucket.
 *
 * ⚠️ The two spellings are NOT the same population, deliberately:
 *   - `null` is the /spending honesty BUCKET — a spending figure, so
 *     negatives only ("uncategorized credits belong to the review queue"),
 *     and `transactionsHref` adds `flow=out` so the link lists exactly it.
 *     31 NULL outflows + 4 system-filed outflows = 35 rows.
 *   - a system ID is the CATEGORY, whose page prints a **Net** over the rows
 *     it lists and whose count must reconcile with the 37 on `/categories`.
 *     Both signs: the same 35 plus the two 2023-11-02 Capital One verification
 *     deposits ($0.11, $0.24) = 37 rows, net $1,284.93 out.
 *     ⚠️ $92.72 is the net of the SIX system-filed rows alone — the figure the
 *     2026-09-03 decision was written about. Conflating the two populations is
 *     the very error this block exists to prevent, and the first draft of this
 *     comment did it.
 * Only `/categories/[id]` reaches the second spelling; every spending surface
 * passes null. Measured 2026-09-11.
 */
export function spendingTransactions(db: AppDatabase, filter: TxnFilter): AnalyticsTxn[] {
  const rows = activeTxnsInRange(db, filter.from, filter.to);
  if (filter.categoryId === null) {
    return rows.filter((r) => r.categoryId === null && r.amountCents < 0);
  }
  const idx = loadCategoryIndex(db);
  if (idx.uncategorizedIds.has(filter.categoryId)) {
    return rows.filter((r) => r.categoryId === null);
  }
  const subtree = new Set(idx.subtreeIds(filter.categoryId));
  return rows.filter((r) => r.categoryId !== null && subtree.has(r.categoryId));
}

/**
 * The `/transactions` spelling of a category filter. The system "Uncategorized"
 * row resolves to the bucket's own param, because a link carrying its raw id
 * filters by that id alone and would list the six hand-filed rows instead of
 * the 37 the number above it counts — the drill-down contract, broken by the
 * same asymmetry `spendingTransactions` documents.
 */
export function hrefCategoryId(db: AppDatabase, categoryId: string | null): string | null {
  if (categoryId === null) return null;
  return loadCategoryIndex(db).uncategorizedIds.has(categoryId) ? null : categoryId;
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
