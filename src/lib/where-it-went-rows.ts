import type { WhereItWentRow } from "@/components/charts/CategoryMassif";
import type {
  CategoryForecastAnnotation,
  CategoryTableChild,
  CategoryTableRow,
} from "@/components/spending/SpendingCategoriesTable";
import type { ComparedCategory } from "./compared-categories";
import type { DeviationSourceRow } from "./deviation-layout";

/**
 * The rows /spending's "Where it went" hands its lenses — the List's, and the
 * relief's and the Table's — cut from ONE `comparedCategories` in one place.
 *
 * 🔴 The page built the List's rows beside the Table's, and the only test on
 * either read the page's source text. A one-line filter of the List back to this
 * period's categories off months passed all 15 tests, and it is exactly the
 * population measured wrong on the owner's ledger 2026-09-15: 11 of 14 whole
 * quarters, 162 of 205 whole weeks and 815 of 1,448 whole days listed fewer rows
 * than the Table — `?period=2026-Q2` 17 against 18, missing Gifts & Donations at
 * -$10.40 against Q1 2026.
 *
 * ⛔ The List's categorized rows ARE the Table's, in the same order, whatever the
 * period's granularity: a whole comparison brings the categories that stopped, a
 * clipped or refused one this period's alone — `comparedCategories` owns both.
 * The List adds only the forecast-only rows after them, which were in neither
 * window and so are in no Table row.
 */

/** A confident next-month forecast for one category (the /budgets prediction engine). */
export interface ForecastedCategory {
  categoryId: string;
  label: string;
  forecast: CategoryForecastAnnotation;
}

export function whereItWentRows<Row extends DeviationSourceRow>(
  compared: readonly ComparedCategory<Row>[],
  context: {
    /** each category's hue and icon, by id */
    meta: ReadonlyMap<string, { color: string | null; icon: string | null }>;
    /** the share denominator — `spendingShareBase` over this period's categories */
    shareBaseCents: number;
    /** confident forecasts only, in the engine's order */
    forecasts: readonly ForecastedCategory[];
    /** a category's expanded rows, from this period's breakdown row */
    childrenOf: (current: Row) => CategoryTableChild[];
  },
): { list: CategoryTableRow[]; where: WhereItWentRow[] } {
  const { meta, shareBaseCents, forecasts, childrenOf } = context;
  const forecastById = new Map(forecasts.map((f) => [f.categoryId, f.forecast]));

  const comparedRows: CategoryTableRow[] = compared.map((c) => ({
    categoryId: c.categoryId,
    name: c.name,
    hue: meta.get(c.categoryId)?.color ?? null,
    icon: meta.get(c.categoryId)?.icon ?? null,
    spentCents: c.spentCents,
    sharePct: shareBaseCents > 0 ? (Math.max(0, c.spentCents) / shareBaseCents) * 100 : 0,
    momDeltaCents: c.priorCents === null ? 0 : c.spentCents - c.priorCents,
    // no breakdown row this period: it is here for the prior window's entries
    stopped: c.current === null,
    forecast: forecastById.get(c.categoryId) ?? null,
    // a category with no row this period has no children in it either
    children: c.current === null ? [] : childrenOf(c.current),
  }));

  const shown = new Set(compared.map((c) => c.categoryId));
  const upcomingRows: CategoryTableRow[] = forecasts
    .filter((f) => !shown.has(f.categoryId))
    .map((f) => ({
      categoryId: f.categoryId,
      name: f.label,
      hue: meta.get(f.categoryId)?.color ?? null,
      icon: meta.get(f.categoryId)?.icon ?? null,
      spentCents: 0,
      sharePct: 0,
      momDeltaCents: 0,
      stopped: false,
      forecast: f.forecast,
      children: [],
    }));

  const where: WhereItWentRow[] = compared.map((c) => ({
    categoryId: c.categoryId,
    name: c.name,
    hue: meta.get(c.categoryId)?.color ?? null,
    spentCents: c.spentCents,
    // ⛔ null, never 0, when there is no comparable prior window: a zero is a
    // measurement, and every block would rise by its whole spend
    priorCents: c.priorCents,
    txnCount: c.txnCount,
  }));

  return { list: [...comparedRows, ...upcomingRows], where };
}
