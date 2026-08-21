import { levelledMonthlyCents } from "./income-basis";

/**
 * Budgets sized by INCOME rather than by past spending.
 *
 * The owner, 2026-08-21: *"you have to use my salary as a base… i know right now
 * youre using estimates with average spends but i want to budget based on my
 * income."* `scripts/propose-budgets.ts` takes `max(median trailing spend,
 * contractual floor)`, which answers "what does this category usually cost" —
 * a fair question, and not the one being asked. It produced eleven budgets
 * totalling $7,575.00 against $4,537.00 of monthly cash income, which /budgets
 * correctly reported as over-allocated and which no allocation of real money can
 * satisfy.
 *
 * So the rule inverts. **Income sets the SIZE; trailing spend only sets the
 * SHAPE.** The total is fixed by what he earns, and history is consulted solely
 * to decide how to divide it — because his own spending is the only evidence of
 * his relative priorities that the ledger holds.
 *
 * The order of operations, and why each step is where it is:
 *
 *   1. **Commitments are funded first and exactly.** Rent, the car lease, the
 *      insurance, the utilities. A budget below what is contractually owed is
 *      not a budget, it is a guaranteed overrun — the same reasoning behind
 *      `propose-budgets`' floor, kept.
 *   2. **What income leaves is the discretionary pool.** Everything else
 *      competes for that and nothing else.
 *   3. **Only the UNCOMMITTED part of a category's history competes.** Housing
 *      already has its rent funded in step 1; letting it also claim a share of
 *      the pool for that same rent would fund it twice.
 *   4. **Rounding goes DOWN.** `propose-budgets` rounds up so a floor is never
 *      rounded away; here the binding constraint is the opposite, and rounding
 *      eleven rows up would quietly hand out more than a month earns.
 *
 * ⛔ It does not balance the unbalanceable. When commitments alone exceed
 * income, `overCommitted` says so and `unallocatedCents` goes negative rather
 * than the plan silently shaving a contract to make the arithmetic close.
 */

/**
 * A weekly wage as one month of income.
 *
 * Annualised, NOT multiplied by four. Four weekly paydays a month is eleven
 * months of pay a year — on this ledger, at $1,047 a week, that quietly loses
 * $4,188.00 of real earnings. The owner chose this basis with both numbers in
 * front of him.
 *
 * ⚠️ Delegates rather than restating the arithmetic. `/budgets` grades these
 * budgets against the same annualised rate (`incomeBasis`), and a second copy of
 * `× 52 ÷ 12` here is a plan and a header that can drift apart while both look
 * right — the shape pass 54 recorded for dates and pass 50 for verdicts.
 */
export function monthlyFromWeekly(weeklyCents: number): number {
  return levelledMonthlyCents(weeklyCents, "weekly");
}

/**
 * What a category typically costs in a month, from its trailing monthly totals.
 *
 * The median, because one-off months are everywhere on this ledger — Travel's
 * $2,448.88 trip drags its mean to $600.65 against a $270.14 median.
 *
 * ⚠️ But the median of MONTHS THE CATEGORY EXISTED, not of the calendar window.
 * The owner moved to Miami in mid-2026, so Utilities has real charges in June
 * ($110.32) and July ($120.43) and structural zeroes before them. A plain
 * median over six months reads **$0.00** there, and a budget built on it funds
 * the category at its contractual floor of $64.21 against $115 of actual usage
 * — underfunding it by about $50 a month, silently, forever.
 *
 * Zero months are dropped only when some month is non-zero. A category that
 * genuinely spent nothing in every trailing month keeps its honest $0.00 rather
 * than being handed an empty median, which is the Car's case today: the lease
 * begins 2026-09-11, so its whole budget should come from the commitment.
 */
