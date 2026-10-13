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
import { cashEarningsReadings } from "./cash-earnings";
import { incomeCard } from "./income-card";
import { paydaySettlement, settledPaydaysForSeries } from "./payday-settlement";
import { recurringCalendar } from "./recurring-calendar";

/**
 * ⚖️ HIS DECISION 75 (2026-10-13, an either/or, the recommended side): a day whose PAY-LINKED rows net to $0.00 — a
 * deposit and its same-day return — BANKED NOTHING. It pays no payday: the calendar keeps that payday unbanked, and
 * Earned vs banked counts nothing for it — the posted average's rule (`nettedToNothing`, "a day whose rows net to
 * $0.00 paid nothing"), now every reader's.
 *
 * 🔴 Settlement read money IN only ("a clawback or a returned payment is not a payday"), so a payroll returned the
 * same day still paid its payday: the calendar drew Sep 17 paid by the deposit beside its return, /recurring and the
 * pay page named no passed payday, and the income card counted the day as the last pay to arrive — while the posted
 * average on the same page said that day paid nothing. Latent: no money out is linked to his pay (a copy of his
 * ledger, 2026-10-13).
 *
 * The fixture is his series' shape — weekly Thursdays at $1,141.92 into Wells Fargo — from a first payday of Sep 3,
 * read on Monday Sep 21 with Wells Fargo checked through Sep 20.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-21";
const WELLS = "acct-wells";
const PAY = "series-it-america";
const WEEK = 114_192;
const now = (): string => new Date().toISOString();

function salaryId(): string {
  const income = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Income"), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Salary"), eq(categories.parentId, income.id)))
    .get()!.id;
}

let seq = 0;
/** A row linked to his pay — a deposit, or (negative) the money of one going back out. */
function payRow(postedOn: string, amountCents: number): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: WELLS,
      postedOn,
      amountCents,
      rawDescription: amountCents > 0 ? "It America LLC Payroll" : "Return It America LLC Payroll",
      normalizedDescription: amountCents > 0 ? "IT AMERICA LLC PAYROLL" : "RETURN IT AMERICA LLC PAYROLL",
      categoryId: salaryId(),
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-returned-pay-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  seq = 0;
  bundle.db
    .insert(accounts)
    .values({
      id: WELLS,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "WELLS FARGO",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
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
      nextExpectedOn: "2026-09-03",
      nextExpectedAmountCents: WEEK,
      lastMatchedOn: "2026-09-03",
      toleranceDays: 3,
      accountId: WELLS,
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  readThrough("2026-09-01", "2026-09-20");
  payRow("2026-09-03", WEEK);
  payRow("2026-09-10", WEEK);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const settled = (today = TODAY): string[] => [...settledPaydaysForSeries(bundle.db, PAY, today).keys()].sort();
const entriesOn = (day: string, today = TODAY) =>
  (recurringCalendar(bundle.db, "2026-09", today).entriesByDay[day] ?? []).filter((e) => e.seriesId === PAY);
const payLine = (today = TODAY) => incomeCard(bundle.db, today)!.pay.find((l) => l.seriesId === PAY)!;

describe("⚖️ decision 75 — a payroll returned the same day banked nothing", () => {
  /** Sep 17's payroll, and the same $1,141.92 back out the same day. */
  beforeEach(() => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -WEEK);
  });

  test("settlement pays no payday with it: Sep 17 stays unpaid, and no money is left over from it", () => {
    expect(settled()).toEqual(["2026-09-03", "2026-09-10"]);
    const s = paydaySettlement(bundle.db, PAY, TODAY);
    expect(s.portions.filter((p) => p.depositOn === "2026-09-17")).toEqual([]);
    expect(s.unallocatedCents).toBe(0);
  });

  test("the calendar keeps Sep 17 unbanked — not banked yet, on a day Wells Fargo is read through", () => {
    const payday = entriesOn("2026-09-17").filter((e) => e.transactionId === null);
    expect(payday.map((e) => [e.state, e.unsettledReason, e.amountCents])).toEqual([["unsettled", "unbanked", WEEK]]);
    // the deposit is drawn where it landed, paying no payday: it answers no week, so no week grades it
    const deposit = entriesOn("2026-09-17").find((e) => e.transactionId !== null && e.amountCents === WEEK)!;
    expect([deposit.towardNoPayday, deposit.expectedAmountCents]).toEqual([true, null]);
    // …and the month's Settled figure holds nothing for the day: the deposit and its return net to $0.00
    const day = entriesOn("2026-09-17").reduce((sum, e) => sum + (e.settledCents ?? 0), 0);
    expect(day).toBe(0);
  });

  test("the pay page and /recurring name Sep 17 as a passed payday with no deposit", () => {
    const unbanked = unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-09-01", TODAY);
    expect(unbanked.series[0]?.occurrenceDates).toEqual(["2026-09-17"]);
    expect(unbanked.totalCents).toBe(WEEK);
  });

  test("Earned vs banked counts nothing for it: banked two weeks, and the silence runs from Sep 10", () => {
    const line = payLine();
    expect([line.paydays, line.impliedCents, line.bankedCents, line.gapCents]).toEqual([3, WEEK * 3, WEEK * 2, WEEK]);
    expect(line.gapLabel).toBe("never reached a bank");
    expect([line.lastBankedOn, line.silentPeriods, line.checkedSilentPeriods]).toEqual(["2026-09-10", 1, 1]);
  });

  test("/spending's note reads the same silence: one payday read since the last pay that banked", () => {
    const reading = cashEarningsReadings(bundle.db, { from: "2026-09-01", to: TODAY, today: TODAY, withChecked: true })
      .find((r) => r.seriesId === PAY)!;
    expect([reading.lastBankedOn, reading.periodsSinceBanked, reading.checkedPeriodsSinceBanked]).toEqual([
      "2026-09-10",
      1,
      1,
    ]);
  });

  /*
   * ⛔ ON THE PAYDAY ITSELF it is still to come: a payday dated today is earned only once a deposit for it lands
   * (`cashEarnings`' `paidToday`), and a deposit returned the same day landed nothing. 🔴 Any row dated today counted:
   * the card earned Sep 17 while the calendar drew it upcoming.
   */
  test("read on Sep 17 itself, the payday is still upcoming on the calendar and not yet earned on the card", () => {
    expect(entriesOn("2026-09-17", "2026-09-17").filter((e) => e.transactionId === null).map((e) => e.state)).toEqual([
      "upcoming",
    ]);
    const line = payLine("2026-09-17");
    expect([line.paydays, line.impliedCents, line.bankedCents]).toEqual([2, WEEK * 2, WEEK * 2]);
  });
});

