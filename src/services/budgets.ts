import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { budgets, BUDGET_PERIODS, type BudgetPeriodKind } from "@/db/schema/budgets";
import { categories } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import {
  addDays,
  compareDates,
  diffDays,
  isValidIsoDate,
  periodBounds,
  todayIso,
  type PeriodBounds,
} from "@/lib/dates";
import { categorySpending, loadCategoryIndex, recurringSeriesIdsForCategory } from "./analytics";
import { trailingFullMonths } from "./forecast";
import { projectOccurrences, toProjectable } from "./recurring";

/**
 * Budgets (master-plan Phase 5). One active budget per (category, period),
 * enforced by the partial unique index — conflicts surface as clean errors.
 *
 * Overlap semantics (schema.md budgets): child spend rolls into a parent's
 * budget AND its own budget by design; alerts fire independently per budget
 * row; any "total budgeted" aggregate excludes budgets whose category is a
 * descendant of another budgeted category so totals never double-count.
 *
 * No rollover: leftover/overrun is informational only.
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
  };
  categoryName: string;
  /** "Food > Dining" for subcategories, "Food" for top-levels */
  categoryPath: string;
  bounds: PeriodBounds;
  /** subtree rollup of active expense spending inside bounds */
  spentCents: number;
  remainingCents: number;
  /** spent/budget — may exceed 1 (over) or dip below 0 (net refunds) */
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

/** Actual-vs-budget for every active budget, evaluated in refDate's period. */
export function budgetStatuses(db: AppDatabase, refDate: string = todayIso()): BudgetStatus[] {
  const idx = loadCategoryIndex(db);
  const rows = db.select().from(budgets).where(eq(budgets.isActive, true)).all();
  const budgetedCategoryIds = new Set(rows.map((r) => r.categoryId));

  return rows
    .map((b): BudgetStatus => {
      const bounds = periodBounds(refDate, b.period);
      const { spentCents } = categorySpending(db, {
        categoryId: b.categoryId,
        from: bounds.start,
        to: bounds.end,
      });
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
        },
        categoryName: node.name,
        categoryPath: parent ? `${parent.name} > ${node.name}` : node.name,
        bounds,
        spentCents,
        remainingCents: b.amountCents - spentCents,
        pct: spentCents / b.amountCents,
        alert: computeAlert(spentCents, b.amountCents),
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
  /** posted spend already tagged to a recurring series (subset of spentCents) */
  recurringPostedCents: number;
  /** future recurring occurrences still to post this period — the tail */
  expectedTailCents: number;
  /** days from period start through today, inclusive */
  elapsedDays: number;
  totalDays: number;
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
  const variablePosted = spentCents - recurringPostedCents;
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const variableRemainder =
    elapsedDays > 0 && variablePosted > 0
      ? Math.round((variablePosted * remainingDays) / elapsedDays)
      : 0;
  return spentCents + expectedTailCents + variableRemainder;
}

export interface BudgetTailSeries {
  id: string;
  name: string;
  cadence: string;
  /** first future in-period occurrence date */
  nextDate: string;
  /** total expected in (today, periodEnd], as positive money-out cents */
  amountCents: number;
  occurrenceCount: number;
  href: string;
}

export interface BudgetTail {
  totalCents: number;
  series: BudgetTailSeries[];
}

/**
 * Expected-but-unposted recurring for a category subtree within a period: every
 * future (strictly after today, through periodEnd) occurrence of the recurring
 * series linked to this subtree. Only money-out (expense) occurrences count — an
 * income series linked here never inflates a spending budget. Reuses
 * projectOccurrences, so the tail agrees with the Recurring tab to the cent.
 */
export function budgetTail(
  db: AppDatabase,
  categoryId: string,
  periodEnd: string,
  today: string,
): BudgetTail {
  const seriesIds = recurringSeriesIdsForCategory(db, categoryId);
  if (seriesIds.size === 0) return { totalCents: 0, series: [] };

  const from = addDays(today, 1); // strictly after today = not yet posted
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

/** Posted spend in a subtree already tagged to a recurring series, over [from,to]. */
function recurringPostedCents(db: AppDatabase, categoryId: string, from: string, to: string): number {
  const subtree = loadCategoryIndex(db).subtreeIds(categoryId);
  const rows = db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNotNull(transactions.recurringSeriesId),
        inArray(transactions.categoryId, subtree),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();
  return rows.reduce((sum, r) => sum - r.amountCents, 0);
}

export interface BudgetPaceStatus extends BudgetStatus {
  totalDays: number;
  /** days from period start through today (inclusive) */
  elapsedDays: number;
  /** 0..1 position of "today" within the period — where the pace tick sits */
  elapsedFraction: number;
  recurringPostedCents: number;
  /** the hollow tail: future recurring still to post this period */
  expectedTailCents: number;
  projectedCents: number;
  pace: BudgetPace;
  tail: BudgetTailSeries[];
}

/**
 * budgetStatuses enriched with pace, projection, and the expected tail — the
 * data behind the §8 bars. Kept separate from the lean budgetStatuses so the
 * category page's budget reference stays cheap; only the /budgets page pays for
 * the per-row projection + tail.
 */
export function budgetPaceStatuses(db: AppDatabase, refDate: string = todayIso()): BudgetPaceStatus[] {
  return budgetStatuses(db, refDate).map((s) => {
    const { start, end } = s.bounds;
    // budgetStatuses always evaluates the period CONTAINING refDate, so refDate
    // ∈ [start,end] and elapsedDays ∈ [1, totalDays] — no clamp needed.
    const totalDays = diffDays(start, end) + 1;
    const elapsedDays = diffDays(start, refDate) + 1;
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
    const posted = recurringPostedCents(db, s.budget.categoryId, start, refDate);
    const tail = budgetTail(db, s.budget.categoryId, end, refDate);
    const forecast = projectSpend({
      spentCents: spentToDate,
      recurringPostedCents: posted,
      expectedTailCents: tail.totalCents,
      elapsedDays,
      totalDays,
    });
    // never project below what has ALREADY posted for the whole period — a large
    // future-dated non-recurring charge is a committed fact, not an estimate, so
    // the full-period actual is the projection floor.
    const projectedCents = Math.max(s.spentCents, forecast);
    return {
      ...s,
      totalDays,
      elapsedDays,
      elapsedFraction: elapsedDays / totalDays,
      recurringPostedCents: posted,
      expectedTailCents: tail.totalCents,
      projectedCents,
      pace: computePace(s.spentCents, projectedCents, s.budget.amountCents),
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
