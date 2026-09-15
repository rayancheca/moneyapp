import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { todayIso } from "@/lib/dates";
import { emptyPeriodCopy, emptyPeriodReason } from "@/lib/empty-period";
import { formatDayLong } from "@/lib/format-date";
import { cashEarningsSectionNotes } from "@/lib/section-notes";
import { comparedCategories } from "@/lib/compared-categories";
import { deviationRowsFrom } from "@/lib/deviation-layout";
import { paceWindowName } from "@/lib/pace-readout";
import { spendingShareBase } from "@/lib/insight-facts";
import {
  heatmapInitialMonth,
  periodParams as periodParamsOf,
  periodQuery,
  parsePeriodParams,
  resolvePeriod,
} from "@/lib/period";
import { WHERE_VIEW_SPEC } from "@/lib/massif-layout";
import { resolveViewState, viewStateToParams } from "@/lib/view-state";
import { spendingSubcategoryItems } from "@/lib/subcategory-rows";
import { categoryBreakdown } from "@/services/analytics";
import { cashEarningsReadings } from "@/services/cash-earnings";
import { spendingSankey } from "@/services/sankey";
import { predictBudgetableCategories } from "@/services/category-forecast";
import { readSettings } from "@/services/settings";
import { ledgerOpens, ledgerReaches } from "@/services/observation-frontier";
import { spendingInsights } from "@/services/spending-insights";
import {
  cashFlowByPeriod,
  dailySpendHeatmap,
  dayLedgerHref,
  honestyBuckets,
  largestTransactions,
  periodComparison,
  spendingProjection,
  topMerchants,
  ledgerFirstDay,
} from "@/services/spending";
import { EmptyState } from "@/components/ui/EmptyState";
import { InsightList } from "@/components/insights/InsightList";
import { SectionNotes } from "@/components/insights/SectionNotes";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { WhereItWentPanel, type WhereItWentRow } from "@/components/charts/CategoryMassif";
import { CategoryDeviation } from "@/components/spending/CategoryDeviation";
import { CashFlowView } from "@/components/spending/CashFlowView";
import { CASH_VIEW_SPEC, SPENDING_SURFACE } from "@/components/spending/spending-view-spec";
import { HonestyBucketsCard } from "@/components/spending/HonestyBucketsCard";
import { LargestPurchases, type LargestPurchaseRow } from "@/components/spending/LargestPurchases";
import { PeriodSelector } from "@/components/spending/PeriodSelector";
import { SpendHeatmap } from "@/components/spending/SpendHeatmap";
import { SpendingCategoriesTable, type CategoryTableRow } from "@/components/spending/SpendingCategoriesTable";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { provenanceFor } from "@/services/provenance";
import { SpendingStatCards } from "@/components/spending/SpendingStatCards";
import { TopMerchantsCard } from "@/components/spending/TopMerchantsCard";

export const metadata: Metadata = { title: "Spending" };
export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | null {
  const s = Array.isArray(value) ? value[0] : value;
  return typeof s === "string" && s !== "" ? s : null;
}

