import { describe, expect, it } from "vitest";
import {
  amountRangeLabel,
  categorySelectOptions,
  hasAnyFilter,
  preservedFilterChips,
} from "./FiltersBar";
import { filtersToQuery, type TxnFilters } from "./query";

function filters(overrides: Partial<TxnFilters> = {}): TxnFilters {
  return {
    view: "all",
    account: null,
    category: null,
    merchant: null,
    from: null,
    to: null,
    q: null,
    amountMinCents: null,
    amountMaxCents: null,
    flow: null,
    page: 1,
    ...overrides,
  };
}

describe("hasAnyFilter", () => {
  it("is false for an untouched ledger", () => {
    expect(hasAnyFilter(filters())).toBe(false);
    // the view tab is not a filter — it has its own control
    expect(hasAnyFilter(filters({ view: "excluded", page: 3 }))).toBe(false);
  });

  it("counts the filters that have no control in the bar", () => {
    // regression: these four were ignored, so no Reset appeared to reveal that
    // a merchant/flow/amount drill-down was even applied
    expect(hasAnyFilter(filters({ merchant: "m1" }))).toBe(true);
    expect(hasAnyFilter(filters({ flow: "out" }))).toBe(true);
    expect(hasAnyFilter(filters({ amountMinCents: 1_500 }))).toBe(true);
    expect(hasAnyFilter(filters({ amountMaxCents: 6_000 }))).toBe(true);
    // a zero-cent bound is a real filter, not an absent one
    expect(hasAnyFilter(filters({ amountMinCents: 0 }))).toBe(true);
  });

  it("still counts the filters that do have controls", () => {
    for (const f of [
      filters({ account: "a1" }),
      filters({ category: "c1" }),
      filters({ from: "2026-01-01" }),
      filters({ to: "2026-01-31" }),
      filters({ q: "NETFLIX" }),
    ]) {
      expect(hasAnyFilter(f)).toBe(true);
    }
  });
});

describe("categorySelectOptions", () => {
  const tree = [
    { id: "food", label: "Food & Drink" },
    { id: "coffee", label: "Food & Drink > Coffee" },
  ];

  it("offers the three URL sentinels ahead of the tree", () => {
    expect(categorySelectOptions(null, tree).map((o) => o.id)).toEqual([
      "uncategorized",
      "spending",
      "income",
      "food",
      "coffee",
    ]);
  });

  it("leaves the list alone when the applied value is already in it", () => {
    expect(categorySelectOptions("coffee", tree)).toHaveLength(tree.length + 3);
    expect(categorySelectOptions("spending", tree)).toHaveLength(tree.length + 3);
  });

  it("appends an unknown applied id so the control never claims 'All categories'", () => {
    // the roots-only list a drill-down to a CHILD lands on
    const options = categorySelectOptions("coffee", [{ id: "food", label: "Food & Drink" }]);
    expect(options.at(-1)).toEqual({ id: "coffee", label: "Filtered category" });
  });

  it("keeps a stale bookmarked id selectable (it filters to nothing, honestly)", () => {
    expect(categorySelectOptions("deleted-id", tree).at(-1)?.id).toBe("deleted-id");
  });
});

describe("amountRangeLabel", () => {
  it("reads as a range, a floor, or a ceiling", () => {
    expect(amountRangeLabel(1_500, 6_000)).toBe("$15.00–$60.00");
    expect(amountRangeLabel(1_500, null)).toBe("$15.00+");
    expect(amountRangeLabel(null, 6_000)).toBe("up to $60.00");
  });

  it("is null when unbounded", () => {
    expect(amountRangeLabel(null, null)).toBeNull();
  });

  it("degrades instead of throwing on an absurd hand-typed bound", () => {
    // parseFilters admits any non-negative integer, and formatCents throws
    // outside the safe-integer range — a server render must survive ?amountMin=1e21
    expect(amountRangeLabel(1e21, null)).toBe("1e+21¢+");
  });
});

describe("preservedFilterChips", () => {
  it("is empty when only the filters with controls are applied", () => {
    expect(preservedFilterChips(filters({ account: "a1", q: "NETFLIX" }))).toEqual([]);
  });

  it("names the merchant when the page supplies it, and stays honest when it does not", () => {
    expect(preservedFilterChips(filters({ merchant: "m1" }), "Netflix")[0]!.label).toBe(
      "Merchant: Netflix",
    );
    expect(preservedFilterChips(filters({ merchant: "m1" }))[0]!.label).toBe("One merchant");
  });

  it("labels direction and the amount range", () => {
    const chips = preservedFilterChips(
      filters({ flow: "out", amountMinCents: 1_500, amountMaxCents: 6_000 }),
    );
    expect(chips.map((c) => [c.key, c.label])).toEqual([
      ["flow", "Money out"],
      ["amount", "$15.00–$60.00"],
    ]);
    expect(preservedFilterChips(filters({ flow: "in" }))[0]!.label).toBe("Money in");
  });

  it("clears only its own param — every other filter survives the remove link", () => {
    const applied = filters({
      merchant: "m1",
      flow: "out",
      amountMinCents: 1_500,
      amountMaxCents: 6_000,
      q: "NETFLIX",
      page: 4,
    });
    const byKey = new Map(preservedFilterChips(applied).map((c) => [c.key, c]));

    expect(filtersToQuery(applied, { ...byKey.get("merchant")!.clear, page: 1 })).toBe(
      "?q=NETFLIX&amountMin=1500&amountMax=6000&flow=out",
    );
    expect(filtersToQuery(applied, { ...byKey.get("flow")!.clear, page: 1 })).toBe(
      "?merchant=m1&q=NETFLIX&amountMin=1500&amountMax=6000",
    );
    // one chip covers both bounds — removing it drops the whole magnitude window
    expect(filtersToQuery(applied, { ...byKey.get("amount")!.clear, page: 1 })).toBe(
      "?merchant=m1&q=NETFLIX&flow=out",
    );
  });
});
