import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { budgetCoverageSentence } from "@/lib/budget-coverage";
import { budgetCoverageLine, budgetVerdict } from "@/lib/budget-verdict";
import { BUDGET_JARGON } from "@/lib/jargon";
import { budgetSectionNotes } from "@/lib/section-notes";
import { rolloverWaitsSentence } from "@/lib/rollover-held-back";
import type { PeriodBounds } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import { levelledMonthlyCents } from "@/lib/income-basis";
import { recurringSeries } from "@/db/schema/recurring";
import type { Cadence, SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import { createAccount } from "./accounts";
import { createCashWallet } from "./cash-wallets";
import { checkedThrough } from "./checked-days-fixture";
import { addManualTransaction } from "./manual-transactions";
import { setSplits } from "./transaction-splits";
import { categorySpending, recurringSeriesIdsForCategory } from "./analytics";
import {
  budgetPaceStatuses,
  budgetSections,
  budgetStatuses,
  budgetOneOffCents,
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
  type BudgetPaceStatus,
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
function spend(postedOn: string, amountCents: number, categoryPath: string, accountId: string = cardId): void {
  seq += 1;
  const rawDescription = `SPEND ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId: catId(categoryPath),
      dedupeHash: dedupeHash({
        accountId,
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

/** A spend row linked to a recurring series (and optionally superseded). Returns its id. */
function spendLinked(
  postedOn: string,
  amountCents: number,
  categoryPath: string,
  seriesId: string,
  status: "active" | "superseded" = "active",
): string {
  seq += 1;
  const rawDescription = `LINKED ${seq}`;
  return bundle.db
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
    .returning({ id: transactions.id })
    .get().id;
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
    // and the schedule's own reading of the month, which is what the month note
    // quotes: the four still to come AND Mon Jun 1, the payday the posted deposit
    // answered two days late — his paydays open on the first one the deposit can
    // have been for (`firstPaydayOn`, §6A 55 step B). 🔴 Walked from the Jun 8
    // anchor it was four, and posted + expected ($5,230.00) sat a payday above
    // the schedule's own month ($4,184.00).
    expect(got.scheduledOccurrences).toBe(5);
    expect(got.scheduledCents).toBe(104_600 * 5);
    expect(got.postedCents + got.expectedCents).toBe(got.scheduledCents);
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
    // …and on the last day itself the payday is TODAY's: still to come until it
    // posts, so still expected. ⚠️ This line asserted 0 — an assertion that
    // ENCODED the neither-leg gap the docstring on `from` describes.
    expect(incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-30").expectedCents).toBe(104_600);
  });

  /*
   * ⛔ THE OTHER HALF, AND THE ONE THE OWNER'S LEDGER SHOWED. A payday dated
   * today whose money has NOT posted was in neither leg: `postedCents` held
   * nothing and the walk opened tomorrow. Measured 2026-09-03, a Thursday:
   * "$0.00 in so far, $3,141.00 still expected" one line above "4 paydays fall
   * in this month, scheduled at $4,188.00" — $1,047.00 in neither figure.
   *
   * Killed by mutation: reopening the walk on `today + 1` fails this; dropping
   * the posted-today exclusion fails the test above it.
   */
  test("a payday ON today with nothing posted is still expected — the forward leg owns today", () => {
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-08");
    expect(got.postedCents).toBe(0);
    // 06-08 (today, unposted), 06-15, 06-22, 06-29 — four. The 06-01 payday is
    // past and unposted, and income has no arrears leg to hold it, by doctrine.
    expect(got.expectedCents).toBe(104_600 * 4);
    expect(got.series.map((s) => s.name)).toEqual(["Cash job (weekly pay)"]);
    // …and it is REPORTED rather than lost: five paydays are scheduled, four
    // are still to come, one has passed with nothing banked.
    expect(got.scheduledOccurrences).toBe(5);
    expect(got.passedUnpaidOccurrences).toBe(1);
    expect(got.passedUnpaidCents).toBe(104_600);
    expect(got.postedCents + got.expectedCents + got.passedUnpaidCents).toBe(got.scheduledCents);
  });

  /*
   * ⛔ THE THIRD LEG — the six days in seven the 09-03 fix did not reach.
   *
   * That session moved the forward leg onto `today`, which closes the gap on
   * the one day the payday IS today. The day AFTER a payday it opens again:
   * `postedCents` stops at today with nothing in it, the walk starts at today
   * and the payday is behind it. Measured on the owner's ledger 2026-09-04:
   * "$0.00 in so far, $3,141.00 still expected" one line above "4 paydays fall
   * in this month, scheduled at $4,188.00" — $1,047.00 called nothing at all.
   *
   * ⛔ It stays OUT of `expectedCents` on purpose (income has no arrears leg),
   * so the only thing that can go wrong is the report going silent — which is
   * what these assertions pin.
   *
   * Mutants killed: walking `<= today` instead of `< today` counts today's own
   * unposted payday as passed (test below); dropping the banked check reports a
   * payday that was paid; dropping the tolerance reports one paid a day late.
   */
  test("a payday that PASSED with nothing banked is reported, and never counted as expected", () => {
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    // the day AFTER a payday, nothing imported
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-09");
    expect(got.postedCents).toBe(0);
    // 06-15, 06-22, 06-29 — 06-01 and 06-08 are behind today
    expect(got.expectedCents).toBe(104_600 * 3);
    expect(got.passedUnpaidOccurrences).toBe(2);
    expect(got.passedUnpaidCents).toBe(104_600 * 2);
    // the three legs are exhaustive over the schedule, which is what lets the
    // header print all three without a reader having to find the difference
    expect(got.postedCents + got.expectedCents + got.passedUnpaidCents).toBe(got.scheduledCents);
  });

  /*
   * ⛔ ONE DEPOSIT'S MONEY IS SPENT ONCE. Which payday a deposit answered is
   * `paydaySettlement`'s question now (⚖️ settle backwards, his decision of
   * 2026-09-28), and the danger the old exact-date check guarded against has
   * not gone away — it has only moved. A deposit whose tolerance window TOUCHES
   * two of its series' paydays must still retire exactly one of them, or the
   * one deposit does the work of two and the month reads short by a payday.
   *
   * Found by mutation, and it still is: drop the `settledDates.has` guard in
   * `settlePaydaysBackwards`, or let the anchor clause run for every occurrence
   * in reach instead of only the first, and this test fails while nothing else
   * in the file moves.
   */
  test("a deposit whose tolerance touches two paydays settles only the later one", () => {
    const pay = createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    // 06-05 is within the default tolerance of 3 of BOTH 06-08 and 06-01, and
    // carries one week's money
    spendLinked("2026-06-05", 104_600, "Income > Salary", pay);
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-08");
    expect(got.postedCents).toBe(104_600);
    // 06-08 was answered; 06-15, 06-22 and 06-29 are still to come
    expect(got.expectedCents).toBe(104_600 * 3);
    // and 06-01 is still owed — one week of pay did not buy two weeks
    expect(got.passedUnpaidOccurrences).toBe(1);
    expect(got.passedUnpaidCents).toBe(104_600);
  });

  /*
   * ⚖️ SETTLE BACKWARDS REACHES PAST THE TOLERANCE, and it has to: his Sep 24
   * deposit retires Aug 27, twenty-eight days behind it. The tolerance decides
   * which payday a deposit ANSWERS on its own date; how far back its money
   * reaches is decided by the money.
   */
  test("a deposit near today, but not on it, still answers today's payday", () => {
    const pay = createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    // three days before today, and short of a full week — his June deposit was
    // $1,047.00 against a $1,141.92 week, and it still answered that week
    spendLinked("2026-06-05", 60_000, "Income > Salary", pay);
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-08");
    expect(got.postedCents).toBe(60_000);
    // 06-08 is answered; 06-15, 06-22 and 06-29 remain
    expect(got.expectedCents).toBe(104_600 * 3);
    expect(got.passedUnpaidOccurrences).toBe(0);
  });

  test("today's own unposted payday is EXPECTED, not passed — the walk cuts strictly before today", () => {
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-08",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-08");
    expect(got.expectedCents).toBe(104_600 * 4);
    expect(got.passedUnpaidOccurrences).toBe(0);
  });

  test("a payday that WAS banked is not reported as passed and unpaid", () => {
    const pay = createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    spendLinked("2026-06-01", 104_600, "Income > Salary", pay);
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-09");
    expect(got.postedCents).toBe(104_600);
    // 06-08 passed unbanked; 06-01 was banked
    expect(got.passedUnpaidOccurrences).toBe(1);
    expect(got.passedUnpaidCents).toBe(104_600);
  });

  /*
   * The SAME arbiter bills get. `overdueForSeries` calls a bill paid when a
   * linked posting sits within the series' own `toleranceDays`; income asking
   * the question differently would let one page call a payday met and another
   * call it missed. Default tolerance is 3.
   */
  test("a deposit inside toleranceDays meets the payday; one day past it does not", () => {
    const pay = createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    // three days late for the 06-01 payday — still that payday
    spendLinked("2026-06-04", 104_600, "Income > Salary", pay);
    expect(
      incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-06").passedUnpaidOccurrences,
    ).toBe(0);

  });

  /*
   * ⚖️ PAST THE TOLERANCE, THE MONEY DECIDES. A deposit outside the tolerance
   * window is not near enough to be that payday's own, so it retires the payday
   * behind it only when it carries the whole of it — claiming a payday was paid
   * with money that was not there is the fabricated plug this ledger refuses.
   *
   * 🔴 It used to be unmet either way, and that is what he rejected: a lump can
   * never catch up if lateness alone disqualifies it.
   */
  test("a deposit past toleranceDays retires the payday only when it covers the whole amount", () => {
    const late = createSeries({
      name: "Other pay",
      nextExpectedOn: "2026-07-01",
      nextExpectedAmountCents: 50_000,
      kind: "income",
      cadence: "monthly",
    });
    // four days late — past the default tolerance of 3 — but a whole month's pay
    spendLinked("2026-07-05", 50_000, "Income > Salary", late);
    const got = incomeExpectation(bundle.db, "2026-07-01", "2026-07-31", "2026-07-08");
    expect(got.passedUnpaidOccurrences).toBe(0);
    expect(got.postedCents).toBe(50_000);

    const short = createSeries({
      name: "Third pay",
      nextExpectedOn: "2026-07-01",
      nextExpectedAmountCents: 50_000,
      kind: "income",
      cadence: "monthly",
    });
    // the same four days late, and short: it buys nothing
    spendLinked("2026-07-05", 30_000, "Income > Salary", short);
    const partial = incomeExpectation(bundle.db, "2026-07-01", "2026-07-31", "2026-07-08");
    expect(partial.passedUnpaidOccurrences).toBe(1);
    expect(partial.passedUnpaidCents).toBe(50_000);
  });

  test("nothing has passed on the period's first day, whatever the schedule pays", () => {
    createSeries({
      name: "Cash job (weekly pay)",
      nextExpectedOn: "2026-06-01",
      nextExpectedAmountCents: 104_600,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    const got = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-01");
    expect(got.passedUnpaidOccurrences).toBe(0);
    expect(got.expectedCents).toBe(104_600 * 5);
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

/*
 * ⚖️ OWNER DECISION 2026-10-13 (§6A 68): the header's "in so far" prints "—", not "$0.00", while NO day of the month
 * has been checked in the accounts the pay lands in — the frontier the passed paydays' sentence beneath it names
 * (`checkedThroughBySeries`). 🔴 Measured on his ledger copy 2026-10-12: "$0.00 in so far, $3,425.76 still expected"
 * over an October nothing had read — Wells Fargo, where It America LLC's pay lands, checked through Sep 24.
 */
describe("incomeExpectation — §6A 68: no income day of the month checked", () => {
  let checkingId: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  });

  /** a weekly pay series landing in Checking, Thursdays from Jun 4 */
  function weeklyPay(name = "It America LLC (weekly pay)", accountId: string = checkingId): string {
    const id = createSeries({
      name,
      nextExpectedOn: "2026-06-04",
      nextExpectedAmountCents: 114_192,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    bundle.db.update(recurringSeries).set({ accountId }).where(eq(recurringSeries.id, id)).run();
    return id;
  }

  const month = (today: string) => incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", today);

  test("checked only through the month before, nothing posted: no day of the month is read", () => {
    weeklyPay();
    checkedThrough(bundle.db, checkingId, "2026-05-28");
    const got = month("2026-06-12");
    expect(got.postedCents).toBe(0);
    expect(got.noIncomeDayRead).toBe(true);
  });

  test("one day of the month checked is a day read — the $0.00 stands, as today", () => {
    weeklyPay();
    checkedThrough(bundle.db, checkingId, "2026-06-01");
    expect(month("2026-06-12")).toMatchObject({ postedCents: 0, noIncomeDayRead: false });
  });

  test("an account the pay lands in with no checked record reads no day", () => {
    weeklyPay();
    expect(month("2026-06-12").noIncomeDayRead).toBe(true);
  });

  // ⛔ §6A 64's rule for a row found: a deposit in the ledger is money in so far, whatever day the balances reach
  test("income posted in the month keeps its figure, however far the balances are checked", () => {
    weeklyPay();
    checkedThrough(bundle.db, checkingId, "2026-05-28");
    spend("2026-06-04", 114_192, "Income > Salary", checkingId);
    expect(month("2026-06-12")).toMatchObject({ postedCents: 114_192, noIncomeDayRead: false });
  });

  test("with two schedules, one checked into the month is enough — some day of it was read", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const savings = createAccount(bundle.db, { institutionId: chase.id, name: "Savings", type: "savings" });
    weeklyPay();
    weeklyPay("Tutoring (weekly pay)", savings);
    checkedThrough(bundle.db, checkingId, "2026-05-28");
    checkedThrough(bundle.db, savings, "2026-06-05");
    expect(month("2026-06-12").noIncomeDayRead).toBe(false);
  });

  /*
   * ⚖️ /spending asks this rule of every window since 2026-10-21 (`noIncomeDayReadOf`), and a ledger with no live pay
   * schedule has no "accounts that pay lands in" to wait for. 🔴 Asked as `live.every(...)`, it was vacuously true
   * there: every window with no income would have read "Not one day of … has been checked in the accounts that pay lands
   * in". Invisible before /spending asked it — /budgets prints the clause only with income expected or posted, and the
   * dashboard's card only with a confirmed schedule.
   */
  test("with no live pay schedule there is nothing to wait for — a month with nothing posted keeps its $0.00", () => {
    checkedThrough(bundle.db, checkingId, "2026-05-28");
    expect(month("2026-06-12")).toMatchObject({ postedCents: 0, noIncomeDayRead: false });
    // an ended or dismissed schedule is not live either
    const ended = weeklyPay();
    bundle.db.update(recurringSeries).set({ status: "ended" }).where(eq(recurringSeries.id, ended)).run();
    expect(month("2026-06-12").noIncomeDayRead).toBe(false);
  });
});

/*
 * 🔴 "COUNTED IN NEITHER FIGURE ABOVE" OF A DEPOSIT "IN SO FAR" COUNTS (review of 5c1c4903, MEDIUM — the dashboard's
 * tile, and this header's sentence by the same two readings). The passed paydays are settlement's, which reads only
 * rows ATTACHED to the pay (`lib/payday-settlement`); "in so far" counts every row filed under Income (`hisIncomeRows`).
 * Jun 11's deposit filed Income › Salary from the review queue and attached to nothing is in both.
 */
describe("incomeExpectation — Income in so far that no pay schedule is attached to", () => {
  let checkingId: string;
  let pay: string;

  beforeEach(() => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    pay = createSeries({
      name: "It America LLC (weekly pay)",
      nextExpectedOn: "2026-06-04",
      nextExpectedAmountCents: 114_192,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    bundle.db.update(recurringSeries).set({ accountId: checkingId }).where(eq(recurringSeries.id, pay)).run();
    // Jun 4's payroll, attached; Jun 11's and its three days to land checked
    credit(checkingId, "2026-06-04", 114_192, "Income > Salary", pay);
    checkedThrough(bundle.db, checkingId, "2026-06-15");
  });

  /** a credit on `accountId`, filed under `categoryPath`, attached to `seriesId` or to nothing */
  function credit(accountId: string, postedOn: string, cents: number, categoryPath: string, seriesId?: string): void {
    seq += 1;
    const rawDescription = `CREDIT ${seq}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents: cents,
        rawDescription,
        normalizedDescription: rawDescription,
        categoryId: catId(categoryPath),
        recurringSeriesId: seriesId ?? null,
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents: cents, rawDescription, occurrenceIndex: 0 }),
      })
      .run();
  }

  const month = () => incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-06-16");

  test("a deposit filed as Income where the pay lands, attached to nothing, is named as in so far", () => {
    credit(checkingId, "2026-06-11", 114_192, "Income > Salary");
    const got = month();
    // in so far counts Jun 11's deposit, while settlement — attached rows only — leaves Jun 11 passed unpaid
    expect(got.postedCents).toBe(2 * 114_192);
    expect([got.passedUnpaidOccurrences, got.passedUnpaidCents]).toEqual([1, 114_192]);
    expect(got.postedUnattachedCents).toBe(114_192);
  });

  test("Income attached to nothing where the pay does not land is not, filed as his pay is or not", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const savings = createAccount(bundle.db, { institutionId: chase.id, name: "Savings", type: "savings" });
    credit(savings, "2026-06-11", 114_192, "Income > Salary");
    const got = month();
    expect(got.postedCents).toBe(2 * 114_192);
    expect(got.passedUnpaidCents).toBe(114_192);
    expect(got.postedUnattachedCents).toBe(0);
  });

  // ⚖️ …nor where it lands filed as no pay of his is filed: his Sep 4 reimbursement from It America LLC (2026-09-28)
  test("Income attached to nothing where the pay lands, filed as a reimbursement, is not", () => {
    credit(checkingId, "2026-06-05", 46_820, "Income > Refunds & Reimbursements");
    const got = month();
    expect(got.postedCents).toBe(114_192 + 46_820);
    expect(got.passedUnpaidCents).toBe(114_192);
    expect(got.postedUnattachedCents).toBe(0);
  });

  // ⛔ …and with two schedules, one schedule's account and the other's filing make it neither one's pay
  test("Income where one schedule lands, filed as another's pay is filed, is neither's", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const savings = createAccount(bundle.db, { institutionId: chase.id, name: "Savings", type: "savings" });
    const tutoring = createSeries({
      name: "Tutoring (weekly pay)",
      nextExpectedOn: "2026-06-03",
      nextExpectedAmountCents: 30_000,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
    });
    bundle.db.update(recurringSeries).set({ accountId: savings }).where(eq(recurringSeries.id, tutoring)).run();
    credit(savings, "2026-06-03", 30_000, "Income > Other Income", tutoring);
    // Savings is where Tutoring lands; Salary is how It America's pay is filed
    credit(savings, "2026-06-11", 114_192, "Income > Salary");
    const got = month();
    expect(got.passedUnpaidCents).toBeGreaterThan(0);
    expect(got.postedUnattachedCents).toBe(0);
  });

  // ⚖️ …while a schedule that has not paid yet is filed where he put it (`user_category_id`, the bridge's override)
  test("a schedule filed by hand before its first deposit reads its filing", () => {
    const fresh = createSeries({
      name: "Tutoring (weekly pay)",
      nextExpectedOn: "2026-06-03",
      nextExpectedAmountCents: 30_000,
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
      lastMatchedOn: null,
    });
    bundle.db
      .update(recurringSeries)
      .set({ accountId: checkingId, userCategoryId: catId("Income > Other Income") })
      .where(eq(recurringSeries.id, fresh))
      .run();
    credit(checkingId, "2026-06-10", 30_000, "Income > Other Income");
    const got = month();
    expect(got.passedUnpaidCents).toBeGreaterThan(0);
    expect(got.postedUnattachedCents).toBe(30_000);
  });

  test("Income attached to the pay is the pay's, and no payday passed unpaid", () => {
    credit(checkingId, "2026-06-11", 114_192, "Income > Salary", pay);
    expect(month()).toMatchObject({ postedCents: 2 * 114_192, passedUnpaidCents: 0, postedUnattachedCents: 0 });
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
   *
   * ⚠️ One day further is no longer unpaid but LATE (below), so the edge is pinned where the two halves of `paymentFor`
   * meet: on time to the limit, late only past it — `<` for `<=` in the first leaves the 11th paying nothing.
   */
  test("a posting EXACTLY toleranceDays late is paid on time", () => {
    const bill = createSeries({ name: "Wifi", nextExpectedOn: "2026-06-08", nextExpectedAmountCents: -5_000 });
    bindSeries(bill, "Housing");
    // default toleranceDays is 3: the 11th is exactly at the limit
    spendLinked("2026-06-11", -5_000, "Housing", bill);
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
  });

  /*
   * ⚖️ …and one day further pays it LATE (`paymentFor`): past its grace and nearer it than the next due day (his
   * decision 76), a payment is still the payment of the day it is late for. 🔴 This test pinned it overdue (review of
   * 44eb3e7) — the very cost the note above names: the $50.00 in `spentCents` and again here, as the rent paid Oct 5
   * for Oct 1 was on his shape.
   */
  test("a posting one day PAST toleranceDays pays the bill late — never overdue beside the spend that holds it", () => {
    const bill = createSeries({ name: "Wifi", nextExpectedOn: "2026-06-08", nextExpectedAmountCents: -5_000 });
    bindSeries(bill, "Housing");
    spendLinked("2026-06-12", -5_000, "Housing", bill);
    expect(budgetOverdue(bundle.db, catId("Housing"), "2026-06-01", "2026-06-20").totalCents).toBe(0);
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
    // ⚖️ its last charge on the card, and every day since read: a series lapses only on days the ledger has checked
    // (§6A 57) — this one's quiet is quiet the balance walk has looked at
    spendLinked("2025-03-01", -499, "Housing", dead);
    const read: (typeof dailyBalances.$inferInsert)[] = [];
    for (let t = Date.UTC(2025, 2, 1); t <= Date.UTC(2026, 5, 19); t += 86_400_000) {
      read.push({ accountId: cardId, day: new Date(t).toISOString().slice(0, 10), balanceCents: 0, basis: "derived" });
    }
    bundle.db.insert(dailyBalances).values(read).run();
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

/*
 * 🔴 /BUDGETS WAS THE ONE ARREARS SURFACE WITHOUT THE SPLIT. On a copy of his ledger 2026-10-08 the Housing row read
 * "$2,291.21 expected by now, not imported" in warning colour — rent and its utilities, both Oct 1, both on days no
 * import had reached — while the runway said the same $2,291.21 quietly. `budgetOverdue` called `overdueForSeries`
 * itself, so the page never learned how far the ledger had read; and where an import HAD reached the day, "not
 * imported" was false. ⛔ The runway's read amount (`arrearsReadCents`), walked over /budgets' own window — the
 * budget's period start through TODAY, inclusive, the one leg that closes on today.
 */
describe("budgetPaceStatuses — /budgets' arrears carry the read/unread split", () => {
  const TODAY = "2026-06-20";

  /** a bill on the Card, bound to Housing, under a June Housing budget */
  function housingBill(opts: { name: string; dueOn: string; cents: number; cadence?: Cadence }): string {
    const weekly = opts.cadence === "weekly";
    const id = createSeries({
      name: opts.name,
      nextExpectedOn: opts.dueOn,
      nextExpectedAmountCents: -opts.cents,
      cadence: opts.cadence,
      intervalDaysAvg: weekly ? 7 : 30,
    });
    bindSeries(id, "Housing");
    bundle.db.update(recurringSeries).set({ accountId: cardId }).where(eq(recurringSeries.id, id)).run();
    return id;
  }

  function housing(): BudgetPaceStatus {
    if (budgetStatuses(bundle.db, TODAY).every((s) => s.categoryName !== "Housing")) {
      createBudget(bundle.db, { categoryId: catId("Housing"), period: "monthly", amountCents: 300_000, startsOn: "2026-06-01" });
    }
    return budgetPaceStatuses(bundle.db, TODAY).find((s) => s.categoryName === "Housing")!;
  }

  /** An import of the Card has reached `day`: a row on it, and its balances checked through it (`checkedThrough`). */
  function cardReadThrough(day: string): void {
    spend(day, -800, "Food");
    checkedThrough(bundle.db, cardId, day);
  }

  test("a due day no checked statement has reached is unread, all of it", () => {
    housingBill({ name: "Rent", dueOn: "2026-06-08", cents: 228_570 });
    cardReadThrough("2026-06-07"); // the Card is read through Jun 7, the day before rent
    const s = housing();
    expect(s.overdueCents).toBe(228_570);
    expect(s.overdueUnreadCents).toBe(228_570);
    expect(s.overdue).toEqual([expect.objectContaining({ name: "Rent", unreadCents: 228_570 })]);
  });

  /*
   * ⚖️ Read once the Card is imported through the due day PLUS its 3 days' grace — his decision 60 (2026-10-08),
   * `dueDayIsRead`: a payment on Jun 9, 10 or 11 still pays Jun 8's rent, so an import reaching Jun 10 vouches for
   * none of it.
   */
  test("a due day is read once the Card is imported through it and its grace — not a day sooner", () => {
    housingBill({ name: "Rent", dueOn: "2026-06-08", cents: 228_570 });
    cardReadThrough("2026-06-10");
    expect(housing()).toMatchObject({ overdueCents: 228_570, overdueUnreadCents: 228_570 });
    cardReadThrough("2026-06-11");
    expect(housing()).toMatchObject({ overdueCents: 228_570, overdueUnreadCents: 0 });
  });

  test("a weekly bill read part of the way is split by amount", () => {
    housingBill({ name: "Cleaner", dueOn: "2026-06-03", cents: 5_000, cadence: "weekly" });
    cardReadThrough("2026-06-13"); // Jun 3 and Jun 10 read, each with its 3 days' grace; Jun 17 is not
    const s = housing();
    expect(s.overdueCents).toBe(15_000);
    expect(s.overdueUnreadCents).toBe(5_000);
  });

  /*
   * ⛔ THE WINDOW IS /BUDGETS' OWN. Every other arrears surface closes the day before today (`arrearsThisMonth`);
   * this one closes ON today, so "read to the end of the window" means read through today. Asked with the month's
   * window, a Card read through yesterday would call a bill due today read — "not posted" of a day nobody has seen.
   * (Weekly, so the series' first late day is read and only the window's end can decide today's.)
   *
   * 🔴 …and with no grace, or the window's end decides nothing. Since a due day is read only with its grace (his
   * decision 60), a 3-day grace read the Cleaner only through Jun 16 — short of yesterday whichever end the walk was
   * handed — and `arrearsReadCents` closing on the month's yesterday passed every test here (2026-10-13). A bill paid
   * on its day exactly is read through the Card's last day, so only the window's own end keeps today unread.
   */
  test("a bill due today, with the Card read through yesterday, is unread — the leg closes on today", () => {
    const cleaner = housingBill({ name: "Cleaner", dueOn: "2026-06-06", cents: 5_000, cadence: "weekly" });
    bundle.db.update(recurringSeries).set({ toleranceDays: 0 }).where(eq(recurringSeries.id, cleaner)).run();
    cardReadThrough("2026-06-19"); // every due day through Jun 19 read; Jun 20, today, is not
    expect(housing()).toMatchObject({ overdueCents: 15_000, overdueUnreadCents: 5_000 });
  });

  /*
   * ⛔ …AT BOTH ENDS. A budget that opens mid-month owes only from its own first day, so the walk that measures the
   * read half starts there too: from the 1st it would count Jun 3 — owed by no row — as read, and Jun 17 with it.
   */
  test("a budget that opens mid-month measures the read half over its own window", () => {
    housingBill({ name: "Cleaner", dueOn: "2026-06-03", cents: 5_000, cadence: "weekly" });
    createBudget(bundle.db, { categoryId: catId("Housing"), period: "monthly", amountCents: 300_000, startsOn: "2026-06-10" });
    cardReadThrough("2026-06-13"); // Jun 10 read, with its grace; Jun 17 is not
    expect(housing()).toMatchObject({ overdueCents: 10_000, overdueUnreadCents: 5_000 });
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

describe("budgetOneOffCents — too big to be a rate, unless a bill already accounts for it", () => {
  const notDrawn: ReadonlySet<string> = new Set(["dismissed-series"]);
  const row = (amountCents: number, recurringSeriesId: string | null = null) => ({
    amountCents,
    recurringSeriesId,
    postedOn: "2026-08-12",
    accountId: "checking",
    categoryId: "food",
  });

  test("both ends of the threshold: the plan itself is a rate, one cent over is an event", () => {
    expect(budgetOneOffCents([row(-10_000)], 10_000, notDrawn, null)).toBe(0);
    expect(budgetOneOffCents([row(-10_001)], 10_000, notDrawn, null)).toBe(10_001);
  });

  /** …a refund the same: one the size of the plan is the rate, one cent over is an event (netted as money back). */
  test("both ends of the threshold for a refund", () => {
    expect(budgetOneOffCents([row(10_000)], 10_000, notDrawn, null)).toBe(0);
    expect(budgetOneOffCents([row(10_001)], 10_000, notDrawn, null)).toBe(-10_001);
    // a purchase and its return, each over the plan, net to nothing held out
    expect(budgetOneOffCents([row(-41_264), row(41_264)], 10_000, notDrawn, null)).toBe(0);
  });

  test("a row a series drawn as recurring owns is never a one-off; a dismissed series' row is", () => {
    expect(budgetOneOffCents([row(-50_000, "live-series")], 10_000, notDrawn, null)).toBe(0);
    expect(budgetOneOffCents([row(-50_000, "dismissed-series")], 10_000, notDrawn, null)).toBe(50_000);
    expect(
      budgetOneOffCents([row(-50_000, "live-series"), row(-20_000), row(-3_000), row(2_500)], 10_000, notDrawn, null),
    ).toBe(20_000); // small spend and a small refund are the rate
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

  /*
   * 🔴 `recurringPostedCents` asked the raw LINK, so a charge tagged to a series
   * the owner DISMISSED — "not recurring i just go eat there often" — was graded
   * as a bill already paid: held out of the run-rate, with no tail (a dismissed
   * series projects none) to stand in for it. The pace under-projected exactly
   * the spending he said was habit. `seriesDrawsAsRecurring` decides; an ENDED
   * series still was a bill, and its charge stays one.
   */
  test("a charge linked to a DISMISSED series is everyday spending — extrapolated, not a bill already paid", () => {
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 30_000,
      startsOn: "2026-07-01",
    });
    const smoothies = createSeries({
      name: "YA-FIT Smoothie Bar",
      nextExpectedOn: "2026-07-10",
      nextExpectedAmountCents: -4_000,
      cadence: "weekly",
      intervalDaysAvg: 7,
      status: "dismissed",
    });
    const mealKit = createSeries({
      name: "Meal kit",
      nextExpectedOn: "2026-07-03",
      nextExpectedAmountCents: -6_000,
      status: "ended",
    });
    // the graded window is [07-01, today 07-08]: both of its ends are in…
    spendLinked("2026-07-01", -4_000, "Food > Dining", smoothies);
    spendLinked("2026-07-08", -4_000, "Food > Dining", smoothies);
    spendLinked("2026-07-03", -6_000, "Food > Dining", mealKit);
    // …and the day either side of it is not, for either status
    spendLinked("2026-06-30", -20_000, "Food > Dining", smoothies);
    spendLinked("2026-07-09", -1_000, "Food > Dining", smoothies);
    spendLinked("2026-06-30", -7_000, "Food > Dining", mealKit);
    spendLinked("2026-07-09", -2_000, "Food > Dining", mealKit);

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === id)!;
    expect(status.spentCents).toBe(17_000); // the whole period: 4k + 4k + 6k + 1k + 2k
    expect(status.recurringPostedCents).toBe(6_000); // the ended charge alone
    expect(status.expectedTailCents).toBe(0); // neither status projects a future
    expect(status.overdueCents).toBe(0);
    // variable posted = to-date 14k − recurring 6k = 8k → 8k × 23/8 = 23_000 → 14k + 0 + 23k
    expect(status.projectedCents).toBe(37_000);
    expect(status.pace).toBe("at-risk"); // under today (17k < 30k), over by the projection
  });

  /*
   * 🔴 A charge larger than the whole budget left the run-rate TWICE when a bill
   * owned it. `projectSpend` extrapolates `spent − recurringPosted − oneOff`, and
   * the one-off filter took every row larger than the plan with no link check,
   * so a live bill's charge was in both, and the second copy hid that much
   * ordinary spend from the pace. HBO Max's $260.26 against the $15.00
   * Subscriptions plan (real ledger, 2026-07-18) is the shape.
   *
   * The same $150.00 charge, four ways, each against a $100.00 plan with $40.00
   * of ordinary spend beside it — it must leave the run-rate exactly once:
   *   - LIVE series  → a bill already paid (`recurringPostedCents`), not a one-off;
   *   - ENDED series → the same: it was a bill (`seriesDrawsAsRecurring`);
   *   - UNLINKED     → a one-off;
   *   - DISMISSED    → a one-off: the owner said it is not recurring, so
   *                    `recurringPostedCents` does not take it, and this must.
   */
  test("a charge larger than the budget leaves the run-rate once — a bill already paid or a one-off, never both", () => {
    const budgetFor = (categoryPath: string) =>
      createBudget(bundle.db, {
        categoryId: catId(categoryPath),
        period: "monthly",
        amountCents: 10_000,
        startsOn: "2026-07-01",
      });
    const subs = budgetFor("Subscriptions");
    const fees = budgetFor("Fees");
    const shopping = budgetFor("Shopping");
    const food = budgetFor("Food");

    const live = createSeries({ name: "HBO Max", nextExpectedOn: "2026-07-02", nextExpectedAmountCents: -15_000 });
    const ended = createSeries({
      name: "Card annual fee",
      nextExpectedOn: "2026-07-02",
      nextExpectedAmountCents: -15_000,
      status: "ended",
    });
    const dismissed = createSeries({
      name: "YA-FIT Smoothie Bar",
      nextExpectedOn: "2026-07-02",
      nextExpectedAmountCents: -15_000,
      status: "dismissed",
    });
    spendLinked("2026-07-02", -15_000, "Subscriptions > Streaming", live);
    spendLinked("2026-07-02", -15_000, "Fees > Card Annual Fees", ended);
    spend("2026-07-02", -15_000, "Shopping > General");
    spendLinked("2026-07-02", -15_000, "Food > Dining", dismissed);
    spend("2026-07-04", -4_000, "Subscriptions > Software");
    spend("2026-07-04", -4_000, "Fees > Bank Fees");
    spend("2026-07-04", -4_000, "Shopping > Clothing");
    spend("2026-07-04", -4_000, "Food > Coffee");

    const statuses = budgetPaceStatuses(bundle.db, "2026-07-08");
    const row = (id: string) => statuses.find((s) => s.budget.id === id)!;
    // variable = the $40.00 alone → 4_000 × 23/8 = 11_500 → 19k + 0 + 11.5k, all four
    for (const id of [subs, fees, shopping, food]) {
      expect(row(id).spentCents).toBe(19_000);
      expect(row(id).expectedTailCents + row(id).overdueCents).toBe(0);
      expect({ category: row(id).categoryPath, projectedCents: row(id).projectedCents }).toEqual({
        category: row(id).categoryPath,
        projectedCents: 30_500,
      });
    }
    expect(row(subs).recurringPostedCents).toBe(15_000);
    expect(row(fees).recurringPostedCents).toBe(15_000);
    expect(row(shopping).recurringPostedCents).toBe(0);
    expect(row(food).recurringPostedCents).toBe(0);
  });

  test("the one-off threshold is STRICTLY above the plan, for a bill and for a plain charge alike", () => {
    const budgetFor = (categoryPath: string) =>
      createBudget(bundle.db, {
        categoryId: catId(categoryPath),
        period: "monthly",
        amountCents: 10_000,
        startsOn: "2026-07-01",
      });
    const atPlan = budgetFor("Food");
    const centOver = budgetFor("Shopping");
    const billAtPlan = budgetFor("Subscriptions");
    const billCentOver = budgetFor("Fees");
    spend("2026-07-02", -10_000, "Food > Dining"); // exactly the plan: a rate, extrapolated
    spend("2026-07-02", -10_001, "Shopping > General"); // one cent over: an event, not extrapolated
    const atPlanSeries = createSeries({
      name: "Streaming bundle",
      nextExpectedOn: "2026-07-02",
      nextExpectedAmountCents: -10_000,
    });
    const overPlanSeries = createSeries({
      name: "Card annual fee",
      nextExpectedOn: "2026-07-02",
      nextExpectedAmountCents: -10_001,
    });
    spendLinked("2026-07-02", -10_000, "Subscriptions > Streaming", atPlanSeries);
    spendLinked("2026-07-02", -10_001, "Fees > Card Annual Fees", overPlanSeries);
    spend("2026-07-04", -4_000, "Subscriptions > Software");
    spend("2026-07-04", -4_000, "Fees > Bank Fees");

    const statuses = budgetPaceStatuses(bundle.db, "2026-07-08");
    const row = (id: string) => statuses.find((s) => s.budget.id === id)!;
    expect(row(atPlan).projectedCents).toBe(10_000 + 28_750); // 10_000 × 23/8
    expect(row(centOver).projectedCents).toBe(10_001);
    // a bill either side of the line is a bill: only the $40.00 beside it extrapolates
    expect(row(billAtPlan).recurringPostedCents).toBe(10_000);
    expect(row(billAtPlan).projectedCents).toBe(14_000 + 11_500);
    expect(row(billCentOver).recurringPostedCents).toBe(10_001);
    expect(row(billCentOver).projectedCents).toBe(14_001 + 11_500);
  });

  /**
   * 🔴 THE RETURN OF A ONE-OFF HID ITS OWN SIZE OF ORDINARY SPEND. A purchase bigger than the plan is held out of the
   * run-rate; its return, the same size the other way, was not — so once it posted, `spent − oneOff` came to the
   * ordinary spend LESS the return, and the run-rate lost exactly that much. His ledger does this: Shopping −$412.64 on
   * 2026-05-12 and +$412.64 on 05-20 (also −/+$1,087.66 in March 2026, −/+$544.36 in February 2024), each over the
   * $280.00 plan. Measured on a copy with the budget started early, the projection fell $890.27 → $383.64 the day the
   * return posted: what had been spent so far, nothing more. A refund larger than the plan is the same event in
   * reverse — counted (the row is graded net), never a rate.
   */
  test("a purchase and its return, each over the plan, leave the run-rate together", () => {
    const shopping = createBudget(bundle.db, {
      categoryId: catId("Shopping"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-02", -41_264, "Shopping > General");
    spend("2026-07-04", -4_000, "Shopping > Clothing");
    spend("2026-07-06", 41_264, "Shopping > General");

    const row = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === shopping)!;
    expect(row.spentCents).toBe(4_000);
    // the $40.00 is the rate: 4_000 × 23/8
    expect(row.projectedCents).toBe(4_000 + 11_500);
    expect(row.pace).toBe("at-risk");
  });

  test("a refund over the plan with no purchase beside it is counted once, and the rate beside it still runs", () => {
    const shopping = createBudget(bundle.db, {
      categoryId: catId("Shopping"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-03", 12_000, "Shopping > General"); // a June purchase, returned in July
    spend("2026-07-04", -4_000, "Shopping > Clothing");

    const row = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === shopping)!;
    expect(row.spentCents).toBe(-8_000);
    // the $40.00 is the rate: 4_000 × 23/8, on top of the month netted below zero
    expect(row.projectedCents).toBe(-8_000 + 11_500);
  });

  /**
   * 🔴 A PROJECTION BELOW ZERO. Held out as an event, a refund over the plan leaves the rate beside it running — and in
   * a month the refund nets below zero, the rate added to it still came to less than nothing (review of c7a3510): on
   * his ledger copy 2026-10-12, Shopping's $280.00 budget started early read "Projected ≈ -$1,050.14" on 2024-05-10,
   * beside −$1,605.11 spent. A projection never reads below what has been spent, nor below zero: the month spends
   * nothing more than it has given back.
   */
  test("a refund over the plan that nets the month below zero projects no lower than zero", () => {
    const shopping = createBudget(bundle.db, {
      categoryId: catId("Shopping"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    spend("2026-07-03", 30_000, "Shopping > General"); // a June purchase, returned in July
    spend("2026-07-04", -4_000, "Shopping > Clothing");

    const row = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === shopping)!;
    expect(row.spentCents).toBe(-26_000);
    // −26_000 + the rate's 11_500 is still below zero
    expect(row.projectedCents).toBe(0);
    expect(row.pace).toBe("under");
  });

  /*
   * THE WIRING, not the export. Every case above holds ONE charge larger than
   * the plan, so a budget whose one-off is "the old over-plan sum, less what
   * `recurringPostedCents` already took" (`Math.max(0, overPlan − posted)`,
   * never calling `budgetOneOffCents`) passed all of them: the netting is only
   * wrong when the bill and the event are DIFFERENT rows. These two put a bill
   * and an unlinked event in the same budget, each against a $100.00 plan with
   * $40.00 of ordinary spend beside them, so only the $40.00 may extrapolate:
   *   - a SMALL bill beside the event — the netting subtracts the $10.00 bill
   *     from the event and lets that $10.00 back into the rate (14_375);
   *   - a bill LARGER than the plan beside the event — the real July 2026
   *     Subscriptions shape: HBO Max −$260.26 linked, APPLE.COM/BILL −$272.18
   *     unlinked, both over $15.00. The link-blind filter took both as one-offs
   *     on top of the posted bill, and the pace extrapolated nothing.
   */
  test("a small bill beside an unlinked charge larger than the budget: only the ordinary spend extrapolates", () => {
    const fees = createBudget(bundle.db, {
      categoryId: catId("Fees"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    const bankFee = createSeries({
      name: "Account maintenance fee",
      nextExpectedOn: "2026-07-02",
      nextExpectedAmountCents: -1_000,
    });
    spendLinked("2026-07-02", -1_000, "Fees > Bank Fees", bankFee); // a bill, under the plan
    spend("2026-07-03", -15_000, "Fees > Card Annual Fees"); // unlinked, over the plan: an event
    spend("2026-07-04", -4_000, "Fees > Interest Charges"); // the rate

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === fees)!;
    expect(status.spentCents).toBe(20_000);
    expect(status.recurringPostedCents).toBe(1_000);
    expect(status.expectedTailCents + status.overdueCents).toBe(0);
    expect(status.projectedCents).toBe(20_000 + 11_500); // 4_000 × 23/8
  });

  test("a bill larger than the budget beside an unlinked charge larger than the budget: each leaves the run-rate once", () => {
    const subs = createBudget(bundle.db, {
      categoryId: catId("Subscriptions"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    const hbo = createSeries({ name: "HBO Max", nextExpectedOn: "2026-07-02", nextExpectedAmountCents: -15_000 });
    spendLinked("2026-07-02", -15_000, "Subscriptions > Streaming", hbo); // a bill, over the plan
    spend("2026-07-03", -15_000, "Subscriptions > Software"); // unlinked, over the plan: an event
    spend("2026-07-04", -4_000, "Subscriptions > Memberships"); // the rate

    const status = budgetPaceStatuses(bundle.db, "2026-07-08").find((s) => s.budget.id === subs)!;
    expect(status.spentCents).toBe(34_000);
    expect(status.recurringPostedCents).toBe(15_000);
    expect(status.expectedTailCents + status.overdueCents).toBe(0);
    expect(status.projectedCents).toBe(34_000 + 11_500); // 4_000 × 23/8
  });

  /*
   * Split rows, mirroring `recurringPostedCents`: a part is a bill when its
   * PARENT is linked to a series drawn as recurring and the PART's category is
   * in the subtree. `spendingTransactions` explodes each part carrying its
   * parent's link, so the same question asked of the part gives the same answer.
   */
  test("a split part larger than the budget follows its parent's link — a live bill's part is not also a one-off", () => {
    const food = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    const shopping = createBudget(bundle.db, {
      categoryId: catId("Shopping"),
      period: "monthly",
      amountCents: 10_000,
      startsOn: "2026-07-01",
    });
    const live = createSeries({
      name: "Meal plan + lounge",
      nextExpectedOn: "2026-07-02",
      nextExpectedAmountCents: -30_000,
    });
    const liveRow = spendLinked("2026-07-02", -30_000, "Food > Dining", live);
    setSplits(bundle.db, liveRow, [
      { categoryId: catId("Food > Dining"), amountCents: -15_000 },
      { categoryId: catId("Travel > Flights"), amountCents: -15_000 },
    ]);
    const dismissed = createSeries({
      name: "Outlet runs",
      nextExpectedOn: "2026-07-03",
      nextExpectedAmountCents: -24_000,
      status: "dismissed",
    });
    const dismissedRow = spendLinked("2026-07-03", -24_000, "Shopping > General", dismissed);
    setSplits(bundle.db, dismissedRow, [
      { categoryId: catId("Shopping > General"), amountCents: -12_000 },
      { categoryId: catId("Travel > Hotels"), amountCents: -12_000 },
    ]);
    spend("2026-07-04", -4_000, "Food > Coffee");
    spend("2026-07-04", -2_000, "Shopping > Clothing");

    const statuses = budgetPaceStatuses(bundle.db, "2026-07-08");
    const row = (id: string) => statuses.find((s) => s.budget.id === id)!;
    expect(row(food).spentCents).toBe(19_000);
    expect(row(food).recurringPostedCents).toBe(15_000); // the Food part, not the $300.00 parent
    expect(row(food).projectedCents).toBe(19_000 + 11_500); // 4_000 × 23/8
    expect(row(shopping).spentCents).toBe(14_000);
    expect(row(shopping).recurringPostedCents).toBe(0);
    expect(row(shopping).projectedCents).toBe(14_000 + 5_750); // the $120.00 part is a one-off; 2_000 × 23/8
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
    // ⚖️ …and it PAYS the 07-25 bill — the calendar's test (`paymentFor`), drawn as that day's row — so the tail no
    // longer lists it beside the spend that holds it (`stillToComeReader`, review of 50020a2). It listed 180k here
    // while the series still projected 07-25.
    expect(status.expectedTailCents).toBe(0);
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


/**
 * Coverage is the day every account a category is SPENT FROM has been imported
 * through (`observationFrontier` → `frontierForSeries`), never the category's
 * own newest row.
 *
 * 🔴 The newest row let one fresh account vouch for a lagging one. Measured on
 * the real ledger 2026-09-15: /budgets read Food "spending imported through Sep
 * 12" (its newest row, on Venture X) while Chase Sapphire, 44% of Food over the
 * six months before, had been imported only through Sep 2 and Chase Checking
 * through Aug 12. The same day the dashboard said 94% of spending posts to
 * accounts shown through Aug 12 at the earliest.
 *
 * Every test grades an Aug 2026 window at 2026-08-11, so the accounts window
 * opens 2026-02-01 (the six full months before August) unless the period opens
 * earlier.
 */
describe("data coverage (uncoveredDays / importedThroughOn)", () => {
  const TODAY = "2026-08-11";

  function account(name: string, type: "checking" | "investment" = "checking"): string {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    return createAccount(bundle.db, { institutionId: chase.id, name, type });
  }

  function foodBudget(startsOn = "2026-08-01", period: "monthly" | "annual" = "monthly") {
    createBudget(bundle.db, { categoryId: catId("Food"), period, amountCents: 100_000, startsOn });
    return budgetPaceStatuses(bundle.db, TODAY).find((x) => x.categoryName === "Food")!;
  }

  test("a period the ledger does not reach reports the uncovered stretch", () => {
    spend("2026-08-03", -5_000, "Food");
    const s = foodBudget();
    expect(s.importedThroughOn).toBe("2026-08-03");
    expect(s.spentFromSince).toBe("2026-02-01");
    expect(s.spentFromAccounts).toBe(1);
    expect(s.uncoveredDays).toBe(8); // 04-Aug .. 11-Aug inclusive
  });

  test("a category with no rows at all reports null and the whole elapsed window", () => {
    createBudget(bundle.db, {
      categoryId: catId("Travel"),
      period: "monthly",
      amountCents: 50_000,
      startsOn: "2026-08-01",
    });
    const s = budgetPaceStatuses(bundle.db, TODAY).find((x) => x.categoryName === "Travel")!;
    expect(s.importedThroughOn).toBeNull();
    expect(s.spentFromAccounts).toBe(0);
    // its page's day is the ledger's, and an empty ledger has none: every elapsed day is unread
    expect(s.borrowedDay).toEqual({ whose: "ledger", on: null });
    expect(s.uncoveredDays).toBe(11);
  });

  test("data reaching today leaves nothing uncovered", () => {
    spend("2026-08-11", -5_000, "Food");
    expect(foodBudget().uncoveredDays).toBe(0);
  });

  test("data from a PRIOR period covers none of this one, and never over-counts", () => {
    spend("2026-07-20", -5_000, "Food");
    const s = foodBudget();
    expect(s.importedThroughOn).toBe("2026-07-20");
    expect(s.uncoveredDays).toBe(11); // the elapsed window, not the 22 days since the row
  });

  test("a CHILD's spending counts as coverage for its parent's budget", () => {
    spend("2026-08-09", -2_500, "Food > Coffee");
    const s = foodBudget();
    expect(s.importedThroughOn).toBe("2026-08-09");
    expect(s.uncoveredDays).toBe(2);
  });

  test("a row dated today on one account cannot vouch for an account it is also spent from that lags", () => {
    /*
     * The one reachable path to a green verdict over unimported days: a cash row
     * typed for today (addManualTransaction accepts any category and date) while
     * the card that carries most of the category is weeks behind. The newest
     * row read Aug 11, left 0 days uncovered and graded "On track".
     */
    const wallet = account("Wallet");
    spend("2026-06-14", -9_000, "Food");
    spend("2026-08-03", -5_000, "Food"); // the card's newest row — its import frontier
    spend("2026-08-11", -1_200, "Food", wallet);
    const s = foodBudget();
    expect(s.importedThroughOn).toBe("2026-08-03");
    expect(s.spentFromAccounts).toBe(2);
    expect(s.uncoveredDays).toBe(8);
    expect(budgetVerdict(s).withheld).toBe(true);
  });

  test("a quiet category is covered through the day its accounts are imported, not through its own last charge", () => {
    // the card has been imported through today on another category's row, so
    // August's missing Travel is a measured zero rather than an unread window
    spend("2026-06-05", -40_000, "Travel");
    spend("2026-08-11", -1_000, "Food");
    createBudget(bundle.db, { categoryId: catId("Travel"), period: "monthly", amountCents: 50_000, startsOn: "2026-08-01" });
    const s = budgetPaceStatuses(bundle.db, TODAY).find((x) => x.categoryName === "Travel")!;
    expect(s.importedThroughOn).toBe("2026-08-11");
    expect(s.uncoveredDays).toBe(0);
  });

  test("the accounts window opens six full months back: a day earlier does not hold the budget back, the first day does", () => {
    // ⛔ a date window has two ends. The wallet lags at Jul 1 either way; only
    // whether it carried Food inside Feb 1 .. today decides whether it counts.
    const dormant = account("Dormant");
    spend("2026-01-31", -2_000, "Food", dormant);
    spend("2026-07-01", -2_000, "Shopping", dormant);
    spend("2026-08-11", -1_000, "Food");
    const outside = foodBudget();
    expect(outside.spentFromAccounts).toBe(1);
    expect(outside.uncoveredDays).toBe(0);

    spend("2026-02-01", -2_000, "Food", dormant);
    const inside = budgetPaceStatuses(bundle.db, TODAY).find((x) => x.categoryName === "Food")!;
    expect(inside.spentFromAccounts).toBe(2);
    expect(inside.importedThroughOn).toBe("2026-07-01");
    expect(inside.uncoveredDays).toBe(11);
  });

  test("a period that opens before the six-month window keeps every account spent from inside the period", () => {
    const wallet = account("Wallet");
    spend("2026-01-15", -2_000, "Food", wallet);
    spend("2026-08-11", -1_000, "Food");
    const s = foodBudget("2026-01-01", "annual");
    expect(s.spentFromSince).toBe("2026-01-01");
    expect(s.importedThroughOn).toBe("2026-01-15");
    expect(s.uncoveredDays).toBe(208); // Jan 16 .. Aug 11 inclusive
  });

  /*
   * 🔴 This pinned the whole window unread (11 days) — a statement no import could bring, while the category's page
   * counted the same window against the ledger's day (§6A 49, `categoryReachFor`). On one page the budget card and the
   * headline over it named two days and two counts (review of e37997b, measured on a copy of his ledger copy
   * 2026-10-12). ⛔ The row asks the page's day: no ancestor here, so the ledger's.
   */
  test("spending only on accounts with no import date says there were accounts, and counts against its page's day", () => {
    // investment accounts are priced, not imported, so they have no frontier
    spend("2026-08-05", -3_000, "Food", account("Brokerage", "investment"));
    const s = foodBudget();
    expect(s.importedThroughOn).toBeNull();
    expect(s.spentFromAccounts).toBe(1);
    // the ledger reaches its one row, Aug 5: Aug 6 – 11 are the days nobody has looked at
    expect(s.borrowedDay).toEqual({ whose: "ledger", on: "2026-08-05" });
    expect(s.uncoveredDays).toBe(6);
    expect(budgetCoverageSentence(s)).toBe(
      "spent only from accounts with no import date since Feb 1 · the ledger imported through Aug 5 · 6 days of this period unaccounted",
    );
  });

  test("⚖️ a cash wallet is left out: its row inside the window neither holds the budget back nor counts as an account", () => {
    /*
     * OWNER DECISION, 2026-09-15: budgets leave cash wallets out of the
     * imported-through day. A wallet has no statements, so its frontier was its
     * newest typed row and no import could move it. Measured 2026-09-15 on the
     * real ledger (read-only): Car read "spending imported through Aug 11" —
     * Cash on Hand's one row, the $5,000 down payment — beside Chase Checking
     * (Aug 12) and Venture X (Sep 13); copies with both cards imported further
     * held it at Aug 11 until Mar 1, 2027. It follows Chase Checking now.
     *
     * Until this decision the test pinned the opposite: Aug 31 held at the
     * wallet's Feb 14 (31 days, withheld).
     */
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-02-10", openingBalanceCents: 10_000 });
    addManualTransaction(bundle.db, {
      accountId: wallet,
      postedOn: "2026-02-14",
      amountCents: -5_000,
      description: "CASH",
      categoryId: catId("Food"),
    });
    spend("2026-06-10", -2_000, "Food"); // the card, spent from inside both windows below
    spend("2026-09-01", -1_000, "Food"); // …and imported through Sep 1
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 100_000, startsOn: "2026-08-01" });
    const food = (today: string) => budgetPaceStatuses(bundle.db, today).find((x) => x.categoryName === "Food")!;

    // Aug 31: the window opens Feb 1 and holds the wallet's Feb 14 — which is left out
    const inside = food("2026-08-31");
    expect(inside.spentFromAccounts).toBe(1);
    expect(inside.spentFromWallets).toBe(1);
    expect(inside.importedThroughOn).toBe("2026-09-01");
    expect(inside.uncoveredDays).toBe(0);
    expect(budgetVerdict(inside).withheld).toBe(false);

    // ⛔ two ends. Sep 1: the window opens Mar 1, the wallet's row leaves it, and nothing else moves
    const outside = food("2026-09-01");
    expect(outside.spentFromAccounts).toBe(1);
    expect(outside.spentFromWallets).toBe(0);
    expect(outside.importedThroughOn).toBe("2026-09-01");
    expect(outside.uncoveredDays).toBe(0);
    expect(budgetVerdict(outside).withheld).toBe(false);
  });

  test("⚖️ a category spent only from cash wallets says so, makes no pace claim, and is not in the coverage note", () => {
    /*
     * The other half of the decision. With wallets left out, such a category has
     * no import date and no statement will ever bring one: "Awaiting statements"
     * would promise something that never arrives, and a graded "On track" would
     * treat the typed rows as all of it.
     */
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-01", openingBalanceCents: 50_000 });
    addManualTransaction(bundle.db, {
      accountId: wallet,
      postedOn: "2026-08-05",
      amountCents: -2_000,
      description: "CASH LUNCH",
      categoryId: catId("Food"),
    });
    spend("2026-08-11", -1_000, "Shopping"); // the card is imported through today, on another category
    const s = foodBudget();
    expect(s.importedThroughOn).toBeNull();
    expect(s.spentFromAccounts).toBe(0);
    expect(s.spentFromWallets).toBe(1);
    // ⛔ fail-safe: the day count stays the whole elapsed window, so a reader of `uncoveredDays` alone still withholds
    expect(s.uncoveredDays).toBe(11);
    const v = budgetVerdict(s);
    expect(v.headline).toBe("Cash only");
    expect(v.withheld).toBe(true);
    expect(budgetCoverageSentence(s)).toBe("spent only from a cash wallet since Feb 1 — no statement will ever cover it");
    const notes = budgetSectionNotes({ rows: [{ ...s, overdueBills: 0 }] });
    expect(notes.find((n) => n.id === "budgets-coverage")).toBeUndefined();
    // ⚖️ §6A 64: no import will ever read a wallet's day, so its typed figures are never dashed for want of one
    expect(s.noDayRead).toBe(true);
    expect(v.unread).toBe(false);
  });

  /*
   * ⚖️ OWNER DECISION 2026-10-12 (§6A 64): where NO elapsed day of a budget's window is imported, Spent and Left print
   * "—" (the plan stays) — the dashboard's pace tile and the category headline's rule (`lib/empty-period::emptyFigure`),
   * asked of the row's OWN window and day: the ones `uncoveredDays` is counted on. 🔴 Measured on his ledger copy
   * 2026-10-12: all 12 rows read "Spent $0.00 · Left $X" over an October the accounts they are spent from were imported
   * through Aug 12 or Sep 2 — "you have spent nothing" of a month nobody had looked at.
   */
  describe("⚖️ §6A 64 — whether one elapsed day of the window has been read", () => {
    test("an account read only before the window opens leaves no day of it read and no row in it: a dash", () => {
      spend("2026-07-20", -5_000, "Food");
      const s = foodBudget();
      expect(s.uncoveredDays).toBe(11);
      expect(s.noDayRead).toBe(true);
      expect(s.txnCount).toBe(0);
      expect(budgetVerdict(s).unread).toBe(true);
    });

    test("an empty ledger has read nothing either", () => {
      createBudget(bundle.db, { categoryId: catId("Travel"), period: "monthly", amountCents: 50_000, startsOn: "2026-08-01" });
      const s = budgetPaceStatuses(bundle.db, TODAY).find((x) => x.categoryName === "Travel")!;
      expect(s.noDayRead).toBe(true);
      expect(budgetVerdict(s).unread).toBe(true);
    });

    // ⛔ two ends: the window's first day read is a floor, not a dash
    test("one day read keeps the lower-bound shape", () => {
      spend("2026-07-20", -5_000, "Food");
      spend("2026-08-01", -1_000, "Shopping"); // the card Food is spent from, read through Aug 1
      const s = foodBudget();
      expect(s.importedThroughOn).toBe("2026-08-01");
      expect(s.uncoveredDays).toBe(10);
      expect(s.noDayRead).toBe(false);
      expect(budgetVerdict(s).unread).toBe(false);
    });

    test("a fresher account's charge inside the window is found — a floor, never a dash", () => {
      const fresh = account("Fresh");
      spend("2026-07-20", -5_000, "Food"); // the card: Food's day, Jul 20
      spend("2026-08-05", -1_200, "Food", fresh);
      const s = foodBudget();
      expect(s.importedThroughOn).toBe("2026-07-20");
      expect(s.noDayRead).toBe(true);
      expect([s.txnCount, s.spentCents]).toEqual([1, 1_200]);
      expect(budgetVerdict(s).unread).toBe(false);
    });
  });
});

/**
 * Opt-in rollover (migration 0012). Each accumulation rule gets its own test
 * because each one exists to REFUSE a specific dishonest number, and a rule that
 * is only implied by a happy-path assertion is a rule the next pass will delete.
 */
describe("rollover", () => {
  /*
   * ⚖️ A closed period banks only once every day of it is read (decision 67, below), so these rules are tested over a
   * card imported from Jan 2 through Jul 1: every closed period they walk is read whole, Food spent from it or not.
   */
  beforeEach(() => {
    spend("2026-01-02", -1, "Shopping");
    spend("2026-07-01", -1, "Shopping");
  });

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
    expect(carryInto(bundle.db, budget, "2026-06-15", "2026-06-15")).toEqual({
      cents: 160_00,
      heldBack: [],
      billMayLapse: [],
      mayAddCents: 0,
      readOn: { whose: "category", ancestor: null },
    });
  });
});

/*
 * ⚖️ OWNER DECISION 2026-10-13 (decision 67): a CLOSED period with ANY day not yet read — by the day its category page
 * asks that window against (`categoryReachFor`) — banks NOTHING into the carry until its statements land. The carry is
 * derived on every load, so it arrives on its own. 🔴 Measured on his ledger copy 2026-10-12: September banked $761.52
 * that no statement confirmed — Cash & ATM $130.00 and Fees $15.00 with no day of it read, Food $399.28, Shopping
 * $19.55, Transport $127.69 and Travel $70.00 read in part ("Available $355.64 ($227.95 plan + $127.69 rolled over)").
 */
describe("⚖️ decision 67 — a closed period with a day not yet read banks nothing", () => {
  function rollingBudget(categoryPath: string, startsOn: string, period: "monthly" | "weekly" = "monthly"): string {
    const id = createBudget(bundle.db, { categoryId: catId(categoryPath), period, amountCents: 500_00, startsOn });
    setBudgetRollover(bundle.db, id, { enabled: true });
    return id;
  }

  function carried(categoryPath: string, refDate = "2026-07-15") {
    const s = budgetStatuses(bundle.db, refDate).find((r) => r.categoryPath === categoryPath);
    if (!s) throw new Error(`no ${categoryPath} budget status`);
    return { cents: s.rolloverCents, availableCents: s.availableCents, heldBack: s.rolloverHeldBack };
  }

  /** whose day the carry asked its closed periods against — what the panel's rule sentence is built from */
  function readOn(categoryPath: string, refDate = "2026-07-15") {
    const s = budgetStatuses(bundle.db, refDate).find((r) => r.categoryPath === categoryPath);
    if (!s) throw new Error(`no ${categoryPath} budget status`);
    return s.rolloverReadOn;
  }

  /** the graded window the panels below are read in — `carried`'s and `readOn`'s Jul 15 — where a day carries its year */
  const GRADED = "2026-07-01";
  const JUNE = { start: "2026-06-01", end: "2026-06-30" };
  const MAY = { start: "2026-05-01", end: "2026-05-31" };
  /** the ledger's first row, long before any budget below opens — so only the import's far end is in question */
  const ledgerOpensJan2 = () => spend("2026-01-02", -1, "Shopping");

  test("read in part, a period banks nothing until its statement lands — and then the carry arrives on its own", () => {
    ledgerOpensJan2();
    rollingBudget("Food", "2026-05-01");
    spend("2026-05-10", -100_00, "Food");
    spend("2026-06-20", -50_00, "Food"); // the card's import stops Jun 20

    // May is read whole and banks its $400; June, read through the 20th, banks nothing — not its $450
    expect(carried("Food")).toEqual({ cents: 400_00, availableCents: 900_00, heldBack: [JUNE] });

    spend("2026-06-30", -1, "Shopping"); // June's statement lands: the card is read through Jun 30
    expect(carried("Food")).toEqual({ cents: 850_00, availableCents: 1_350_00, heldBack: [] });
  });

  test("not one day of it read — Cash & ATM's and Fees' September — it banks nothing; Available is the plan", () => {
    ledgerOpensJan2();
    rollingBudget("Food", "2026-05-01");
    spend("2026-04-30", -20_00, "Food"); // the card's import stops before May opens

    expect(carried("Food")).toEqual({ cents: 0, availableCents: 500_00, heldBack: [MAY, JUNE] });
  });

  test("a day before the records begin is a day nobody has read either", () => {
    rollingBudget("Food", "2026-04-01");
    spend("2026-05-10", -100_00, "Food"); // the ledger's first row: April and May 1–9 were never imported
    spend("2026-07-01", -1, "Shopping"); // the card is read through Jul 1

    // only June banks; banking April's whole plan is the fabrication `startsOn` already refuses
    const april = { start: "2026-04-01", end: "2026-04-30" };
    expect(carried("Food")).toEqual({ cents: 500_00, availableCents: 1_000_00, heldBack: [april, MAY] });
  });

  test("⚖️ spent only from a cash wallet, a period banks by its own rule — no statement is coming to wait for", () => {
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-04-01", openingBalanceCents: 100_000 });
    for (const [postedOn, amountCents] of [["2026-04-15", -10_00], ["2026-05-10", -100_00]] as const) {
      const description = "CASH";
      addManualTransaction(bundle.db, { accountId: wallet, postedOn, amountCents, description, categoryId: catId("Food") });
    }
    rollingBudget("Food", "2026-05-01");

    expect(carried("Food")).toEqual({ cents: 900_00, availableCents: 1_400_00, heldBack: [] });
    // …and the panel says it waits for no statement, never "until the accounts … are imported" (review of 46b6e4b),
    // with the facts the row's Grading line is worded from (`budgetCoverageFact`): one wallet, since its window opens
    expect(readOn("Food")).toEqual({
      whose: "cash-only",
      ancestor: null,
      cash: { spentFromSince: expect.any(String), spentFromWallets: 1 },
    });
  });

  /*
   * 🔴 THE PANEL CONTRADICTED ITSELF (review of 44d0104): a cash-only Food whose rolling budget opens Apr 1, before the
   * ledger's first row (Apr 15), holds April back — "April 2026 is not fully imported, so nothing rolls over from it
   * yet." — and then said "…a closed period waits for no statement — none will ever cover it." An older statement could
   * bring Apr 1–14 in. It names that one case instead. Latent: none of his 57 expense categories reads cash-only
   * (his ledger copy 2026-10-21), and his rolling budgets carry from Sep 1.
   */
  test("cash only, a period before the records begin is held back — and the panel says that is what holds it", () => {
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-04-01", openingBalanceCents: 100_000 });
    for (const [postedOn, amountCents] of [["2026-04-15", -10_00], ["2026-05-10", -100_00]] as const) {
      const description = "CASH";
      addManualTransaction(bundle.db, { accountId: wallet, postedOn, amountCents, description, categoryId: catId("Food") });
    }
    rollingBudget("Food", "2026-04-01");

    const april = { start: "2026-04-01", end: "2026-04-30" };
    expect(carried("Food").heldBack).toEqual([april]);
    const panel = rolloverWaitsSentence(readOn("Food")!, GRADED);
    expect(panel).toContain("only a day before your records begin holds one back");
    expect(panel).not.toContain("none will ever cover it");
  });

  test("a category with no account of its own waits on its page's day — its parent's, never the ledger's", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const other = createAccount(bundle.db, { institutionId: chase.id, name: "Other", type: "checking" });
    ledgerOpensJan2();
    rollingBudget("Food > Coffee", "2026-05-01");
    spend("2026-05-10", -100_00, "Food");
    spend("2026-06-20", -50_00, "Food"); // Food's card stops Jun 20…
    spend("2026-07-15", -1, "Shopping", other); // …while the ledger reaches Jul 15 on another account

    expect(carried("Food > Coffee")).toEqual({ cents: 500_00, availableCents: 1_000_00, heldBack: [JUNE] });
    // 🔴 its panel said "the accounts this category has lately been spent from" — Coffee has none (review of 46b6e4b)
    expect(readOn("Food > Coffee")).toEqual({ whose: "category", ancestor: "Food" });
  });

  /*
   * 🔴 THE CASH-ONLY PARENT HAD NO TEST. The walk names the ancestor whose day it found, whatever kind that day is — a
   * cash-only parent's too — and the panel then says "…this category is read as Food is, spent only from cash
   * wallets". Dropping the name there (`ancestor: … || whose === "cash-only" ? null`) passed every test (review of
   * 9249ae7), and turned Coffee's panel into "This category is spent only from cash wallets" — false of a category with
   * no wallet row of its own. Latent: on his ledger copy 2026-10-21 none of his 57 expense categories reads a cash-only
   * day, its own or a parent's.
   */
  test("a subcategory whose parent is spent only from cash is read as its parent is — named, and banked", () => {
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-04-01", openingBalanceCents: 100_000 });
    for (const [postedOn, amountCents] of [["2026-04-15", -10_00], ["2026-05-10", -100_00]] as const) {
      const description = "CASH";
      addManualTransaction(bundle.db, { accountId: wallet, postedOn, amountCents, description, categoryId: catId("Food") });
    }
    rollingBudget("Food > Coffee", "2026-05-01"); // Coffee has no row of its own, on any account

    // read through today as Food is, so May and June bank whole — no statement is coming to wait for
    expect(carried("Food > Coffee")).toEqual({ cents: 1_000_00, availableCents: 1_500_00, heldBack: [] });
    expect(readOn("Food > Coffee")).toMatchObject({ whose: "cash-only", ancestor: "Food" });
    const panel = rolloverWaitsSentence(readOn("Food > Coffee")!, GRADED);
    expect(panel).toMatch(/^With no account of its own to wait on, this category is read as Food is — Food spent only /);
    // the row's words, its one wallet and since when (`budgetCoverageFact`), never "cash wallets" with no window
    expect(panel).toMatch(/ — Food spent only from a cash wallet since [A-Z][a-z]{2} \d{1,2} — /);
    expect(panel).toMatch(/ — so a closed period waits for no statement; only a day before your records begin /);
  });

  /*
   * 🔴 A category with no account of its own and no ancestor with a day waits on the LEDGER's — the newest day any
   * account reaches (`ledgerReaches`). Measured on a copy of his ledger 2026-10-13 (review of 46b6e4b): a $100 rolling
   * Gifts & Donations budget from Jul 1 banked July and August and held September back on the ledger's Sep 24, under a
   * sentence about the accounts Gifts "has lately been spent from" — it has none. ⚠️ And that day waits for no one
   * account: a statement missing on a lagging account does not hold the period, so the sentence promises nothing of it.
   */
  test("with no account of its own and no ancestor to ask, it waits on the ledger's day — and on no one account", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const other = createAccount(bundle.db, { institutionId: chase.id, name: "Other", type: "credit" });
    ledgerOpensJan2();
    rollingBudget("Gifts & Donations", "2026-05-01");
    spend("2026-05-31", -1, "Shopping", other); // Other is imported through May 31: its June statement has not come
    spend("2026-06-20", -1, "Shopping"); // the ledger reaches Jun 20 on the card

    expect(carried("Gifts & Donations")).toEqual({ cents: 500_00, availableCents: 1_000_00, heldBack: [JUNE] });
    expect(readOn("Gifts & Donations")).toEqual({ whose: "ledger", ancestor: null });

    spend("2026-06-30", -1, "Shopping"); // the card reaches Jun 30 — Other still stops May 31, and June banks
    expect(carried("Gifts & Donations")).toEqual({ cents: 1_000_00, availableCents: 1_500_00, heldBack: [] });
    expect(rolloverWaitsSentence(readOn("Gifts & Donations")!, GRADED)).not.toContain("missing statement");
  });

  test("with no closed period walked yet, it names the day the period now running will be asked against", () => {
    ledgerOpensJan2();
    spend("2026-06-20", -50_00, "Food");
    rollingBudget("Food > Coffee", "2026-07-01");

    expect(carried("Food > Coffee")).toEqual({ cents: 0, availableCents: 500_00, heldBack: [] });
    expect(readOn("Food > Coffee")).toEqual({ whose: "category", ancestor: "Food" });
  });

  test("a budget that does not roll over waits on nothing, and says nothing", () => {
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 500_00, startsOn: "2026-05-01" });
    expect(readOn("Food")).toBeNull();
  });

  /*
   * ⚠️ THE GAP THE PANEL'S SENTENCE STOPS SHORT OF. A period is read on the accounts the category has lately been spent
   * from (`categoryCoverage`, its documented gap: "a FIRST charge on an account the category was never spent from in
   * the window is not waited for"). The panel said flatly "a missing statement cannot bank itself as savings"; a June
   * statement missing on a card Food was never spent from is not waited for, and June banks. Pinned so the sentence
   * (`rolloverWaitsSentence`, asked of whose day the carry read — its own accounts here) and the rule move together.
   */
  test("⚠️ it waits on the accounts the category has lately been spent from — the panel's words, and no wider", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const other = createAccount(bundle.db, { institutionId: chase.id, name: "Other", type: "credit" });
    ledgerOpensJan2();
    spend("2026-05-31", -1, "Shopping", other); // Other is imported through May 31: its June statement has not come
    rollingBudget("Food", "2026-06-01");
    spend("2026-06-30", -50_00, "Food"); // Food's card is read through Jun 30

    expect(carried("Food")).toEqual({ cents: 450_00, availableCents: 950_00, heldBack: [] });
    expect(readOn("Food")).toEqual({ whose: "category", ancestor: null });
    const own = rolloverWaitsSentence(readOn("Food")!, GRADED);
    expect(own).toContain("the accounts this category has lately been spent from");
    // …while a missing statement on an account Food IS spent from holds June back
    spend("2026-05-20", -10_00, "Food", other);
    expect(carried("Food")).toEqual({ cents: 0, availableCents: 500_00, heldBack: [JUNE] });
  });

  /*
   * 🔴 ONE LIST FOR EVERY BUDGET THAT DOES NOT ROLL OVER. They were all handed the same `heldBack` array (a module-level
   * `NOTHING_CARRIED`), so a reader that wrote into one row's list wrote into every other's — and into every later
   * load's: a "September 2026 is not fully imported" line would have stood under budgets that bank nothing at all
   * (review of 73a743d). Latent: no caller writes into it today.
   */
  test("a budget that does not roll over holds back a list of its own — no other row's, and no later load's", () => {
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 500_00, startsOn: "2026-05-01" });
    createBudget(bundle.db, { categoryId: catId("Shopping"), period: "monthly", amountCents: 500_00, startsOn: "2026-05-01" });
    const [food, shopping] = budgetStatuses(bundle.db, "2026-07-15");
    expect(food!.rolloverHeldBack).toEqual([]);
    expect(food!.rolloverHeldBack).not.toBe(shopping!.rolloverHeldBack);

    try {
      (food!.rolloverHeldBack as PeriodBounds[]).push(JUNE);
    } catch {
      // a list nobody may write into is as good as one of its own
    }
    expect(shopping!.rolloverHeldBack).toEqual([]);
    expect(budgetStatuses(bundle.db, "2026-07-15").map((s) => s.rolloverHeldBack)).toEqual([[], []]);
  });

  /*
   * ⛔ `/categories/<id>` builds ONE row (`categoryBudgetRef`), and building all of them to find it walked every rolling
   * budget's carry — nine of his twelve, about 100 ms on his ledger copy 2026-10-13 — per category page. The row asked
   * for is the row the whole page would build, "also counts toward its parent" and all.
   */
  test("asked for one category, it builds that budget's row alone — the row the whole page builds", () => {
    rollingBudget("Food", "2026-05-01");
    createBudget(bundle.db, { categoryId: catId("Food > Coffee"), period: "monthly", amountCents: 50_00, startsOn: "2026-05-01" });
    createBudget(bundle.db, { categoryId: catId("Shopping"), period: "monthly", amountCents: 500_00, startsOn: "2026-05-01" });
    spend("2026-05-10", -100_00, "Food");
    const all = budgetStatuses(bundle.db, "2026-07-15");
    for (const path of ["Food", "Food > Coffee", "Shopping"]) {
      const one = budgetStatuses(bundle.db, "2026-07-15", undefined, { categoryId: catId(path) });
      expect(one, path).toEqual([all.find((s) => s.categoryPath === path)]);
    }
    expect(all.find((s) => s.categoryPath === "Food > Coffee")!.isDescendantOfBudgeted).toBe(true);
  });

  test("carryInto names the weeks it held back", () => {
    ledgerOpensJan2();
    rollingBudget("Food", "2026-06-01", "weekly"); // a Monday
    spend("2026-06-03", -40_00, "Food");
    spend("2026-06-10", -1, "Shopping"); // the card is read through Jun 10, inside the second week
    const budget = {
      categoryId: catId("Food"),
      period: "weekly" as const,
      amountCents: 500_00,
      startsOn: "2026-06-01",
      rolloverStartsOn: null,
      rolloverCapCents: null,
    };
    expect(carryInto(bundle.db, budget, "2026-06-15", "2026-06-15")).toEqual({
      cents: 460_00,
      heldBack: [{ start: "2026-06-08", end: "2026-06-14" }],
      billMayLapse: [],
      // …and the week of Jun 8, $0.00 of its $500.00 found so far, can still bank all of it once it is read
      mayAddCents: 500_00,
      readOn: { whose: "category", ancestor: null },
    });
  });

  /*
   * ⚖️ default built, not asked (2026-10-29): a period held back banks once its statements land, so the line it carries
   * into can still RISE — by at most what it would bank on the spend found in it so far, which a statement still to
   * come can only add to, at any step of the order its statements can land in. 🔴 Review of 48475ec4: Food, $30.00
   * a month rolling from Jul 1, read "Over budget by 33%" in August and spoke "over budget by at least $10.00" while
   * July, held back with $0.00 of its plan found, could still bank $30.00 — and did, on the load after July's
   * statement, with no Food added anywhere.
   */
  describe("what the periods held back can still add to the line", () => {
    /** `rolloverMayAddCents` — the most the line can still rise by once what is held back is read */
    function mayAdd(categoryPath: string, refDate = "2026-07-15"): number {
      const s = budgetStatuses(bundle.db, refDate).find((r) => r.categoryPath === categoryPath);
      if (!s) throw new Error(`no ${categoryPath} budget status`);
      return s.rolloverMayAddCents;
    }

    /** the row /budgets prints: its verdict, and whether it says its line can still rise (`lineMayRise`) */
    function verdictOf(categoryPath: string, refDate: string) {
      const s = budgetPaceStatuses(bundle.db, refDate).find((r) => r.categoryPath === categoryPath);
      if (!s) throw new Error(`no ${categoryPath} budget status`);
      return budgetVerdict(s);
    }

    /** a second Chase card, read through a day of its own */
    function card(name: string): string {
      const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
      return createAccount(bundle.db, { institutionId: chase.id, name, type: "credit" });
    }

    const MARCH = { start: "2026-03-01", end: "2026-03-31" };
    const JULY = { start: "2026-07-01", end: "2026-07-31" };
    const AUGUST = { start: "2026-08-01", end: "2026-08-31" };
    const SEPTEMBER = { start: "2026-09-01", end: "2026-09-30" };
    const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };

    test("a period read in part can still bank its plan less what is found in it — nothing once that is spent", () => {
      ledgerOpensJan2();
      rollingBudget("Food", "2026-05-01");
      spend("2026-05-10", -100_00, "Food");
      spend("2026-06-20", -50_00, "Food"); // the card's import stops Jun 20: June held back, $50.00 of it found
      expect(carried("Food")).toEqual({ cents: 400_00, availableCents: 900_00, heldBack: [JUNE] });
      expect(mayAdd("Food")).toBe(450_00);

      spend("2026-06-15", -500_00, "Food"); // past June's plan on what is found, and a statement can only add to it
      expect(carried("Food").heldBack).toEqual([JUNE]);
      expect(mayAdd("Food")).toBe(0);
    });

    /*
     * 🔴 Review of 4cd38494: a bill due in a period held back was taken as owed, as the carry counts it once the
     * period is read. But its overdue is judged on the days read so far: read, the bill may have lapsed — or be paid
     * in a later period. What is found in it is the least it will hold; what is due in it is not.
     */
    test("a bill due in it is not held against it: read, it may have lapsed, or be paid in a later period", () => {
      ledgerOpensJan2();
      rollingBudget("Food", "2026-05-01");
      spend("2026-05-10", -100_00, "Food");
      spend("2026-06-20", -50_00, "Food");
      const mealKit = createSeries({ name: "Meal Kit", nextExpectedOn: "2026-06-10", nextExpectedAmountCents: -200_00 });
      bindSeries(mealKit, "Food"); // $200.00 due Jun 10, not posted
      expect(mayAdd("Food")).toBe(450_00);

      // …nor bills past June's leftover: June can still bank its $500.00 less the $50.00 found in it
      const pantry = createSeries({ name: "Pantry", nextExpectedOn: "2026-06-12", nextExpectedAmountCents: -300_00 });
      bindSeries(pantry, "Food");
      expect(mayAdd("Food")).toBe(450_00);
    });

    /*
     * 🔴 Review of 4cd38494, reproduced: Food $500.00 rolling from Jul 1, a $450.00 Meal Kit last paid Jun 25 and
     * then cancelled, the card read and checked through Aug 31. September held back at $60.00 found plus $450.00
     * overdue was taken to bank nothing, so October read "Over budget by 17%" and spoke "over budget by at least
     * $100.00" — and once September was checked through, no Meal Kit and no Food, the series lapsed and September
     * banked $440.00: $700.00 of $1,040.00, "Awaiting statements".
     */
    test("…as a cancelled bill's: read, it lapses, and the period banks as far as the line said it could", () => {
      const fresh = card("Fresh");
      const OCT_15 = "2026-10-15";
      ledgerOpensJan2();
      const kit = createSeries({
        name: "Meal Kit",
        nextExpectedOn: "2026-07-25",
        nextExpectedAmountCents: -450_00,
        lastMatchedOn: "2026-06-25",
      });
      bindSeries(kit, "Food");
      spendLinked("2026-05-25", -450_00, "Food", kit);
      spendLinked("2026-06-25", -450_00, "Food", kit); // its last payment: cancelled after June
      spend("2026-08-31", -1, "Shopping"); // the card is read through Aug 31: September held back
      checkedThrough(bundle.db, cardId, "2026-08-31");
      checkedThrough(bundle.db, fresh, OCT_15);
      spend("2026-09-03", -60_00, "Food", fresh); // September: $60.00 of Food found
      spend("2026-10-02", -700_00, "Food", fresh); // October: $700.00
      spend(OCT_15, -1, "Shopping", fresh);
      rollingBudget("Food", "2026-07-01");

      // July and August read whole, each $500.00 less the kit then still owed; September held back with it due
      expect(carried("Food", OCT_15)).toEqual({ cents: 100_00, availableCents: 600_00, heldBack: [SEPTEMBER] });
      expect(mayAdd("Food", OCT_15)).toBe(440_00);
      // the verdict stands — his rule — and the row says its line can still rise
      expect(verdictOf("Food", OCT_15)).toMatchObject({ headline: "Over budget by 17%", lineMayRise: true });

      spend("2026-09-30", -1, "Shopping"); // September's statement lands — no Meal Kit, no Food — and is checked
      checkedThrough(bundle.db, cardId, "2026-09-30", "2026-09-01");
      expect(budgetOverdue(bundle.db, catId("Food"), "2026-09-01", "2026-09-30").totalCents).toBe(0);
      expect(carried("Food", OCT_15)).toEqual({ cents: 540_00, availableCents: 1_040_00, heldBack: [] });
    });

    /*
     * 🔴 Review of 4cd38494: it walked the carry with EVERY period held back banked at once — but they are read as
     * their accounts' day moves on, the oldest first, and a newer one still held back passes on what an older one
     * banked until its own statement lands. Food, $30.00 rolling from Jul 1: July $0.00 found and August $60.00, both
     * held back, walked whole to $0.00, so September's $40.00 read "Over budget by 33%", "no later import can undo
     * that" and "over budget by at least $10.00" — and July's statement alone, no Food added, read $40.00 of $60.00
     * ($30.00 rolled over), "Awaiting statements".
     */
    test("an older period read before a newer one lifts the line on its own — the newer, past its plan, waits", () => {
      const fresh = card("Fresh");
      const SEP_11 = "2026-09-11";
      ledgerOpensJan2();
      rollingBudget("Food", "2026-07-01");
      spend("2026-06-15", -10_00, "Food"); // Food is spent from the card…
      spend("2026-06-30", -1, "Shopping"); // …which is read through Jun 30: July and August held back
      spend("2026-08-02", -1_000_00, "Food", fresh); // August: $1,000.00 found, $500.00 past its plan
      spend("2026-09-02", -600_00, "Food", fresh); // September: $600.00 of a $500.00 line
      spend(SEP_11, -1, "Shopping", fresh);

      expect(carried("Food", SEP_11)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [JULY, AUGUST] });
      // July, read alone, banks its $500.00 — and August passes it on until its own statement lands
      expect(mayAdd("Food", SEP_11)).toBe(500_00);
      expect(verdictOf("Food", SEP_11)).toMatchObject({ headline: "Over budget by 20%", lineMayRise: true });

      spend("2026-07-31", -1, "Shopping"); // July's statement lands, no Food in it: the line rises to $1,000.00
      expect(carried("Food", SEP_11)).toEqual({ cents: 500_00, availableCents: 1_000_00, heldBack: [AUGUST] });
      expect(mayAdd("Food", SEP_11)).toBe(0); // …and August, past its plan, can only take it back
      spend("2026-08-31", -1, "Shopping");
      expect(carried("Food", SEP_11)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [] });
    });

    /*
     * ⛔ …in that order, and no other: a newer period shares its accounts' day with an older one, so it is never read
     * first. Where the older, past its plan, takes back what has banked, the newer cannot lift the line past where it
     * stands. Measured on his ledger copy 2026-10-29, at 2026-12-10 with nothing more imported: Travel, $70.00 banked
     * from September, October held back at $288.80 and November at $0.00 — banking each period held back on its own,
     * whichever left more, put $70.00 still to roll over where none can.
     */
    test("…in that order only: an older period past its plan takes back what a newer one could bank", () => {
      const fresh = card("Fresh");
      const SEP_11 = "2026-09-11";
      ledgerOpensJan2();
      rollingBudget("Food", "2026-06-01");
      spend("2026-06-10", -400_00, "Food"); // June, read whole, banks $100.00
      spend("2026-06-30", -1, "Shopping"); // the card is read through Jun 30
      spend("2026-07-05", -800_00, "Food", fresh); // July, held back: $300.00 past its plan
      spend("2026-08-05", -450_00, "Food", fresh); // August, held back: $50.00 left
      spend(SEP_11, -1, "Shopping", fresh);

      expect(carried("Food", SEP_11)).toEqual({ cents: 100_00, availableCents: 600_00, heldBack: [JULY, AUGUST] });
      // July, read first, takes the $100.00 back, and August's $50.00 cannot make it up
      expect(mayAdd("Food", SEP_11)).toBe(0);

      spend("2026-07-31", -1, "Shopping"); // July's statement lands: nothing carried, and August can still bank $50.00
      expect(carried("Food", SEP_11)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [AUGUST] });
      expect(mayAdd("Food", SEP_11)).toBe(50_00);
    });

    /*
     * ⚠️ …while a period older than the six months the newer ones share asks a window of its own (`spentFromSinceFor`):
     * an account spent from only then, and read no further, holds it back after the newer ones are read — or for good.
     * It is banked or passed, whichever leaves more, and never read as landing first. Latent: his rolling budgets carry
     * from Sep 1 (his ledger copy 2026-10-29).
     */
    test("a period held back in a window of its own lands in no order — banked or passed, whichever is more", () => {
      const old = card("Old");
      const NOV_15 = "2026-11-15";
      ledgerOpensJan2();
      rollingBudget("Food", "2026-02-01");
      spend("2026-02-10", -300_00, "Food"); // February banks $200.00
      spend("2026-03-10", -900_00, "Food", old); // March, on a card read no further: held back, $400.00 past its plan
      for (const month of ["04", "05", "06", "07", "08", "09"]) spend(`2026-${month}-10`, -500_00, "Food");
      spend("2026-10-05", -450_00, "Food"); // October, $50.00 left…
      spend("2026-10-20", -1, "Shopping"); // …and held back: the card is read through Oct 20

      expect(carried("Food", NOV_15)).toEqual({ cents: 200_00, availableCents: 700_00, heldBack: [MARCH, OCTOBER] });
      // October can be read while March is still held back: its $50.00 on the $200.00 March has not taken
      expect(mayAdd("Food", NOV_15)).toBe(50_00);
    });

    /*
     * ⛔ …and the window read in order is the NEWEST held-back period's (`findLast`), never one older than the six
     * months, in a window of its own. 🔴 Review of ca938320 (round 2): read in order from the OLDEST held-back period's
     * window (`find`), every test above still passed — none held one in a window of its own beside two in the shared
     * one. Food, $500.00 rolling from Feb 1: February banks $200.00; March, on a card read no further, is $400.00 past
     * its plan; September $300.00 past its plan and October $50.00 under it, both held back by the main card's Sep 20.
     * September is read before October and takes the $200.00 back, so nothing can rise — read in March's order, the
     * row would have dropped "at least" and said "more can still roll over" of $50.00 that cannot.
     */
    test("…the window read in order is the newest held-back period's, not one of its own beside it", () => {
      const old = card("Old");
      const fresh = card("Fresh");
      const NOV_15 = "2026-11-15";
      ledgerOpensJan2();
      rollingBudget("Food", "2026-02-01");
      spend("2026-02-10", -300_00, "Food"); // February banks $200.00
      spend("2026-03-10", -900_00, "Food", old); // March, on a card read no further: held back, $400.00 past its plan
      for (const month of ["04", "05", "06", "07", "08"]) spend(`2026-${month}-10`, -500_00, "Food");
      spend("2026-09-10", -800_00, "Food"); // September: $300.00 past its plan…
      spend("2026-09-20", -1, "Shopping"); // …and held back: the main card is read through Sep 20 — October too
      spend("2026-10-05", -450_00, "Food", fresh); // October: $50.00 left, on a second card read through Nov 15
      spend(NOV_15, -1, "Shopping", fresh);

      expect(carried("Food", NOV_15)).toEqual({
        cents: 200_00,
        availableCents: 700_00,
        heldBack: [MARCH, SEPTEMBER, OCTOBER],
      });
      // September and October share the main card's day, so September is read first and takes the $200.00 back
      expect(mayAdd("Food", NOV_15)).toBe(0);
    });

    /*
     * ⚠️ …walked both ways each, up to 256 ways (`WAYS_WALKED`); past them, one held back in a window of its own is
     * walked the way that leaves more alone — banked under its plan, passed past it — and the most is what it was.
     * Food, $500.00 rolling from Jan 1, 2025: January to August 2025 each on a card read no further, $1.00, $2.00, …
     * $128.00 left (256 ways); September 2025 $300.00 left and October $400.00 past its plan, each on its own card;
     * November at its plan on one more — the newest held back, so the one read in its window's order; every month
     * after them at its plan.
     */
    test("…past 256 ways, a period in a window of its own is walked the way that leaves more alone", () => {
      const NOV_15 = "2026-11-15";
      const left = [1_00, 2_00, 4_00, 8_00, 16_00, 32_00, 64_00, 128_00, 300_00, -400_00, 0];
      left.forEach((cents, i) => {
        const old = card(`Old ${i}`); // read no further than its one row: the month held back for good
        spend(`2025-${String(i + 1).padStart(2, "0")}-10`, -(500_00 - cents), "Food", old);
      });
      const of2026 = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"].map((month) => `2026-${month}`);
      for (const month of ["2025-12", ...of2026]) spend(`${month}-10`, -500_00, "Food"); // at their plan
      spend("2026-10-31", -1, "Shopping"); // the main card read through Oct 31
      rollingBudget("Food", "2025-01-01");

      expect(carried("Food", NOV_15).cents).toBe(0);
      expect(carried("Food", NOV_15).heldBack).toHaveLength(11);
      // all eight and September banked, October passed: $255.00 + $300.00
      expect(mayAdd("Food", NOV_15)).toBe(555_00);
    });

    test("the cap bounds it: a carry already at its cap has nothing more to take", () => {
      ledgerOpensJan2();
      const id = rollingBudget("Food", "2026-05-01");
      spend("2026-05-10", -100_00, "Food"); // May banks $400.00
      spend("2026-06-20", -50_00, "Food");
      setBudgetRollover(bundle.db, id, { enabled: true, capCents: 400_00 });
      expect(mayAdd("Food")).toBe(0);
      setBudgetRollover(bundle.db, id, { enabled: true, capCents: 600_00 });
      expect(mayAdd("Food")).toBe(200_00);
    });

    test("it reaches the period now graded through every later period, as the carry does", () => {
      rollingBudget("Food", "2026-04-01");
      spend("2026-05-10", -100_00, "Food"); // the ledger's first row: April and May 1–9 were never imported
      spend("2026-07-01", -1, "Shopping"); // the card is read through Jul 1, so June banks
      expect(carried("Food")).toEqual({
        cents: 500_00,
        availableCents: 1_000_00,
        heldBack: [{ start: "2026-04-01", end: "2026-04-30" }, MAY],
      });
      // April $500.00 and May $400.00 on what is found, June's $500.00 on top of them, as the carry adds it
      expect(mayAdd("Food")).toBe(900_00);
    });

    test("nothing held back, or no rollover: nothing more can come", () => {
      ledgerOpensJan2();
      rollingBudget("Food", "2026-05-01");
      const plan = { period: "monthly", amountCents: 500_00, startsOn: "2026-05-01" } as const;
      createBudget(bundle.db, { categoryId: catId("Shopping"), ...plan }); // rollover off
      // the ledger read through Jan 2 alone: Food holds May and June back, and could still bank both…
      expect(carried("Food").heldBack).toEqual([MAY, JUNE]);
      expect(mayAdd("Food")).toBe(1_000_00);
      // …while a budget that does not roll over carries nothing, and has nothing to add
      expect(mayAdd("Shopping")).toBe(0);

      spend("2026-06-30", -1, "Shopping"); // read through Jun 30: May and June read whole, and banked
      expect(carried("Food")).toEqual({ cents: 1_000_00, availableCents: 1_500_00, heldBack: [] });
      expect(mayAdd("Food")).toBe(0);
    });

    /*
     * 🔴 Review of ca938320 (round 2): a period READ WHOLE by its rows banked its bill's overdue as final — while that
     * bill's lapse is measured to the day its accounts are CHECKED through (`silenceMeasuredThroughBySeries`), which
     * can fall short of the period's end. The rule a held-back period already follows — a bill due in it is judged on
     * the days read so far, and once they are read it may have lapsed — held for it too, and was not applied.
     */
    describe("…and a period read whole, whose bill its statements may still let go", () => {
      /** the closed periods read whole whose bill may still lapse (`BudgetStatus.rolloverBillMayLapse`) */
      function billMayLapse(categoryPath: string, refDate: string): readonly PeriodBounds[] {
        const s = budgetStatuses(bundle.db, refDate).find((r) => r.categoryPath === categoryPath);
        if (!s) throw new Error(`no ${categoryPath} budget status`);
        return s.rolloverBillMayLapse;
      }

      const OCT_15 = "2026-10-15";

      /** Food $500.00 rolling from Sep 1; the card's rows reach Sep 30, its balances checked only through Aug 31 */
      function septemberReadWholeCheckedToAug31(): void {
        const fresh = card("Fresh");
        ledgerOpensJan2();
        spend("2026-09-30", -1, "Shopping"); // the card's rows reach Sep 30: September is read whole…
        checkedThrough(bundle.db, cardId, "2026-08-31"); // …and its balances are checked only through Aug 31
        checkedThrough(bundle.db, fresh, OCT_15);
        spend("2026-09-03", -60_00, "Food", fresh); // September: $60.00 of Food found
        spend("2026-10-02", -700_00, "Food", fresh); // October: $700.00 of a $500.00 line
        spend(OCT_15, -1, "Shopping", fresh);
        rollingBudget("Food", "2026-09-01");
      }

      /** a $450.00 Meal Kit on the card, monthly on the 25th, last paid on `lastPaidOn` */
      function mealKitLastPaid(lastPaidOn: string): void {
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2026-07-25",
          nextExpectedAmountCents: -450_00,
          lastMatchedOn: lastPaidOn,
        });
        bindSeries(kit, "Food");
        spendLinked("2026-05-25", -450_00, "Food", kit);
        spendLinked(lastPaidOn, -450_00, "Food", kit);
      }

      /*
       * 🔴 Reproduced at ca938320: Food $500.00 rolling from Sep 1, a $450.00 Meal Kit last paid Jun 25 and then
       * cancelled. September, read whole, banked $0.00 ($60.00 found and the kit owed), so October's $700.00 read
       * "Over budget by 40%", "no later import can undo that" and "over budget by at least $200.00" — and once
       * September was checked through Sep 30, no row added, the kit lapsed, September banked $440.00, and the row read
       * "Awaiting statements" at $700.00 of $940.00.
       */
      test("it can still bank the bill its statements may let go — and banks it once they do", () => {
        septemberReadWholeCheckedToAug31();
        mealKitLastPaid("2026-06-25"); // cancelled after June

        // read whole, September banks $500.00 − $60.00 − the kit's $450.00, floored at $0.00…
        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [] });
        const owed = budgetOverdue(bundle.db, catId("Food"), SEPTEMBER.start, SEPTEMBER.end).series;
        // …but checked through Sep 30 with nothing more posted, the kit is let go: it may still lapse
        expect(owed.map((s) => [s.name, s.amountCents, s.mayStillLapse])).toEqual([["Meal Kit", 450_00, true]]);
        expect(mayAdd("Food", OCT_15)).toBe(440_00);
        expect(billMayLapse("Food", OCT_15)).toEqual([SEPTEMBER]);
        // the verdict stands — his rule — and the row says its line can still rise
        expect(verdictOf("Food", OCT_15)).toMatchObject({ headline: "Over budget by 40%", lineMayRise: true });

        checkedThrough(bundle.db, cardId, "2026-09-30", "2026-09-01"); // September's statement: no kit, no row added
        expect(budgetOverdue(bundle.db, catId("Food"), SEPTEMBER.start, SEPTEMBER.end).totalCents).toBe(0);
        expect(carried("Food", OCT_15)).toEqual({ cents: 440_00, availableCents: 940_00, heldBack: [] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([0, []]);
      });

      test("the control: a bill still owed at the period's end, checked or not, stays held against it", () => {
        septemberReadWholeCheckedToAug31();
        mealKitLastPaid("2026-08-25"); // its Sep 25 is due: 36 days quiet at Sep 30, owed and not let go

        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [] });
        const owed = budgetOverdue(bundle.db, catId("Food"), SEPTEMBER.start, SEPTEMBER.end).series;
        expect(owed.map((s) => [s.name, s.amountCents, s.mayStillLapse])).toEqual([["Meal Kit", 450_00, false]]);
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([0, []]);
        expect(verdictOf("Food", OCT_15)).toMatchObject({ headline: "Over budget by 40%", lineMayRise: false });
      });

      /*
       * ⚖️ His decision 72 (2026-10-13): an over verdict over unread days keeps its figure — and here its floor too. A
       * bill that has never posted has no quiet to be measured from (`seriesStaleness`), and one on no account the
       * ledger knows has no statement that can ever check it: neither can lapse, so a period read whole keeps either
       * owed, final. Measured on his ledger copy 2026-10-29: Health's September, read whole through Oct 2, owes Gym's
       * $100.00 — never posted — and Health keeps "over budget by at least $240.59".
       */
      test("a bill never posted, or on no account, cannot lapse: it stays owed, and the over a floor", () => {
        septemberReadWholeCheckedToAug31();
        spend("2026-09-12", -300_00, "Food"); // September, $360.00 found: $140.00 left before its bills
        const gym = createSeries({
          name: "Gym",
          nextExpectedOn: "2026-09-10",
          nextExpectedAmountCents: -100_00,
          lastMatchedOn: null,
        });
        bindSeries(gym, "Food");
        const september = () => budgetOverdue(bundle.db, catId("Food"), SEPTEMBER.start, SEPTEMBER.end).series;

        // never posted: owed, final — September banks its $40.00 and no more
        expect(september().map((s) => [s.name, s.mayStillLapse])).toEqual([["Gym", false]]);
        expect(carried("Food", OCT_15)).toEqual({ cents: 40_00, availableCents: 540_00, heldBack: [] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([0, []]);
        expect(verdictOf("Food", OCT_15)).toMatchObject({ headline: "Over budget by 30%", lineMayRise: false });

        // last seen in March, with no row and no account to post to: no statement can ever measure its quiet
        const locker = createSeries({
          name: "Locker",
          nextExpectedOn: "2026-09-15",
          nextExpectedAmountCents: -30_00,
          lastMatchedOn: "2026-03-15",
        });
        bindSeries(locker, "Food");
        expect(september().map((s) => [s.name, s.mayStillLapse])).toEqual([["Gym", false], ["Locker", false]]);
        expect(carried("Food", OCT_15)).toEqual({ cents: 10_00, availableCents: 510_00, heldBack: [] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([0, []]);
      });

      /** the line /budgets prints under the row (`budgetCoverageLine`) */
      function lineOf(categoryPath: string, refDate: string): string | null {
        const s = budgetPaceStatuses(bundle.db, refDate).find((r) => r.categoryPath === categoryPath);
        if (!s) throw new Error(`no ${categoryPath} budget status`);
        return budgetCoverageLine(s);
      }

      /**
       * A $450.00 Meal Kit on the main card, monthly on the 25th, its last two paid on `paid` and the next due on
       * `next` — the card's rows reaching Sep 30, its balances checked only through `checkedOn`; September held back
       * with `septemberCents` of Food found on a card read through Sep 20; October's $700.00 on a third, read through
       * Oct 15.
       */
      function kitOnACardCheckedShort(opts: {
        paid: readonly [string, string];
        next: string;
        checkedOn: string;
        septemberCents: number;
      }): void {
        const half = card("Half");
        const fresh = card("Fresh");
        ledgerOpensJan2();
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: opts.next,
          nextExpectedAmountCents: -450_00,
          lastMatchedOn: opts.paid[1],
        });
        bindSeries(kit, "Food");
        for (const day of opts.paid) spendLinked(day, -450_00, "Food", kit);
        spend("2026-09-30", -1, "Shopping"); // the main card's rows reach Sep 30…
        checkedThrough(bundle.db, cardId, opts.checkedOn); // …its balances only `checkedOn`
        spend("2026-09-05", -opts.septemberCents, "Food", half); // September, held back: its card read through Sep 20
        spend("2026-09-20", -1, "Shopping", half);
        checkedThrough(bundle.db, half, "2026-09-20");
        spend("2026-10-02", -700_00, "Food", fresh); // October: $700.00 of a $500.00 plan
        spend(OCT_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, OCT_15);
      }

      /*
       * 🔴 Review of 73d2cbc4: a period read whole was named whenever it subtracted a bill its statements may still let
       * go — never asked whether banking that bill back could change what rolls over. Food $500.00 rolling from Aug 1:
       * August $600.00 found and the Meal Kit owed, last paid May 25 on the main card; September held back at $100.00
       * found. August is $100.00 past its plan with the kit gone, so it can bank nothing — yet the row read "Over
       * budget by 40%" over "…a bill subtracted from another may have stopped" and "…more can still roll over from
       * September 2026 once it is fully imported, and from August 2026 once its statements land, if a bill subtracted
       * from it has stopped". August's statement, checked through Aug 31 with no row added: the kit lapsed, the carry
       * stayed $0.00, and all $400.00 still to come was September's.
       */
      test("a period whose bill, let go, would still bank nothing is not named — September alone is", () => {
        kitOnACardCheckedShort({
          paid: ["2026-04-25", "2026-05-25"],
          next: "2026-06-25",
          checkedOn: "2026-07-31",
          septemberCents: 100_00,
        });
        rollingBudget("Food", "2026-08-01");
        spend("2026-08-10", -600_00, "Food"); // August: $100.00 past its plan before any bill

        const owed = budgetOverdue(bundle.db, catId("Food"), AUGUST.start, AUGUST.end).series;
        expect(owed.map((s) => [s.name, s.amountCents, s.mayStillLapse])).toEqual([["Meal Kit", 450_00, true]]);
        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [SEPTEMBER] });
        // September can still bank its $400.00 — and August nothing, its kit gone or not
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([400_00, []]);
        expect(verdictOf("Food", OCT_15)).toMatchObject({
          headline: "Over budget by 40%",
          explanation: BUDGET_JARGON.paceOverLineMayRise,
          lineMayRise: true,
        });
        expect(lineOf("Food", OCT_15)).toBe(
          "spending imported through Sep 20 · 15 days of this period unaccounted · more can still roll over from " +
            "September 2026 once it is fully imported",
        );

        checkedThrough(bundle.db, cardId, "2026-08-31", "2026-08-01"); // August's statement: no kit, no row added
        expect(budgetOverdue(bundle.db, catId("Food"), AUGUST.start, AUGUST.end).totalCents).toBe(0);
        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [SEPTEMBER] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([400_00, []]);
      });

      /*
       * ⛔ …yet one past its plan with the bill gone can still lift the line, taking back less of what an earlier
       * period carried in — so "its term with the bill gone is above zero" is not the test (the review's warning).
       * July banks $50.00 (its kit owed, and too recent to lapse); August, $520.00 found, is $20.00 past its plan once
       * the kit is let go: it takes back $20.00 of July's $50.00 rather than all of it.
       */
      test("…one past its plan even with the bill gone is named where it takes back less of an earlier carry", () => {
        kitOnACardCheckedShort({
          paid: ["2026-04-25", "2026-05-25"],
          next: "2026-06-25",
          checkedOn: "2026-07-31",
          septemberCents: 100_00,
        });
        rollingBudget("Food", "2026-07-01");
        spend("2026-08-10", -520_00, "Food");

        const owed = (p: PeriodBounds) =>
          budgetOverdue(bundle.db, catId("Food"), p.start, p.end).series.map((s) => [s.amountCents, s.mayStillLapse]);
        expect([owed(JULY), owed(AUGUST)]).toEqual([[[450_00, false]], [[450_00, true]]]);
        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [SEPTEMBER] });
        // $30.00 more from August, if its kit stopped — and September's $400.00 on top of it
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([430_00, [AUGUST]]);
        expect(verdictOf("Food", OCT_15).explanation).toBe(BUDGET_JARGON.paceOverHeldBackAndBill);
        expect(lineOf("Food", OCT_15)).toBe(
          "spending imported through Sep 20 · 15 days of this period unaccounted · more can still roll over from " +
            "September 2026 once it is fully imported, and from August 2026 once its statements land, if a bill " +
            "subtracted from it has stopped",
        );

        checkedThrough(bundle.db, cardId, "2026-08-31", "2026-08-01"); // August's statement: no kit, no row added
        expect(carried("Food", OCT_15)).toEqual({ cents: 30_00, availableCents: 530_00, heldBack: [SEPTEMBER] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([400_00, []]);
      });

      /*
       * ⛔ …and asked with the OTHER bills let go too, not only owed: two can lift the line together where neither can
       * alone. July, $400.00 found, banks $100.00 once its kit is let go — which August, $500.00 found, takes back
       * unless its kit is let go as well.
       */
      test("…two whose bills lift the line only together are both named", () => {
        kitOnACardCheckedShort({
          paid: ["2026-03-25", "2026-04-25"],
          next: "2026-05-25",
          checkedOn: "2026-05-31",
          septemberCents: 500_00, // held back, and at its plan already: it adds nothing
        });
        rollingBudget("Food", "2026-07-01");
        spend("2026-07-10", -400_00, "Food");
        spend("2026-08-10", -500_00, "Food");

        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [SEPTEMBER] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([100_00, [JULY, AUGUST]]);
      });

      /*
       * ⛔ …and with them OWED too, not only let go: under a cap, each can lift the line alone where neither adds a
       * cent once the other is let go. 🔴 Asked only with every other let go, neither was named over a line that could
       * still rise $150.00 — all of it theirs, and the row would have put it on September, held back at its plan.
       * $200.00 cap: July, $300.00 found, banks $200.00 once its kit is let go; August, $0.00 found, banks $50.00 owing
       * its kit and $500.00 without it.
       */
      test("…two that each lift the line to its cap alone are both named", () => {
        kitOnACardCheckedShort({
          paid: ["2026-03-25", "2026-04-25"],
          next: "2026-05-25",
          checkedOn: "2026-05-31",
          septemberCents: 500_00,
        });
        const id = rollingBudget("Food", "2026-07-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 200_00 });
        spend("2026-07-10", -300_00, "Food");

        expect(carried("Food", OCT_15)).toEqual({ cents: 50_00, availableCents: 550_00, heldBack: [SEPTEMBER] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([150_00, [JULY, AUGUST]]);
      });

      /*
       * ⛔ …and every way the others can land, not three of them: under a $300.00 cap, July lifts the line only with
       * August's kit let go and September's owed. $400.00 kit; July $100.00 found, August $500.00, September $200.00 —
       * every one of them read whole. Asked with every other let go, only September was named; with every other let go,
       * none, or those before it, July was still left out.
       */
      test("…every way the other bills can land is asked: three months, each named", () => {
        const fresh = card("Fresh");
        ledgerOpensJan2();
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2026-05-25",
          nextExpectedAmountCents: -400_00,
          lastMatchedOn: "2026-04-25",
        });
        bindSeries(kit, "Food");
        for (const day of ["2026-03-25", "2026-04-25"]) spendLinked(day, -400_00, "Food", kit);
        spend("2026-09-30", -1, "Shopping"); // the card's rows reach Sep 30: July to September read whole…
        checkedThrough(bundle.db, cardId, "2026-05-31"); // …and its balances checked only through May 31
        spend("2026-10-02", -700_00, "Food", fresh);
        spend(OCT_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, OCT_15);
        const id = rollingBudget("Food", "2026-07-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 300_00 });
        spend("2026-07-10", -100_00, "Food");
        spend("2026-08-10", -500_00, "Food");
        spend("2026-09-10", -200_00, "Food");

        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([300_00, [JULY, AUGUST, SEPTEMBER]]);
        expect(verdictOf("Food", OCT_15).explanation).toBe(BUDGET_JARGON.paceOverBillMayStop);
      });

      /*
       * ⚠️ Past eight such periods (2⁸ walks), each is asked with every other let go alone — exact wherever no cap is
       * reached. Nine months read whole, January to September, each owing the kit last paid Oct 25, 2025, on a card
       * checked through Nov 30, 2025: seven at their plan first (nothing to lift, whatever is let go), then August and
       * September, which lift the line only together.
       */
      test("…past eight of them, each is asked with every other let go", () => {
        const fresh = card("Fresh");
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2025-11-25",
          nextExpectedAmountCents: -450_00,
          lastMatchedOn: "2025-10-25",
        });
        bindSeries(kit, "Food");
        for (const day of ["2025-09-25", "2025-10-25"]) spendLinked(day, -450_00, "Food", kit); // the ledger opens
        spend("2026-09-30", -1, "Shopping");
        checkedThrough(bundle.db, cardId, "2025-11-30", "2025-09-01");
        spend("2026-10-02", -700_00, "Food", fresh);
        spend(OCT_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, OCT_15);
        rollingBudget("Food", "2026-01-01");
        for (const month of ["01", "02", "03", "04", "05", "06", "07"]) spend(`2026-${month}-10`, -500_00, "Food");
        spend("2026-08-10", -400_00, "Food");
        spend("2026-09-10", -500_00, "Food");

        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([100_00, [AUGUST, SEPTEMBER]]);
      });

      /*
       * 🔴 Review of 09e481d7: a period was named only where letting its bill go raised the MOST the carry can reach as
       * the periods held back are read — never asked of the line as it stands, or of any other way it can stand. Food
       * $500.00 rolling from Aug 1: August read whole, $400.00 found and the Meal Kit owed (its card checked through
       * Jul 31); September held back at $600.00 found, October at $200.00, both waiting on September's card's Sep 20.
       * The carry stands at $0.00, $0.00 or $300.00 as September and then October are read — $100.00, $0.00 or $300.00
       * with the kit let go — so the most did not move and August went unnamed: "Over budget by 10%" over "…a closed
       * period is not fully imported yet" and "…more can still roll over from September 2026 and October 2026 once they
       * are fully imported". August's statement alone, checked through Aug 31 with no row added, lifted the line
       * $100.00, and the row read "Awaiting statements".
       */
      test("…named where its bill lifts the line as it stands, though the most the carry reaches does not move", () => {
        const NOV_15 = "2026-11-15";
        const half = card("Half");
        const fresh = card("Fresh");
        ledgerOpensJan2();
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2026-06-25",
          nextExpectedAmountCents: -450_00,
          lastMatchedOn: "2026-05-25",
        });
        bindSeries(kit, "Food");
        for (const day of ["2026-04-25", "2026-05-25"]) spendLinked(day, -450_00, "Food", kit);
        spend("2026-09-30", -1, "Shopping"); // the main card's rows reach Sep 30…
        checkedThrough(bundle.db, cardId, "2026-07-31"); // …its balances only Jul 31
        spend("2026-09-05", -600_00, "Food", half); // September, held back: $100.00 past its plan
        spend("2026-09-20", -1, "Shopping", half);
        checkedThrough(bundle.db, half, "2026-09-20");
        spend("2026-10-05", -200_00, "Food", fresh); // October, held back too: $200.00 found
        spend("2026-11-02", -550_00, "Food", fresh); // November: $550.00 of a $500.00 plan
        spend(NOV_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, NOV_15);
        rollingBudget("Food", "2026-08-01");
        spend("2026-08-10", -400_00, "Food"); // August, read whole: $400.00 found and the kit owed

        expect(carried("Food", NOV_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [SEPTEMBER, OCTOBER] });
        expect([mayAdd("Food", NOV_15), billMayLapse("Food", NOV_15)]).toEqual([300_00, [AUGUST]]);
        expect(verdictOf("Food", NOV_15)).toMatchObject({
          headline: "Over budget by 10%",
          explanation: BUDGET_JARGON.paceOverHeldBackAndBill,
        });
        expect(lineOf("Food", NOV_15)).toBe(
          "spending imported through Sep 20 · 15 days of this period unaccounted · more can still roll over from " +
            "September 2026 and October 2026 once they are fully imported, and from August 2026 once its statements " +
            "land, if a bill subtracted from it has stopped",
        );

        checkedThrough(bundle.db, cardId, "2026-08-31", "2026-08-01"); // August's statement: no kit, no row added
        expect(carried("Food", NOV_15)).toEqual({
          cents: 100_00,
          availableCents: 600_00,
          heldBack: [SEPTEMBER, OCTOBER],
        });
        expect([mayAdd("Food", NOV_15), billMayLapse("Food", NOV_15)]).toEqual([200_00, []]);
        expect(verdictOf("Food", NOV_15).headline).toBe("Awaiting statements");
      });

      /*
       * 🔴 …and under a cap, where a period held back can bank to the cap whatever the bill does. $400.00 cap: August,
       * $0.00 found and the kit owed, banks $50.00 — $400.00 once it is let go; September, held back at $100.00 found,
       * can bank its $400.00 to the cap either way, so the most was $400.00 whatever the kit did. "Over budget by 27%"
       * over "…more can still roll over from September 2026 once it is fully imported" — and August's statement alone
       * lifted the line $350.00.
       */
      test("…and under a cap, where a period held back can reach the cap whatever the bill does", () => {
        kitOnACardCheckedShort({
          paid: ["2026-04-25", "2026-05-25"],
          next: "2026-06-25",
          checkedOn: "2026-07-31",
          septemberCents: 100_00,
        });
        const id = rollingBudget("Food", "2026-08-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 400_00 }); // August: $0.00 found, the kit owed

        expect(carried("Food", OCT_15)).toEqual({ cents: 50_00, availableCents: 550_00, heldBack: [SEPTEMBER] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([350_00, [AUGUST]]);
        expect(verdictOf("Food", OCT_15)).toMatchObject({
          headline: "Over budget by 27%",
          explanation: BUDGET_JARGON.paceOverHeldBackAndBill,
        });

        checkedThrough(bundle.db, cardId, "2026-08-31", "2026-08-01"); // August's statement: no kit, no row added
        expect(carried("Food", OCT_15)).toEqual({ cents: 400_00, availableCents: 900_00, heldBack: [SEPTEMBER] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([0, []]);
        expect(verdictOf("Food", OCT_15).headline).toBe("Awaiting statements");
      });

      /*
       * ⛔ …asked of EVERY way the periods held back can be read, not only the line as it stands: one held back before a
       * bill is read first. $400.00 cap, Food rolling from Jun 1; the ledger opens Jun 2, the day before a $100.00
       * kit's one charge, so June is held back for its Jun 1 ($100.00 found: $400.00 once older history reaches it).
       * July and August $400.00 found each and the kit owed for good, at their plan; September $600.00 found and the
       * kit owed, where it may still lapse; October and November held back at $100.00 found. With June passed,
       * September's kit gone or owed banks nothing; with June read, $300.00 or $200.00; with October read too, the cap
       * either way — so neither the line as it stands nor the most it can reach moves, and only the way between them
       * shows September's statement lifting it.
       */
      test("…asked of every way the periods held back can be read, not only the way he sees now", () => {
        const DEC_15 = "2026-12-15";
        const NOVEMBER = { start: "2026-11-01", end: "2026-11-30" };
        const fresh = card("Fresh");
        spend("2026-06-02", -1, "Shopping"); // the ledger opens Jun 2: June is held back for its Jun 1
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2026-07-03",
          nextExpectedAmountCents: -100_00,
          lastMatchedOn: "2026-06-03",
        });
        bindSeries(kit, "Food");
        spendLinked("2026-06-03", -100_00, "Food", kit);
        for (const month of ["07", "08"]) spend(`2026-${month}-10`, -400_00, "Food");
        spend("2026-09-10", -600_00, "Food"); // September, read whole: $600.00 found and the kit owed
        spend("2026-09-30", -1, "Shopping"); // the main card's rows reach Sep 30: October and November held back…
        checkedThrough(bundle.db, cardId, "2026-07-31", "2026-06-02"); // …its balances checked only through Jul 31
        for (const month of ["10", "11"]) spend(`2026-${month}-05`, -100_00, "Food", fresh);
        spend("2026-12-02", -700_00, "Food", fresh);
        spend(DEC_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, DEC_15);
        const id = rollingBudget("Food", "2026-06-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 400_00 });

        const owed = (p: PeriodBounds) =>
          budgetOverdue(bundle.db, catId("Food"), p.start, p.end).series.map((s) => [s.amountCents, s.mayStillLapse]);
        expect([owed(AUGUST), owed(SEPTEMBER)]).toEqual([[[100_00, false]], [[100_00, true]]]);
        expect(carried("Food", DEC_15)).toEqual({
          cents: 0,
          availableCents: 500_00,
          heldBack: [JUNE, OCTOBER, NOVEMBER],
        });
        expect([mayAdd("Food", DEC_15), billMayLapse("Food", DEC_15)]).toEqual([400_00, [SEPTEMBER]]);

        spend("2026-05-31", -1, "Shopping"); // June's history lands, no Food in it: $400.00, September takes half back
        expect(carried("Food", DEC_15)).toEqual({
          cents: 200_00,
          availableCents: 700_00,
          heldBack: [OCTOBER, NOVEMBER],
        });
        expect([mayAdd("Food", DEC_15), billMayLapse("Food", DEC_15)]).toEqual([200_00, [SEPTEMBER]]);
        checkedThrough(bundle.db, cardId, "2026-09-30", "2026-08-01"); // September's statement: no kit, no row added
        expect(carried("Food", DEC_15)).toEqual({
          cents: 300_00,
          availableCents: 800_00,
          heldBack: [OCTOBER, NOVEMBER],
        });
      });

      /*
       * ⛔ …and of both ways a period held back in a window of its own can land — not only the one that leaves more.
       * $400.00 cap, Food rolling from Mar 1: March, on a card read no further, $100.00 found — banked, it fills the
       * cap; April to August $50.00 found each beside the kit — paid in April and May, owed after, for good in June and
       * July (too recent at their ends to lapse), at their plan; August's may still lapse. September held back at its
       * plan. Banked, March leaves the cap whatever the kit does, so walked only that way, August went unnamed: "…more
       * can still roll over from March 2026 and September 2026 once they are fully imported" — and the main card's
       * statement alone, through Aug 31, no row added, lifted the line $400.00.
       */
      test("…and of both ways a period in a window of its own can land: passed, where banked fills the cap", () => {
        kitOnACardCheckedShort({
          paid: ["2026-04-25", "2026-05-25"],
          next: "2026-06-25",
          checkedOn: "2026-07-31",
          septemberCents: 500_00,
        });
        const old = card("Old");
        const id = rollingBudget("Food", "2026-03-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 400_00 });
        spend("2026-03-10", -100_00, "Food", old); // March, on a card read no further: $400.00 left
        for (const month of ["04", "05", "06", "07", "08"]) spend(`2026-${month}-10`, -50_00, "Food");

        expect(carried("Food", OCT_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [MARCH, SEPTEMBER] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([400_00, [AUGUST]]);
        expect(verdictOf("Food", OCT_15)).toMatchObject({
          headline: "Over budget by 40%",
          explanation: BUDGET_JARGON.paceOverHeldBackAndBill,
        });

        checkedThrough(bundle.db, cardId, "2026-08-31", "2026-08-01"); // the main card's statement: no kit, no row
        expect(carried("Food", OCT_15)).toEqual({
          cents: 400_00,
          availableCents: 900_00,
          heldBack: [MARCH, SEPTEMBER],
        });
        expect(verdictOf("Food", OCT_15).headline).toBe("Awaiting statements");
      });

      /*
       * ⛔ …banked, too, where passed is the way that leaves more. $400.00 cap, Food rolling from Feb 1: February banks
       * to the cap; March, on a card read no further, $400.00 past its plan; a $400.00 kit, last paid May 25 on a card
       * checked through Jul 31, owed for good in June and July ($100.00 found each: at their plan), and owed in August
       * ($100.00 found: at its plan, $400.00 left without it) and September ($500.00: $400.00 past it, at it without),
       * where it may still lapse; October held back. Passed, March leaves the cap in place, so August's kit can add
       * nothing; banked, March takes it all back, and then only August's and September's together refill it.
       */
      test("…banked, where passed fills the cap before the bill", () => {
        const NOV_15 = "2026-11-15";
        const old = card("Old");
        const fresh = card("Fresh");
        ledgerOpensJan2();
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2026-06-25",
          nextExpectedAmountCents: -400_00,
          lastMatchedOn: "2026-05-25",
        });
        bindSeries(kit, "Food");
        for (const day of ["2026-04-25", "2026-05-25"]) spendLinked(day, -400_00, "Food", kit);
        spend("2026-10-20", -1, "Shopping"); // the main card's rows reach Oct 20: October held back…
        checkedThrough(bundle.db, cardId, "2026-07-31"); // …and its balances checked only through Jul 31
        spend("2026-11-02", -700_00, "Food", fresh);
        spend(NOV_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, NOV_15);
        const id = rollingBudget("Food", "2026-02-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 400_00 });
        spend("2026-02-10", -100_00, "Food"); // February: $400.00 left, to the cap
        spend("2026-03-10", -900_00, "Food", old); // March, on a card read no further: $400.00 past its plan
        for (const month of ["04", "05", "06", "07", "08"]) spend(`2026-${month}-10`, -100_00, "Food");
        spend("2026-09-10", -500_00, "Food");
        spend("2026-10-10", -500_00, "Food");

        const owed = (p: PeriodBounds) =>
          budgetOverdue(bundle.db, catId("Food"), p.start, p.end).series.map((s) => [s.amountCents, s.mayStillLapse]);
        expect([owed(JULY), owed(AUGUST), owed(SEPTEMBER)]).toEqual([
          [[400_00, false]],
          [[400_00, true]],
          [[400_00, true]],
        ]);
        expect(carried("Food", NOV_15)).toEqual({ cents: 0, availableCents: 500_00, heldBack: [MARCH, OCTOBER] });
        expect([mayAdd("Food", NOV_15), billMayLapse("Food", NOV_15)]).toEqual([400_00, [AUGUST, SEPTEMBER]]);
      });

      /*
       * 🔴 …and past eight of them under a cap that is reached, asked only with every other let go, none was named
       * where the line could rise and nothing was held back, so the row read "a closed period is not fully imported
       * yet" of none (the review's nine months under a $100.00 cap: $50.00 carried, $50.00 still to come). Each is
       * asked alone too, and let go one by one, oldest first. The nine above, under a $100.00 cap: January to June at
       * their plan; July $400.00 found, $100.00 left once its kit is let go — which August, $500.00 found, takes back
       * unless its kit is let go as well; September $0.00 found, banking $50.00 owing its kit. September's statement
       * alone lifts the line, and August's once July's is in; July's lifts it only with August's in and September's
       * not — no way asked, so it goes unnamed.
       */
      test("…past eight of them under a reached cap: each that lifts it alone is named, and one always is", () => {
        const fresh = card("Fresh");
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2025-11-25",
          nextExpectedAmountCents: -450_00,
          lastMatchedOn: "2025-10-25",
        });
        bindSeries(kit, "Food");
        for (const day of ["2025-09-25", "2025-10-25"]) spendLinked(day, -450_00, "Food", kit); // the ledger opens
        spend("2026-09-30", -1, "Shopping");
        checkedThrough(bundle.db, cardId, "2025-11-30", "2025-09-01");
        spend("2026-10-02", -700_00, "Food", fresh);
        spend(OCT_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, OCT_15);
        const id = rollingBudget("Food", "2026-01-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 100_00 });
        for (const month of ["01", "02", "03", "04", "05", "06"]) spend(`2026-${month}-10`, -500_00, "Food");
        spend("2026-07-10", -400_00, "Food");
        spend("2026-08-10", -500_00, "Food");

        expect(carried("Food", OCT_15)).toEqual({ cents: 50_00, availableCents: 550_00, heldBack: [] });
        expect([mayAdd("Food", OCT_15), billMayLapse("Food", OCT_15)]).toEqual([50_00, [AUGUST, SEPTEMBER]]);
        expect(verdictOf("Food", OCT_15)).toMatchObject({
          headline: "Over budget by 27%",
          explanation: BUDGET_JARGON.paceOverBillMayStop,
        });
      });

      /*
       * ⛔ …and named for lifting the line past where it stands — not for making good what a period held back takes
       * back first. $400.00 cap, Food rolling from Feb 1: February banks to the cap; March, on a card read no further,
       * $400.00 past its plan; a $100.00 kit last paid May 25 on a card checked through Jul 31, owed for good in June
       * and July; August at its plan owing it, $100.00 left without it; September $50.00 past its plan owing it, $50.00
       * under without; October held back with $100.00 left. $350.00 carried: with March passed, August's kit is held
       * at the cap whatever it does; with March read, its kit's lapse lifts what is left — to $250.00 at most, with
       * September's let go and October read too, never past the $350.00 he sees. September's statement alone lifts it
       * to the cap.
       */
      test("…named only where its bill lifts the line past where it stands", () => {
        const NOV_15 = "2026-11-15";
        const old = card("Old");
        const fresh = card("Fresh");
        ledgerOpensJan2();
        const kit = createSeries({
          name: "Meal Kit",
          nextExpectedOn: "2026-06-25",
          nextExpectedAmountCents: -100_00,
          lastMatchedOn: "2026-05-25",
        });
        bindSeries(kit, "Food");
        for (const day of ["2026-04-25", "2026-05-25"]) spendLinked(day, -100_00, "Food", kit);
        spend("2026-10-20", -1, "Shopping"); // the main card's rows reach Oct 20: October held back…
        checkedThrough(bundle.db, cardId, "2026-07-31"); // …and its balances checked only through Jul 31
        spend("2026-11-02", -900_00, "Food", fresh);
        spend(NOV_15, -1, "Shopping", fresh);
        checkedThrough(bundle.db, fresh, NOV_15);
        const id = rollingBudget("Food", "2026-02-01");
        setBudgetRollover(bundle.db, id, { enabled: true, capCents: 400_00 });
        spend("2026-02-10", -100_00, "Food"); // February: $400.00 left, to the cap
        spend("2026-03-10", -900_00, "Food", old); // March, on a card read no further: $400.00 past its plan
        for (const month of ["04", "05", "06", "07", "08"]) spend(`2026-${month}-10`, -400_00, "Food");
        spend("2026-09-10", -450_00, "Food");
        spend("2026-10-10", -400_00, "Food");

        const owed = (p: PeriodBounds) =>
          budgetOverdue(bundle.db, catId("Food"), p.start, p.end).series.map((s) => [s.amountCents, s.mayStillLapse]);
        expect([owed(JULY), owed(AUGUST), owed(SEPTEMBER)]).toEqual([
          [[100_00, false]],
          [[100_00, true]],
          [[100_00, true]],
        ]);
        expect(carried("Food", NOV_15)).toEqual({ cents: 350_00, availableCents: 850_00, heldBack: [MARCH, OCTOBER] });
        expect([mayAdd("Food", NOV_15), billMayLapse("Food", NOV_15)]).toEqual([50_00, [SEPTEMBER]]);
      });
    });
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
