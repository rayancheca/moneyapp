"use client";

import Link from "next/link";
import { useState } from "react";
import { deactivateBudgetAction } from "@/app/budgets/actions";
import { Icon } from "@/components/shell/Icon";
import { ConfirmActionButton } from "@/components/ui/Confirm";
import type { Provenance } from "@/services/provenance";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { InfoTip } from "@/components/ui/InfoTip";
import { Popover, usePopover } from "@/components/ui/Popover";
import { formatDayShort } from "@/lib/format-date";
import { budgetVerdict } from "@/lib/budget-verdict";
import { formatCents } from "@/lib/money";
import type { BudgetPace, BudgetPaceStatus } from "@/services/budgets";
import { DisclosureChevron, DisclosureRegion, useDisclosure } from "@/components/ui/Disclosure";
import { BudgetAmountEditor, PERIOD_WORD } from "./BudgetAmountEditor";
import { BudgetDetails } from "./BudgetDetails";
import { BudgetRolloverToggle } from "./BudgetRolloverToggle";
import { budgetDeactivateLines } from "./deactivate-radius";

/**
 * Pace → the bar fill and the label tone. Green→amber→red by projected pace.
 *
 * Colours only. The words live in `budgetVerdict`, with the definition that
 * explains them — a label here and a definition there is exactly the split that
 * let a tooltip describe a mark the row did not draw.
 */
