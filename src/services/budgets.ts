import { and, eq, gte, inArray, isNotNull, isNull, lte, notExists } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { budgets, BUDGET_PERIODS, type BudgetPeriodKind } from "@/db/schema/budgets";
import { categories } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import {
  addCalendarMonths,
  addDays,
  compareDates,
  diffDays,
  isValidIsoDate,
  periodBounds,
  todayIso,
  type PeriodBounds,
} from "@/lib/dates";
import { outsidePortfolioCashAccountIds } from "./accounts";
import {
  activeTxnsInRange,
  categorySpending,
  isIncome,
  loadCategoryIndex,
  spendingTransactions,
  recurringSeriesIdsForCategory,
  type AnalyticsTxn,
} from "./analytics";
import { trailingFullMonths } from "./forecast";
import {
  overdueForSeries,
  unbankedIncomeForSeries,
  unbankedIncomeTotals,
  type BudgetTail,
  type BudgetTailSeries,
} from "./arrears";
import type { UnbankedFrontier } from "@/lib/unbanked-income";
import { settledPaydaysBySeries } from "./payday-settlement";
import { effectiveSeries, projectOccurrences, seriesHasLapsed, toProjectable } from "./recurring";
import { linkIsRecurring, rowIsRecurring, seriesIdsNotDrawnAsRecurring } from "./recurring-link";

// the overdue rule now lives in ./arrears (the forecast needs it too, and
// budgets.ts already imports from ./forecast — see that module's header)
export { overdueForSeries };
export type { BudgetTail, BudgetTailSeries };
import { incomeBasis, levelledMonthlyCents, type IncomeBasis } from "@/lib/income-basis";
import { daysNotImportedYet } from "@/lib/empty-period";
import { frontierForSeries, ledgerOpens, observationFrontier, type ObservationFrontier } from "./observation-frontier";
import { cashWalletIds } from "./cash-wallet-rule";

/**
 * Budgets (master-plan Phase 5). One active budget per (category, period),
 * enforced by the partial unique index — conflicts surface as clean errors.
 *
 * Overlap semantics (schema.md budgets): child spend rolls into a parent's
 * budget AND its own budget by design; alerts fire independently per budget
 * row; any "total budgeted" aggregate excludes budgets whose category is a
 * descendant of another budgeted category so totals never double-count.
 *
 * Rollover is opt-in per budget and off by default. Off, leftover/overrun is
 * informational only. On, unspent plan from CLOSED periods accumulates (see
 * `carryInto`) and every "how am I doing" figure — pct, alert, pace, remaining —
 * grades against `availableCents` instead. Totals and the expected-income
 * comparison deliberately stay on the plan amount.
 */

const WARN_NUMERATOR = 4; // 80% = 4/5, compared in integer math — no float drift
const WARN_DENOMINATOR = 5;

export const budgetInputSchema = z.object({
  categoryId: z.string().min(1),
  period: z.enum(BUDGET_PERIODS),
  amountCents: z.number().int().positive("Budget amount must be positive"),
  startsOn: z.string().refine(isValidIsoDate, "Invalid date").optional(),
});
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export const budgetPatchSchema = z.object({
  amountCents: z.number().int().positive("Budget amount must be positive").optional(),
  period: z.enum(BUDGET_PERIODS).optional(),
});
export type BudgetPatch = z.infer<typeof budgetPatchSchema>;

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function requireBudgetableCategory(db: AppDatabase, categoryId: string) {
  const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!category) throw new Error(`Unknown category ${categoryId}`);
  if (category.kind !== "expense") {
    throw new Error(`Budgets apply to expense categories only — "${category.name}" is ${category.kind}`);
  }
  if (category.isArchived) {
    throw new Error(`"${category.name}" is archived and cannot be budgeted`);
  }
  return category;
}

export function createBudget(db: AppDatabase, input: BudgetInput): string {
  const parsed = budgetInputSchema.parse(input);
  const category = requireBudgetableCategory(db, parsed.categoryId);
  try {
    return db
      .insert(budgets)
      .values({
        categoryId: parsed.categoryId,
        period: parsed.period,
        amountCents: parsed.amountCents,
        startsOn: parsed.startsOn ?? todayIso(),
      })
      .returning({ id: budgets.id })
      .get().id;
  } catch (error: unknown) {
    if (isUniqueConflict(error)) {
      throw new Error(`An active ${parsed.period} budget already exists for ${category.name}`);
    }
    throw error;
  }
}

export function updateBudget(db: AppDatabase, id: string, patch: BudgetPatch): void {
  const parsed = budgetPatchSchema.parse(patch);
  const existing = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!existing) throw new Error(`Unknown budget ${id}`);
  try {
    db.update(budgets)
      .set({
        ...(parsed.amountCents !== undefined && { amountCents: parsed.amountCents }),
        ...(parsed.period !== undefined && { period: parsed.period }),
      })
      .where(eq(budgets.id, id))
      .run();
  } catch (error: unknown) {
    if (isUniqueConflict(error)) {
      throw new Error(`An active ${parsed.period ?? existing.period} budget already exists for this category`);
    }
    throw error;
  }
}

export const budgetRolloverSchema = z.object({
  enabled: z.boolean(),
  /** null clears the override and falls back to the budget's own startsOn */
  startsOn: z.string().refine(isValidIsoDate, "Invalid date").nullable().optional(),
  capCents: z.number().int().positive("Rollover cap must be positive").nullable().optional(),
});
export type BudgetRolloverInput = z.infer<typeof budgetRolloverSchema>;

/**
 * Turn rollover on or off for one budget, with the one invariant the column
 * cannot express: a carry may never begin BEFORE the budget did. Nothing else
 * validates cross-field, so without this a caller could set the start to
 * 2025-01-01 and manufacture exactly the fabricated budget history the
 * accumulation rules exist to refuse.
 */
export function setBudgetRollover(db: AppDatabase, id: string, input: BudgetRolloverInput): void {
  const parsed = budgetRolloverSchema.parse(input);
  const existing = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!existing) throw new Error(`Unknown budget ${id}`);
  if (parsed.startsOn != null && compareDates(parsed.startsOn, existing.startsOn) < 0) {
    throw new Error(
      `Rollover cannot start before the budget does (${existing.startsOn}) — there is no plan to carry from`,
    );
  }
  db.update(budgets)
    .set({
      rolloverEnabled: parsed.enabled,
      ...(parsed.startsOn !== undefined && { rolloverStartsOn: parsed.startsOn }),
      ...(parsed.capCents !== undefined && { rolloverCapCents: parsed.capCents }),
    })
    .where(eq(budgets.id, id))
    .run();
}

export function deactivateBudget(db: AppDatabase, id: string, endedOn: string = todayIso()): void {
  const existing = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!existing) throw new Error(`Unknown budget ${id}`);
  db.update(budgets).set({ isActive: false, endsOn: endedOn }).where(eq(budgets.id, id)).run();
}

// ── Statuses ─────────────────────────────────────────────────────────

export type BudgetAlert = "none" | "warn80" | "over";

