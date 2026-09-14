import type { BlastRadiusLine } from "@/components/ui/blast-radius";

/**
 * What the owner is switching off when he deactivates a budget, in his units.
 *
 * 🔴 IT NAMED THE FUTURE AND NOT THE ARREARS. The dialog listed "Spent so far
 * this period" and "Recurring still expected this period" and stopped, so on
 * the owner's ledger 2026-09-08 the Housing budget's confirmation read
 *
 *     Budget stopped                  $2,291.21 / month
 *     Spent so far this period        $0.00
 *
 * of a month in which $2,291.21 — the budget to the cent — had come due on
 * Sep 1 and never posted. The row behind the dialog says so in warning colour
 * ("$2,291.21 expected by now, not imported · Flamingo South Beach (rent)
 * Sep 1, Rent utilities & fees Sep 1"), the bar's own `aria-label` says it in
 * words, the projection counts it, and `/budgets`' page note counts it across
 * three budgets — "That money is committed, so the room left is smaller than it
 * looks." Only the dialog that turns the alert off left it out, and left "$0.00
 * spent" standing alone as the whole story. Measured: three of the twelve
 * budgets understated, Housing by $2,291.21, Utilities by $108.87 and
 * Subscriptions by $4.99 of a $10.99 month.
 *
 * ⛔ `overdueCents` and `expectedTailCents` are DISJOINT by construction —
 * `budgetPaceStatuses` builds the tail strictly after today and the due leg on
 * or before it — so both are printed, never added. Due first, then future:
 * that is the order the row above the button reads in.
 *
 * 🔴 AND "DUE" IS NOT "LATE". The line read "Already due this period, not
 * imported" over a figure that INCLUDES today — a bill dated today is due, not
 * overdue, until it posts. Measured over 61 asking days in Sep–Oct 2026, the
 * line held a bill dated that very day on 13 of them (15 budget rows; the car
 * lease on the 15th, Housing's rent on the 1st). The cents cannot say which
 * part is dated today, so the label says what is true of both: due by today.
 * ⛔ Do NOT move the edge to make "already" true — `budgetTail` opens the day
 * AFTER today, so a bill dated today would then be in neither leg.
 */
export interface BudgetDeactivateInput {
  /** the plan itself, already formatted with its period word */
  budgetPhrase: string;
  spentCents: number;
  /** bills due on or before today — late, or due today and not yet posted */
  overdueCents: number;
  /** recurring still to come before the period closes */
  expectedTailCents: number;
}

export function budgetDeactivateLines(
  input: BudgetDeactivateInput,
  formatCents: (cents: number) => string,
): BlastRadiusLine[] {
  return [
    { label: "Budget stopped", value: input.budgetPhrase, irreversible: true },
    { label: "Spent so far this period", value: formatCents(input.spentCents) },
    ...(input.overdueCents > 0
      ? [
          // ⛔ both ends: the figure is `budgetOverdue` from the period start to
          // today — a bill due last period is not in it (arrears end with the
          // month, his decision 2026-09-02), and the sibling lines name the period
          { label: "Due this period by today, not imported", value: formatCents(input.overdueCents) },
        ]
      : []),
    ...(input.expectedTailCents > 0
      ? [{ label: "Recurring still expected this period", value: formatCents(input.expectedTailCents) }]
      : []),
  ];
}
