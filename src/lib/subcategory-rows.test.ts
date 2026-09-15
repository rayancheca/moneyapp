import { describe, expect, test } from "vitest";
import { ownRowName, spendingSubcategoryItems, withOwnRow } from "./subcategory-rows";

/**
 * 🔴 S20 — the rule that makes a parent's subcategory rows add up to the parent,
 * given its second caller.
 *
 * `/categories/[id]` learned on 2026-09-10 that a parent's own rows belong in
 * its subcategory list (`categorySubcategorySplit`). `/spending`'s expander
 * never did: it copied `categoryBreakdown`'s children, and those skip every row
 * filed on the parent itself. Measured on the real ledger 2026-09-15,
 * `/spending?period=2026-07`: Travel $2,448.88 over Flights $2,394.89 — the
 * $53.99 filed directly on Travel was in no row. 2025 was the widest: Shopping
 * $3,770.70 over children summing to $1,413.69.
 */

const href = (id: string) => `/categories/${id}?period=2026-07`;

describe("ownRowName", () => {
  test("is the one name both surfaces print", () => {
    expect(ownRowName("Travel")).toBe("On Travel itself");
  });
});

describe("withOwnRow", () => {
  type Row = { categoryId: string; name: string; cents: number; href: string | null };

  test("adds the parent's own row, unlinked, and sorts it among the children by amount", () => {
    const rows = withOwnRow<Row>(
      [
        { categoryId: "flights", name: "Flights", cents: 239_489, href: href("flights") },
        { categoryId: "hotels", name: "Hotels", cents: 1_000, href: href("hotels") },
      ],
      { categoryId: "travel", name: "Travel" },
      { rowCount: 2, fields: { cents: 5_399 } },
      (r) => r.cents,
    );
    expect(rows).toEqual([
      { categoryId: "flights", name: "Flights", cents: 239_489, href: href("flights") },
      { categoryId: "travel", name: "On Travel itself", cents: 5_399, href: null },
      { categoryId: "hotels", name: "Hotels", cents: 1_000, href: href("hotels") },
    ]);
  });

  test("a parent with no rows of its own gets no extra row", () => {
    const rows = withOwnRow<Row>(
      [{ categoryId: "flights", name: "Flights", cents: 100, href: href("flights") }],
      { categoryId: "travel", name: "Travel" },
      { rowCount: 0, fields: { cents: 0 } },
      (r) => r.cents,
    );
    expect(rows.map((r) => r.name)).toEqual(["Flights"]);
  });

  test("ties break by name, so the order does not depend on insertion", () => {
    const rows = withOwnRow<Row>(
      [
        { categoryId: "b", name: "Bravo", cents: 100, href: href("b") },
        { categoryId: "a", name: "Alpha", cents: 100, href: href("a") },
      ],
      { categoryId: "p", name: "Parent" },
      { rowCount: 0, fields: { cents: 0 } },
      (r) => r.cents,
    );
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("spendingSubcategoryItems", () => {
  const travel = {
    categoryId: "travel",
    name: "Travel",
    spentCents: 244_888,
    txnCount: 5,
    ownSpentCents: 5_399,
    ownTxnCount: 2,
    children: [{ categoryId: "flights", name: "Flights", spentCents: 239_489, txnCount: 3 }],
  };

  test("the expanded rows add up to the parent's total", () => {
    const items = spendingSubcategoryItems(travel, href);
    expect(items.reduce((s, i) => s + i.spentCents, 0)).toBe(travel.spentCents);
    expect(items).toEqual([
      { categoryId: "flights", name: "Flights", spentCents: 239_489, href: href("flights") },
      { categoryId: "travel", name: "On Travel itself", spentCents: 5_399, href: null },
    ]);
  });

  test("⛔ own rows but no child rows: no items, so the parent gets no expander listing only itself", () => {
    expect(spendingSubcategoryItems({ ...travel, spentCents: 5_399, children: [] }, href)).toEqual([]);
  });

  test("a net refund on the parent itself still gets its row, at its signed amount", () => {
    const items = spendingSubcategoryItems(
      { ...travel, spentCents: 239_289, ownSpentCents: -200, ownTxnCount: 1 },
      href,
    );
    expect(items.map((i) => [i.name, i.spentCents])).toEqual([
      ["Flights", 239_489],
      ["On Travel itself", -200],
    ]);
    expect(items.reduce((s, i) => s + i.spentCents, 0)).toBe(239_289);
  });

  test("the Uncategorized bucket has no subcategories and no own row", () => {
    expect(
      spendingSubcategoryItems({ ...travel, categoryId: null, name: "Uncategorized", children: [] }, href),
    ).toEqual([]);
  });
});
