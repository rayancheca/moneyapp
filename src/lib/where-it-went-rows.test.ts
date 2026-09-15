import { describe, expect, test } from "vitest";
import { comparedCategories } from "./compared-categories";
import { whereItWentRows } from "./where-it-went-rows";

/**
 * 🔴 THE LIST'S ROWS WERE GUARDED BY HOW THE PAGE WAS SPELLED. /spending built the
 * List's rows and the Table's rows side by side, and the only test on either read
 * the page's source text. Filtering the List back to this period's categories off
 * months (`period.granularity === "month" || compared[i].current !== null`) passed
 * all 15 tests, and is exactly the population the owner's ledger measured wrong on
 * 2026-09-15: 11 of 14 whole quarters, 162 of 205 whole weeks and 815 of 1,448
 * whole days listed fewer rows than the Table — `?period=2026-Q2` 17 against 18,
 * missing Gifts & Donations at -$10.40 against Q1 2026.
 *
 * Both lenses' rows are cut here now, from ONE `comparedCategories`, and this
 * reads the rows themselves.
 */

interface Row {
  categoryId: string | null;
  name: string;
  spentCents: number;
  txnCount: number;
  subs: string[];
}

const row = (categoryId: string | null, name: string, spentCents: number, txnCount: number, subs: string[] = []): Row => ({
  categoryId,
  name,
  spentCents,
  txnCount,
  subs,
});

// the quarters' own figures are illustrative; Gifts & Donations' -$10.40 is the owner's 2026-Q2 against Q1 2026
const Q2 = [
  row("travel", "Travel", 120_000, 9, ["flights"]),
  row("food", "Food", 80_000, 60),
  row("shopping", "Shopping", -2_500, 2),
  row(null, "Uncategorized", 4_000, 2),
];
const Q1 = [
  row("food", "Food", 90_000, 70),
  row("gifts", "Gifts & Donations", 1_040, 1),
  row("travel", "Travel", 40_000, 3),
  row(null, "Uncategorized", 3_000, 1),
];

const META = new Map([
  ["travel", { color: "sky", icon: "plane" }],
  ["gifts", { color: "rose", icon: null }],
]);

const FORECAST = { cents: 36_149, confidence: 0.8, basis: "$361.49 recurring", seasonal: false };

function rowsOf(current: readonly Row[], previous: readonly Row[] | null, forecasts = [] as Parameters<typeof whereItWentRows>[1]["forecasts"]) {
  return whereItWentRows(comparedCategories(current, previous), {
    meta: META,
    // Travel + Food: the positive spends of Q2's categories
    shareBaseCents: 200_000,
    forecasts,
    childrenOf: (r) => r.subs.map((id) => ({ categoryId: id, name: id, spentCents: 100, href: `/categories/${id}` })),
  });
}

describe("whereItWentRows — the List and the Table cut from one population", () => {
  test("on a quarter compared whole the List's rows are the Table's, row for row, the category that stopped included", () => {
    const { list, where } = rowsOf(Q2, Q1);

    expect(list.map((r) => r.categoryId)).toEqual(where.map((r) => r.categoryId));
    expect(new Set(list.map((r) => r.categoryId))).toEqual(new Set(["travel", "food", "shopping", "gifts"]));
    expect(list).toHaveLength(4);

    expect(list.find((r) => r.categoryId === "gifts")).toEqual({
      categoryId: "gifts",
      name: "Gifts & Donations",
      hue: "rose",
      icon: null,
      spentCents: 0,
      sharePct: 0,
      momDeltaCents: -1_040,
      forecast: null,
      children: [],
    });
    expect(where.find((r) => r.categoryId === "gifts")).toEqual({
      categoryId: "gifts",
      name: "Gifts & Donations",
      hue: "rose",
      spentCents: 0,
      priorCents: 1_040,
      txnCount: 0,
    });
  });

  test("each row that spent carries its change against the prior window, its share and its subcategories", () => {
    const { list } = rowsOf(Q2, Q1);
    const byId = new Map(list.map((r) => [r.categoryId, r]));

    expect(byId.get("travel")).toMatchObject({ hue: "sky", icon: "plane", sharePct: 60, momDeltaCents: 80_000 });
    expect(byId.get("travel")!.children.map((c) => c.categoryId)).toEqual(["flights"]);
    expect(byId.get("food")).toMatchObject({ hue: null, icon: null, sharePct: 40, momDeltaCents: -10_000 });
    // a category that netted a refund takes no share, and had nothing in Q1
    expect(byId.get("shopping")).toMatchObject({ spentCents: -2_500, sharePct: 0, momDeltaCents: -2_500 });
  });

  test("with no whole prior window: this period's categories alone, none stopped, no change measured", () => {
    const { list, where } = rowsOf(Q2, null);

    expect(list.map((r) => r.categoryId)).toEqual(["travel", "food", "shopping"]);
    expect(where.map((r) => r.categoryId)).toEqual(["travel", "food", "shopping"]);
    expect(list.every((r) => r.momDeltaCents === 0)).toBe(true);
    // ⛔ null, never 0: a zero is a measurement
    expect(where.every((r) => r.priorCents === null)).toBe(true);
  });

  test("a forecast rides on its category's row, and a forecast-only category follows the compared rows in the List alone", () => {
    const { list, where } = rowsOf(Q2, Q1, [
      { categoryId: "food", label: "Food", forecast: FORECAST },
      { categoryId: "insurance", label: "Insurance", forecast: FORECAST },
    ]);

    expect(list.map((r) => r.categoryId)).toEqual([...where.map((r) => r.categoryId), "insurance"]);
    expect(list.find((r) => r.categoryId === "food")!.forecast).toBe(FORECAST);
    expect(list.find((r) => r.categoryId === "travel")!.forecast).toBeNull();
    // in neither window: no change
    expect(list.at(-1)).toEqual({
      categoryId: "insurance",
      name: "Insurance",
      hue: null,
      icon: null,
      spentCents: 0,
      sharePct: 0,
      momDeltaCents: 0,
      forecast: FORECAST,
      children: [],
    });
  });

  test("with nothing to divide by, no row takes a share", () => {
    const { list } = whereItWentRows(comparedCategories(Q2, Q1), {
      meta: META,
      shareBaseCents: 0,
      forecasts: [],
      childrenOf: () => [],
    });

    expect(list.every((r) => r.sharePct === 0)).toBe(true);
  });
});
