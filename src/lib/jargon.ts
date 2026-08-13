/**
 * Definitions for the terms these screens use without explaining them.
 *
 * Authored copy, kept in one module for the same reason section notes are: it
 * can be swept. A tooltip body is LIVE DOM TEXT even while its popover is
 * closed — measured, Playwright's text engine ignores visibility, so
 * `getByText(...)` matches it and `toHaveCount` counts it. Copy that repeats a
 * phrase the surrounding page states is therefore not merely redundant; it
 * breaks a page-level assertion somewhere else and says the same thing twice in
 * two voices.
 *
 * Two rules every definition obeys:
 *
 * - **No figures.** A number here would be one nobody measured, and it would
 *   collide with the single-match locators that read the real ones.
 * - **Say what the code does, not what the word suggests.** Each definition
 *   below is grounded in `analytics.ts`'s stated contract: categories of kind
 *   transfer/investment/rewards/system are excluded from spending; spending is
 *   expense-kind netted (purchases against refunds); income counts positive
 *   amounts in income-kind categories.
 */

/** Terms the surrounding UI owns. A definition may not contain one of these. */
export const RESERVED_JARGON_PHRASES = [
  // graded verdicts and windows on /budgets, each read by an exact-count locator
  "On track",
  "Off pace",
  "Over budget",
  "rolled over",
  "expected by now, not imported",
  "expected before",
  "Awaiting statements",
  "expected income",
  "unaccounted",
  "Available",
  "Banked",
  "Grading",
  "left to allocate",
  "Over-allocated by",
  "Leftover is forgotten",
  "stops being budgeted",
  "Projected",
  "projected",
  // /categories row copy
  "resolve this category by name",
  "Archived",
  "Locked",
] as const;

/**
 * What a category's KIND decides. The manager tells the reader the kind "drives
 * the money math" and then never says how — these are the how, one per group
 * heading on /categories.
 */
export const CATEGORY_KIND_JARGON: Record<string, string> = {
  expense:
    "The only kind counted as spending. Purchases and refunds net against each other, so returning something reduces the total instead of adding to it.",
  income:
    "Only money arriving counts here. A repayment that claws some of it back nets against the original rather than inflating what you earned.",
  rewards:
    "Cash back and statement credits. Kept out of spending totals, so a credit never reads as money earned or as money spent.",
  investment:
    "Buying and selling positions. Kept out of spending totals — moving money into an investment is not an expense, and the position is valued separately.",
  transfer:
    "Money moving between accounts you own. Kept out of spending totals so one payment is never counted twice, once leaving and once arriving.",
  system:
    "Where a transaction sits until it has a real category. Kept out of spending totals, and surfaced separately so it is never silently treated as nothing.",
};
