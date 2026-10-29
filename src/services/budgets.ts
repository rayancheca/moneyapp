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
import { withBillingCarriers } from "./billing-carriers";
import {
  activeTxnsInRange,
  categorySpending,
  hisIncomeRows,
  incomeSeriesOfRender,
  isAgentsIncomeSeries,
  loadCategoryIndex,
  offAgentsCash,
  spendingTransactions,
  recurringSeriesIdsForCategory,
  type AnalyticsTxn,
} from "./analytics";
import {
  isUpfrontCarRow,
  upfrontCarRule,
  type UpfrontCarCandidate,
  type UpfrontCarRule,
} from "./car-upfront";
import { trailingFullMonths } from "./forecast";
import {
  arrearsInWindow,
  overdueForSeries,
  unbankedIncomeForSeries,
  unbankedIncomeTotals,
  type Arrears,
  type ArrearsSeries,
  type BudgetTail,
  type BudgetTailSeries,
} from "./arrears";
import type { UnbankedFrontier } from "@/lib/unbanked-income";
import { portionsAcross } from "@/lib/payday-settlement";
import { paydayProjectable, paydaySettlementsBySeries, stillToCome, stillToComeReader } from "./payday-settlement";
import { checkedThroughBySeries, silenceMeasuredThroughBySeries } from "./cash-earnings";
import { effectiveSeries, hasStoppedForecasting, oneChargeDays, projectOccurrences, toProjectable } from "./recurring";
import { linkIsRecurring, rowIsRecurring, seriesIdsNotDrawnAsRecurring } from "./recurring-link";

// the overdue rule now lives in ./arrears (the forecast needs it too, and
// budgets.ts already imports from ./forecast — see that module's header)
export { overdueForSeries };
export type { BudgetTail, BudgetTailSeries };
import { incomeBasis, levelledMonthlyCents, type IncomeBasis } from "@/lib/income-basis";
import { daysNotImportedYet, emptyFigure, emptyPeriodReason, type EmptyPeriodInput } from "@/lib/empty-period";
import { paydayIsRead } from "@/lib/occurrence-verdict";
import { spentOnlyFromCashWallets, type BorrowedDay } from "@/lib/budget-coverage";
import { formatCategoryPath } from "@/lib/category-path";
import { categoryReach, type CategoryReach } from "@/lib/category-reach";
import type { RolloverReadOn } from "@/lib/rollover-held-back";
import {
  accountsThatDate,
  frontierForSeries,
  ledgerOpens,
  ledgerReaches,
  observationFrontier,
  type ObservationFrontier,
} from "./observation-frontier";
import { accountsAwaitingStatements, cashWalletIds } from "./cash-wallet-rule";

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
 * informational only. On, unspent plan from CLOSED periods read whole accumulates
 * (see `carryInto`) and every "how am I doing" figure — pct, alert, pace, remaining —
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
  /** the rows `spentCents` was summed from — 0 is a window in which not one row was found (⚖️ §6A 64) */
  txnCount: number;
  /** unspent plan banked from CLOSED periods read whole (⚖️ decision 67); 0 whenever rollover is off */
  rolloverCents: number;
  /** ⚖️ decision 67: the closed periods that banked nothing because a day of them is not read yet; empty when off */
  rolloverHeldBack: readonly PeriodBounds[];
  /**
   * The most those periods can still add to `rolloverCents` once their statements land (`RolloverCarry.mayAddCents`):
   * the line this period is graded against can still RISE by up to this. 0 when nothing is held back, when what is held
   * back has already spent its plan, and whenever rollover is off.
   */
  rolloverMayAddCents: number;
  /** whose day the carry read those periods through (`RolloverCarry.readOn`) — the panel's rule; null when off */
  rolloverReadOn: RolloverReadOn | null;
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

/** What a rolling budget banked, and what it held back (⚖️ decision 67). */
export interface RolloverCarry {
  /** unspent plan banked from the CLOSED periods every day of which has been read */
  cents: number;
  /** the closed periods that banked nothing because a day of them is not read yet, oldest first */
  heldBack: readonly PeriodBounds[];
  /**
   * The most `heldBack` can still add to `cents` once its statements land: the carry walked again with each of them
   * banked on the spend and overdue found in it SO FAR — the least it will hold, since a statement still to come can
   * only add to what it holds — less `cents`, and never below 0. A period already past its plan on what is found adds
   * nothing, and a carry at its cap takes nothing more.
   *
   * ⚖️ default built, not asked (2026-10-29): while this is above 0 the line can still rise, so no figure past it is a
   * floor (`lib/rollover-held-back::lineMayRise`). 🔴 Review of 48475ec4: Food, $30.00 a month rolling from Jul 1,
   * $40.00 of August found, July held back with $0.00 of it — "over budget by at least $10.00", and on the load after
   * July's statement $40.00 of $60.00 ($30.00 rolled over) with no Food added anywhere.
   */
  mayAddCents: number;
  /**
   * Whose day the newest closed period was read through — or, none closed yet, the day the period now running is asked
   * against — as `categoryReachFor` found it: what the panel's rule says it waits on (`rolloverWaitsSentence`). Null
   * for a budget that does not roll over, which waits on nothing.
   */
  readOn: RolloverReadOn | null;
}

/**
 * The reads `carryInto` asks a closed period's days against: its category page's (`categoryReachFor`), and the day the
 * ledger opens.
 */
export interface CarryReads extends CategoryReachContext {
  /** `ledgerOpens(db)` — a day before it is a day nobody has read */
  opens: string | null;
}

export function carryReads(db: AppDatabase): CarryReads {
  return { ...categoryReachContext(db), opens: ledgerOpens(db) };
}

/**
 * Unspent plan banked from every CLOSED period, for a budget with rollover on.
 *
 *     balance = clampToCap(max(0, balance + amount − spent(p) − overdue(p)))   — p read whole
 *     balance = balance                                                        — p not read whole yet
 *     ceiling = clampToCap(max(0, ceiling + amount − spent(p) − overdue(p)))   — every p, on what is found so far
 *
 * `ceiling − balance` is what the periods held back can still add once read (`mayAddCents`, `mayStillBank`): the carry
 * falls as their spend grows, and what is found in a period is the least it will hold — the floor every withheld row
 * stands on.
 *
 * Five rules, each of which exists because the alternative asserts something the
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
 * - ⚖️ **Bank nothing from a period not read whole** — owner decision 2026-10-13
 *   (decision 67). A closed period is graded on the spend FOUND in it, so one no
 *   statement has covered banked its plan as though nothing was spent. 🔴 On his
 *   ledger copy 2026-10-12 September banked $761.52 no statement confirmed: Cash &
 *   ATM $130.00 and Fees $15.00 with no day of it read, Food $399.28, Shopping
 *   $19.55, Transport $127.69 and Travel $70.00 read in part — Transport read
 *   "Available $355.64 ($227.95 plan + $127.69 rolled over)" over a September its
 *   accounts were imported through Aug 12. Such a period passes the balance on
 *   untouched — as though it spent its plan exactly — and is named in `heldBack`.
 *   Read is asked as its category PAGE asks that window (`categoryReachFor`, the
 *   day the row counts `uncoveredDays` against — its own, its ancestor's, else the
 *   ledger's), and every day of it must be read (`emptyPeriodReason` "measured"):
 *   a day past that day, or before the ledger opens, is a day nobody has looked
 *   at. ⚖️ A category spent only from cash wallets by its own rule (2026-09-15):
 *   its page reads it through today, so it banks — no statement is coming to wait
 *   for. Nothing is stored, so the carry arrives on the load after the statement.
 *   Whose day it asked is returned (`readOn`), so the panel's rule names THAT day
 *   (`lib/rollover-held-back::rolloverWaitsSentence`) — 🔴 it named the category's
 *   own accounts under every budget, Gifts & Donations' among them, which has none
 *   and waits on the ledger's (review of 46b6e4b). ⚠️ A period older than the six
 *   months asks a WIDER accounts window (`spentFromSinceFor`), which can find the
 *   category's own accounts where the recent one found none; `readOn` is the newest
 *   period's — the one the panel's "lately" speaks for.
 *
 * Derived at read time and never stored: the 2026-08-03 import back-filled
 * $623.58 of spend into an already-closed July, so a stored balance would have
 * been stale within 72 hours.
 *
 * Cost: one `categorySpending` per closed period walked, one `budgetOverdue` per period read whole — and per period
 * held back only where it could still bank (`mayStillBank`) — and one `categoryReachFor` per distinct accounts window
 * (`spentFromSinceFor` — every period inside the last six months shares one), which grows with calendar time.
 * Deliberately exact rather than truncated to a recent window — a silently-bounded
 * lookback would report a carry that is not the sum of the periods it claims to
 * cover. `rolloverStartsOn` is the supported way to bound it.
 */
