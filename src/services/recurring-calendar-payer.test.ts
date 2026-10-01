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
import { daysInMonthOf } from "@/lib/calendar-math";
import { addDays } from "@/lib/dates";
import { flowEntryOf, monthFlow } from "@/lib/month-flow";
import { incomeExpectation } from "./budgets";
import {
  payerStandsForPayday,
  recurringCalendar,
  type CalendarEntry,
  type RecurringCalendarMonth,
} from "./recurring-calendar";

/**
 * 🔴 THE CALENDAR NAMED ITS OWN PAYER FOR A PAYDAY, BEFORE ASKING SETTLEMENT.
 *
 * `services/payday-settlement` is the one answer to "which deposit paid this
 * payday" — /budgets, arrears and the forecast all read it. The calendar asked
 * it only AFTER its own older rule had spoken: a payday with any row of the
 * series within tolerance was treated as paid by that row and never drawn.
 *
 * His 09-23/09-24 lump-then-weekly shifted one week (§6A 29 review): Thu Sep 3
 * $1,141.92, Wed Sep 30 $4,567.68, Thu Oct 1 $1,141.92. Settlement spends the
 * lump on Oct 1 and Sep 24, 17, 10, and the Oct 1 deposit — its own payday
 * already paid — on Aug 27. The calendar drew Oct 1 paid by the Oct 1 row AND
 * chipped Aug 27 "paid by the deposit of Oct 1": one deposit, two paydays, and
 * the row counted in both months' Settled figures while /budgets said Sep 30
 * paid Oct 1.
 */

let dir: string;
let bundle: DbBundle;
const WELLS = "acct-wells";
const PAY = "series-it-america";
const WEEK = 114_192;
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

/** His series: weekly Thursdays, confirmed, $1,141.92 typed by him. */
function addPaySeries(anchor: string): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      id: PAY,
      name: "It America LLC (weekly pay)",
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
/** A deposit ATTRIBUTED to the pay series — `series_link_source = 'user'` on his ledger. */
function deposit(postedOn: string, amountCents: number): void {
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
}

