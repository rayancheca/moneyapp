import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { addDays } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { budgetTail, createBudget } from "./budgets";
import {
  nextMonthBounds,
  predictBudgetableCategories,
  predictBudgets,
  predictCategory,
} from "./category-forecast";

const TODAY = "2026-07-08"; // target = August 2026; trailing = Apr/May/Jun 2026

describe("nextMonthBounds", () => {
  test("the full calendar month after today's month", () => {
    expect(nextMonthBounds("2026-07-08")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });
  test("crosses the year boundary", () => {
    expect(nextMonthBounds("2026-12-15")).toEqual({ start: "2027-01-01", end: "2027-01-31" });
  });
});

describe("predictCategory / predictBudgetableCategories", () => {
  let dir: string;
  let bundle: DbBundle;
  let cardId: string;
  let seq = 0;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cf-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function categoryId(name: string): string {
    const row = bundle.db.select().from(categories).where(eq(categories.name, name)).get();
    if (!row) throw new Error(`missing category ${name}`);
    return row.id;
  }

  function insertTxn(
    postedOn: string,
    amountCents: number,
    opts: { categoryName?: string; recurringSeriesId?: string; status?: TransactionStatus } = {},
  ): void {
    seq += 1;
    const rawDescription = `FIXTURE ${seq}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId: cardId,
        postedOn,
        amountCents,
        rawDescription,
        normalizedDescription: rawDescription,
        categoryId: opts.categoryName ? categoryId(opts.categoryName) : null,
        recurringSeriesId: opts.recurringSeriesId ?? null,
        status: opts.status ?? "active",
        dedupeHash: dedupeHash({ accountId: cardId, postedOn, amountCents, rawDescription, occurrenceIndex: seq }),
      })
      .run();
  }

  function insertSeries(input: {
    name: string;
    kind: SeriesKind;
    cadence: Cadence;
    intervalDaysAvg: number;
    nextExpectedOn: string;
    nextExpectedAmountCents: number;
    status?: SeriesStatus;
    userCategoryId?: string;
    lastMatchedOn?: string;
  }): string {
    return bundle.db
      .insert(recurringSeries)
      .values({ status: "detected", toleranceDays: 3, ...input })
      .returning({ id: recurringSeries.id })
      .get().id;
  }

  test("recurring baseline + discretionary trend compose into a labeled forecast", () => {
    // discretionary Groceries spend, rising: Apr $300, May $400, Jun $500
    insertTxn("2026-04-10", -30000, { categoryName: "Groceries" });
    insertTxn("2026-05-10", -40000, { categoryName: "Groceries" });
    insertTxn("2026-06-10", -50000, { categoryName: "Groceries" });
    // a monthly subscription linked to Groceries, one occurrence next month
    const seriesId = insertSeries({
      name: "Grocery box",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-10",
      nextExpectedAmountCents: -1500,
      status: "confirmed",
    });
    insertTxn("2026-06-10", -1500, { categoryName: "Groceries", recurringSeriesId: seriesId });

    const p = predictCategory(bundle.db, categoryId("Groceries"), "Groceries", TODAY);

    expect(p.periodLabel).toBe("August 2026");
    expect(p.targetStart).toBe("2026-08-01");
    expect(p.seasonalApplied).toBe(false); // Aug 2025 predates the earliest txn (Apr 2026)
    // discretionary: trailing avg 40000 + trend (50000-30000)/2 = 10000 → 50000
    expect(p.forecast.discretionaryCents).toBe(50000);
    // recurring: one $15 occurrence in August
    expect(p.forecast.recurringCents).toBe(1500);
    expect(p.forecast.expectedTotalCents).toBe(51500);
    expect(p.forecast.parts.map((part) => part.key)).toEqual(["recurring", "discretionary"]);
    expect(p.forecast.parts[0]!.method).toBe("Expected recurring");
    expect(p.forecast.confidence).toBeGreaterThan(0);
    expect(p.forecast.confidence).toBeLessThanOrEqual(1);
  });

  test("recurring-tagged spend is not double-counted in the discretionary history", () => {
    // ALL of April's Groceries spend is recurring-tagged → discretionary excludes it
    const seriesId = insertSeries({
      name: "Grocery box",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-10",
      nextExpectedAmountCents: -1500,
      status: "confirmed",
    });
    insertTxn("2026-04-10", -1500, { categoryName: "Groceries", recurringSeriesId: seriesId });
    insertTxn("2026-05-10", -1500, { categoryName: "Groceries", recurringSeriesId: seriesId });
    insertTxn("2026-06-10", -1500, { categoryName: "Groceries", recurringSeriesId: seriesId });

    const p = predictCategory(bundle.db, categoryId("Groceries"), "Groceries", TODAY);
    // no NON-recurring history → discretionary is $0, only the recurring baseline remains
    expect(p.forecast.discretionaryCents).toBe(0);
    expect(p.forecast.recurringCents).toBe(1500);
    expect(p.forecast.expectedTotalCents).toBe(1500);
    // with no discretionary spend the recurring part is the whole forecast
    expect(p.forecast.parts.map((part) => part.key)).toEqual(["recurring", "discretionary"]);
    expect(p.forecast.basis).toMatch(/expected recurring/i);
  });

  test("a same-month-last-year figure inside coverage nudges the estimate (seasonality)", () => {
    // put earliest coverage before Aug 2025 so the seasonal anchor is offered
    insertTxn("2025-01-15", -1000, { categoryName: "Groceries" });
    insertTxn("2025-08-12", -60000, { categoryName: "Groceries" }); // Aug 2025 seasonal prior $600
    insertTxn("2026-04-10", -30000, { categoryName: "Groceries" });
    insertTxn("2026-05-10", -40000, { categoryName: "Groceries" });
    insertTxn("2026-06-10", -50000, { categoryName: "Groceries" });

    const p = predictCategory(bundle.db, categoryId("Groceries"), "Groceries", TODAY);
    expect(p.seasonalApplied).toBe(true);
    // trend 50000 blended toward 60000: 0.65*50000 + 0.35*60000 = 53500
    expect(p.forecast.discretionaryCents).toBe(53500);
    const discPart = p.forecast.parts.find((part) => part.key === "discretionary")!;
    expect(discPart.basis).toMatch(/same period last year/i);
  });

  test("seasonalApplied is false when the anchor is in coverage but moves nothing", () => {
    // coverage starts before Aug 2025 (so the anchor is offered)…
    insertTxn("2025-01-15", -1000, { categoryName: "Groceries" });
    // …but Groceries has NO non-recurring history (trend $0) and $0 last August,
    // so the seasonal blend is $0 → $0 — it must NOT claim to have adjusted.
    const seriesId = insertSeries({
      name: "Grocery box",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-10",
      nextExpectedAmountCents: -1500,
      status: "confirmed",
    });
    insertTxn("2026-06-10", -1500, { categoryName: "Groceries", recurringSeriesId: seriesId });

    const p = predictCategory(bundle.db, categoryId("Groceries"), "Groceries", TODAY);
    expect(p.forecast.recurringCents).toBe(1500);
    expect(p.forecast.discretionaryCents).toBe(0);
    expect(p.seasonalApplied).toBe(false);
  });

  test("spend tagged to a DISMISSED series folds back into the discretionary trend", () => {
    // detection flagged some variable spend as recurring; the user DISMISSED it as
    // a false positive — the rows keep their tag but the series is never projected,
    // so that spend must reappear in the discretionary estimate (not vanish).
    const dismissed = insertSeries({
      name: "Not really recurring",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-10",
      nextExpectedAmountCents: -30000,
      status: "dismissed",
    });
    insertTxn("2026-04-10", -30000, { categoryName: "Groceries", recurringSeriesId: dismissed });
    insertTxn("2026-05-10", -30000, { categoryName: "Groceries", recurringSeriesId: dismissed });
    insertTxn("2026-06-10", -30000, { categoryName: "Groceries", recurringSeriesId: dismissed });

    const p = predictCategory(bundle.db, categoryId("Groceries"), "Groceries", TODAY);
    // dismissed → not projected as recurring, but recovered into discretionary
    expect(p.forecast.recurringCents).toBe(0);
    expect(p.forecast.discretionaryCents).toBe(30000); // avg of [300,300,300]
  });

  /*
   * 🔴 Series membership here was a private copy that found series only through
   * posted rows and never read `user_category_id`, while /budgets and the
   * category page read the override. On the real ledger 2026-09-14 /spending's
   * October forecast left out $1,346.11 of registered commitments (the car
   * lease, parking, the gym, rent fees) that the budget tail projected.
   */
  test("a commitment that has never posted forecasts into the category the owner put it in", () => {
    insertSeries({
      name: "Parking",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-20",
      nextExpectedAmountCents: -36886,
      status: "confirmed",
      userCategoryId: categoryId("Parking & Tolls"),
    });

    const p = predictCategory(bundle.db, categoryId("Transport"), "Transport", TODAY);
    expect(p.forecast.recurringCents).toBe(36886);
    expect(p.forecast.basis).toMatch(/expected recurring/);
    expect(p.forecast.basis).not.toMatch(/no recurring bills/);
  });

  test("an override MOVES a posted series — it is forecast where the owner put it, not in both", () => {
    const moved = insertSeries({
      name: "Supplement box",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-20",
      nextExpectedAmountCents: -9000,
      status: "confirmed",
      lastMatchedOn: "2026-06-20",
      userCategoryId: categoryId("Health"),
    });
    insertTxn("2026-06-20", -9000, { categoryName: "Groceries", recurringSeriesId: moved });

    expect(predictCategory(bundle.db, categoryId("Food"), "Food", TODAY).forecast.recurringCents).toBe(0);
    expect(predictCategory(bundle.db, categoryId("Health"), "Health", TODAY).forecast.recurringCents).toBe(9000);
  });

  test("a dismissed series moved elsewhere still folds back into the trend where its rows sit", () => {
    // the override takes it out of Food's MEMBERSHIP, but its rows are still Food's
    const dismissed = insertSeries({
      name: "Not really recurring",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-10",
      nextExpectedAmountCents: -3000,
      status: "dismissed",
      userCategoryId: categoryId("Shopping"),
    });
    insertTxn("2026-05-10", -3000, { categoryName: "Dining", recurringSeriesId: dismissed });
    insertTxn("2026-06-10", -3000, { categoryName: "Dining", recurringSeriesId: dismissed });

    // Apr 0, May 3000, Jun 3000 → average 2000 + trend 1500
    expect(predictCategory(bundle.db, categoryId("Food"), "Food", TODAY).forecast.discretionaryCents).toBe(3500);
    expect(predictCategory(bundle.db, categoryId("Shopping"), "Shopping", TODAY).forecast.recurringCents).toBe(0);
  });

  test("a money-out series that has stopped posting is not forecast", () => {
    const lapsed = insertSeries({
      name: "Old pharmacy plan",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-01",
      nextExpectedAmountCents: -4999,
      status: "confirmed",
      lastMatchedOn: "2025-12-01",
    });
    insertTxn("2025-12-01", -4999, { categoryName: "Pharmacy", recurringSeriesId: lapsed });

    expect(predictCategory(bundle.db, categoryId("Health"), "Health", TODAY).forecast.recurringCents).toBe(0);
  });

  test("every category's forecast bills are exactly the budget tail over the target month", () => {
    insertSeries({ name: "Parking", kind: "bill", cadence: "monthly", intervalDaysAvg: 30, nextExpectedOn: "2026-08-20", nextExpectedAmountCents: -36886, status: "confirmed", userCategoryId: categoryId("Parking & Tolls") });
    const moved = insertSeries({ name: "Supplement box", kind: "subscription", cadence: "monthly", intervalDaysAvg: 30, nextExpectedOn: "2026-08-20", nextExpectedAmountCents: -9000, status: "confirmed", lastMatchedOn: "2026-06-20", userCategoryId: categoryId("Health") });
    insertTxn("2026-06-20", -9000, { categoryName: "Groceries", recurringSeriesId: moved });
    const lapsed = insertSeries({ name: "Old pharmacy plan", kind: "subscription", cadence: "monthly", intervalDaysAvg: 30, nextExpectedOn: "2026-08-01", nextExpectedAmountCents: -4999, status: "confirmed", lastMatchedOn: "2025-12-01" });
    insertTxn("2025-12-01", -4999, { categoryName: "Pharmacy", recurringSeriesId: lapsed });
    const posted = insertSeries({ name: "Grocery box", kind: "subscription", cadence: "monthly", intervalDaysAvg: 30, nextExpectedOn: "2026-08-10", nextExpectedAmountCents: -1500, status: "confirmed", lastMatchedOn: "2026-06-10" });
    insertTxn("2026-06-10", -1500, { categoryName: "Groceries", recurringSeriesId: posted });

    const predictions = predictBudgetableCategories(bundle.db, TODAY);
    expect(predictions.length).toBeGreaterThan(0);
    for (const p of predictions) {
      const tail = budgetTail(bundle.db, p.categoryId, p.targetEnd, addDays(p.targetStart, -1));
      expect([p.label, p.forecast.recurringCents]).toEqual([p.label, tail.totalCents]);
    }
  });

  test("a category with no history and no bills predicts nothing (honest zero)", () => {
    const p = predictCategory(bundle.db, categoryId("Groceries"), "Groceries", TODAY);
    expect(p.forecast.expectedTotalCents).toBe(0);
    expect(p.forecast.confidence).toBe(0);
  });

  test("predictBudgetableCategories covers every top-level expense category, sorted by amount", () => {
    insertTxn("2026-04-10", -30000, { categoryName: "Groceries" });
    insertTxn("2026-05-10", -40000, { categoryName: "Groceries" });
    insertTxn("2026-06-10", -50000, { categoryName: "Groceries" });

    const predictions = predictBudgetableCategories(bundle.db, TODAY);
    expect(predictions.length).toBeGreaterThan(0);
    // sorted descending by predicted amount
    for (let i = 1; i < predictions.length; i += 1) {
      expect(predictions[i - 1]!.forecast.expectedTotalCents).toBeGreaterThanOrEqual(
        predictions[i]!.forecast.expectedTotalCents,
      );
    }
    // Groceries rolls into its top-level parent (Food) — that parent leads
    expect(predictions[0]!.forecast.expectedTotalCents).toBe(50000);
    expect(predictions.every((p) => p.periodLabel === "August 2026")).toBe(true);
  });

  test("predictBudgets rounds the forecast UP to $10 and skips already-budgeted categories", () => {
    // Food predicts $505 (trailing 30/40/50 → avg 40 + trend 10 = 50; wait, use a value that needs rounding)
    insertTxn("2026-04-10", -30_000, { categoryName: "Groceries" });
    insertTxn("2026-05-10", -40_000, { categoryName: "Groceries" });
    insertTxn("2026-06-10", -50_500, { categoryName: "Groceries" }); // trend pushes to a non-$10 total

    const before = predictBudgets(bundle.db, TODAY);
    const food = before.find((b) => b.label === "Food")!;
    expect(food).toBeDefined();
    // amount is the forecast rounded UP to the nearest $10
    expect(food.amountCents % 1_000).toBe(0);
    expect(food.amountCents).toBeGreaterThanOrEqual(food.forecast.expectedTotalCents);
    expect(food.amountCents - food.forecast.expectedTotalCents).toBeLessThan(1_000);

    // once Food carries an active budget it is no longer proposed
    createBudget(bundle.db, { categoryId: categoryId("Food"), period: "monthly", amountCents: 60_000 });
    expect(predictBudgets(bundle.db, TODAY).find((b) => b.label === "Food")).toBeUndefined();
  });

  test("predictBudgets skips categories predicting below the noise floor", () => {
    insertTxn("2026-06-10", -500, { categoryName: "Groceries" }); // ~$5, below the $20 floor
    expect(predictBudgets(bundle.db, TODAY).find((b) => b.label === "Food")).toBeUndefined();
  });
});
