import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { todayIso } from "@/lib/dates";
import {
  heatmapInitialMonth,
  resolvePeriod,
  stepPeriodParams,
} from "@/lib/period";
import { categoryBreakdown } from "@/services/analytics";
import {
  cashFlowByPeriod,
  dailySpendHeatmap,
  dayLedgerHref,
  honestyBuckets,
  largestTransactions,
  topMerchants,
} from "@/services/spending";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { CashFlowChart } from "@/components/spending/CashFlowChart";
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
  const period = resolvePeriod(
    { period: firstParam(raw.period), from: firstParam(raw.from), to: firstParam(raw.to) },
    today,
  );
  const range = { from: period.from, to: period.to };

  const db = getDb();
  const cashFlow = cashFlowByPeriod(db, period, today);
  const merchants = topMerchants(db, range);
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
  // Share denominator = gross positive spending across categories. The NET total
  // (cashFlow.totals.spentCents) can be dragged below an individual category's
  // gross by refund/reimbursement-heavy categories that net to an inflow, which
  // would push shares past 100% or negative — so sum only the positive spends.
  const shareBase = breakdown
    .filter((r) => r.categoryId !== null)
    .reduce((s, r) => s + Math.max(0, r.spentCents), 0);
  const categoryRows: CategoryTableRow[] = breakdown
    .filter((r) => r.categoryId !== null)
    .map((r) => ({
      categoryId: r.categoryId!,
      name: r.name,
      hue: catMeta.get(r.categoryId!)?.color ?? null,
      icon: catMeta.get(r.categoryId!)?.icon ?? null,
      spentCents: r.spentCents,
      sharePct: shareBase > 0 ? (Math.max(0, r.spentCents) / shareBase) * 100 : 0,
      momDeltaCents: r.spentCents - (prevById.get(r.categoryId) ?? 0),
      children: r.children.map((c) => ({ categoryId: c.categoryId, name: c.name, spentCents: c.spentCents })),
    }));

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
        <PeriodSelector period={period} todayMonthKey={today.slice(0, 7)} />
      </div>

      {!hasActivity ? (
        <EmptyState
          title="No activity in this period"
          description="Pick another period above, or import and categorize transactions. Uncategorized outflows still show up — as their own explicit bucket."
        />
      ) : (
        <div className="space-y-6">
          <SpendingStatCards totals={cashFlow.totals} range={range} />

          <SurfaceCard>
            <h2 className="mb-1 text-sm font-medium">Cash flow — {period.label}</h2>
            <CashFlowChart data={cashFlow} />
          </SurfaceCard>

          <div className="grid gap-6 lg:grid-cols-5">
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

          <SurfaceCard>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Where it went</h2>
              <span className="text-xs text-ink-faint">tap a category to open its page</span>
            </div>
            <SpendingCategoriesTable rows={categoryRows} showDelta={period.granularity === "month"} />
          </SurfaceCard>

          <div className="grid gap-6 lg:grid-cols-2">
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
