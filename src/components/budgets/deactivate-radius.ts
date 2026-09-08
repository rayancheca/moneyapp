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
 * `budgetPaceStatuses` builds the tail strictly after today and the arrears on
 * or before it — so both are printed, never added. Past first, then future:
 * that is the order the row above the button reads in.
 */
export interface BudgetDeactivateInput {
  /** the plan itself, already formatted with its period word */
  budgetPhrase: string;
  spentCents: number;
  /** bills due on or before today that never posted */
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
      ? [{ label: "Already due this period, not imported", value: formatCents(input.overdueCents) }]
      : []),
    ...(input.expectedTailCents > 0
      ? [{ label: "Recurring still expected this period", value: formatCents(input.expectedTailCents) }]
      : []),
  ];
}
