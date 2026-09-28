import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { unbankedIncomeForSeries } from "./arrears";
import { incomeExpectation } from "./budgets";
import { forecastCurrentMonth } from "./forecast";
import { settledPaydaysForSeries } from "./payday-settlement";
import { recurringCalendar } from "./recurring-calendar";

/**
 * 🔴 ONE DEPOSIT SETTLED EXACTLY ONE PAYDAY, so a lump could never catch up.
 *
 * Measured on the owner's ledger 2026-09-28. Five weeks of pay had landed —
 * 2026-09-23 +$4,567.68 (exactly 4 × $1,141.92) and 2026-09-24 +$1,141.92, both
 * linked to "It America LLC (weekly pay)" by him — and every surface still said
 * the weeks before Sep 24 went unpaid:
 *
 *     /budgets    "3 paydays worth $3,425.76 already passed this month"
 *     /recurring  Sep 3, Sep 10, Sep 17 and all four August paydays drawn
 *                 "unsettled (unbanked)"
 *
 * ⚖️ HIS DECISION, asked as a concrete either/or and answered 2026-09-28:
 * (A) SETTLE BACKWARDS — "a deposit attributed to a pay series pays down the
 * oldest unmet paydays up to its amount, so the Sep 24 deposit retires Aug 27,
 * Sep 3, Sep 10, Sep 17 and Sep 24". He rejected (B) one-deposit-one-payday.
 *
 * The fixture is that ledger's shape, to the cent and to the day.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-28";
const WELLS = "acct-wells";
const PAY = "series-it-america";
const WEEK = 114_192;
const now = (): string => new Date().toISOString();

function categoryId(parent: string, child: string): string {
  const top = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parent), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, child), eq(categories.parentId, top.id)))
    .get()!.id;
}

function addAccount(id: string): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: id,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** His series: weekly Thursdays, confirmed, $1,141.92 typed by him. */
function addPaySeries(id: string, name: string, anchor = "2026-06-04"): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name,
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: WEEK,
      userAmountCents: WEEK,
      nextExpectedOn: anchor,
      nextExpectedAmountCents: WEEK,
      lastMatchedOn: anchor,
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let seq = 0;
/** A deposit ATTRIBUTED to the series — `series_link_source = 'user'` on his ledger. */
function deposit(seriesId: string | null, postedOn: string, amountCents: number, category = "Salary"): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: WELLS,
      postedOn,
      amountCents,
      rawDescription: "It America LLC Payroll",
      normalizedDescription: "IT AMERICA LLC PAYROLL",
      categoryId: categoryId("Income", category),
      recurringSeriesId: seriesId,
      seriesLinkSource: seriesId === null ? null : "user",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function readThrough(accountId: string, from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-settle-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(WELLS);
  addPaySeries(PAY, "It America LLC (weekly pay)");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The two deposits on his ledger today. */
function hisSeptember(): void {
  deposit(PAY, "2026-09-23", 456_768);
  deposit(PAY, "2026-09-24", WEEK);
}

const settled = (today = TODAY): string[] => [...settledPaydaysForSeries(bundle.db, PAY, today)].sort();

describe("settledPaydaysForSeries — a deposit pays down the paydays behind it", () => {
  test("his five: the lump and the weekly deposit retire Aug 27 through Sep 24", () => {
    hisSeptember();
    expect(settled()).toEqual(["2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]);
  });

  test("a lone weekly deposit still settles only its own payday", () => {
    deposit(PAY, "2026-09-24", WEEK);
    expect(settled()).toEqual(["2026-09-24"]);
  });

  /* ⛔ The reimbursement. "+$468.20 Instant Pmt From It America LLC — this was
     them paying them back for claude subscription" (his words, 2026-09-28): it
     is filed Refunds & Reimbursements and attributed to NOTHING, and money the
     owner did not call pay must never retire a payday. */
  test("an inbound row from the same payer that is not attributed settles nothing", () => {
    deposit(null, "2026-09-04", 46_820, "Refunds & Reimbursements");
    expect(settled()).toEqual([]);
  });

  /* Partial: the deposit landed ON the payday, so the payday was answered. How
     MUCH it paid is `classifyPostedAmount`'s question, not this one — and his
     June deposit really was $1,047.00 against a $1,141.92 week. */
  test("a deposit short of a full week still settles the payday it landed on, and no further", () => {
    deposit(PAY, "2026-09-24", 104_700);
    expect(settled()).toEqual(["2026-09-24"]);
  });

  /* Beyond the tolerance window the short deposit buys nothing: claiming a
     payday was paid with money that was not there is a fabricated plug. */
  test("a deposit that cannot reach a payday, and cannot cover one, settles nothing", () => {
    deposit(PAY, "2026-09-24", WEEK); // takes Sep 24
    deposit(PAY, "2026-09-25", 50_000); // reaches no unsettled payday it can afford
    expect(settled()).toEqual(["2026-09-24"]);
  });

  /* Leftover stays unallocated — it never pre-pays a payday it could not reach.
     Oct 1 is 4 days past Sep 24 + 3 days of tolerance. */
  test("a deposit bigger than every payday behind it does not pre-pay the ones ahead", () => {
    deposit(PAY, "2026-09-24", 456_768);
    expect(settled()).toEqual(["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]);
    expect(settled()).not.toContain("2026-10-01");
  });

  /* A rate change mid-run: his weeks have been $1,047.00 and $1,141.92. Three
     whole weeks of money retires three weeks; the remainder retires nothing. */
  test("an amount matching no whole number of paydays stops when the money runs out", () => {
    deposit(PAY, "2026-09-24", 400_000);
    expect(settled()).toEqual(["2026-09-10", "2026-09-17", "2026-09-24"]);
  });

  /* ⛔ Nothing after today has arrived. A deposit dated forward would otherwise
     retire paydays from a reading taken before it posted — the same refusal
     `cashEarnings` makes when it clamps its own window to `today`. */
  test("a deposit dated after the day of the reading retires nothing", () => {
    deposit(PAY, "2026-09-24", WEEK);
    expect(settled("2026-09-20")).toEqual([]);
    expect(settled("2026-09-24")).toEqual(["2026-09-24"]);
  });

  /* ⛔ Never before the series' first evidence. The ledger starts matching this
     schedule in June 2026; a payday it has no reason to think was ever owed
     must not be invented and then retired. */
  test("the walk stops at the series' first attributed deposit", () => {
    addPaySeries("series-late", "Second job", "2026-09-03");
    deposit("series-late", "2026-09-17", WEEK * 4);
    expect([...settledPaydaysForSeries(bundle.db, "series-late", TODAY)].sort()).toEqual([
      "2026-09-03",
      "2026-09-10",
      "2026-09-17",
    ]);
  });
});

describe("the surfaces agree about which paydays went unpaid", () => {
  test("/budgets stops saying three September paydays passed with no deposit", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-27");
    hisSeptember();
    const income = incomeExpectation(bundle.db, "2026-09-01", "2026-09-30", TODAY);
    expect(income.passedUnpaidOccurrences).toBe(0);
    expect(income.passedUnpaidCents).toBe(0);
  });

  test("unbankedIncomeForSeries stops counting the settled weeks, in August too", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-27");
    hisSeptember();
    expect(unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-09-01", TODAY).totalCents).toBe(0);
    // August keeps Aug 6, 13 and 20 — five weeks of pay reached back only to Aug 27
    const august = unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-08-01", TODAY);
    expect(august.series[0]?.occurrenceCount).toBe(3);
    expect(august.series[0]?.amountCents).toBe(WEEK * 3);
  });

  test("the calendar turns Aug 27 and Sep 3, 10, 17 from unsettled to paid", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-27");
    hisSeptember();
    const september = recurringCalendar(bundle.db, "2026-09", TODAY);
    for (const day of ["2026-09-03", "2026-09-10", "2026-09-17"]) {
      expect(september.entriesByDay[day]?.map((e) => e.state) ?? []).toEqual(["paid"]);
    }
    const august = recurringCalendar(bundle.db, "2026-08", TODAY);
    expect(august.entriesByDay["2026-08-27"]?.map((e) => e.state)).toEqual(["paid"]);
    expect(august.entriesByDay["2026-08-20"]?.map((e) => e.state)).toEqual(["unsettled"]);
  });

  /**
   * 🔴 THE DOUBLE COUNT. A lump that posts BEFORE the payday it covers was
   * counted twice: once in `postedCents`, and again in `expectedCents` because
   * the forward leg only dropped an occurrence dated exactly today with a
   * deposit dated exactly today. On 2026-09-23, his $4,567.68 was banked AND
   * the month still expected Sep 24's $1,141.92 on top of it.
   */
  test("a deposit that posts before the payday it covers is not also still expected", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-22");
    deposit(PAY, "2026-09-23", 456_768);
    const income = incomeExpectation(bundle.db, "2026-09-01", "2026-09-30", "2026-09-23");
    expect(income.postedCents).toBe(456_768);
    expect(income.expectedCents).toBe(0);
  });

  /* The same double count, by the forecast's door: the lump is already in the
     balance this projection starts from, so projecting Sep 24 on top of it
     would add $1,141.92 that is standing in the account. */
  test("the forecast stops projecting a payday the lump already paid", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-22");
    deposit(PAY, "2026-09-23", 456_768);
    const forecast = forecastCurrentMonth(bundle.db, "2026-09-23");
    expect(forecast.components.filter((c) => c.label === "It America LLC (weekly pay)")).toEqual([]);
    expect(forecast.unbankedIncome.occurrenceCount).toBe(0);
  });
});
