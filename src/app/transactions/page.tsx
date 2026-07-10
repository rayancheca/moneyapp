import type { Metadata } from "next";
import { and, asc, count, desc, eq, gte, inArray, like, lte, or, type SQL } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { coverageStats } from "@/services/categorize";
import { claudeRunState, pendingMerchantQueue } from "@/services/claude-categorize";
import { aiSpend } from "@/services/settings";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import type { CategoryOption } from "@/components/transactions/CategoryCell";
import { FiltersBar } from "@/components/transactions/FiltersBar";
import { HeaderStrip } from "@/components/transactions/HeaderStrip";
import { NoticeBanner } from "@/components/transactions/NoticeBanner";
import { Pagination } from "@/components/transactions/Pagination";
import { TransactionsTable, type TxnRowView } from "@/components/transactions/TransactionsTable";
import { ViewTabs } from "@/components/transactions/ViewTabs";
import {
  filtersToQuery,
  parseFilters,
  parseNotice,
  type TxnFilters,
  type TxnView,
} from "@/components/transactions/query";

export const metadata: Metadata = { title: "Transactions" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const LOW_CONFIDENCE_THRESHOLD = 0.8;

type CategoryRow = typeof categories.$inferSelect;

function viewCondition(view: TxnView): SQL {
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
function filterConditions(filters: TxnFilters, allCategories: readonly CategoryRow[]): SQL[] {
  const conds: SQL[] = [];
  if (filters.account) conds.push(eq(transactions.accountId, filters.account));
  if (filters.category) {
    const subtreeIds = allCategories
      .filter((c) => c.id === filters.category || c.parentId === filters.category)
      .map((c) => c.id);
    if (subtreeIds.length > 0) conds.push(inArray(transactions.categoryId, subtreeIds));
  }
  if (filters.from) conds.push(gte(transactions.postedOn, filters.from));
  if (filters.to) conds.push(lte(transactions.postedOn, filters.to));
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    const clause = or(
      like(transactions.rawDescription, pattern),
      like(transactions.normalizedDescription, pattern),
    );
    if (clause) conds.push(clause);
  }
  return conds;
}

function countTransactions(db: AppDatabase, conds: readonly SQL[]): number {
  return (
    db
      .select({ n: count() })
      .from(transactions)
      .where(and(...conds))
      .get()?.n ?? 0
  );
}

function byHierarchy(a: CategoryRow, b: CategoryRow): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

/** Flat select options: each root followed by its children as "Parent > Sub". */
function buildCategoryOptions(allCategories: readonly CategoryRow[]): CategoryOption[] {
  const live = allCategories.filter((c) => !c.isArchived);
  const roots = live.filter((c) => c.parentId === null).sort(byHierarchy);
  return roots.flatMap((root) => [
    { id: root.id, label: root.name },
    ...live
      .filter((c) => c.parentId === root.id)
      .sort(byHierarchy)
      .map((c) => ({ id: c.id, label: `${root.name} > ${c.name}` })),
  ]);
}

/** "Parent > Sub" labels for display — includes archived so history still renders. */
function buildCategoryLabels(allCategories: readonly CategoryRow[]): Map<string, string> {
  const byId = new Map(allCategories.map((c) => [c.id, c]));
  return new Map(
    allCategories.map((c) => {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      return [c.id, parent ? `${parent.name} > ${c.name}` : c.name];
    }),
  );
}

const EMPTY_FILTERED_COPY: Record<TxnView, { title: string; description: string }> = {
  all: {
    title: "No matching transactions",
    description: "Nothing matches the current filters. Adjust them or reset to see everything.",
  },
  review: {
    title: "Review queue is clear",
    description:
      "No transactions need review under the current filters — low-confidence categorizations, big uncategorized deposits, and ambiguous transfer pairs land here.",
  },
  quarantined: {
    title: "No quarantined transactions",
    description:
      "Quarantine holds transactions from statement periods that failed reconciliation. Empty is exactly what you want.",
  },
  excluded: {
    title: "No excluded transactions",
    description: "Transactions excluded by rules or by hand appear here, out of every analytic.",
  },
};

interface TransactionsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const notice = parseNotice(params);

  const db = getDb();
  const accountRows = db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .orderBy(asc(accounts.displayOrder), asc(accounts.name))
    .all();
  const allCategories = db.select().from(categories).all();

  const common = filterConditions(filters, allCategories);
  const counts: Record<TxnView, number> = {
    all: countTransactions(db, [...common, viewCondition("all")]),
    review: countTransactions(db, [...common, viewCondition("review")]),
    quarantined: countTransactions(db, [...common, viewCondition("quarantined")]),
    excluded: countTransactions(db, [...common, viewCondition("excluded")]),
  };
  const totalRows = counts[filters.view];
  const totalInLedger = countTransactions(db, []);

  const rows = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      rawDescription: transactions.rawDescription,
      normalizedDescription: transactions.normalizedDescription,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      merchantId: transactions.merchantId,
      transferGroupId: transactions.transferGroupId,
      recurringSeriesId: transactions.recurringSeriesId,
      categorizationConfidence: transactions.categorizationConfidence,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...common, viewCondition(filters.view)))
    .orderBy(desc(transactions.postedOn), desc(transactions.id))
    .limit(PAGE_SIZE)
    .offset((filters.page - 1) * PAGE_SIZE)
    .all();

  const categoryLabels = buildCategoryLabels(allCategories);
  const tableRows: TxnRowView[] = rows.map((r) => ({
    id: r.id,
    postedOn: r.postedOn,
    rawDescription: r.rawDescription,
    normalizedDescription: r.normalizedDescription,
    accountName: r.accountName,
    amountCents: r.amountCents,
    categoryId: r.categoryId,
    categoryLabel: r.categoryId ? (categoryLabels.get(r.categoryId) ?? null) : null,
    hasMerchant: r.merchantId !== null,
    isTransfer: r.transferGroupId !== null,
    isRecurring: r.recurringSeriesId !== null,
    lowConfidence:
      r.categorizationConfidence !== null && r.categorizationConfidence < LOW_CONFIDENCE_THRESHOLD,
  }));

  const coverage = coverageStats(db);
  const pendingMerchants = pendingMerchantQueue(db).length;
  const spend = aiSpend(db);
  const runState = claudeRunState(db);

  const returnQuery = filtersToQuery(filters);
  const rootCategories = allCategories
    .filter((c) => c.parentId === null && !c.isArchived)
    .sort(byHierarchy)
    .map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every transaction from your statements — deduplicated, reconciled against printed balances, and categorized."
      />

      {notice ? <NoticeBanner notice={notice} dismissHref={`/transactions${returnQuery}`} /> : null}

      <HeaderStrip
        coverage={coverage}
        pendingMerchants={pendingMerchants}
        spend={{ monthUsd: spend.monthUsd, capUsd: spend.capUsd, overCap: spend.overCap }}
        runState={runState}
        returnQuery={returnQuery}
      />

      {totalInLedger === 0 ? (
        <EmptyState
          title="Nothing imported yet"
          description="Statement ingestion (CSV, OFX/QFX, then PDF) arrives with the trust layer: begin + transactions must equal end, or the statement is flagged with its exact gap. Once transactions land, the engine categorizes them here."
          phase="Phase 2 · Ingestion"
        />
      ) : (
        <div className="space-y-4">
          <ViewTabs filters={filters} counts={counts} />
          <FiltersBar filters={filters} accounts={accountRows} rootCategories={rootCategories} />
          {tableRows.length === 0 ? (
            <EmptyState
              title={EMPTY_FILTERED_COPY[filters.view].title}
              description={EMPTY_FILTERED_COPY[filters.view].description}
            />
          ) : (
            <TransactionsTable
              rows={tableRows}
              categoryOptions={buildCategoryOptions(allCategories)}
              returnQuery={returnQuery}
            />
          )}
          <Pagination filters={filters} totalRows={totalRows} pageSize={PAGE_SIZE} />
        </div>
      )}
    </>
  );
}
