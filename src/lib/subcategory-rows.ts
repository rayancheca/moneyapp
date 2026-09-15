import type { BreakdownRow } from "@/services/analytics";

/**
 * A parent category's subcategory list — its children PLUS the rows filed on the
 * parent itself — so the list adds up to the parent's total.
 *
 * 🔴 The rule lived in `categorySubcategorySplit` with one caller. `/categories/[id]`
 * learned it on 2026-09-10 (Travel $2,448.88 over Flights $2,394.89, and the
 * $53.99 filed on Travel itself in no row), and `/spending`'s expander, built
 * from `categoryBreakdown`'s children, never did. Measured on the real ledger
 * 2026-09-15 the same gap stood on `/spending` in every year: 2024 Food $51.38,
 * 2025 Shopping $2,357.01 and Travel $1,707.36, 2026 Shopping $469.84, and
 * `?period=2026-07` Travel $53.99 — the very rows the category page had fixed.
 *
 * Pure and in `lib` (a type-only import erases at build time) so both surfaces
 * import one rule rather than each keeping a copy of it.
 */

/** The name of the row holding what was filed on a parent category itself. */
export function ownRowName(parentName: string): string {
  return `On ${parentName} itself`;
}

/** What every row of a subcategory list carries, whatever its amount is called. */
export interface SubcategoryRowIdentity {
  categoryId: string;
  name: string;
  /**
   * Where the row opens, or null for the parent's own row. ⛔ Never a link: a
   * category filter takes the whole SUBTREE, so a link on it would list every
   * child's rows too — the drill-down contract broken rather than kept.
   */
  href: string | null;
}

/**
 * The children, with the parent's own row added when the parent holds rows of its
 * own, ordered by amount (largest first, ties by name).
 *
 * `own.rowCount` decides whether the row exists; the caller says which rows count,
 * because the two surfaces count them differently (distinct transactions on the
 * category page, split parts in the breakdown). Neither prints a count on it.
 */
export function withOwnRow<Row extends SubcategoryRowIdentity>(
  children: readonly Row[],
  parent: { categoryId: string; name: string },
  own: { rowCount: number; fields: Omit<Row, keyof SubcategoryRowIdentity> },
  amountOf: (row: Row) => number,
): Row[] {
  const ownRow =
    own.rowCount === 0
      ? []
      : [{ ...own.fields, categoryId: parent.categoryId, name: ownRowName(parent.name), href: null } as Row];
  return [...ownRow, ...children].sort((a, b) => amountOf(b) - amountOf(a) || a.name.localeCompare(b.name));
}

/** One row of `/spending`'s expanded subcategory list. */
export interface SubcategoryItem extends SubcategoryRowIdentity {
  /** netted money out, the same frame as the parent's total above it */
  spentCents: number;
}

/**
 * `/spending`'s expander for one breakdown row.
 *
 * ⛔ Empty when the parent has no CHILD rows in the window, even if it has rows of
 * its own: the expander would otherwise open onto a single "On X itself" equal to
 * the parent it sits under. The Uncategorized bucket has no children by
 * construction, so it gets none either.
 */
export function spendingSubcategoryItems(
  row: BreakdownRow,
  hrefFor: (categoryId: string) => string,
): SubcategoryItem[] {
  if (row.categoryId === null || row.children.length === 0) return [];
  return withOwnRow<SubcategoryItem>(
    row.children.map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      spentCents: c.spentCents,
      href: hrefFor(c.categoryId),
    })),
    { categoryId: row.categoryId, name: row.name },
    { rowCount: row.ownTxnCount, fields: { spentCents: row.ownSpentCents } },
    (r) => r.spentCents,
  );
}
