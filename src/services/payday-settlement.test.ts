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

const settled = (today = TODAY): string[] => [...settledPaydaysForSeries(bundle.db, PAY, today).keys()].sort();

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
    expect([...settledPaydaysForSeries(bundle.db, "series-late", TODAY).keys()].sort()).toEqual([
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

/**
 * 🔴 A PAYDAY SETTLED BY ANOTHER MONTH'S DEPOSIT FELL OUT OF EVERY FIGURE.
 *
 * Settlement's deposit universe has no month in it — that is the whole point of
 * it, and why Aug 27 can be retired by a deposit dated Sep 24. But every
 * surface that reads the answer publishes totals over a WINDOW, and the money
 * that settled a payday can lie outside the window the reader is describing:
 *
 *   /budgets   `postedCents` is `[start, today]`
 *   calendar   the Settled total is the month being drawn
 *
 * Dropped from the expectation and absent from the posted total, the payday was
 * named by NOTHING. Measured on 2026-10-01 — a Thursday, three days after the
 * ledger's TODAY — with one deposit of $1,141.92 dated 2026-09-30:
 *
 *   /budgets   posted $0.00 + expected $4,567.68 + passed-unpaid $0.00
 *              against five paydays scheduled at $5,709.60
 *   calendar   Oct 1 drawn green "paid", footer Settled $0.00 Expected $4,567.68
 *
 * Both legs now have to add up to the schedule, which is the invariant the page
 * prints side by side and the reader is entitled to check.
 */
describe("a payday paid by a deposit outside the window is still named by the window", () => {
  /** One week's pay, landing the day before a payday that falls on the 1st. */
  function lastDayOfSeptember(): void {
    readThrough(WELLS, "2026-06-01", "2026-09-30");
    deposit(PAY, "2026-09-30", WEEK);
  }

  /** Every leg the /budgets header prints for the month's pay, summed. */
  const allFourLegs = (i: ReturnType<typeof incomeExpectation>): number =>
    i.postedCents + i.expectedCents + i.passedUnpaidCents + i.paidByAnotherMonthCents;

  test("October's income still adds up to October's schedule", () => {
    lastDayOfSeptember();
    const income = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-01");
    expect(income.scheduledCents).toBe(WEEK * 5);
    expect(allFourLegs(income)).toBe(WEEK * 5);
  });

  /*
   * 🔴 THE PAST LEG — the residue the fix above left (§6A 29). Once today has
   * passed the payday, the forward leg has moved beyond it, `passedUnpaidCents`
   * cannot name it (settlement says it was met) and `postedCents` never held it
   * (the money landed in September). Read on Fri 2026-10-02 with one deposit of
   * $1,141.92 dated 2026-09-30:
   *
   *   posted $0.00 + expected $4,567.68 + passed-unpaid $0.00 = $4,567.68
   *   against five paydays scheduled at $5,709.60 — $1,141.92 in no figure
   *
   * ⚖️ His answer (a): a FOURTH figure beside the other three, naming money
   * that arrived in another month — "$1,141.92 paid early, in September" —
   * rather than (b) a month that says nothing about money banked elsewhere.
   */
  test("the day after, a fourth figure names the payday September's money paid", () => {
    lastDayOfSeptember();
    const income = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-02");
    expect(income.scheduledCents).toBe(WEEK * 5);
    // the three figures the header already printed: one week short of the schedule…
    expect(income.postedCents + income.expectedCents + income.passedUnpaidCents).toBe(WEEK * 4);
    // …and the fourth, which names that week and the deposit that paid it
    expect(income.paidByAnotherMonthCents).toBe(WEEK);
    expect(income.paidByAnotherMonthOccurrences).toBe(1);
    expect(income.paidByAnotherMonthDeposits).toEqual(["2026-09-30"]);
    expect(allFourLegs(income)).toBe(income.scheduledCents);
  });

  /*
   * ⛔ AND ON THE PAYDAY ITSELF. The fix above kept this one in `expectedCents`
   * because no figure could name it otherwise. With one that can, "still
   * expected" would be calling money that landed yesterday still to come — on
   * the same Thursday /recurring draws Oct 1 "paid by the deposit of Sep 30"
   * and the forecast projects four October paydays, not five. Nothing happens
   * overnight, so nothing may move between the two readings either.
   */
  test("on the payday itself it is already paid early, as the forecast and the calendar say", () => {
    lastDayOfSeptember();
    const income = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-01");
    expect(income.expectedCents).toBe(WEEK * 4);
    expect(income.paidByAnotherMonthCents).toBe(WEEK);
    expect(forecastCurrentMonth(bundle.db, "2026-10-01").committed.incomeCents).toBe(income.expectedCents);
    expect(recurringCalendar(bundle.db, "2026-10", "2026-10-01").upcomingNetCents).toBe(income.expectedCents);
    const dayAfter = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-02");
    expect(dayAfter.paidByAnotherMonthCents).toBe(income.paidByAnotherMonthCents);
    expect(dayAfter.expectedCents).toBe(income.expectedCents);
  });

  /* The window's two edges are this month's own money: a deposit on the 1st and
     one read on the day it lands are in `postedCents`, and naming either again
     as another month's would count the same week twice. */
  test("a deposit on the month's first day, or on today, is this month's money", () => {
    readThrough(WELLS, "2026-06-01", "2026-10-08");
    deposit(PAY, "2026-10-01", WEEK);
    deposit(PAY, "2026-10-08", WEEK);
    const income = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-08");
    expect(income.postedCents).toBe(WEEK * 2);
    expect(income.paidByAnotherMonthCents).toBe(0);
    expect(allFourLegs(income)).toBe(income.scheduledCents);
  });

  /* ⛔ Only money from ANOTHER month. September's lump and weekly deposit paid
     September's paydays and sit in September's `postedCents`; naming those
     paydays here as well would count the same money twice on one line. */
  test("a payday paid by money inside the month is not named by the fourth figure", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-27");
    hisSeptember();
    const september = incomeExpectation(bundle.db, "2026-09-01", "2026-09-30", TODAY);
    expect(september.paidByAnotherMonthCents).toBe(0);
    expect(september.paidByAnotherMonthOccurrences).toBe(0);
    expect(september.paidByAnotherMonthDeposits).toEqual([]);
  });

  test("October's calendar still adds up to October's schedule", () => {
    lastDayOfSeptember();
    const october = recurringCalendar(bundle.db, "2026-10", "2026-10-01");
    expect(october.entriesByDay["2026-10-01"]?.map((e) => e.state)).toEqual(["paid"]);
    expect(october.postedNetCents + october.upcomingNetCents).toBe(WEEK * 5);
  });

  /* ⛔ AND NO DOUBLE COUNT THE OTHER WAY. September's own lump is drawn on
     September's grid as a real row; the three paydays behind it must NOT be
     added to the month's Settled total on top of the money that paid them.
     Four weeks, not the five that landed: the Sep 24 deposit paid Aug 27, and
     that week is August's figure (the next test), where its chip stands. */
  test("a payday paid by a deposit inside the month is not counted twice", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-27");
    hisSeptember();
    const september = recurringCalendar(bundle.db, "2026-09", TODAY);
    expect(september.postedNetCents).toBe(WEEK * 4);
  });

  /* August's Aug 27 was retired by the deposit of Sep 24, so the money is on
     September's grid and August's chip must say whose money it was. */
  test("August names the payday, the deposit that paid it, and counts it once", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-27");
    hisSeptember();
    const august = recurringCalendar(bundle.db, "2026-08", TODAY);
    expect(august.entriesByDay["2026-08-27"]?.[0]).toMatchObject({
      state: "paid",
      settledByDepositsOn: ["2026-09-24"],
      transactionId: null,
    });
    expect(august.postedNetCents).toBe(WEEK);
    expect(august.upcomingNetCents).toBe(0);
    /*
     * ⛔ THE FOOTER TALLIES, not just the states. The settled entry is the first
     * in this codebase with `transactionId === null` and `state === "paid"`, and
     * before the guard at the end of the month walk it fell straight through to
     * the missed tally — /recurring printing a red "missed" count for the very
     * paydays the same grid draws green. Mutating that guard back to the
     * original `else missedCount += 1` left all 246 settlement tests passing.
     */
    expect(august.missedCount).toBe(0);
    expect(august.unsettledCount).toBe(3);
    expect(august.unsettledGrossCents).toBe(WEEK * 3);
    const september = recurringCalendar(bundle.db, "2026-09", TODAY);
    expect(september.missedCount).toBe(0);
    expect(september.unsettledCount).toBe(0);
  });
});

