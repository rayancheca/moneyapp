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
import { formatDayLong } from "@/lib/format-date";
import { unbankedIncomeFrontierClause } from "@/lib/unbanked-income";
import { unbankedIncomeForSeries, unbankedIncomeTotals } from "./arrears";
import { incomeExpectation } from "./budgets";
import { forecastCurrentMonth } from "./forecast";

/**
 * 🔴 THE CALENDAR IS NOT THE RECORD — on the two surfaces that still asked it.
 *
 * Measured on the owner's ledger 2026-09-15: /budgets read "2 paydays worth
 * $2,094.00 already passed this month with no deposit against them" and
 * /recurring "… Cash pay that never reaches a bank cannot be projected as
 * arriving" of Sep 3 and Sep 10, while Chase Checking — the only account that
 * pay has ever landed in — had been read through Aug 12. /spending said of the
 * same two paydays, the same day, "all of it after Wed, Aug 12, 2026, which
 * nothing has imported yet".
 *
 * ⛔ The fixture is that ledger's shape: a Thursday schedule, its one attributed
 * deposit in June, and a landing account read through a day before today.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-15";
const CHASE = "acct-chase";
const SERIES = "series-cash-job";
const now = (): string => new Date().toISOString();

function salaryId(): string {
  const income = bundle.db.select().from(categories).where(and(eq(categories.name, "Income"), isNull(categories.parentId))).get()!;
  return bundle.db.select().from(categories).where(and(eq(categories.name, "Salary"), eq(categories.parentId, income.id))).get()!.id;
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

function addPaySeries(id: string, name: string, status: "confirmed" | "detected" = "confirmed"): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name,
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 100_000,
      userAmountCents: 100_000,
      nextExpectedOn: "2026-06-04",
      nextExpectedAmountCents: 100_000,
      lastMatchedOn: "2026-06-04",
      status,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let seq = 0;
function deposit(accountId: string, seriesId: string, postedOn: string): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      postedOn,
      amountCents: 100_000,
      rawDescription: "ATM CASH DEPOSIT",
      normalizedDescription: "ATM CASH DEPOSIT",
      categoryId: salaryId(),
      recurringSeriesId: seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** Days the balance walk has read — the second arbiter `accountCoverage` grades. */
