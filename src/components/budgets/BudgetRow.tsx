"use client";

import Link from "next/link";
import { deactivateBudgetAction } from "@/app/budgets/actions";
import { Icon } from "@/components/shell/Icon";
import { ConfirmActionButton } from "@/components/ui/Confirm";
import { Money } from "@/components/ui/Money";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { Popover, usePopover } from "@/components/ui/Popover";
import { formatDayShort } from "@/lib/format-date";
import { formatCents } from "@/lib/money";
import type { BudgetPace, BudgetPaceStatus } from "@/services/budgets";
import { BudgetAmountEditor, PERIOD_WORD } from "./BudgetAmountEditor";

/** Pace → the bar fill and the label tone. Green→amber→red by projected pace. */
const PACE: Record<BudgetPace, { fill: string; text: string; label: string }> = {
  under: { fill: "bg-positive", text: "text-positive", label: "On track" },
  "at-risk": { fill: "bg-warning", text: "text-warning", label: "Off pace" },
  over: { fill: "bg-negative", text: "text-negative", label: "Over budget" },
};

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function paceSentence(status: BudgetPaceStatus): string {
  const projected = `projected ${formatCents(status.projectedCents)}`;
  if (status.pace === "over") return `over budget by ${formatCents(-status.remainingCents)}`;
  if (status.pace === "at-risk") return `off pace — ${projected}, over budget`;
  return `on track — ${projected}`;
}

interface BudgetRowProps {
  status: BudgetPaceStatus;
  guidanceCents: number;
}

/**
 * One pace-aware budget row (ux-overhaul §8): a bar coloured green→amber→red by
 * PROJECTED pace, a today tick at the elapsed fraction, and a hollow tail for
 * expected-but-unposted recurring that opens a popover of the contributing
 * series (drill-down contract). The amount edits inline; the row links to the
 * category page, which shows the budget back.
 */