const PACE: Record<BudgetPace, { fill: string; text: string }> = {
  under: { fill: "bg-positive", text: "text-positive" },
  "at-risk": { fill: "bg-warning", text: "text-warning" },
  over: { fill: "bg-negative", text: "text-negative" },
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

/**
 * "no spending imported since 8 Jul · 11 days of this period unaccounted".
 * Statement lag is normal here — accounts land on different dates each month —
 * so this reads as a fact about coverage, never as an error.
 *
 * 🔴 THE DOCSTRING WAS RIGHT AND THE CODE DROPPED THREE WORDS. It rendered
 * "· 2 days unaccounted" beside "no spending imported since Aug 12", and on
 * 2026-09-02 that pair invited a reader to compute 21 days and find the card
 * wrong about itself. `uncoveredDays` is scoped to the BUDGET PERIOD — Sep 1
 * and Sep 2 — and never to the elapsed gap since the last import. Same shape as
 * the trust card's bare "52 days" next to "since Dec 5, 2023": two true numbers
 * that a reader joins into one false one. The qualifier is what separates them.
 */
function coverageSentence(status: BudgetPaceStatus): string {
  const days = `${status.uncoveredDays} day${status.uncoveredDays === 1 ? "" : "s"} of this period unaccounted`;
  return status.dataThroughOn
    ? `no spending imported since ${formatDayShort(status.dataThroughOn)} · ${days}`
    : `nothing imported for this category yet · ${days}`;
}

interface BudgetRowProps {
  status: BudgetPaceStatus;
  guidanceCents: number;
  /** what the SPENT figure is standing on — null while none can be computed */
  spentProvenance: Provenance | null;
  /**
   * What the PLAN is standing on. A separate proof on purpose: the actual is a
   * sum of documented rows and the plan is a decision he made, so one badge
   * cannot answer for both. Null only when the budget has vanished underneath
   * the render.
   */
  planProvenance: Provenance | null;
}

/**
 * One pace-aware budget row (ux-overhaul §8): a bar coloured green→amber→red by
 * PROJECTED pace, a today mark at the elapsed fraction (drawn only while the bar
 * is still to scale — see `budgetVerdict`), and a hollow tail for
 * expected-but-unposted recurring that opens a popover of the contributing
 * series (drill-down contract). The amount edits inline; the row links to the
 * category page, which shows the budget back.
 *
 * The headline and the definition beside it both come from `budgetVerdict`, so
 * the words and their explanation are chosen by one branch.
 */
export function BudgetRow({ status, guidanceCents, spentProvenance, planProvenance }: BudgetRowProps) {
  const { budget, tail } = status;
  // Lifted out of BudgetRolloverToggle so the details panel reacts to the toggle
  // immediately. Left inside the toggle, the panel would read the stale server
  // prop until router.refresh() landed and show the wrong half of its copy.
  const [rolloverEnabled, setRolloverEnabled] = useState(budget.rolloverEnabled);
  const tone = PACE[status.pace];
  const pctDisplay = Math.round(status.pct * 100);

  // The headline, what it means, and whether the bar is still to scale — all
  // from one branch, so the words and the definition beside them cannot drift.
  // Every state it can return is unit-tested; only two of the four can render in
  // the e2e fixture.
  const verdict = budgetVerdict({
    pace: status.pace,
    pct: status.pct,
    uncoveredDays: status.uncoveredDays,
  });
  const { headline, withheld: undermeasured, barIsFull } = verdict;

  const spentPct = clampPct(status.pct * 100);
  // divides by AVAILABLE, the same denominator as `pct` — dividing the tail by the
  // plan while the fill divides by available would draw a tail longer than the
  // spend it extends
  const tailEndPct = clampPct(
    ((status.spentCents + status.expectedTailCents) / status.availableCents) * 100,
  );
  const tailWidth = Math.max(0, tailEndPct - spentPct);
  const tickPct = clampPct(status.elapsedFraction * 100);
  // "Over by" vs "Left" in the figures cluster below — and NOT the same question
  // as `barIsFull`. This is `remaining < 0` (strictly past the line); the bar
  // fills at `spent >= available`. They disagree at exactly 100%, where "Left
  // $0.00" is the right words over a bar that has just filled.
  const over = status.remainingCents < 0;

  const tailPopover = usePopover<HTMLButtonElement>();
  const details = useDisclosure();

  // The elapsed fraction is what the today mark encodes, and the mark is
  // `aria-hidden` — so without this clause the spoken row is strictly poorer
  // than the drawn one, and on a full bar (where the mark is not drawn at all)
  // nothing would state it. Placed EARLY in the sentence on purpose: the overdue
  // clause at the end is asserted with an end-anchored regex.
  const elapsedSentence = `${Math.round(status.elapsedFraction * 100)}% of this period has passed`;
  // the spoken sentence uses the SAME denominator the visual bar does, or
  // assistive tech gets a strictly worse number than the sighted reader
  const valueText = `${status.categoryPath}: ${formatCents(status.spentCents)} of ${formatCents(
    status.availableCents,
  )}${
    status.rolloverCents > 0 ? ` (${formatCents(status.rolloverCents)} rolled over)` : ""
  } (${pctDisplay}% of budget). ${elapsedSentence}. ${undermeasured ? coverageSentence(status) : paceSentence(status)}.${
    status.expectedTailCents > 0
      ? ` ${formatCents(status.expectedTailCents)} in recurring still expected this period.`
      : ""
  }${
    status.overdueCents > 0
      ? ` ${formatCents(status.overdueCents)} was expected by now and has not been imported.`
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
        <div className={`text-xs font-medium ${undermeasured ? "text-ink-faint" : tone.text}`}>
          {headline}
          {/* One per ROW, departing from the "one tip per group" rule /categories
              set — deliberately, and for the two reasons that rule was costed on.
              A budgets page carries a handful of rows rather than 77, and what is
              being explained DIFFERS per row: the headline is one of four
              readings, and a clamped bar does not render the today mark, so a
              single section-level definition would describe something the row in
              front of the reader does not have.

              The category is in the accessible name because the page carries one
              of these per row, and four buttons all called "What the pace means"
              are indistinguishable in a screen reader's control list. */}
          <InfoTip term={`the ${status.categoryPath} pace`} placement="bottom">
            {verdict.explanation}
          </InfoTip>
        </div>
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
            className={`absolute inset-y-0 left-0 rounded-full ${undermeasured ? "bg-ink-faint/40" : tone.fill}`}
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
        {/* Today mark — the pace reference; fill left of it means you are ahead.
            NOT drawn once the fill is clamped. Above 100% the bar has stopped
            showing the quantity the mark exists to be compared against (108% and
            300% both draw full), so the comparison would be against a number no
            longer on screen — and with no unfilled side, the mark has nothing to
            divide. Reported by the owner on the Housing row, which reads 108%.
            The elapsed figure it encodes is still spoken in `aria-valuetext`. */}
        {!barIsFull && (
          <div
            aria-hidden
            data-today-tick
            className="absolute top-[-2px] bottom-[-2px] w-0.5 -translate-x-1/2 rounded-full bg-ink/70"
            style={{ left: `${tickPct}%` }}
          />
        )}
      </div>

      {undermeasured && (
        <p className="mt-2 text-xs text-ink-faint">{coverageSentence(status)}</p>
      )}

      {/* Due already and still not posted. Distinct from the forward tail on
          purpose: the tail is money the month has not reached yet, this is money
          the month has passed and cannot account for. Reading "on track" over a
          missing rent payment is the failure this exists to prevent. */}
      {status.overdueCents > 0 && (
        <p className="mt-2 text-xs text-warning">
          {formatCents(status.overdueCents)} expected by now, not imported
          {status.overdue.length > 0 && (
            <span className="text-ink-faint">
              {" · "}
              {status.overdue.map((o) => `${o.name} ${formatDayShort(o.nextDate)}`).join(", ")}
            </span>
          )}
        </p>
      )}

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
            {/* the actual is a SUM of rows, so it is only as proven as its
                weakest one — beside the figure, never wrapping it */}
            {spentProvenance && (
              <ProvenancePopover label={`${status.categoryPath} spent`} provenance={spentProvenance} />
            )}
          </span>
          {/* With a carry, "Budget $50 · Left $631" cannot be reconciled by the
              reader, so the row names the line it is actually graded against and
              shows its two parts. The editor below still edits the PLAN. */}
          <span>
            <span className="text-ink-faint">{status.rolloverCents > 0 ? "Available " : "Budget "}</span>
            <NumberRoll value={formatCents(status.availableCents)} />
            {status.rolloverCents > 0 && (
              <span className="text-ink-faint">
                {" ("}
                {formatCents(budget.amountCents)} plan + {formatCents(status.rolloverCents)} rolled
                over)
              </span>
            )}
            {/* ⛔ Proves the PLAN, never the figure beside it when a carry is on.
                With rollover the label reads "Available" and the number is plan
                + carry, so the badge is named for what it actually answers for
                and its panel says in words that the carry is measured from the
                ledger rather than chosen. */}
            {planProvenance && (
              <ProvenancePopover
                label={`${status.categoryPath} ${status.rolloverCents > 0 ? "plan" : "budget"}`}
                provenance={planProvenance}
                placement="bottom-end"
              />
            )}
          </span>
          <span>
            <span className="text-ink-faint">{over ? "Over by " : "Left "}</span>
            <NumberRoll
              value={formatCents(Math.abs(status.remainingCents))}
              className={over ? "text-negative" : undefined}
            />
          </span>
          {status.pace !== "over" && status.projectedCents !== status.spentCents && (
            <span>
              <span className="text-ink-faint">Projected ≈ </span>
              <Money cents={status.projectedCents} className={status.pace === "at-risk" ? "text-warning" : undefined} />
            </span>
          )}
        </div>
        {/* flex-wrap is load-bearing, not cosmetic: this row now carries four
            controls and 320px is swept for horizontal overflow. */}
        <div className="flex flex-wrap items-center gap-1">
          <BudgetRolloverToggle
            budgetId={budget.id}
            enabled={rolloverEnabled}
            onChange={setRolloverEnabled}
            categoryPath={status.categoryPath}
          />
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
              /* the alerts this turns off are the row's, and one of them is the
                 arrears — see `budgetDeactivateLines` for the month it read
                 "$0.00 spent" over */
              lines: budgetDeactivateLines(
                {
                  budgetPhrase: `${formatCents(budget.amountCents)} / ${PERIOD_WORD[budget.period]}`,
                  spentCents: status.spentCents,
                  overdueCents: status.overdueCents,
                  expectedTailCents: status.expectedTailCents,
                },
                formatCents,
              ),
              reassurance:
                "No transaction is changed and nothing is deleted — set the budget again to resume tracking.",
            }}
          />
          {/* in the controls cluster, not on its own line below it — the trigger
              is a sibling of Edit and Deactivate, and wraps with them */}
          <button
            type="button"
            onClick={details.toggle}
            aria-expanded={details.triggerProps["aria-expanded"]}
            aria-controls={details.triggerProps["aria-controls"]}
            aria-label={`Details for the ${status.categoryPath} budget`}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Details
            <DisclosureChevron open={details.open} />
          </button>
        </div>
      </div>

      {/* Panel content renders only when open — the page carries one of these per
          budget and nothing in it is needed to read the bar. */}
      <DisclosureRegion open={details.open} regionId={details.regionId}>
        {(open) =>
          open ? <BudgetDetails status={status} rolloverEnabled={rolloverEnabled} /> : null
        }
      </DisclosureRegion>
    </li>
  );
}
