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
import { addDays, periodBounds } from "@/lib/dates";
import { incomeExpectation } from "./budgets";
import { cashEarningsReadings } from "./cash-earnings";
import { incomeCard } from "./income-card";
import { paydaySettlement } from "./payday-settlement";
import { recurringCalendar } from "./recurring-calendar";

/**
 * ⚖️ ONE PAYDAY UNIVERSE (§6A 55, step B): every reader of a pay series' paydays opens on the same first payday — the
 * anchor's rhythm walked back to the series' first deposit (`firstPaydayOn`). Earned vs banked, the settlement, the
 * recurring calendar and /budgets name the same paydays.
 *
 * 🔴 Two universes, measured 2026-10-08: Earned vs banked counted from the first linked DEPOSIT (his Jun 4 — 18
 * paydays); the settlement, the calendar and /budgets walked from the stored ANCHOR, which `stepsToReach` never walks
 * back from (his Jul 23). June's $1,047.00 cash week was earned on the income card and on no other page: the calendar
 * drew no payday in June and /budgets scheduled none. On the e2e fixture the two universes were a week apart — the
 * card counted Paycheck's deposit Fridays from Jan 2, the calendar its anchor's Fridays from Jul 10.
 */

let dir: string;
let bundle: DbBundle;
const WELLS = "acct-wells";
const PAY = "series-pay";
const now = (): string => new Date().toISOString();

function salaryCategoryId(): string {
  const top = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Income"), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Salary"), eq(categories.parentId, top.id)))
    .get()!.id;
}

