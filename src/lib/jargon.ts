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
  // the two decision cards, each phrase printed exactly once on the dashboard
  "of cash",
  "Net cash",
  "Running down by",
  "Committed bills",
  "all in",
  "a renewal is not in the ledger",
  "not charged yet",
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
 * - `incomeExpectation` (budgets.ts) grades against an ANNUALISED rate whenever a
 *   live income series exists: a year of pay divided by twelve, so a plan sized
 *   that way is not marked over-allocated in the eight months a year that hold
 *   four weekly paydays and under-allocated in the four that hold five. Its
 *   definition says so, because a reader who counts the paydays on the calendar
 *   cannot otherwise reconcile them with the figure. That rate is FLOORED by the
 *   income the window has already measured, because a rate published below money
 *   the ledger can see is the one error this figure must never make — one
 *   auto-detected interest series was enough to read fourteen cents over five
 *   thousand dollars of banked salary. With nothing to level at all it falls back
 *   to `max(posted + still-due, whole-period forecast)`, and the third definition
 *   states the max — the max is there because most of every month reads $0.00
 *   posted while statements land weeks apart, and publishing that would assert a
 *   measured zero.
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
  /**
   * ONE of these three ever renders, and `incomeBasis` picks which — the same
   * headline-and-its-definition-from-one-branch rule `budgetVerdict` follows.
   * They describe genuinely different arithmetic, and a single body covering
   * all three could only do it by being vague about the one that is on screen.
   */
  expectedIncomeLevelled:
    "A year of your recurring pay spread evenly across twelve months, so the figure holds still instead of jumping whenever a month happens to hold an extra payday.",
  expectedIncomeBanked:
    "Income that has already arrived in this window, used here because it came to more than your recurring pay adds up to — a plan is never graded against less money than the ledger has actually seen.",
  expectedIncomeCalendar:
    "Money already in for this window plus the pay still due before it ends — or, when statements are behind, what your recurring income adds up to across the whole window, whichever is larger.",
  /**
   * ⛔ TWO ENTRIES, because the ternary they sit in has two arms and the
   * subtraction runs the other way in each.
   *
   * 🔴 `/budgets` on 2026-09-04 read "Over-allocated by $377.56" over a tip
   * saying "That income minus the monthly total below" — $4,537.00 minus
   * $4,914.56 is MINUS $377.56, the exact negative of the figure the tip was
   * mounted on. One definition served both arms, and a definition can only be
   * right about one of them. The docstring above this object already stated the
   * rule: a headline and its definition come from the SAME branch.
   */
  leftToAllocate:
    "That income minus the monthly total below. Budgets on any other cycle are left out, so a weekly or an annual one never moves this figure.",
  overAllocated:
    "The monthly total below minus that income — what the plans come to over and above it. Budgets on any other cycle are left out, so a weekly or an annual one never moves this figure.",
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

/**
 * The two decision cards' terms — the pass-63 runway and car answers.
 *
 * Each is mounted where the term is printed EXACTLY ONCE, the rule the budget
 * map follows and for the same measured reason: a tooltip body is live DOM text
 * even while closed, so a definition repeated per row is furniture that also
 * breaks somebody else's exact-count locator.
 */
export const RUNWAY_JARGON = {
  runway:
    "How long the money would last if what you spend and what you earn both carried on exactly as they have been.",
  netCash:
    "The cash in your accounts after taking off what is still owed on cards, because that money has already been spent.",
  burn: "The gap between what leaves each month and what arrives, which is the rate your cash actually runs down at.",
  /*
   * 🔴 This said "…plus any that fell due and never arrived" — the arrears the
   * rate no longer contains. Once arrears left `totalCents` the tooltip
   * contradicted the sentence three lines below it on the same card, which says
   * "A further $X came due earlier this month and never posted". A definition
   * that outlives the figure it defines is worse than none.
   */
  committed:
    "Money already agreed to, as a monthly rate: what a recurring schedule says is coming over the next twelve months, divided by twelve. Bills that fell due and never arrived are not in it — they are named separately, because a debt already owed is not part of a rate.",
  unevidenced:
    "A commitment entered by hand which the bank has never billed, so the ledger has agreed to it without ever seeing one.",
  allIn:
    "The regular monthly bill plus the money handed over at the start, spread across the term that money buys.",
} as const;

/**
 * The recurring calendar's two channels: what a mark SAYS happened, and how
 * firmly the app is claiming what will.
 *
 * Mounted once each in the legend rather than per cell — the budget map's rule,
 * for the same measured reason: a tooltip body is live DOM text even while
 * closed, so a definition repeated across a 35-cell grid is furniture that also
 * breaks somebody else's exact-count locator.
 *
 * `notYetKnown` is the entry that had to exist. The state it defines is the one
 * this calendar previously did not have, and without a definition a grey "?"
 * beside a payday is indistinguishable from a rendering failure.
 */
export const RECURRING_JARGON = {
  paid: "A charge for this bill turned up on the expected day, for about the amount expected.",
  paidDifferent:
    "The charge turned up, but for enough more or less than usual to be worth a look — measured against how much this bill normally varies, not against a fixed percentage.",
  missed:
    "Nothing turned up, and the statements covering that day HAVE been imported — so the silence is an answer rather than a gap in the records.",
  notYetKnown:
    "Nothing turned up, but the ledger cannot say whether it should have — the day may not be imported yet, the money may be cash you were handed and have not deposited, or this bill may not have charged enough times yet for the app to grade it. None of those is evidence that a payment failed.",
  upcoming: "Expected on or after today, so nothing has had the chance to happen yet.",
  scheduled:
    "You told the app this amount or this date, which makes it the firmest kind of claim here — firmer than a bill with years of history behind it.",
  expected:
    "You confirmed this is a real recurring item, and the amount and date come from what it has charged before.",
  predicted:
    "The app spotted a pattern and nobody has agreed to it yet. Drawn with a striped bar, because it is a guess.",
} as const;
