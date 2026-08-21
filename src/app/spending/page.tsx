import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { todayIso } from "@/lib/dates";
import { formatDayLong } from "@/lib/format-date";
import { cashEarningsSectionNotes } from "@/lib/section-notes";
import {
  heatmapInitialMonth,
  resolvePeriod,
  stepPeriodParams,
} from "@/lib/period";
import { WHERE_VIEW_SPEC } from "@/lib/massif-layout";
import { resolveViewState, viewStateToParams } from "@/lib/view-state";
import { categoryBreakdown } from "@/services/analytics";
import { cashEarningsReadings } from "@/services/cash-earnings";
import { spendingSankey } from "@/services/sankey";
import { predictBudgetableCategories } from "@/services/category-forecast";
import { readSettings } from "@/services/settings";
import {
  cashFlowByPeriod,
  dailySpendHeatmap,
  dayLedgerHref,
  honestyBuckets,
  largestTransactions,
  spendingProjection,
  topMerchants,
  ledgerFirstDay,
} from "@/services/spending";
import { EmptyState } from "@/components/ui/EmptyState";
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
    { period: firstParam(raw.period), from: firstParam(raw.from), to: firstParam(raw.to) },
    today,
    ledgerFirstDay(db) ?? undefined,
  );
  const range = { from: period.from, to: period.to };

  const cashFlow = cashFlowByPeriod(db, period, today);
  const projection = spendingProjection(db, period, today, cashFlow.pace, cashFlow.totals.spentCents);
  const sankey = spendingSankey(db, range);
  const merchants = topMerchants(db, range);

  /*
   * What this page's income figure cannot see. Its totals count DEPOSITS, which
   * for a cash job is a record of ATM trips rather than of earnings — July 2026
   * reported $52.95 of income while a confirmed $1,046-a-week schedule ran the
   * whole month. The note is measured, never added to any total.
   */
  const cashNotes = cashEarningsSectionNotes({
    rows: cashEarningsReadings(db, { from: range.from, to: range.to, today }),
    formatDay: formatDayLong,
  });

  // switchable-view state (NS#2 Pillar 2): URL > persisted preference > default.
  // Two INDEPENDENT dimensions on this surface — the cash-flow card's renderer
  // and the "Where it went" card's lens — sharing one persisted record, which
  // saveViewPreferenceAction merges per key.
  const persistedViews = readSettings(db).viewPreferences[SPENDING_SURFACE];
  const cashView = resolveViewState(CASH_VIEW_SPEC, { cash: firstParam(raw.cash) ?? undefined }, persistedViews);
  const whereView = resolveViewState(WHERE_VIEW_SPEC, { where: firstParam(raw.where) ?? undefined }, persistedViews);
  // params to preserve when switching views: the current period, and the OTHER
  // card's lens — so flipping one card never drops the other out of the URL.
  const periodParams: Record<string, string> = period.key
    ? { period: period.key }
    : { from: period.from, to: period.to };
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

  // categories table: this-period breakdown vs the previous period for MoM
  const prevPeriod = resolvePeriod(stepPeriodParams(period, -1), today);
  const breakdown = categoryBreakdown(db, range);
  const prevBreakdown = categoryBreakdown(db, { from: prevPeriod.from, to: prevPeriod.to });
  const prevById = new Map(prevBreakdown.map((r) => [r.categoryId, r.spentCents]));
  // "What moved" reads the SAME two breakdowns the categories table already
  // compares, so the two panels can never disagree about a delta.
  const deviationRows = breakdown.map((r) => ({
    key: r.categoryId ?? "__uncat",
    label: r.name,
    currentCents: r.spentCents,
    previousCents: prevById.get(r.categoryId) ?? 0,
  }));
  // Share denominator = gross positive spending across categories. The NET total
  // (cashFlow.totals.spentCents) can be dragged below an individual category's
  // gross by refund/reimbursement-heavy categories that net to an inflow, which
  // would push shares past 100% or negative — so sum only the positive spends.
  const shareBase = breakdown
    .filter((r) => r.categoryId !== null)
    .reduce((s, r) => s + Math.max(0, r.spentCents), 0);
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

  const spentRows: CategoryTableRow[] = breakdown
    .filter((r) => r.categoryId !== null)
    .map((r) => ({
      categoryId: r.categoryId!,
      name: r.name,
      hue: catMeta.get(r.categoryId!)?.color ?? null,
      icon: catMeta.get(r.categoryId!)?.icon ?? null,
      spentCents: r.spentCents,
      sharePct: shareBase > 0 ? (Math.max(0, r.spentCents) / shareBase) * 100 : 0,
      momDeltaCents: r.spentCents - (prevById.get(r.categoryId) ?? 0),
      forecast: forecastByCategory.get(r.categoryId!) ?? null,
      children: r.children.map((c) => ({ categoryId: c.categoryId, name: c.name, spentCents: c.spentCents })),
    }));

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

  // The relief/table lenses of the SAME card, cut from the SAME breakdown rows
  // the list above is: this period against the previous one, with the entry
  // count the footprint depth encodes. Forecast-only "upcoming" rows are not
  // here on purpose — a category with no spend and no entries has no footprint,
  // and the list lens still shows them.
  const whereRows: WhereItWentRow[] = breakdown
    .filter((r) => r.categoryId !== null)
    .map((r) => ({
      categoryId: r.categoryId!,
      name: r.name,
      hue: catMeta.get(r.categoryId!)?.color ?? null,
      spentCents: r.spentCents,
      priorCents: prevById.get(r.categoryId) ?? 0,
      txnCount: r.txnCount,
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

  const hasActivity =
    cashFlow.totals.spentCents !== 0 ||
    cashFlow.totals.earnedCents !== 0 ||
    honesty.uncategorized.txnCount > 0;

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
        <EmptyState
          title="No activity in this period"
          description="Pick another period above, or import and categorize transactions. Uncategorized outflows still show up — as their own explicit bucket."
        />
      ) : (
        <div className="space-y-6">
          <SpendingStatCards totals={cashFlow.totals} range={range} />

          {/* Mounted UNDER the stat cards, not above them: the note qualifies a
              figure the reader has already seen, and a caveat printed before its
              subject reads as a page-level warning about the whole screen. */}
          <SectionNotes notes={cashNotes} label="What this page cannot see" />

          <SurfaceCard>
            <h2 className="mb-1 text-sm font-medium">Cash flow — {period.label}</h2>
            <CashFlowView
              cashFlow={cashFlow}
              projection={projection}
              sankey={sankey}
              viewState={cashView}
              baseParams={baseParams}
              periodLabel={period.label}
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
              <SpendHeatmap key={heatMonth} initial={heatmap} today={today} />
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
            <CategoryDeviation
              rows={deviationRows}
              currentLabel={period.label}
              previousLabel={prevPeriod.label}
            />
          </SurfaceCard>

          <SurfaceCard>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Where it went</h2>
              <span className="text-xs text-ink-faint">tap a category to open its page</span>
            </div>
            {/* three lenses on one set of rows: the ranked list this card has
                always shown (default), the spatial relief, and every figure as
                a table. The lens lives in the URL and persists per surface. */}
            <WhereItWentPanel
              rows={whereRows}
              totals={massifTotals}
              periodLabel={period.label}
              priorLabel={prevPeriod.label}
              viewState={whereView}
              baseParams={whereBaseParams}
            >
              <SpendingCategoriesTable
                rows={categoryRows}
                showDelta={period.granularity === "month"}
                forecastMonthLabel={forecastMonthLabel}
              />
            </WhereItWentPanel>
          </SurfaceCard>

          <div className="grid gap-6 *:min-w-0 lg:grid-cols-2">
            <SurfaceCard>
              <h2 className="mb-3 text-sm font-medium">Largest purchases</h2>
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
