/**
 * Budget suggestions from spending history (user ask: "create budgets for me
 * based on predictions"). Pure — no db, no React.
 *
 * HONESTY: a suggestion is a DESCRIPTION of recent behavior, not a forecast —
 * the amount is the average of the last N complete months (a month with no
 * spending is a real $0 month; a net-refund month clamps to $0), rounded UP to
 * the nearest $10 so a clean average never turns into an instant "over
 * budget". Every suggestion carries its basis so the UI can say exactly where
 * the number came from. One-offs (a single active month) and noise (average
 * under the floor) earn no budget.
 */

export interface CategorySpendMonths {
  categoryId: string;
  /** display label ("Food") */
  label: string;
  /** subtree spending per COMPLETE month, cents, oldest → newest */
  monthly: number[];
}

export interface BudgetSuggestion {
  categoryId: string;
  label: string;
  /** the suggested monthly budget, cents (avg rounded up to the nearest $10) */
  amountCents: number;
  /** the raw average the suggestion came from, cents */
  avgCents: number;
  /** months (of the window) with any spending */
  activeMonths: number;
}

export interface SuggestOptions {
  /** months with spending required before a budget is suggested */
  minActiveMonths?: number;
  /** averages below this earn no budget (noise), cents */
  floorCents?: number;
  /** round the suggestion UP to this granularity, cents */
  roundToCents?: number;
}

export function suggestBudgetAmounts(
  rows: readonly CategorySpendMonths[],
  options: SuggestOptions = {},
): BudgetSuggestion[] {
  const minActiveMonths = options.minActiveMonths ?? 2;
  const floorCents = options.floorCents ?? 2_000;
  const roundToCents = options.roundToCents ?? 1_000;

  const out: BudgetSuggestion[] = [];
  for (const row of rows) {
    if (row.monthly.length === 0) continue;
    const clamped = row.monthly.map((m) => Math.max(m, 0));
    const activeMonths = clamped.filter((m) => m > 0).length;
    if (activeMonths < minActiveMonths) continue;
    const avgCents = Math.round(clamped.reduce((s, m) => s + m, 0) / clamped.length);
    if (avgCents < floorCents) continue;
    out.push({
      categoryId: row.categoryId,
      label: row.label,
      amountCents: Math.ceil(avgCents / roundToCents) * roundToCents,
      avgCents,
      activeMonths,
    });
  }
  return out.sort((a, b) => b.amountCents - a.amountCents);
}