export function carryInto(
  db: AppDatabase,
  budget: CarryableBudget,
  currentPeriodStart: string,
  today: string,
  reads: CarryReads = carryReads(db),
): RolloverCarry {
  const from = budget.rolloverStartsOn ?? budget.startsOn;
  const first = periodBounds(from, budget.period);
  // a period the budget only partly owned is skipped whole, never prorated
  let cursor = compareDates(first.start, from) < 0 ? addDays(first.end, 1) : first.start;
  // the day a window is read through depends on its start only through the accounts window it opens
  const reached = new Map<string, CategoryReachWalk>();
  const reachFrom = (start: string): CategoryReachWalk => {
    const since = spentFromSinceFor(start, today);
    let walk = reached.get(since);
    if (walk === undefined) {
      // asked from `since`, which opens the same accounts window `start` does (`spentFromSinceFor`)
      walk = categoryReachWalk(db, budget.categoryId, since, today, reads);
      reached.set(since, walk);
    }
    return walk;
  };
  const readWhole = (p: PeriodBounds, through: string | null): boolean => {
    // every day of it read: none past that day, none before the ledger opens
    const window = { from: p.start, to: p.end, today, ledgerOpens: reads.opens, ledgerReaches: through };
    return emptyPeriodReason(window).kind === "measured";
  };

  let balance = 0;
  const heldBack: PeriodBounds[] = [];
  // every period walked, in order — what the periods held back can still bank is walked from them (`mayStillBank`)
  const steps: CarryStep[] = [];
  let newest: CategoryReachWalk | null = null;
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
    cursor = addDays(p.end, 1);
    newest = reachFrom(p.start);
    const spent = categorySpending(db, {
      categoryId: budget.categoryId,
      from: p.start,
      to: p.end,
    }).spentCents;
    // ⚖️ decision 67: a day of it not read yet, so it banks nothing until its statements land
    if (!readWhole(p, newest.reach.through)) {
      heldBack.push(p);
      steps.push({ term: budget.amountCents - spent, held: p });
      continue;
    }
    const overdue = budgetOverdue(db, budget.categoryId, p.start, p.end).totalCents;
    const term = budget.amountCents - spent - overdue;
    balance = banked(balance + term, budget.rolloverCapCents);
    steps.push({ term, held: null });
  }
  // ⛔ whose day it waited on, as it asked it — the period now running's where none has closed (review of 46b6e4b)
  const { reach, ancestor } = newest ?? reachFrom(currentPeriodStart);
  // …and of a cash-only day, the facts its row's Grading line is worded from, so the panel says it in those words
  const { spentFromSince, spentFromWallets } = reach.coverage;
  const cash = reach.whose === "cash-only" ? { cash: { spentFromSince, spentFromWallets } } : {};
  const overdueOf = (p: PeriodBounds): number => budgetOverdue(db, budget.categoryId, p.start, p.end).totalCents;
  const mayAddCents = mayStillBank(steps, balance, budget.rolloverCapCents, overdueOf);
  return { cents: balance, heldBack, mayAddCents, readOn: { whose: reach.whose, ancestor, ...cash } };
}

/** A balance after a period's term: never below zero, never past the cap (`carryInto`'s first rule, and its cap). */
function banked(balanceCents: number, capCents: number | null): number {
  const floored = Math.max(0, balanceCents);
  return capCents === null ? floored : Math.min(floored, capCents);
}

/** One closed period `carryInto` walked, for what the periods held back can still bank (`mayStillBank`). */
interface CarryStep {
  /** read whole: its plan less its spend and overdue, as the carry banks it; held back: its plan less what is found */
  term: number;
  /** the period where it is held back — its overdue is not in `term` yet — and null where it was read whole */
  held: PeriodBounds | null;
}

/**
 * `RolloverCarry.mayAddCents`: the carry walked again with every period held back banked on what is found in it so
 * far — its spend less the bills due in it and not posted, as the carry counts it once read — less `balance`.
 *
 * ⚡ Their overdue is read only where it could matter. An overdue bill only LOWERS what a period banks and every step
 * is monotone in the one before, so a walk without theirs that comes to no more than `balance` says, exactly, that
 * nothing held back can add to it. On his ledger copy 2026-10-29 five of his seven held-back Septembers were past
 * their plans on spend alone (Entertainment, Food, Shopping, Subscriptions, Transport) and read no overdue at all;
 * Cash & ATM and Fees, $0.00 found of their plans, read theirs.
 */
function mayStillBank(
  steps: readonly CarryStep[],
  balance: number,
  capCents: number | null,
  overdueOf: (p: PeriodBounds) => number,
): number {
  const walk = (heldOverdue: (p: PeriodBounds) => number): number =>
    steps.reduce((c, s) => banked(c + s.term - (s.held === null ? 0 : heldOverdue(s.held)), capCents), 0);
  if (walk(() => 0) <= balance) return 0;
  return Math.max(0, walk(overdueOf) - balance);
}

/**
 * What a budget that does not roll over carries: nothing — in a list of its OWN. 🔴 One module-level object was handed
 * to every such budget, so all of them shared one `heldBack` array, and a reader writing into one row's list would
 * have written into every other's and every later load's (review of 73a743d). Built per budget, and read-only besides.
 */
function nothingCarried(): RolloverCarry {
  return { cents: 0, heldBack: [], mayAddCents: 0, readOn: null };
}

/**
 * Actual-vs-budget for every active budget, evaluated in refDate's period. `reads` are the carry's (`carryReads`),
 * asked once and only when a budget rolls over — `budgetPaceStatuses` hands in the ones it already holds.
 *
 * `only.categoryId` builds that category's budget alone — the row the whole list holds, "also counts toward its
 * parent" included (every active budget is still read for that). ⚡ `/categories/<id>` reads one row
 * (`budgetPaceStatusFor`), and building all of them walked every rolling budget's carry to find it: nine of his
 * twelve, about 100 ms per category page on his ledger copy 2026-10-13.
 */