export default async function SpendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const today = todayIso();
  const db = getDb();
  // "All time" needs the ledger's real first day, or it draws years of empty
  // axis before the first transaction
  const period = resolvePeriod(
    parsePeriodParams({ period: firstParam(raw.period), from: firstParam(raw.from), to: firstParam(raw.to) }),
    today,
    ledgerFirstDay(db) ?? undefined,
  );
  const range = { from: period.from, to: period.to };

  const cashFlow = cashFlowByPeriod(db, period, today);
  /*
   * 🔴 WHETHER THERE IS A PRIOR WINDOW TO STATE A CHANGE AGAINST — asked ONCE.
   * Every lens below that prints a delta (What moved; the relief's heights and
   * the Table's Prior/Change/%; the List delta; the cash-flow ghost, its column
   * and its "$Z in <prior>") used to take the paging rule's previous window and
   * never ask whether the ledger holds it. Measured 2026-09-14: `?period=ALL`
   * read "All time against Aug 4, 2018 – Aug 24, 2022 — 20 up · 0 down" over a
   * window of 0 rows. They all read this one answer now, so no two of them can
   * disagree about whether a comparison exists — or over which days.
   */
  const comparison = periodComparison(db, period, today);
  const projection = spendingProjection(db, period, today, cashFlow.pace, cashFlow.totals.spentCents, comparison);
  const sankey = spendingSankey(db, range);
  const merchants = topMerchants(db, range);

  /*
   * What this page's income figure cannot see. Its totals count DEPOSITS, which
   * for a cash job is a record of ATM trips rather than of earnings — July 2026
   * reported $52.95 of income while a confirmed $1,046-a-week schedule ran the
   * whole month. The note is measured, never added to any total.
   */
  /*
   * PHASE III-B. Sentences the app wrote about its own ledger, each one checked
   * against a typed fact before it could exist (`lib/insight-grammar`). It does
   * NOT follow the period selector: its window is the newest month every
   * account has been imported through, which `moversCard` owns, and every
   * sentence names that window itself.
   */
  const insights = spendingInsights(db, today);

  const cashNotes = cashEarningsSectionNotes({
    // measured against how far the pay's own account has been READ, not only the calendar
    rows: cashEarningsReadings(db, { from: range.from, to: range.to, today, withChecked: true }),
    formatDay: formatDayLong,
  });

  // switchable-view state (NS#2 Pillar 2): URL > persisted preference > default.
  // Two INDEPENDENT dimensions on this surface — the cash-flow card's renderer
  // and the "Where it went" card's lens — sharing one persisted record, which
  // saveViewPreferenceAction merges per key.
  const persistedViews = readSettings(db).viewPreferences[SPENDING_SURFACE];
  const cashView = resolveViewState(CASH_VIEW_SPEC, { cash: firstParam(raw.cash) ?? undefined }, persistedViews);
  const whereView = resolveViewState(
    WHERE_VIEW_SPEC,
    // the relief's camera is real view state now, resolved beside the lens it belongs to
    { where: firstParam(raw.where) ?? undefined, massifView: firstParam(raw.massifView) ?? undefined },
    persistedViews,
  );
  // params to preserve when switching views: the current period, and the OTHER
  // card's lens — so flipping one card never drops the other out of the URL.
  const periodParams: Record<string, string> = periodParamsOf(period);
  // ⛔ every link OUT of this page carries the window this page measured —
  // a bare /categories/<id> silently means "the current month", which on this
  // ledger is a month with nothing in it. `lib/period` owns the rule.
  const query = periodQuery(period);
  const baseParams: Record<string, string> = {
    ...periodParams,
    ...viewStateToParams(WHERE_VIEW_SPEC, whereView),
  };
  const whereBaseParams: Record<string, string> = {
    ...periodParams,
    ...viewStateToParams(CASH_VIEW_SPEC, cashView),
  };
  const honesty = honestyBuckets(db, range);
  const heatMonth = heatmapInitialMonth(period, today);
  const heatmap = dailySpendHeatmap(db, heatMonth);

  const catMeta = new Map(
    db
      .select({ id: categories.id, name: categories.name, color: categories.color, icon: categories.icon })
      .from(categories)
      .all()
      .map((c) => [c.id, c]),
  );

  // categories table: this-period breakdown vs the previous period for MoM —
  // and only where the two periods are compared WHOLE
  const breakdown = categoryBreakdown(db, range);
  const prevBreakdown = comparison.kind === "whole" ? categoryBreakdown(db, comparison.prior) : null;
  /*
   * 🔴 THE CATEGORIES "Where it went" COMPARES — one population for its three
   * lenses, and the one What moved reads (`lib/compared-categories`).
   * Measured 2026-09-15, `?period=2026-07`: the card mapped July's categories
   * alone, so Government ($2,250.00 in June, nothing in July), Personal Care and
   * Gambling were in no lens of it, and the relief read "+$588.75 against June
   * 2026" beneath a What moved counting 9 of 15 categories down. The change was
   * -$2,057.14.
   */
  const compared = comparedCategories(breakdown, prevBreakdown);
  // The List prints a change only month over month (`showDelta`). A List that
  // prints none lists what THIS period spent, where a $0.00 row says nothing.
  const listCompares = period.granularity === "month" && prevBreakdown !== null;
  /*
   * "What moved" reads the two windows the comparison names, over their UNION
   * (`deviationRowsFrom` owns that rule and its measurement): the whole periods —
   * the same two breakdowns the categories table compares — or the days both
   * were CUT to.
   *
   * 🔴 S1/S2, measured 2026-09-14: `?period=2026-09&where=relief` read
   * "September 2026 against August 2026 — 2 up · 7 down" and "Housing …
   * -$2,229.85 on August 2026" — two unimported days, and nothing past Aug 12
   * for Chase Checking, against a whole August holding the rent.
   *
   * ⛔ When cut, What moved is the ONLY panel that states a change. Where it
   * went, the List delta and the cash-flow ghost take the null-prior path: a
   * block's footprint is the whole period's spending and cannot also carry a
   * change measured over part of it (owner decision 2026-09-14, 3a).
   */
  const deviationRows =
    comparison.kind === "whole" && prevBreakdown !== null
      ? deviationRowsFrom(breakdown, prevBreakdown)
      : comparison.kind === "clipped"
        ? deviationRowsFrom(categoryBreakdown(db, comparison.current), categoryBreakdown(db, comparison.prior))
        : [];
  // Share denominator = gross positive spending across categories. The NET total
  // (cashFlow.totals.spentCents) can be dragged below an individual category's
  // gross by refund/reimbursement-heavy categories that net to an inflow, which
  // would push shares past 100% or negative — so sum only the positive spends.
  // ⛔ `spendingShareBase`, the same author the Table lens and the relief divide
  // by: three hand copies of this line existed, and the relief's diverged.
  const shareBase = spendingShareBase(breakdown.filter((r) => r.categoryId !== null));
  // Next-month per-category forecast (recurring baseline + trend/seasonal
  // discretionary) — the SAME engine /budgets' Predict-budgets uses, surfaced
  // read-only here. Only meaningful when the page is on a month (the forecast
  // always targets the NEXT full calendar month); a 0-confidence prediction is
  // noise, so it is dropped.
  // Only on the CURRENT month: the engine forecasts the NEXT calendar month, so
  // it is a "what's coming" companion to this month — showing it next to a PAST
  // month's actuals would be confusing (an unrelated future number).
  const predictions =
    period.granularity === "month" && period.isCurrent ? predictBudgetableCategories(db, today) : [];
  const forecastByCategory = new Map(
    predictions
      .filter((p) => p.forecast.confidence > 0)
      .map((p) => [
        p.categoryId,
        {
          cents: p.forecast.expectedTotalCents,
          confidence: p.forecast.confidence,
          basis: p.forecast.basis,
          seasonal: p.seasonalApplied,
        },
      ]),
  );
  const forecastMonthLabel = predictions[0]?.periodLabel ?? null;

  // a category that stopped is a $0.00 row carrying its fall, where the List prints one
  const spentRows: CategoryTableRow[] = (listCompares ? compared : compared.filter((c) => c.current !== null)).map(
    (c) => ({
      categoryId: c.categoryId,
      name: c.name,
      hue: catMeta.get(c.categoryId)?.color ?? null,
      icon: catMeta.get(c.categoryId)?.icon ?? null,
      spentCents: c.spentCents,
      sharePct: shareBase > 0 ? (Math.max(0, c.spentCents) / shareBase) * 100 : 0,
      momDeltaCents: c.priorCents === null ? 0 : c.spentCents - c.priorCents,
      forecast: forecastByCategory.get(c.categoryId) ?? null,
      // 🔴 S20: the children alone did not add up to the parent above them — the
      // rows filed on the parent itself were in no row (`lib/subcategory-rows`).
      // A category with no row this period has no children in it either.
      children: c.current === null ? [] : spendingSubcategoryItems(c.current, (id) => `/categories/${id}?${query}`),
    }),
  );

  // Categories with a confident next-month forecast (an upcoming recurring bill,
  // typically) but NO spend this period get no breakdown row — surface them as
  // $0 "upcoming" rows at the end, so the most useful forecast (a charge you
  // haven't seen yet) is not silently dropped.
  const shownIds = new Set(spentRows.map((r) => r.categoryId));
  const upcomingRows: CategoryTableRow[] = predictions
    .filter((p) => p.forecast.confidence > 0 && !shownIds.has(p.categoryId))
    .map((p) => ({
      categoryId: p.categoryId,
      name: p.label,
      hue: catMeta.get(p.categoryId)?.color ?? null,
      icon: catMeta.get(p.categoryId)?.icon ?? null,
      spentCents: 0,
      sharePct: 0,
      momDeltaCents: 0,
      forecast: {
        cents: p.forecast.expectedTotalCents,
        confidence: p.forecast.confidence,
        basis: p.forecast.basis,
        seasonal: p.seasonalApplied,
      },
      children: [],
    }));
  const categoryRows: CategoryTableRow[] = [...spentRows, ...upcomingRows];

  // The relief/table lenses of the SAME card, cut from the SAME compared
  // categories the list above is: this period against the previous one, with
  // the entry count the footprint depth encodes. A category that stopped IS
  // here — the Table prints it at $0.00 with its fall, and the relief counts the
  // fall in its total and names it beside a plate it has no footprint on
  // (`MassifLayout.absent`). Forecast-only "upcoming" rows are not: they were in
  // neither window, and the list lens still shows them.
  const whereRows: WhereItWentRow[] = compared.map((c) => ({
    categoryId: c.categoryId,
    name: c.name,
    hue: catMeta.get(c.categoryId)?.color ?? null,
    spentCents: c.spentCents,
    // ⛔ null, never 0, when there is no comparable prior window: a zero is a
    // measurement, and every block would rise by its whole spend
    priorCents: c.priorCents,
    txnCount: c.txnCount,
  }));
  // The identity the relief states under itself, from the SAME two services the
  // stat cards use: Σ categories + uncategorized = gross spent − refunds.
  // categoryBreakdown books a refund as a negative in its category's bucket, so
  // its rows sum to NET money out; periodTotals keeps the two sides apart.
  const massifTotals = {
    blocksCents: whereRows.reduce((sum, r) => sum + r.spentCents, 0),
    uncategorizedCents: breakdown.find((r) => r.categoryId === null)?.spentCents ?? 0,
    grossSpentCents: cashFlow.totals.spentCents,
    refundsCents: cashFlow.totals.refundsCents,
  };

  const largest: LargestPurchaseRow[] = largestTransactions(db, range).map((t) => {
    const meta = t.categoryId ? catMeta.get(t.categoryId) : undefined;
    return {
      id: t.id,
      postedOn: t.postedOn,
      description: t.rawDescription,
      amountCents: t.amountCents,
      accountName: t.accountName,
      categoryName: meta?.name ?? null,
      hue: meta?.color ?? null,
      icon: meta?.icon ?? null,
      ledgerHref: dayLedgerHref(t.postedOn),
    };
  });

  /**
   * What the period's WHOLE spending is standing on — the biggest figure on
   * this page, and until now the only one with no way to check it.
   *
   * ⛔ Mounted on the heading, not on a StatCard. `StatCard` wraps its entire
   * tile in a `<Link>` when it has an href, and every card here does; a
   * `<button>` inside one is axe `nested-interactive` (serious), which is the
   * trap `ProvenancePopover` documents. The `<h2>` below is a flow container
   * and is not inside a link.
   *
   * ⚠️ Measured before it was mounted, not after: 8ms for a full year and 15ms
   * for the whole four-year ledger — it walks the window twice, once through the
   * classifier and once for the documents. A month costs about 2ms.
   */
  const spendProvenance = provenanceFor(db, {
    kind: "allSpend",
    from: range.from,
    to: range.to,
    label: period.label,
  });

  const hasActivity =
    cashFlow.totals.spentCents !== 0 ||
    cashFlow.totals.earnedCents !== 0 ||
    honesty.uncategorized.txnCount > 0;

  /*
   * 🔴 WHY the period is empty, when it is. This page printed "No activity in
   * this period" over September 2026 on 2026-09-04 — four elapsed days, not one
   * of them imported for any account — which is a measurement of a window
   * nobody has read. The dashboard's pace tile already refuses that ("an em
   * dash, not a $0.00") and links here; `/budgets` refuses to grade the same
   * days. `lib/empty-period` is that refusal, and it still says "measured zero"
   * where the window really is covered.
   */
  // both ends of the ledger, read once: the empty state and the heatmap ask them
  const opens = ledgerOpens(db);
  const reaches = ledgerReaches(db);
  const emptyReason = !hasActivity
    ? emptyPeriodReason({
        from: range.from,
        to: range.to,
        today,
        ledgerOpens: opens,
        ledgerReaches: reaches,
      })
    : null;
  const emptyCopy =
    emptyReason === null
      ? null
      : emptyPeriodCopy(emptyReason, period.label, reaches, formatDayLong, {
          uncategorizedBucket: true,
          ledgerOpens: opens,
        });

  return (
    <>
      <PageHeader
        title="Spending"
        description="Income and spending on one surface. Every stat, bar, day, and category reconciles to a filterable transaction list — nothing here is view-only."
      />

      <div className="mb-6">
        <PeriodSelector period={period} today={today} />
      </div>

      {!hasActivity ? (
        <>
          <EmptyState title={emptyCopy!.title} description={emptyCopy!.description} />
          {/* ⛔ Mounted INSIDE the empty branch too. These notes are the page
              saying what it cannot see, and the one period where a reader most
              needs them is the period where it can see nothing — the branch
              that used to drop them. */}
          <SectionNotes notes={cashNotes} label="What this page cannot see" />
        </>
      ) : (
        <div className="space-y-6">
          <SpendingStatCards totals={cashFlow.totals} range={range} />

          {/* Mounted UNDER the stat cards, not above them: the note qualifies a
              figure the reader has already seen, and a caveat printed before its
              subject reads as a page-level warning about the whole screen. */}
          <SectionNotes notes={cashNotes} label="What this page cannot see" />

          {/* Under the notes, above the charts: a reader who has seen the
              totals and their caveats is ready for sentences about them, and a
              claim printed before its own subject reads as a page banner. */}
          {insights && <InsightList data={insights} />}

          <SurfaceCard>
            <h2 className="mb-1 text-sm font-medium">Cash flow — {period.label}</h2>
            <CashFlowView
              cashFlow={cashFlow}
              projection={projection}
              sankey={sankey}
              viewState={cashView}
              baseParams={baseParams}
              periodLabel={period.label}
              paceWindowName={paceWindowName(period)}
            />
          </SurfaceCard>

          {/* `*:min-w-0` is load-bearing (the dashboard's shrink guard, same
              token): a grid item's automatic minimum size is its MIN-CONTENT
              size, so below lg — one implicit column — the track sized itself
              to the widest card and pushed the PAGE sideways. Zeroing it keeps
              any scrolling inside the card that owns a scroller. */}
          <div className="grid gap-6 *:min-w-0 lg:grid-cols-5">
            <SurfaceCard className="lg:col-span-3">
              <h2 className="mb-3 text-sm font-medium">Daily heatmap</h2>
              {/* keyed by the period-derived month so changing the period
                  remounts the heatmap on the new month (its own ‹ › paging
                  keeps the user's choice while the key is stable) */}
              <SpendHeatmap
                key={heatMonth}
                initial={heatmap}
                today={today}
                ledgerOpens={opens}
                ledgerReaches={reaches}
              />
            </SurfaceCard>
            <SurfaceCard className="lg:col-span-2">
              <h2 className="mb-3 text-sm font-medium">Top merchants</h2>
              <TopMerchantsCard data={merchants} />
            </SurfaceCard>
          </div>

          {/* Direction C's centre-rule deviation bar. Every other panel on this
              page answers "how much"; this is the only one that asks WHAT MOVED,
              with the change on its own axis and zero at the centre rather than
              at the bottom. It sits here rather than on the dashboard because
              the dashboard's category list already prints the move against last
              month beside each amount — there it would be a third encoding of a
              fact already stated twice. */}
          <SurfaceCard>
            <h2 className="mb-3 text-sm font-medium">What moved</h2>
            {/* ⛔ the refusal is a sentence, never the panel's own "No category
                changed between …" — that is a measurement of a window nobody
                imported */}
            {comparison.kind === "refused" ? (
              <p className="text-sm text-ink-muted">{comparison.sentence}</p>
            ) : (
              <CategoryDeviation
                rows={deviationRows}
                currentLabel={comparison.current.label}
                previousLabel={comparison.prior.label}
                note={comparison.kind === "clipped" ? comparison.note : null}
              />
            )}
          </SurfaceCard>

          <SurfaceCard>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">
                Where it went
                {/* the section's subject IS the period's whole spending, and a
                    total is only as proven as its weakest row */}
                {spendProvenance && (
                  <ProvenancePopover label="this period's spending" provenance={spendProvenance} />
                )}
              </h2>
              <span className="text-xs text-ink-faint">tap a category to open its page</span>
            </div>
            {/* three lenses on one set of rows: the ranked list this card has
                always shown (default), the spatial relief, and every figure as
                a table. The lens lives in the URL and persists per surface. */}
            <WhereItWentPanel
              rows={whereRows}
              totals={massifTotals}
              periodQuery={query}
              periodLabel={period.label}
              priorLabel={comparison.kind === "whole" ? comparison.prior.label : null}
              viewState={whereView}
              baseParams={whereBaseParams}
            >
              <SpendingCategoriesTable
                rows={categoryRows}
                periodQuery={query}
                showDelta={listCompares}
                forecastMonthLabel={forecastMonthLabel}
              />
            </WhereItWentPanel>
          </SurfaceCard>

          <div className="grid gap-6 *:min-w-0 lg:grid-cols-2">
            <SurfaceCard>
              {/* 🔴 "purchases" of a population that is every expense-kind
                  OUTFLOW. `spending-insights` settled this noun once —
                  "'transaction', not 'purchase'. … rent is not a purchase in
                  any case" — and this heading never read it. Measured
                  2026-09-10 across all 49 months the ledger covers: 20 of the
                  49 top-5 lists hold at least one row that is not a purchase.
                  Aug 2026 is led by "Flamingo Rent" (-$2,237.11) with
                  "PROGRESSIVE INS" 4th; Jul 2026 by the same rent charge with
                  "Zelle Payment To Kevin" 5th; Apr 2026 holds a $3,000.00
                  Zelle to a person and a NYS tax payment. The figures are
                  exactly right; the noun was not. */}
              <h2 className="mb-3 text-sm font-medium">Largest spending</h2>
              <LargestPurchases rows={largest} />
            </SurfaceCard>
            <SurfaceCard>
              <h2 className="mb-3 text-sm font-medium">Honesty check</h2>
              <HonestyBucketsCard data={honesty} />
            </SurfaceCard>
          </div>
        </div>
      )}
    </>
  );
}
