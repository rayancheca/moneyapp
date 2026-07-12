import type { Metadata } from "next";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { coverageStats } from "@/services/categorize";
import { countMatching, filterConditions, viewCondition } from "@/services/transactions-query";
import { claudeRunState, pendingMerchantQueue } from "@/services/claude-categorize";
import { aiSpend } from "@/services/settings";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { buildCategoryPickerOptions, byHierarchy } from "@/components/transactions/category-options";
import { FiltersBar } from "@/components/transactions/FiltersBar";
import { HeaderStrip } from "@/components/transactions/HeaderStrip";
import { NoticeBanner } from "@/components/transactions/NoticeBanner";
import { Pagination } from "@/components/transactions/Pagination";
import { ReviewInbox } from "@/components/transactions/ReviewInbox";
import { TransactionsLedger, type LedgerRow } from "@/components/transactions/TransactionsLedger";
import { ViewTabs } from "@/components/transactions/ViewTabs";
import { reviewInbox } from "@/services/review-inbox";
import { toLedgerRow } from "@/services/ledger-rows";
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

type CategoryRow = typeof categories.$inferSelect;

// countMatching / filterConditions / viewCondition all come from the
// transactions-query service (ux-overhaul-plan §3.5): the page's tab counts,
// the ledger rows, and bulk "select all matching" share ONE predicate — the
// displayed blast radius is exactly the set a bulk-by-filter action mutates.
// (The service predicate also honors amountMin/Max and escapes LIKE wildcards,
// which the page's old local copy did not.)

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
    all: countMatching(db, filters, "all"),
    review: countMatching(db, filters, "review"),
    quarantined: countMatching(db, filters, "quarantined"),
    excluded: countMatching(db, filters, "excluded"),
  };
  const totalRows = counts[filters.view];
  const totalInLedger = db.select({ n: count() }).from(transactions).get()?.n ?? 0;

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
  const ledgerRows: LedgerRow[] = rows.map((r) => toLedgerRow(r, catById));

  const coverage = coverageStats(db);
  const pendingMerchants = pendingMerchantQueue(db).length;
  const spend = aiSpend(db);
  const runState = claudeRunState(db);

  const returnQuery = filtersToQuery(filters);
  const rootCategories = allCategories
    .filter((c) => c.parentId === null && !c.isArchived)
    .sort(byHierarchy)
    .map((c) => ({ id: c.id, name: c.name }));
  const pickerOptions = buildCategoryPickerOptions(allCategories);
  // Review is a distinct surface (§3.3): the whole backlog clustered by
  // merchant, not the filtered/paginated ledger — so it skips FiltersBar.
  const inbox = filters.view === "review" ? reviewInbox(db) : null;

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
          {inbox ? (
            <ReviewInbox data={inbox} categories={pickerOptions} />
          ) : (
            <>
              <FiltersBar filters={filters} accounts={accountRows} rootCategories={rootCategories} />
              {ledgerRows.length === 0 ? (
                <EmptyState
                  title={EMPTY_FILTERED_COPY[filters.view].title}
                  description={EMPTY_FILTERED_COPY[filters.view].description}
                />
              ) : (
                <TransactionsLedger
                  rows={ledgerRows}
                  categories={pickerOptions}
                  selectionParams={params}
                  totalMatching={totalRows}
                />
              )}
              <Pagination filters={filters} totalRows={totalRows} pageSize={PAGE_SIZE} />
            </>
          )}
        </div>
      )}
    </>
  );
}
