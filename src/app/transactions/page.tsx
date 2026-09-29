import type { Metadata } from "next";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { listAccountOptions, outsidePortfolioCashAccountIds } from "@/services/accounts";
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
import { listDuplicatePairs, openDuplicateCount } from "@/services/duplicate-resolution";
import { DuplicatePairs } from "@/components/transactions/DuplicatePairs";
import { toLedgerRow } from "@/services/ledger-rows";
import { splitCountsByTxn } from "@/services/transaction-splits";
import {
  filtersToQuery,
  clampPage,
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
  duplicates: {
    title: "No duplicate charges found",
    description:
      "Nothing here means no charge is recorded twice. Pairs land here when two different files record the same money — usually after a statement closes a gap that had put its own rows aside.",
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
  const parsed = parseFilters(params);
  const notice = parseNotice(params);
  // All four redirect actions come back through `returnPath` (transactions/actions.ts:121)
  // with `&error=`; `parseNotice` matches a fixed enum and cannot carry an arbitrary
  // message, so without this the refusal was dropped and the page re-rendered unchanged.
  const error = errorParam(params);

  const db = getDb();
  // 🔴 this page ran its own `orderBy(displayOrder, name)` — a within-institution
  // ordinal used as a global one. See `listAccountOptions`.
  const accountRows = listAccountOptions(db);
  const allCategories = db.select().from(categories).all();

  // the page number cannot change a COUNT, so these run off the parsed filters
  // and the clamp below reads them
  const common = filterConditions(parsed, allCategories, [...outsidePortfolioCashAccountIds(db)]);
  const counts: Record<TxnView, number> = {
    all: countMatching(db, parsed, "all"),
    review: countMatching(db, parsed, "review"),
    // Pairs, not rows: the tab counts the questions the owner has to answer,
    // and one question always has two rows behind it.
    duplicates: openDuplicateCount(db),
    quarantined: countMatching(db, parsed, "quarantined"),
    excluded: countMatching(db, parsed, "excluded"),
  };
  /*
   * 🔴 `clampPage` was written for exactly this, tested, and never called.
   * `?page=9999` survived `parseFilters` (which has no counts) and rendered
   *
   *     No matching transactions
   *     Nothing matches the current filters. Adjust them or reset to see everything.
   *     Page 9999 of 204 · 10178 transactions
   *
   * — an empty state saying the filters match nothing, over a line saying 10,178
   * rows match them, over a page number the ledger does not have. Its own
   * docstring names the symptom: "would otherwise render 'Page 99999 of 194'
   * over an empty page with a working Previous link."
   */
  const totalRows = counts[parsed.view];
  const filters = clampPage(parsed, totalRows, PAGE_SIZE);
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
    // the badge asks what the series IS, not whether there is one — both
    // queries that select these columns LEFT JOIN recurring_series for it
    seriesStatus: recurringSeries.status,
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
    // many-to-one on a primary key: the row count, order and every offset below
    // (`neighbourDay`) are unchanged by it
    .leftJoin(recurringSeries, eq(transactions.recurringSeriesId, recurringSeries.id))
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

  /*
   * ⛔ THE ROW ON EITHER SIDE OF THE CUT. A day group is only "partial" when the
   * neighbouring page continues THAT DAY, and this is the one side that can see
   * across its own slice — see `pageBoundary`, which flagged both edges of every
   * boundary until this existed. Two indexed lookups on the same order and the
   * same filters; `offset` alone can address them, so neither reads a page.
   */
  const neighbourDay = (offset: number): string | null => {
    if (offset < 0) return null;
    const row = db
      .select({ postedOn: transactions.postedOn })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...common, viewCondition(filters.view)))
      .orderBy(...ledgerOrder)
      .limit(1)
      .offset(offset)
      .all()[0];
    return row?.postedOn ?? null;
  };
  const consumedBefore = (filters.page - 1) * PAGE_SIZE;
  const previousDay = consumedBefore > 0 ? neighbourDay(consumedBefore - 1) : null;
  const nextDay = rows.length > 0 ? neighbourDay(consumedBefore + rows.length) : null;

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
  // the filter has its own Uncategorized option, which now covers the system
  // category too — listing that category as well would be the same set twice
  const rootCategories = allCategories
    .filter((c) => c.parentId === null && !c.isArchived && c.kind !== "system")
    .sort(byHierarchy)
    .map((c) => ({ id: c.id, name: c.name }));
  const pickerOptions = buildCategoryPickerOptions(allCategories);
  // Review is a distinct surface (§3.3): the whole backlog clustered by
  // merchant, not the filtered/paginated ledger — so it skips FiltersBar.
  const inbox = filters.view === "review" ? reviewInbox(db) : null;
  // Duplicates is its own surface too, and for a stronger reason than Review:
  // the question is about a PAIR, and neither the cluster model nor the ledger
  // can express a relationship between two specific rows.
  const duplicatePairs = filters.view === "duplicates" ? listDuplicatePairs(db) : null;

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
          .leftJoin(recurringSeries, eq(transactions.recurringSeriesId, recurringSeries.id))
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
          {duplicatePairs ? (
            duplicatePairs.length === 0 ? (
              <EmptyState
                title={EMPTY_FILTERED_COPY.duplicates.title}
                description={EMPTY_FILTERED_COPY.duplicates.description}
              />
            ) : (
              <DuplicatePairs pairs={duplicatePairs} />
            )
          ) : inbox ? (
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
                  previousDay={previousDay}
                  nextDay={nextDay}
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
