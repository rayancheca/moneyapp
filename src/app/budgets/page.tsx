import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { periodBounds, todayIso, type PeriodBounds } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import {
  budgetGuidanceCents,
  budgetPaceStatuses,
  budgetSections,
  incomeExpectation,
  hasOverlappingChildBudget,
  listBudgetableCategories,
  totalBudgetedCents,
} from "@/services/budgets";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { BudgetForm } from "@/components/budgets/BudgetForm";
import { PredictBudgets } from "@/components/budgets/PredictBudgets";
import { budgetInsights } from "@/services/budget-insights";
import { provenanceFor } from "@/services/provenance";
import { BudgetRow } from "@/components/budgets/BudgetRow";
import { InsightList } from "@/components/insights/InsightList";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { SectionNotes } from "@/components/insights/SectionNotes";
import { InfoTip } from "@/components/ui/InfoTip";
import { BUDGET_JARGON } from "@/lib/jargon";
import { budgetSectionNotes } from "@/lib/section-notes";

export const metadata: Metadata = { title: "Budgets" };
export const dynamic = "force-dynamic";

function formatBounds(bounds: PeriodBounds): string {
  const { start, end } = bounds;
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
  // Graded against the BASIS, not against the paydays that happen to fall in
  // this calendar month. Budgets here were sized from a weekly wage annualised
  // ($1,047 × 52 ÷ 12); grading that plan against a four-payday month marked it
  // over-allocated eight months a year and under-allocated the other four,
  // while the same plan balanced across the year. lib/income-basis carries the
  // reasoning, and `basis.monthNote` states the calendar month underneath so
  // nothing is hidden by the levelling.
  const leftToAllocateCents = income.basis.cents - monthlyBudgetedCents;

  // measured guidance: what the page as a whole knows and no single row states
  const notes = budgetSectionNotes({
    rows: statuses.map((s) => ({
      categoryPath: s.categoryPath,
      overdueCents: s.overdueCents,
      uncoveredDays: s.uncoveredDays,
      pace: s.pace,
    })),
  });

  /**
   * "Prove it" per budget — the same figure kind as a category total, over the
   * budget's own graded window.
   *
   * ⚠️ Measured before it was written, not after: 10 of these cost **23ms
   * total** (2.3ms each) because SQLite's statement cache makes the repeated
   * `accountCoverage` walk nearly free. The per-row-work regression pass 31
   * found is the reason to check; the number is the reason not to build a cache.
   */
  const spendProvenance = new Map(
    statuses.map((s) => [
      s.budget.id,
      provenanceFor(db, {
        kind: "categorySpend",
        categoryId: s.budget.categoryId,
        from: s.bounds.start,
        to: s.bounds.end,
        label: s.categoryPath,
      }),
    ]),
  );

  /**
   * …and what the PLAN is standing on, which is a different question with a
   * different answer. The actual is a sum of documented rows; the plan is a
   * decision, so its honest verdict is `manual` and its badge reads "a plan"
   * rather than the stock "you entered it" — these were sized by
   * `pnpm propose-budgets` and kept, and no column can tell a typed plan from an
   * accepted proposal.
   *
   * ⚠️ Free next to the block above: `budgetPlanProvenance` is two indexed
   * lookups and no coverage walk. Measured — all 12 monthly plans together cost
   * 1ms, against 23ms for the twelve `categorySpend` proofs.
   */
  const planProvenance = new Map(
    statuses.map((s) => [
      s.budget.id,
      provenanceFor(db, { kind: "budgetPlan", id: s.budget.id, label: s.categoryPath }),
    ]),
  );

  // where the biggest plan sits among the others — two facts the page holds
  // and never states, because it orders its rows by category and not by amount
  const insights = budgetInsights(db, today);

  const sections = budgetSections(statuses, today);

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
              <Money cents={income.basis.cents} className="font-medium" />
              <span className="text-ink-muted"> expected income</span>
              {/* Mounted on the TERM, not on the figure: the surprise is not the
                  number, it is which arithmetic produced it. The body comes off
                  `income.basis` rather than being picked here, so the figure and
                  its definition are chosen by one branch. */}
              <InfoTip term="expected income" placement="bottom">
                {income.basis.explanation}
              </InfoTip>
            </p>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {/* One definition, two mount sites — exactly one of which ever
                renders. Both branches describe the same subtraction, and the
                monthly-only scope is the surprising half of it in either
                direction. */}
            {leftToAllocateCents >= 0 ? (
              <>
                <Money cents={leftToAllocateCents} className="font-medium text-ink" /> left to
                allocate
                <InfoTip term="left to allocate" placement="bottom">
                  {BUDGET_JARGON.leftToAllocate}
                </InfoTip>
              </>
            ) : (
              <>
                <span className="font-medium text-danger">
                  Over-allocated by <Money cents={-leftToAllocateCents} />
                </span>
                <InfoTip term="over-allocated" placement="bottom">
                  {BUDGET_JARGON.leftToAllocate}
                </InfoTip>{" "}
                {/* Named by the SAME branch that chose the figure. Hard-coded
                    here, this clause said "more than this month is expected to
                    bring in" while the grading figure was an annual rate — and
                    in the four five-payday months a year the month brings in
                    MORE than the budgets, so it stated the reverse of the note
                    two lines below it. */}
                — {income.basis.overAllocatedClause}
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
          {/* The calendar month, named rather than deleted. Levelling makes the
              figure above hold still; this says what the month it is describing
              actually pays, and by how much the two differ. Authored in
              `lib/income-basis` beside the branch that chose the figure, so the
              two cannot describe different months. */}
          {income.basis.monthNote && (
            <p className="mt-1 text-xs text-ink-faint">{income.basis.monthNote}</p>
          )}
        </SurfaceCard>
      )}

      <SectionNotes notes={notes} label="What this page noticed" />

      {/* Under the totals and their caveats, above the rows: a reader who has
          seen what is budgeted against what is expected is ready for sentences
          about the shape of it, and a claim printed before its own subject reads
          as a page banner. Same order /spending settled on. */}
      {insights && <InsightList data={insights} heading="How the plan is shaped" />}

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
                    {formatBounds(section.bounds)}
                  </span>
                </h2>
                <span className="text-xs text-ink-muted">
                  Total budgeted
                  {/* One per SECTION, never per row. The exclusion rule below is
                      invisible unless it bites — the page prints "overlapping
                      child budgets excluded" only when a child is actually
                      dropped, so on every other page load the sum looks like
                      plain addition and is not. */}
                  <InfoTip term="Total budgeted" placement="bottom">
                    {BUDGET_JARGON.totalBudgeted}
                  </InfoTip>{" "}
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
                    spentProvenance={spendProvenance.get(status.budget.id) ?? null}
                    planProvenance={planProvenance.get(status.budget.id) ?? null}
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
