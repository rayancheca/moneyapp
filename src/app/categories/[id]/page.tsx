import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { resolvePeriod } from "@/lib/period";
import { categorySpending } from "@/services/analytics";
import {
  categoryBudgetRef,
  categoryDetailHeader,
  categoryMonthlyTrend,
  categorySubcategorySplit,
  seriesInCategory,
  type CategoryHeader,
} from "@/services/category-detail";
import { provenanceFor } from "@/services/provenance";
import { categoryInsights } from "@/services/spending-insights";
import { topMerchants } from "@/services/spending";
import { loadSpendingCategoryTxns } from "@/app/spending/actions";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { CategoryMoveMenu } from "@/components/categories/CategoryMoveMenu";
import { CategoryNameHeading } from "@/components/categories/CategoryNameHeading";
import { moveDestinations as categoryMoveDestinations } from "@/services/category-edit";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { InsightList } from "@/components/insights/InsightList";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { CategorySeriesList } from "@/components/spending/CategorySeriesList";
import { CategoryTxnPanel } from "@/components/spending/CategoryTxnPanel";
import { MonthlyTrendBars } from "@/components/spending/MonthlyTrendBars";
import { PeriodSelector } from "@/components/spending/PeriodSelector";
import { SpendDelta } from "@/components/spending/SpendDelta";
import { TopMerchantsCard } from "@/components/spending/TopMerchantsCard";

export const metadata: Metadata = { title: "Category" };
export const dynamic = "force-dynamic";

const TREND_MONTHS = 12;

