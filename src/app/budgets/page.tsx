import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { periodBounds, todayIso, type PeriodBounds } from "@/lib/dates";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { paidByAnotherMonthNote, paidForAnotherMonthNote } from "@/lib/paid-by-another-month";
import { unbankedIncomeFrontierClause } from "@/lib/unbanked-income";
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
  // which of the passed paydays the ledger has looked for — null when all of them
  const passedUnread = unbankedIncomeFrontierClause(
    {
      occurrenceCount: income.passedUnpaidOccurrences,
      checkedOccurrenceCount: income.passedUnpaidCheckedOccurrences,
      frontier: income.passedUnpaidFrontier,
    },
    formatDayLong,
  );
  // the fourth leg: paydays this month that another month's money paid — null when none
  const paidElsewhere = paidByAnotherMonthNote(
    {
      cents: income.paidByAnotherMonthCents,
      occurrences: income.paidByAnotherMonthOccurrences,
      deposits: income.paidByAnotherMonthDeposits,
    },
    monthBounds.start,
  );
  // …and its mirror: money in so far that paid another month's paydays — null when none
  const paidForElsewhere = paidForAnotherMonthNote({
    cents: income.paidForAnotherMonthCents,
    deposits: income.paidForAnotherMonthDeposits,
    paydays: income.paidForAnotherMonthPaydays,
  });
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
      // occurrences, not series — the same rows `overdueCents` was summed from,
      // so the count and the money it describes cannot drift apart
      overdueBills: s.overdue.reduce((n, o) => n + o.occurrenceCount, 0),
      uncoveredDays: s.uncoveredDays,
      pace: s.pace,
      // so a row spent only from cash wallets is left out on the row's own rule
      spentFromAccounts: s.spentFromAccounts,
      spentFromWallets: s.spentFromWallets,
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
                  {BUDGET_JARGON.overAllocated}
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
            {(income.expectedCents > 0 ||
              income.postedCents > 0 ||
              income.passedUnpaidCents > 0 ||
              income.paidByAnotherMonthCents > 0) && (
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
          {/* 🔴 THE THIRD LEG, NAMED.
              `postedCents` stops at today and `expectedCents` opens on it, so a
              payday that passed with nothing banked is in neither — and the
              month note one line above prints what the whole month is scheduled
              to pay. Read on 2026-09-04, the day after a Thursday payday:
              "$0.00 in so far, $3,141.00 still expected" over "4 paydays fall in
              this month, scheduled at $4,188.00", with $1,047.00 called nothing
              at all. The 09-03 session moved the forward leg onto `today` and
              closed the one day in seven where the payday IS today; this is the
              other six.

              ⛔ Named rather than added to "still expected", because income has
              no arrears leg by doctrine — a payday that passed without a deposit
              is evidence about the imports, not about the job. The spending side
              two lines down says the same shape for bills, and it can add its
              figure because a bill nobody paid is still owed. */}
          {/* 🔴 "with no deposit against them" was said of Sep 3 and Sep 10 while
              the account that pay lands in was checked through Aug 12 (measured
              2026-09-15). It is said now only when every passed payday fell on
              a day the ledger has checked; otherwise `passedUnread` names the
              rest as not looked for, in /spending's words. */}
          {income.passedUnpaidCents > 0 && (
            <p className="mt-1 text-xs text-ink-faint">
              {income.passedUnpaidOccurrences === 1 ? "1 payday" : `${income.passedUnpaidOccurrences} paydays`}{" "}
              worth <Money cents={income.passedUnpaidCents} /> already passed this month
              {passedUnread === null && (
                <> with no deposit against {income.passedUnpaidOccurrences === 1 ? "it" : "them"}</>
              )}{" "}
              — counted in neither figure above.{" "}
              {passedUnread ??
                "That is evidence about what has been imported, not about whether the money was earned."}
            </p>
          )}
          {/* 🔴 THE FOURTH LEG, NAMED — his answer to §6A 29. A payday paid by
              money that landed in ANOTHER month is in none of the three: not
              "in so far" (the deposit is last month's), not "still expected"
              (it was paid), not "already passed" (settlement says it was met).
              Read on 2026-10-02 with Thu Oct 1 paid by the deposit of Wed Sep
              30: "$0.00 in so far, $4,567.68 still expected" under "5 paydays
              fall in this month, scheduled at $5,709.60", and $1,141.92 called
              nothing at all. */}
          {paidElsewhere && <p className="mt-1 text-xs text-ink-faint">{paidElsewhere}</p>}
          {/* 🔴 …AND ITS MIRROR, because the two cancel. Money in "in so far"
              can have paid ANOTHER month's payday: Thu Oct 1's deposit paid Aug
              27 once Wed Sep 30's lump had taken Oct 1. With only the fourth
              leg named, that October read $1,141.92 in so far + $4,567.68
              still expected + $1,141.92 paid early against $5,709.60
              scheduled — a week over, and nothing said which. */}
          {paidForElsewhere && <p className="mt-1 text-xs text-ink-faint">{paidForElsewhere}</p>}
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
