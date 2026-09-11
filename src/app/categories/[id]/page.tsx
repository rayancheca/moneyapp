import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { compareDates, todayIso } from "@/lib/dates";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import { resolvePeriod, withPeriod } from "@/lib/period";
import { emptyPeriodCopy, emptyPeriodReason } from "@/lib/empty-period";
import { ledgerOpens, ledgerReaches } from "@/services/observation-frontier";
import { categorySpending } from "@/services/analytics";
import {
  categoryBudgetRef,
  categoryDetailHeader,
  categoryFlowSign,
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
import { MonthlyTrendBars, trendWindowLabel } from "@/components/spending/MonthlyTrendBars";
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
  /*
   * Only an EXPENSE category is printed in `categorySpending`'s money-out
   * frame, because only there does a bigger number mean more money gone.
   *
   * 🔴 The excluded kinds (transfer/investment/rewards/system — reachable by
   * drilling a series' category chip) used to keep the raw money-out net under
   * a bare label "Net", and money ARRIVING therefore printed as a minus
   * directly above the same rows printed as a plus. Measured 2026-09-04 on
   * `/categories/<Pass-through>?period=2026-08`:
   *
   *     Net · August 2026     -$5,000.00   2 transactions
   *     08-12  ZELLE PAYMENT FROM ARNO SEARCH CAPITAL, LLC   +$1,000.00
   *     08-11  ZELLE PAYMENT FROM ARNO SEARCH CAPITAL, LLC   +$4,000.00
   *
   * The transaction list under the headline is the ledger's own frame — money
   * in positive — and the headline over it must be the sum of what it prints.
   */
  const sign = categoryFlowSign(header.kind);
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

  /*
   * ⛔ THE TREND IS ANCHORED TO THE PERIOD THIS PAGE IS SHOWING, not to today.
   * Every other card here respects the selector — "Spent · November 2023", the
   * Nov 2023 merchants, the Nov 2023 transactions — and this one silently did
   * not: on `?period=2023-11` it headed a November-2023 page with bars from
   * Oct 2025 to Sep 2026. Same on all 80 category pages and every past period.
   *
   * Clamped at `today`, so selecting a whole year that has not finished does
   * not draw months nobody could have imported.
   */
  const trendAnchor = compareDates(period.to, today) < 0 ? period.to : today;
  const trend = categoryMonthlyTrend(db, id, TREND_MONTHS, trendAnchor, ledgerReaches(db)).map((p) => ({ ...p, spentCents: sign * p.spentCents }));

  /*
   * PHASE III-B. Where this category sits, through the SAME builder /spending
   * uses — so the two pages cannot disagree about a rank, a share or a trend.
   * Like /spending's, its window is the newest fully-imported month rather than
   * the period selector's, and every sentence names it.
   */
  /*
   * 🔴 WHICH OF SIX WORLDS AN EMPTY WINDOW IS IN. On 2026-09-04 every category
   * page read, of a September nobody had imported a single day of:
   *
   *     Spent · September 2026   $0.00   0 transactions
   *     Top merchants   "No merchant spending in this period."
   *     Transactions    "No transactions in this period."
   *
   * — three claims of absence about a window nobody has looked at, which is the
   * one error `lib/empty-period` exists to stop. It was written for /spending
   * on 2026-09-04 and shipped with exactly one caller; this is the second, and
   * the two pages a reader moves between now describe the same month the same
   * way.
   */
  const emptyReason =
    txnCount === 0
      ? emptyPeriodReason({
          from: range.from,
          to: range.to,
          today,
          ledgerOpens: ledgerOpens(db),
          ledgerReaches: ledgerReaches(db),
        })
      : null;
  const emptyCopy = emptyReason
    ? emptyPeriodCopy(emptyReason, period.label, ledgerReaches(db), formatDayLong)
    : null;
  // the title carries the antecedent — "4 days of IT" has none without it
  const emptyText = emptyCopy ? `${emptyCopy.title}. ${emptyCopy.description}` : undefined;

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
        {/* ⛔ the crumbs carry the window too: a bare href means "the current
            month" to `resolvePeriod`, so stepping up out of a July page landed
            on an empty September one. */}
        <Link href={withPeriod("/spending", period)} className="hover:text-ink hover:underline">Spending</Link>
        <Icon name="chevron-right" className="size-3 text-ink-faint" />
        {header.parentId && (
          <>
            <Link href={withPeriod(`/categories/${header.parentId}`, period)} className="hover:text-ink hover:underline">
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
          {/* the heading names the twelve months the bars are actually drawn
              over — it read a bare "12-month trend" over any window at all */}
          <h2 className="mb-4 text-sm font-medium">
            12-month trend · <span className="text-ink-muted">{trendWindowLabel(trend)}</span>
          </h2>
          <MonthlyTrendBars points={trend} flowLabel={flowLabel} />
        </SurfaceCard>

        {budget && (
          <SurfaceCard>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Budget</h2>
                <p className="text-xs text-ink-faint">
                  {/* 🔴 The window, because this page has a PERIOD SELECTOR and
                      the budget is always graded at today. Unnamed, the card
                      answered "how much of Housing went out?" with $0.00 on a
                      screen whose headline answered it with $2,653.58. Same
                      words as /budgets' own detail card. */}
                  {budget.period} budget · grading {formatDayShort(budget.bounds.start)} –{" "}
                  {formatDayShort(budget.bounds.end)}
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
                {/* ⛔ The parent's OWN rows have no link: `/transactions?category=`
                    filters by SUBTREE, so one would list every child's rows too
                    — the drill-down contract broken rather than kept. See
                    `categorySubcategorySplit`.

                    ⛔ And the SIGN is printed, not stripped. `Math.abs` here was
                    what hid the frame disagreement below it: on Transfers the
                    eight rows printed unsigned summed to $163,704.93 under a
                    headline of $106,664.95, and two of them were money OUT.
                    These rows share the header's frame (`categoryFlowSign`), so
                    they add up to it — and only a signed row can. */}
                {subcats.map((s) =>
                  s.href === null ? (
                    <li
                      key={s.categoryId}
                      className="flex items-center justify-between gap-2 py-2 text-sm text-ink-muted"
                    >
                      <span className="truncate">{s.name}</span>
                      <Money cents={s.flowCents} className="shrink-0 font-medium" />
                    </li>
                  ) : (
                    <li key={s.categoryId}>
                      <Link
                        href={withPeriod(`/categories/${s.categoryId}`, period)}
                        className="flex items-center justify-between gap-2 py-2 text-sm hover:underline"
                      >
                        <span className="truncate">{s.name}</span>
                        <Money cents={s.flowCents} className="shrink-0 font-medium" />
                      </Link>
                    </li>
                  ),
                )}
              </ul>
            </SurfaceCard>
          )}

          {merchants && (
            <SurfaceCard>
              <h2 className="mb-3 text-sm font-medium">Top merchants</h2>
              <TopMerchantsCard data={merchants} emptyText={emptyText} />
            </SurfaceCard>
          )}

          <SurfaceCard className={subcats.length > 0 || merchants ? "" : "lg:col-span-2"}>
            <h2 className="mb-3 text-sm font-medium">Recurring series</h2>
            <CategorySeriesList rows={series} today={today} />
          </SurfaceCard>
        </div>

        <SurfaceCard>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Transactions</h2>
            <span className="text-xs text-ink-faint">{period.label}</span>
          </div>
          {txns.ok ? (
            <CategoryTxnPanel data={txns.data} categories={pickerOptions} emptyText={emptyText} />
          ) : (
            <p className="text-sm text-ink-muted">Could not load transactions.</p>
          )}
        </SurfaceCard>
      </div>
    </>
  );
}