let seq = 0;
function deposit(postedOn: string, amountCents: number): string {
  seq += 1;
  const id = `t-${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: WELLS,
      postedOn,
      amountCents,
      rawDescription: "PAYROLL",
      normalizedDescription: "PAYROLL",
      categoryId: salaryCategoryId(),
      recurringSeriesId: PAY,
      seriesLinkSource: "user",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

function readThrough(from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WELLS, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

/** Per month: the paydays Earned vs banked counts, and the ones /budgets schedules — the same set, or two universes. */
function countsByMonth(months: readonly string[], today: string): { card: number[]; budgets: number[] } {
  const card: number[] = [];
  const budgets: number[] = [];
  for (const m of months) {
    const { start, end } = periodBounds(`${m}-01`, "monthly");
    card.push(cashEarningsReadings(bundle.db, { from: start, to: end, today }).find((r) => r.seriesId === PAY)!.periodsCovered);
    budgets.push(incomeExpectation(bundle.db, start, end, today).scheduledOccurrences);
  }
  return { card, budgets };
}

/** The paydays the calendar draws in a month with no row of their own standing for them. */
const drawnPaydays = (month: string, today: string): string[] =>
  Object.entries(recurringCalendar(bundle.db, month, today).entriesByDay)
    .filter(([, entries]) => entries.some((e) => e.seriesId === PAY && e.transactionId === null))
    .map(([day]) => day)
    .sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-payday-universe-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: WELLS,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** His series as his ledger stores it (2026-10-08): weekly Thursdays, his $1,141.92, detection's Jul 23 anchor. */
describe("his ledger — the income card and settlement name the same paydays, from Jun 4", () => {
  const TODAY = "2026-10-08";
  const WEEK = 114_192;
  const CASH = 104_700;
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: PAY,
        name: "It America LLC (weekly pay)",
        kind: "income",
        cadence: "weekly",
        userCadence: "weekly",
        intervalDaysAvg: 7,
        amountCentsAvg: 104_600,
        userAmountCents: WEEK,
        userAmountHistory: [{ throughOn: "2026-08-26", amountCents: CASH }],
        nextExpectedOn: "2026-07-23",
        nextExpectedAmountCents: 104_600,
        lastMatchedOn: "2026-07-23",
        status: "confirmed",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    readThrough("2026-06-01", "2026-09-24");
    deposit("2026-06-04", CASH);
    deposit("2026-06-05", 40_000);
    deposit("2026-09-23", WEEK * 4);
    deposit("2026-09-24", WEEK);
  });

  test("the income card counts 18 paydays from Jun 4, and the settlement opens on Jun 4", () => {
    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.paydaysLabel).toBe("18 paydays, Jun 4 – Oct 1");
    expect(paydaySettlement(bundle.db, PAY, TODAY).firstPaydayOn).toBe("2026-06-04");
  });

  /* Jun 4's cash week is a payday its own deposit paid in full; Jun 5's $400.00 reaches no other payday. */
  test("the settlement pays Jun 4 with Jun 4's money; Sep 23 pays Sep 24, 17, 10 and 3; Sep 24 pays Aug 27", () => {
    const s = paydaySettlement(bundle.db, PAY, TODAY);
    expect(s.portions.map((p) => `${p.paydayOn} ← ${p.depositOn} ${p.cents}`).sort()).toEqual([
      `2026-06-04 ← 2026-06-04 ${CASH}`,
      `2026-08-27 ← 2026-09-24 ${WEEK}`,
      `2026-09-03 ← 2026-09-23 ${WEEK}`,
      `2026-09-10 ← 2026-09-23 ${WEEK}`,
      `2026-09-17 ← 2026-09-23 ${WEEK}`,
      `2026-09-24 ← 2026-09-23 ${WEEK}`,
    ]);
    expect(s.unallocatedCents).toBe(40_000);
  });

  test("month by month, Earned vs banked and /budgets count the same paydays", () => {
    const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
    const { card, budgets } = countsByMonth(months, TODAY);
    expect(card).toEqual([0, 4, 5, 4, 4]);
    expect(budgets).toEqual(card);
  });

  test("June on /budgets: four cash weeks scheduled at $4,188.00, the one Jun 4's money paid not among the unpaid", () => {
    const june = incomeExpectation(bundle.db, "2026-06-01", "2026-06-30", "2026-07-01");
    expect([june.scheduledOccurrences, june.scheduledCents]).toEqual([4, CASH * 4]);
    // read on Jul 1, the passed-unpaid leg walks June: Jun 11, 18 and 25
    expect([june.passedUnpaidOccurrences, june.passedUnpaidCents]).toEqual([3, CASH * 3]);
  });

  test("the calendar draws no payday before Jun 4, then June's unpaid cash weeks and July's", () => {
    expect(drawnPaydays("2026-05", TODAY)).toEqual([]);
    expect(drawnPaydays("2026-06", TODAY)).toEqual(["2026-06-11", "2026-06-18", "2026-06-25"]);
    expect(drawnPaydays("2026-07", TODAY)).toEqual(["2026-07-02", "2026-07-09", "2026-07-16", "2026-07-23", "2026-07-30"]);
  });
});

/**
 * The e2e fixture's shape: a biweekly Paycheck anchored Fri Jul 10, 2026, whose deposits fall on the OTHER Fridays.
 * The card counted the deposits' Fridays; the calendar and /budgets the anchor's. One universe: the anchor's.
 */
describe("deposits a week off the anchor's rhythm — the anchor's rhythm, walked back to them", () => {
  const TODAY = "2026-07-08";
  const PAYDAY = 294_319;
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: PAY,
        name: "Paycheck",
        kind: "income",
        cadence: "biweekly",
        intervalDaysAvg: 14,
        amountCentsAvg: PAYDAY,
        nextExpectedOn: "2026-07-10",
        nextExpectedAmountCents: PAYDAY,
        lastMatchedOn: "2026-06-26",
        status: "confirmed",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    readThrough("2026-01-01", "2026-06-30");
    for (let day = "2026-01-02"; day <= "2026-05-08"; day = addDays(day, 14)) deposit(day, PAYDAY);
  });

  test("the income card counts the anchor's Fridays from Jan 9, where the settlement opens", () => {
    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.paydaysLabel).toBe("13 paydays, Jan 9 – Jun 26");
    expect(paydaySettlement(bundle.db, PAY, TODAY).firstPaydayOn).toBe("2026-01-09");
  });

  test("month by month, Earned vs banked and /budgets count the same paydays", () => {
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
    const { card, budgets } = countsByMonth(months, TODAY);
    expect(card).toEqual([2, 2, 2, 2, 3, 2]);
    expect(budgets).toEqual(card);
  });

  test("the calendar draws January's paydays on the anchor's Fridays", () => {
    expect(drawnPaydays("2026-01", TODAY)).toEqual(["2026-01-09", "2026-01-23"]);
  });
});

/**
 * A monthly pay on the 30th, first paid in late February: walked back, its first payday is February's 30th clamped —
 * the 28th — and every payday after it is the 30th again, on the card as on /budgets.
 */
describe("a monthly pay on the 30th, first paid in February", () => {
  const TODAY = "2026-07-15";
  const MONTH = 500_000;
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: PAY,
        name: "Monthly pay",
        kind: "income",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: MONTH,
        nextExpectedOn: "2026-07-30",
        nextExpectedAmountCents: MONTH,
        lastMatchedOn: "2026-06-30",
        status: "confirmed",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    readThrough("2026-02-01", "2026-07-14");
    deposit("2026-02-27", MONTH);
  });

  test("the card counts Feb 28 and then the 30th — not the 28th of every month after", () => {
    expect(paydaySettlement(bundle.db, PAY, TODAY).firstPaydayOn).toBe("2026-02-28");
    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.paydaysLabel).toBe("5 paydays, Feb 28 – Jun 30");
  });
});

/**
 * A schedule the owner DATED walks the owner's cadence: his date replaces detection's measured gap
 * (`effectiveSeries`), so a weekly pay measured at 7.6 days steps 7 — on the card as on the calendar. 🔴 The card read
 * the measured gap and stepped 8 days.
 */
describe("a weekly pay the owner dated, measured at 7.6 days", () => {
  const TODAY = "2026-07-08";
  const WEEK = 100_000;
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: PAY,
        name: "Weekly pay",
        kind: "income",
        cadence: "weekly",
        intervalDaysAvg: 7.6,
        amountCentsAvg: WEEK,
        nextExpectedOn: "2026-07-10",
        userNextExpectedOn: "2026-07-09",
        nextExpectedAmountCents: WEEK,
        lastMatchedOn: "2026-07-02",
        status: "confirmed",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    readThrough("2026-04-01", "2026-07-07");
    deposit("2026-04-02", WEEK);
  });

  test("month by month, Earned vs banked and /budgets count the same Thursdays", () => {
    expect(paydaySettlement(bundle.db, PAY, TODAY).firstPaydayOn).toBe("2026-04-02");
    const { card, budgets } = countsByMonth(["2026-04", "2026-05", "2026-06"], TODAY);
    expect(card).toEqual([5, 4, 4]);
    expect(budgets).toEqual(card);
  });
});
