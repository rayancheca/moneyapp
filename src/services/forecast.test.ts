import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { dailyBalances } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { forecastCurrentMonth, trailingFullMonths } from "./forecast";

const TODAY = "2026-07-08"; // July 2026: 31 days, 24 remaining (incl. today)

describe("trailingFullMonths", () => {
  test("returns the 3 full months before the current one, oldest first", () => {
    expect(trailingFullMonths("2026-07-08", 3)).toEqual([
      { start: "2026-04-01", end: "2026-04-30", key: "2026-04" },
      { start: "2026-05-01", end: "2026-05-31", key: "2026-05" },
      { start: "2026-06-01", end: "2026-06-30", key: "2026-06" },
    ]);
  });

  test("crosses year boundaries", () => {
    expect(trailingFullMonths("2026-01-15", 3)).toEqual([
      { start: "2025-10-01", end: "2025-10-31", key: "2025-10" },
      { start: "2025-11-01", end: "2025-11-30", key: "2025-11" },
      { start: "2025-12-01", end: "2025-12-31", key: "2025-12" },
    ]);
  });
});

describe("forecastCurrentMonth", () => {
  let dir: string;
  let bundle: DbBundle;
  let checkingId: string;
  let savingsId: string;
  let cardId: string;
  let seq = 0;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-fc-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    savingsId = createAccount(bundle.db, { institutionId: chase.id, name: "Savings", type: "savings" });
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
    accountId: string,
    postedOn: string,
    amountCents: number,
    opts: { categoryName?: string; recurringSeriesId?: string; status?: TransactionStatus } = {},
  ): void {
    seq += 1;
    const rawDescription = `FIXTURE ${seq}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription,
        normalizedDescription: rawDescription,
        categoryId: opts.categoryName ? categoryId(opts.categoryName) : null,
        recurringSeriesId: opts.recurringSeriesId ?? null,
        status: opts.status ?? "active",
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
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
  }): string {
    return bundle.db
      .insert(recurringSeries)
      .values({ status: "detected", toleranceDays: 3, ...input })
      .returning({ id: recurringSeries.id })
      .get().id;
  }

  test("month geometry: 31 days, 24 remaining including today", () => {
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.monthStart).toBe("2026-07-01");
    expect(f.monthEnd).toBe("2026-07-31");
    expect(f.daysInMonth).toBe(31);
    expect(f.remainingDays).toBe(24);
  });

  test("a weekly series contributes the correct count of remaining occurrences", () => {
    insertSeries({
      name: "Payroll",
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
      nextExpectedOn: "2026-07-09",
      nextExpectedAmountCents: 80000,
      status: "confirmed",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const payroll = f.components.find((c) => c.label === "Payroll");
    // Jul 9, 16, 23, 30 — four occurrences left in July
    expect(payroll).toMatchObject({ kind: "fixed", cents: 4 * 80000 });
    expect(payroll!.detail).toContain("4 × $800.00");
    expect(f.projectedIncomeCents).toBe(320000);
  });

  test("a series whose next date falls after month end contributes nothing", () => {
    insertSeries({
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30.2,
      nextExpectedOn: "2026-08-01",
      nextExpectedAmountCents: -180000,
      status: "confirmed",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components).toHaveLength(0);
    expect(f.projectedNetCents).toBe(0);
  });

  test("dismissed and ended series are excluded from the fixed baseline", () => {
    insertSeries({
      name: "Old gym",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-12",
      nextExpectedAmountCents: -4000,
      status: "dismissed",
    });
    insertSeries({
      name: "Cancelled box",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-13",
      nextExpectedAmountCents: -2500,
      status: "ended",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components).toHaveLength(0);
  });

  test("transfer-kind series never count as income or spending", () => {
    insertSeries({
      name: "Card payment",
      kind: "transfer",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-10",
      nextExpectedAmountCents: -50000,
      status: "confirmed",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components).toHaveLength(0);
    expect(f.projectedSpendCents).toBe(0);
  });

  test("variable: trailing 3-month average with trend, scaled by remaining days", () => {
    insertTxn(cardId, "2026-04-10", -30000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-05-10", -40000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-06-10", -50000, { categoryName: "Groceries" });

    const f = forecastCurrentMonth(bundle.db, TODAY);
    const food = f.components.find((c) => c.label === "Food");
    // avg 40000 + trend (50000−30000)/2 = 50000 → × 24/31 → 38710
    expect(food).toMatchObject({ kind: "variable", cents: -38710 });
    expect(f.projectedSpendCents).toBe(-38710);
  });

  test("variable excludes recurring-tagged transactions", () => {
    const seriesId = insertSeries({
      name: "Meal kit",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-02",
      nextExpectedAmountCents: -9900,
      status: "confirmed",
    });
    insertTxn(cardId, "2026-04-10", -30000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-05-10", -40000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-06-10", -50000, { categoryName: "Groceries" });
    // tagged row must not inflate June
    insertTxn(cardId, "2026-06-11", -99900, { categoryName: "Groceries", recurringSeriesId: seriesId });

    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Food")?.cents).toBe(-38710);
  });

  test("variable never projects below zero (trend clamp)", () => {
    insertTxn(cardId, "2026-04-05", -60000, { categoryName: "Entertainment" });
    // May and June: nothing → avg 20000, trend −30000 → clamped to 0
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Entertainment")).toBeUndefined();
    expect(f.projectedSpendCents).toBe(0);
  });

  test("uncategorized negatives form an explicit bucket; positives are excluded", () => {
    insertTxn(cardId, "2026-06-20", -5000, {});
    insertTxn(checkingId, "2026-06-21", 7000, {}); // review queue's problem, not income
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const uncat = f.components.find((c) => c.label === "Uncategorized");
    // spend [0, 0, 5000] → avg 1666.67 + trend 2500 → 4166.67 × 24/31 → 3226
    expect(uncat).toMatchObject({ kind: "variable", cents: -3226 });
    expect(f.projectedIncomeCents).toBe(0);
  });

  test("subcategory spending rolls up to one top-level component", () => {
    insertTxn(cardId, "2026-06-03", -10000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-06-04", -20000, { categoryName: "Dining" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const labels = f.components.map((c) => c.label);
    expect(labels).toEqual(["Food"]);
    // spend [0, 0, 30000] → avg 10000 + trend 15000 → 25000 × 24/31 → 19355
    expect(f.components[0]!.cents).toBe(-19355);
  });

  test("current-month, non-active, and non-expense transactions never enter variable", () => {
    insertTxn(cardId, "2026-07-02", -70000, { categoryName: "Groceries" }); // current month
    insertTxn(cardId, "2026-06-09", -88800, { categoryName: "Groceries", status: "quarantined" });
    insertTxn(checkingId, "2026-06-12", -20000, { categoryName: "Internal Transfer" });
    insertTxn(checkingId, "2026-06-13", 1500, { categoryName: "Cash Back" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components).toHaveLength(0);
  });

  test("components sum exactly to the displayed projections", () => {
    insertSeries({
      name: "Payroll",
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
      nextExpectedOn: "2026-07-09",
      nextExpectedAmountCents: 80000,
      status: "confirmed",
    });
    insertSeries({
      name: "Netflix",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30.4,
      nextExpectedOn: "2026-07-16",
      nextExpectedAmountCents: -1549,
    });
    insertTxn(cardId, "2026-04-10", -30000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-05-10", -40000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-06-10", -50000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-06-20", -5000, {});

    const f = forecastCurrentMonth(bundle.db, TODAY);
    const sumAll = f.components.reduce((s, c) => s + c.cents, 0);
    const sumIn = f.components.filter((c) => c.cents > 0).reduce((s, c) => s + c.cents, 0);
    const sumOut = f.components.filter((c) => c.cents < 0).reduce((s, c) => s + c.cents, 0);
    expect(f.projectedIncomeCents).toBe(sumIn);
    expect(f.projectedSpendCents).toBe(sumOut);
    expect(f.projectedNetCents).toBe(sumAll);
    expect(f.projectedNetCents).toBe(f.projectedIncomeCents + f.projectedSpendCents);
    // fixed: +320000 −1549; variable: −38710 (Food) −3226 (Uncategorized)
    expect(f.projectedNetCents).toBe(320000 - 1549 - 38710 - 3226);
  });

  test("EOM cash and net worth build on the latest derived balances", () => {
    for (const [accountId, cents] of [
      [checkingId, 500000],
      [savingsId, 100000],
      [cardId, -50000],
    ] as const) {
      bundle.db
        .insert(dailyBalances)
        .values({ accountId, day: "2026-07-07", balanceCents: cents, basis: "anchored" })
        .run();
    }
    insertSeries({
      name: "Payroll",
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
      nextExpectedOn: "2026-07-09",
      nextExpectedAmountCents: 80000,
      status: "confirmed",
    });

    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.projectedNetCents).toBe(320000);
    // cash = checking + savings only; net worth = all three accounts
    expect(f.projectedEomCashCents).toBe(600000 + 320000);
    expect(f.projectedEomNetWorthCents).toBe(550000 + 320000);
  });

  test("uncategorized rows already tagged to a series stay out of the bucket", () => {
    const seriesId = insertSeries({
      name: "Mystery bill",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-03",
      nextExpectedAmountCents: -5000,
      status: "confirmed",
    });
    insertTxn(cardId, "2026-06-20", -5000, { recurringSeriesId: seriesId });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Uncategorized")).toBeUndefined();
    // sanity: no untagged uncategorized rows exist
    const untagged = bundle.db
      .select()
      .from(transactions)
      .where(and(isNull(transactions.categoryId), isNull(transactions.recurringSeriesId)))
      .all();
    expect(untagged).toHaveLength(0);
  });

  test("variable income: categorized income present in ≥2 trailing months projects forward", () => {
    insertTxn(checkingId, "2026-05-15", 200000, { categoryName: "Salary" });
    insertTxn(checkingId, "2026-06-15", 400000, { categoryName: "Salary" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const salary = f.components.find((c) => c.label === "Salary");
    // trailing [Apr 0, May 200000, Jun 400000] → mean 200000 (NO trend) × 24/31 → 154839
    expect(salary).toMatchObject({ kind: "variable", cents: 154839 });
    expect(f.projectedIncomeCents).toBe(154839);
  });

  test("variable income: a one-off (single trailing month) is NOT projected forward", () => {
    insertTxn(checkingId, "2026-05-15", 200000, { categoryName: "Salary" });
    insertTxn(checkingId, "2026-06-15", 400000, { categoryName: "Salary" });
    // a single Dividends payout in June — one month → gated out, must not extrapolate
    insertTxn(checkingId, "2026-06-20", 300000, { categoryName: "Dividends" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Dividends")).toBeUndefined();
    expect(f.components.find((c) => c.label === "Salary")?.cents).toBe(154839);
  });

  test("variable income: event-driven income (refunds/other income) never projects even when it clusters", () => {
    // refunds AND misc "Other Income" land in TWO trailing months (passes the presence
    // gate) but are one-off windfalls/gifts/settlements that must not extrapolate.
    insertTxn(checkingId, "2026-05-10", 150000, { categoryName: "Refunds & Reimbursements" });
    insertTxn(checkingId, "2026-06-18", 300000, { categoryName: "Refunds & Reimbursements" });
    insertTxn(checkingId, "2026-05-12", 300000, { categoryName: "Other Income" });
    insertTxn(checkingId, "2026-06-12", 300000, { categoryName: "Other Income" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Refunds & Reimbursements")).toBeUndefined();
    expect(f.components.find((c) => c.label === "Other Income")).toBeUndefined();
    expect(f.projectedIncomeCents).toBe(0);
  });

  test("variable income: a negative row in an income category never corrupts a bucket", () => {
    insertTxn(checkingId, "2026-05-15", 200000, { categoryName: "Salary" });
    insertTxn(checkingId, "2026-06-15", 400000, { categoryName: "Salary" });
    // a refund-reversal (negative amount) posted to Salary must be SKIPPED, not netted:
    // June stays 400000 → Salary still projects 154839 (not a corrupted/gated bucket).
    insertTxn(checkingId, "2026-06-16", -500000, { categoryName: "Salary" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Salary")?.cents).toBe(154839);
  });

  test("variable income: a positive row in an EXPENSE category is not projected as income", () => {
    // a grocery refund (positive amount in an expense category) present in ≥2 months
    // must never become "income" — it only reduces spend in variableComponents.
    insertTxn(checkingId, "2026-05-10", 30000, { categoryName: "Groceries" });
    insertTxn(checkingId, "2026-06-10", 40000, { categoryName: "Groceries" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Food")).toBeUndefined();
    expect(f.projectedIncomeCents).toBe(0);
  });

  test("variable income: a bucket that scales to under a cent is dropped, not shown as $0", () => {
    // tiny interest (avg ~7¢/mo) on the last day of the month → 7 × 1/31 rounds to 0
    insertTxn(checkingId, "2026-05-10", 10, { categoryName: "Interest" });
    insertTxn(checkingId, "2026-06-10", 10, { categoryName: "Interest" });
    const f = forecastCurrentMonth(bundle.db, "2026-07-31"); // 1 day remaining
    expect(f.components.find((c) => c.label === "Interest")).toBeUndefined();
  });

  test("variable income: series-linked income rows don't double-count the fixed series", () => {
    const seriesId = insertSeries({
      name: "Cash job",
      kind: "income",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-05", // after month end → 0 fixed contribution this month
      nextExpectedAmountCents: 200000,
      status: "confirmed",
    });
    insertTxn(checkingId, "2026-05-15", 200000, { categoryName: "Salary", recurringSeriesId: seriesId });
    insertTxn(checkingId, "2026-06-15", 400000, { categoryName: "Salary", recurringSeriesId: seriesId });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Salary")).toBeUndefined();
    expect(f.projectedIncomeCents).toBe(0);
  });
});