export interface BudgetStatus {
  budget: {
    id: string;
    categoryId: string;
    period: BudgetPeriodKind;
    amountCents: number;
    startsOn: string;
    endsOn: string | null;
    rolloverEnabled: boolean;
    rolloverStartsOn: string | null;
    rolloverCapCents: number | null;
  };
  categoryName: string;
  /** "Food > Dining" for subcategories, "Food" for top-levels */
  categoryPath: string;
  /** the graded window: the period containing refDate, START-clamped to startsOn */
  bounds: PeriodBounds;
  /** the clamp actually moved the start — the budget only owns part of this period */
  partialPeriod: boolean;
  /** subtree rollup of active expense spending inside bounds */
  spentCents: number;
  /** unspent plan banked from CLOSED periods; 0 whenever rollover is off */
  rolloverCents: number;
  /** amountCents + rolloverCents — the line this period is actually graded against */
  availableCents: number;
  remainingCents: number;
  /** spent/available — may exceed 1 (over) or dip below 0 (net refunds) */
  pct: number;
  alert: BudgetAlert;
  /** an ancestor category also carries an active budget (overlap by design) */
  isDescendantOfBudgeted: boolean;
  /** category ids of every ancestor up to the root — for same-set overlap math */
  ancestorCategoryIds: string[];
}

export function computeAlert(spentCents: number, amountCents: number): BudgetAlert {
  if (spentCents >= amountCents) return "over";
  if (spentCents * WARN_DENOMINATOR >= amountCents * WARN_NUMERATOR) return "warn80";
  return "none";
}

const PERIOD_ORDER: Record<BudgetPeriodKind, number> = { daily: 0, weekly: 1, monthly: 2, annual: 3 };

interface CarryableBudget {
  categoryId: string;
  period: BudgetPeriodKind;
  amountCents: number;
  startsOn: string;
  rolloverStartsOn: string | null;
  rolloverCapCents: number | null;
}

/**
 * Unspent plan banked from every CLOSED period, for a budget with rollover on.
 *
 *     balance = clampToCap(max(0, balance + amount − spent(p) − overdue(p)))
 *
 * Four rules, each of which exists because the alternative asserts something the
 * ledger does not support:
 *
 * - **Floor at zero.** Carrying deficits forward would leave every category whose
 *   mean spend exceeds its amount permanently, unrecoverably negative — Car's
 *   $921.38 is lease $559.89 + insurance $361.49 EXACTLY, so its planned surplus
 *   is $0.00/month and one bad month would mark it over budget forever. A colour
 *   that can never return to green carries no information.
 *
 * - **Skip a partial first period.** A budget created mid-period has not lived a
 *   whole one, and crediting it for the days before it existed banks a surplus
 *   out of missing data: the ten budgets started 2026-07-16 would bank $6,522.71
 *   from 16 days whose measured spend was $276.29 — more than a month of this
 *   owner's expected income, for half a month.
 *
 * - **Never look back past `startsOn`.** Seeding from trailing history would hand
 *   the Car budget thousands in "savings" for months in which he had no car. It
 *   is the same fabrication as backfilling a cash wallet's opening history.
 *
 * - **Subtract the period's overdue.** A bill that came due and never posted is
 *   money committed, not money saved. Housing's August window holds $0.00 spent
 *   against $2,285.70 of rent overdue since 2026-08-08; without this term, August
 *   closing before that statement lands banks $2,109.00 of "surplus" created
 *   entirely by a bill the same row already flags in red — and then the rent
 *   either back-dates (the carry silently changes) or posts in September (banked
 *   once, charged again).
 *
 * Derived at read time and never stored: the 2026-08-03 import back-filled
 * $623.58 of spend into an already-closed July, so a stored balance would have
 * been stale within 72 hours.
 *
 * Cost: one `categorySpending` + one `budgetOverdue` per closed period, which
 * grows with calendar time. Deliberately exact rather than truncated to a recent
 * window — a silently-bounded lookback would report a carry that is not the sum
 * of the periods it claims to cover. `rolloverStartsOn` is the supported way to
 * bound it.
 */
export function carryInto(
  db: AppDatabase,
  budget: CarryableBudget,
  currentPeriodStart: string,
): number {
  const from = budget.rolloverStartsOn ?? budget.startsOn;
  const first = periodBounds(from, budget.period);
  // a period the budget only partly owned is skipped whole, never prorated
  let cursor = compareDates(first.start, from) < 0 ? addDays(first.end, 1) : first.start;

  let balance = 0;
  while (compareDates(cursor, currentPeriodStart) < 0) {
    const p = periodBounds(cursor, budget.period);
    /*
     * Stop before any period that reaches into the one being graded — only
     * CLOSED periods have a final answer to bank.
     *
     * ⚠️ `>=` and `>` are indistinguishable here, and it is worth saying so
     * rather than leaving a mutation audit to rediscover it. Every period this
     * walk builds is calendar-aligned (`periodBounds` snaps both ends), and so
     * is `currentPeriodStart`, so `p.end` — a period's LAST day — can never
     * equal a period's FIRST day of the same kind. Brute-forced over 198,400
     * (cursor, period) pairs across all four kinds and 400 reference days:
     * zero hits. The `>=` stays because it states the intent — a period that
     * REACHES the graded one is not closed — and the equality it also covers is
     * unreachable rather than wrong.
     */
    if (compareDates(p.end, currentPeriodStart) >= 0) break;
    const spent = categorySpending(db, {
      categoryId: budget.categoryId,
      from: p.start,
      to: p.end,
    }).spentCents;
    const overdue = budgetOverdue(db, budget.categoryId, p.start, p.end).totalCents;
    balance = Math.max(0, balance + budget.amountCents - spent - overdue);
    if (budget.rolloverCapCents !== null) balance = Math.min(balance, budget.rolloverCapCents);
    cursor = addDays(p.end, 1);
  }
  return balance;
}

/** Actual-vs-budget for every active budget, evaluated in refDate's period. */
export function budgetStatuses(db: AppDatabase, refDate: string = todayIso()): BudgetStatus[] {
  const idx = loadCategoryIndex(db);
  const rows = db.select().from(budgets).where(eq(budgets.isActive, true)).all();
  const budgetedCategoryIds = new Set(rows.map((r) => r.categoryId));

  return rows
    .map((b): BudgetStatus => {
      // A budget grades only the days it has actually existed. createBudget
      // stamps startsOn = today, so an unclamped period would judge a budget
      // made this morning against the whole month's PRIOR spend and open at
      // "over by 4798%". Only the START clamps — the end stays the period's, so
      // the bar still fills toward the real period close.
      const period = periodBounds(refDate, b.period);
      const partialPeriod = compareDates(b.startsOn, period.start) > 0;
      const bounds: PeriodBounds = partialPeriod ? { start: b.startsOn, end: period.end } : period;
      const { spentCents } = categorySpending(db, {
        categoryId: b.categoryId,
        from: bounds.start,
        to: bounds.end,
      });
      // Banked plan from closed periods. Off by default, and `carryInto` is not
      // even called then, so a non-rollover budget grades exactly as it did
      // before the column existed.
      const rolloverCents = b.rolloverEnabled ? carryInto(db, b, period.start) : 0;
      const availableCents = b.amountCents + rolloverCents;
      const node = idx.byId.get(b.categoryId);
      if (!node) throw new Error(`Budget ${b.id} points at unknown category ${b.categoryId}`);
      const parent = node.parentId ? idx.byId.get(node.parentId) : null;

      // walk the FULL ancestor chain (no early break): the ids let a total scope
      // its parent/child exclusion to the SAME set (one period on the page),
      // while isDescendantOfBudgeted stays the global "has a budgeted ancestor".
      const ancestorCategoryIds: string[] = [];
      let isDescendantOfBudgeted = false;
      for (let cursor = node.parentId; cursor; ) {
        ancestorCategoryIds.push(cursor);
        if (budgetedCategoryIds.has(cursor)) isDescendantOfBudgeted = true;
        cursor = idx.byId.get(cursor)?.parentId ?? null;
      }

      return {
        budget: {
          id: b.id,
          categoryId: b.categoryId,
          period: b.period,
          amountCents: b.amountCents,
          startsOn: b.startsOn,
          endsOn: b.endsOn,
          rolloverEnabled: b.rolloverEnabled,
          rolloverStartsOn: b.rolloverStartsOn,
          rolloverCapCents: b.rolloverCapCents,
        },
        categoryName: node.name,
        categoryPath: parent ? `${parent.name} > ${node.name}` : node.name,
        bounds,
        partialPeriod,
        spentCents,
        rolloverCents,
        availableCents,
        // Every "how am I doing" figure grades against AVAILABLE, not plan: with
        // rollover on, the owner has said the carry is part of the line. Splitting
        // them would put a contradiction on screen — BudgetRow derives its
        // headline percentage from `pct` while gating on `pace`, so a row could
        // read "Over budget by <1%" while sitting comfortably under.
        remainingCents: availableCents - spentCents,
        pct: spentCents / availableCents,
        alert: computeAlert(spentCents, availableCents),
        isDescendantOfBudgeted,
        ancestorCategoryIds,
      };
    })
    .sort(
      (a, b) =>
        PERIOD_ORDER[a.budget.period] - PERIOD_ORDER[b.budget.period] ||
        a.categoryPath.localeCompare(b.categoryPath),
    );
}

