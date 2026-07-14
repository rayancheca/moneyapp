import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { moveCategory, renameCategory } from "./category-edit";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-catedit-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function byName(name: string, parentId: string | null = null) {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId)))
    .get();
}

describe("renameCategory", () => {
  test("renames an expense category and trims whitespace", () => {
    const food = byName("Food")!;
    const result = renameCategory(bundle.db, food.id, "  Munchies  ");
    expect(result).toEqual({ id: food.id, name: "Munchies" });
    expect(byName("Munchies")?.id).toBe(food.id);
  });

  test("renaming to the current name is a no-op, not a clash", () => {
    const food = byName("Food")!;
    expect(renameCategory(bundle.db, food.id, "Food").name).toBe("Food");
  });

  test("rejects empty and unknown", () => {
    const food = byName("Food")!;
    expect(() => renameCategory(bundle.db, food.id, "   ")).toThrow(/cannot be empty/);
    expect(() => renameCategory(bundle.db, "nope", "X")).toThrow(/Unknown category/);
  });

  test("blocks transfer-kind categories — detection matches on their names", () => {
    const transfers = byName("Transfers")!;
    expect(() => renameCategory(bundle.db, transfers.id, "Moves")).toThrow(/keep their names/);
    const sub = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.parentId, transfers.id))
      .all()[0]!;
    expect(() => renameCategory(bundle.db, sub.id, "Card Pay")).toThrow(/keep their names/);
  });

  test("rejects a sibling name clash at root and within a parent", () => {
    const food = byName("Food")!;
    const income = byName("Income")!;
    expect(() => renameCategory(bundle.db, food.id, "Income")).toThrow(/already exists/);

    // Salary is not an import-hint name, so the SIBLING-CLASH guard is what fires
    const salary = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.parentId, income.id), eq(categories.name, "Salary")))
      .get()!;
    expect(() => renameCategory(bundle.db, salary.id, "Dividends")).toThrow(/already exists/);
  });

  test("the same name is allowed under a different parent", () => {
    const income = byName("Income")!;
    const food = byName("Food")!;
    const foodSub = bundle.db.select().from(categories).where(eq(categories.parentId, food.id)).all()[0]!;
    const incomeSub = bundle.db.select().from(categories).where(eq(categories.parentId, income.id)).all()[0]!;
    // give the food child the income child's name — different parents, no clash
    const renamed = renameCategory(bundle.db, foodSub.id, incomeSub.name);
    expect(renamed.name).toBe(incomeSub.name);
  });
});

describe("import-hint name guard", () => {
  test("blocks the hinted roots and paths imports resolve by name", () => {
    const income = byName("Income")!;
    expect(() => renameCategory(bundle.db, income.id, "Cash In")).toThrow(/auto-categorize by this name/);
    const interest = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.parentId, income.id), eq(categories.name, "Interest")))
      .get()!;
    expect(() => renameCategory(bundle.db, interest.id, "Yield")).toThrow(/auto-categorize by this name/);
  });

  test("non-hinted siblings under a hinted root still rename freely", () => {
    const income = byName("Income")!;
    const salary = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.parentId, income.id), eq(categories.name, "Salary")))
      .get()!;
    expect(renameCategory(bundle.db, salary.id, "Wages").name).toBe("Wages");
  });
});

describe("moveCategory (S7)", () => {
  test("a subcategory moves to another same-kind root, and to top level", () => {
    const food = byName("Food")!;
    const shopping = byName("Shopping")!;
    const dining = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.parentId, food.id), eq(categories.name, "Dining")))
      .get()!;

    expect(moveCategory(bundle.db, dining.id, shopping.id).parentId).toBe(shopping.id);
    expect(moveCategory(bundle.db, dining.id, null).parentId).toBeNull();
  });

  test("guards: depth, kind, self, clash, hints, transfer", () => {
    const food = byName("Food")!;
    const income = byName("Income")!;
    const transfers = byName("Transfers")!;
    const dining = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.parentId, food.id), eq(categories.name, "Dining")))
      .get()!;

    // a root WITH children cannot become a child
    expect(() => moveCategory(bundle.db, food.id, byName("Shopping")!.id)).toThrow(/one level deep/);
    // cross-kind move blocked (expense → income)
    expect(() => moveCategory(bundle.db, dining.id, income.id)).toThrow(/same kind/);
    // self-parenting blocked
    expect(() => moveCategory(bundle.db, dining.id, dining.id)).toThrow(/under itself/);
    // hint-protected categories stay put
    const interest = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.parentId, income.id), eq(categories.name, "Interest")))
      .get()!;
    expect(() => moveCategory(bundle.db, interest.id, null)).toThrow(/auto-categorize/);
    // transfer kind blocked
    expect(() => moveCategory(bundle.db, transfers.id, null)).toThrow(/stay put/);
    // destination sibling clash: make a root named Dining, then try moving the sub to top level
    renameCategory(bundle.db, byName("Personal Care")!.id, "Dining");
    expect(() => moveCategory(bundle.db, dining.id, null)).toThrow(/already exists/);
    // moving to the current parent is a no-op
    expect(moveCategory(bundle.db, dining.id, food.id).parentId).toBe(food.id);
  });
});