/** Every figure the /budgets header prints for the month's pay, reconciled to the schedule. */
const reconciled = (i: ReturnType<typeof incomeExpectation>): number =>
  i.postedCents - i.paidForAnotherMonthCents + i.expectedCents + i.passedUnpaidCents + i.paidByAnotherMonthCents;

/**
 * 🔴 THE OTHER HALF OF A CANCELLING PAIR.
 *
 * The fourth figure names a payday in this month that ANOTHER month's money
 * paid. Nothing named the mirror image: money posted THIS month — so inside "in
 * so far" — that settlement spent on another month's payday. Before the fourth
 * figure existed the two cancelled, and the header added up by accident.
 *
 * His own 09-23/09-24 lump-then-weekly, shifted one week so the lump lands in
 * September and the weekly deposit in October: Thu Sep 3 $1,141.92, Wed Sep 30
 * $4,567.68 (four weeks), Thu Oct 1 $1,141.92. The lump reaches forward and
 * takes Oct 1, then Sep 24, 17 and 10; the Oct 1 deposit, finding its own
 * payday already paid, goes back to Aug 27. Read Fri Oct 2, October printed
 *
 *   $1,141.92 in so far + $4,567.68 still expected + $1,141.92 paid early
 *   = $6,851.52 against five paydays scheduled at $5,709.60
 *
 * — a week too high, because the $1,141.92 in so far is the money that paid
 * August's Aug 27, and no figure said so.
 */