/**
 * Total budgeted across statuses, excluding a budget whose category is a
 * descendant of another budget IN THE SAME SET (schema.md: never double-count).
 * Scoped to the passed set — the page totals one period at a time, and amounts
 * from different periods are never summed together, so a child budgeted in a
 * DIFFERENT period than its parent belongs fully in its own period's total (it
 * would otherwise be silently dropped by a global "has a budgeted ancestor").
 */
export function totalBudgetedCents(statuses: readonly BudgetStatus[]): number {
  const present = new Set(statuses.map((s) => s.budget.categoryId));
  return statuses
    .filter((s) => !s.ancestorCategoryIds.some((id) => present.has(id)))
    .reduce((sum, s) => sum + s.budget.amountCents, 0);
}

/**
 * Whether any budget in this set is excluded from its total as a descendant of
 * another budget IN THE SAME SET — the trigger for the "overlapping child
 * budgets excluded" note. Same-set scoping keeps the note honest: a cross-period
 * child (never summed with its parent) is neither excluded nor flagged.
 */
export function hasOverlappingChildBudget(statuses: readonly BudgetStatus[]): boolean {
  const present = new Set(statuses.map((s) => s.budget.categoryId));
  return statuses.some((s) => s.ancestorCategoryIds.some((id) => present.has(id)));
}

const PERIOD_LABEL: Record<BudgetPeriodKind, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  annual: "Annual",
};

export interface BudgetSection<T> {
  period: BudgetPeriodKind;
  label: string;
  /**
   * The PERIOD's own window. Deliberately NOT read off a member row: a budget
   * created mid-period is start-clamped (see the clamp above), so a section
   * labelled from `statuses[0]` inherits one budget's short window and states it
   * over every other row. The per-row clamped window belongs on the row.
   */
  bounds: PeriodBounds;
  statuses: T[];
}

/**
 * Group statuses into the period sections the page renders, in period order,
 * dropping periods with no budgets. Pure and generic over the status shape so
 * the grouping can be tested without standing up a database.
 */
export function budgetSections<T extends { budget: { period: BudgetPeriodKind } }>(
  statuses: readonly T[],
  refDate: string,
): BudgetSection<T>[] {
  return BUDGET_PERIODS.map((period) => ({
    period,
    label: PERIOD_LABEL[period],
    bounds: periodBounds(refDate, period),
    statuses: statuses.filter((s) => s.budget.period === period),
  })).filter((section) => section.statuses.length > 0);
}

// ── Form support ─────────────────────────────────────────────────────

export interface BudgetableCategory {
  id: string;
  name: string;
  depth: 0 | 1;
  parentName: string | null;
}

/** Non-archived expense categories in tree order (subs after their parent). */
export function listBudgetableCategories(db: AppDatabase): BudgetableCategory[] {
  const rows = db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      kind: categories.kind,
      isArchived: categories.isArchived,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .all()
    .filter((r) => r.kind === "expense" && !r.isArchived);

  const bySort = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

  const out: BudgetableCategory[] = [];
  for (const parent of rows.filter((r) => r.parentId === null).sort(bySort)) {
    out.push({ id: parent.id, name: parent.name, depth: 0, parentName: null });
    for (const child of rows.filter((r) => r.parentId === parent.id).sort(bySort)) {
      out.push({ id: child.id, name: child.name, depth: 1, parentName: parent.name });
    }
  }
  return out;
}

// ── Pace, projection, and the expected-but-unposted tail (§8) ─────────

export type BudgetPace = "under" | "at-risk" | "over";

/**
 * Green→amber→red by PROJECTED pace (ux-overhaul §8):
 * - over  (red):   already spent the whole budget — a fact, not a forecast.
 * - at-risk (amber): still under today, but the projection lands over.
 * - under (green): projected to finish within budget.
 * spent is compared with `>=` so a to-the-cent budget reads "over" only once
 * truly met, matching computeAlert's over threshold.
 */
export function computePace(spentCents: number, projectedCents: number, amountCents: number): BudgetPace {
  if (spentCents >= amountCents) return "over";
  if (projectedCents >= amountCents) return "at-risk";
  return "under";
}

export interface PaceProjectionInput {
  spentCents: number;
  /**
   * posted spend that is RECURRING money (subset of spentCents) — rows a series
   * drawn as recurring owns (`linkIsRecurring`): a live series' bill, or an
   * ENDED one's. Not "every row with a link": a DISMISSED series' rows are
   * everyday spending and stay in the variable pace.
   */
  recurringPostedCents: number;
  /** future recurring occurrences still to post this period — the tail */
  expectedTailCents: number;
  /** days from period start through today, inclusive */
  elapsedDays: number;
  totalDays: number;
  /**
   * Posted spend too large to be a RATE (subset of spentCents). A single charge
   * bigger than the whole period's budget is an event, not a daily habit, and
   * extrapolating it is how a $5,000 car deposit on day 1 of a 21-day window
   * projected $105,000 against a $921.38 budget. It still counts as spent — it
   * is simply not evidence about the remaining days.
   *
   * ⛔ DISJOINT from `recurringPostedCents` (`budgetOneOffCents`): both are
   * subtracted before the extrapolation, so a row in both hides its own size
   * of everyday spend from the pace.
   */
  oneOffCents?: number;
}

/**
 * Honest projected spend — the components ARE the math (forecast.ts discipline):
 *   projected = spent + expected recurring tail + extrapolated variable remainder
 * The variable remainder linearly extends ONLY the non-recurring spend, so a
 * bill that already posted is never double-counted with its own tail, and a
 * bill still to post is counted once (via the tail), never smeared by pace.
 * A category with net refunds (variablePosted < 0) contributes no negative
 * remainder — pace never projects below what has already been spent.
 */
