import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { getDb } from "@/db/client";
import { periodBounds, todayIso } from "@/lib/dates";
import {
  categoryBreakdown,
  categoryTrends,
  incomeByMonth,
  monthKeysBack,
  monthlySpending,
  transactionsHref,
  type IncomeCell,
  type SpendingCell,
} from "@/services/analytics";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { SpendDelta } from "@/components/spending/SpendDelta";
import { StackedMonthChart, type ChartRow, type ChartSeries } from "@/components/spending/StackedMonthChart";

export const metadata: Metadata = { title: "Spending" };
export const dynamic = "force-dynamic";

const searchSchema = z.object({
  months: z.enum(["6", "12", "24"]).catch("12"),
  view: z.enum(["spending", "income"]).catch("spending"),
});

const CATEGORY_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--warning)",
];
const OTHER_COLOR = "var(--line-strong)";
const UNCATEGORIZED_COLOR = "var(--ink-faint)";
const TOP_CATEGORY_LIMIT = 7;

interface PivotResult {
  rows: ChartRow[];
  series: ChartSeries[];
}

/** Top N categories get their own stack layer; the rest fold into "Other".
 *  Uncategorized is always its own explicit layer — never hidden. */
function pivotSpending(cells: SpendingCell[], monthKeys: string[]): PivotResult {
  const totals = new Map<string, number>();
  for (const c of cells) {
    if (c.categoryId === null) continue;
    totals.set(c.categoryName, (totals.get(c.categoryName) ?? 0) + c.spentCents);
  }
  const topNames = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CATEGORY_LIMIT)
    .map(([name]) => name);

  const hasOther = totals.size > topNames.length;
  const hasUncategorized = cells.some((c) => c.categoryId === null);

  const rows = monthKeys.map((month) => {
    const row: ChartRow = { month };
    for (const c of cells.filter((c) => c.month === month)) {
      const key =
        c.categoryId === null ? "Uncategorized" : topNames.includes(c.categoryName) ? c.categoryName : "Other";
      row[key] = ((row[key] as number | undefined) ?? 0) + c.spentCents;
    }
    return row;
  });

  const series: ChartSeries[] = topNames.map((name, i) => ({
    key: name,
    label: name,
    color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]!,
  }));
  if (hasOther) series.push({ key: "Other", label: "Other", color: OTHER_COLOR });
  if (hasUncategorized) series.push({ key: "Uncategorized", label: "Uncategorized", color: UNCATEGORIZED_COLOR });
  return { rows, series };
}

function pivotIncome(cells: IncomeCell[], monthKeys: string[]): PivotResult {
  const names = [...new Set(cells.map((c) => c.categoryName))].sort();
  const rows = monthKeys.map((month) => {
    const row: ChartRow = { month };
    for (const c of cells.filter((c) => c.month === month)) {
      row[c.categoryName] = ((row[c.categoryName] as number | undefined) ?? 0) + c.incomeCents;
    }
    return row;
  });
  const series = names.map((name, i) => ({
    key: name,
    label: name,
    color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]!,
  }));
  return { rows, series };
}

function viewHref(view: string, months: string): string {
  return `/spending?view=${view}&months=${months}`;
}

const TH = "pb-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint";
const TH_NUM = `${TH} text-right`;