describe("money this month that paid another month's payday is named too", () => {
  function lumpThenWeeklyAcrossTheMonthLine(): void {
    readThrough(WELLS, "2026-06-01", "2026-10-02");
    deposit(PAY, "2026-09-03", WEEK);
    deposit(PAY, "2026-09-30", WEEK * 4);
    deposit(PAY, "2026-10-01", WEEK);
  }

  test("the settlement the header has to describe", () => {
    lumpThenWeeklyAcrossTheMonthLine();
    const by = settledPaydaysForSeries(bundle.db, PAY, "2026-10-02");
    for (const day of ["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"]) expect(by.get(day)).toBe("2026-09-30");
    expect(by.get("2026-08-27")).toBe("2026-10-01");
  });

  test("October adds up: the money in so far that paid Aug 27 is named", () => {
    lumpThenWeeklyAcrossTheMonthLine();
    const october = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-02");
    expect(october.scheduledCents).toBe(WEEK * 5);
    expect(october.postedCents).toBe(WEEK);
    expect(october.paidByAnotherMonthCents).toBe(WEEK);
    // the four figures the header printed before: a week over the schedule…
    expect(october.postedCents + october.expectedCents + october.passedUnpaidCents + october.paidByAnotherMonthCents).toBe(
      WEEK * 6,
    );
    // …because the week in so far paid August
    expect(october.paidForAnotherMonthCents).toBe(WEEK);
    expect(october.paidForAnotherMonthDeposits).toEqual(["2026-10-01"]);
    expect(october.paidForAnotherMonthPaydays).toEqual(["2026-08-27"]);
    expect(reconciled(october)).toBe(october.scheduledCents);
    // …and nothing moves overnight: on the payday itself the same money is named the same way
    const onThePayday = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-01");
    expect(onThePayday.paidForAnotherMonthCents).toBe(WEEK);
    expect(reconciled(onThePayday)).toBe(onThePayday.scheduledCents);
  });

  /* His two September deposits: the lump of Sep 23 paid Sep 3–24 and the
     weekly deposit of Sep 24 paid Aug 27, so September's "in so far" holds five
     weeks against four September paydays. August, read the same day, names the
     same $1,141.92 from its side. (On his ledger itself two June cash deposits
     pool into the lump's walk and reach Aug 27 first, so the Sep 24 deposit
     pays Aug 20 — measured on a copy 2026-09-28, same shape one week back.) */
  test("his September: the deposit of Sep 24 paid Aug 27, and both months say so", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-27");
    hisSeptember();
    const september = incomeExpectation(bundle.db, "2026-09-01", "2026-09-30", TODAY);
    expect(september.postedCents).toBe(WEEK * 5);
    expect(september.scheduledCents).toBe(WEEK * 4);
    expect(september.paidForAnotherMonthCents).toBe(WEEK);
    expect(september.paidForAnotherMonthDeposits).toEqual(["2026-09-24"]);
    expect(september.paidForAnotherMonthPaydays).toEqual(["2026-08-27"]);
    expect(reconciled(september)).toBe(september.scheduledCents);
    const august = incomeExpectation(bundle.db, "2026-08-01", "2026-08-31", TODAY);
    expect(august.paidByAnotherMonthCents).toBe(september.paidForAnotherMonthCents);
    expect(august.paidByAnotherMonthDeposits).toEqual(["2026-09-24"]);
  });

  /* Forward too: the tolerance lets September's last-day lump pay Thu Oct 1,
     so on Sep 30 that week is in September's money and October's schedule. */
  test("a lump on the month's last day that pays the 1st is named by the month it landed in", () => {
    readThrough(WELLS, "2026-06-01", "2026-09-30");
    deposit(PAY, "2026-09-03", WEEK);
    deposit(PAY, "2026-09-30", WEEK * 4);
    const september = incomeExpectation(bundle.db, "2026-09-01", "2026-09-30", "2026-09-30");
    expect(september.paidForAnotherMonthPaydays).toEqual(["2026-10-01"]);
    expect(september.paidForAnotherMonthCents).toBe(WEEK);
    expect(reconciled(september)).toBe(september.scheduledCents);
  });

  /* ⛔ Only money that left the month. A deposit paying a payday of its own
     month is that month's pay, and naming it here would count it out twice. */
  test("money that paid this month's own paydays is not named", () => {
    readThrough(WELLS, "2026-06-01", "2026-10-08");
    deposit(PAY, "2026-10-01", WEEK);
    deposit(PAY, "2026-10-08", WEEK);
    const october = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-08");
    expect(october.paidForAnotherMonthCents).toBe(0);
    expect(october.paidForAnotherMonthDeposits).toEqual([]);
    expect(october.paidForAnotherMonthPaydays).toEqual([]);
  });
});

