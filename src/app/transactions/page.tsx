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
import type { CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { FiltersBar } from "@/components/transactions/FiltersBar";
import { HeaderStrip } from "@/components/transactions/HeaderStrip";
import { NoticeBanner } from "@/components/transactions/NoticeBanner";
import { Pagination } from "@/components/transactions/Pagination";
import { TransactionsLedger, type LedgerRow } from "@/components/transactions/TransactionsLedger";
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
  if (filters.merchant) conds.push(eq(transactions.merchantId, filters.merchant));
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

/** Flat picker options: each root then its children (indented), each carrying
 * the category identity (hue/icon; children inherit the root's when unset). */
function buildCategoryPickerOptions(allCategories: readonly CategoryRow[]): CategoryPickerOption[] {
  const live = allCategories.filter((c) => !c.isArchived);
  const roots = live.filter((c) => c.parentId === null).sort(byHierarchy);
  return roots.flatMap((root) => [
    { id: root.id, name: root.name, label: root.name, hue: root.color, icon: root.icon, depth: 0 },
    ...live
      .filter((c) => c.parentId === root.id)
      .sort(byHierarchy)
      .map((c) => ({
        id: c.id,
        name: c.name,
        label: `${root.name} > ${c.name}`,
        hue: c.color ?? root.color,
        icon: c.icon ?? root.icon,
        depth: 1,
      })),
  ]);
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
      needsReview: transactions.needsReview,
      status: transactions.status,
      notes: transactions.notes,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...common, viewCondition(filters.view)))
    // content-column tiebreaks: stable across re-imports/reseeds (ids encode
    // insertion time and dedupeHash embeds the per-seed account id — both
    // shuffle same-day rows between otherwise identical databases). rawDescription
    // alone doesn't disambiguate two same-day/same-amount rows that differ by
    // account or occurrence, so account name + occurrenceIndex carry the order;
    // id is only an absolute fallback for rows that are otherwise byte-identical
    // (and therefore render identically, so it never moves a pixel).
    .orderBy(
      desc(transactions.postedOn),
      desc(transactions.amountCents),
      desc(transactions.rawDescription),
      asc(accounts.name),
      asc(transactions.occurrenceIndex),
      desc(transactions.id),
    )
    .limit(PAGE_SIZE)
    .offset((filters.page - 1) * PAGE_SIZE)
    .all();

  const catById = new Map(allCategories.map((c) => [c.id, c]));
  const ledgerRows: LedgerRow[] = rows.map((r) => {
    const cat = r.categoryId ? catById.get(r.categoryId) : undefined;
    // children inherit the parent hue/icon where their own is unset (§2.3)
    const parent = cat?.parentId ? catById.get(cat.parentId) : undefined;
    return {
      id: r.id,
      postedOn: r.postedOn,
      rawDescription: r.rawDescription,
      normalizedDescription: r.normalizedDescription,
      accountName: r.accountName,
      amountCents: r.amountCents,
      categoryId: r.categoryId,
      categoryName: cat ? cat.name : null,
      hue: cat?.color ?? parent?.color ?? null,
      icon: cat?.icon ?? parent?.icon ?? null,
      merchantId: r.merchantId,
      isTransfer: r.transferGroupId !== null,
      isRecurring: r.recurringSeriesId !== null,
      needsReview: r.needsReview,
      status: r.status,
      notes: r.notes,
      lowConfidence:
        r.categorizationConfidence !== null && r.categorizationConfidence < LOW_CONFIDENCE_THRESHOLD,
      suggestedCategoryIds: [],
    };
  });

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
        />
      ) : (
        <div className="space-y-4">
          <ViewTabs filters={filters} counts={counts} />
          <FiltersBar filters={filters} accounts={accountRows} rootCategories={rootCategories} />
          {ledgerRows.length === 0 ? (
            <EmptyState
              title={EMPTY_FILTERED_COPY[filters.view].title}
              description={EMPTY_FILTERED_COPY[filters.view].description}
            />
          ) : (
            <TransactionsLedger rows={ledgerRows} categories={buildCategoryPickerOptions(allCategories)} />
          )}
          <Pagination filters={filters} totalRows={totalRows} pageSize={PAGE_SIZE} />
        </div>
      )}
    </>
  );
}
