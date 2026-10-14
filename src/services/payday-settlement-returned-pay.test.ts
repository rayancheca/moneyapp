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
import { noticesCard } from "./notices-card";
import { paydaySettlement, settledPaydaysForSeries } from "./payday-settlement";
import { postedAveragesBySeries } from "./posted-average";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

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

function categoryId(name: string, parent: string): string {
  const top = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parent), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, top.id)))
    .get()!.id;
}
const salaryId = (): string => categoryId("Salary", "Income");

let seq = 0;
/** A row linked to his pay — a deposit, or (negative) the money of one going back out — filed where it is filed. */
function payRow(postedOn: string, amountCents: number, filedAs: string | null = salaryId()): void {
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
      categoryId: filedAs,
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
const entriesOn = (day: string, today = TODAY, month = "2026-09") =>
  (recurringCalendar(bundle.db, month, today).entriesByDay[day] ?? []).filter((e) => e.seriesId === PAY);
const payLine = (today = TODAY) => incomeCard(bundle.db, today)!.pay.find((l) => l.seriesId === PAY)!;

/** /budgets' legs for a month — and the identity they keep: posted − paid for another + expected + passed + paid by */
function legsOf(month: string, today: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const e = incomeExpectation(bundle.db, `${month}-01`, end, today);
  const legs = e.postedCents - e.paidForAnotherMonthCents + e.expectedCents + e.passedUnpaidCents;
  return {
    posted: e.postedCents,
    expected: e.expectedCents,
    passed: e.passedUnpaidCents,
    paidBy: e.paidByAnotherMonthCents,
    paidFor: e.paidForAnotherMonthCents,
    scheduled: e.scheduledCents,
    legs: legs + e.paidByAnotherMonthCents,
  };
}

/** The posted average's per-payday samples, as the series page, the All tab and the popover read them. */
function samplesOf(today: string) {
  const s = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, PAY)).get()!;
  const posted = postedAveragesBySeries(bundle.db, [s], today).get(PAY)!;
  return {
    avg: posted.avgCents,
    samples: posted.perPayday!.samples.map((x) => [x.postedOn, x.cents, x.paydays, x.dayCents]),
  };
}

/**
 * What every reader makes of a deposit DAY — the figures, never the rows: settlement's portions, the calendar's
 * grading of the day's deposit (what it is held to the week as, per payday) and its paydays, the month's Settled for
 * the day, the posted average's samples, /budgets' legs for the month and Earned vs banked's line.
 */
function readingOfDay(day: string, today: string) {
  const month = day.slice(0, 7);
  const s = paydaySettlement(bundle.db, PAY, today);
  const entries = entriesOn(day, today, month);
  const deposit = entries.find((e) => e.transactionId !== null && e.amountCents > 0) ?? null;
  const line = payLine(today);
  return {
    portions: s.portions,
    unallocated: s.unallocatedCents,
    deposit:
      deposit === null
        ? null
        : {
            state: deposit.state,
            heldAs: deposit.perPayday?.cents ?? deposit.amountCents,
            paydays: deposit.perPayday?.paydays ?? 1,
            expected: deposit.expectedAmountCents,
            towardNoPayday: deposit.towardNoPayday,
          },
    paydays: entries.filter((e) => e.transactionId === null).map((e) => [e.state, e.unsettledReason]),
    settledThatDay: entries.reduce((sum, e) => sum + (e.settledCents ?? 0), 0),
    average: samplesOf(today),
    budgets: legsOf(month, today),
    card: [line.paydays, line.impliedCents, line.bankedCents, line.lastBankedOn],
    postedThisMonth: incomeCard(bundle.db, today)!.postedThisMonthCents,
  };
}

/** Replaces a day's pay rows with others — the same day read again, as if the bank had posted these instead. */
function rePost(day: string, amounts: readonly number[]): void {
  bundle.db.delete(transactions).where(eq(transactions.postedOn, day)).run();
  for (const cents of amounts) payRow(day, cents);
}

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