export function projectSpend(input: PaceProjectionInput): number {
  const { spentCents, recurringPostedCents, expectedTailCents, elapsedDays, totalDays } = input;
  const variablePosted = spentCents - recurringPostedCents - (input.oneOffCents ?? 0);
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const variableRemainder =
    elapsedDays > 0 && variablePosted > 0
      ? Math.round((variablePosted * remainingDays) / elapsedDays)
      : 0;
  return spentCents + expectedTailCents + variableRemainder;
}

/**
 * The posted spend `projectSpend` must not extrapolate because it is an EVENT —
 * a single charge larger than the whole period's plan — and is not already held
 * out as a bill.
 *
 * 🔴 THE SECOND HALF WAS MISSING. `projectSpend` subtracts `recurringPostedCents`
 * AND `oneOffCents` from spend-to-date, and this filter took every row over the
 * plan with no link check, so a bill larger than its budget was subtracted
 * twice and the second copy hid that much ordinary spend from the run-rate. On
 * the real ledger (2026-09-14) the only linked charge ever larger than its plan
 * while a budget existed is HBO Max, −$260.26 on 2026-07-18 against the $15.00
 * Subscriptions plan: that day the run-rate extrapolated nothing ($262.79) where
 * the $2.53 of other subscriptions beside it projects $273.75, and on 07-24 the
 * published projection read $564.95 where it is $574.69. The card annual fees
 * are the same shape against Fees' $15.00, measured on a copy with that budget
 * started early: Sapphire's $95.00 hid the $5.00 wire fee beside it (03-05,
 * $100.00 → $126.00); Venture X's $395.00 in January had nothing beside it.
 *
 * "Held out as a bill" is `rowIsRecurring`, the in-memory form of the
 * `linkIsRecurring` that `recurringPostedCents` queries with, so the two cannot
 * disagree about a row: an ENDED series' charge was a bill and stays one, and a
 * DISMISSED series' charge is not — `recurringPostedCents` does not take it, so
 * a large one must be a one-off here or it is extrapolated as a habit. A split
 * part arrives exploded carrying its PARENT's link, which is the question
 * `recurringPostedCents` asks of a part.
 *
 * `planCents` is strict: a charge exactly the size of the plan is still a rate.
 */
export function budgetOneOffCents(
  rows: readonly Pick<AnalyticsTxn, "amountCents" | "recurringSeriesId">[],
  planCents: number,
  notDrawn: ReadonlySet<string>,
): number {
  return rows
    .filter((t) => !rowIsRecurring(t.recurringSeriesId, notDrawn))
    .filter((t) => -t.amountCents > planCents)
    .reduce((sum, t) => sum - t.amountCents, 0);
}

/**
 * Posted income in a window, by analytics' own rule (`isIncome`): POSITIVE
 * amounts in income-kind categories, off the agent's cash account. Split parts
 * are attributed independently because activeTxnsInRange explodes them.
 *
 * 🔴 It asked the category's kind with its own copy of the rule, so when the
 * owner decided (2026-09-28) that the agent's dividends and interest are not his
 * income, "$X in so far" — and the income basis it floors — would have gone on
 * counting them. One classifier, and the agent's rule comes with it.
 */
function incomeTotalCents(db: AppDatabase, from: string, to: string): number {
  if (compareDates(from, to) > 0) return 0;
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  let cents = 0;
  for (const txn of activeTxnsInRange(db, from, to)) {
    if (isIncome(idx, agentsCash, txn)) cents += txn.amountCents;
  }
  return cents;
}

export interface IncomeExpectation {
  /** money already in, inside [start, today] */
  postedCents: number;
  /**
   * money still expected, from TODAY through end — less today's occurrence
   * once a deposit for it has posted (that money is in `postedCents`)
   */
  expectedCents: number;
  /**
   * What the SCHEDULE says this whole window pays, and the occurrences behind
   * it — one walk, so a count and an amount that are printed in the same
   * sentence cannot describe different sets of days.
   *
   * ⚠️ Not `postedCents + expectedCents`. Those two are cut at `today`, and
   * actuals routinely disagree with the schedule: a paycheque banked before the
   * anchor is posted money the walk never projects.
   */
  scheduledCents: number;
  scheduledOccurrences: number;
  /**
   * Paydays that have ALREADY passed inside this window with nothing banked
   * against them — the third leg, and the reason the first two do not have to
   * add up to `scheduledCents`.
   *
   * ⛔ Never added to `expectedCents`, and that is doctrine rather than an
   * oversight: a payday that passed without a deposit is evidence about the
   * IMPORTS, not about the job (`arrears.ts` says the same thing from the other
   * side, where the money-out filter is what keeps a missed payday out of every
   * forecast). It is REPORTED so the header can name it, because the reader is
   * looking at "$0.00 in so far, $3,141.00 still expected" one line above
   * "4 paydays … $4,188.00" and the difference has to be called something.
   */
  passedUnpaidCents: number;
  passedUnpaidOccurrences: number;
  /**
   * Of `passedUnpaidOccurrences`, the paydays on days every account the pay
   * lands in has been read through — the only ones "no deposit against them"
   * is a statement about (`unbankedIncomeTotals`).
   */
  passedUnpaidCheckedOccurrences: number;
  /** how far the accounts the other passed paydays land in were checked — one day, per schedule, or not at all */
  passedUnpaidFrontier: UnbankedFrontier;
  /** which figure budgets are graded against, and how this month sits on it */
  basis: IncomeBasis;
  /** the live income series contributing to expectedCents */
  series: { id: string; name: string; amountCents: number }[];
}

/** How far ahead a series must still be paying to earn its annualised rate. */
const BASIS_HORIZON_MONTHS = 12;

/**
 * What this period is expected to bring IN — the term `/budgets` has never had.
 *
 * Ten budgets totalling more than the owner earns is the single most useful
 * thing the page could tell him, and before this nothing on it mentioned income
 * at all. `postedCents` is posted actuals over [start, today]; `expectedCents`
 * is the schedule from today on, minus today's occurrence once its deposit has
 * posted — disjoint by the one fact that matters, so a paycheque that has
 * already landed is never also forecast and one that has not is never lost.
 * (⚠️ NOT built like `budgetTail`, which opens tomorrow: spending has an
 * arrears leg to own today, and income by doctrine has none — see `from`.)
 *
 * Deliberately series-driven rather than a trailing average. His income is a
 * cash job deposited IRREGULARLY (docs/income-ground-truth.md), so a trailing
 * mean reads far below the confirmed weekly series — the series is the stated
 * fact, the deposits are its noisy shadow.
 *
 * **`basis` is what the header grades budgets against, and it is a RATE floored
 * by a measurement.** See `lib/income-basis`: a plan sized from $1,047 × 52 ÷ 12
 * graded against the paydays that happen to fall in a calendar month swings by
 * $349.00 either way and balances only across the year. The calendar month is
 * still reported — `scheduledCents`, and the note on the basis — it is simply
 * not the yardstick. `postedCents` goes in as the floor: a rate published below
 * money the ledger has already seen is the one error this figure must never
 * make, and one auto-detected fourteen-cent interest series was enough to cause
 * it before the floor existed.
 *
 * ⛔ **A stale series still feeds this, and that is a decision rather than an
 * oversight.** The cash job has been silent for eleven paydays while the owner
 * is demonstrably still working it, so `/spending` says the money never reached
 * a bank and this says the month should still bring it in. Asked as a concrete
 * either/or on 2026-08-21, the owner chose to leave both readings standing:
 * they answer different questions, and suppressing this one would tell a working
 * man he has no income. Do not "fix" the disagreement without asking again.
 */
