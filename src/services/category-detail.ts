import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories, type CategoryKind } from "@/db/schema/categories";
import { monthKey, periodBounds } from "@/lib/dates";
import {
  categorySpending,
  ledgerHref,
  loadCategoryIndex,
  monthKeysBack,
  recurringSeriesIdsForCategory,
  type DateRange,
} from "./analytics";
import { budgetStatuses } from "./budgets";
import { listSeries } from "./recurring";

/**
 * Category-page aggregates (ux-overhaul-plan §5.4) for `/categories/[id]`. The
 * page closes the linking chain: monthly trend, ranked merchants (via
 * spending.topMerchants scoped to the subtree), subcategory split, the budget
 * reference, and the recurring series whose linked transactions live in this
 * category — the bridge back to Stage 2. No schema change.
 */

export interface CategoryHeader {
  id: string;
  name: string;
  kind: CategoryKind;
  hue: string | null;
  icon: string | null;
  parentId: string | null;
  parentName: string | null;
  isSubcategory: boolean;
}

export function categoryDetailHeader(db: AppDatabase, categoryId: string): CategoryHeader {
  const row = db
    .select({ id: categories.id, name: categories.name, kind: categories.kind, color: categories.color, icon: categories.icon, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .get();
  if (!row) throw new Error("Unknown category");
  const parent = row.parentId
    ? db.select({ name: categories.name }).from(categories).where(eq(categories.id, row.parentId)).get()
    : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    hue: row.color,
    icon: row.icon,
    parentId: row.parentId,
    parentName: parent?.name ?? null,
    isSubcategory: row.parentId !== null,
  };
}

// ── Monthly trend ────────────────────────────────────────────────────

export interface CategoryMonthPoint {
  month: string;
  spentCents: number;
  txnCount: number;
  href: string;
}

/** Subtree spend per month over the trailing window; click a month → its txns. */
export function categoryMonthlyTrend(
  db: AppDatabase,
  categoryId: string,
  months: number,
  refDate: string,
): CategoryMonthPoint[] {
  return monthKeysBack(refDate, months).map((month) => {
    const from = `${month}-01`;
    const to = periodBounds(from, "monthly").end;
    const { spentCents, txnCount } = categorySpending(db, { categoryId, from, to });
    return { month, spentCents, txnCount, href: ledgerHref({ category: categoryId, from, to }) };
  });
}

// ── Subcategory split ────────────────────────────────────────────────

export interface CategorySubRow {
  categoryId: string;
  name: string;
  /** direction-appropriate flow: money out for expense, money in for income */
  flowCents: number;
  txnCount: number;
  href: string;
}

/** Direct children of a top-level category, by flow (empty for a subcategory). */
export function categorySubcategorySplit(
  db: AppDatabase,
  categoryId: string,
  range: DateRange,
): CategorySubRow[] {
  const idx = loadCategoryIndex(db);
  const node = idx.byId.get(categoryId);
  if (!node) throw new Error("Unknown category");
  const children = [...idx.byId.values()].filter((c) => c.parentId === categoryId);
  if (children.length === 0) return [];

  const inflow = node.kind === "income";
  return children
    .map((child) => {
      const { spentCents, txnCount } = categorySpending(db, { categoryId: child.id, from: range.from, to: range.to });
      // categorySpending returns -sum(amount); for income flip the sign back to money-in
      const flowCents = inflow ? -spentCents : spentCents;
      return {
        categoryId: child.id,
        name: child.name,
        flowCents,
        txnCount,
        href: ledgerHref({ category: child.id, from: range.from, to: range.to }),
      };
    })
    .filter((r) => r.txnCount > 0)
    .sort((a, b) => b.flowCents - a.flowCents || a.name.localeCompare(b.name));
}

// ── Recurring series in this category (closes the Stage-2 chain) ──────

export interface CategorySeriesRow {
  id: string;
  name: string;
  cadence: string;
  amountCents: number;
  nextExpectedOn: string | null;
  status: string;
  isActive: boolean;
  href: string;
}

/**
 * Recurring series whose linked active transactions fall in this category's
 * subtree — the bridge from the Spending tab back to Recurring (§4). A series'
 * category is the category of its linked rows (recurringSeries has no category
 * column), so this is derived from the ledger.
 */
export function seriesInCategory(db: AppDatabase, categoryId: string, today: string): CategorySeriesRow[] {
  const ids = recurringSeriesIdsForCategory(db, categoryId);
  if (ids.size === 0) return [];

  return listSeries(db, today)
    .filter((s) => ids.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      cadence: s.cadence,
      amountCents: s.amountCentsAvg ?? 0,
      nextExpectedOn: s.nextExpectedOn,
      status: s.status,
      isActive: s.isActive,
      href: `/recurring/${s.id}`,
    }));
}

// ── Budget reference ─────────────────────────────────────────────────

export interface CategoryBudgetRef {
  amountCents: number;
  /** banked plan from closed periods; 0 unless the budget opted into rollover */
  rolloverCents: number;
  /** amountCents + rolloverCents — the denominator `remainingCents` is measured from */
  availableCents: number;
  spentCents: number;
  remainingCents: number;
  period: string;
  alert: "none" | "warn80" | "over";
  href: string;
}

/** The active budget targeting THIS exact category, evaluated at refDate. */
export function categoryBudgetRef(db: AppDatabase, categoryId: string, refDate: string): CategoryBudgetRef | null {
  const status = budgetStatuses(db, refDate).find((s) => s.budget.categoryId === categoryId);
  if (!status) return null;
  return {
    amountCents: status.budget.amountCents,
    rolloverCents: status.rolloverCents,
    availableCents: status.availableCents,
    spentCents: status.spentCents,
    remainingCents: status.remainingCents,
    period: status.budget.period,
    alert: status.alert,
    href: "/budgets",
  };
}