/*
 * ⚖️ "BANKED NOTHING" IS EVERY LEG'S ANSWER, /budgets' "in so far" too. Settlement reads the day by its net, so Sep 17
 * is a passed payday with no deposit — and the money that came back is in no figure of what came in.
 * 🔴 "In so far" summed money IN row by row (`isIncome`), so the returned $1,141.92 stayed in it while the third leg
 * named its payday unpaid: September read $3,425.76 in so far + $1,141.92 still expected + $1,141.92 passed against
 * four paydays at $4,567.68 — the week counted twice — and the dashboard's "Income recorded in Sep 2026" said
 * $3,425.76 beside Earned vs banked's two weeks (review of b0219f5; hypothetical: no money out is linked to his pay).
 */
describe("/budgets: a payroll returned the same day is in no leg twice", () => {
  test("September's legs add up to its four paydays — in so far holds Sep 3 and Sep 10, Sep 17 has passed", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -WEEK);
    const sep = legsOf("2026-09", TODAY);
    expect([sep.posted, sep.passed, sep.expected, sep.scheduled]).toEqual([WEEK * 2, WEEK, WEEK, WEEK * 4]);
    expect(sep.legs).toBe(sep.scheduled);
    // the dashboard's "Income recorded in Sep 2026" is that figure, beside Earned vs banked's two weeks
    expect(incomeCard(bundle.db, TODAY)!.postedThisMonthCents).toBe(WEEK * 2);
    expect(payLine().bankedCents).toBe(WEEK * 2);
  });

  test("…and every reader reads that day as a day nothing landed on", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -WEEK);
    const returned = readingOfDay("2026-09-17", TODAY);
    rePost("2026-09-17", []);
    expect({ ...returned, deposit: null }).toEqual(readingOfDay("2026-09-17", TODAY));
  });
});

/*
 * ⚖️ A PARTIAL RETURN THE SAME DAY: the day banked its net, and every reader reads it as ONE deposit of that net —
 * settlement, the calendar's grading of the deposit (held to the week as $641.92, never as the $1,141.92 that came
 * back in part), the posted average's sample, /budgets' legs, Earned vs banked. 🔴 Only settlement read the net: the
 * calendar held Sep 17's deposit to the week as $1,141.92 and the posted average sampled it at $1,141.92, and "in so
 * far" counted the whole $1,141.92 (review of b0219f5).
 */