export function incomeExpectation(
  db: AppDatabase,
  start: string,
  end: string,
  today: string,
): IncomeExpectation {
  /*
   * The last day `postedCents` speaks for. Named because the forward leg has to
   * ask the same question of the settling deposits: money outside this window
   * is not in this figure, whatever payday it paid.
   */
  const postedThrough = compareDates(today, end) > 0 ? end : today;
  const postedCents = incomeTotalCents(db, start, postedThrough);

  const live = db
    .select()
    .from(recurringSeries)
    .where(
      and(
        eq(recurringSeries.kind, "income"),
        inArray(recurringSeries.status, ["detected", "confirmed"]),
      ),
    )
    .all();

  /*
   * ⛔ THE FORWARD LEG OPENS ON `today`, and today's occurrence leaves it only
   * once its money has posted.
   *
   * This opened on `today + 1`. The legs were then disjoint by construction —
   * and the day they meet was in NEITHER unless the pay had already landed.
   * Measured on the owner's ledger on 2026-09-03, a Thursday and a payday, with
   * nothing imported past 2026-08-12: the header read "$0.00 in so far,
   * $3,141.00 still expected" one line above "4 paydays fall in this month,
   * scheduled at $4,188.00". Today's $1,047.00 was in neither figure — the hole
   * `services/arrears` closed for bills, mirrored onto income, and on a weekly
   * schedule it opens one day in seven.
   *
   * Spending on this page can afford a tail that opens tomorrow because
   * `budgetOverdue` owns today. Income has no arrears leg, by doctrine (a
   * payday that passed without a deposit is evidence about the imports, not
   * about the job), so the forward leg has to own today — as it already does on
   * `/recurring`, the upcoming strip and `committedBook`. What keeps a
   * paycheque that HAS landed today from being counted twice is the series'
   * own posted row: an occurrence dated today is dropped from the walk exactly
   * when a linked deposit dated today exists, the one fact that says the money
   * is already in `postedCents`.
   */
  const from = today;
  /*
   * ⛔ WHICH PAYDAYS ARE ALREADY IN `postedCents` — asked of `paydaySettlement`,
   * which is the one place that answers it.
   *
   * 🔴 This used to be the narrower "is a deposit dated exactly today?", and
   * that left the mirror-image hole. A lump that posts BEFORE the payday it
   * covers was counted TWICE: on 2026-09-23 his +$4,567.68 was in `postedCents`
   * while `expectedCents` still projected Sep 24's $1,141.92 on top of it,
   * because the deposit was not dated Sep 24. Under settle-backwards that lump
   * settles Sep 24, so the money is banked once and expected never.
   *
   * ⚖️ The old comment warned that widening to the series' tolerance would let
   * ONE deposit delete a payday it had already been counted against. Settlement
   * is what makes the widening safe INSIDE one month: an occurrence is dropped
   * here only when a deposit actually paid for it, and each deposit's money is
   * spent once.
   *
   * 🔴 ACROSS months it was not safe, and that is what `settledBy` answers.
   * Settlement's deposit universe has no start bound — a deposit on Sep 30
   * settles Oct 1 — while `postedCents` is cut at `start`. Dropped from
   * `expectedCents` on the strength of money counted in the PREVIOUS month, the
   * payday was named by no leg at all: `passedUnpaidCents` cannot name it either
   * (it walks `[start, today)` and settlement says the payday was met). Measured
   * on 2026-10-01 with one deposit of $1,141.92 dated 2026-09-30: posted $0.00 +
   * expected $4,567.68 + passed-unpaid $0.00, against five paydays scheduled at
   * $5,709.60. So an occurrence leaves this leg only when the money that settled
   * it is inside the window `postedCents` covers; otherwise it stays here, which
   * is the old, safe answer and keeps the four figures the header prints side by
   * side adding up.
   */
  const settled = settledPaydaysBySeries(
    db,
    live.map((s) => s.id),
    today,
  );
  const paidInsideWindow = (depositOn: string | undefined): boolean =>
    depositOn !== undefined && compareDates(depositOn, start) >= 0 && compareDates(depositOn, postedThrough) <= 0;
  const series: IncomeExpectation["series"] = [];
  let expectedCents = 0;
  if (compareDates(from, end) <= 0) {
    for (const s of live) {
      const met = settled.get(s.id) ?? new Map<string, string>();
      // money IN only — a refund-shaped income series must not subtract here
      const cents = projectOccurrences(toProjectable(s), from, end)
        .filter((o) => o.amountCents > 0)
        // pay a deposit has already answered INSIDE this window: it is in
        // postedCents, and so not also here
        .filter((o) => !paidInsideWindow(met.get(o.date)))
        .reduce((sum, o) => sum + o.amountCents, 0);
      if (cents === 0) continue;
      expectedCents += cents;
      series.push({ id: s.id, name: s.name, amountCents: cents });
    }
  }
  series.sort((a, b) => b.amountCents - a.amountCents);

  /*
   * The whole window as the SCHEDULE sees it, plus its occurrence count. Both
   * come out of one walk on purpose: the month note prints them in the same
   * sentence ("4 paydays … scheduled at $4,188.00"), and two walks could
   * eventually describe different sets of days while each looked right.
   */
  let scheduledCents = 0;
  let scheduledOccurrences = 0;
  /*
   * The third leg. `postedCents` cuts at today and the forward leg opens on
   * today, so an occurrence STRICTLY BEFORE today with nothing banked against
   * it is in neither — and on a weekly schedule that is six days in seven, not
   * the one day the today-boundary covers. Measured on the owner's ledger
   * 2026-09-04, the day after a Thursday payday: "$0.00 in so far, $3,141.00
   * still expected" over "4 paydays … $4,188.00", with $1,047.00 nowhere.
   *
   * ⛔ `services/arrears` owns the rule, beside the bills version, because the
   * forecast card publishes the same figure and two implementations of "did
   * this payday arrive?" is the shape that has cost this codebase a landlord in
   * the forecast for seven months.
   */
  const unbanked = unbankedIncomeForSeries(db, new Set(live.map((s) => s.id)), start, today);
  const passed = unbankedIncomeTotals(unbanked);
  const passedUnpaidCents = passed.totalCents;
  const passedUnpaidOccurrences = passed.occurrenceCount;
  /*
   * The annualised rate every live series pays, summed.
   *
   * A series earns its rate by still being alive across the year ahead, NOT by
   * paying inside this particular month — that gate is what would put the
   * calendar swing straight back, in quarterly and annual sizes. `userEndsOn`
   * is honoured because the horizon walk goes through `projectOccurrences`,
   * which stops there; a job that finished pays nothing and levels to nothing.
   */
  const horizon = addDays(addCalendarMonths(start, BASIS_HORIZON_MONTHS), -1);
  let levelledCents = 0;
  for (const s of live) {
    const inPeriod = projectOccurrences(toProjectable(s), start, end).filter(
      (o) => o.amountCents > 0,
    );
    scheduledOccurrences += inPeriod.length;
    scheduledCents += inPeriod.reduce((sum, o) => sum + o.amountCents, 0);


    const eff = effectiveSeries(s);
    const perOccurrenceCents = eff.nextExpectedAmountCents;
    // a series with no amount projects nothing at all; levelling it would
    // publish a rate of zero as though it had been measured
    if (perOccurrenceCents === null || perOccurrenceCents <= 0) continue;
    const stillPaying = projectOccurrences(toProjectable(s), start, horizon).some(
      (o) => o.amountCents > 0,
    );
    if (!stillPaying) continue;
    levelledCents += levelledMonthlyCents(perOccurrenceCents, eff.cadence);
  }

  /*
   * The fallback, used only when there is nothing to level.
   *
   * posted + future UNDERSTATES whenever the month's income has not been
   * imported yet, which is most of every month here — statements land weeks
   * apart, so early August reads $0.00 posted and silently drops the paydays
   * that already happened. Publishing that as an income figure would assert a
   * measured zero where "not measured yet" is true, which is the same failure
   * the per-row coverage work fixed for SPENDING. So take the larger of (what is
   * known + what is still coming) and (what the schedule says the whole period
   * brings). Mirrors projectSpend's max(spent, forecast).
   */
  const measuredCents = Math.max(postedCents + expectedCents, scheduledCents);

  return {
    postedCents,
    expectedCents,
    scheduledCents,
    scheduledOccurrences,
    basis: incomeBasis({
      levelledCents,
      postedCents,
      scheduledCents,
      scheduledOccurrences,
      measuredCents,
    }),
    passedUnpaidCents,
    passedUnpaidOccurrences,
    passedUnpaidCheckedOccurrences: passed.checkedOccurrenceCount,
    passedUnpaidFrontier: passed.frontier,
    series,
  };
}