export function budgetStatuses(
  db: AppDatabase,
  refDate: string = todayIso(),
  reads?: CarryReads,
  only?: { categoryId: string },
): BudgetStatus[] {
  const idx = loadCategoryIndex(db);
  const rows = db.select().from(budgets).where(eq(budgets.isActive, true)).all();
  const budgetedCategoryIds = new Set(rows.map((r) => r.categoryId));
  let carryReadsOnce = reads;

  return rows
    .filter((b) => only === undefined || b.categoryId === only.categoryId)
    .map((b): BudgetStatus => {
      // A budget grades only the days it has actually existed. createBudget
      // stamps startsOn = today, so an unclamped period would judge a budget
      // made this morning against the whole month's PRIOR spend and open at
      // "over by 4798%". Only the START clamps — the end stays the period's, so
      // the bar still fills toward the real period close.
      const period = periodBounds(refDate, b.period);
      const partialPeriod = compareDates(b.startsOn, period.start) > 0;
      const bounds: PeriodBounds = partialPeriod ? { start: b.startsOn, end: period.end } : period;
      const { spentCents, txnCount } = categorySpending(db, {
        categoryId: b.categoryId,
        from: bounds.start,
        to: bounds.end,
      });
      // Banked plan from closed periods. Off by default, and `carryInto` is not
      // even called then, so a non-rollover budget grades exactly as it did
      // before the column existed.
      const carry = b.rolloverEnabled
        ? carryInto(db, b, period.start, refDate, (carryReadsOnce ??= carryReads(db)))
        : nothingCarried();
      const rolloverCents = carry.cents;
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
        categoryPath: formatCategoryPath(parent?.name, node.name),
        bounds,
        partialPeriod,
        spentCents,
        txnCount,
        rolloverCents,
        rolloverHeldBack: carry.heldBack,
        rolloverMayAddCents: carry.mayAddCents,
        rolloverReadOn: carry.readOn,
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
   * is simply not evidence about the remaining days. A REFUND that size is the
   * same event in reverse, so this can be negative (`budgetOneOffCents`).
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
 *
 * ⚖️ …AND THE CAR'S UP-FRONT MONEY, whatever its size (`isUpfrontCarRow`, owner decision 2026-10-07, §6A 51): spent
 * once, so graded as spent and never extrapolated. 🔴 Only a charge bigger than the plan was held out, so on a Car
 * budget larger than the $1,100 deposit the deposit was paced over the rest of August as a habit. ⛔ ONE set, not two
 * terms: a down payment both up front and over the plan is held out once — subtracted twice, it would hide its own
 * size of ordinary spend (a repair) from the run-rate. Either sign, as the card nets a refund of the deposit.
 *
 * 🔴 …AND A REFUND LARGER THAN THE PLAN, the same event in reverse. Only a CHARGE was held out, so when a purchase over
 * the plan was returned inside the period the purchase left the run-rate and its return stayed in it, and `spent −
 * oneOff` came to the ordinary spend LESS the return: the return hid its own size of everyday spend — the shape the
 * paragraph above calls a defect. His ledger does it (Shopping, $280.00 plan): −$412.64 on 2026-05-12, +$412.64 on
 * 05-20; −/+$1,087.66 in March 2026; −/+$544.36 in February 2024. Measured on a copy with that budget started early,
 * the projection fell $890.27 → $383.64 the day the return posted — the spend so far and no rate at all; held out
 * with its purchase, it reads $594.64. A big refund of an earlier month's purchase is netted as money back (the row is
 * graded net) and never a rate either. Latent on his live budgets, which began 2026-07-16 and have seen none. Where
 * that refund nets the month below zero, it and the rate beside it can come to less than nothing: the projection
 * floors at zero (`budgetPaceStatusOf`).
 */
export function budgetOneOffCents(
  rows: readonly UpfrontCarCandidate[],
  planCents: number,
  notDrawn: ReadonlySet<string>,
  upfront: UpfrontCarRule | null,
): number {
  return rows
    .filter((t) => !rowIsRecurring(t.recurringSeriesId, notDrawn))
    .filter((t) => isUpfrontCarRow(upfront, t) || Math.abs(t.amountCents) > planCents)
    .reduce((sum, t) => sum - t.amountCents, 0);
}

/**
 * Posted income in a window, by analytics' own reader (`hisIncomeRows`): POSITIVE
 * amounts in income-kind categories, off the agent's cash account, and his PAY
 * read by the day. Split parts are attributed independently because
 * activeTxnsInRange explodes them.
 *
 * 🔴 It asked the category's kind with its own copy of the rule, so when the
 * owner decided (2026-09-28) that the agent's dividends and interest are not his
 * income, "$X in so far" — and the income basis it floors — would have gone on
 * counting them. One classifier, and the agent's rule comes with it.
 *
 * ⚖️ …AND A PAY SERIES' DAY IS ITS NET, as settlement spends it (his decision 75, 2026-10-13, `daysThatBanked`): a
 * payroll and its same-day return banked nothing and are in no figure of what came in, a partial return the same day
 * leaves the day its net — the same reader as /spending's Income, the cash-flow chart, the heatmap, the Sankey and the
 * dashboard's period panel, so the month's income has one answer. 🔴 Row by row, money in only, the returned payroll
 * stayed in "in so far" while the third leg named its payday unpaid: on the review's fixture September read $3,425.76
 * in so far + $1,141.92 still expected + $1,141.92 passed against four paydays at $4,567.68 (review of b0219f5); and
 * netted here alone, over rows filed under Income alone, /spending still read $3,425.76 and a return filed as a
 * transfer was netted by nothing but settlement (review of 54d77ad; hypothetical: no money out is linked to his pay,
 * a copy of his ledger 2026-10-13).
 */
function incomeTotalCents(db: AppDatabase, agentsCash: ReadonlySet<string>, from: string, to: string): number {
  if (compareDates(from, to) > 0) return 0;
  const rows = activeTxnsInRange(db, from, to);
  return hisIncomeRows(loadCategoryIndex(db), agentsCash, incomeSeriesOfRender(db), rows).reduce(
    (sum, r) => sum + r.amountCents,
    0,
  );
}

export interface IncomeExpectation {
  /** money already in, inside [start, today] — a pay series' days by their net, as settlement spends them (decision 75) */
  postedCents: number;
  /**
   * ⚖️ §6A 68 (2026-10-13): NOT ONE day of this window has been checked in the accounts any live pay series lands in
   * (`checkedThroughBySeries`, the frontier the passed paydays' sentence names) and no income posted in it — so
   * `postedCents` is no measurement, and the header prints "— in so far" for it. ⛔ Money found keeps its figure: a
   * deposit in the ledger is in so far whatever day the balances are checked through (§6A 64's rule for a row found).
   */
  noIncomeDayRead: boolean;
  /**
   * money still expected, from TODAY through end — less every payday a deposit
   * has already paid (that money is in `postedCents`, or in
   * `paidByAnotherMonthCents` when it landed outside this window)
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
   * against them — the third leg, and one reason the first two do not have to
   * add up to `scheduledCents` (the fourth leg, `paidByAnotherMonthCents`, and
   * its mirror `paidForAnotherMonthCents` are the others).
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
  /**
   * The MONEY from deposits outside the window `postedCents` covers that paid
   * paydays inside this window — the fourth leg. Settle-backwards
   * (`paydaySettlement`) spends a deposit on paydays either side of a month
   * line: his Thursday Oct 1 paid by the deposit of Wed Sep 30.
   *
   * ⚖️ His decision (§6A 29): a fourth figure beside the other three, naming
   * money that arrived in another month — "$1,141.92 paid early, in September"
   * — rather than a month that says nothing about money banked elsewhere.
   * Without it such a payday is in no leg once today has passed it: not posted
   * (the money is another month's), not expected (it is behind the forward
   * leg), not passed-unpaid (settlement says it was met).
   *
   * 🔴 Money, not the schedule: the sum of what those deposits put in
   * (settlement's `portions`), so a short deposit is counted at what it carried
   * and a payday paid partly by this month's money is counted only for the
   * part that was not. The sentence names the deposits so the reader can go and
   * find the rows — they have to hold what it says.
   *
   * ⛔ Never added to `postedCents` or `expectedCents`: the money is in the other
   * month's own posted figure, and adding it here too counts it twice.
   */
  paidByAnotherMonthCents: number;
  /** how many of this window's paydays that money went into */
  paidByAnotherMonthOccurrences: number;
  /** the `posted_on` of each deposit it came from, oldest first, each once */
  paidByAnotherMonthDeposits: string[];
  /**
   * The mirror of the fourth leg: money INSIDE `postedCents` that settlement
   * spent on a payday OUTSIDE this window. Measured on a copy of his ledger
   * 2026-09-28: the weekly deposit of Sep 24 paid Aug 20, so September's "in so
   * far" holds five weeks of pay against four September paydays.
   *
   * 🔴 The two used to cancel. Across a month line — a lump on Sep 30 that
   * reaches forward to pay Oct 1, and the Oct 1 deposit that then goes back to
   * Aug 27 — the week in so far is August's and October's own week is in the
   * fourth leg, and with only the fourth leg named the header read a week over
   * the schedule: $1,141.92 in so far + $4,567.68 still expected + $1,141.92
   * paid early against five paydays at $5,709.60.
   *
   * ⛔ Named, never subtracted from `postedCents`: that figure is what landed,
   * and the income basis floors on it as a measurement. So the four legs add up
   * to the schedule as posted − this + expected + passed-unpaid + the fourth.
   */
  paidForAnotherMonthCents: number;
  /** the `posted_on` of each deposit in this window that money came from, oldest first, each once */
  paidForAnotherMonthDeposits: string[];
  /** the paydays outside this window it went to, oldest first, each once */
  paidForAnotherMonthPaydays: string[];
  /** which figure budgets are graded against, and how this month sits on it */
  basis: IncomeBasis;
  /**
   * The series whose annualised rates the levelled figure sums, in the order walked — what is behind `basis` under
   * `levelled` (`incomeBasisHref`). ⛔ Not `series`: that is the forward leg's, and a schedule whose next payday
   * this month has already met is behind the rate while it is in no "still expected" figure.
   */
  levelledSeriesIds: string[];
  /** the live income series contributing to expectedCents */
  series: { id: string; name: string; amountCents: number }[];
}

/** a recurring series as read — `hisLiveIncomeSeries`' rows */
type RecurringSeriesRow = typeof recurringSeries.$inferSelect;

/** How far ahead a series must still be paying to earn its annualised rate. */
const BASIS_HORIZON_MONTHS = 12;

/**
 * ⚖️ His live income series — detected or confirmed, never the agent's (`isAgentsIncomeSeries`, owner decision
 * 2026-09-28). 🔴 `incomeExpectation`'s posted leg had learned whose income is whose and its other legs had not. On a
 * fixture with the agent's month-end interest detected on its cash account, "$X in so far" left the $0.04 out while
 * "$Y still expected" counted it, the month note read "6 paydays" for October's five Thursdays, and the basis the
 * runway and the income card read rose by it. Every leg there walks this one list, and so does `noIncomeDayReadOf`.
 */
export function hisLiveIncomeSeries(db: AppDatabase, agentsCash: ReadonlySet<string>): RecurringSeriesRow[] {
  return db
    .select()
    .from(recurringSeries)
    .where(and(eq(recurringSeries.kind, "income"), inArray(recurringSeries.status, ["detected", "confirmed"])))
    .all()
    .filter((s) => !isAgentsIncomeSeries(agentsCash, s));
}

/**
 * ⚖️ §6A 68 (2026-10-13): whether a window's Income is NO measurement — nothing found in it, and NOT ONE of its days
 * checked in the accounts any of his live pay series lands in (`checkedThroughBySeries`, the frontier the passed
 * paydays' sentence names). Asked of the window's first day: a frontier that has reached it has read at least that day
 * (`paydayIsRead`), one that has not has read none. 🔴 Measured on his ledger copy 2026-10-12: "$0.00 in so far,
 * $3,425.76 still expected" over an October with Wells Fargo, where It America LLC's pay lands, checked through Sep 24
 * — a zero nobody had looked for.
 *
 * ⛔ THE ONE RULE for an Income dash: /budgets' "— in so far" and the dashboard's "Income recorded in Oct 2026 —" (both
 * through `incomeExpectation`), and /spending's Income card and cash-flow buckets (`cashFlowByPeriod`, 2026-10-21). 🔴
 * /spending asked none, and on his ledger copy 2026-10-21 carded October "INCOME $0.00 · NET -$1,603.00" under that
 * dashboard's dash. ⛔ Money found keeps its figure (§6A 64's rule for a row found), and with no live pay schedule
 * there are no accounts the pay lands in to wait for — a $0.00 stands, as it always has.
 *
 * A reader for one `today`, asked per window: ⚡ the frontier is read once, and only when a window found nothing.
 */
export function noIncomeDayReadOf(
  db: AppDatabase,
  today: string,
  live: readonly RecurringSeriesRow[],
): (start: string, foundCents: number) => boolean {
  let checkedOf: ((seriesId: string) => string | null) | null = null;
  return (start, foundCents) => {
    if (foundCents !== 0 || live.length === 0) return false;
    checkedOf ??= checkedThroughBySeries(db, today);
    const read = checkedOf;
    return live.every((s) => !paydayIsRead(start, read(s.id)));
  };
}

/**
 * What this period is expected to bring IN — the term `/budgets` has never had.
 *
 * Ten budgets totalling more than the owner earns is the single most useful
 * thing the page could tell him, and before this nothing on it mentioned income
 * at all. `postedCents` is posted actuals over [start, today]; `expectedCents`
 * is the schedule from today on, minus every payday a deposit has already paid
 * — disjoint by the one fact that matters, so a paycheque that has already
 * landed is never also forecast and one that has not is never lost. The other
 * two legs name what neither holds: paydays that passed unpaid, and paydays
 * money from another month paid.
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
  // whose money is whose, read once: the posted leg and the series every other leg walks answer it alike
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const postedCents = incomeTotalCents(db, agentsCash, start, postedThrough);

  // ⚖️ his live income series, never the agent's — every leg below walks this one list (`hisLiveIncomeSeries`)
  const live = hisLiveIncomeSeries(db, agentsCash);

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
   * $5,709.60.
   *
   * ⚖️ HIS ANSWER (§6A 29) IS A FOURTH FIGURE, so a paid payday leaves this leg
   * whichever month its money landed in: inside the window it is in
   * `postedCents`, outside it `paidByAnotherMonthCents` names it. The 09-28 fix
   * kept the outside case HERE, because no figure could name it otherwise — and
   * that held only until the payday passed. The day after, it fell out of every
   * leg (read on 2026-10-02: posted $0.00 + expected $4,567.68 + passed-unpaid
   * $0.00 against $5,709.60 scheduled); and on the payday itself "still
   * expected" called money that landed the day before still to come, while
   * /recurring drew Oct 1 "paid by the deposit of Sep 30" and the forecast
   * projected four October paydays, not five.
   */
  const settlements = paydaySettlementsBySeries(
    db,
    live.map((s) => s.id),
    today,
  );
  /** whether a deposit's money is in `postedCents` — the window it covers */
  const paidInsideWindow = (depositOn: string): boolean =>
    compareDates(depositOn, start) >= 0 && compareDates(depositOn, postedThrough) <= 0;
  const series: IncomeExpectation["series"] = [];
  let expectedCents = 0;
  if (compareDates(from, end) <= 0) {
    for (const s of live) {
      const met = settlements.get(s.id)?.settledBy ?? new Map<string, string>();
      // money IN only — a refund-shaped income series must not subtract here
      const cents = projectOccurrences(toProjectable(s), from, end)
        .filter((o) => o.amountCents > 0)
        // pay a deposit has already answered is not still to come: its money is
        // in postedCents or, landed in another month, in the fourth leg below
        .filter((o) => !met.has(o.date))
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
  // ⚖️ §6A 68 (2026-10-13): whether ANY day of this window has been checked where the pay lands (`noIncomeDayReadOf`)
  const noIncomeDayRead = noIncomeDayReadOf(db, today, live)(start, postedCents);
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
  // …and whose rates they are, added on the same line, so the link and the figure cannot name different sets
  const levelledSeriesIds: string[] = [];
  /*
   * The money that crossed the month line, both ways: another month's money
   * that paid paydays in this window (the fourth leg), and money in
   * `postedCents` that paid paydays outside it (its mirror). Read off the SAME
   * walk as the schedule, for the schedule's own reason — the month note prints
   * "5 paydays … $5,709.60" and these name money in and out of those days, so
   * they cannot be allowed to describe a different set. Whose money paid which
   * payday is `paydaySettlement`'s answer (`portions`), and whether that money
   * is in `postedCents` is `paidInsideWindow` — no third spelling of either.
   *
   * 🔴 THE MONEY, not the payday's scheduled amount. The fourth leg added
   * `o.amountCents` wherever a payday's settling deposit fell outside the
   * window, so read on 2026-10-02 it said "$1,141.92 … paid early, by the
   * deposit of Wed, Sep 30" of a row holding $1,100.00 (a short deposit the
   * anchor clause lets settle Oct 1), and a payday paid partly by change
   * carried over from another month went wholly to whichever side its settling
   * deposit fell on.
   *
   * 🔴 AND BOTH WAYS, because the two halves cancel. A lump on Wed Sep 30 pays
   * Oct 1 and the Oct 1 deposit, finding its payday paid, goes back to Aug 27:
   * the week in so far is August's, October's own week is in the fourth leg,
   * and with only that one named the header read $1,141.92 in so far +
   * $4,567.68 still expected + $1,141.92 paid early against five paydays at
   * $5,709.60. Each portion is sorted by the two questions, so every cent a
   * deposit in this window spent either paid this window's paydays or is named
   * as having paid another's. The sort is `portionsAcross`, which the recurring
   * calendar's Settled figure reads too, so the two pages cannot sort one sum
   * to different sides of the same month line.
   */
  let paidByAnotherMonthCents = 0;
  let paidByAnotherMonthOccurrences = 0;
  const paidByAnotherMonthDeposits = new Set<string>();
  let paidForAnotherMonthCents = 0;
  const paidForAnotherMonthDeposits = new Set<string>();
  const paidForAnotherMonthPaydays = new Set<string>();
  for (const s of live) {
    /*
     * ⚖️ From the series' first payday (`paydayProjectable`, §6A 55 step B) — the paydays its settlement walked and
     * Earned vs banked counts. 🔴 From the stored anchor, his June scheduled no payday while the income card earned
     * four cash weeks in it.
     */
    const inPeriod = projectOccurrences(paydayProjectable(s, settlements.get(s.id), today), start, end).filter(
      (o) => o.amountCents > 0,
    );
    scheduledOccurrences += inPeriod.length;
    scheduledCents += inPeriod.reduce((sum, o) => sum + o.amountCents, 0);
    const scheduledDays = new Set(inPeriod.map((o) => o.date));
    const paidFromElsewhere = new Set<string>();
    const across = portionsAcross(settlements.get(s.id)?.portions ?? [], {
      paydayInside: (day) => scheduledDays.has(day),
      depositInside: paidInsideWindow,
    });
    for (const p of across.paidByAnotherWindow) {
      paidByAnotherMonthCents += p.cents;
      paidByAnotherMonthDeposits.add(p.depositOn);
      paidFromElsewhere.add(p.paydayOn);
    }
    for (const p of across.paidForAnotherWindow) {
      paidForAnotherMonthCents += p.cents;
      paidForAnotherMonthDeposits.add(p.depositOn);
      paidForAnotherMonthPaydays.add(p.paydayOn);
    }
    paidByAnotherMonthOccurrences += paidFromElsewhere.size;

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
    levelledSeriesIds.push(s.id);
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
    noIncomeDayRead,
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
    levelledSeriesIds,
    passedUnpaidCents,
    passedUnpaidOccurrences,
    passedUnpaidCheckedOccurrences: passed.checkedOccurrenceCount,
    passedUnpaidFrontier: passed.frontier,
    paidByAnotherMonthCents,
    paidByAnotherMonthOccurrences,
    paidByAnotherMonthDeposits: [...paidByAnotherMonthDeposits].sort(compareDates),
    paidForAnotherMonthCents,
    paidForAnotherMonthDeposits: [...paidForAnotherMonthDeposits].sort(compareDates),
    paidForAnotherMonthPaydays: [...paidForAnotherMonthPaydays].sort(compareDates),
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
 *
 * ⛔ Each late series carries how much of it the ledger has not read (`unreadCents`), through `arrearsInWindow` — the
 * split the runway, the bill's page and /recurring say their arrears through. 🔴 This leg alone skipped it, so the
 * row said "not imported" in warning colour whatever had been read (review of a132c57, 2026-10-08).
 */
export function budgetOverdue(
  db: AppDatabase,
  categoryId: string,
  periodStart: string,
  today: string,
): Arrears {
  const seriesIds = recurringSeriesIdsForCategory(db, categoryId);
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };
  // the only arrears leg that closes ON today (see `budgetTail`), so the day it walks to is the day it is asked on
  return arrearsInWindow(db, seriesIds, periodStart, today, today);
}

/**
 * A line of the FORWARD tail — the one budget list that prints a cadence ("Nov 11 · monthly"), so the one that
 * carries the one-charge reading (`oneChargeDays`). ⚖️ Owner decision 2026-10-08 (§6A 56): a series whose whole
 * schedule holds one charge reads "Nov 11 · once". The overdue list names a day and no cadence, and needs none.
 */
export interface BudgetTailLine extends BudgetTailSeries {
  oneCharge: boolean;
}

export interface ForwardBudgetTail extends BudgetTail {
  series: BudgetTailLine[];
}

export function budgetTail(
  db: AppDatabase,
  categoryId: string,
  periodEnd: string,
  today: string,
): ForwardBudgetTail {
  const seriesIds = recurringSeriesIdsForCategory(db, categoryId);
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };

  /*
   * ⛔ STRICTLY AFTER TODAY, AND THE REASON IS NOT THE CALENDAR — it is that
   * the overdue leg closes ON today and checks postings.
   *
   * `overdueForSeries` drops an occurrence a linked charge already covers
   * (within the series' own tolerance); this walk projects the schedule less
   * what a payment has already paid (below). A bill due TODAY may already have
   * posted, in which case `spentCents` holds it — so it belongs in the leg that
   * can see that, and putting it here would count it twice.
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
  // upcomingOccurrences' detected|confirmed horizon). Each with the carrier it is billed with, whose postings are
  // its evidence (`lastSeenOn`, §6A 59) — the lapse gate below reads them.
  const rows = withBillingCarriers(
    db,
    db
      .select()
      .from(recurringSeries)
      .where(
        and(
          inArray(recurringSeries.id, [...seriesIds]),
          inArray(recurringSeries.status, ["detected", "confirmed"]),
        ),
      )
      .all(),
  );
  // ⚖️ §6A 56 — the cadence word this list prints, from the one reading every cadence printer asks
  const oneCharge = oneChargeDays(db, rows);
  /*
   * ⛔ …and a day after today a payment has ALREADY paid is not still to come either — the bill paid early, which
   * `spentCents` holds (`stillToComeReader`, the forecast's and the Upcoming tab's reading; in another period, that
   * period's spend holds it, as the calendar settles it there). 🔴 A bill due Oct 22 and paid Oct 20 was counted here
   * on top of the Oct 20 row, read on Oct 21 (review of 50020a2).
   */
  const toCome = stillToComeReader(db, rows, today);

  const series: BudgetTailLine[] = [];
  let totalCents = 0;
  // the lapse is measured to each series' checked day (§6A 57)
  const checkedThrough = silenceMeasuredThroughBySeries(db, today);
  for (const s of rows) {
    // a series that stopped charging is not a forecast — see seriesHasLapsed for
    // why this is not `isSeriesActive` (a registered commitment has no postings
    // yet and must still be projected). `hasStoppedForecasting`, the predicate
    // `budgetOverdue` asks too: money in never lapses, in either leg.
    if (hasStoppedForecasting(s, today, checkedThrough(s.id))) continue;
    const occ = stillToCome(toCome, s, projectOccurrences(toProjectable(s), from, periodEnd)).filter(
      (o) => o.amountCents < 0,
    );
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
      occurrenceCents: occ.map((o) => -o.amountCents),
      href: `/recurring/${s.id}`,
      oneCharge: oneCharge.has(s.id),
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
 *
 * ⚖️ A SUBSET of `spentCents`, so it reads his rows only: the agent's cash is left
 * out, as `spendingTransactions` leaves it out (owner decision 2026-10-02). 🔴 Its
 * linked Gold fee came off his variable spend as a bill of his already paid.
 */
function recurringPostedCents(
  db: AppDatabase,
  categoryId: string,
  from: string,
  to: string,
  notDrawn: ReadonlySet<string>,
): number {
  const subtree = loadCategoryIndex(db).subtreeIds(categoryId);
  const his = offAgentsCash([...outsidePortfolioCashAccountIds(db)]);
  const unsplit = db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        linkIsRecurring(notDrawn),
        his,
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
        his,
        inArray(transactionSplits.categoryId, subtree),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();
  return [...unsplit, ...splitParts].reduce((sum, r) => sum - r.amountCents, 0);
}

export interface CategoryCoverage {
  /**
   * the earliest import frontier among the accounts below a statement is still coming for — among all of them when
   * none of those has one; null when none has one at all
   */
  importedThroughOn: string | null;
  /** where the window of accounts opens: six full months back, or the period's start if earlier */
  spentFromSince: string;
  /** accounts other than cash wallets the subtree was spent from over [spentFromSince, today], any with no frontier included */
  spentFromAccounts: number;
  /** cash wallets it was spent from over the same days — never part of `importedThroughOn` (⚖️ below) */
  spentFromWallets: number;
}

/**
 * How many full calendar months before `refDate`'s month `spentFromSinceFor` looks back for the accounts a category is
 * spent from.
 *
 * ⚠️ It was the inline editor's guide window, and is no longer: since his decision 71 (2026-10-13) the guide averages
 * only months every account he spends from has been read through to the end of, and slides back behind that day
 * (`budget-guide.ts`). Which accounts a category is spent from is a question of recency, not an average — a charge on
 * an unread month still says the account is spent from — so this stays the calendar's six.
 */
const SPENT_FROM_MONTHS = 6;

/**
 * Where the window of accounts a category was spent from opens (`categoryCoverage`): `SPENT_FROM_MONTHS` full months
 * before `refDate`'s month, or `periodStart` when that is earlier. Every window starting inside those months asks the
 * same accounts, and so reads through the same day — what `carryInto` asks once.
 */
export function spentFromSinceFor(periodStart: string, refDate: string): string {
  // always SPENT_FROM_MONTHS windows, oldest first
  const windowStart = trailingFullMonths(refDate, SPENT_FROM_MONTHS)[0]!.start;
  return compareDates(periodStart, windowStart) < 0 ? periodStart : windowStart;
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
 * ⚠️ The window is what keeps a dormant account from vetoing forever. It is
 * `SPENT_FROM_MONTHS` full months before today's month — the calendar's six,
 * which the editor's guide read until decision 71 slid it behind the frontier —
 * opened at the period's own start when that is earlier, so an annual
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
 * ⚖️ THE CATEGORY PAGE ASKS THIS RULE TOO — owner decision 2026-10-07 (§6A 49).
 * `/categories/[id]`, the page each row links to, fed `emptyPeriodReason` the
 * ledger-wide `ledgerReaches`. Measured on his ledger that day: the Car row read
 * "spending imported through Aug 12 · 7 days of this period unaccounted" (Chase
 * Checking stops Aug 12), and `/categories/<Car>` one click away "October 2026
 * has not been imported yet. Nothing has been imported for 7 days of it; the
 * ledger is imported through Thu, Sep 24, 2026" (Fees, Cash & ATM and Travel
 * read the same there on 2026-09-15). The page names the category's own day
 * now, through `categoryReachFor` below — this function, never a copy — and so
 * do its trend's empty months and its headline's proof (`categorySpend`).
 * Where THIS names no day (and the row is not cash only), the row asks the page's
 * in turn — an ancestor's, else the ledger's (`borrowedReach`).
 *
 * ⚖️ …AND SO ARE ARCHIVED ACCOUNTS, while an account a statement is still coming
 * for was spent from — the one rule (`accountsAwaitingStatements`) /imports asks
 * for its statements by and a series' lapse is held back by (2026-10-08), asked
 * as /spending's cut and the dashboard ask it (`accountsThatDate`). An
 * archived card is never imported again, so its last statement held the row for
 * as long as its rows stayed in the window: "Awaiting statements", which
 * `lib/budget-verdict` forbids for a statement that never arrives. 🔴 On a copy
 * of his ledger with Chase Sapphire archived, Travel on 2027-01-20 read "spending
 * imported through Sep 2, 2026" — Sapphire's last statement — with Venture X, the
 * other account it was spent from, read through Sep 13 (review of 82d75d7).
 *  - ❓ Spent ONLY from accounts no statement is coming for, archived among them,
 *    the row keeps the archived account's own day — a true fact, where leaving it
 *    out would read "spent only from accounts with no import date" — and so still
 *    "Awaiting statements" until those rows leave the window (Health, with Venture
 *    X archived, on 2027-01-20). A "Cash only"-like row for it is his call.
 *
 * Deliberately NOT account coverage/verifiedThrough, which answers "which
 * periods reconcile", a stronger and more optimistic question (SoFi Checking
 * reports a verified 2026-07-31 against a last transaction of 2026-05-31, and
 * cash wallets report nothing at all). The accounts come from
 * `spendingTransactions`, the rows the budget is graded from.
 */
export function categoryCoverage(
  db: AppDatabase,
  categoryId: string,
  periodStart: string,
  refDate: string,
  frontier: ObservationFrontier,
  wallets: ReadonlySet<string>,
  // `accountsAwaitingStatements`: only these date the row while one of them was spent from
  awaiting: ReadonlySet<string>,
): CategoryCoverage {
  const spentFromSince = spentFromSinceFor(periodStart, refDate);
  const spentFrom = new Set(
    spendingTransactions(db, { categoryId, from: spentFromSince, to: refDate }).map((t) => t.accountId),
  );
  return coverageOfAccounts(spentFrom, spentFromSince, frontier, wallets, awaiting);
}

/**
 * `categoryCoverage`'s rule asked of accounts already found — the accounts a figure's rows were spent from over
 * `[spentFromSince, refDate]` (`spentFromSinceFor`): the earliest import day among them, wallets and archived accounts
 * left out as the row leaves them.
 *
 * ⚖️ Implied by his decision 72 (ruled by the orchestrator 2026-10-14): a merchant's own window is read by the accounts
 * it was paid from, by this rule (`provenance::merchantPartlyRead`). ⛔ This function, never a copy: a second copy is a
 * second day for the same accounts. ⚠️ One rule is not one day: a merchant and its category over the same days read the
 * same day only where they were paid from the same accounts — on his ledger copy 2026-10-21 IKEA reads "imported through
 * Oct 2, 2026" over Oct 27, 2025 – Oct 12, 2026, and Housing over those days "Jul 31, 2026" (its share's line names it).
 */
export function coverageOfAccounts(
  spentFrom: ReadonlySet<string>,
  spentFromSince: string,
  frontier: ObservationFrontier,
  wallets: ReadonlySet<string>,
  awaiting: ReadonlySet<string>,
): CategoryCoverage {
  // ⚖️ a wallet is counted on its own and never dates the row
  const imported = new Set([...spentFrom].filter((id) => !wallets.has(id)));
  return {
    // ⚖️ …nor does an archived account, while one a statement is still coming for has a day (`accountsThatDate`)
    importedThroughOn: frontierForSeries(frontier, accountsThatDate(frontier, imported, awaiting)),
    spentFromSince,
    spentFromAccounts: imported.size,
    spentFromWallets: spentFrom.size - imported.size,
  };
}

/** The reads `categoryReachFor` shares across every window it asks of one render — a page's period and its trend's months. */
export interface CategoryReachContext {
  frontier: ObservationFrontier;
  wallets: ReadonlySet<string>;
  /** `accountsAwaitingStatements` — the accounts that date a row (`categoryCoverage`) */
  awaiting: ReadonlySet<string>;
  /** `ledgerReaches(db)` — the day left standing where the category has no account of its own to ask */
  ledgerReaches: string | null;
}

export function categoryReachContext(db: AppDatabase): CategoryReachContext {
  return {
    frontier: observationFrontier(db),
    wallets: cashWalletIds(db),
    awaiting: accountsAwaitingStatements(db),
    ledgerReaches: ledgerReaches(db),
  };
}

/**
 * ⚖️ The day `/categories/[id]` asks a window starting `periodStart` against — the category's own (owner decision
 * 2026-10-07, §6A 49): `categoryCoverage` over the same window its budget row would grade, at `today`, and
 * `lib/category-reach::categoryReach` for the worlds in which that names no day (cash only; no account of its own).
 *
 * ⚠️ A category with no account of its own in the window asks its NEAREST ANCESTOR before the ledger. 🔴 Measured on a
 * copy of his ledger 2026-10-07: 9 of 80 category pages — Fees › Interest Charges, Utilities › Mobile, Travel ›
 * Hotels among them — fell back to the ledger's Sep 24 while the parent one click up named its own Aug 12. The
 * ancestor's day is named as the ancestor's ("spending in Fees is imported through …"); a top-level category with
 * nothing to ask keeps the ledger's, in the ledger's words.
 */
export function categoryReachFor(
  db: AppDatabase,
  categoryId: string,
  periodStart: string,
  today: string,
  ctx: CategoryReachContext = categoryReachContext(db),
): CategoryReach {
  return categoryReachWalk(db, categoryId, periodStart, today, ctx).reach;
}

/** `categoryReachFor`'s day, and the ANCESTOR it was found on — null where it is the category's own or the ledger's */
interface CategoryReachWalk {
  reach: CategoryReach;
  ancestor: string | null;
}

/**
 * `categoryReachFor`'s walk, saying whose day it found — what a rolling budget's panel names (`carryInto`'s `readOn`).
 * ⛔ The one walk: `categoryReachFor` is this, less the ancestor's name.
 */
function categoryReachWalk(
  db: AppDatabase,
  categoryId: string,
  periodStart: string,
  today: string,
  ctx: CategoryReachContext,
): CategoryReachWalk {
  const reachOf = (id: string) => {
    const row = db
      .select({ name: categories.name, kind: categories.kind, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, id))
      .get();
    if (!row) return null;
    const coverage = categoryCoverage(db, id, periodStart, today, ctx.frontier, ctx.wallets, ctx.awaiting);
    return { reach: categoryReach(coverage, ctx.ledgerReaches, today, { name: row.name, kind: row.kind }), parentId: row.parentId };
  };
  const own = reachOf(categoryId);
  if (own === null) throw new Error(`category ${categoryId} not found`);
  let next = own;
  // categories nest, so the walk is as long as the tree is deep — two levels on every ledger the app seeds
  while (next.reach.whose === "ledger" && next.parentId !== null) {
    const parent = reachOf(next.parentId);
    if (parent === null) break;
    next = parent;
  }
  if (next.reach.whose === "ledger") return { reach: own.reach, ancestor: null };
  return { reach: next.reach, ancestor: next === own ? null : next.reach.owner.name };
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
  tail: BudgetTailLine[];
  /** bills expected on/before today that never posted — money committed but missing */
  overdueCents: number;
  /**
   * Of `overdueCents`, the part on days no checked statement has reached (`ArrearsReading.unreadCents`) — what the
   * row, its dialog and the page note may not call "not posted", nor warn about.
   */
  overdueUnreadCents: number;
  /**
   * Of `overdueUnreadCents`, the part no statement keeps unread (`ArrearsSeries.inGraceCents`) — what they say waits for
   * its days to post, never "no statement has covered it yet".
   */
  overdueInGraceCents: number;
  overdue: ArrearsSeries[];
  /**
   * Days of THIS window the ledger cannot speak for: the elapsed days past
   * `importedThroughOn` — past `borrowedDay`'s where the category has none of its
   * own (`daysNotImportedYet`). A row spent only from cash wallets keeps them all,
   * and says why instead (`lib/budget-coverage::spentOnlyFromCashWallets`).
   * >0 means the row's spent/pace/% figures are lower bounds, not measurements,
   * and the UI must not report a verdict — "On track" over an unimported month
   * is the one failure mode a budgeting tool cannot afford. ⚠️ The % only while
   * the line it divides by cannot rise (`rolloverMayAddCents`, 2026-10-29).
   */
  uncoveredDays: number;
  /**
   * ⚖️ §6A 64 (2026-10-12): NOT ONE elapsed day of this window has been read by the day `uncoveredDays` is counted
   * against — the category headline's question (`lib/empty-period::emptyFigure` "dash"), asked of the same window and
   * day. With no row found in it the row prints "—" for Spent and Left (`lib/budget-coverage::spendUnread`). True of
   * a row spent only from cash wallets, which has no day at all; that row keeps its figures by the predicate's rule.
   */
  noDayRead: boolean;
  /**
   * the page's day where the category has no import day of its own and is not cash only (`borrowedReach`) — what
   * `uncoveredDays` was counted against, named in the row's sentence; null otherwise
   */
  borrowedDay: BorrowedDay | null;
}

/**
 * The reads every pace row shares — asked once per render, however many rows it builds. The carry's (`CarryReads`) are
 * among them: the ledger's opening end, and the import's per-account frontier, wallets and awaited accounts its page
 * asks a day with.
 */
interface BudgetPaceReads extends CarryReads {
  /** the series whose charges are not recurring money */
  notDrawn: ReadonlySet<string>;
  /** the car's up-front money, spent once and never a rate (§6A 51, `budgetOneOffCents`) */
  upfront: UpfrontCarRule | null;
}

function budgetPaceReads(db: AppDatabase, carry: CarryReads = carryReads(db)): BudgetPaceReads {
  const notDrawn = seriesIdsNotDrawnAsRecurring(db);
  return {
    // ⛔ the reads `/categories/[id]` asks its day with, so the row can ask the same one (`borrowedReach`) — the
    // page's own, where it hands them in (`budgetPaceStatusFor`)
    ...carry,
    notDrawn,
    upfront: upfrontCarRule(loadCategoryIndex(db), outsidePortfolioCashAccountIds(db), notDrawn),
  };
}

/**
 * ⚖️ The day a budget on a category with NO IMPORT DAY OF ITS OWN counts its window against: the one its page asks
 * (§6A 49, `categoryReachFor`) — the nearest ancestor's, else the ledger's. Null where the category has a day of its
 * own, and where it is spent only from cash wallets (⚖️ 2026-09-15: it keeps every elapsed day and reads "Cash only").
 *
 * 🔴 The row asked no day at all, so every elapsed day was "unaccounted" and the row waited for a statement no import
 * could bring. On a copy of his ledger copy 2026-10-12, a monthly budget made on Travel › Hotels (3 rows ever, none
 * since March) at 2026-09-02: `/categories/<Hotels>` headlined a measured $0.00 and its budget card, one block below,
 * "Awaiting statements · nothing imported for this category since Mar 1 · 2 days of this period unaccounted" — and once
 * Travel's day moved inside the window, the headline would count N days where the card kept counting all of them.
 * None of his 12 budgets is on such a category; one made on a dormant subcategory is.
 *
 * ⛔ `categoryReachFor` itself, never a copy of its walk: a second walk is a second day.
 */
function borrowedReach(
  db: AppDatabase,
  categoryId: string,
  own: CategoryCoverage,
  periodStart: string,
  refDate: string,
  ctx: CategoryReachContext,
): { through: string | null; day: BorrowedDay } | null {
  if (own.importedThroughOn !== null || spentOnlyFromCashWallets(own)) return null;
  // own names no day, so this is an ancestor's (an import day, or cash only — read through today) or the ledger's
  const reach = categoryReachFor(db, categoryId, periodStart, refDate, ctx);
  return {
    through: reach.through,
    day:
      reach.whose === "ledger"
        ? { whose: "ledger", on: reach.through }
        : { whose: "ancestor", name: reach.owner.name, coverage: reach.coverage },
  };
}

/** How far one category's window is READ — the coverage half of a /budgets row (`BudgetPaceStatus`). */
export interface CategoryWindowReading extends CategoryCoverage {
  /** the page's day where the category has none of its own and is not cash only (`borrowedReach`); null otherwise */
  borrowedDay: BorrowedDay | null;
  /** elapsed days of the window past the day it is read through (`BudgetPaceStatus.uncoveredDays`) */
  uncoveredDays: number;
  /** not one elapsed day of it read by that day (`BudgetPaceStatus.noDayRead`) */
  noDayRead: boolean;
}

/**
 * The day a category's window `[start, end]` is read through, and how many of its elapsed days lie past it — what a
 * /budgets row's coverage line is written from (`lib/budget-coverage::budgetCoverageSentence`).
 *
 * ⛔ One reading for the row and for the total its category page headlines over the same window (⚖️ decision 72,
 * 2026-10-13, `provenance::categorySpendProvenance`): the page's chip reads "partly read" over exactly the days the row
 * calls unaccounted, and prints the row's line under its figure. Two readings would be two days for one window.
 *
 * The uncovered stretch is measured against the graded window only: a frontier before the window opens leaves the
 * WHOLE elapsed window uncovered, and one on or past today leaves none. ⛔ The count is `daysNotImportedYet`, the
 * dashboard tile's and /spending's, not a third copy of the clamp — only the frontier it is given is this category's.
 * A category spent only from cash wallets keeps every elapsed day here and says why instead
 * (`spentOnlyFromCashWallets`): a caller grading a figure by the count asks that first.
 */
export function categoryWindowReading(
  db: AppDatabase,
  categoryId: string,
  window: { start: string; end: string },
  refDate: string,
  reads: CarryReads = carryReads(db),
): CategoryWindowReading {
  const coverage = categoryCoverage(db, categoryId, window.start, refDate, reads.frontier, reads.wallets, reads.awaiting);
  // ⚖️ no day of its own: the page's, so the card under its headline counts what the headline counts (`borrowedReach`)
  const borrowed = borrowedReach(db, categoryId, coverage, window.start, refDate, reads);
  const asked: EmptyPeriodInput = {
    from: window.start,
    to: window.end,
    today: refDate,
    ledgerOpens: reads.opens,
    ledgerReaches: borrowed === null ? coverage.importedThroughOn : borrowed.through,
  };
  return {
    ...coverage,
    borrowedDay: borrowed?.day ?? null,
    uncoveredDays: daysNotImportedYet(asked),
    // ⚖️ §6A 64: the headline's dash (`emptyFigure`) over the window and day the count above was taken on, never a
    // second reading of either
    noDayRead: emptyFigure(emptyPeriodReason(asked)) === "dash",
  };
}

/**
 * budgetStatuses enriched with pace, projection, and the expected tail — the
 * data behind the §8 bars. Kept separate from the lean budgetStatuses so a
 * caller pays for the per-row projection + tail only on the rows it draws:
 * /budgets on every row, `/categories/[id]` on its own one (`budgetPaceStatusFor`).
 */
export function budgetPaceStatuses(db: AppDatabase, refDate: string = todayIso()): BudgetPaceStatus[] {
  const reads = budgetPaceReads(db);
  return budgetStatuses(db, refDate, reads).map((s) => budgetPaceStatusOf(db, s, refDate, reads));
}

/**
 * ONE category's /budgets row, or null when it has no active budget — built alone (`budgetStatuses`' `only`) on the
 * reads its page already made (`carry`: the page's `categoryReachContext` and `ledgerOpens`), asked once for the
 * carry and the row both. ⚡ 🔴 `categoryBudgetRef` built every budget's row to find this one, and asked the page's
 * reads again for the carry and again for the row (review of e37997b): about 110 ms per category page on his ledger
 * copy 2026-10-13.
 */
export function budgetPaceStatusFor(
  db: AppDatabase,
  categoryId: string,
  refDate: string,
  carry?: CarryReads,
): BudgetPaceStatus | null {
  const reads = budgetPaceReads(db, carry);
  const [status] = budgetStatuses(db, refDate, reads, { categoryId });
  return status === undefined ? null : budgetPaceStatusOf(db, status, refDate, reads);
}

/**
 * ONE budget row's pace status — the row /budgets draws, built by the same code for any page that reads one row.
 *
 * ⛔ One rule, every caller. 🔴 `/categories/[id]`'s budget card read the lean `budgetStatuses` alone, and on his
 * ledger copy 2026-10-12 graded Housing's unimported October "$0.00 of $2,291.21 · $2,291.21 left" in green while
 * /budgets withheld the same row and window ("Awaiting statements"). It reads its verdict off this now.
 */
export function budgetPaceStatusOf(
  db: AppDatabase,
  s: BudgetStatus,
  refDate: string,
  reads: BudgetPaceReads = budgetPaceReads(db),
): BudgetPaceStatus {
  const { notDrawn, upfront } = reads;
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
    upfront,
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
  // 🔴 …nor below zero. A refund over the plan is held out of the rate as an event (`budgetOneOffCents`), so in a month
  // it nets below zero the rate beside it still runs, and the two came to less than nothing. On his ledger copy
  // 2026-10-12, Shopping's $280.00 budget started early: May 2024 (−$1,605.11) read "Projected ≈ -$1,050.14" on the
  // 10th and below zero every day to the 30th (review of c7a3510). The month spends nothing more than it has given
  // back; the row prints no $0.00 beside a spend below it (`BudgetRow`), as it prints none equal to the spend. Latent
  // on his live budgets.
  const projectedCents = Math.max(0, s.spentCents, forecast);
  return {
    ...s,
    overdueCents: overdue.totalCents,
    overdueUnreadCents: overdue.series.reduce((sum, o) => sum + o.unreadCents, 0),
    overdueInGraceCents: overdue.series.reduce((sum, o) => sum + o.inGraceCents, 0),
    overdue: overdue.series,
    ...categoryWindowReading(db, s.budget.categoryId, s.bounds, refDate, reads),
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
}