describe("a partial return the same day reads, everywhere, as one deposit of the day's net", () => {
  test("$1,141.92 in and $500.00 back on Sep 17 is $641.92 that landed", () => {
    rePost("2026-09-17", [WEEK, -50_000]);
    const partly = readingOfDay("2026-09-17", TODAY);
    expect(partly.deposit).toMatchObject({ heldAs: WEEK - 50_000, paydays: 1, expected: WEEK });
    expect(partly.average.samples.map((s) => s[1])).toEqual([WEEK, WEEK, WEEK - 50_000]);
    expect(partly.budgets.posted).toBe(WEEK * 3 - 50_000);
    rePost("2026-09-17", [WEEK - 50_000]);
    expect(partly).toEqual(readingOfDay("2026-09-17", TODAY));
  });

  /*
   * 🔴 Across the month line, "in so far" kept the $500.00 that came back: Wed Sep 30's $641.92 paid Thu Oct 1, so
   * September named $641.92 paid for another month out of an "in so far" holding $1,141.92 for it — four paydays
   * at $4,567.68 against legs of $5,067.68 (review of b0219f5).
   */
  test("Wed Sep 30's $1,141.92 and $500.00 back pay Thu Oct 1 its $641.92 — September's legs still add up", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-24", WEEK);
    rePost("2026-09-30", [WEEK, -50_000]);
    const read = "2026-10-05";
    const sep = legsOf("2026-09", read);
    expect([sep.posted, sep.paidFor, sep.scheduled]).toEqual([WEEK * 5 - 50_000, WEEK - 50_000, WEEK * 4]);
    expect(sep.legs).toBe(sep.scheduled);
    const partly = { sep, oct: legsOf("2026-10", read), day: readingOfDay("2026-09-30", read) };
    rePost("2026-09-30", [WEEK - 50_000]);
    expect(partly).toEqual({
      sep: legsOf("2026-09", read),
      oct: legsOf("2026-10", read),
      day: readingOfDay("2026-09-30", read),
    });
  });

  /*
   * 🔴 A lump with a same-day return was divided GROSS by the paydays its NET paid: $4,567.68 in and $500.00 back on
   * Sep 23 paid Sep 24, 17 and 10 — $641.92 over — and the posted average read $4,567.68 ÷ 3 = $1,522.56 a payday,
   * where a lump of the $4,067.68 that landed reads $1,355.89 (review of b0219f5).
   */
  test("a four-week lump with $500.00 back the same day reads as a lump of $4,067.68", () => {
    bundle.db.delete(transactions).run();
    const read = "2026-09-28";
    rePost("2026-09-23", [WEEK * 4, -50_000]);
    const partly = readingOfDay("2026-09-23", read);
    expect(partly.portions.map((p) => p.paydayOn)).toEqual(["2026-09-24", "2026-09-17", "2026-09-10"]);
    const perPayday = Math.round((WEEK * 4 - 50_000) / 3);
    expect(partly.average.samples).toEqual([["2026-09-23", perPayday, 3, WEEK * 4 - 50_000]]);
    expect(partly.deposit).toMatchObject({ heldAs: perPayday, paydays: 3 });
    rePost("2026-09-23", [WEEK * 4 - 50_000]);
    expect(partly).toEqual(readingOfDay("2026-09-23", read));
  });
});

/*
 * ⚖️ MONEY OUT IS NO PAYDAY'S PAY, so no week grades it (decision 75, every reader): back the same day it is netted
 * into its day's figure, and the DEPOSIT is held to the week at that net; on a day of its own it banked nothing and
 * paid no payday. Either way it answers no week — as money toward no payday answers none — so the calendar draws it
 * ungraded and the series page holds it to nothing (`PaydayReading.expectedCents`).
 * 🔴 Every surface that grades a row (`expectedCentsOf`) held money out to the week's $1,141.92: the $500.00 back on
 * Sep 17 read amber and, stored first, put "It America LLC (weekly pay) fell by $641.92 between its usual amount and
 * Sep 17." on the dashboard — for a day $500.00 short — beside "vs expected -$641.92" on the series page; a $50.00
 * clawback on a day of its own "fell by $1,091.92"; and a payroll returned whole read green only while the measured
 * spread was empty, amber under a cached one (review of bbf17cb, hypothetical: no money out is linked to his pay).
 */
/** How the calendar draws a row of his pay on a day — its state, and what it is held to */
const graded = (day: string, cents: number) => {
  const row = entriesOn(day).find((e) => e.transactionId !== null && e.amountCents === cents)!;
  return [row.state, row.expectedAmountCents];
};
/** …and what the series page's Amount history holds it to */
const heldTo = (day: string, cents: number) =>
  seriesDetail(bundle.db, PAY, TODAY).amountHistory.find((p) => p.date === day && p.amountCents === cents)!
    .expectedCents;
const payNotices = () =>
  (noticesCard(bundle.db, TODAY)?.notices ?? []).map((n) => n.text).filter((t) => t.includes("It America LLC"));