export default async function SpendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const { months, view } = searchSchema.parse({ months: raw.months, view: raw.view });
  const monthCount = Number(months);

  const db = getDb();
  const refDate = todayIso();
  const monthKeys = monthKeysBack(refDate, monthCount);
  const rangeFrom = `${monthKeys[0]}-01`;
  const currentBounds = periodBounds(refDate, "monthly");
  const rangeTo = currentBounds.end;

  const spendingCells = monthlySpending(db, { months: monthCount, refDate });
  const incomeCells = incomeByMonth(db, { months: monthCount, refDate });

  return (
    <>
      <PageHeader
        title="Spending & income"
        description="Category breakdowns, trends, and income tracking — transfers and rewards excluded by construction. Every number reconciles to a filterable transaction list."
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Analytics view" className="flex gap-1 rounded-full bg-surface-sunken p-1">
          {(["spending", "income"] as const).map((v) => (
            <Link
              key={v}
              href={viewHref(v, months)}
              aria-current={view === v ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-xs capitalize transition-colors duration-(--duration-fast) ${
                view === v ? "bg-surface-raised font-medium shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              {v}
            </Link>
          ))}
        </nav>
        <nav aria-label="Month range" className="flex items-center gap-1">
          {(["6", "12", "24"] as const).map((m) => (
            <Link
              key={m}
              href={viewHref(view, m)}
              aria-current={months === m ? "page" : undefined}
              className={`rounded-full px-2.5 py-1 text-xs transition-colors duration-(--duration-fast) ${
                months === m ? "bg-accent-soft font-medium text-accent" : "text-ink-muted hover:text-ink"
              }`}
            >
              {m}M
            </Link>
          ))}
        </nav>
      </div>

      {view === "spending" ? (
        <SpendingView
          db={db}
          cells={spendingCells}
          monthKeys={monthKeys}
          refDate={refDate}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
        />
      ) : (
        <IncomeView cells={incomeCells} monthKeys={monthKeys} rangeFrom={rangeFrom} rangeTo={rangeTo} />
      )}
    </>
  );
}

function SpendingView({
  db,
  cells,
  monthKeys,
  refDate,
  rangeFrom,
  rangeTo,
}: {
  db: ReturnType<typeof getDb>;
  cells: SpendingCell[];
  monthKeys: string[];
  refDate: string;
  rangeFrom: string;
  rangeTo: string;
}) {
  if (cells.length === 0) {
    return (
      <EmptyState
        title="No spending to analyze yet"
        description="Spending analytics unlock once transactions are imported and categorized. Uncategorized outflows will still show up — as their own explicit bucket."
        phase="Phase 4 · Analytics"
      />
    );
  }

  const { rows, series } = pivotSpending(cells, monthKeys);
  const trends = categoryTrends(db, { refDate });
  const breakdown = categoryBreakdown(db, { from: rangeFrom, to: rangeTo });
  const totalCurrent = trends.reduce((s, t) => s + t.currentMonthCents, 0);
  const totalPrevious = trends.reduce((s, t) => s + t.previousMonthCents, 0);
  const totalAvg = trends.reduce((s, t) => s + t.trailing3moAvgCents, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <SurfaceCard className="p-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">This month</div>
          <Money cents={totalCurrent} className="mt-1 block text-xl font-semibold" />
        </SurfaceCard>
        <SurfaceCard className="p-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">vs last month</div>
          <span className="mt-1 block text-xl font-semibold">
            <SpendDelta cents={totalCurrent - totalPrevious} />
          </span>
        </SurfaceCard>
        <SurfaceCard className="p-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">3-month average</div>
          <Money cents={totalAvg} className="mt-1 block text-xl font-semibold" />
        </SurfaceCard>
      </div>

      <SurfaceCard>
        <h2 className="mb-4 text-sm font-medium">Monthly spending by category</h2>
        <StackedMonthChart rows={rows} series={series} ariaLabel="Stacked monthly spending by top-level category" />
      </SurfaceCard>

      <SurfaceCard>
        <h2 className="mb-3 text-sm font-medium">Category trends</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Category</th>
              <th scope="col" className={TH_NUM}>This month</th>
              <th scope="col" className={TH_NUM}>3-mo avg</th>
              <th scope="col" className={TH_NUM}>MoM</th>
            </tr>
          </thead>
          <tbody>
            {trends.map((t) => (
              <tr key={t.categoryId ?? "uncategorized"} className="border-b border-line last:border-0">
                <td className="py-2">
                  <Link
                    href={transactionsHref({ categoryId: t.categoryId, from: rangeFrom, to: rangeTo })}
                    className="hover:text-accent hover:underline"
                  >
                    {t.categoryName}
                  </Link>
                </td>
                <td className="py-2 text-right"><Money cents={t.currentMonthCents} /></td>
                <td className="py-2 text-right"><Money cents={t.trailing3moAvgCents} className="text-ink-muted" /></td>
                <td className="py-2 text-right"><SpendDelta cents={t.momDeltaCents} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </SurfaceCard>

      <SurfaceCard>
        <h2 className="mb-1 text-sm font-medium">Where it went</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Full {monthKeys.length}-month range · every line links to its exact transactions.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Category</th>
              <th scope="col" className={TH_NUM}>Transactions</th>
              <th scope="col" className={TH_NUM}>Spent</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((row) => (
              <BreakdownRows key={row.categoryId ?? "uncategorized"} row={row} rangeFrom={rangeFrom} rangeTo={rangeTo} />
            ))}
          </tbody>
        </table>
      </SurfaceCard>
    </div>
  );
}

function BreakdownRows({
  row,
  rangeFrom,
  rangeTo,
}: {
  row: ReturnType<typeof categoryBreakdown>[number];
  rangeFrom: string;
  rangeTo: string;
}) {
  return (
    <>
      <tr className="border-b border-line">
        <td className="py-2 font-medium">
          <Link
            href={transactionsHref({ categoryId: row.categoryId, from: rangeFrom, to: rangeTo })}
            className="hover:text-accent hover:underline"
          >
            {row.name}
          </Link>
        </td>
        <td className="py-2 text-right text-ink-muted">{row.txnCount}</td>
        <td className="py-2 text-right"><Money cents={row.spentCents} /></td>
      </tr>
      {row.children.map((child) => (
        <tr key={child.categoryId} className="border-b border-line last:border-0">
          <td className="py-1.5 pl-5 text-ink-muted">
            <Link
              href={transactionsHref({ categoryId: child.categoryId, from: rangeFrom, to: rangeTo })}
              className="hover:text-accent hover:underline"
            >
              {child.name}
            </Link>
          </td>
          <td className="py-1.5 text-right text-ink-faint">{child.txnCount}</td>
          <td className="py-1.5 text-right"><Money cents={child.spentCents} className="text-ink-muted" /></td>
        </tr>
      ))}
    </>
  );
}

function IncomeView({
  cells,
  monthKeys,
  rangeFrom,
  rangeTo,
}: {
  cells: IncomeCell[];
  monthKeys: string[];
  rangeFrom: string;
  rangeTo: string;
}) {
  if (cells.length === 0) {
    return (
      <EmptyState
        title="No income recorded yet"
        description="Income tracks positive transactions in Income categories — salary, interest, and dividends (including from investment accounts) appear here once categorized."
        phase="Phase 4 · Analytics"
      />
    );
  }

  const { rows, series } = pivotIncome(cells, monthKeys);
  const currentMonth = monthKeys.at(-1)!;
  const trailingKeys = monthKeys.slice(-4, -1);

  const sources = series.map((s) => {
    const mine = cells.filter((c) => c.categoryName === s.key);
    const sum = (predicate: (c: IncomeCell) => boolean) =>
      mine.filter(predicate).reduce((acc, c) => acc + c.incomeCents, 0);
    return {
      categoryId: mine[0]!.categoryId,
      name: s.key,
      currentCents: sum((c) => c.month === currentMonth),
      trailingAvgCents: Math.round(sum((c) => trailingKeys.includes(c.month)) / 3),
      totalCents: sum(() => true),
      txnCount: mine.reduce((acc, c) => acc + c.txnCount, 0),
    };
  });
  const totalIncome = sources.reduce((s, r) => s + r.totalCents, 0);

  return (
    <div className="space-y-6">
      <SurfaceCard>
        <h2 className="mb-4 text-sm font-medium">Income by month</h2>
        <StackedMonthChart rows={rows} series={series} ariaLabel="Stacked monthly income by source" />
      </SurfaceCard>

      <SurfaceCard>
        <h2 className="mb-3 text-sm font-medium">Income sources</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Source</th>
              <th scope="col" className={TH_NUM}>This month</th>
              <th scope="col" className={TH_NUM}>3-mo avg</th>
              <th scope="col" className={TH_NUM}>Range total</th>
            </tr>
          </thead>
          <tbody>
            {[...sources]
              .sort((a, b) => b.totalCents - a.totalCents)
              .map((s) => (
                <tr key={s.categoryId} className="border-b border-line last:border-0">
                  <td className="py-2">
                    <Link
                      href={transactionsHref({ categoryId: s.categoryId, from: rangeFrom, to: rangeTo })}
                      className="hover:text-accent hover:underline"
                    >
                      {s.name}
                    </Link>
                  </td>
                  <td className="py-2 text-right"><Money cents={s.currentCents} /></td>
                  <td className="py-2 text-right"><Money cents={s.trailingAvgCents} className="text-ink-muted" /></td>
                  <td className="py-2 text-right"><Money cents={s.totalCents} /></td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong">
              <th scope="row" className="py-2 text-left text-xs font-medium text-ink-muted">
                Total
              </th>
              <td />
              <td />
              <td className="py-2 text-right">
                <Money cents={totalIncome} className="font-medium text-positive" />
              </td>
            </tr>
          </tfoot>
        </table>
      </SurfaceCard>
    </div>
  );
}