/**
 * 🔴 THE FOURTH FIGURE IS MONEY, AND IT HAS TO BE THE MONEY IN THE ROWS IT NAMES.
 *
 * It added each payday's SCHEDULED amount wherever the settling deposit's date
 * fell outside the month — `settledBy` carries a date and no money — so it
 * misstated another month's money whenever that deposit was short, or when
 * change pooled from an earlier deposit paid part of the payday. Its sentence
 * names the deposit so the reader can go and find the row; the row has to hold
 * what the sentence says.
 */
describe("the fourth figure is the money another month's deposits put in", () => {
  /* Read Oct 2: it said $1,141.92 "paid early, by the deposit of Wed, Sep 30"
     — a row holding $1,100.00. The only gap left is the $41.92 never paid. */
  test("SHORT: a $1,100.00 deposit put $1,100.00 into Oct 1", () => {
    readThrough(WELLS, "2026-06-01", "2026-10-02");
    deposit(PAY, "2026-09-30", 110_000);
    const october = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-02");
    expect(october.paidByAnotherMonthCents).toBe(110_000);
    expect(october.paidByAnotherMonthOccurrences).toBe(1);
    expect(october.paidByAnotherMonthDeposits).toEqual(["2026-09-30"]);
    expect(reconciled(october)).toBe(october.scheduledCents - (WEEK - 110_000));
  });

  /* $5,000.00 on Sep 23 pays four weeks and carries $432.32 of change into the
     $709.60 of Oct 1, which retires Oct 1. It said $0.00 — Oct 1's settling
     deposit is October's — and $432.32 of September's money was in no figure. */
  test("POOLED: September's change that paid part of Oct 1 is named", () => {
    readThrough(WELLS, "2026-06-01", "2026-10-02");
    deposit(PAY, "2026-09-23", 500_000);
    deposit(PAY, "2026-10-01", 70_960);
    const october = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-10-02");
    expect(october.postedCents).toBe(70_960);
    expect(october.paidByAnotherMonthCents).toBe(43_232);
    expect(october.paidByAnotherMonthOccurrences).toBe(1);
    expect(october.paidByAnotherMonthDeposits).toEqual(["2026-09-23"]);
    expect(reconciled(october)).toBe(october.scheduledCents);
  });

  /* The other direction: $1,500.00 on Thu Oct 22 pays Oct 22 and carries
     $358.08, and Sun Nov 1's $783.84 tops it up to retire Oct 29. It said
     $1,141.92 of November's money — counting October's own $358.08 twice. */
  test("POOLED: October's own change is not called another month's money", () => {
    readThrough(WELLS, "2026-06-01", "2026-11-02");
    deposit(PAY, "2026-10-22", 150_000);
    deposit(PAY, "2026-11-01", 78_384);
    const october = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", "2026-11-02");
    expect(october.paidByAnotherMonthCents).toBe(78_384);
    expect(october.paidByAnotherMonthDeposits).toEqual(["2026-11-01"]);
    expect(reconciled(october)).toBe(october.scheduledCents);
  });
});