describe("money out linked to his pay is held to no week", () => {
  test("$500.00 back the same day: the return is ungraded, and the one notice is the day's — $500.00 short", () => {
    rePost("2026-09-17", [-50_000, WEEK]);
    expect(graded("2026-09-17", -50_000)).toEqual(["paid", null]);
    expect(heldTo("2026-09-17", -50_000)).toBeNull();
    // the deposit is held to the week at the day's net, as it was
    expect(graded("2026-09-17", WEEK)).toEqual(["paid_different", WEEK]);
    expect(payNotices()).toEqual(["It America LLC (weekly pay) fell by $500.00 between its usual amount and Sep 17."]);
  });

  test("a payroll returned whole the same day: the return is ungraded, under a cached spread too", () => {
    bundle.db.update(recurringSeries).set({ amountCentsStddev: 5_000 }).where(eq(recurringSeries.id, PAY)).run();
    rePost("2026-09-17", [WEEK, -WEEK]);
    expect(graded("2026-09-17", -WEEK)).toEqual(["paid", null]);
    expect(heldTo("2026-09-17", -WEEK)).toBeNull();
  });

  test("a $50.00 clawback on a day of its own: ungraded, and nothing says his pay fell", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-18", -5_000);
    expect(graded("2026-09-18", -5_000)).toEqual(["paid", null]);
    expect(heldTo("2026-09-18", -5_000)).toBeNull();
    expect(payNotices()).toEqual([]);
  });
});

/*
 * ⚖️ ONE DEFINITION OF A PAY DAY'S ROWS (`isPayDayRow`), for settlement and every reader that draws or counts what it
 * paid — the calendar's grading of the deposit, the posted average, Earned vs banked, /budgets' legs: a row linked to
 * his pay that is his SPENDING — an unfiled debit, or one filed under a spending category — is no row of its day.
 * ⚖️ Orchestrator's default (2026-10-14, his call open): it is his Uncategorized spending until he files it, so the day
 * banked its payroll — and filed under Income or as a transfer it nets (decision 75, the tests above).
 * 🔴 Settlement and every reader beside it read EVERY linked row: an unfiled $1,141.92 back beside Sep 17's payroll
 * left Sep 17 unbanked on the calendar and the card while "in so far" counted the payroll (review of f1903f6;
 * hypothetical: no money out is linked to his pay).
 */
describe("money linked to his pay that is his spending is no row of its pay day", () => {
  const bankFeesId = (): string => categoryId("Bank Fees", "Fees");
  /** what the posted average and the popover's words make of his pay's rows (`perPaydayEvidence`) */
  const evidenceOf = (today = TODAY) => {
    const s = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, PAY)).get()!;
    return postedAveragesBySeries(bundle.db, [s], today).get(PAY)!.perPayday!;
  };

  test.each([
    ["unfiled", (): string | null => null],
    ["filed under a spending category", bankFeesId],
  ])("%s, the week's pay back on Sep 17 leaves every reader reading the day's payroll", (_, filedAs) => {
    rePost("2026-09-17", [WEEK]);
    const deposit = () =>
      seriesDetail(bundle.db, PAY, TODAY).amountHistory.find((p) => p.date === "2026-09-17" && p.amountCents === WEEK);
    const payroll = { ...readingOfDay("2026-09-17", TODAY), history: deposit() };
    payRow("2026-09-17", -WEEK, filedAs());
    // the calendar's Settled is the flow of every mark it draws — the debit's too, which left
    expect({ ...readingOfDay("2026-09-17", TODAY), history: deposit() }).toEqual({ ...payroll, settledThatDay: 0 });
    // the debit is drawn as the money out it is, held to no week, and the popover names it as that
    expect(graded("2026-09-17", -WEEK)).toEqual(["paid", null]);
    expect(heldTo("2026-09-17", -WEEK)).toBeNull();
    const evidence = evidenceOf();
    expect([evidence.moneyOut, evidence.noPaydayOfTheirOwn, evidence.netted]).toEqual([1, 0, []]);
    expect(payNotices()).toEqual([]);
  });

  test("an unfiled $500.00 out on a lump's day leaves the lump whole — four weeks at $1,141.92", () => {
    bundle.db.delete(transactions).run();
    const read = "2026-09-28";
    rePost("2026-09-23", [WEEK * 4]);
    const lump = readingOfDay("2026-09-23", read);
    payRow("2026-09-23", -50_000, null);
    expect(readingOfDay("2026-09-23", read)).toEqual({ ...lump, settledThatDay: lump.settledThatDay - 50_000 });
    expect(evidenceOf(read).samples.map((s) => [s.dayCents, s.returns])).toEqual([[WEEK * 4, 0]]);
  });

  test("beside a payroll returned whole the same day, it is named as money out — the day as netting to $0.00", () => {
    rePost("2026-09-17", [WEEK, -WEEK]);
    const returned = readingOfDay("2026-09-17", TODAY);
    payRow("2026-09-17", -5_000, null);
    expect(readingOfDay("2026-09-17", TODAY)).toEqual({ ...returned, settledThatDay: -5_000 });
    const evidence = evidenceOf();
    expect([evidence.moneyOut, evidence.netted.map((o) => [o.postedOn, o.postings])]).toEqual([
      1,
      [["2026-09-17", 2]],
    ]);
  });

  test("a refund filed under a spending category, linked to his pay, pays no payday — it is no pay", () => {
    bundle.db.delete(transactions).where(eq(transactions.postedOn, "2026-09-10")).run();
    payRow("2026-09-10", WEEK, bankFeesId());
    expect(settled()).toEqual(["2026-09-03"]);
    expect(entriesOn("2026-09-10").find((e) => e.transactionId !== null)?.towardNoPayday).toBe(true);
    expect([payLine().bankedCents, payLine().lastBankedOn]).toEqual([WEEK, "2026-09-03"]);
  });
});

