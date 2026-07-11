import { describe, expect, test } from "vitest";
import { groupContiguous, paletteSearch, type PaletteItem } from "./palette-search";

function item(id: string, label: string, keywords?: string[]): PaletteItem {
  return { id, label, keywords, group: "test" };
}

function ids(results: PaletteItem[]): string[] {
  return results.map((r) => r.id);
}

describe("empty query", () => {
  const items = [item("a", "Dashboard"), item("b", "Accounts"), item("c", "Transactions")];

  test("returns the first `limit` items in original order", () => {
    expect(ids(paletteSearch(items, "", 2))).toEqual(["a", "b"]);
  });

  test("whitespace-only query counts as empty", () => {
    expect(ids(paletteSearch(items, "   ", 2))).toEqual(["a", "b"]);
  });

  test("default limit is 12", () => {
    const many = Array.from({ length: 15 }, (_, i) => item(`i${i}`, `Item ${i}`));
    expect(paletteSearch(many, "")).toHaveLength(12);
  });
});

describe("ranking tiers", () => {
  test("label prefix > word-boundary prefix > substring > keyword substring", () => {
    const items = [
      item("keyword", "Move money", ["transfer"]),
      item("substring", "Extras"),
      item("word", "All Transactions"),
      item("prefix", "Transactions"),
    ];
    expect(ids(paletteSearch(items, "tra"))).toEqual(["prefix", "word", "substring", "keyword"]);
  });

  test("stable within a tier by original order", () => {
    const items = [
      item("first", "Budget: Food"),
      item("second", "Budget: Fuel"),
      item("third", "Budgets"),
    ];
    expect(ids(paletteSearch(items, "budget"))).toEqual(["first", "second", "third"]);
  });

  test("non-matching items are excluded entirely", () => {
    const items = [item("a", "Dashboard"), item("b", "Spending", ["charts"])];
    expect(paletteSearch(items, "zzz")).toEqual([]);
  });

  test("limit truncates ranked results", () => {
    const items = [
      item("sub", "Unsettled"),
      item("pre", "Settings"),
      item("word", "App Settings"),
    ];
    expect(ids(paletteSearch(items, "sett", 2))).toEqual(["pre", "word"]);
  });
});

describe("case and diacritic folding", () => {
  test("matching is case-insensitive", () => {
    const items = [item("a", "transactions")];
    expect(ids(paletteSearch(items, "TRA"))).toEqual(["a"]);
  });

  test("diacritics in the label fold away", () => {
    const items = [item("a", "Café Rouge")];
    expect(ids(paletteSearch(items, "cafe"))).toEqual(["a"]);
  });

  test("diacritics in the query fold away", () => {
    const items = [item("a", "Cafeteria")];
    expect(ids(paletteSearch(items, "café"))).toEqual(["a"]);
  });

  test("diacritics in keywords fold away", () => {
    const items = [item("a", "Dining out", ["café"])];
    expect(ids(paletteSearch(items, "cafe"))).toEqual(["a"]);
  });
});

describe("keywords", () => {
  test("keyword substring matches when the label does not", () => {
    const items = [item("a", "Recurring", ["subscriptions", "bills"])];
    expect(ids(paletteSearch(items, "bill"))).toEqual(["a"]);
  });

  test("items without keywords never reach the keyword tier", () => {
    const items = [item("a", "Recurring")];
    expect(paletteSearch(items, "bill")).toEqual([]);
  });

  test("keywords that do not match exclude the item", () => {
    const items = [item("a", "Recurring", ["subscriptions"])];
    expect(paletteSearch(items, "bill")).toEqual([]);
  });
});

describe("word-boundary detail", () => {
  test("punctuation and digits participate in word splitting", () => {
    const items = [item("a", "Budget: 2026 review")];
    expect(ids(paletteSearch(items, "rev"))).toEqual(["a"]);
    expect(ids(paletteSearch(items, "2026"))).toEqual(["a"]);
  });

  test("mid-word text is substring tier, not word tier", () => {
    const items = [
      item("mid", "Repayments"),
      item("word", "Auto Pay"),
    ];
    expect(ids(paletteSearch(items, "pay"))).toEqual(["word", "mid"]);
  });
});

describe("groupContiguous", () => {
  const item = (id: string, group: string) => ({ id, label: id, group });

  test("makes each group's items contiguous, preserving first-appearance order", () => {
    // tier-interleaved input: Accounts, Categories, Accounts, Merchants
    const input = [item("a1", "Accounts"), item("c1", "Categories"), item("a2", "Accounts"), item("m1", "Merchants")];
    const out = groupContiguous(input);
    expect(out.map((i) => i.id)).toEqual(["a1", "a2", "c1", "m1"]);
    // group order = first appearance; items keep their relative order within
    expect(out.map((i) => i.group)).toEqual(["Accounts", "Accounts", "Categories", "Merchants"]);
  });

  test("is a no-op for already-contiguous or empty input", () => {
    expect(groupContiguous([])).toEqual([]);
    const contiguous = [item("a1", "Accounts"), item("a2", "Accounts"), item("m1", "Merchants")];
    expect(groupContiguous(contiguous).map((i) => i.id)).toEqual(["a1", "a2", "m1"]);
  });
});