function readThrough(accountId: string, from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-arrears-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(CHASE);
  addPaySeries(SERIES, "Cash job (weekly pay)");
  // the one attributed deposit: a Thursday, so the schedule's paydays are Thursdays
  deposit(CHASE, SERIES, "2026-06-04");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const unbanked = (from: string, today: string = TODAY) => unbankedIncomeForSeries(bundle.db, new Set([SERIES]), from, today);

describe("unbankedIncomeForSeries — a passed payday is measured against the day its account was read through", () => {
  test("the owner's September: both paydays fall after the frontier, so neither was looked for", () => {
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    const u = unbanked("2026-09-01");
    expect(u.totalCents).toBe(200_000);
    expect(u.series).toHaveLength(1);
    expect(u.series[0]).toMatchObject({
      nextDate: "2026-09-03",
      occurrenceCount: 2,
      amountCents: 200_000,
      checkedThrough: "2026-08-12",
      checkedOccurrenceCount: 0,
      checkedCents: 0,
    });
  });

  /* ⛔ A date window has two ends, and so does "read": a payday ON the frontier
     day was read; the payday a week later was not. */
  test("a window straddling the frontier splits on it, and the frontier day itself is read", () => {
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    // walk [Aug 1, Aug 20]: Aug 6 (read), Aug 13 and Aug 20 (after the frontier)
    expect(unbanked("2026-08-01", "2026-08-21").series[0]).toMatchObject({
      occurrenceCount: 3,
      checkedOccurrenceCount: 1,
      checkedCents: 100_000,
      checkedThrough: "2026-08-12",
    });
    readThrough(CHASE, "2026-08-13", "2026-08-13");
    expect(unbanked("2026-08-01", "2026-08-21").series[0]).toMatchObject({
      occurrenceCount: 3,
      checkedOccurrenceCount: 2,
      checkedCents: 200_000,
      checkedThrough: "2026-08-13",
    });
  });

  test("a window read through the day before today has every passed payday checked", () => {
    readThrough(CHASE, "2026-06-01", "2026-09-14");
    expect(unbanked("2026-09-01").series[0]).toMatchObject({
      occurrenceCount: 2,
      checkedOccurrenceCount: 2,
      checkedCents: 200_000,
      checkedThrough: "2026-09-14",
    });
  });

  /**
   * 🔴 Measured on a copy of the owner's ledger 2026-10-07: /recurring and
   * /budgets said Oct 1 "falls after Wed, Aug 12, 2026" for It America LLC's
   * weekly payroll, whose series names Wells Fargo (checked through Sep 24; he
   * moved it there 2026-09-28). Two Jun 4–5 ATM deposits in Chase Checking,
   * checked through Aug 12, dragged the frontier back. A payday's deposit is
   * looked for where the pay lands NOW — the series' own account when it names
   * one.
   */
  test("a series that names its account is looked for there, not where old pay landed", () => {
    const WF = "acct-wf";
    addAccount(WF);
    bundle.db.update(recurringSeries).set({ accountId: WF }).where(eq(recurringSeries.id, SERIES)).run();
    deposit(WF, SERIES, "2026-08-27");
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    readThrough(WF, "2026-06-01", "2026-09-10");
    // walk [Sep 1, Sep 14]: Sep 3 and Sep 10 on read Wells Fargo days
    expect(unbanked("2026-09-01").series[0]).toMatchObject({
      occurrenceCount: 2,
      checkedThrough: "2026-09-10",
      checkedOccurrenceCount: 2,
    });
  });

  // one deposit elsewhere is not a move (`POSTING_DAYS_THAT_SAY_WHERE`): Chase stays a place the pay could land
  test("a series that names no account is still looked for everywhere its last two deposits landed", () => {
    const WF = "acct-wf";
    addAccount(WF);
    deposit(WF, SERIES, "2026-08-27");
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    readThrough(WF, "2026-06-01", "2026-09-10");
    expect(unbanked("2026-09-01").series[0]).toMatchObject({ checkedThrough: "2026-08-12", checkedOccurrenceCount: 0 });
  });

  test("a landing account nobody has read has no frontier, and nothing counts as checked", () => {
    expect(unbanked("2026-09-01").series[0]).toMatchObject({ occurrenceCount: 2, checkedThrough: null, checkedOccurrenceCount: 0, checkedCents: 0 });
  });

  test("a pay series that has never landed anywhere has no frontier either", () => {
    readThrough(CHASE, "2026-06-01", "2026-09-14");
    addPaySeries("series-new", "New job", "detected");
    const u = unbankedIncomeForSeries(bundle.db, new Set(["series-new"]), "2026-09-01", TODAY);
    expect(u.series[0]).toMatchObject({ occurrenceCount: 2, checkedThrough: null, checkedOccurrenceCount: 0 });
  });

  /* The figure itself does not move: every one of these is still "counted in
     neither figure above" — the frontier changes what may be SAID about it. */
  test("the frontier never changes the total", () => {
    const before = unbanked("2026-09-01");
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    expect(unbanked("2026-09-01").totalCents).toBe(before.totalCents);
  });
});

describe("unbankedIncomeTotals — one reading for a sentence about several series", () => {
  /**
   * 🔴 THE EARLIEST FRONTIER IS NOT A FRONTIER FOR EVERY SCHEDULE. The reading
   * used to reduce several schedules to their earliest day, and the one clause
   * then said "1 falls on a day already read, with no deposit; the other 3 fall
   * after Wed, Aug 12, 2026, which nothing has imported yet" — while the account
   * Tutoring lands in had been checked through Sep 4, and Tutoring's own Sep 3,
   * after Aug 12, was the payday it called read (measured 2026-09-15, this
   * fixture). A day is named only when every schedule shares it.
   */
  test("schedules checked through different days share no frontier, so no day is named", () => {
    addAccount("acct-sofi");
    addPaySeries("series-tutor", "Tutoring");
    deposit("acct-sofi", "series-tutor", "2026-06-04");
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    readThrough("acct-sofi", "2026-06-01", "2026-09-04");

    const t = unbankedIncomeTotals(unbankedIncomeForSeries(bundle.db, new Set([SERIES, "series-tutor"]), "2026-09-01", TODAY));
    expect(t).toEqual({
      totalCents: 400_000,
      occurrenceCount: 4,
      checkedOccurrenceCount: 1, // Tutoring's Sep 3
      frontier: { kind: "per-schedule" },
      names: ["Cash job (weekly pay)", "Tutoring"],
    });
    const words = unbankedIncomeFrontierClause(t, formatDayLong);
    expect(words).toBe(
      "1 falls on a day already checked, with no deposit; the other 3 fall after the last day the accounts their pay lands in have been checked through, which differs by schedule.",
    );
    expect(words).not.toMatch(/Aug 12|Sep 4/);
  });

  test("schedules checked through the SAME day still name it", () => {
    addPaySeries("series-tutor", "Tutoring");
    deposit(CHASE, "series-tutor", "2026-06-04");
    readThrough(CHASE, "2026-06-01", "2026-08-12");

    const t = unbankedIncomeTotals(unbankedIncomeForSeries(bundle.db, new Set([SERIES, "series-tutor"]), "2026-09-01", TODAY));
    expect(t.frontier).toEqual({ kind: "day", through: "2026-08-12" });
    expect(unbankedIncomeFrontierClause(t, formatDayLong)).toContain("They all fall after Wed, Aug 12, 2026,");
  });

  test("one unchecked landing account makes the whole reading unchecked", () => {
    addAccount("acct-sofi");
    addPaySeries("series-tutor", "Tutoring");
    deposit("acct-sofi", "series-tutor", "2026-06-04");
    readThrough(CHASE, "2026-06-01", "2026-09-14");

    const t = unbankedIncomeTotals(unbankedIncomeForSeries(bundle.db, new Set([SERIES, "series-tutor"]), "2026-09-01", TODAY));
    expect(t.frontier).toEqual({ kind: "unchecked" });
    expect(t.checkedOccurrenceCount).toBe(2);
  });

  test("nothing passed unpaid reads as nothing", () => {
    expect(unbankedIncomeTotals({ totalCents: 0, series: [] })).toEqual({
      totalCents: 0,
      occurrenceCount: 0,
      checkedOccurrenceCount: 0,
      frontier: { kind: "unchecked" },
      names: [],
    });
  });
});

describe("both surfaces that print the figure carry the split", () => {
  test("/budgets' income expectation and /recurring's forecast read the same frontier", () => {
    readThrough(CHASE, "2026-06-01", "2026-08-12");

    const income = incomeExpectation(bundle.db, "2026-09-01", "2026-09-30", TODAY);
    expect([income.passedUnpaidOccurrences, income.passedUnpaidCents]).toEqual([2, 200_000]);
    expect(income.passedUnpaidCheckedOccurrences).toBe(0);
    expect(income.passedUnpaidFrontier).toEqual({ kind: "day", through: "2026-08-12" });

    expect(forecastCurrentMonth(bundle.db, TODAY).unbankedIncome).toEqual({
      totalCents: 200_000,
      occurrenceCount: 2,
      checkedOccurrenceCount: 0,
      frontier: { kind: "day", through: "2026-08-12" },
      names: ["Cash job (weekly pay)"],
    });
  });
});