/**
 * Expected-but-unposted recurring for a category subtree within a period: every
 * future (strictly after today, through periodEnd) occurrence of the recurring
 * series linked to this subtree. Only money-out (expense) occurrences count — an
 * income series linked here never inflates a spending budget. Reuses
 * projectOccurrences, so the tail agrees with the Recurring tab to the cent.
 */
/**
 * Bills this period EXPECTED and never posted — the past-facing sibling of
 * `budgetTail`.
 *
 * `budgetTail` anchors at `addDays(today, 1)` and only ever looks forward, so a
 * bill that came due and never arrived falls into a blind spot: it is not in
 * `spentCents` (nothing posted) and not in the tail (its date has passed).
 * Measured consequence on the owner's ledger — rent of $2,285.70 came due
 * 2026-08-08, never posted, and Housing still read green with $2,109.00 left.
 *
 * Same `alreadyPosted` rule as `recurringCalendar` (`recurring-calendar.ts:157`)
 * so the two surfaces cannot disagree about the same bill: an occurrence is
 * overdue only when NO linked posting sits within the series' own
 * `toleranceDays`. That is also what keeps this disjoint from `spentCents` —
 * anything that posted is spend, never overdue.
 */
export function budgetOverdue(
  db: AppDatabase,
  categoryId: string,
  periodStart: string,
  today: string,
): BudgetTail {
  const seriesIds = recurringSeriesIdsForCategory(db, categoryId);
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };
  return overdueForSeries(db, seriesIds, periodStart, today);
}

export function budgetTail(
  db: AppDatabase,
  categoryId: string,
  periodEnd: string,
  today: string,
): BudgetTail {
  const seriesIds = recurringSeriesIdsForCategory(db, categoryId);
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };

  /*
   * ⛔ STRICTLY AFTER TODAY, AND THE REASON IS NOT THE CALENDAR — it is that
   * this leg does NOT check postings and the overdue leg does.
   *
   * `overdueForSeries` drops an occurrence a linked charge already covers
   * (within the series' own tolerance); this walk projects the schedule and
   * nothing else. A bill due TODAY may already have posted, in which case
   * `spentCents` holds it — so it belongs in the leg that can see that, and
   * putting it here would count it twice.
   *
   * ⚠️ That is why `/budgets` and the runway card split the same instant
   * differently and BOTH are right. `committedBook`'s forward leg is a RATE
   * over N whole months, not a list of what is still to pay, so double-counting
   * against actuals is not a risk there and its arrears leg closes the day
   * BEFORE today. Reconciling the two by moving one edge would either lose a
   * bill here (no leg would own today) or break the rate there. See
   * `services/committed.ts`.
   */
  const from = addDays(today, 1);
  if (compareDates(from, periodEnd) > 0) return { totalCents: 0, series: [] };

  // Only live series forecast a tail — a dismissed/ended series whose past rows
  // are still tagged must not resurrect as an "expected" charge (matches
  // upcomingOccurrences' detected|confirmed horizon).
  const rows = db
    .select()
    .from(recurringSeries)
    .where(
      and(
        inArray(recurringSeries.id, [...seriesIds]),
        inArray(recurringSeries.status, ["detected", "confirmed"]),
      ),
    )
    .all();

  const series: BudgetTailSeries[] = [];
  let totalCents = 0;
  for (const s of rows) {
    // a series that stopped charging is not a forecast — see seriesHasLapsed for
    // why this is not `isSeriesActive` (a registered commitment has no postings
    // yet and must still be projected)
    if (seriesHasLapsed(s, today)) continue;
    const occ = projectOccurrences(toProjectable(s), from, periodEnd).filter((o) => o.amountCents < 0);
    if (occ.length === 0) continue;
    const amountCents = occ.reduce((sum, o) => sum - o.amountCents, 0); // money-out → positive
    totalCents += amountCents;
    series.push({
      id: s.id,
      name: s.name,
      cadence: occ[0]!.cadence,
      nextDate: occ[0]!.date,
      amountCents,
      occurrenceCount: occ.length,
      href: `/recurring/${s.id}`,
    });
  }
  series.sort((a, b) => compareDates(a.nextDate, b.nextDate) || a.name.localeCompare(b.name));
  return { totalCents, series };
}

/**
 * Posted spend in a subtree that is RECURRING money, over [from,to] — split-aware.
 * A split recurring row contributes only the parts whose category falls in the
 * subtree (its stale parent category is ignored, mirroring analytics' explode);
 * an unsplit recurring row contributes its whole amount.
 *
 * 🔴 Recurring by `seriesDrawsAsRecurring`, not by having a link. This read
 * `isNotNull(recurringSeriesId)`, so a charge tagged to a series the owner
 * DISMISSED — "not recurring i just go eat there often" — was graded as a bill
 * already paid: subtracted from the variable spend `projectSpend` extrapolates,
 * with no tail to stand in for it (`budgetTail` projects live series only). An
 * ENDED series' charge stays here: it was a bill.
 */
function recurringPostedCents(
  db: AppDatabase,
  categoryId: string,
  from: string,
  to: string,
  notDrawn: ReadonlySet<string>,
): number {
  const subtree = loadCategoryIndex(db).subtreeIds(categoryId);
  const unsplit = db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        linkIsRecurring(notDrawn),
        inArray(transactions.categoryId, subtree),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
        notExists(
          db
            .select({ one: transactionSplits.id })
            .from(transactionSplits)
            .where(eq(transactionSplits.transactionId, transactions.id)),
        ),
      ),
    )
    .all();
  const splitParts = db
    .select({ amountCents: transactionSplits.amountCents })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.transferGroupId), // transfer-linked parts never count
        linkIsRecurring(notDrawn),
        inArray(transactionSplits.categoryId, subtree),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();
  return [...unsplit, ...splitParts].reduce((sum, r) => sum - r.amountCents, 0);
}

