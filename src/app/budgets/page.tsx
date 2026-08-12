import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { periodBounds, todayIso } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import type { BudgetPeriodKind } from "@/db/schema/budgets";
import {
  budgetGuidanceCents,
  budgetPaceStatuses,
  incomeExpectation,
  hasOverlappingChildBudget,
  listBudgetableCategories,
  totalBudgetedCents,
  type BudgetPaceStatus,
} from "@/services/budgets";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { BudgetForm } from "@/components/budgets/BudgetForm";
import { PredictBudgets } from "@/components/budgets/PredictBudgets";
import { BudgetRow } from "@/components/budgets/BudgetRow";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { SectionNotes } from "@/components/insights/SectionNotes";
import { budgetSectionNotes } from "@/lib/section-notes";

export const metadata: Metadata = { title: "Budgets" };
export const dynamic = "force-dynamic";

const PERIOD_SECTIONS: { period: BudgetPeriodKind; label: string }[] = [
  { period: "daily", label: "Daily" },
  { period: "weekly", label: "Weekly" },
  { period: "monthly", label: "Monthly" },
  { period: "annual", label: "Annual" },
];

function formatBounds(status: BudgetPaceStatus): string {
  const { start, end } = status.bounds;
  return start === end ? formatDayShort(start) : `${formatDayShort(start)} – ${formatDayShort(end)}`;
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const error = errorParam(raw);

  const db = getDb();
  const today = todayIso();
  const statuses = budgetPaceStatuses(db, today);
  const categories = listBudgetableCategories(db);

  // one 6-month spend guide per budget, for the inline editor
  const guidance = new Map(
    statuses.map((s) => [s.budget.id, budgetGuidanceCents(db, s.budget.categoryId, s.budget.period, today)]),
  );

  // The income term the page has never had. Scoped to MONTHLY budgets only:
  // they are the ones whose window matches a pay cycle, and mixing a daily and
  // an annual budget into one "allocated" figure would compare unlike things.
  const monthly = statuses.filter((s) => s.budget.period === "monthly");
  const monthlyBudgetedCents = totalBudgetedCents(monthly);
  // the WHOLE month, deliberately — not any one budget's `bounds`. A budget
  // created mid-month is start-clamped, so borrowing its window would compare a
  // full month of budgeted amounts against a fraction of a month of income.
  const monthBounds = periodBounds(today, "monthly");
  const income = incomeExpectation(db, monthBounds.start, monthBounds.end, today);
  const leftToAllocateCents = income.totalCents - monthlyBudgetedCents;

  // measured guidance: what the page as a whole knows and no single row states
  const notes = budgetSectionNotes({
    rows: statuses.map((s) => ({
      categoryPath: s.categoryPath,
      overdueCents: s.overdueCents,
      uncoveredDays: s.uncoveredDays,
      pace: s.pace,
    })),
  });

  const sections = PERIOD_SECTIONS.map((s) => ({
    ...s,
    statuses: statuses.filter((st) => st.budget.period === s.period),
  })).filter((s) => s.statuses.length > 0);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Budgets"
          description="Daily, weekly, monthly, and annual budgets per category. Child spending rolls into parent budgets. Leftover is forgotten each period unless a budget opts into rolling it over."
        />
        <PredictBudgets />
      </div>

      {error && <ErrorBanner message={error} />}

      {monthly.length > 0 && (
        <SurfaceCard>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              This month
            </h2>
            <p className="text-sm">
              <span className="text-ink-muted">Budgeted </span>
              <Money cents={monthlyBudgetedCents} className="font-medium" />
              <span className="text-ink-muted"> of </span>
              <Money cents={income.totalCents} className="font-medium" />
              <span className="text-ink-muted"> expected income</span>
            </p>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {leftToAllocateCents >= 0 ? (
              <>
                <Money cents={leftToAllocateCents} className="font-medium text-ink" /> left to
                allocate
              </>
            ) : (
              <>
                <span className="font-medium text-danger">
                  Over-allocated by <Money cents={-leftToAllocateCents} />
                </span>{" "}
                — these budgets total more than this month is expected to bring in
              </>
            )}
            {income.expectedCents > 0 && (
              <>
                {" · "}
                <Money cents={income.postedCents} /> in so far,{" "}
                <Money cents={income.expectedCents} /> still expected
                {income.series.length > 0 && ` from ${income.series[0]!.name}`}
              </>
            )}
          </p>
        </SurfaceCard>
      )}

      <SectionNotes notes={notes} label="What this page noticed" />

      <div className="space-y-6">
        {sections.length === 0 ? (
          <EmptyState
            title="No budgets yet"
            description="Create one below — actuals come straight from the spending analytics, so a budget's number always matches its transaction list."
          />
        ) : (
          sections.map((section) => (
            <section key={section.period} aria-label={`${section.label} budgets`}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                  {section.label}
                  <span className="ml-2 font-normal normal-case tracking-normal">
                    {formatBounds(section.statuses[0]!)}
                  </span>
                </h2>
                <span className="text-xs text-ink-muted">
                  Total budgeted{" "}
                  <Money cents={totalBudgetedCents(section.statuses)} className="font-medium" />
                  {hasOverlappingChildBudget(section.statuses) && (
                    <span className="text-ink-faint"> · overlapping child budgets excluded</span>
                  )}
                </span>
              </div>
              <ul className="grid gap-3 md:grid-cols-2">
                {section.statuses.map((status) => (
                  <BudgetRow
                    key={status.budget.id}
                    status={status}
                    guidanceCents={guidance.get(status.budget.id) ?? 0}
                  />
                ))}
              </ul>
            </section>
          ))
        )}

        <SurfaceCard>
          <h2 className="mb-1 text-sm font-medium">Create a budget</h2>
          <p className="mb-4 text-xs text-ink-muted">
            One active budget per category and period. Budgeting a subcategory alongside its parent is
            allowed — the child&apos;s spending counts toward both, and totals never double-count.
          </p>
          <BudgetForm categories={categories} />
        </SurfaceCard>
      </div>
    </>
  );
}
