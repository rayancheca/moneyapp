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
  "Total budgeted",
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

/**
 * The three sums `/budgets` performs and never shows its working for.
 *
 * Each is mounted where the term is printed EXACTLY ONCE — the two header terms
 * render once per page, `Total budgeted` once per period section. That is not a
 * style preference: the pace verdict ("On track", "Off pace") is the page's most
 * misread term and is deliberately absent here, because it is printed once per
 * ROW and an identical explanation repeated beside every row is furniture rather
 * than information. Annotating it needs a home that does not scale with the row
 * count, and this page has not got one yet.
 *
 * Every definition below was written AFTER reading the function that computes
 * the figure, and says what that function does rather than what the words
 * suggest:
 *
 * - `incomeExpectation` (budgets.ts) returns `max(posted + still-due, whole-period
 *   series forecast)` — the max is there because most of every month reads $0.00
 *   posted while statements land weeks apart, and publishing that would assert a
 *   measured zero. The definition states the max, because a reader who assumes
 *   plain addition cannot reconcile the figure with the two parts printed beside it.
 * - `leftToAllocateCents` (page.tsx) subtracts MONTHLY budgets only. A weekly
 *   grocery budget does not reduce it — the single most surprising thing on the
 *   page, and nothing on screen says it.
 * - `totalBudgetedCents` (budgets.ts) drops any budget whose ancestor is budgeted
 *   in the same set. The page prints "overlapping child budgets excluded" only
 *   when that actually bites, so the rule itself is otherwise invisible.
 */
/**
 * How to read the bar, shared by the three states that draw a today mark.
 *
 * Factored so the sentence cannot drift between them — three hand-copied
 * variants would eventually disagree about the same graphic. `paceOver` does
 * NOT use it: that row draws no mark, and would be describing something it does
 * not render.
 */
const BAR_ANATOMY =
  "The filled part is what has gone so far, and the dark mark is how far through the period you are — fill behind the mark means spending is slower than time.";

export const BUDGET_JARGON = {
  expectedIncome:
    "Money already in for this window plus the pay still due before it ends — or, when statements are behind, what your recurring income adds up to across the whole window, whichever is larger.",
  leftToAllocate:
    "That income minus the monthly total below. Budgets on any other cycle are left out, so a weekly or an annual one never moves this figure.",
  totalBudgeted:
    "What the plans in this section come to. A budget nested inside another one here is left out of the sum, so the same money is never counted twice.",
  /**
   * The verdict, and the bar underneath it — one body per state the headline can
   * actually render, selected by `budgetVerdict` so the words and the reading
   * they explain are chosen by the SAME branch and cannot drift apart.
   *
   * The bar half was reported by the owner against the Housing row: a solid red
   * bar with a dark vertical line a quarter of the way in, and nothing on the
   * page saying what the line was. The verdict half is the older gap — "Off pace"
   * at thirty-nine percent used is not a contradiction, it is a claim about where
   * spending is HEADING, and no screen said so.
   *
   * ⛔ None of these may contain the words they explain. "On track", "Off pace",
   * "Over budget", "Awaiting statements" and "projected" are all reserved: each
   * is read by an exact-count locator, and a tooltip body is live DOM text even
   * while closed. So each body describes its state without naming it — which is
   * also better writing.
   */
  paceUnder: `Spending is inside the line and, at this rate, would finish inside it — the reading is about where this is heading, not only where it stands. ${BAR_ANATOMY}`,
  paceAtRisk: `Spending is still inside the line today, but at this rate it lands on or past the line before the period ends — the reading is about where this is heading, not where it stands. ${BAR_ANATOMY}`,
  paceOver:
    "Spending has already passed the line, and no later import can undo that — this reading is measured rather than a forecast. The bar is full and no longer to scale, and the period mark is left off because there is nothing left for it to divide.",
  paceWithheld: `Days in this window have no imported spending yet, so the amount and the percentage can only rise — they are floors rather than measurements. No reading is offered over them, because calling an unimported month healthy is the one error this page must not make. ${BAR_ANATOMY}`,
} as const;
