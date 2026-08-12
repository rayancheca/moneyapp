import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import {
  allMoveDestinations,
  archiveCategory,
  createCategory,
  KIND_ORDER,
  listCategoryTree,
  moveCategory,
  moveDestinations,
  renameCategory,
  reorderCategories,
  unarchiveCategory,
} from "./category-edit";

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

describe("createCategory", () => {
  test("creates a top-level expense category with an explicit kind", () => {
    const result = createCategory(bundle.db, { name: "  Car  ", kind: "expense" });
    expect(result.name).toBe("Car");
    expect(result.parentId).toBeNull();
    expect(result.kind).toBe("expense");
    expect(byName("Car")?.id).toBe(result.id);
  });

  test("a child inherits its parent's kind instead of taking one", () => {
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    const child = createCategory(bundle.db, { name: "Car Payment", parentId: car.id });
    expect(child.kind).toBe("expense");
    expect(child.parentId).toBe(car.id);
  });

  test("appends after existing siblings rather than colliding on sortOrder 0", () => {
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    const first = createCategory(bundle.db, { name: "Car Payment", parentId: car.id });
    const second = createCategory(bundle.db, { name: "Car Insurance", parentId: car.id });
    const rowOf = (id: string) => bundle.db.select().from(categories).where(eq(categories.id, id)).get()!;
    expect(rowOf(second.id).sortOrder).toBeGreaterThan(rowOf(first.id).sortOrder);
  });

  test("rejects an empty or whitespace-only name", () => {
    expect(() => createCategory(bundle.db, { name: "   ", kind: "expense" })).toThrow(/cannot be empty/);
  });

  test("rejects a duplicate name among the same siblings", () => {
    expect(() => createCategory(bundle.db, { name: "Food", kind: "expense" })).toThrow(/already exists/);
    const food = byName("Food")!;
    expect(() => createCategory(bundle.db, { name: "Dining", parentId: food.id })).toThrow(/already exists/);
  });

  test("allows the same name under a DIFFERENT parent", () => {
    const food = byName("Food")!;
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    createCategory(bundle.db, { name: "Extras", parentId: food.id });
    expect(() => createCategory(bundle.db, { name: "Extras", parentId: car.id })).not.toThrow();
  });

  test("refuses to nest more than one level deep", () => {
    const food = byName("Food")!;
    const dining = byName("Dining", food.id)!;
    expect(() => createCategory(bundle.db, { name: "Sushi", parentId: dining.id })).toThrow(/one level deep/);
  });

  test("requires a kind for a top-level category", () => {
    expect(() => createCategory(bundle.db, { name: "Car" })).toThrow(/what kind/);
  });

  test("refuses to create transfer or system categories", () => {
    // @ts-expect-error — deliberately outside CreatableCategoryKind
    expect(() => createCategory(bundle.db, { name: "Sneaky", kind: "transfer" })).toThrow(/cannot be created/);
  });

  test("refuses to add a subcategory under a transfer parent", () => {
    const transfers = bundle.db.select().from(categories).where(eq(categories.kind, "transfer")).get()!;
    const root = transfers.parentId === null ? transfers : byName("Transfers")!;
    expect(() => createCategory(bundle.db, { name: "Sneaky", parentId: root.id })).toThrow(/detection depends on them/);
  });
});

describe("archiveCategory", () => {
  test("archives a user-made category and hides it from budgetable pickers", async () => {
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    expect(archiveCategory(bundle.db, car.id).isArchived).toBe(true);
    const { listBudgetableCategories } = await import("./budgets");
    expect(listBudgetableCategories(bundle.db).some((c) => c.id === car.id)).toBe(false);
  });

  test("refuses while a live subcategory remains, and succeeds once it is archived", () => {
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    const child = createCategory(bundle.db, { name: "Car Payment", parentId: car.id });
    expect(() => archiveCategory(bundle.db, car.id)).toThrow(/subcategories first/);
    archiveCategory(bundle.db, child.id);
    expect(() => archiveCategory(bundle.db, car.id)).not.toThrow();
  });

  test("refuses to archive a category imports categorize into", () => {
    const income = byName("Income")!;
    expect(() => archiveCategory(bundle.db, income.id)).toThrow(/stays active/);
  });

  test("never deletes the row — history keeps resolving", () => {
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    archiveCategory(bundle.db, car.id);
    expect(bundle.db.select().from(categories).where(eq(categories.id, car.id)).get()).toBeDefined();
  });

  test("unarchive restores it, but not under an archived parent", () => {
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    const child = createCategory(bundle.db, { name: "Car Payment", parentId: car.id });
    archiveCategory(bundle.db, child.id);
    archiveCategory(bundle.db, car.id);
    expect(() => unarchiveCategory(bundle.db, child.id)).toThrow(/Unarchive "Car" first/);
    unarchiveCategory(bundle.db, car.id);
    expect(unarchiveCategory(bundle.db, child.id).isArchived).toBe(false);
  });
});

