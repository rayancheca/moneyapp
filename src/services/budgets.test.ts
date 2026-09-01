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
import { levelledMonthlyCents } from "@/lib/income-basis";
import { recurringSeries } from "@/db/schema/recurring";
import type { Cadence, SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import { createAccount } from "./accounts";
import { categorySpending, recurringSeriesIdsForCategory } from "./analytics";
import {
  budgetGuidanceCents,
  budgetPaceStatuses,
  budgetSections,
  budgetStatuses,
  budgetOverdue,
  budgetTail,
  computeAlert,
  computePace,
  carryInto,
  createBudget,
  deactivateBudget,
  setBudgetRollover,
  hasOverlappingChildBudget,
  listBudgetableCategories,
  incomeExpectation,
  projectSpend,
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

function createSeries(opts: {
  name: string;
  nextExpectedOn: string;
  nextExpectedAmountCents: number;
  kind?: SeriesKind;
  cadence?: Cadence;
  intervalDaysAvg?: number;
  status?: SeriesStatus;
  /** omit to mirror nextExpectedOn; null = a commitment that has never posted */
  lastMatchedOn?: string | null;
}): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind ?? "bill",
      cadence: opts.cadence ?? "monthly",
      intervalDaysAvg: opts.intervalDaysAvg ?? 30,
      amountCentsAvg: opts.nextExpectedAmountCents,
      nextExpectedOn: opts.nextExpectedOn,
      nextExpectedAmountCents: opts.nextExpectedAmountCents,
      status: opts.status ?? "confirmed",
      lastMatchedOn: opts.lastMatchedOn === undefined ? opts.nextExpectedOn : opts.lastMatchedOn,
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

/** Bind a series to a category without any posted row — migration 0010's case. */
function bindSeries(seriesId: string, categoryPath: string): void {
  bundle.db
    .update(recurringSeries)
    .set({ userCategoryId: catId(categoryPath) })
    .where(eq(recurringSeries.id, seriesId))
    .run();
}

/** A spend row linked to a recurring series (and optionally superseded). */
function spendLinked(
  postedOn: string,
  amountCents: number,
  categoryPath: string,
  seriesId: string,
  status: "active" | "superseded" = "active",
): void {
  seq += 1;
  const rawDescription = `LINKED ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId: cardId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId: catId(categoryPath),
      recurringSeriesId: seriesId,
      status,
      dedupeHash: dedupeHash({ accountId: cardId, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
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

describe("budgetStatuses — startsOn clamps the graded window", () => {
  test("a budget created mid-period is graded only on spend from startsOn onward", () => {
    spend("2026-07-03", -240_000, "Food > Dining"); // the month's damage, done before the budget existed
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 5_000,
      startsOn: "2026-07-27",
    });
    spend("2026-07-28", -1_000, "Food > Coffee");

    const status = statusFor(id, "2026-07-28");
    expect(status.bounds).toEqual({ start: "2026-07-27", end: "2026-07-31" }); // start clamped, end untouched
    expect(status.partialPeriod).toBe(true);
    expect(status.spentCents).toBe(1_000); // NOT 241_000
    expect(status.remainingCents).toBe(4_000);
    expect(status.pct).toBeCloseTo(0.2, 10);
    expect(status.alert).toBe("none"); // day one never opens at "over budget by 4798%"
  });

  test("partialPeriod is true exactly when the clamp moves the start", () => {
    const onStart = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 60_000,
      startsOn: "2026-07-01", // exactly the period start — nothing to clamp
    });
    const older = createBudget(bundle.db, {
      categoryId: catId("Travel"),
      period: "monthly",
      amountCents: 30_000,
      startsOn: "2026-01-15", // long-running budget, whole period is its own
    });
    const mid = createBudget(bundle.db, {
      categoryId: catId("Shopping"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-02", // one day in — the clamp bites
    });

    expect(statusFor(onStart, "2026-07-15").partialPeriod).toBe(false);
    expect(statusFor(onStart, "2026-07-15").bounds).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(statusFor(older, "2026-07-15").partialPeriod).toBe(false);
    expect(statusFor(older, "2026-07-15").bounds).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(statusFor(mid, "2026-07-15").partialPeriod).toBe(true);
    expect(statusFor(mid, "2026-07-15").bounds).toEqual({ start: "2026-07-02", end: "2026-07-31" });
  });

  test("the clamp applies to any period kind — a weekly budget started mid-week", () => {
    spend("2026-07-06", -4_000, "Food > Dining"); // Monday, before the budget
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "weekly",
      amountCents: 5_000,
      startsOn: "2026-07-08", // Wednesday of the ISO week 07-06..07-12
    });
    spend("2026-07-09", -1_500, "Food > Coffee");

    const status = statusFor(id, "2026-07-09");
    expect(status.bounds).toEqual({ start: "2026-07-08", end: "2026-07-12" });
    expect(status.partialPeriod).toBe(true);
    expect(status.spentCents).toBe(1_500);
  });

  test("pace measures the budget's own life inside the period, not the whole period", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 20_000,
      startsOn: "2026-07-25",
    });
    spend("2026-07-03", -100_000, "Food > Dining"); // pre-budget, invisible to it
    spend("2026-07-26", -2_000, "Food > Coffee");

    const status = budgetPaceStatuses(bundle.db, "2026-07-28").find((s) => s.budget.id === id)!;
    expect(status.totalDays).toBe(7); // 07-25..07-31
    expect(status.elapsedDays).toBe(4); // 07-25..07-28
    expect(status.elapsedFraction).toBeCloseTo(4 / 7, 10);
    expect(status.spentCents).toBe(2_000);
    // variable remainder = round(2_000 × 3/4) = 1_500 → projected 3_500
    expect(status.projectedCents).toBe(3_500);
    expect(status.pace).toBe("under");
  });

  test("a future-dated budget has not opened yet — no spend, no elapsed days, no divide-by-zero", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 20_000,
      startsOn: "2026-07-25",
    });
    spend("2026-07-10", -9_000, "Food > Dining");

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.partialPeriod).toBe(true);
    expect(status.spentCents).toBe(0);
    expect(status.totalDays).toBe(7);
    expect(status.elapsedDays).toBe(0);
    expect(status.elapsedFraction).toBe(0);
    expect(status.projectedCents).toBe(0);
    expect(status.pace).toBe("under");
  });

  test("the expected tail starts at startsOn — a bill due before the budget began is not projected onto it", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Housing"),
      period: "monthly",
      amountCents: 200_000,
      startsOn: "2026-07-25",
    });
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -180_000 });
    spendLinked("2026-06-20", -180_000, "Housing > Rent", rent); // maps the series to Housing

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.expectedTailCents).toBe(0); // 07-20 falls before the budget's window
    expect(status.tail).toEqual([]);
  });

  /*
   * ⛔ THE TAIL AND THE OVERDUE WINDOW ABUT, AND A BUDGET CREATED TODAY IS THE
   * ONLY SHAPE THAT CAN SHOW IT.
   *
   * `tailFrom` is `refDate` normally, and `startsOn − 1` for a budget that
   * opens LATER in the period, so `budgetTail`'s strictly-after-anchor window
   * begins exactly on `startsOn`. When the budget opens TODAY the two readings
   * collide: relaxing `start > refDate` to `>=` anchors a day early and the
   * tail opens on today — the same day the overdue leg already owns.
   *
   * Found by mutation; no fixture had a budget whose clamped start equalled the
   * reference day. The cost is a doubled projection on a budget's first day,
   * and `pace` is graded from that projection, so a brand-new budget could open
   * at "at-risk" over a bill that exists once.
   */
  test("a budget created TODAY does not project today's unpaid bill twice", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Housing"),
      period: "monthly",
      amountCents: 200_000,
      startsOn: "2026-07-08", // today
    });
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-08", nextExpectedAmountCents: -12_500 });
    spendLinked("2026-06-08", -12_500, "Housing > Rent", rent); // maps the series to Housing, last month

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    // today's unpaid bill belongs to the OVERDUE leg…
    expect(status.overdueCents).toBe(12_500);
    // …so the forward tail, which opens strictly after today, holds nothing
    expect(status.expectedTailCents).toBe(0);
    expect(status.tail).toEqual([]);
    // and the projection counts it exactly once
    expect(status.projectedCents).toBe(12_500);
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

  test("a child budgeted in a DIFFERENT period than its parent is not dropped from its own period total", () => {
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 100_000,
      startsOn: "2026-07-01",
    });
    createBudget(bundle.db, {
      categoryId: catId("Food > Dining"),
      period: "weekly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    const statuses = budgetStatuses(bundle.db, "2026-07-15");
    const monthly = statuses.filter((s) => s.budget.period === "monthly");
    const weekly = statuses.filter((s) => s.budget.period === "weekly");

    // per period (how the page totals): Dining's parent is budgeted MONTHLY, never
    // summed with the weekly section, so the weekly total keeps its full 10k and
    // shows no "overlap excluded" note.
    expect(totalBudgetedCents(monthly)).toBe(100_000);
    expect(totalBudgetedCents(weekly)).toBe(10_000);
    expect(hasOverlappingChildBudget(weekly)).toBe(false);
    expect(hasOverlappingChildBudget(monthly)).toBe(false);

    // summed into ONE set, the same-set double-count rule DOES exclude the child
    expect(totalBudgetedCents(statuses)).toBe(100_000);
    expect(hasOverlappingChildBudget(statuses)).toBe(true);
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

// ── §8 pace, projection, tail, guidance ──────────────────────────────

describe("computePace — green→amber→red by projected pace", () => {
  test("over the moment spend meets budget; amber when only the projection overruns", () => {
    expect(computePace(10_000, 10_000, 10_000)).toBe("over"); // spent == budget
    expect(computePace(10_001, 20_000, 10_000)).toBe("over"); // spent past budget dominates
    expect(computePace(5_000, 12_000, 10_000)).toBe("at-risk"); // projection lands over
    expect(computePace(5_000, 10_000, 10_000)).toBe("at-risk"); // projection exactly at budget
    expect(computePace(5_000, 8_000, 10_000)).toBe("under"); // projected to finish under
    expect(computePace(0, 0, 10_000)).toBe("under");
  });
});

describe("projectSpend — the components ARE the math, no double count", () => {
  const base = { recurringPostedCents: 0, expectedTailCents: 0, elapsedDays: 10, totalDays: 30 };

  test("linearly extrapolates variable spend across the remaining days", () => {
    expect(projectSpend({ ...base, spentCents: 10_000 })).toBe(30_000); // 10k in 10/30 days → 30k
  });

  test("recurring already posted is NOT extrapolated (no double count with its tail)", () => {
    // 6k rent posted + 4k variable in 10 days; only the 4k variable extends
    expect(projectSpend({ ...base, spentCents: 10_000, recurringPostedCents: 6_000 })).toBe(18_000);
  });

  test("the tail is added exactly once, never smeared by pace", () => {
    // all 6k spent is recurring; the 1.8k tail is added flat, variable remainder is 0
    expect(
      projectSpend({ ...base, spentCents: 6_000, recurringPostedCents: 6_000, expectedTailCents: 1_800 }),
    ).toBe(7_800);
  });

  test("a net-refund month never projects below what is already spent", () => {
    expect(projectSpend({ ...base, spentCents: -500 })).toBe(-500);
  });

  test("a single charge bigger than the whole budget is an event, not a rate", () => {
    // the $5,000-car-deposit shape: without the guard this extrapolates to a
    // number many multiples of the budget and makes the page untrustworthy.
    const oneOff = { ...base, spentCents: 500_000, elapsedDays: 1, totalDays: 21 };
    expect(projectSpend(oneOff)).toBe(500_000 + 500_000 * 20); // 5000 x 20/1 — absurd
    // excluded from the RATE, still counted as spent, so the row stays over budget
    expect(projectSpend({ ...oneOff, oneOffCents: 500_000 })).toBe(500_000);
  });

  test("ordinary spend alongside a one-off still extrapolates", () => {
    // the guard must not silence the rate; only the event is excluded from it
    const mixed = { ...base, spentCents: 510_000, oneOffCents: 500_000, elapsedDays: 10, totalDays: 30 };
    // variable = 510k - 0 - 500k = 10k over 10 days -> 20k more across the 20 left
    expect(projectSpend(mixed)).toBe(510_000 + 20_000);
  });

  test("guards elapsedDays 0 and a fully-elapsed period", () => {
    expect(projectSpend({ ...base, spentCents: 10_000, elapsedDays: 0 })).toBe(10_000);
    expect(projectSpend({ ...base, spentCents: 10_000, elapsedDays: 30, expectedTailCents: 500 })).toBe(10_500);
  });
});

describe("recurringSeriesIdsForCategory — the shared series↔category bridge", () => {
  test("maps a series by its linked ACTIVE rows in the subtree, nothing else", () => {
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -180_000 });
    spendLinked("2026-06-20", -180_000, "Food > Dining", rent);
    // a superseded link and an out-of-subtree link must not map
    const gym = createSeries({ name: "Gym", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -5_000 });
    spendLinked("2026-06-20", -5_000, "Food > Dining", gym, "superseded");
    const flights = createSeries({ name: "Flights", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -20_000 });
    spendLinked("2026-06-20", -20_000, "Travel > Flights", flights);

    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food"))).toEqual(new Set([rent]));
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food > Dining"))).toEqual(new Set([rent]));
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Travel"))).toEqual(new Set([flights]));
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food > Groceries"))).toEqual(new Set());
  });

  test("user_category_id maps a commitment that has NEVER posted", () => {
    // the case this column exists for: a lease signed today, first payment next
    // month. Zero linked rows, so the posted-row derivation cannot find it.
    const lease = createSeries({ name: "Car lease", nextExpectedOn: "2026-09-11", nextExpectedAmountCents: -55_989 });
    bundle.db
      .update(recurringSeries)
      .set({ userCategoryId: catId("Travel > Flights") })
      .where(eq(recurringSeries.id, lease))
      .run();

    expect(recurringSeriesIdsForCategory(bundle.db, catId("Travel > Flights"))).toEqual(new Set([lease]));
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Travel"))).toEqual(new Set([lease]));
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food"))).toEqual(new Set());
  });

  test("an OVERRIDE, not a union — an overridden series leaves its posted-row category", () => {
    // without this the series would answer to BOTH categories and budgetTail
    // would project the whole amount into each.
    const moved = createSeries({ name: "Moved", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -9_000 });
    spendLinked("2026-06-20", -9_000, "Food > Dining", moved);
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food"))).toEqual(new Set([moved]));

    bundle.db
      .update(recurringSeries)
      .set({ userCategoryId: catId("Travel > Flights") })
      .where(eq(recurringSeries.id, moved))
      .run();

    expect(recurringSeriesIdsForCategory(bundle.db, catId("Travel"))).toEqual(new Set([moved]));
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food"))).toEqual(new Set());
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food > Dining"))).toEqual(new Set());
  });

  test("clearing the override hands the series back to its posted rows", () => {
    const back = createSeries({ name: "Back", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -4_000 });
    spendLinked("2026-06-20", -4_000, "Food > Dining", back);
    bundle.db
      .update(recurringSeries)
      .set({ userCategoryId: catId("Travel") })
      .where(eq(recurringSeries.id, back))
      .run();
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food"))).toEqual(new Set());

    bundle.db
      .update(recurringSeries)
      .set({ userCategoryId: null })
      .where(eq(recurringSeries.id, back))
      .run();
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Food"))).toEqual(new Set([back]));
    expect(recurringSeriesIdsForCategory(bundle.db, catId("Travel"))).toEqual(new Set());
  });
});

describe("incomeExpectation — the term /budgets never had", () => {
  test("posted and expected are disjoint, so a landed paycheque is never also forecast", () => {
    const pay = createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    // one already in, inside [start, today]
    spendLinked("2026-06-03", 104_600, "Income > Salary", pay);

    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05");
    expect(got.postedCents).toBe(104_600);
    // 06-08, 06-15, 06-22, 06-29 — strictly after today, none of them the posted one
    expect(got.expectedCents).toBe(104_600 * 4);
    expect(got.series.map((s) => s.name)).toEqual(["Cash job (weekly pay)"]);
    // and the schedule's own reading of the same four days, which is what the
    // month note quotes — deliberately NOT the posted one, which the walk does
    // not know about
    expect(got.scheduledOccurrences).toBe(4);
    expect(got.scheduledCents).toBe(104_600 * 4);
  });

  /*
   * ⛔ THE TWO WINDOWS ABUT ON `today`, AND ONLY A PAYDAY THAT LANDS ON IT CAN
   * SHOW IT. `postedCents` covers `[start, today]` and the expected walk opens
   * at `today + 1`. Found by mutation: relaxing that open to `today` changed no
   * test, because no fixture had a payday on the reference day.
   *
   * On this owner's ledger the pay is WEEKLY, so a payday falls on `today` once
   * a week — the card would show $4,188.00 of income for a month the schedule
   * pays $3,141.00, the deposit counted once as arrived and again as still to
   * come.
   */
  test("a paycheque that lands ON today is posted, never also expected", () => {
    const pay = createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    // today IS a payday, and it has already landed
    spendLinked("2026-06-08", 104_600, "Income > Salary", pay);

    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-08");
    expect(got.postedCents).toBe(104_600);
    // 06-15, 06-22, 06-29 — three, not four: today's is already in `postedCents`
    expect(got.expectedCents).toBe(104_600 * 3);
    expect(got.postedCents + got.expectedCents).toBe(104_600 * 4);
  });

  /*
   * The other end of the same window. `if (from <= end)` guards the walk; with
   * `<` it skips the whole block on the one day where `from === end` — the day
   * before the period closes.
   */
  test("a payday on the period's LAST day is still expected on the day before", () => {
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-30",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-29");
    // tomorrow is payday and tomorrow is inside the period
    expect(got.expectedCents).toBe(104_600);
    expect(got.series).toHaveLength(1);
    // …and on the last day itself there is nothing left to come
    expect(incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-30").expectedCents).toBe(0);
  });

  test("the basis is the annualised rate, not the paydays that happen to fall in the month", () => {
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05");
    expect(got.basis.kind).toBe("levelled");
    expect(got.basis.cents).toBe(levelledMonthlyCents(104_600, "weekly"));
  });

  test("the basis does not move between a four-payday month and a five-payday month", () => {
    // The whole point. July 2026 holds five Mondays after this anchor and June
    // holds four, and the plan being graded is the same plan in both.
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 100_000,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const june = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-01");
    const july = incomeExpectation(bundle.db, "2026-07-01", "2026-07-31", "2026-07-01");

    expect(june.scheduledOccurrences).not.toBe(july.scheduledOccurrences);
    expect(june.scheduledCents).not.toBe(july.scheduledCents);
    expect(june.basis.cents).toBe(july.basis.cents);
    // and the note names the difference rather than hiding it
    expect(june.basis.monthNote).toContain(`${june.scheduledOccurrences} paydays`);
    expect(july.basis.monthNote).toContain(`${july.scheduledOccurrences} paydays`);
  });

  test("posted money raises the basis only once it EXCEEDS the rate", () => {
    /*
     * ⚠️ This test previously asserted the opposite — "a lumpy month is not a
     * raise" — and that stricter rule is what produced the defect the floor now
     * guards: with actuals unable to raise the basis at all, one fourteen-cent
     * interest series published $0.14 of expected income over five thousand
     * dollars of banked salary.
     *
     * The worry behind the old rule was real (his mother's $6,900 landed in a
     * single July day and does not licence a bigger plan), but it argues for
     * classifying that deposit correctly, not for a header that can be talked
     * below the ledger. And the app behaved this way before the levelling
     * existed: `max(posted + still-due, forecast)` let actuals win too.
     */
    const pay = createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const rate = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05").basis;
    expect(rate.kind).toBe("levelled");

    // a deposit SMALLER than the rate leaves the rate in charge
    spendLinked("2026-06-02", 50_000, "Income > Salary", pay);
    const small = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05").basis;
    expect(small.kind).toBe("levelled");
    expect(small.cents).toBe(rate.cents);

    // one that exceeds it takes over, and says so
    spendLinked("2026-06-04", 690_000, "Income > Salary", pay);
    const fat = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05");
    expect(fat.postedCents).toBe(740_000);
    expect(fat.basis.kind).toBe("banked");
    expect(fat.basis.cents).toBe(740_000);
  });

  test("a user cadence override sets the basis, because it sets the projection", () => {
    // effectiveSeries already abandons the detected interval for an override;
    // a basis read off the DETECTED cadence would grade against a schedule the
    // page no longer draws.
    const pay = createSeries({
      name: "Cash job",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 100_000,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    bundle.db
      .update(recurringSeries)
      .set({ userCadence: "biweekly", userAmountCents: 200_000 })
      .where(eq(recurringSeries.id, pay))
      .run();
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05");
    expect(got.basis.cents).toBe(levelledMonthlyCents(200_000, "biweekly"));
  });

  test("a series whose owner ended it before the window contributes nothing", () => {
    // `userEndsOn` already stops the projection. A basis that levelled it anyway
    // would keep paying a job that finished.
    const pay = createSeries({
      name: "Old job",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 100_000,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    bundle.db
      .update(recurringSeries)
      .set({ userEndsOn: "2026-05-31" })
      .where(eq(recurringSeries.id, pay))
      .run();
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05");
    expect(got.basis.kind).toBe("calendar");
    expect(got.basis.cents).toBe(0);
    expect(got.basis.monthNote).toBeNull();
  });

  test("a series still running keeps its full rate in the months it does not pay", () => {
    // A quarterly series pays in one month of three. Levelling it away in the
    // other two would re-create the swing this replaced, in a bigger size.
    createSeries({
      name: "Quarterly draw",
      nextExpectedOn: "2026-06-15",
      nextExpectedAmountCents: 300_000,
      kind: "income",
      cadence: "quarterly",
      intervalDaysAvg: 91,
    });
    const quiet = incomeExpectation(bundle.db, "2026-07-01", "2026-07-31", "2026-07-01");
    expect(quiet.scheduledOccurrences).toBe(0);
    expect(quiet.basis.kind).toBe("levelled");
    expect(quiet.basis.cents).toBe(levelledMonthlyCents(300_000, "quarterly"));
    expect(quiet.basis.monthNote).toContain("No payday falls in this month");
  });

  test("only money-IN counts, and only live income series", () => {
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-06-10", nextExpectedAmountCents: -180_000 });
    const dead = createSeries({
      name: "Old job",
      nextExpectedOn: "2026-06-10",
      nextExpectedAmountCents: 50_000,
      kind: "income",
      status: "ended",
    });
    expect(rent).toBeTruthy();
    expect(dead).toBeTruthy();

    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05");
    expect(got.expectedCents).toBe(0);
    expect(got.series).toEqual([]);
    // nothing to level, so the page keeps the measurement it always had
    expect(got.basis.kind).toBe("calendar");
    expect(got.basis.cents).toBe(0);
  });

  test("an income series with no amount at all is not levelled to zero silently", () => {
    // `projectOccurrences` returns nothing without an amount, so a series like
    // this must not select `levelled` and publish a rate of zero — the fallback
    // measurement is the honest reading.
    const pay = createSeries({
      name: "Unknown pay",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 100_000,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    bundle.db
      .update(recurringSeries)
      .set({ nextExpectedAmountCents: null })
      .where(eq(recurringSeries.id, pay))
      .run();
    spend("2026-06-03", 40_000, "Income > Salary");
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-05");
    expect(got.basis.kind).toBe("calendar");
    expect(got.basis.cents).toBe(40_000);
  });

  test("a trivial detected series cannot bury five thousand dollars of banked salary", () => {
    /*
     * The end-to-end reproduction of the defect the levelling introduced. Nothing
     * here is contrived: `INTEREST PAYMENT` is a series the detector creates by
     * itself on the real fixture, and salary posting without an attributed series
     * is the ordinary state of this ledger for weeks at a time.
     *
     * Before the floor: basis `levelled` $0.14, and every budget on the page
     * reads over-allocated against fourteen cents.
     */
    spend("2026-08-05", 250_000, "Income > Salary");
    spend("2026-08-19", 250_000, "Income > Salary");
    createSeries({
      name: "INTEREST PAYMENT",
      nextExpectedOn: "2026-08-31",
      nextExpectedAmountCents: 14,
      kind: "income",
      cadence: "monthly",
      intervalDaysAvg: 30.4,
      status: "detected",
    });

    const got = incomeExpectation(bundle.db, "2026-08-01", "2026-08-31", "2026-08-21");
    expect(got.postedCents).toBe(500_000);
    expect(got.basis.kind).toBe("banked");
    expect(got.basis.cents).toBe(500_000);
  });

  test("the floor does not fire on the ledger's ordinary state, so the rate still holds still", () => {
    // The control for the test above. His cash job has banked nothing since
    // June, so `postedCents` is zero and the rate governs — which is the whole
    // point of the rate.
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-08-06",
      nextExpectedAmountCents: 104_700,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const august = incomeExpectation(bundle.db, "2026-08-01", "2026-08-31", "2026-08-21");
    const october = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-21");
    expect(august.postedCents).toBe(0);
    expect(august.basis.kind).toBe("levelled");
    // October 2026 schedules FIVE paydays against August's four, and the graded
    // figure does not notice — which it would if the floor read the schedule.
    expect(october.scheduledOccurrences).toBe(5);
    expect(october.basis.cents).toBe(august.basis.cents);
    expect(october.basis.cents).toBe(levelledMonthlyCents(104_700, "weekly"));
  });

  test("the horizon is a WHOLE year, and an annual series proves it has to be", () => {
    /*
     * Found by mutation: BASIS_HORIZON_MONTHS 12 -> 6 survived the whole suite,
     * because every other income series here pays inside any horizon you pick.
     * An annual one does not, and shortening the horizon makes it contribute in
     * the months near its payday and vanish in the rest — which is the calendar
     * swing this whole mechanism exists to remove, in its largest possible size.
     *
     * Graded month is 2026-08; the payday is 2027-06-15, ten months out. It is
     * inside a twelve-month horizon and outside anything shorter than eleven.
     */
    createSeries({
      name: "Annual bonus",
      nextExpectedOn: "2027-06-15",
      nextExpectedAmountCents: 1_200_000,
      kind: "income",
      cadence: "annual",
      intervalDaysAvg: 365,
    });
    const got = incomeExpectation(bundle.db, "2026-08-01", "2026-08-31", "2026-08-21");
    expect(got.scheduledOccurrences).toBe(0);
    expect(got.basis.kind).toBe("levelled");
    expect(got.basis.cents).toBe(levelledMonthlyCents(1_200_000, "annual"));
  });

  test("the nominal cadence sets the rate even when the measured gap disagrees", () => {
    /*
     * A deliberate, measured trade-off rather than an oversight — pinned so it is
     * a decision a future reader can find rather than one they trip over.
     *
     * `stepPlan` walks a "monthly" series by its MEASURED average gap unless that
     * gap is 29..32 days, so a series labelled monthly at 38.5 days (two exist on
     * the real ledger, both dismissed) projects about nine occurrences a year
     * while the rate below levels twelve. The alternative — deriving the rate from
     * the walk — makes a weekly series yield 52 or 53 depending on which weekday
     * the year starts on, moving the header by about $87 from one month to the
     * next. That is the same disease in a smaller size, so the nominal table wins
     * and `monthNote` states the difference on screen rather than hiding it.
     */
    createSeries({
      name: "Irregular monthly",
      nextExpectedOn: "2026-08-10",
      nextExpectedAmountCents: 100_000,
      kind: "income",
      cadence: "monthly",
      intervalDaysAvg: 38.5,
    });
    const got = incomeExpectation(bundle.db, "2026-08-01", "2026-08-31", "2026-08-01");
    // the walk steps 39 days, so August holds exactly one occurrence...
    expect(got.scheduledOccurrences).toBe(1);
    expect(got.scheduledCents).toBe(100_000);
    // ...while the rate reads the LABEL and levels twelve payments a year
    expect(got.basis.cents).toBe(levelledMonthlyCents(100_000, "monthly"));
    // and the gap between the two models is printed, not swallowed
    expect(got.basis.monthNote).toContain("exactly the annualised figure above");
  });

  test("a window entirely in the past forecasts nothing and reports only actuals", () => {
    spend("2026-06-03", 40_000, "Income > Salary");
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-08-11");
    expect(got.postedCents).toBe(40_000);
    expect(got.expectedCents).toBe(0);
  });
});

describe("budgetOverdue — the bill that came due and never arrived", () => {
  test("an expected occurrence with no posting is overdue; a posted one is not", () => {
    const rent = createSeries({
      name: "Rent",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: -228_570,
    });
    bindSeries(rent, "Housing");
    // today is the 20th: the 8th came due and nothing posted
    const missed = budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20");
    expect(missed.totalCents).toBe(228_570);
    expect(missed.series.map((x) => x.name)).toEqual(["Rent"]);

    // once it posts, it is spend — never also overdue
    spendLinked("2026-06-08", -228_570, "Housing", rent);
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
  });

  test("a posting inside toleranceDays still counts as paid", () => {
    const bill = createSeries({ name: "Wifi", nextExpectedOn: "2026-06-08", nextExpectedAmountCents: -5_000 });
    bindSeries(bill, "Housing");
    // default toleranceDays is 3 — landing on the 10th is the same bill
    spendLinked("2026-06-10", -5_000, "Housing", bill);
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
  });

  /*
   * ⛔ THE TOLERANCE EDGE, PINNED IN BOTH DIRECTIONS. The rule is
   * `|posted − due| <= toleranceDays`, and the day EXACTLY at the limit is the
   * only one that separates it from `<`. Found by mutation: tightening the
   * comparison changed no test, because every fixture posting sat comfortably
   * inside or comfortably outside.
   *
   * The cost of getting it wrong is money that has already left the account
   * being reported as an unpaid bill on /budgets AND added to `projectedCents`
   * a second time on top of the charge already in `spentCents`. This is also
   * the committed book's overdue rule, so the runway card inherits it, and
   * `recurring-calendar` documents itself as having to agree with it.
   */
  test("a posting EXACTLY toleranceDays late is paid, and one day further is not", () => {
    const bill = createSeries({ name: "Wifi", nextExpectedOn: "2026-06-08", nextExpectedAmountCents: -5_000 });
    bindSeries(bill, "Housing");
    // default toleranceDays is 3: the 11th is exactly at the limit
    spendLinked("2026-06-11", -5_000, "Housing", bill);
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
  });

  test("a posting one day PAST toleranceDays leaves the bill overdue", () => {
    const bill = createSeries({ name: "Wifi", nextExpectedOn: "2026-06-08", nextExpectedAmountCents: -5_000 });
    bindSeries(bill, "Housing");
    spendLinked("2026-06-12", -5_000, "Housing", bill);
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(5_000);
  });

  test("the tolerance is symmetric — EARLY by exactly the limit is paid too", () => {
    const bill = createSeries({ name: "Wifi", nextExpectedOn: "2026-06-08", nextExpectedAmountCents: -5_000 });
    bindSeries(bill, "Housing");
    spendLinked("2026-06-05", -5_000, "Housing", bill);
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
  });

  /**
   * UBER *ONE last charged 446 days ago against a 49-day tolerance and kept
   * projecting $4.99 a month into Travel. A forecast is a claim about what is
   * coming; a series that stopped charging has stopped making it.
   */
  test("a series that stopped charging is no longer overdue OR forecast", () => {
    const dead = createSeries({
      name: "UBER *ONE",
      nextExpectedOn: "2026-06-10",
      nextExpectedAmountCents: -499,
      lastMatchedOn: "2025-03-01", // 466 days before the 2026-06-10 window
    });
    bindSeries(dead, "Housing");
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
    expect(budgetTail(bundle.db, catId("Housing"), "2026-06-30", "2026-06-05").totalCents).toBe(0);
  });

  /**
   * The reason this gate is not `isSeriesActive`. A lease signed today posts
   * nothing until next month's statement, so it has no `lastMatchedOn` at all —
   * and deleting it from the forecast would remove real money the owner owes.
   */
  test("a registered commitment that has NEVER posted is still forecast", () => {
    const lease = createSeries({
      name: "Car lease",
      nextExpectedOn: "2026-06-11",
      nextExpectedAmountCents: -55_989,
      lastMatchedOn: null,
    });
    bindSeries(lease, "Housing");
    // due on the 11th, today is the 20th, nothing posted → overdue, not ignored
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(55_989);
    // and still forecast while it is ahead of today
    expect(budgetTail(bundle.db, catId("Housing"), "2026-06-30", "2026-06-05").totalCents).toBe(55_989);
  });

  test("never looks past today, so it can never overlap budgetTail", () => {
    bindSeries(
      createSeries({ name: "Later", nextExpectedOn: "2026-06-25", nextExpectedAmountCents: -1_000 }),
      "Housing",
    );
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
  });
});

describe("budgetTail — expected-but-unposted recurring", () => {
  test("sums future money-out occurrences strictly after today, per series, sorted", () => {
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -180_000 });
    spendLinked("2026-06-20", -180_000, "Food > Dining", rent); // establishes category = Food
    const weekly = createSeries({
      name: "Cleaner",
      nextExpectedOn: "2026-07-10",
      nextExpectedAmountCents: -5_000,
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    spendLinked("2026-06-19", -5_000, "Food > Dining", weekly);

    const tail = budgetTail(bundle.db, catId("Food"), "2026-07-31", "2026-07-08");
    // Cleaner: 07-10, 07-17, 07-24, 07-31 = 4×5k; Rent: 07-20 = 18k
    expect(tail.totalCents).toBe(20_000 + 180_000);
    expect(tail.series.map((s) => [s.name, s.nextDate, s.amountCents, s.occurrenceCount])).toEqual([
      ["Cleaner", "2026-07-10", 20_000, 4],
      ["Rent", "2026-07-20", 180_000, 1],
    ]);
    expect(tail.series[0]!.href).toBe(`/recurring/${weekly}`);
  });

  test("excludes today's own date, income (money-in), and non-live series", () => {
    const onToday = createSeries({ name: "OnToday", nextExpectedOn: "2026-07-08", nextExpectedAmountCents: -3_000 });
    spendLinked("2026-06-08", -3_000, "Food > Dining", onToday);
    const income = createSeries({
      name: "SideGig",
      nextExpectedOn: "2026-07-15",
      nextExpectedAmountCents: 90_000,
      kind: "income",
    });
    spendLinked("2026-06-15", 90_000, "Food > Dining", income);
    const dismissed = createSeries({
      name: "OldBox",
      nextExpectedOn: "2026-07-16",
      nextExpectedAmountCents: -2_000,
      status: "dismissed",
    });
    spendLinked("2026-06-16", -2_000, "Food > Dining", dismissed);

    const tail = budgetTail(bundle.db, catId("Food"), "2026-07-31", "2026-07-08");
    // OnToday's only in-window occurrence is 07-08 (== today, excluded); its next
    // monthly step (08-07) is outside the period. Income and dismissed excluded.
    expect(tail).toEqual({ totalCents: 0, series: [] });
  });
});

describe("budgetGuidanceCents — 6-month daily rate, period-agnostic", () => {
  test("expresses trailing spend at the budget period's length; refunds clamp to 0", () => {
    // 18,100 over 181 days (Jan–Jun 2026) = 100/day exactly
    spend("2026-01-15", -18_100, "Food > Dining");
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "monthly", "2026-07-15")).toBe(3_100); // 100 × 31
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "weekly", "2026-07-15")).toBe(700); // 100 × 7
    expect(budgetGuidanceCents(bundle.db, catId("Food"), "daily", "2026-07-15")).toBe(100); // 100 × 1

    // a net-refund history never suggests a negative budget
    spend("2026-02-10", 30_000, "Travel > Flights");
    expect(budgetGuidanceCents(bundle.db, catId("Travel"), "monthly", "2026-07-15")).toBe(0);
  });
});

describe("budgetPaceStatuses — end-to-end pace, projection, and tail", () => {
  test("wires elapsed days, projection, pace tier, and the tail onto each status", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 60_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-03", -12_000, "Food > Dining"); // variable
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -18_000 });
    spendLinked("2026-06-20", -18_000, "Food > Dining", rent); // June link → category only, not July spend

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.totalDays).toBe(31);
    expect(status.elapsedDays).toBe(8);
    expect(status.spentCents).toBe(12_000); // June link is outside July
    expect(status.recurringPostedCents).toBe(0);
    expect(status.expectedTailCents).toBe(18_000);
    // variable remainder = round(12_000 × 23/8) = 34_500 → projected 12k+18k+34.5k
    expect(status.projectedCents).toBe(64_500);
    expect(status.pace).toBe("at-risk"); // under today (12k<60k) but projection overruns
    expect(status.tail.map((t) => t.name)).toEqual(["Rent"]);
    expect(status.elapsedFraction).toBeCloseTo(8 / 31, 10);
  });

  test("pace reads 'over' the instant spend meets budget, regardless of projection", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-02", -10_000, "Food > Dining");
    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.pace).toBe("over");
  });

  test("a recurring charge already posted this period is not double-counted (no tail, not extrapolated)", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 60_000,
      startsOn: "2026-07-01",
    });
    // Rent already posted on the 5th; its next step (Aug) is outside the period
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-05", nextExpectedAmountCents: -18_000 });
    spendLinked("2026-07-05", -18_000, "Food > Dining", rent);
    spend("2026-07-03", -12_000, "Food > Dining"); // variable

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.spentCents).toBe(30_000);
    expect(status.recurringPostedCents).toBe(18_000);
    expect(status.expectedTailCents).toBe(0); // already posted → no phantom tail
    // only the 12k variable extrapolates: 12k × 23/8 = 34_500 → 30k + 0 + 34.5k
    expect(status.projectedCents).toBe(64_500);
    expect(status.pace).toBe("at-risk");
  });

  test("a future-dated recurring posting is counted once (spend-to-date base, not spent+tail)", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Housing"),
      period: "monthly",
      amountCents: 200_000,
      startsOn: "2026-07-01",
    });
    // Rent series projects 07-25. A matching charge is ALSO already posted with
    // that FUTURE in-period date (a bill logged early). recomputeSeriesStats
    // ignores postedOn > today, so the series still projects 07-25 — the exact
    // trap where a naive full-period base would count the 180k in BOTH spent and
    // the tail (→ a fabricated 360k projection).
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-25", nextExpectedAmountCents: -180_000 });
    spendLinked("2026-06-25", -180_000, "Housing > Rent", rent); // June link maps the series to Housing
    spendLinked("2026-07-25", -180_000, "Housing > Rent", rent); // future-dated in-period posting

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.spentCents).toBe(180_000); // the future-dated charge has posted this period
    expect(status.expectedTailCents).toBe(180_000); // the series still projects 07-25
    // counted ONCE: spend-to-date is 0 (07-25 > today) so projected = tail only,
    // floored at the 180k already posted — never 360k.
    expect(status.projectedCents).toBe(180_000);
    expect(status.pace).toBe("under");
  });

  test("a daily budget has a single-day period and no forward tail", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "daily",
      amountCents: 3_000,
      startsOn: "2026-07-01",
    });
    // a linked series exists, but today IS the last day → nothing left to post
    const rent = createSeries({ name: "Rent", nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -18_000 });
    spendLinked("2026-06-20", -18_000, "Food > Dining", rent);
    spend("2026-07-08", -1_000, "Food > Coffee");

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.totalDays).toBe(1);
    expect(status.elapsedDays).toBe(1);
    expect(status.elapsedFraction).toBe(1);
    expect(status.expectedTailCents).toBe(0);
    expect(status.spentCents).toBe(1_000);
    expect(status.pace).toBe("under");
  });
});


describe("data coverage (uncoveredDays / dataThroughOn)", () => {
  test("a period the ledger does not reach reports the uncovered stretch", () => {
    spend("2026-08-03", -5_000, "Food");
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 100_000,
      startsOn: "2026-08-01",
    });
    const s = budgetPaceStatuses(bundle.db, "2026-08-11").find((x) => x.categoryName === "Food")!;
    expect(s.dataThroughOn).toBe("2026-08-03");
    expect(s.uncoveredDays).toBe(8); // 04-Aug .. 11-Aug inclusive
  });

  test("a category with no rows at all reports null and the whole elapsed window", () => {
    createBudget(bundle.db, {
      categoryId: catId("Travel"),
      period: "monthly",
      amountCents: 50_000,
      startsOn: "2026-08-01",
    });
    const s = budgetPaceStatuses(bundle.db, "2026-08-11").find((x) => x.categoryName === "Travel")!;
    expect(s.dataThroughOn).toBeNull();
    expect(s.uncoveredDays).toBe(11);
  });

  test("data reaching today leaves nothing uncovered", () => {
    spend("2026-08-11", -5_000, "Food");
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 100_000,
      startsOn: "2026-08-01",
    });
    const s = budgetPaceStatuses(bundle.db, "2026-08-11").find((x) => x.categoryName === "Food")!;
    expect(s.uncoveredDays).toBe(0);
  });

  test("data from a PRIOR period covers none of this one, and never over-counts", () => {
    spend("2026-07-20", -5_000, "Food");
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 100_000,
      startsOn: "2026-08-01",
    });
    const s = budgetPaceStatuses(bundle.db, "2026-08-11").find((x) => x.categoryName === "Food")!;
    expect(s.dataThroughOn).toBe("2026-07-20");
    expect(s.uncoveredDays).toBe(11); // the elapsed window, not the 22 days since the row
  });

  test("a CHILD's spending counts as coverage for its parent's budget", () => {
    spend("2026-08-09", -2_500, "Food > Coffee");
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 100_000,
      startsOn: "2026-08-01",
    });
    const s = budgetPaceStatuses(bundle.db, "2026-08-11").find((x) => x.categoryName === "Food")!;
    expect(s.dataThroughOn).toBe("2026-08-09");
    expect(s.uncoveredDays).toBe(2);
  });
});

/**
 * Opt-in rollover (migration 0012). Each accumulation rule gets its own test
 * because each one exists to REFUSE a specific dishonest number, and a rule that
 * is only implied by a happy-path assertion is a rule the next pass will delete.
 */
describe("rollover", () => {
  /** A Food budget of `amountCents`/month from `startsOn`, rollover already on. */
  function rollingFoodBudget(startsOn: string, amountCents = 500_00): string {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents,
      startsOn,
    });
    setBudgetRollover(bundle.db, id, { enabled: true });
    return id;
  }

  function foodStatus(refDate: string) {
    const s = budgetStatuses(bundle.db, refDate).find((r) => r.categoryPath === "Food");
    if (!s) throw new Error("no Food budget status");
    return s;
  }

  test("is off by default, and an untouched budget grades exactly as before", () => {
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 500_00,
      startsOn: "2026-05-01",
    });
    spend("2026-05-10", -100_00, "Food");

    const s = foodStatus("2026-07-15");
    expect(s.budget.rolloverEnabled).toBe(false);
    expect(s.rolloverCents).toBe(0);
    // available collapses onto the plan, so pct/alert/remaining are untouched
    expect(s.availableCents).toBe(500_00);
    expect(s.remainingCents).toBe(500_00);
  });

  test("unspent plan from each CLOSED period accumulates", () => {
    rollingFoodBudget("2026-05-01");
    spend("2026-05-10", -100_00, "Food"); // May surplus $400
    spend("2026-06-10", -200_00, "Food"); // June surplus $300

    const s = foodStatus("2026-07-15");
    expect(s.rolloverCents).toBe(700_00);
    expect(s.availableCents).toBe(1_200_00);
  });

  test("the period being graded is never banked — only closed ones are", () => {
    rollingFoodBudget("2026-06-01");
    // June is the CURRENT period at this refDate, so it contributes nothing even
    // though nothing has been spent in it
    expect(foodStatus("2026-06-20").rolloverCents).toBe(0);
  });

  test("a deficit is floored at zero, never carried forward as debt", () => {
    rollingFoodBudget("2026-05-01");
    spend("2026-05-10", -2_000_00, "Food"); // May overspent by $1,500

    // May floors to 0 rather than −$1,500, so June's full $500 survives. Carrying
    // the deficit would leave the row permanently, unrecoverably over.
    expect(foodStatus("2026-07-15").rolloverCents).toBe(500_00);
  });

  test("a partial first period is skipped whole, never prorated", () => {
    rollingFoodBudget("2026-05-15"); // opens mid-May

    // only June is banked. Crediting the 17 days of May the budget did exist for
    // would bank surplus out of days that were never planned.
    expect(foodStatus("2026-07-15").rolloverCents).toBe(500_00);
  });

  test("rollover cannot be told to start before the budget does", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 500_00,
      startsOn: "2026-05-01",
    });
    expect(() => setBudgetRollover(bundle.db, id, { enabled: true, startsOn: "2026-01-01" })).toThrow(
      /cannot start before the budget/i,
    );
  });

  test("a later rollover start narrows the lookback", () => {
    const id = rollingFoodBudget("2026-04-01");
    expect(foodStatus("2026-07-15").rolloverCents).toBe(1_500_00); // Apr+May+Jun

    setBudgetRollover(bundle.db, id, { enabled: true, startsOn: "2026-06-01" });
    expect(foodStatus("2026-07-15").rolloverCents).toBe(500_00); // June only
  });

  test("a bill that came due and never posted is not banked as surplus", () => {
    rollingFoodBudget("2026-05-01");
    const series = createSeries({
      name: "Meal Kit",
      nextExpectedOn: "2026-06-10",
      nextExpectedAmountCents: -200_00,
    });
    bindSeries(series, "Food");

    // June banks $500 − $200 committed = $300, on top of May's $500. Without the
    // overdue term June would bank the full $500 of a month whose bill simply
    // has not arrived yet — and the bill would then be charged to July as well.
    expect(foodStatus("2026-07-15").rolloverCents).toBe(800_00);
  });

  test("the carry is capped when a cap is set", () => {
    const id = rollingFoodBudget("2026-04-01");
    expect(foodStatus("2026-07-15").rolloverCents).toBe(1_500_00);

    setBudgetRollover(bundle.db, id, { enabled: true, capCents: 600_00 });
    expect(foodStatus("2026-07-15").rolloverCents).toBe(600_00);
  });

  test("the carry is derived at read time, so a back-filled import moves it", () => {
    rollingFoodBudget("2026-05-01");
    expect(foodStatus("2026-07-15").rolloverCents).toBe(1_000_00);

    // a statement lands late and back-fills a closed period — a stored balance
    // would still be reporting $1,000.00
    spend("2026-05-20", -150_00, "Food");
    expect(foodStatus("2026-07-15").rolloverCents).toBe(850_00);
  });

  test("pct, alert and pace all grade against the carry, and cannot disagree", () => {
    rollingFoodBudget("2026-05-01");
    spend("2026-07-05", -700_00, "Food"); // over the $500 plan, under $1,500 available

    const s = budgetPaceStatuses(bundle.db, "2026-07-15").find((r) => r.categoryPath === "Food")!;
    expect(s.availableCents).toBe(1_500_00);
    // past the plan but not past the line he is actually graded against
    expect(s.spentCents).toBeGreaterThan(s.budget.amountCents);
    expect(s.remainingCents).toBe(800_00);
    expect(s.pct).toBeLessThan(1);
    expect(s.alert).not.toBe("over");
    // pace shares the denominator — split denominators would render
    // "Over budget by <1%" on a row sitting comfortably under
    expect(s.pace).not.toBe("over");
  });

  test("carryInto walks weekly periods too, not just months", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "weekly",
      amountCents: 100_00,
      startsOn: "2026-06-01", // a Monday — a whole ISO week
    });
    setBudgetRollover(bundle.db, id, { enabled: true });
    spend("2026-06-03", -40_00, "Food");

    // weeks of 06-01 and 06-08 are closed at 06-15; the first banks $60, the
    // second the full $100
    const budget = {
      categoryId: catId("Food"),
      period: "weekly" as const,
      amountCents: 100_00,
      startsOn: "2026-06-01",
      rolloverStartsOn: null,
      rolloverCapCents: null,
    };
    expect(carryInto(bundle.db, budget, "2026-06-15")).toBe(160_00);
  });
});

describe("budgetSections — a section is labelled by its PERIOD, never by a member row", () => {
  /**
   * The defect this exists to prevent, measured on the real ledger 2026-08-13:
   * the page read its section range off `statuses[0].bounds`. A budget created
   * mid-period is START-CLAMPED, so the Car budget (created 2026-08-11, and
   * alphabetically first among eleven) made the whole Monthly header read
   * "Aug 11 – Aug 31" over ten budgets that had been graded since Aug 1.
   *
   * The clamped row must sort FIRST here, or the test passes without the fix.
   */
  test("a start-clamped first row does not shrink its section's window", () => {
    createBudget(bundle.db, {
      // sorts before "Food" — the structural position the real Car budget held
      categoryId: catId("Entertainment"),
      period: "monthly",
      amountCents: 92_138,
      startsOn: "2026-08-11",
    });
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 143_000,
      startsOn: "2026-07-16",
    });

    const statuses = budgetStatuses(bundle.db, "2026-08-13");
    const [section] = budgetSections(statuses, "2026-08-13");

    // the premise: the clamped budget really is first, and really is clamped
    expect(statuses[0]!.categoryPath).toBe("Entertainment");
    expect(statuses[0]!.partialPeriod).toBe(true);
    expect(statuses[0]!.bounds).toEqual({ start: "2026-08-11", end: "2026-08-31" });

    // the section spans the whole month regardless
    expect(section!.bounds).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(section!.label).toBe("Monthly");
    expect(section!.statuses).toHaveLength(2);
  });

  test("periods with no budgets are dropped, and the rest stay in period order", () => {
    createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "annual",
      amountCents: 500_000,
      startsOn: "2026-01-01",
    });
    createBudget(bundle.db, {
      categoryId: catId("Transport"),
      period: "weekly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });

    const sections = budgetSections(budgetStatuses(bundle.db, "2026-08-13"), "2026-08-13");

    expect(sections.map((s) => s.period)).toEqual(["weekly", "annual"]);
    expect(sections.map((s) => s.label)).toEqual(["Weekly", "Annual"]);
    // each carries ITS OWN period's window, not the page's month
    expect(sections[1]!.bounds).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  test("emits nothing at all when there are no budgets", () => {
    expect(budgetSections([], "2026-08-13")).toEqual([]);
  });
});
