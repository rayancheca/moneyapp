import Link from "next/link";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatDayShort } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import type { CategoryBudgetRef } from "@/services/category-detail";

interface CategoryBudgetCardProps {
  /** the category's active budget, graded at today (`categoryBudgetRef`) */
  budget: CategoryBudgetRef;
}

/**
 * The colour of "left" or "over" — and none at all while the row's verdict is withheld.
 *
 * ⛔ /budgets prints its "Left" in no colour beside "Awaiting statements" or "Cash only", and this card is the same row
 * and window. 🔴 It read `alert` alone, which never asks how much of the window was imported: green "$2,291.21 left"
 * over an October nobody had imported, on his ledger copy 2026-10-12. A withheld verdict is never `over` (past the
 * line on partial data is graded — `budgetVerdict`), so what is left is a figure that can only fall, never a verdict.
 */
function leftTone(budget: CategoryBudgetRef): string | undefined {
  if (budget.verdict.withheld) return undefined;
  if (budget.alert === "over") return "text-negative";
  return budget.alert === "warn80" ? "text-warning" : "text-positive";
}

/**
 * `/categories/<id>`'s budget card: the category's budget, graded at today, read the way its /budgets row reads it.
 *
 * While that row's verdict is withheld the card says so in the row's own words — the headline ("Awaiting statements",
 * "Cash only") and the row's coverage sentence under it — and calls nothing healthy. A measured window keeps the
 * figures and colours it always had.
 *
 * ⛔ Not the definition /budgets puts beside that headline: every one of them ends on the bar's anatomy ("the dark mark
 * is how far through the period you are"), and this card draws no bar — a definition of a mark the reader cannot see
 * is the one `paceOver` is written without (`lib/jargon`). The coverage sentence says why; "Budgets →" leads to the rest.
 */
export function CategoryBudgetCard({ budget }: CategoryBudgetCardProps) {
  const { verdict } = budget;
  return (
    <SurfaceCard>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {/* beside the heading, never in it: the card is still called "Budget" */}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-sm font-medium">Budget</h2>
            {verdict.withheld && <span className="text-xs font-medium text-ink-faint">{verdict.headline}</span>}
          </div>
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
          {budget.coverageSentence !== null && <p className="text-xs text-ink-faint">{budget.coverageSentence}</p>}
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span>
            <Money cents={budget.spentCents} /> of <Money cents={budget.availableCents} />
          </span>
          <span className={leftTone(budget)}>
            {budget.remainingCents >= 0
              ? `${formatCents(budget.remainingCents)} left`
              : `${formatCents(-budget.remainingCents)} over`}
          </span>
          <Link href={budget.href} className="text-accent hover:underline">Budgets →</Link>
        </div>
      </div>
    </SurfaceCard>
  );
}
