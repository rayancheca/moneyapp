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
import { CategorizeMode } from "@/components/transactions/CategorizeMode";
import { FiltersBar } from "@/components/transactions/FiltersBar";
import { HeaderStrip } from "@/components/transactions/HeaderStrip";
import { NoticeBanner } from "@/components/transactions/NoticeBanner";
import { Pagination } from "@/components/transactions/Pagination";
import { ReviewInbox } from "@/components/transactions/ReviewInbox";
import { TransactionsLedger, type LedgerRow } from "@/components/transactions/TransactionsLedger";
import { ViewTabs } from "@/components/transactions/ViewTabs";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { reviewInbox } from "@/services/review-inbox";
import { toLedgerRow } from "@/services/ledger-rows";
import { splitCountsByTxn } from "@/services/transaction-splits";
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
  // All four redirect actions come back through `returnPath` (transactions/actions.ts:121)
  // with `&error=`; `parseNotice` matches a fixed enum and cannot carry an arbitrary
  // message, so without this the refusal was dropped and the page re-rendered unchanged.
  const error = errorParam(params);

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

  const ledgerColumns = {
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
    importFileId: transactions.importFileId,
    accountName: accounts.name,
  } as const;

  // content-column tiebreaks: stable across re-imports/reseeds (see below).
  const ledgerOrder = [
    desc(transactions.postedOn),
    desc(transactions.amountCents),
    desc(transactions.rawDescription),
    asc(accounts.name),
    asc(transactions.occurrenceIndex),
    desc(transactions.id),
  ] as const;

  const rows = db
    .select(ledgerColumns)
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...common, viewCondition(filters.view)))
    // content-column tiebreaks (ledgerOrder): stable across re-imports/reseeds —
    // ids encode insertion time and dedupeHash embeds the per-seed account id,
    // both of which shuffle same-day rows between otherwise identical databases;
    // account name + occurrenceIndex carry the order, id is the byte-identical
    // fallback (which renders identically, so it never moves a pixel).
    .orderBy(...ledgerOrder)
    .limit(PAGE_SIZE)
    .offset((filters.page - 1) * PAGE_SIZE)
    .all();

  const catById = new Map(allCategories.map((c) => [c.id, c]));
  const ledgerSplitCounts = splitCountsByTxn(db, rows.map((r) => r.id));
  const ledgerRows: LedgerRow[] = rows.map((r) => ({
    ...toLedgerRow(r, catById),
    splitCount: ledgerSplitCounts.get(r.id) ?? 0,
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
  const pickerOptions = buildCategoryPickerOptions(allCategories);
  // Review is a distinct surface (§3.3): the whole backlog clustered by
  // merchant, not the filtered/paginated ledger — so it skips FiltersBar.
  const inbox = filters.view === "review" ? reviewInbox(db) : null;

  // The guided one-by-one Categorize walk (§3.2) gets the WHOLE flagged backlog
  // (capped) as ledger rows, ordered like the ledger — so a category set on the
  // card runs the same shared correction flow.
  const CATEGORIZE_CAP = 200;
  const categorizeSource =
    filters.view === "review"
      ? db
          .select(ledgerColumns)
          .from(transactions)
          .innerJoin(accounts, eq(transactions.accountId, accounts.id))
          .where(and(eq(transactions.status, "active"), eq(transactions.needsReview, true)))
          .orderBy(...ledgerOrder)
          .limit(CATEGORIZE_CAP)
          .all()
      : [];
  const categorizeSplitCounts = splitCountsByTxn(db, categorizeSource.map((r) => r.id));
  const categorizeRows: LedgerRow[] = categorizeSource.map((r) => ({
    ...toLedgerRow(r, catById),
    splitCount: categorizeSplitCounts.get(r.id) ?? 0,
  }));

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every transaction from your statements — deduplicated, reconciled against printed balances, and categorized."
      />

      {/* Above the notice deliberately: `notice` reports a success, `error` a refusal,
          and the refusal is the one the reader has to act on. Both sit above the
          `totalInLedger === 0` branch below so neither state can swallow them. */}
      {error && <ErrorBanner message={error} />}

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
            <>
              {/* CategorizeMode renders its own launcher when there is a backlog,
                  and keeps an in-progress walk alive even if the backlog empties */}
              <CategorizeMode rows={categorizeRows} categories={pickerOptions} />
              <ReviewInbox data={inbox} categories={pickerOptions} />
            </>
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
                  pageSize={PAGE_SIZE}
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
