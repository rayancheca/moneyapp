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
import { forecastCurrentMonth, forecastForMonth, trailingFullMonths } from "./forecast";

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
    /** omitted → never matched, which reads as stale (services/recurring.ts) */
    lastMatchedOn?: string;
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

  /* ── staleness disclosure (item 13a) ───────────────────────────────────
     The forecast keeps stale series and says how old their evidence is. The
     original backlog item asked for the opposite — filtering by isSeriesActive
     — which measured out to suppressing ~$1,046/wk of the owner's real income
     (weekly cadence goes stale after 7 × 1.5 + 2 = 12.5 days; his deposits lag
     ~22) to remove ~$10.99/cycle of dead subscriptions. */

  test("a stale series still projects its full amount, carrying its staleness", () => {
    insertSeries({
      name: "Cash job",
      kind: "income",
      cadence: "weekly",
      intervalDaysAvg: 7,
      nextExpectedOn: "2026-07-09",
      nextExpectedAmountCents: 104600,
      status: "confirmed",
      lastMatchedOn: "2026-06-16", // 22 days before TODAY — past 12.5 of tolerance
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const cashJob = f.components.find((c) => c.label === "Cash job")!;

    // the money is NOT dropped — four Thursdays of income still land in July
    expect(cashJob.cents).toBe(4 * 104600);
    expect(f.projectedIncomeCents).toBe(4 * 104600);
    expect(cashJob.staleness).toMatchObject({
      lastMatchedOn: "2026-06-16",
      daysSinceLastMatch: 22,
      stepDays: 7,
      toleranceDays: 12.5,
      isStale: true,
    });
  });

  test("a fresh series carries staleness saying so, never an absent field", () => {
    insertSeries({
      name: "Netflix",
      kind: "subscription",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-16",
      nextExpectedAmountCents: -1099,
      status: "confirmed",
      lastMatchedOn: "2026-06-16", // 22 days against 30 × 1.5 + 3 = 48
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const netflix = f.components.find((c) => c.label === "Netflix")!;

    expect(netflix.staleness).toMatchObject({ daysSinceLastMatch: 22, isStale: false });
  });

  test("a series nothing has ever matched is disclosed as stale, not hidden", () => {
    insertSeries({
      name: "Ghost bill",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-20",
      nextExpectedAmountCents: -5000,
      status: "detected",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const ghost = f.components.find((c) => c.label === "Ghost bill")!;

    expect(ghost.cents).toBe(-5000);
    expect(ghost.staleness).toMatchObject({ lastMatchedOn: null, daysSinceLastMatch: null, isStale: true });
  });

  test("variable components carry no staleness — no series stands behind them", () => {
    for (const month of ["2026-04", "2026-05", "2026-06"]) {
      insertTxn(cardId, `${month}-10`, -30000, { categoryName: "Groceries" });
    }
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const variable = f.components.filter((c) => c.kind === "variable");

    expect(variable.length).toBeGreaterThan(0);
    expect(variable.every((c) => c.staleness === undefined)).toBe(true);
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

  /* ── arrears: what came due earlier this month and never posted ──────────
     Found by reading the running app on 2026-09-02. The fixed leg opened on
     `today` and the variable leg excludes every recurring-tagged row, so a bill
     that came due EARLIER THIS MONTH and never posted was in neither: rent
     ($2,109.00, due Sep 1) and its utilities ($182.21) were missing from
     September's projected spending and from EOM cash, while /budgets and the
     runway card both published the same $2,291.21 as "due by today and no
     import has covered it". Three surfaces, one bill, two answers. */

  test("a bill that came due earlier this month and never posted is still projected", () => {
    insertSeries({
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-01", // a week before TODAY, and nothing posted
      nextExpectedAmountCents: -210900,
      status: "confirmed",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const rentLine = f.components.find((c) => c.label === "Rent");
    expect(rentLine).toMatchObject({ kind: "fixed", cents: -210900 });
    expect(rentLine!.detail).toContain("came due");
    expect(f.projectedSpendCents).toBe(-210900);
    // it is a COMMITMENT, not a pace: the schedule-only reading owns it too
    expect(f.committed.spendCents).toBe(-210900);
  });

  test("a bill that came due AND posted is not projected on top of what it cost", () => {
    const seriesId = insertSeries({
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-01",
      nextExpectedAmountCents: -210900,
      status: "confirmed",
      lastMatchedOn: "2026-07-02",
    });
    // landed a day late — inside the series' own 3-day tolerance
    insertTxn(checkingId, "2026-07-02", -210900, { recurringSeriesId: seriesId });

    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Rent")).toBeUndefined();
    expect(f.projectedSpendCents).toBe(0);
  });

  /* ⛔ The two legs must ABUT, never overlap: a bill due TODAY is DUE, not late,
     and the forward leg already owns it. Counting it in both would double the
     largest bill on the ledger on exactly one day a month. */
  test("a bill due TODAY is projected exactly once", () => {
    insertSeries({
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: TODAY,
      nextExpectedAmountCents: -210900,
      status: "confirmed",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.filter((c) => c.label === "Rent")).toHaveLength(1);
    expect(f.projectedSpendCents).toBe(-210900);
  });

  /* ⛔ MONEY-OUT ONLY, the same asymmetry `fixedComponents` already states: a
     dead outflow that keeps projecting overstates what you owe, which is
     conservative. A payday that did not arrive is evidence about the IMPORTS,
     and projecting it as still-to-come would inflate EOM cash. */
  test("a payday that came and went without a deposit is NOT projected as arrears", () => {
    insertSeries({
      name: "Payroll",
      kind: "income",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-01",
      nextExpectedAmountCents: 300000,
      status: "confirmed",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.find((c) => c.label === "Payroll")).toBeUndefined();
    expect(f.projectedIncomeCents).toBe(0);
  });

  /* A transfer moves money between the owner's own accounts; it is never
     spending, forward OR overdue. Found by mutation: without the kind filter a
     card payment that came due on the 1st and had not yet imported posted
     itself into September's projected spending. */
  test("a transfer that came due and never posted is not spending either", () => {
    insertSeries({
      name: "Card payment",
      kind: "transfer",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-01",
      nextExpectedAmountCents: -50000,
      status: "confirmed",
    });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components).toHaveLength(0);
    expect(f.projectedSpendCents).toBe(0);
  });

  /* A whole month still ahead has no "earlier this month" at all — every
     occurrence is in the forward leg, and an arrears leg there would be a
     second reading of the same money. */
  test("a future month projects the bill once, with no arrears leg", () => {
    insertSeries({
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-01",
      nextExpectedAmountCents: -210900,
      status: "confirmed",
    });
    const aug = forecastForMonth(bundle.db, "2026-08", TODAY)!;
    expect(aug.components.filter((c) => c.label === "Rent")).toHaveLength(1);
    expect(aug.components.find((c) => c.label === "Rent")!.cents).toBe(-210900);
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
    // spend [0, 0, 5000] → avg 1666.67, median 0 so no upward trend → × 24/31
    expect(uncat).toMatchObject({ kind: "variable", cents: -1290 });
    expect(f.projectedIncomeCents).toBe(0);
  });

  test("subcategory spending rolls up to one top-level component", () => {
    insertTxn(cardId, "2026-06-03", -10000, { categoryName: "Groceries" });
    insertTxn(cardId, "2026-06-04", -20000, { categoryName: "Dining" });
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const labels = f.components.map((c) => c.label);
    expect(labels).toEqual(["Food"]);
    // spend [0, 0, 30000] → avg 10000, median 0 so no upward trend → × 24/31
    expect(f.components[0]!.cents).toBe(-7742);
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
    /*
     * fixed: +320000 −1549; variable: −38710 (Food) −1290 (Uncategorized).
     *
     * Food's history [30000, 40000, 50000] rises steadily, so its +10000 slope
     * is well under the 40000 median and passes through UNCAPPED — the cap is
     * meant to bound a spike, not to flatten a real trend. Uncategorized's
     * [0, 0, 5000] is the spike shape and loses its nudge entirely.
     */
    expect(f.projectedNetCents).toBe(320000 - 1549 - 38710 - 1290);
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

/**
 * PASS — the forecast follows the calendar.
 *
 * ⛔ The card said "Forecast · August 2026" while the grid under it showed
 * October. Two different months, stacked, with nothing saying so.
 */
describe("forecastForMonth", () => {
  let dir: string;
  let bundle: DbBundle;
  let checkingId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-ffm-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rent = (): string =>
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Rent",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-08-01",
        nextExpectedAmountCents: -200_000,
        status: "confirmed",
        toleranceDays: 3,
      })
      .returning({ id: recurringSeries.id })
      .get().id;

  test("the running month is exactly what forecastCurrentMonth says", () => {
    rent();
    const viaMonth = forecastForMonth(bundle.db, "2026-07", TODAY)!;
    const viaCurrent = forecastCurrentMonth(bundle.db, TODAY);
    expect(viaMonth).toEqual(viaCurrent);
    expect(viaMonth.basis).toBe("current");
    expect(viaMonth.monthKey).toBe("2026-07");
  });

  /*
   * ⛔ A month that has ended is not a forecast. The calendar below it already
   * shows what actually posted, and dressing that up as a projection would be
   * the app claiming to predict something it can simply read.
   */
  test("a past month has no projection at all", () => {
    rent();
    expect(forecastForMonth(bundle.db, "2026-06", TODAY)).toBeNull();
    expect(forecastForMonth(bundle.db, "2025-01", TODAY)).toBeNull();
  });

  test("a future month is projected END TO END, not from today", () => {
    rent();
    const f = forecastForMonth(bundle.db, "2026-09", TODAY)!;
    expect(f.basis).toBe("future");
    expect(f.monthStart).toBe("2026-09-01");
    expect(f.monthEnd).toBe("2026-09-30");
    expect(f.daysInMonth).toBe(30);
    // the WHOLE month is ahead — not the 24 days remaining of the current one
    expect(f.remainingDays).toBe(30);
    // September's rent is due on the 1st, which is BEFORE today+n — it is only
    // in this projection because the window starts at the month, not at today
    expect(f.components.find((c) => c.label === "Rent")?.cents).toBe(-200_000);
  });

  /*
   * ⛔ The chain. "What will I have at the end of October" cannot be answered
   * from October alone — it depends on September. Projecting October's net
   * against today's balance would be wrong by a whole month and look entirely
   * reasonable.
   */
  test("end-of-month cash is CHAINED through every intervening month", () => {
    rent();
    const jul = forecastCurrentMonth(bundle.db, TODAY);
    const aug = forecastForMonth(bundle.db, "2026-08", TODAY)!;
    const sep = forecastForMonth(bundle.db, "2026-09", TODAY)!;
    const oct = forecastForMonth(bundle.db, "2026-10", TODAY)!;

    /*
     * ⚠️ AUGUST is in the chain and it is easy to forget: today is 2026-07-08,
     * so September is TWO months out. My own first assertion here skipped it and
     * failed — which is the whole reason the figure has to be chained rather
     * than added to today's balance.
     */
    expect(aug.projectedEomCashCents).toBe(jul.projectedEomCashCents + aug.projectedNetCents);
    expect(sep.projectedEomCashCents).toBe(aug.projectedEomCashCents + sep.projectedNetCents);
    expect(oct.projectedEomCashCents).toBe(sep.projectedEomCashCents + oct.projectedNetCents);
    // …and each month's own net is about that month alone
    expect(oct.projectedNetCents).not.toBe(oct.projectedEomCashCents);
  });

  /*
   * ⛔ THE CHAIN STARTS AT THE MONTH AFTER THIS ONE. The running month's net is
   * already in `chainedNet` before the loop opens, so the loop must begin at
   * `i = 1`; starting at 0 adds the current month a second time.
   *
   * ⚠️ The chain test above cannot see it, and that is worth knowing: with
   * `i = 0` EVERY future month gains the same extra term, so all the
   * month-to-month DIFFERENCES it asserts are unchanged and only the very first
   * step is wrong. It survived because `rent()` is anchored on 2026-08-01, so
   * the running month's own net is exactly zero and the double count adds
   * nothing. A relationship between consecutive months cannot pin a term that
   * is common to all of them.
   */
  test("the chain does not count the running month twice", () => {
    rent();
    // something due in JULY, after today, so the running month has a net at all
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Insurance",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-07-20",
        nextExpectedAmountCents: -30_000,
        status: "confirmed",
        toleranceDays: 3,
      })
      .run();

    const jul = forecastCurrentMonth(bundle.db, TODAY);
    const aug = forecastForMonth(bundle.db, "2026-08", TODAY)!;
    expect(jul.projectedNetCents).not.toBe(0); // the term that would be doubled
    expect(aug.projectedEomCashCents).toBe(jul.projectedEomCashCents + aug.projectedNetCents);
    // the same for the committed reading, which is chained separately
    expect(aug.committed.eomCashCents).toBe(jul.committed.eomCashCents + aug.committed.netCents);
  });

  test("a commitment that has ended is not projected past its last payment", () => {
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Lease",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-08-15",
        nextExpectedAmountCents: -50_000,
        status: "confirmed",
        toleranceDays: 3,
        userEndsOn: "2026-09-15",
      })
      .run();

    expect(forecastForMonth(bundle.db, "2026-09", TODAY)!.components.some((c) => c.label === "Lease")).toBe(true);
    expect(forecastForMonth(bundle.db, "2026-10", TODAY)!.components.some((c) => c.label === "Lease")).toBe(false);
  });

  /*
   * ⛔ A bound, not a preference: the EOM figure is chained, so an unbounded
   * horizon is an unbounded loop over the whole forecast machinery, one
   * page-turn at a time.
   */
  /*
   * ⛔ The asymmetry, and it is not a nicety.
   *
   * A dead OUTFLOW that keeps projecting overstates what you owe — conservative.
   * A live INFLOW dropped for want of an import understates what you earn, and
   * on the owner's ledger that turned $4,233.69 of projected income into
   * $45.69, because his pay arrives as cash and reaches the ledger late.
   * An income series going quiet is evidence about the IMPORTS, not the job.
   */
  test("a lapsed OUTFLOW stops projecting; a lapsed INCOME series does not", () => {
    const lapsedLongAgo = "2025-01-01";
    bundle.db
      .insert(recurringSeries)
      .values([
        {
          name: "Old landlord",
          kind: "bill",
          cadence: "monthly",
          intervalDaysAvg: 30,
          nextExpectedOn: "2026-08-08",
          nextExpectedAmountCents: -177_949,
          status: "detected",
          toleranceDays: 3,
          lastMatchedOn: lapsedLongAgo,
        },
        {
          name: "Cash job",
          kind: "income",
          cadence: "weekly",
          intervalDaysAvg: 7,
          nextExpectedOn: "2026-08-06",
          nextExpectedAmountCents: 104_700,
          status: "confirmed",
          toleranceDays: 3,
          lastMatchedOn: lapsedLongAgo,
        },
      ])
      .run();

    const labels = forecastForMonth(bundle.db, "2026-09", TODAY)!.components.map((c) => c.label);
    expect(labels).not.toContain("Old landlord");
    expect(labels).toContain("Cash job");
  });

  /**
   * The lapse gate reads the series' KIND, not the sign of its amount.
   *
   * Both series below are lapsed and both have a sign that contradicts their
   * kind, which is the only shape that can tell the two rules apart — the
   * eighteen live series on the real ledger all have a sign that agrees with
   * their kind, so nothing there could ever fail this.
   *
   * ⛔ The income row is the expensive direction. A sign test DELETES it, and
   * deleting the owner's only income series is how a $4,233.69 projection
   * became $45.69 once already.
   */
  test("lapse is decided by kind, even when the amount's sign disagrees", () => {
    const lapsedLongAgo = "2025-01-01";
    bundle.db
      .insert(recurringSeries)
      .values([
        {
          // a bill that projects a CREDIT — still money-out by kind, still dead
          name: "Positive-amount bill",
          kind: "bill",
          cadence: "monthly",
          intervalDaysAvg: 30,
          nextExpectedOn: "2026-08-08",
          nextExpectedAmountCents: 5_000,
          status: "detected",
          toleranceDays: 3,
          lastMatchedOn: lapsedLongAgo,
        },
        {
          // income stored negative — quiet imports must not delete it
          name: "Negative-amount income",
          kind: "income",
          cadence: "weekly",
          intervalDaysAvg: 7,
          nextExpectedOn: "2026-08-06",
          nextExpectedAmountCents: -104_700,
          status: "confirmed",
          toleranceDays: 3,
          lastMatchedOn: lapsedLongAgo,
        },
      ])
      .run();

    const labels = forecastForMonth(bundle.db, "2026-09", TODAY)!.components.map((c) => c.label);
    expect(labels).not.toContain("Positive-amount bill");
    expect(labels).toContain("Negative-amount income");
  });

  test("beyond the horizon there is no projection", () => {
    rent();
    expect(forecastForMonth(bundle.db, "2028-07", TODAY)).not.toBeNull();
    expect(forecastForMonth(bundle.db, "2028-08", TODAY)).toBeNull();
  });

  /* ── the committed reading ───────────────────────────────────────────────
     ⛔ The five headline tiles show THIS, at the owner's instruction:
     *"projected income is 1047*4 a month. projected spend is the actual
     monthlies i have you so around 3.5k"*. The trailing pace keeps its own row
     and its own end-of-month cash, so nothing is deleted — but the number his
     eye lands on is now the schedule. */

  /** A cash job paying $1,047 weekly, plus a month of discretionary spending. */
  function scheduleAndPace(): void {
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Cash job (weekly pay)",
        kind: "income",
        cadence: "weekly",
        intervalDaysAvg: 7,
        nextExpectedOn: "2026-08-06",
        nextExpectedAmountCents: 104_700,
        status: "confirmed",
        toleranceDays: 3,
      })
      .run();
    // three full trailing months of uncategorised outflow → a variable bucket
    for (const day of ["2026-04-15", "2026-05-15", "2026-06-15"]) {
      const raw = `PACE ${day}`;
      bundle.db
        .insert(transactions)
        .values({
          accountId: checkingId,
          postedOn: day,
          amountCents: -31_000,
          rawDescription: raw,
          normalizedDescription: raw,
          status: "active",
          dedupeHash: dedupeHash({
            accountId: checkingId,
            postedOn: day,
            amountCents: -31_000,
            rawDescription: raw,
            occurrenceIndex: 0,
          }),
        })
        .run();
    }
  }

  test("committed carries the schedule alone, with no trailing pace in it", () => {
    rent();
    scheduleAndPace();
    const aug = forecastForMonth(bundle.db, "2026-08", TODAY)!;

    // Aug 6, 13, 20, 27 — four paydays
    expect(aug.committed.incomeCents).toBe(4 * 104_700);
    expect(aug.committed.spendCents).toBe(-200_000);
    expect(aug.committed.netCents).toBe(4 * 104_700 - 200_000);

    // the pace is REAL and still reported — just not in the headline
    expect(aug.projectedSpendCents).toBeLessThan(aug.committed.spendCents);
    expect(aug.projectedIncomeCents).toBe(aug.committed.incomeCents);
  });

  test("committed.net is its own row's arithmetic, never the full net", () => {
    rent();
    scheduleAndPace();
    for (const key of ["2026-08", "2026-09", "2026-10"]) {
      const m = forecastForMonth(bundle.db, key, TODAY)!;
      expect(m.committed.netCents).toBe(m.committed.incomeCents + m.committed.spendCents);
      expect(m.committed.netCents).not.toBe(m.projectedNetCents);
    }
  });

  /*
   * ⛔ The committed end-of-month cash is CHAINED SEPARATELY. Deriving it as
   * "the full chain minus this month's pace" is the obvious shortcut and it is
   * wrong by every EARLIER month's pace — a mistake that grows the further ahead
   * you page, which is exactly when nobody is checking.
   */
  test("committed end-of-month cash chains through its own months only", () => {
    rent();
    scheduleAndPace();
    const jul = forecastCurrentMonth(bundle.db, TODAY);
    const aug = forecastForMonth(bundle.db, "2026-08", TODAY)!;
    const sep = forecastForMonth(bundle.db, "2026-09", TODAY)!;
    const oct = forecastForMonth(bundle.db, "2026-10", TODAY)!;

    expect(aug.committed.eomCashCents).toBe(jul.committed.eomCashCents + aug.committed.netCents);
    expect(sep.committed.eomCashCents).toBe(aug.committed.eomCashCents + sep.committed.netCents);
    expect(oct.committed.eomCashCents).toBe(sep.committed.eomCashCents + oct.committed.netCents);

    // and the shortcut really is wrong — by more than one month's pace
    const shortcut = oct.projectedEomCashCents - (oct.projectedNetCents - oct.committed.netCents);
    expect(oct.committed.eomCashCents).not.toBe(shortcut);
  });

  /*
   * ⛔ The RUNNING month's committed reading needs pinning on its own, and this
   * is the test that was missing: the chain assertions above verify only that
   * each month's cash equals the previous month's plus its net, and that
   * identity survives feeding the FULL July net into the committed chain —
   * both sides shift together. Found by mutation; the chain tests all stayed
   * green while the first link was quietly the wrong number.
   *
   * At TODAY = 2026-07-08 neither commitment has started (rent 2026-08-01, the
   * cash job 2026-08-06), so July's committed net is exactly zero while its
   * full net is the trailing pace.
   */
  test("the running month's committed net excludes its own pace", () => {
    rent();
    scheduleAndPace();
    const jul = forecastCurrentMonth(bundle.db, TODAY);
    expect(jul.committed.incomeCents).toBe(0);
    expect(jul.committed.spendCents).toBe(0);
    expect(jul.committed.netCents).toBe(0);
    expect(jul.projectedNetCents).toBeLessThan(0);
    expect(jul.committed.netCents).not.toBe(jul.projectedNetCents);
  });

  test("net worth chains on the committed reading too", () => {
    rent();
    scheduleAndPace();
    const jul = forecastCurrentMonth(bundle.db, TODAY);
    const aug = forecastForMonth(bundle.db, "2026-08", TODAY)!;
    expect(aug.committed.eomNetWorthCents).toBe(
      jul.committed.eomNetWorthCents + aug.committed.netCents,
    );
  });

  /*
   * With nothing discretionary in the ledger the two readings are the same
   * month, so they must agree to the cent. A card that showed two different
   * numbers here would be inventing a distinction rather than reporting one.
   */
  test("with no trailing pace at all, committed equals the full projection", () => {
    rent();
    const aug = forecastForMonth(bundle.db, "2026-08", TODAY)!;
    expect(aug.committed.incomeCents).toBe(aug.projectedIncomeCents);
    expect(aug.committed.spendCents).toBe(aug.projectedSpendCents);
    expect(aug.committed.netCents).toBe(aug.projectedNetCents);
    expect(aug.committed.eomCashCents).toBe(aug.projectedEomCashCents);
    expect(aug.committed.eomNetWorthCents).toBe(aug.projectedEomNetWorthCents);
  });

});