function readThrough(from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WELLS, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-payer-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: WELLS,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: WELLS,
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

/** The pay series' marks on one day: the deposit rows that landed, and the payday drawn on its own. */
function marksOn(month: RecurringCalendarMonth, day: string): { rows: CalendarEntry[]; payday: CalendarEntry | undefined } {
  const entries = (month.entriesByDay[day] ?? []).filter((e) => e.seriesId === PAY);
  return { rows: entries.filter((e) => e.transactionId !== null), payday: entries.find((e) => e.transactionId === null) };
}

/** Every figure /budgets prints for the month's pay that is money landed or paid, as the calendar's Settled sees it. */
function budgetsSettled(month: string, today: string): number {
  const end = `${month}-${String(daysInMonthOf(month)).padStart(2, "0")}`;
  const i = incomeExpectation(bundle.db, `${month}-01`, end, today);
  return i.postedCents - i.paidForAnotherMonthCents + i.paidByAnotherMonthCents;
}

describe("the shifted case — a lump on Sep 30 pays Oct 1, and Oct 1's deposit pays Aug 27", () => {
  const TODAY = "2026-10-02";

  beforeEach(() => {
    addPaySeries("2026-06-04");
    readThrough("2026-06-01", TODAY);
    deposit("2026-09-03", WEEK);
    deposit("2026-09-30", WEEK * 4);
    deposit("2026-10-01", WEEK);
  });

  test("Oct 1 is drawn paid by the deposit of Sep 30 — settlement's payer, and /budgets' — not by the row on it", () => {
    const october = recurringCalendar(bundle.db, "2026-10", TODAY);
    const { rows, payday } = marksOn(october, "2026-10-01");
    expect(payday).toMatchObject({ state: "paid", amountCents: WEEK, settledByDepositsOn: ["2026-09-30"] });
    expect(rows).toHaveLength(1);
    const budgets = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", TODAY);
    expect(payday?.settledByDepositsOn).toEqual(budgets.paidByAnotherMonthDeposits);
  });

  test("the deposit of Oct 1 is drawn paying the one payday it paid, Aug 27, as both months say", () => {
    const october = recurringCalendar(bundle.db, "2026-10", TODAY);
    const [row] = marksOn(october, "2026-10-01").rows;
    expect(row?.settlesPaydaysOn).toEqual(["2026-08-27"]);
    const budgets = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", TODAY);
    expect(row?.settlesPaydaysOn).toEqual(budgets.paidForAnotherMonthPaydays);
    const august = recurringCalendar(bundle.db, "2026-08", TODAY);
    expect(marksOn(august, "2026-08-27").payday?.settledByDepositsOn).toEqual(["2026-10-01"]);
  });

  /*
   * ⛔ THE CANCELLING PAIR. October's footer added up BEFORE this fix only
   * because its two errors cancelled: the Oct 1 row stood in for Oct 1's payday
   * (wrong — Sep 30 paid it) and its money stayed in October (wrong — it paid
   * Aug 27, which August counts). Drawing the right payer alone puts October a
   * week over its schedule, so the level and the total are asserted together.
   */
  test("every deposit's money is in exactly one month's Settled figure, and October still adds up", () => {
    const settled = (m: string) => recurringCalendar(bundle.db, m, TODAY).postedNetCents;
    expect(settled("2026-08")).toBe(WEEK);
    expect(settled("2026-09")).toBe(WEEK * 4);
    expect(settled("2026-10")).toBe(WEEK);
    const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
    expect(months.reduce((sum, m) => sum + settled(m), 0)).toBe(WEEK * 6);
    const october = recurringCalendar(bundle.db, "2026-10", TODAY);
    expect(october.postedNetCents + october.upcomingNetCents).toBe(WEEK * 5);
  });

  test("each month's Settled figure is /budgets' money in, less what paid other months, plus what other months paid", () => {
    for (const m of ["2026-08", "2026-09", "2026-10"]) {
      expect(recurringCalendar(bundle.db, m, TODAY).postedNetCents).toBe(budgetsSettled(m, TODAY));
    }
  });

  /* The strip above the grid and the footer under it read the same marks, so they must land on the same figures. */
  test("the flow strip's running totals end on the footer's figures", () => {
    for (const m of ["2026-09", "2026-10"]) {
      const month = recurringCalendar(bundle.db, m, TODAY);
      const flowEntries: Record<string, ReturnType<typeof flowEntryOf>[]> = {};
      for (const [iso, entries] of Object.entries(month.entriesByDay)) flowEntries[iso] = entries.map(flowEntryOf);
      const flow = monthFlow(daysInMonthOf(m), m, flowEntries, TODAY);
      expect(flow.settledCents).toBe(month.postedNetCents);
      expect(flow.endCents).toBe(month.postedNetCents + month.upcomingNetCents);
    }
  });
});

/**
 * His ledger as it stands on 2026-10-01, to the cent: two June cash deposits
 * attributed to the series, the Sep 23 lump of exactly four weeks, and the Sep
 * 24 weekly deposit. The June money pools into the lump's walk and pays Aug 27;
 * the Sep 24 deposit, its own payday already paid by the lump, pays Aug 20.
 */
describe("his ledger — a payday whose own day holds a deposit that paid another one", () => {
  const TODAY = "2026-10-01";

  beforeEach(() => {
    addPaySeries("2026-07-23");
    readThrough("2026-06-01", "2026-09-30");
    deposit("2026-06-04", 104_700);
    deposit("2026-06-05", 40_000);
    deposit("2026-09-23", WEEK * 4);
    deposit("2026-09-24", WEEK);
  });

  test("Sep 24 is drawn paid by the lump of Sep 23, and the deposit on Sep 24 says it paid Aug 20", () => {
    const september = recurringCalendar(bundle.db, "2026-09", TODAY);
    const { rows, payday } = marksOn(september, "2026-09-24");
    expect(payday).toMatchObject({ state: "paid", settledByDepositsOn: ["2026-09-23"] });
    expect(rows.map((r) => r.settlesPaydaysOn)).toEqual([["2026-08-20"]]);
    const august = recurringCalendar(bundle.db, "2026-08", TODAY);
    expect(marksOn(august, "2026-08-20").payday?.settledByDepositsOn).toEqual(["2026-09-24"]);
  });

  /*
   * Whose MONEY paid it, which is what /budgets names. The lump's walk retired
   * Aug 27, but the lump's own $4,567.68 went to Sep 3–24 and the money that
   * reached Aug 27 was June's — so naming the lump would claim five weeks out
   * of a four-week deposit.
   */
  test("Aug 27 is drawn paid by the June deposits whose money paid it, as /budgets names them", () => {
    const august = recurringCalendar(bundle.db, "2026-08", TODAY);
    const aug27 = marksOn(august, "2026-08-27").payday;
    expect(aug27?.settledByDepositsOn).toEqual(["2026-06-04", "2026-06-05"]);
    const budgets = incomeExpectation(bundle.db, "2026-08-01", "2026-08-31", TODAY);
    const named = new Set(budgets.paidByAnotherMonthDeposits);
    for (const d of aug27?.settledByDepositsOn ?? []) expect(named.has(d)).toBe(true);
    const june = recurringCalendar(bundle.db, "2026-06", TODAY);
    expect(marksOn(june, "2026-06-04").rows.map((r) => r.settlesPaydaysOn)).toEqual([["2026-08-27"]]);
    expect(marksOn(june, "2026-06-05").rows.map((r) => r.settlesPaydaysOn)).toEqual([["2026-08-27"]]);
  });

  test("the months' Settled figures add up to the money he was paid, each cent once", () => {
    const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    const settled = months.map((m) => recurringCalendar(bundle.db, m, TODAY).postedNetCents);
    // June keeps only the $305.08 no payday reached; August holds Aug 20 and Aug 27; September its four weeks
    expect(settled).toEqual([30_508, 0, WEEK * 2, WEEK * 4, 0]);
    expect(settled.reduce((a, b) => a + b, 0)).toBe(104_700 + 40_000 + WEEK * 4 + WEEK);
    for (const m of ["2026-06", "2026-08", "2026-09"]) {
      expect(recurringCalendar(bundle.db, m, TODAY).postedNetCents).toBe(budgetsSettled(m, TODAY));
    }
  });
});

/*
 * 🔴 THE CHIP STATED THE PAYDAY'S WORTH, NOT THE MONEY. A deposit of $1,100.00
 * on Wed Sep 30 settles Thu Oct 1 under the anchor clause; /budgets says
 * "$1,100.00 … paid early, by the deposit of Wed, Sep 30" and October's chip
 * said $1,141.92 — and counted $1,141.92 into October's Settled figure.
 */
test("a short deposit across the month line is drawn, and counted, at the money it carried", () => {
  addPaySeries("2026-06-04");
  readThrough("2026-06-01", "2026-10-02");
  deposit("2026-09-30", 110_000);
  const october = recurringCalendar(bundle.db, "2026-10", "2026-10-02");
  expect(marksOn(october, "2026-10-01").payday).toMatchObject({
    state: "paid",
    amountCents: 110_000,
    expectedAmountCents: WEEK,
    settledByDepositsOn: ["2026-09-30"],
  });
  expect(october.postedNetCents).toBe(110_000);
  expect(october.postedNetCents).toBe(budgetsSettled("2026-10", "2026-10-02"));
});

/*
 * The merged drawing — a payday with no mark of its own, its deposit's row
 * standing for it — is the claim "the deposit beside this payday paid it", so
 * it is made only when settlement's whole answer is one day's deposit, drawn
 * here, within tolerance, with nothing else of the series as near.
 */
describe("payerStandsForPayday — when a payday is drawn as the row that paid it", () => {
  const THU = "2026-10-01";

  test("its own deposit, on the day or within tolerance, alone on the grid", () => {
    expect(payerStandsForPayday([THU], THU, [THU], 3)).toBe(true);
    expect(payerStandsForPayday(["2026-09-30"], THU, ["2026-09-30"], 3)).toBe(true);
    expect(payerStandsForPayday(["2026-09-28"], THU, ["2026-09-28"], 3)).toBe(true);
  });

  test("never past the tolerance, never for a deposit this grid does not draw, never for money from two days", () => {
    expect(payerStandsForPayday(["2026-09-27"], THU, ["2026-09-27"], 3)).toBe(false);
    expect(payerStandsForPayday(["2026-09-30"], THU, [THU], 3)).toBe(false);
    expect(payerStandsForPayday(["2026-09-30", THU], THU, ["2026-09-30", THU], 3)).toBe(false);
  });

  test("not when another of the series' rows sits as near or nearer, which a reader would take for its pay", () => {
    expect(payerStandsForPayday(["2026-09-30"], THU, ["2026-09-30", THU], 3)).toBe(false);
    expect(payerStandsForPayday(["2026-09-30"], THU, ["2026-09-30", "2026-10-02"], 3)).toBe(false);
    expect(payerStandsForPayday([THU], THU, [THU, "2026-10-03"], 3)).toBe(true);
  });
});

/*
 * ⛔ NEAR IS NOT PAID. With four days of tolerance a Monday deposit reaches the
 * Thursday either side of it; settlement spends one week's money on the newer
 * one and leaves the older unpaid — one week's pay settling two weeks is the
 * double-settle his decision exists to prevent. The row lying within tolerance
 * of Sep 24 must not draw Sep 24 as paid.
 */
test("a deposit near a payday it did not pay does not stand for it", () => {
  addPaySeries("2026-06-04");
  bundle.db.update(recurringSeries).set({ toleranceDays: 4 }).where(eq(recurringSeries.id, PAY)).run();
  readThrough("2026-06-01", "2026-10-02");
  deposit("2026-09-28", WEEK);
  const september = recurringCalendar(bundle.db, "2026-09", "2026-10-02");
  expect(marksOn(september, "2026-09-24").payday).toMatchObject({ state: "unsettled", settledCents: null });
  expect(marksOn(september, "2026-09-28").rows.map((r) => r.settlesPaydaysOn)).toEqual([["2026-10-01"]]);
  const october = recurringCalendar(bundle.db, "2026-10", "2026-10-02");
  expect(marksOn(october, "2026-10-01").payday).toMatchObject({ state: "paid", settledByDepositsOn: ["2026-09-28"] });
});

/* The ordinary week must not change: a deposit on its own payday is that payday, drawn once. */
test("a weekly deposit on its own payday still stands for it — one mark, no chip", () => {
  addPaySeries("2026-06-04");
  readThrough("2026-06-01", "2026-09-30");
  deposit("2026-09-24", WEEK);
  const september = recurringCalendar(bundle.db, "2026-09", "2026-09-28");
  const { rows, payday } = marksOn(september, "2026-09-24");
  expect(payday).toBeUndefined();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "paid", settledByDepositsOn: [], settlesPaydaysOn: [] });
});