export function BudgetRow({ status, guidanceCents }: BudgetRowProps) {
  const { budget, tail } = status;
  const tone = PACE[status.pace];
  const pctDisplay = Math.round(status.pct * 100);
  // the headline % must say WHAT it measures: 108% of a budget is "over BY 8%",
  // never "over budget · 108%" (which reads as 108% over)
  const overPct = (status.pct - 1) * 100;
  const headline =
    status.pace === "over"
      ? `Over budget by ${overPct < 1 ? "<1" : Math.round(overPct)}%`
      : `${tone.label} · ${pctDisplay}% used`;

  const spentPct = clampPct(status.pct * 100);
  const tailEndPct = clampPct(((status.spentCents + status.expectedTailCents) / budget.amountCents) * 100);
  const tailWidth = Math.max(0, tailEndPct - spentPct);
  const tickPct = clampPct(status.elapsedFraction * 100);
  const over = status.remainingCents < 0;

  const tailPopover = usePopover<HTMLButtonElement>();

  const valueText = `${status.categoryPath}: ${formatCents(status.spentCents)} of ${formatCents(
    budget.amountCents,
  )} (${pctDisplay}% of budget). ${paceSentence(status)}.${
    status.expectedTailCents > 0
      ? ` ${formatCents(status.expectedTailCents)} in recurring still expected this period.`
      : ""
  }`;

  return (
    <li className="rounded-(--radius-card) border border-line bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link
            href={`/categories/${budget.categoryId}`}
            className="text-sm font-medium hover:text-accent hover:underline"
          >
            {status.categoryPath}
          </Link>
          {status.isDescendantOfBudgeted && (
            <span className="ml-2 text-[11px] text-ink-faint">also counts toward its parent&apos;s budget</span>
          )}
        </div>
        <div className={`text-xs font-medium ${tone.text}`}>{headline}</div>
      </div>

      <div
        role="progressbar"
        aria-label={`${status.categoryPath} budget`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(spentPct)}
        aria-valuetext={valueText}
        className="relative mt-3 h-2.5"
      >
        <div className="absolute inset-0 overflow-hidden rounded-full bg-surface-sunken">
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${tone.fill}`}
            style={{ width: `${spentPct}%` }}
          />
          {tailWidth > 0 && (
            <div
              aria-hidden
              className={`absolute inset-y-0 rounded-r-full border border-l-0 border-dashed ${tone.text} opacity-70`}
              style={{ left: `${spentPct}%`, width: `${tailWidth}%`, borderColor: "currentColor" }}
            />
          )}
        </div>
        {/* today tick — the pace reference; fill left of it means you are ahead */}
        <div
          aria-hidden
          className="absolute top-[-2px] bottom-[-2px] w-0.5 -translate-x-1/2 rounded-full bg-ink/70"
          style={{ left: `${tickPct}%` }}
        />
      </div>

      {status.expectedTailCents > 0 && (
        <div className="mt-2">
          <button
            type="button"
            {...tailPopover.triggerProps}
            aria-expanded={tailPopover.open}
            className="inline-flex items-center gap-1 rounded-md text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Icon name="repeat" className="size-3 text-ink-faint" />
            <span>
              <Money cents={status.expectedTailCents} /> expected before {formatDayShort(status.bounds.end)}
            </span>
            <Icon name="chevron-down" className="size-3 text-ink-faint" />
          </button>
          <Popover
            anchorRef={tailPopover.anchorRef}
            open={tailPopover.open}
            onClose={tailPopover.close}
            placement="bottom-start"
            className="w-72"
          >
            <div className="p-1">
              <p className="px-3 py-2 text-[11px] uppercase tracking-[0.1em] text-ink-faint">
                Expected before {formatDayShort(status.bounds.end)} · {formatCents(status.expectedTailCents)}
              </p>
              <ul>
                {tail.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={s.href}
                      className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{s.name}</span>
                        <span className="text-xs text-ink-faint">
                          {formatDayShort(s.nextDate)}
                          {s.occurrenceCount > 1 ? ` · ${s.occurrenceCount}×` : ""} · {s.cadence}
                        </span>
                      </span>
                      <Money cents={s.amountCents} className="shrink-0 text-ink-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </Popover>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span>
            <span className="text-ink-faint">Spent </span>
            <Money cents={status.spentCents} />
          </span>
          <span>
            <span className="text-ink-faint">Budget </span>
            <NumberRoll value={formatCents(budget.amountCents)} />
          </span>
          <span>
            <span className="text-ink-faint">{over ? "Over by " : "Left "}</span>
            <NumberRoll
              value={formatCents(Math.abs(status.remainingCents))}
              className={over ? "text-negative" : undefined}
            />
          </span>
          {status.pace !== "over" && (
            <span>
              <span className="text-ink-faint">Projected ≈ </span>
              <Money cents={status.projectedCents} className={status.pace === "at-risk" ? "text-warning" : undefined} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <BudgetAmountEditor
            budgetId={budget.id}
            amountCents={budget.amountCents}
            guidanceCents={guidanceCents}
            period={budget.period}
            categoryPath={status.categoryPath}
          />
          <ConfirmActionButton
            action={deactivateBudgetAction}
            fields={{ budgetId: budget.id }}
            triggerLabel="Deactivate"
            triggerAriaLabel={`Deactivate the ${status.categoryPath} budget`}
            triggerClassName="rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-negative focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title="Deactivate this budget"
            confirmLabel="Deactivate this budget"
            radius={{
              headline: `${status.categoryPath} stops being budgeted. Its spending keeps posting to the ledger — only the pace row, its projection and its alerts go.`,
              lines: [
                {
                  label: "Budget stopped",
                  value: `${formatCents(budget.amountCents)} / ${PERIOD_WORD[budget.period]}`,
                  irreversible: true,
                },
                { label: "Spent so far this period", value: formatCents(status.spentCents) },
                ...(status.expectedTailCents > 0
                  ? [
                      {
                        label: "Recurring still expected this period",
                        value: formatCents(status.expectedTailCents),
                      },
                    ]
                  : []),
              ],
              reassurance:
                "No transaction is changed and nothing is deleted — set the budget again to resume tracking.",
            }}
          />
        </div>
      </div>
    </li>
  );
}