function firstParam(value: string | string[] | undefined): string | null {
  const s = Array.isArray(value) ? value[0] : value;
  return typeof s === "string" && s !== "" ? s : null;
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const today = todayIso();
  const db = getDb();

  let header: CategoryHeader;
  try {
    header = categoryDetailHeader(db, id);
  } catch {
    notFound();
  }
  const moveDestinations = categoryMoveDestinations(db, header.id);

  const period = resolvePeriod(
    { period: firstParam(raw.period), from: firstParam(raw.from), to: firstParam(raw.to) },
    today,
  );
  const range = { from: period.from, to: period.to };
  const isIncome = header.kind === "income";
  const isExpense = header.kind === "expense";
  // income flows are money-IN (flip categorySpending's money-out sign); expense
  // and the excluded kinds (transfer/investment/rewards/system — reachable by
  // drilling a series' category chip) keep the raw net, labelled honestly below.
  const sign = isIncome ? -1 : 1;
  const flowLabel = isIncome ? "Received" : isExpense ? "Spent" : "Net";

  const { spentCents, txnCount } = categorySpending(db, { categoryId: id, from: range.from, to: range.to });
  const flowCents = sign * spentCents;
  const spendProvenance = provenanceFor(db, {
    kind: "categorySpend",
    categoryId: id,
    from: range.from,
    to: range.to,
    label: header.name,
  });

  const trend = categoryMonthlyTrend(db, id, TREND_MONTHS, today).map((p) => ({ ...p, spentCents: sign * p.spentCents }));

  /*
   * PHASE III-B. Where this category sits, through the SAME builder /spending
   * uses — so the two pages cannot disagree about a rank, a share or a trend.
   * Like /spending's, its window is the newest fully-imported month rather than
   * the period selector's, and every sentence names it.
   */
  const insights = categoryInsights(db, id, today);
  const subcats = categorySubcategorySplit(db, id, range);
  const series = seriesInCategory(db, id, today);
  const budget = categoryBudgetRef(db, id, today);
  // merchants are only meaningful for expense categories — transfer/investment
  // rows are not merchant purchases (spending-analytics exclusion law)
  const merchants = isExpense ? topMerchants(db, range, 8, { categoryId: id }) : null;

  const pickerOptions = buildCategoryPickerOptions(db.select().from(categories).all());
  const txns = await loadSpendingCategoryTxns({ categoryId: id, from: range.from, to: range.to });

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-xs text-ink-muted">
        <Link href="/spending" className="hover:text-ink hover:underline">Spending</Link>
        <Icon name="chevron-right" className="size-3 text-ink-faint" />
        {header.parentId && (
          <>
            <Link href={`/categories/${header.parentId}`} className="hover:text-ink hover:underline">
              {header.parentName}
            </Link>
            <Icon name="chevron-right" className="size-3 text-ink-faint" />
          </>
        )}
        <span className="text-ink">{header.name}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <CategoryChip label={header.name} hue={header.hue} icon={header.icon} />
          <div>
            <div className="flex items-center gap-1.5">
              <CategoryNameHeading
                categoryId={header.id}
                name={header.name}
                editable={header.kind !== "transfer" && header.kind !== "system"}
              />
              <CategoryMoveMenu
                categoryId={header.id}
                currentParentId={header.parentId}
                destinations={moveDestinations}
              />
            </div>
            <p className="text-xs text-ink-faint">
              {header.isSubcategory ? `${header.parentName} · ` : ""}
              {header.kind}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            {flowLabel} · {period.label}
            {/* the total's proof is the proof of the rows underneath it, and its
                weakest row sets the verdict */}
            {spendProvenance && (
              <ProvenancePopover
                label={`this ${flowLabel.toLowerCase()} total`}
                provenance={spendProvenance}
                placement="bottom-end"
              />
            )}
          </div>
          <Money cents={flowCents} className="figures text-2xl font-semibold" />
          <div className="text-xs text-ink-faint">{txnCount} {txnCount === 1 ? "transaction" : "transactions"}</div>
        </div>
      </header>

      <div className="mb-6">
        <PeriodSelector period={period} today={today} basePath={`/categories/${id}`} />
      </div>

      <div className="space-y-6">
        {insights && <InsightList data={insights} heading={`What the ledger says about ${header.name}`} />}

        <SurfaceCard>
          <h2 className="mb-4 text-sm font-medium">12-month trend</h2>
          <MonthlyTrendBars points={trend} />
        </SurfaceCard>

        {budget && (
          <SurfaceCard>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Budget</h2>
                <p className="text-xs text-ink-faint">
                  {budget.period} budget for this category
                  {/* the "left" figure beside this is measured from AVAILABLE, so a
                      carry has to be named here or the two cannot be reconciled */}
                  {budget.rolloverCents > 0 &&
                    ` · ${formatCents(budget.amountCents)} plan + ${formatCents(budget.rolloverCents)} rolled over`}
                </p>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <span>
                  <Money cents={budget.spentCents} /> of <Money cents={budget.availableCents} />
                </span>
                <span
                  className={
                    budget.alert === "over"
                      ? "text-negative"
                      : budget.alert === "warn80"
                        ? "text-warning"
                        : "text-positive"
                  }
                >
                  {budget.remainingCents >= 0
                    ? `${formatCents(budget.remainingCents)} left`
                    : `${formatCents(-budget.remainingCents)} over`}
                </span>
                <Link href={budget.href} className="text-accent hover:underline">Budgets →</Link>
              </div>
            </div>
          </SurfaceCard>
        )}

        {/* `*:min-w-0` is load-bearing, not cosmetic. A grid track defaults to
            minmax(auto, 1fr) and `auto` as a MINIMUM resolves to min-content, so a
            single child that cannot shrink (a nowrap merchant row here) widens the
            track and pushes the whole page sideways — measured at 358px in a 320px
            viewport before this. Same guard, same reason, as page.tsx:155. */}
        <div className="grid gap-6 *:min-w-0 lg:grid-cols-2">
          {subcats.length > 0 && (
            <SurfaceCard>
              <h2 className="mb-3 text-sm font-medium">Subcategories</h2>
              <ul className="divide-y divide-line">
                {subcats.map((s) => (
                  <li key={s.categoryId}>
                    <Link href={`/categories/${s.categoryId}`} className="flex items-center justify-between gap-2 py-2 text-sm hover:underline">
                      <span className="truncate">{s.name}</span>
                      <Money cents={Math.abs(s.flowCents)} className="shrink-0 font-medium" />
                    </Link>
                  </li>
                ))}
              </ul>
            </SurfaceCard>
          )}

          {merchants && (
            <SurfaceCard>
              <h2 className="mb-3 text-sm font-medium">Top merchants</h2>
              <TopMerchantsCard data={merchants} />
            </SurfaceCard>
          )}

          <SurfaceCard className={subcats.length > 0 || merchants ? "" : "lg:col-span-2"}>
            <h2 className="mb-3 text-sm font-medium">Recurring series</h2>
            <CategorySeriesList rows={series} />
          </SurfaceCard>
        </div>

        <SurfaceCard>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Transactions</h2>
            <span className="text-xs text-ink-faint">{period.label}</span>
          </div>
          {txns.ok ? (
            <CategoryTxnPanel data={txns.data} categories={pickerOptions} />
          ) : (
            <p className="text-sm text-ink-muted">Could not load transactions.</p>
          )}
        </SurfaceCard>
      </div>
    </>
  );
}