/*
 * ⛔ THE UNIT IS THE DAY (`daysThatBanked`): a day's deposits are the one deposit settlement walks, as the readings
 * always took them (`lib/per-payday`) — and so the money pools as his decision of 2026-09-28 says it must: how his
 * payer happens to split a transfer is not a fact about which weeks he was paid for. 🔴 Walked row by row, one week
 * sent as $500.00 and $641.92 the same day answered Sep 17 with the $500.00 alone — short by $641.92, with $641.92
 * left over — and which payday a day's money paid hung on the order its rows were stored in (at b995ce2).
 */
describe("two deposits on one day are one deposit", () => {
  test("one week sent as $500.00 and $641.92 the same day pays Sep 17 in full", () => {
    rePost("2026-09-17", [50_000, WEEK - 50_000]);
    const s = paydaySettlement(bundle.db, PAY, TODAY);
    expect(s.portions.filter((p) => p.paydayOn === "2026-09-17")).toEqual([
      { paydayOn: "2026-09-17", depositOn: "2026-09-17", cents: WEEK },
    ]);
    expect(s.unallocatedCents).toBe(0);
    expect([payLine().bankedCents, payLine().gapCents]).toEqual([WEEK * 3, 0]);
  });

  test("…and a day's money pays the same paydays whatever order its rows were stored in", () => {
    bundle.db.delete(transactions).where(eq(transactions.postedOn, "2026-09-10")).run();
    rePost("2026-09-17", [50_000, WEEK]);
    const smallFirst = readingOfDay("2026-09-17", TODAY);
    rePost("2026-09-17", [WEEK, 50_000]);
    expect(readingOfDay("2026-09-17", TODAY)).toEqual(smallFirst);
    // the day's $1,641.92 pays its own Thursday in full; the $500.00 over cannot pay Sep 10, which has passed unpaid
    expect([smallFirst.portions, smallFirst.unallocated]).toEqual([
      [
        { paydayOn: "2026-09-03", depositOn: "2026-09-03", cents: WEEK },
        { paydayOn: "2026-09-17", depositOn: "2026-09-17", cents: WEEK },
      ],
      50_000,
    ]);
    const unbanked = unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-09-01", TODAY);
    expect(unbanked.series[0]?.occurrenceDates).toEqual(["2026-09-10"]);
  });
});
