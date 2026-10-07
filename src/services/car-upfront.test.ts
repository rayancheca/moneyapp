import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type SeriesStatus } from "@/db/schema/recurring";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { baselineCaption } from "@/lib/committed";
import { resolvePeriod } from "@/lib/period";
import { createAccount } from "./accounts";
import { budgetGuidanceCents, budgetPaceStatuses, createBudget } from "./budgets";
import { createCashWallet } from "./cash-wallets";
import { predictBudgets, predictCategory } from "./category-forecast";
import { carCard, runwayCard, spendBaseline } from "./committed";
import { forecastCurrentMonth, forecastForMonth, type MonthForecast } from "./forecast";
import { addManualTransaction } from "./manual-transactions";
import { cashFlowByPeriod, spendingProjection } from "./spending";

/**
 * ⚖️ Owner decision 2026-10-07 (§6A 48): the spending PACE leaves out the car's up-front money — what the car card
 * counts as "Paid up front, spread over the lease" — so it is not projected again as monthly spending. Lease and
 * insurance stay in, as the scheduled bills they are.
 *
 * The fixture is his ledger's car, on the day he asked: on 2026-10-07 `/recurring`'s "If you also spend at your recent
 * pace" read "Car  3-mo avg $2,033.33 + trend $0.00, × 25/31 days = -$1,639.78" — the $5,000 cash down payment
 * (2026-08-11) and the $1,100 Mercedes-Benz deposit (2026-08-12), ÷ 3, projected as October's car spending on top of
 * the lease and the insurance the same card prices.
 */
const TODAY = "2026-10-07"; // October: 31 days, 25 remaining; trailing = Jul / Aug / Sep

const DOWN_PAYMENT = -500_000;
const DEPOSIT = -110_000;
const LEASE = -69_504;
const INSURANCE = -35_758;

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;
let groceriesId: string;
let carId: string;
let carInsuranceId: string;
let leaseId: string;
let insuranceId: string;
let seq = 0;