describe("reorderCategories", () => {
  /** Root ids of one kind, in the order the manager displays them. */
  function rootsOfKind(kind: string): { id: string; name: string }[] {
    return listCategoryTree(bundle.db)
      .filter((r) => r.kind === kind)
      .map((r) => ({ id: r.id, name: r.name }));
  }

  function sortOrderOf(id: string): number {
    return bundle.db.select().from(categories).where(eq(categories.id, id)).get()!.sortOrder;
  }

  test("moving a root up changes the displayed order and persists it", () => {
    const before = rootsOfKind("expense");
    expect(before.length).toBeGreaterThan(2);
    const moved = [before[1]!, before[0]!, ...before.slice(2)];

    reorderCategories(bundle.db, moved.map((r) => r.id));

    expect(rootsOfKind("expense").map((r) => r.name)).toEqual(moved.map((r) => r.name));
  });

  test("roots are renumbered GLOBALLY, so two kinds never share a sort_order", () => {
    const expense = rootsOfKind("expense");
    reorderCategories(bundle.db, [expense[1]!.id, expense[0]!.id, ...expense.slice(2).map((r) => r.id)]);

    // every root, across every kind, must hold a distinct sort_order — otherwise
    // the readers that sort by sort_order ALONE (the budget form, the transaction
    // category picker, the command index) interleave spending and income by name
    const roots = bundle.db
      .select()
      .from(categories)
      .where(isNull(categories.parentId))
      .all();
    const orders = roots.map((r) => r.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  test("the global renumber keeps kinds grouped in KIND_ORDER", () => {
    const expense = rootsOfKind("expense");
    reorderCategories(bundle.db, [expense[1]!.id, expense[0]!.id, ...expense.slice(2).map((r) => r.id)]);

    const roots = bundle.db
      .select()
      .from(categories)
      .where(isNull(categories.parentId))
      .all()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    // the kind sequence must be non-decreasing in KIND_ORDER terms
    const rank = (k: string) => KIND_ORDER.indexOf(k as (typeof KIND_ORDER)[number]);
    for (let i = 1; i < roots.length; i += 1) {
      expect(rank(roots[i]!.kind)).toBeGreaterThanOrEqual(rank(roots[i - 1]!.kind));
    }
  });

  test("children reorder within their parent only", () => {
    const food = listCategoryTree(bundle.db).find((r) => r.name === "Food")!;
    expect(food.children.length).toBeGreaterThan(1);
    const ids = food.children.map((c) => c.id);
    const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];

    reorderCategories(bundle.db, swapped);

    const after = listCategoryTree(bundle.db).find((r) => r.name === "Food")!;
    expect(after.children.map((c) => c.id)).toEqual(swapped);
  });

  test("a sibling the caller omitted is appended, never dropped", () => {
    const food = listCategoryTree(bundle.db).find((r) => r.name === "Food")!;
    const ids = food.children.map((c) => c.id);
    // the screen was hiding the last child (archived, say) so it never sent it
    reorderCategories(bundle.db, ids.slice(0, -1));

    const after = listCategoryTree(bundle.db).find((r) => r.name === "Food")!;
    expect(after.children.length).toBe(ids.length);
    expect(after.children.at(-1)!.id).toBe(ids.at(-1));
  });

  test("refuses to reorder categories that are not siblings", () => {
    const tree = listCategoryTree(bundle.db);
    const food = tree.find((r) => r.name === "Food")!;
    const housing = tree.find((r) => r.name === "Housing")!;
    expect(() => reorderCategories(bundle.db, [food.children[0]!.id, housing.id])).toThrow(
      /siblings/i,
    );
  });

  test("refuses to mix root kinds, which would break the kind grouping", () => {
    const tree = listCategoryTree(bundle.db);
    const expense = tree.find((r) => r.kind === "expense")!;
    const income = tree.find((r) => r.kind === "income")!;
    expect(() => reorderCategories(bundle.db, [expense.id, income.id])).toThrow(/same kind/i);
  });

  test("an unknown id is rejected before anything is written", () => {
    const expense = rootsOfKind("expense");
    const before = sortOrderOf(expense[0]!.id);
    expect(() => reorderCategories(bundle.db, [expense[0]!.id, "nope"])).toThrow(/Unknown category/);
    expect(sortOrderOf(expense[0]!.id)).toBe(before);
  });
});

describe("allMoveDestinations", () => {
  test("is equivalent to moveDestinations for EVERY category, from one table read", () => {
    // the batch form exists purely for speed (the manager renders ~77 rows and the
    // per-row form re-scans the table each time). Speed is only worth having if
    // the answer is identical, so prove it row by row rather than trusting it.
    const all = bundle.db.select().from(categories).all();
    const batch = allMoveDestinations(bundle.db);
    expect(Object.keys(batch).length).toBe(all.length);
    for (const c of all) {
      expect(batch[c.id]).toEqual(moveDestinations(bundle.db, c.id));
    }
  });
});