export function typicalMonthlySpend(monthlyTotalsCents: readonly number[]): number {
  if (monthlyTotalsCents.length === 0) return 0;
  const active = monthlyTotalsCents.filter((v) => v > 0);
  const basis = active.length > 0 ? active : monthlyTotalsCents;
  const sorted = [...basis].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export interface IncomeBudgetCategory {
  id: string;
  name: string;
  /** contractually owed every month, from CONFIRMED recurring series; positive cents */
  committedCents: number;
  /** typical monthly spend; positive cents. Sets the share, never the size. */
  trailingCents: number;
}

export interface IncomeBudgetInput {
  /** one month of income, positive cents */
  incomeBaseCents: number;
  categories: readonly IncomeBudgetCategory[];
  /** round the discretionary part down to this multiple; 0 disables rounding */
  roundToCents?: number;
}

export interface IncomeBudgetRow {
  id: string;
  name: string;
  /** what to budget: the commitment plus this row's share of the pool */
  budgetCents: number;
  committedCents: number;
  /** the share of the pool, on top of the commitment */
  discretionaryCents: number;
  trailingCents: number;
  /** `budgetCents − trailingCents`; negative is a cut against what he spends */
  deltaVsTrailingCents: number;
}

export interface IncomeBudgetPlan {
  incomeBaseCents: number;
  /** every contractual commitment, summed */
  committedCents: number;
  /** income minus commitments, floored at zero */
  discretionaryPoolCents: number;
  rows: IncomeBudgetRow[];
  allocatedCents: number;
  /**
   * `incomeBaseCents − allocatedCents`. NEGATIVE only when commitments alone
   * exceed income, which is the one case worth shouting about.
   */
  unallocatedCents: number;
  /** commitments alone exceed the income base — this plan cannot balance */
  overCommitted: boolean;
}

/** The largest multiple of `step` at or below `value`. `step <= 0` is identity. */
function floorTo(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}

const DEFAULT_ROUND_CENTS = 500;

export function incomeBudgetPlan({
  incomeBaseCents,
  categories,
  roundToCents = DEFAULT_ROUND_CENTS,
}: IncomeBudgetInput): IncomeBudgetPlan {
  const committedCents = categories.reduce((sum, c) => sum + c.committedCents, 0);
  const overCommitted = committedCents > incomeBaseCents;
  const discretionaryPoolCents = Math.max(0, incomeBaseCents - committedCents);

  /*
   * Only the part of history a commitment does not already cover competes for
   * the pool — step 3 in the module docstring.
   *
   * Zipped rather than kept as a parallel array indexed by position: the two
   * would always be the same length by construction, so `needs[i]` needs a
   * fallback that can never fire, and a branch that cannot execute is a branch
   * the 100% gate can only be satisfied about by lying.
   */
  const withNeed = categories.map((c) => ({
    category: c,
    need: Math.max(0, c.trailingCents - c.committedCents),
  }));
  const totalNeed = withNeed.reduce((sum, w) => sum + w.need, 0);

  const rows: IncomeBudgetRow[] = withNeed.map(({ category: c, need }) => {
    /*
     * A zero total need means nothing is asking for the pool. Dividing by it
     * would be NaN, and spreading the pool evenly across categories that are
     * already fully committed would invent discretionary room nobody spends.
     * The pool simply stays unallocated, and `unallocatedCents` reports it.
     */
    const share = totalNeed === 0 ? 0 : need / totalNeed;
    const discretionaryCents = floorTo(Math.floor(discretionaryPoolCents * share), roundToCents);
    // The commitment is added AFTER rounding: $2,285.70 of rent is an exact
    // number and rounding it to a multiple of $5 would underfund a contract.
    const budgetCents = c.committedCents + discretionaryCents;
    return {
      id: c.id,
      name: c.name,
      budgetCents,
      committedCents: c.committedCents,
      discretionaryCents,
      trailingCents: c.trailingCents,
      deltaVsTrailingCents: budgetCents - c.trailingCents,
    };
  });

  /*
   * Sorted here, not by the caller. The categories arrive in whatever order a
   * query or a Map iteration produced, and a plan whose row order depends on
   * that is a plan that reshuffles between two renders of the same numbers.
   * Largest budget first is also the order the reader wants: the rows that
   * decide whether the month works are the ones at the top.
   */
  rows.sort(
    (a, b) => b.budgetCents - a.budgetCents || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  const allocatedCents = rows.reduce((sum, r) => sum + r.budgetCents, 0);

  return {
    incomeBaseCents,
    committedCents,
    discretionaryPoolCents,
    rows,
    allocatedCents,
    unallocatedCents: incomeBaseCents - allocatedCents,
    overCommitted,
  };
}