export interface CategoryCoverage {
  /** the earliest import frontier among the accounts below; null when none of them has one */
  importedThroughOn: string | null;
  /** where the window of accounts opens: six full months back, or the period's start if earlier */
  spentFromSince: string;
  /** accounts other than cash wallets the subtree was spent from over [spentFromSince, today], any with no frontier included */
  spentFromAccounts: number;
  /** cash wallets it was spent from over the same days — never part of `importedThroughOn` (⚖️ below) */
  spentFromWallets: number;
}

/**
 * Through which day this budget's spending has been imported: the EARLIEST
 * import frontier (`observationFrontier`) among the accounts its subtree was
 * spent from — `frontierForSeries`, the recurring calendar's question asked of
 * a category's accounts instead of a series'.
 *
 * Earliest, for `frontierForSeries`' own reason: the claim guarded is a negative
 * one. To say a stretch of the period holds no more Food, every account Food is
 * spent from has to have been looked at; taking the category's newest row let
 * one fresh account vouch for a stale one.
 *
 * 🔴 WHAT THIS REPLACED. `subtreeDataThrough` read the subtree's newest row.
 * Measured on the real ledger 2026-09-15, /budgets read Food "spending imported
 * through Sep 12" (Venture X) and "3 days of this period unaccounted" while
 * Chase Sapphire, 44% of Food's spend since March, was imported through Sep 2
 * and Chase Checking through Aug 12; the dashboard the same day said 94% of
 * spending posts to accounts shown through Aug 12 at the earliest. Twelve
 * budgets named ten days. And a cash row typed for today in any category
 * (`addManualTransaction`) set the newest row to today, left 0 days uncovered,
 * and let the row grade "On track" over two unimported accounts.
 *
 * ⛔ EVERY account the subtree was spent from in the window, NOT the dashboard's
 * live-spender habit (`liveSpendersOver`, at least `MIN_OCCURRENCES` of six
 * months). Measured 2026-09-15, the habit rule per category read Utilities and
 * Entertainment "imported through Sep 13" on Venture X alone, while Chase
 * Checking (42% of Utilities' spend, in two of the six months, through Aug 12)
 * and Chase Sapphire (42% of Entertainment's, through Sep 2) were left out. A
 * monthly bill that moved accounts is not a habit on either, and a category is
 * too small a population for a count of months to tell dormant from live.
 *
 * ⛔ NOT the ledger-wide `ledgerReaches` (Sep 13): it understates on every row —
 * Fees posts 27 times on Chase Checking and would read 2 days where it has 15.
 * NOT `spendingCoverageThrough` either: that is all spending's population, and
 * would clamp Travel and Health, which are never spent from Chase Checking, to
 * its Aug 12.
 *
 * ⚠️ The window is what keeps a dormant account from vetoing forever. It is the
 * inline editor's guide window (`GUIDANCE_MONTHS` full months before today's
 * month, `budgetGuidanceCents`) — the same subtree history the page already
 * reads — opened at the period's own start when that is earlier, so an annual
 * budget keeps every account spent from inside the year it grades. An account
 * whose last charge in this category falls before it no longer holds the row
 * back (SoFi Checking's one Mar 9 Cash & ATM row stops counting in October).
 *
 * ⚠️ Known gap, the dashboard's own: a FIRST charge on an account the category
 * was never spent from in the window is not waited for.
 *
 * ⚖️ CASH WALLETS ARE LEFT OUT — owner decision, 2026-09-15. A wallet has no
 * statements, so its frontier was its newest typed row and no import could move
 * it. Measured 2026-09-15 on copies of the real ledger, with a $1.00 Car row
 * added on Chase Checking and on Venture X on each day tested: Cash on Hand's
 * one row (Aug 11, the $5,000 down payment, 77% of Car since March) held Car at
 * "Awaiting statements · spending imported through Aug 11" on Oct 13 and on
 * Feb 26, 2027, with both cards imported through that day.
 *  - WHICH accounts are wallets is `cashWalletIds`, the rule
 *    `addManualTransaction` guards its writes with (under the Cash institution,
 *    no statement period, no import anchor, no imported row) — never a name, and
 *    never a second copy of that rule.
 *  - A category spent from a wallet AND an imported account follows the imported
 *    one: Car on the real ledger, 2026-09-15, Aug 11 -> Aug 12 (Chase Checking).
 *  - A category spent ONLY from wallets has no day: `importedThroughOn` is null
 *    and `uncoveredDays` stays the whole elapsed window, so anything reading the
 *    count alone still withholds. `lib/budget-coverage::spentOnlyFromCashWallets`
 *    is what the row's headline, its sentence and the page note read to say
 *    "Cash only" instead of waiting for a statement that never comes.
 *
 * ❓ A SECOND SURFACE ASKS THIS QUESTION OF THE SAME CATEGORY AND MONTH, WITH
 * THE WHOLE LEDGER'S DAY. `/categories/[id]`, the page each row links to, feeds
 * `emptyPeriodReason` the ledger-wide `ledgerReaches`. Measured 2026-09-15:
 * the Fees row reads "spending imported through Aug 12 · 15 days of this period
 * unaccounted", and its September page "2 days of it have not been imported —
 * the ledger is imported through Sun, Sep 13, 2026"; Car, Cash & ATM and Travel
 * read the same sentence there. The ⛔ above rules out only the ledger's day on
 * THIS page; whether that page should read this rule is not decided.
 *
 * Deliberately NOT account coverage/verifiedThrough, which answers "which
 * periods reconcile", a stronger and more optimistic question (SoFi Checking
 * reports a verified 2026-07-31 against a last transaction of 2026-05-31, and
 * cash wallets report nothing at all). The accounts come from
 * `spendingTransactions`, the rows the budget is graded from.
 */
function categoryCoverage(
  db: AppDatabase,
  categoryId: string,
  periodStart: string,
  refDate: string,
  frontier: ObservationFrontier,
  wallets: ReadonlySet<string>,
): CategoryCoverage {
  // always GUIDANCE_MONTHS windows, oldest first
  const windowStart = trailingFullMonths(refDate, GUIDANCE_MONTHS)[0]!.start;
  const spentFromSince = compareDates(periodStart, windowStart) < 0 ? periodStart : windowStart;
  const spentFrom = new Set(
    spendingTransactions(db, { categoryId, from: spentFromSince, to: refDate }).map((t) => t.accountId),
  );
  // ⚖️ a wallet is counted on its own and never dates the row
  const imported = new Set([...spentFrom].filter((id) => !wallets.has(id)));
  return {
    importedThroughOn: frontierForSeries(frontier, imported),
    spentFromSince,
    spentFromAccounts: imported.size,
    spentFromWallets: spentFrom.size - imported.size,
  };
}

export interface BudgetPaceStatus extends BudgetStatus, CategoryCoverage {
  totalDays: number;
  /** days from the window start through today (inclusive); 0 before it opens */
  elapsedDays: number;
  /** 0..1 position of "today" within the period — where the pace tick sits */
  elapsedFraction: number;
  recurringPostedCents: number;
  /** the hollow tail: future recurring still to post this period */
  expectedTailCents: number;
  projectedCents: number;
  pace: BudgetPace;
  tail: BudgetTailSeries[];
  /** bills expected on/before today that never posted — money committed but missing */
  overdueCents: number;
  overdue: BudgetTailSeries[];
  /**
   * Days of THIS window the ledger cannot speak for: the elapsed days past
   * `importedThroughOn`, all of them when it is null (`daysNotImportedYet`) —
   * a row spent only from cash wallets keeps them all, and says why instead
   * (`lib/budget-coverage::spentOnlyFromCashWallets`).
   * >0 means the row's spent/pace/% figures are lower bounds, not measurements,
   * and the UI must not report a verdict — "On track" over an unimported month
   * is the one failure mode a budgeting tool cannot afford.
   */
  uncoveredDays: number;
}

