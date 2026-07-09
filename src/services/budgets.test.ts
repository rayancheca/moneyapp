import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { categorySpending } from "./analytics";
import {
  budgetStatuses,
  computeAlert,
  createBudget,
  deactivateBudget,
  listBudgetableCategories,
  totalBudgetedCents,
  updateBudget,
} from "./budgets";

let dir: string;
let bundle: DbBundle;
let cardId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-budgets-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) throw new Error(`missing category ${parentName}`);
  if (!subName) return parent.id;
  const sub = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get();
  if (!sub) throw new Error(`missing category ${pathStr}`);
  return sub.id;
}

let seq = 0;
function spend(postedOn: string, amountCents: number, categoryPath: string): void {
  seq += 1;
  const rawDescription = `SPEND ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId: cardId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId: catId(categoryPath),
      dedupeHash: dedupeHash({
        accountId: cardId,
        postedOn,
        amountCents,
        rawDescription,
        occurrenceIndex: 0,
      }),
    })
    .run();
}

function statusFor(budgetId: string, refDate: string) {
  const status = budgetStatuses(bundle.db, refDate).find((s) => s.budget.id === budgetId);
  if (!status) throw new Error(`budget ${budgetId} missing from statuses`);
  return status;
}

describe("createBudget / updateBudget / deactivateBudget", () => {
  test("creates with a default startsOn and appears in statuses", () => {
    const id = createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 60_000 });
    const status = statusFor(id, "2026-07-15");
    expect(status.budget.amountCents).toBe(60_000);
    expect(status.categoryPath).toBe("Food");
    expect(status.spentCents).toBe(0);
    expect(status.remainingCents).toBe(60_000);
    expect(status.alert).toBe("none");
  });

  test("unique active (category, period) surfaces a clean error; other periods are fine", () => {
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 60_000 });
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 10_000 }),
    ).toThrow(/active monthly budget already exists for Food/);
    // a weekly budget on the same category is a different slot
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Food"), period: "weekly", amountCents: 15_000 }),
    ).not.toThrow();
  });

  test("deactivating frees the (category, period) slot", () => {
    const id = createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 60_000 });
    deactivateBudget(bundle.db, id, "2026-07-15");
    expect(budgetStatuses(bundle.db, "2026-07-15")).toEqual([]);
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 45_000 }),
    ).not.toThrow();
  });

  test("rejects non-expense and unknown categories, and non-positive amounts", () => {
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Income"), period: "monthly", amountCents: 1_000 }),
    ).toThrow(/expense categories only/);
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Transfers"), period: "monthly", amountCents: 1_000 }),
    ).toThrow(/expense categories only/);
    expect(() =>
      createBudget(bundle.db, { categoryId: "nope", period: "monthly", amountCents: 1_000 }),
    ).toThrow(/Unknown category/);
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 0 }),
    ).toThrow();
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: -5 }),
    ).toThrow();
  });

  test("rejects archived categories", () => {
    bundle.db.update(categories).set({ isArchived: true }).where(eq(categories.id, catId("Travel"))).run();
    expect(() =>
      createBudget(bundle.db, { categoryId: catId("Travel"), period: "monthly", amountCents: 1_000 }),
    ).toThrow(/archived/);
  });

  test("updateBudget changes the amount; period change into a taken slot errors cleanly", () => {
    const a = createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 60_000 });
    createBudget(bundle.db, { categoryId: catId("Food"), period: "weekly", amountCents: 15_000 });
    updateBudget(bundle.db, a, { amountCents: 70_000 });
    expect(statusFor(a, "2026-07-15").budget.amountCents).toBe(70_000);
    expect(() => updateBudget(bundle.db, a, { period: "weekly" })).toThrow(/already exists/);
    expect(() => updateBudget(bundle.db, "nope", { amountCents: 1 })).toThrow(/Unknown budget/);
  });
});

describe("budgetStatuses — period bounds across month/year boundaries (fixed oracles)", () => {
  test("weekly budget on 2024-12-31 spans the ISO week 2024-12-30..2025-01-05", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "weekly",
      amountCents: 20_000,
      startsOn: "2024-01-01",
    });
    spend("2024-12-29", -5_000, "Food > Dining"); // Sunday before — outside
    spend("2024-12-30", -3_000, "Food > Dining"); // Monday — inside
    spend("2025-01-05", -4_000, "Food > Groceries"); // Sunday — inside
    spend("2025-01-06", -6_000, "Food > Dining"); // next Monday — outside

    const status = statusFor(id, "2024-12-31");
    expect(status.bounds).toEqual({ start: "2024-12-30", end: "2025-01-05" });
    expect(status.spentCents).toBe(7_000);
    expect(status.remainingCents).toBe(13_000);
  });

  test("monthly budget in a leap February spans 02-01..02-29", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 50_000,
      startsOn: "2024-01-01",
    });
    spend("2024-01-31", -1_000, "Food > Dining"); // outside
    spend("2024-02-01", -2_000, "Food > Dining"); // inside
    spend("2024-02-29", -3_000, "Food > Dining"); // leap day — inside
    spend("2024-03-01", -4_000, "Food > Dining"); // outside

    const status = statusFor(id, "2024-02-15");
    expect(status.bounds).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(status.spentCents).toBe(5_000);
  });

  test("daily budget counts only the refDate's transactions", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "daily",
      amountCents: 3_000,
      startsOn: "2024-01-01",
    });
    spend("2024-12-30", -1_000, "Food > Coffee");
    spend("2024-12-31", -1_500, "Food > Coffee");
    spend("2025-01-01", -2_000, "Food > Coffee");

    const status = statusFor(id, "2024-12-31");
    expect(status.bounds).toEqual({ start: "2024-12-31", end: "2024-12-31" });
    expect(status.spentCents).toBe(1_500);
  });

  test("annual budget spans the calendar year exactly", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Travel"),
      period: "annual",
      amountCents: 300_000,
      startsOn: "2024-01-01",
    });
    spend("2023-12-31", -10_000, "Travel > Flights"); // outside
    spend("2024-01-01", -40_000, "Travel > Flights"); // inside
    spend("2024-12-31", -25_000, "Travel > Hotels"); // inside
    spend("2025-01-01", -30_000, "Travel > Flights"); // outside

    const status = statusFor(id, "2024-06-15");
    expect(status.bounds).toEqual({ start: "2024-01-01", end: "2024-12-31" });
    expect(status.spentCents).toBe(65_000);
  });
});

describe("parent/child overlap semantics", () => {
  test("child spend counts toward the parent's budget AND its own; totals never double-count", () => {
    const parent = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 60_000,
      startsOn: "2026-07-01",
    });
    const child = createBudget(bundle.db, {
      categoryId: catId("Food > Dining"),
      period: "monthly",
      amountCents: 20_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-03", -12_000, "Food > Dining");
    spend("2026-07-05", -8_000, "Food > Groceries");

    const statuses = budgetStatuses(bundle.db, "2026-07-15");
    const parentStatus = statuses.find((s) => s.budget.id === parent)!;
    const childStatus = statuses.find((s) => s.budget.id === child)!;

    expect(parentStatus.spentCents).toBe(20_000); // Dining + Groceries roll up
    expect(childStatus.spentCents).toBe(12_000); // Dining counts toward its own too
    expect(childStatus.categoryPath).toBe("Food > Dining");
    expect(parentStatus.isDescendantOfBudgeted).toBe(false);
    expect(childStatus.isDescendantOfBudgeted).toBe(true);
    // total budgeted excludes the descendant's 20_000 (schema.md overlap semantics)
    expect(totalBudgetedCents(statuses)).toBe(60_000);
  });

  test("a subcategory budget without a budgeted ancestor counts in totals", () => {
    createBudget(bundle.db, {
      categoryId: catId("Food > Dining"),
      period: "monthly",
      amountCents: 20_000,
    });
    const statuses = budgetStatuses(bundle.db, "2026-07-15");
    expect(statuses[0]?.isDescendantOfBudgeted).toBe(false);
    expect(totalBudgetedCents(statuses)).toBe(20_000);
  });
});

describe("alert thresholds — integer math, exact at the boundaries", () => {
  test("computeAlert at exactly 80% and 100%", () => {
    expect(computeAlert(7_999, 10_000)).toBe("none"); // one cent under 80%
    expect(computeAlert(8_000, 10_000)).toBe("warn80"); // exactly 80%
    expect(computeAlert(9_999, 10_000)).toBe("warn80"); // one cent under 100%
    expect(computeAlert(10_000, 10_000)).toBe("over"); // exactly 100%
    expect(computeAlert(10_001, 10_000)).toBe("over");
    expect(computeAlert(0, 10_000)).toBe("none");
    expect(computeAlert(-500, 10_000)).toBe("none"); // net refund month
  });

  test("statuses carry the alert end-to-end", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-02", -8_000, "Food > Dining");
    expect(statusFor(id, "2026-07-15").alert).toBe("warn80");
    spend("2026-07-03", -2_000, "Food > Groceries");
    const status = statusFor(id, "2026-07-15");
    expect(status.alert).toBe("over");
    expect(status.remainingCents).toBe(0);
    spend("2026-07-04", -1, "Food > Coffee");
    expect(statusFor(id, "2026-07-15").remainingCents).toBe(-1); // overrun visible
  });
});

describe("budget actuals match Phase 4 analytics exactly", () => {
  test("spentCents equals categorySpending for the identical bounds", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 60_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-03", -12_345, "Food > Dining");
    spend("2026-07-08", -6_789, "Food > Groceries");
    spend("2026-07-09", 1_000, "Food > Groceries"); // refund nets in both places

    const status = statusFor(id, "2026-07-15");
    const analytics = categorySpending(bundle.db, {
      categoryId: catId("Food"),
      from: status.bounds.start,
      to: status.bounds.end,
    });
    expect(status.spentCents).toBe(analytics.spentCents);
    expect(status.spentCents).toBe(18_134);
  });
});

describe("listBudgetableCategories", () => {
  test("returns non-archived expense categories in tree order with depth", () => {
    bundle.db.update(categories).set({ isArchived: true }).where(eq(categories.id, catId("Travel"))).run();
    const list = listBudgetableCategories(bundle.db);

    expect(list.some((c) => c.name === "Travel")).toBe(false);
    expect(list.some((c) => c.name === "Income")).toBe(false);
    expect(list.some((c) => c.name === "Transfers")).toBe(false);
    expect(list.some((c) => c.name === "Uncategorized")).toBe(false);

    const foodIdx = list.findIndex((c) => c.name === "Food" && c.depth === 0);
    const diningIdx = list.findIndex((c) => c.name === "Dining");
    expect(foodIdx).toBeGreaterThanOrEqual(0);
    expect(diningIdx).toBeGreaterThan(foodIdx);
    expect(list[diningIdx]).toEqual({ id: catId("Food > Dining"), name: "Dining", depth: 1, parentName: "Food" });
  });
});
