import type { BudgetPaceKind } from "@/lib/budget-verdict";

/**
 * Pace → the bar fill and the text tone. Green→amber→red by projected pace — a /budgets row's headline, and the
 * category page's budget card's "left" for the same row.
 *
 * Colours only. The words live in `budgetVerdict`, with the definition that explains them — a label here and a
 * definition there is exactly the split that let a tooltip describe a mark the row did not draw.
 *
 * ⛔ One table for both. 🔴 The card coloured its "left" from `alert` (spent against 80% of the line) while /budgets
 * coloured the same row by its pace: "Off pace · 30% used" in amber there over a green "$1,603.85 left" here (review of
 * e37997b, 2026-10-12).
 */
export const PACE_TONE: Readonly<Record<BudgetPaceKind, { fill: string; text: string }>> = {
  under: { fill: "bg-positive", text: "text-positive" },
  "at-risk": { fill: "bg-warning", text: "text-warning" },
  over: { fill: "bg-negative", text: "text-negative" },
};