/*
 * ⚖️ …AND ITS PAYDAY IS KEPT, unbanked: where a job's paydays begin is pay SENT (`firstPaydayOn`), and a first payroll
 * returned the same day says the job was paying then. Here detection anchored the schedule on Sep 17, after both
 * deposits, so only the first one can open Sep 3. Read as a day that banked nothing it would open nothing, and Sep 3
 * would leave the calendar and the card rather than stand unbanked on both.
 */
describe("a FIRST payroll returned the same day still opens the job's paydays", () => {
  beforeEach(() => {
    bundle.db.delete(transactions).run();
    bundle.db.update(recurringSeries).set({ nextExpectedOn: "2026-09-17" }).where(eq(recurringSeries.id, PAY)).run();
    payRow("2026-09-03", WEEK);
    payRow("2026-09-03", -WEEK);
    payRow("2026-09-10", WEEK);
  });

  test("Sep 3 is a payday, kept unbanked on the calendar and earned with nothing banked on the card", () => {
    expect(paydaySettlement(bundle.db, PAY, TODAY).firstPaydayOn).toBe("2026-09-03");
    expect(settled()).toEqual(["2026-09-10"]);
    expect(entriesOn("2026-09-03").filter((e) => e.transactionId === null).map((e) => e.state)).toEqual(["unsettled"]);
    const line = payLine();
    expect([line.paydaysLabel, line.bankedCents, line.lastBankedOn]).toEqual([
      "3 paydays, Sep 3 – Sep 17",
      WEEK,
      "2026-09-10",
    ]);
  });
});

