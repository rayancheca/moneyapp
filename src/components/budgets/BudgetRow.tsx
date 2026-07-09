import Link from "next/link";
import { deactivateBudgetAction } from "@/app/budgets/actions";
import { Money } from "@/components/ui/Money";
import { transactionsHref } from "@/services/analytics";
import type { BudgetStatus } from "@/services/budgets";

const BAR_TONE: Record<BudgetStatus["alert"], string> = {
  none: "bg-accent",
  warn80: "bg-warning",
  over: "bg-negative",
};

const LABEL_TONE: Record<BudgetStatus["alert"], string> = {
  none: "text-ink-muted",
  warn80: "text-warning",
  over: "text-negative",
};

/** One actual-vs-budget row: progress, figures, and honest leftover language. */
export function BudgetRow({ status }: { status: BudgetStatus }) {
  const { budget, alert } = status;
  const pctDisplay = Math.round(status.pct * 100);
  const barPct = Math.min(100, Math.max(0, status.pct * 100));
  const over = status.remainingCents < 0;

  return (
    <li className="rounded-(--radius-card) border border-line bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link
            href={transactionsHref({
              categoryId: budget.categoryId,
              from: status.bounds.start,
              to: status.bounds.end,
            })}
            className="text-sm font-medium hover:text-accent hover:underline"
          >
            {status.categoryPath}
          </Link>
          {status.isDescendantOfBudgeted && (
            <span className="ml-2 text-[11px] text-ink-faint">
              also counts toward its parent&apos;s budget
            </span>
          )}
        </div>
        <div className={`text-xs font-medium ${LABEL_TONE[alert]}`}>
          {alert === "over" ? "Over budget" : alert === "warn80" ? `${pctDisplay}% used` : `${pctDisplay}%`}
        </div>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barPct)}
        aria-label={`${status.categoryPath} budget used`}
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div className={`h-full rounded-full ${BAR_TONE[alert]}`} style={{ width: `${barPct}%` }} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            <span className="text-ink-faint">Spent </span>
            <Money cents={status.spentCents} />
          </span>
          <span>
            <span className="text-ink-faint">Budget </span>
            <Money cents={budget.amountCents} />
          </span>
          <span>
            <span className="text-ink-faint">{over ? "Over by " : "Left "}</span>
            <Money
              cents={Math.abs(status.remainingCents)}
              className={over ? "text-negative" : undefined}
            />
            {!over && <span className="text-ink-faint"> · does not roll over</span>}
          </span>
        </div>
        <form action={deactivateBudgetAction}>
          <input type="hidden" name="budgetId" value={budget.id} />
          <button
            type="submit"
            className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-negative"
          >
            Deactivate
          </button>
        </form>
      </div>
    </li>
  );
}