/**
 * budgetStatuses enriched with pace, projection, and the expected tail — the
 * data behind the §8 bars. Kept separate from the lean budgetStatuses so the
 * category page's budget reference stays cheap; only the /budgets page pays for
 * the per-row projection + tail.
 */
export function budgetPaceStatuses(db: AppDatabase, refDate: string = todayIso()): BudgetPaceStatus[] {
  // one read for every row: the series whose charges are not recurring money
  const notDrawn = seriesIdsNotDrawnAsRecurring(db);
  // …and where the import stands, per account and at the ledger's opening end
  const frontier = observationFrontier(db);
  const opens = ledgerOpens(db);
  // …and which accounts are cash wallets, which no import ever reaches (⚖️ `categoryCoverage`)
  const wallets = cashWalletIds(db);
  return budgetStatuses(db, refDate).map((s) => {
    const { start, end } = s.bounds;
    // budgetStatuses evaluates the period CONTAINING refDate, start-clamped to
    // startsOn, so pace is measured over the budget's OWN life inside the period
    // (a 4-day-old budget paces on 4 days, not on the month). refDate ∈
    // [start,end] for any budget that has already begun; a future-dated startsOn
    // has not opened its window yet, hence the clamps — elapsedDays floors at 0
    // and the span never divides by a non-positive number.
    const totalDays = Math.max(1, diffDays(start, end) + 1);
    const elapsedDays = Math.min(totalDays, Math.max(0, diffDays(start, refDate) + 1));
    // Project from spend-TO-DATE ([start, refDate]), NOT full-period spend: a
    // future-dated posting inside the period (a bill logged/posted early) must
    // not be counted both as already-spent AND as an expected-tail occurrence
    // of its own series — recomputeSeriesStats ignores postedOn > today, so the
    // series still projects that same date. spentToDate ([start,today]) and the
    // tail ((today,end]) are disjoint by construction, so the projection adds
    // each future charge exactly once.
    const spentToDate = categorySpending(db, {
      categoryId: s.budget.categoryId,
      from: start,
      to: refDate,
    }).spentCents;
    const posted = recurringPostedCents(db, s.budget.categoryId, start, refDate, notDrawn);
    /*
     * A single charge larger than the WHOLE period's budget is an event, not a
     * rate. The owner's $5,000 car deposit landed on day 1 of a 21-day window
     * against a $921.38 budget and the linear run-rate turned it into a
     * $105,000 projection. It stays in spentCents — he spent it, the row is
     * honestly `over` — but it tells you nothing about the other 20 days, so it
     * must not be extrapolated. Threshold is the budget itself rather than an
     * invented multiple: anything that alone exhausts the period cannot be the
     * daily habit the run-rate is modelling. A bill that size is not one: it
     * is already in `posted`, and `budgetOneOffCents` leaves it there.
     *
     * Deliberately the PLAN amount and not `availableCents`: this is a question
     * about the shape of a charge, not about how much room is left. Raising the
     * bar by a large carry would let the $5,000 deposit back into the run-rate
     * and reproduce the $105,000 projection exactly.
     */
    const oneOffCents = budgetOneOffCents(
      spendingTransactions(db, { categoryId: s.budget.categoryId, from: start, to: refDate }),
      s.budget.amountCents,
      notDrawn,
    );
    // the tail lives inside the budget's window too: for a budget that starts
    // LATER in this period, anchor a day before startsOn so budgetTail's
    // strictly-after-anchor window opens exactly on startsOn, never earlier.
    const tailFrom = compareDates(start, refDate) > 0 ? addDays(start, -1) : refDate;
    const tail = budgetTail(db, s.budget.categoryId, end, tailFrom);
    // due already, still not posted — disjoint from BOTH spentCents (it never
    // posted) and the tail (which starts strictly after today)
    const overdue = budgetOverdue(db, s.budget.categoryId, start, refDate);
    const forecast = projectSpend({
      spentCents: spentToDate,
      recurringPostedCents: posted,
      // an overdue bill is COMMITTED money, not an extrapolation — it belongs in
      // the projection exactly once, alongside the forward tail
      expectedTailCents: tail.totalCents + overdue.totalCents,
      oneOffCents,
      elapsedDays,
      totalDays,
    });
    // never project below what has ALREADY posted for the whole period — a large
    // future-dated non-recurring charge is a committed fact, not an estimate, so
    // the full-period actual is the projection floor.
    const projectedCents = Math.max(s.spentCents, forecast);
    // the uncovered stretch is measured against the graded window only: a
    // frontier before the window opens leaves the WHOLE elapsed window
    // uncovered, and one on or past today leaves none. ⛔ The count is
    // `daysNotImportedYet`, the dashboard tile's and /spending's, not a third
    // copy of the clamp — only the frontier it is given is this category's.
    const coverage = categoryCoverage(db, s.budget.categoryId, start, refDate, frontier, wallets);
    const uncoveredDays = daysNotImportedYet({
      from: start,
      to: end,
      today: refDate,
      ledgerOpens: opens,
      ledgerReaches: coverage.importedThroughOn,
    });
    return {
      ...s,
      overdueCents: overdue.totalCents,
      overdue: overdue.series,
      ...coverage,
      uncoveredDays,
      totalDays,
      elapsedDays,
      elapsedFraction: elapsedDays / totalDays,
      recurringPostedCents: posted,
      expectedTailCents: tail.totalCents,
      projectedCents,
      // graded against AVAILABLE so pace and pct cannot disagree; `over` still
      // means "past the line", it is just that rollover moves the line
      pace: computePace(s.spentCents, projectedCents, s.availableCents),
      tail: tail.series,
    };
  });
}

const GUIDANCE_MONTHS = 6;

/**
 * A trailing spend guide for the inline editor (ux-overhaul §8): the last 6 full
 * calendar months of subtree spend expressed at the budget PERIOD's length via a
 * daily rate, so the figure is directly comparable to a daily/weekly/monthly/
 * annual amount alike. Net refunds never push it below zero. This is what kills
 * deactivate-and-recreate — the user adjusts a live number against real history.
 */
export function budgetGuidanceCents(
  db: AppDatabase,
  categoryId: string,
  period: BudgetPeriodKind,
  refDate: string = todayIso(),
): number {
  // trailingFullMonths always returns GUIDANCE_MONTHS non-empty windows, so the
  // day total is a fixed, strictly-positive divisor (≈181) — no zero guard.
  const windows = trailingFullMonths(refDate, GUIDANCE_MONTHS);
  let totalSpent = 0;
  let totalDays = 0;
  for (const w of windows) {
    totalSpent += categorySpending(db, { categoryId, from: w.start, to: w.end }).spentCents;
    totalDays += diffDays(w.start, w.end) + 1;
  }
  const bounds = periodBounds(refDate, period);
  const periodDays = diffDays(bounds.start, bounds.end) + 1;
  return Math.max(0, Math.round((totalSpent / totalDays) * periodDays));
}