function insertTxn(opts: {
  accountId?: string;
  postedOn: string;
  amountCents: number;
  categoryId: string | null;
  recurringSeriesId?: string | null;
}): string {
  seq += 1;
  const accountId = opts.accountId ?? checkingId;
  const rawDescription = `FIXTURE ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId: opts.categoryId,
      recurringSeriesId: opts.recurringSeriesId ?? null,
      dedupeHash: dedupeHash({ accountId, postedOn: opts.postedOn, amountCents: opts.amountCents, rawDescription, occurrenceIndex: seq }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function addSeries(opts: {
  name: string;
  nextExpectedOn: string;
  amountCents: number;
  userCategoryId: string;
  lastMatchedOn?: string;
  status?: SeriesStatus;
}): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: "bill",
      cadence: "monthly",
      status: opts.status ?? "confirmed",
      intervalDaysAvg: 30,
      toleranceDays: 4,
      nextExpectedOn: opts.nextExpectedOn,
      nextExpectedAmountCents: opts.amountCents,
      userCategoryId: opts.userCategoryId,
      lastMatchedOn: opts.lastMatchedOn ?? null,
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

function addCategory(name: string, parentId: string | null): string {
  return bundle.db
    .insert(categories)
    .values({ name, parentId, kind: "expense", sortOrder: 99 })
    .returning({ id: categories.id })
    .get().id;
}

function split(transactionId: string, parts: readonly { categoryId: string; amountCents: number }[]): void {
  parts.forEach((p, i) =>
    bundle.db.insert(transactionSplits).values({ transactionId, categoryId: p.categoryId, amountCents: p.amountCents, sortOrder: i }).run(),
  );
}

function carLine(f: MonthForecast) {
  return f.components.find((c) => c.kind === "variable" && c.label === "Car");
}

/** What a forecast publishes about spending, minus nothing — the figure and every line behind it. */
function spendingOf(f: MonthForecast) {
  return {
    projectedSpendCents: f.projectedSpendCents,
    projectedEomCashCents: f.projectedEomCashCents,
    components: f.components,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-car-upfront-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  groceriesId = bundle.db.select().from(categories).where(eq(categories.name, "Groceries")).get()!.id;
  seq = 0;

  // a control bucket the decision must not touch: $400, $500, $450
  insertTxn({ postedOn: "2026-07-05", amountCents: -40_000, categoryId: groceriesId });
  insertTxn({ postedOn: "2026-08-05", amountCents: -50_000, categoryId: groceriesId });
  insertTxn({ postedOn: "2026-09-05", amountCents: -45_000, categoryId: groceriesId });

  // the car: a top-level Car with its insurance filed one level down, as his is
  carId = addCategory("Car", null);
  carInsuranceId = addCategory("Car Insurance", carId);
  leaseId = addSeries({ name: "Car lease", nextExpectedOn: "2026-10-15", amountCents: LEASE, userCategoryId: carId, lastMatchedOn: "2026-09-15" });
  insuranceId = addSeries({
    name: "Car insurance",
    nextExpectedOn: "2026-10-11",
    amountCents: INSURANCE,
    userCategoryId: carInsuranceId,
    lastMatchedOn: "2026-09-11",
  });
  insertTxn({ postedOn: "2026-08-12", amountCents: INSURANCE, categoryId: carInsuranceId, recurringSeriesId: insuranceId });
  insertTxn({ postedOn: "2026-09-11", amountCents: INSURANCE, categoryId: carInsuranceId, recurringSeriesId: insuranceId });
  insertTxn({ postedOn: "2026-09-15", amountCents: LEASE, categoryId: carId, recurringSeriesId: leaseId });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The two rows his card calls "Paid up front": the cash down payment and the dealer deposit. */
function postTheUpfrontMoney(): string[] {
  return [
    insertTxn({ postedOn: "2026-08-11", amountCents: DOWN_PAYMENT, categoryId: carId }),
    insertTxn({ postedOn: "2026-08-12", amountCents: DEPOSIT, categoryId: carId, accountId: cardId }),
  ];
}

function removeRows(ids: readonly string[]): void {
  for (const id of ids) bundle.db.delete(transactions).where(eq(transactions.id, id)).run();
}

describe("the pace leaves out the car's up-front money (owner decision 2026-10-07, §6A 48)", () => {
  /**
   * 🔴 Measured before the fix on this fixture, the same line as his ledger: "Car  3-mo avg $2,033.33 + trend $0.00,
   * × 25/31 days" = −$1,639.78 — $6,100 ÷ 3 spread over the 25 days left, as though he hands over a down payment
   * every month.
   */
  test("/recurring's month forecast projects no Car pace from the down payment", () => {
    postTheUpfrontMoney();
    const f = forecastCurrentMonth(bundle.db, TODAY);

    expect(carLine(f)).toBeUndefined();
    // the lease and the insurance stay in, as the bills they are
    expect(f.components.filter((c) => c.kind === "fixed").map((c) => [c.label, c.cents])).toEqual(
      expect.arrayContaining([
        ["Car insurance", INSURANCE],
        ["Car lease", LEASE],
      ]),
    );
    // …and the control bucket (Groceries, under Food) is untouched: ($400 + $500 + $450) / 3 = $450, + trend $25, × 25/31
    expect(f.components.find((c) => c.label === "Food")?.cents).toBe(-Math.round(((135_000 / 3 + 2_500) * 25) / 31));
  });

  /**
   * The strongest statement of the decision: with the up-front money posted, the forecast publishes exactly what it
   * would without it — every line, the spending total and month-end cash. Not "a smaller Car line": no line.
   */
  test("the forecast is the one a ledger without the up-front rows publishes", () => {
    const upfront = postTheUpfrontMoney();
    const withIt = spendingOf(forecastCurrentMonth(bundle.db, TODAY));
    removeRows(upfront);
    const without = spendingOf(forecastCurrentMonth(bundle.db, TODAY));

    expect(withIt.projectedSpendCents).toBe(without.projectedSpendCents);
    expect(withIt.components).toEqual(without.components);
  });

  /** Every month the calendar pages to reads the same pace — November included, a whole month of it. */
  test("a month ahead projects no Car pace either", () => {
    postTheUpfrontMoney();
    const november = forecastForMonth(bundle.db, "2026-11", TODAY)!;
    expect(carLine(november)).toBeUndefined();
    expect(november.components.filter((c) => c.kind === "fixed").map((c) => c.label)).toEqual(
      expect.arrayContaining(["Car insurance", "Car lease"]),
    );
  });

  /** /spending's predictions and /budgets' "Predict budgets" read the same pace, and must agree with /recurring. */
  test("/spending's prediction for Car is its bills alone, and /budgets seeds the bills", () => {
    postTheUpfrontMoney();
    const p = predictCategory(bundle.db, carId, "Car", TODAY);

    // November: the lease on the 15th and the premium on the 11th
    expect(p.forecast.recurringCents).toBe(-(LEASE + INSURANCE));
    expect(p.forecast.discretionaryCents).toBe(0);
    expect(p.forecast.expectedTotalCents).toBe(-(LEASE + INSURANCE));

    const car = predictBudgets(bundle.db, TODAY).find((b) => b.categoryId === carId);
    // $1,052.62 rounded up to the next $10 — not $3,085.95's
    expect(car?.amountCents).toBe(106_000);
  });

  /**
   * ⛔ The card's figures must not move: this decision READS its definition, it does not change it. Pinned from the
   * card as it published before the pace was touched.
   */
  test("the car card's figures do not move", () => {
    postTheUpfrontMoney();
    const c = carCard(bundle.db, TODAY)!;
    expect(c.cost).toMatchObject({
      upfrontCents: 610_000, // $5,000 + $1,100
      upfrontMonthlyCents: 25_417, // ÷ the 24-month lease
      monthlyCents: -(LEASE + INSURANCE),
      allInMonthlyCents: 130_679,
      committedCents: 1_263_144,
      projectedMonthlySpendCents: 152_762,
      allInProjectedMonthlySpendCents: 178_179,
      evidencedThrough: null,
    });
    expect(c.baseline).toMatchObject({ fromMonth: "2026-08", toMonth: "2026-09", months: 2, monthlyCents: 47_500 });
  });
});

describe("one rule: what the card calls up front is exactly what the pace leaves out", () => {
  /**
   * A row tagged to a DISMISSED series is money handed over on the card (`seriesDrawsAsRecurring`), so it is up-front
   * money for the pace too — before the decision the pace held it, as every dismissed row's spend.
   */
  test("a Car row linked to a dismissed series is up front on the card and out of the pace", () => {
    const club = addSeries({ name: "Car wash club", nextExpectedOn: "2026-10-02", amountCents: -2_500, userCategoryId: carId, status: "dismissed" });
    const row = insertTxn({ postedOn: "2026-09-02", amountCents: -2_500, categoryId: carId, recurringSeriesId: club });

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(2_500);
    const withIt = spendingOf(forecastCurrentMonth(bundle.db, TODAY));
    expect(carLine(forecastCurrentMonth(bundle.db, TODAY))).toBeUndefined();
    removeRows([row]);
    expect(spendingOf(forecastCurrentMonth(bundle.db, TODAY)).components).toEqual(withIt.components);
  });

  /** An ENDED series' payment was a bill: not up front on the card, and not the pace's either (it never was). */
  test("a Car row linked to an ended series is neither up front nor pace", () => {
    const old = addSeries({ name: "Old insurer", nextExpectedOn: "2026-09-20", amountCents: -40_000, userCategoryId: carId, status: "ended" });
    insertTxn({ postedOn: "2026-08-20", amountCents: -40_000, categoryId: carId, recurringSeriesId: old });

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(0);
    expect(carLine(forecastCurrentMonth(bundle.db, TODAY))).toBeUndefined();
    expect(predictCategory(bundle.db, carId, "Car", TODAY).forecast.discretionaryCents).toBe(0);
  });

  /**
   * A split part is judged on its own category: the Car part of a mixed purchase is up front on the card and leaves
   * the pace; the Groceries part beside it stays in Groceries' pace, on the forecast and on /spending alike.
   */
  test("a split purchase: its Car part leaves the pace, its Groceries part stays", () => {
    // before the lease starts — after it, a Car part is ordinary spending (§6A 52, below)
    const mixed = insertTxn({ postedOn: "2026-09-05", amountCents: -9_000, categoryId: groceriesId });
    split(mixed, [
      { categoryId: groceriesId, amountCents: -3_000 },
      { categoryId: carId, amountCents: -6_000 },
    ]);

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(6_000);
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(carLine(f)).toBeUndefined();
    // Food: $400, $500, $480 → avg $460, trend min(median $480, slope $40) = $40
    expect(f.components.find((c) => c.label === "Food")?.cents).toBe(-Math.round(((138_000 / 3 + 4_000) * 25) / 31));
    expect(predictCategory(bundle.db, carId, "Car", TODAY).forecast.discretionaryCents).toBe(0);
    expect(predictCategory(bundle.db, groceriesId, "Groceries", TODAY).forecast.discretionaryCents).toBeGreaterThan(0);
  });

  /** The card nets a refund against the money handed over, so the pace leaves the refund out with it. */
  test("a refund of the deposit nets on the card and leaves the pace with the deposit", () => {
    postTheUpfrontMoney();
    insertTxn({ postedOn: "2026-09-03", amountCents: 10_000, categoryId: carId, accountId: cardId });

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(600_000);
    expect(carLine(forecastCurrentMonth(bundle.db, TODAY))).toBeUndefined();
    expect(predictCategory(bundle.db, carId, "Car", TODAY).forecast.discretionaryCents).toBe(0);
  });

  /**
   * ⚖️ The AGENT'S money is not his (owner decisions 2026-10-02, 2026-10-05): a Car row on the agent's cash is not
   * money HE handed over, so the card does not count it — and the agent's own pace, which projects into EOM net worth
   * alone, keeps it. The decision is about his up-front money, and only his.
   */
  test("a Car row on the agent's cash is not his up-front money, and the agent's pace keeps it", () => {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    insertTxn({ postedOn: "2026-09-09", amountCents: -10_000, categoryId: carId, accountId: agentic });

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(0);
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(carLine(f)).toBeUndefined();
    // $0, $0, $100 → avg $33.33, trend capped at the $0 median, × 25/31
    expect(f.agentsCosts.netCents).toBe(-Math.round(((10_000 / 3) * 25) / 31));
  });

  /** A "Car" that is not top-level is not the car — the card's own resolution — and its spend stays pace. */
  test("without a top-level Car the pace is untouched, even beside a sub-category named Car", () => {
    // a fresh ledger shape: no top-level Car at all, and a Transport > Car
    bundle.db.update(recurringSeries).set({ userCategoryId: null }).run();
    bundle.db.update(transactions).set({ categoryId: groceriesId }).where(eq(transactions.categoryId, carInsuranceId)).run();
    bundle.db.update(transactions).set({ categoryId: groceriesId }).where(eq(transactions.categoryId, carId)).run();
    bundle.db.delete(categories).where(eq(categories.id, carInsuranceId)).run();
    bundle.db.delete(categories).where(eq(categories.id, carId)).run();
    const transport = bundle.db.select().from(categories).where(eq(categories.name, "Transport")).get()!.id;
    const transportCar = addCategory("Car", transport);
    insertTxn({ postedOn: "2026-09-02", amountCents: -30_000, categoryId: transportCar });

    expect(carCard(bundle.db, TODAY)).toBeNull();
    const f = forecastCurrentMonth(bundle.db, TODAY);
    // $0, $0, $300 → avg $100, trend capped at the $0 median, × 25/31
    expect(f.components.find((c) => c.label === "Transport")?.cents).toBe(-Math.round((10_000 * 25) / 31));
  });
});

describe("paid up front means BEFORE the lease starts (owner decision 2026-10-07, §6A 52)", () => {
  /**
   * ⚖️ Only Car rows dated before the lease starts (2026-09-11) are money handed over up front. A non-bill Car row
   * after it — a repair, a registration, EV charging — is ordinary spending: in the pace, in the budgets, and never
   * spread over the lease on the card. 🔴 Before this answer every unlinked Car row was "up front" for good, so the
   * first repair would have been amortised over 24 months and left out of every pace.
   */
  test("a Car repair after the lease starts is ordinary spending, not up front", () => {
    postTheUpfrontMoney();
    insertTxn({ postedOn: "2026-09-20", amountCents: -30_000, categoryId: carId });

    // the card keeps his $6,100, and only it
    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(610_000);
    // the pace carries the repair: $0, $0, $300 → avg $100, trend capped at the $0 median, × 25/31
    expect(carLine(forecastCurrentMonth(bundle.db, TODAY))?.cents).toBe(-Math.round((10_000 * 25) / 31));
    expect(predictCategory(bundle.db, carId, "Car", TODAY).forecast.discretionaryCents).toBe(10_000);
  });

  test("the boundary: the day before the lease starts is up front, the day it starts is not", () => {
    insertTxn({ postedOn: "2026-09-10", amountCents: -1_000, categoryId: carId });
    insertTxn({ postedOn: "2026-09-11", amountCents: -2_000, categoryId: carId });

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(1_000);
    // only the $20 of the 11th is pace: $0, $0, $20 → avg $6.67, × 25/31
    expect(carLine(forecastCurrentMonth(bundle.db, TODAY))?.cents).toBe(-Math.round(((2_000 / 3) * 25) / 31));
  });

  /** A wash club the owner dismissed, charged after the lease starts, is a habit like any other. */
  test("a dismissed series' Car row after the lease starts is in the pace", () => {
    const club = addSeries({ name: "Car wash club", nextExpectedOn: "2026-10-20", amountCents: -2_500, userCategoryId: carId, status: "dismissed" });
    insertTxn({ postedOn: "2026-09-20", amountCents: -2_500, categoryId: carId, recurringSeriesId: club });

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(0);
    expect(carLine(forecastCurrentMonth(bundle.db, TODAY))?.cents).toBe(-Math.round(((2_500 / 3) * 25) / 31));
  });
});

describe("every spending rate leaves the up-front money out (owner decision 2026-10-07, §6A 51)", () => {
  /**
   * ⚖️ The runway's "What you spend a month" averaged the $6,100 in as ordinary spending: on his ledger the Apr–Sep
   * average read $9,259.32, $1,016.67 a month of it the down payment and deposit ÷ 6. Here, two complete months
   * (Aug, Sep): $8,460.20 of spending, $6,100.00 of it up front.
   */
  test("the runway's spend baseline leaves it out, and its caption says so", () => {
    postTheUpfrontMoney();
    const spend = spendBaseline(bundle.db, TODAY);
    expect(spend).toMatchObject({ months: 2, fromMonth: "2026-08", toMonth: "2026-09", upfrontCarCents: 610_000 });
    expect(spend.monthlyCents).toBe((846_020 - 610_000) / 2);

    const r = runwayCard(bundle.db, TODAY);
    expect(r.runway.assumptions.find((a) => a.id === "spend")?.cents).toBe(118_010);
    // a sentence that claims a plain average must say what it left out
    expect(baselineCaption(r.spend)).toBe(
      "Spending averaged over 2 complete months, Aug 2026 to Sep 2026, leaving out the $6,100.00 paid up front for " +
        "the car, which the car card spreads over the lease. This month is still running and is not counted.",
    );
  });

  test("with nothing up front the caption is the plain average it always was", () => {
    expect(spendBaseline(bundle.db, TODAY).upfrontCarCents).toBe(0);
    expect(baselineCaption(runwayCard(bundle.db, TODAY).spend)).toBe(
      "Spending averaged over 2 complete months, Aug 2026 to Sep 2026. This month is still running and is not counted.",
    );
  });

  /**
   * The car card measures his spending "before the car" from the same baseline, less the car. With the up-front money
   * already out of the baseline, taking it out again would subtract it twice — the share must still reconcile.
   */
  test("the car card's spending-before-the-car still reconciles with the runway's baseline", () => {
    postTheUpfrontMoney();
    const c = carCard(bundle.db, TODAY)!;
    const runwaySpend = spendBaseline(bundle.db, TODAY).monthlyCents;
    // the car's other spend in Aug + Sep: two premiums and a lease payment
    const carBillsPerMonth = (-INSURANCE * 2 - LEASE) / 2;
    expect(c.baseline.monthlyCents).toBe(runwaySpend - carBillsPerMonth);
    expect(c.baseline.monthlyCents).toBe(47_500); // groceries alone, ($500 + $450) / 2
    expect(c.cost.allInProjectedMonthlySpendCents).toBe(47_500 - (LEASE + INSURANCE) + 25_417);
  });

  /**
   * 🔴 The dashboard's pace tile and /spending's "projected" extrapolate the month's spend so far. Replayed at
   * 2026-08-20 on his ledger, the $6,100 in August's first twenty days read as a rate: $16,841.12 projected. It is
   * spent once — counted in the total, never extrapolated.
   */
  test("the month's pace counts the up-front money once and does not extrapolate it", () => {
    const day = "2026-08-20";
    const period = resolvePeriod({}, day);
    const read = () => {
      const flow = cashFlowByPeriod(bundle.db, period, day);
      return {
        tile: flow.pace!.projectedCents,
        spending: spendingProjection(bundle.db, period, day, flow.pace, flow.totals.spentCents).projectedSpendCents!,
      };
    };
    const without = read();
    postTheUpfrontMoney();
    const withIt = read();

    expect(withIt.tile).toBe(without.tile + 610_000);
    expect(withIt.spending).toBe(without.spending + 610_000);
    // $857.58 of ordinary spend in 20 of 31 days, + the $6,100 once
    expect(withIt.tile).toBe(610_000 + Math.round((85_758 * 31) / 20));
  });

  /**
   * /budgets' run-rate is the same arithmetic per category. Its one-off guard catches a charge bigger than the whole
   * plan; on a $7,000 Car budget neither the $5,000 nor the $1,100 is, and both were extrapolated over the rest of
   * August. The up-front money is spent — the row is graded on it — but it is no rate.
   */
  test("/budgets' run-rate counts the up-front money once and does not extrapolate it", () => {
    createBudget(bundle.db, { categoryId: carId, period: "monthly", amountCents: 700_000, startsOn: "2026-08-01" });
    const day = "2026-08-20";
    const row = () => budgetPaceStatuses(bundle.db, day).find((s) => s.budget.categoryId === carId)!;
    const without = row();
    postTheUpfrontMoney();
    const withIt = row();

    expect(withIt.spentCents).toBe(without.spentCents + 610_000);
    expect(withIt.projectedCents).toBe(without.projectedCents + 610_000);
  });

  /**
   * ⛔ …and ONCE. On a budget smaller than the down payment the one-off guard (a charge bigger than the plan) catches
   * it too; held out by both, it would hide its own size of ordinary spend from the run-rate — here, a repair.
   */
  test("/budgets' run-rate holds a row that is both up front and over the plan out once", () => {
    createBudget(bundle.db, { categoryId: carId, period: "monthly", amountCents: 120_000, startsOn: "2026-09-01" });
    const day = "2026-09-20";
    // a repair after the lease starts: ordinary spending, a rate
    insertTxn({ postedOn: "2026-09-15", amountCents: -20_000, categoryId: carId });
    const row = () => budgetPaceStatuses(bundle.db, day).find((s) => s.budget.categoryId === carId)!;
    const without = row();
    // up front (before the lease starts) AND over the $1,200 plan
    insertTxn({ postedOn: "2026-09-05", amountCents: DOWN_PAYMENT, categoryId: carId });
    const withIt = row();

    expect(withIt.projectedCents).toBe(without.projectedCents + 500_000);
  });

  /** The budget editor's six-month guide is a rate too: the up-front money is no guide to a month of the car. */
  test("the budget guidance leaves it out", () => {
    const without = budgetGuidanceCents(bundle.db, carId, "monthly", TODAY);
    postTheUpfrontMoney();
    expect(budgetGuidanceCents(bundle.db, carId, "monthly", TODAY)).toBe(without);
    expect(without).toBeGreaterThan(0);
  });

  /**
   * His $5,000 was handed over in cash, from the Cash on Hand wallet — a manual row on an account no import reaches.
   * It is up front like the card-paid deposit, on every surface.
   */
  test("a down payment from a cash wallet is up front on the card and out of every rate", () => {
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-01", openingBalanceCents: 500_000 });
    addManualTransaction(bundle.db, {
      accountId: wallet,
      postedOn: "2026-08-11",
      amountCents: DOWN_PAYMENT,
      description: "Car down payment",
      categoryId: carId,
    });

    expect(carCard(bundle.db, TODAY)!.cost.upfrontCents).toBe(500_000);
    // Aug + Sep: $7,360.20 of spending, $5,000.00 of it up front
    expect(spendBaseline(bundle.db, TODAY)).toMatchObject({ upfrontCarCents: 500_000, monthlyCents: (736_020 - 500_000) / 2 });
    expect(carLine(forecastCurrentMonth(bundle.db, TODAY))).toBeUndefined();
    expect(predictCategory(bundle.db, carId, "Car", TODAY).forecast.discretionaryCents).toBe(0);
    const day = "2026-08-20";
    const flow = cashFlowByPeriod(bundle.db, resolvePeriod({}, day), day);
    // $857.58 of ordinary spend in 20 of 31 days, + the $5,000 once
    expect(flow.pace!.projectedCents).toBe(500_000 + Math.round((85_758 * 31) / 20));
  });
});