/*
 * ⛔ …but the walk back reaches only as far as money that BANKED (`walkBackBound`): a payroll landing the Wednesday
 * before its Thursday and returned that day reached no payday. Here detection dated the next payday Sep 24, past it.
 * 🔴 Read as pay that reached Thursday, the walk back drew Sep 17 on Sep 17 itself — a payday no deposit paid, which
 * /budgets then scheduled in no leg: not paid, not still expected (the forward leg opens on Sep 24), not yet passed.
 * A payday the walk back draws is one a deposit settles (`walkBackBound`), and a day that banked nothing settles none.
 */
describe("a payroll returned the day before its payday reaches no payday", () => {
  beforeEach(() => {
    bundle.db.update(recurringSeries).set({ nextExpectedOn: "2026-09-24" }).where(eq(recurringSeries.id, PAY)).run();
    payRow("2026-09-16", WEEK);
    payRow("2026-09-16", -WEEK);
  });

  test("read on the Thursday, /budgets schedules only paydays a leg names: Sep 3 and 10 paid, Sep 24 to come", () => {
    const thursday = "2026-09-17";
    expect(paydaySettlement(bundle.db, PAY, thursday).walkBackBefore).toBe(thursday);
    expect(settled(thursday)).toEqual(["2026-09-03", "2026-09-10"]);
    const sep = incomeExpectation(bundle.db, "2026-09-01", "2026-09-30", thursday);
    expect([sep.scheduledOccurrences, sep.expectedCents, sep.passedUnpaidOccurrences]).toEqual([3, WEEK, 0]);
  });

  test("the day after, Sep 17 has passed and is drawn unpaid, as every past reader draws it", () => {
    expect(entriesOn("2026-09-17", "2026-09-18").filter((e) => e.transactionId === null).map((e) => e.state)).toEqual([
      "unsettled",
    ]);
    expect(unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-09-01", "2026-09-18").totalCents).toBe(WEEK);
  });
});

/*
 * A RETURN ON A LATER DAY is not a same-day return: the payroll's own day banked its $1,141.92 and paid Sep 17, as it
 * always has. The return's day nets below $0.00 — money out alone — and banks nothing: it pays no payday and is no
 * pay arriving, so the card's last banked day is the payroll's, not the return's. Earned vs banked's banked figure is
 * what reached a bank, net, and still takes the return off (unchanged).
 */
describe("a payroll returned on a LATER day is not a same-day return", () => {
  beforeEach(() => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-18", -WEEK);
  });

  test("its own day still pays Sep 17, drawn by its row", () => {
    expect(settled()).toEqual(["2026-09-03", "2026-09-10", "2026-09-17"]);
    expect(entriesOn("2026-09-17").filter((e) => e.transactionId === null)).toEqual([]);
    expect(unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-09-01", TODAY).totalCents).toBe(0);
  });

  test("the banked figure nets the return, as it always has; the last pay that banked is Sep 17's", () => {
    const line = payLine();
    expect([line.paydays, line.bankedCents]).toEqual([3, WEEK * 2]);
    // 🔴 it was Sep 18, the return's own day: money going out was read as pay arriving
    expect([line.lastBankedOn, line.silentPeriods]).toEqual(["2026-09-17", 0]);
  });
});

/*
 * ⚖️ A PARTIAL SAME-DAY RETURN: the day banked its net. $1,141.92 in and $500.00 back out on Sep 17 is $641.92 that
 * reached a bank — the day is one deposit of $641.92 to settlement, so Sep 17 is answered short (the anchor clause: a
 * deposit answers the payday it landed on whatever it paid, and what it paid is the money there was).
 */
describe("a partial return the same day: the day banked its net", () => {
  beforeEach(() => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -50_000);
  });

  test("Sep 17 is paid by the day's $641.92, the money there was", () => {
    expect(settled()).toEqual(["2026-09-03", "2026-09-10", "2026-09-17"]);
    const s = paydaySettlement(bundle.db, PAY, TODAY);
    expect(s.portions.filter((p) => p.paydayOn === "2026-09-17")).toEqual([
      { paydayOn: "2026-09-17", depositOn: "2026-09-17", cents: WEEK - 50_000 },
    ]);
  });

  test("Earned vs banked counts the $641.92, and Sep 17 is the last pay that banked", () => {
    const line = payLine();
    expect([line.bankedCents, line.gapCents, line.lastBankedOn, line.silentPeriods]).toEqual([
      WEEK * 3 - 50_000,
      50_000,
      "2026-09-17",
      0,
    ]);
  });
});
