import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { arrearsThisMonth } from "./arrears";
import { budgetTail } from "./budgets";
import { committedBook } from "./committed";
import { dashboardData } from "./dashboard";
import { forecastCurrentMonth, forecastForMonth } from "./forecast";
import { listSeries, upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * 🔴 A BILL PAID EARLY WAS STILL LISTED AS COMING (review of 50020a2). The calendar draws an occurrence paid by its
 * own payment in another month — the rent paid Sep 30 for Oct 1 — "paid (paid by its payment of Sep 30, 2026)",
 * settling $0.00, and what is billed inside the rent "paid with the rent's payment of Sep 30" (§6A 59). Every reader
 * that looks ahead still projected that Oct 1: `stillToCome` said "Money out is never paid down". Measured on a linked
 * copy of his ledger (moneyapp-copy-2026-10-08.db) with the Sep 2 Wells Fargo rent row cloned to Sep 30, today Sep 30:
 * October's forecast card listed "Flamingo South Beach (rent) 1 × -$2,109.00 (monthly), next Oct 1" and "Rent
 * utilities & fees … next Oct 1" — committed net $2,134.63 under a grid whose Expected was $4,425.84, the gap exactly
 * $2,291.21 — /recurring's Upcoming tab and the dashboard strip listed both on Oct 1, the rent's page "Next expected
 * Oct 1 · Nov 1 · Dec 1" and the All tab's Next Oct 1, while the cash balance already held the Sep 30 payment.
 *
 * The fixture is his shape: the rent (confirmed, $2,109.00 on the 1st, his own next date Sep 1, 3 days' grace,
 * posted Jul 8, Aug 4, Sep 2), the utilities billed with it ($182.21 on the 1st, never posted), and a gym on the 22nd
 * nothing has paid — the control.
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
const TODAY = "2026-09-30";
const RENT = "rent";
const UTIL = "util";
const GYM = "gym";
const now = (): string => new Date().toISOString();

function pay(id: string, seriesId: string, postedOn: string, cents: number): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: "acct",
      postedOn,
      amountCents: cents,
      rawDescription: id,
      normalizedDescription: id.toUpperCase(),
      categoryId,
      recurringSeriesId: seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** a payment of the rent, linked to it — his Sep 2 $2,291.21 is the rent and what it carries */
const rentPaid = (postedOn: string): void => pay(`t-rent-${postedOn}`, RENT, postedOn, -229121);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-bill-paid-early-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: "acct",
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  categoryId = bundle.db.select().from(categories).all()[0]!.id;
  const bill = (id: string, name: string, cents: number, nextOn: string) => ({
    id,
    name,
    kind: "bill" as const,
    cadence: "monthly" as const,
    intervalDaysAvg: 30,
    amountCentsAvg: cents,
    toleranceDays: 3,
    nextExpectedOn: nextOn,
    nextExpectedAmountCents: cents,
    userAmountCents: cents,
    anchorDay: Number(nextOn.slice(8)),
    status: "confirmed" as const,
    userCategoryId: categoryId,
    createdAt: now(),
    updatedAt: now(),
  });
  bundle.db
    .insert(recurringSeries)
    .values([
      {
        ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-09-01"),
        userNextExpectedOn: "2026-09-01",
        accountId: "acct",
        lastMatchedOn: "2026-09-02",
      },
      { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-09-01"), userBilledWithSeriesId: RENT },
      bill(GYM, "Gym", -10000, "2026-10-22"),
    ])
    .run();
  pay("t-rent-jul", RENT, "2026-07-08", -228570);
  pay("t-rent-aug", RENT, "2026-08-04", -223711);
  rentPaid("2026-09-02");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const RENT_NAME = "Flamingo South Beach (rent)";
const UTIL_NAME = "Rent utilities & fees";
const ours = (list: readonly { seriesId: string; date: string }[]): string[][] =>
  list.filter((o) => o.seriesId === RENT || o.seriesId === UTIL).map((o) => [o.seriesId, o.date]);
const octoberBills = (today = TODAY): string[] =>
  forecastForMonth(bundle.db, "2026-10", today)!
    .components.filter((c) => c.label === RENT_NAME || c.label === UTIL_NAME)
    .map((c) => `${c.label} ${c.detail}`);

describe("the rent paid Sep 30 for Oct 1 — and what it carries — is not still to come", () => {
  beforeEach(() => rentPaid("2026-09-30"));

  test("the calendar draws both Oct 1s paid by the Sep 30 payment (what every reader below now agrees with)", () => {
    const oct1 = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay["2026-10-01"] ?? [];
    expect(oct1.map((e) => [e.seriesId, e.state, e.paidWith])).toEqual([
      [RENT, "paid", { carrier: null, postedOn: "2026-09-30" }],
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-30" }],
    ]);
  });

  test("October's forecast card projects neither — its committed net is the grid's Expected, one answer", () => {
    expect(octoberBills()).toEqual([]);
    const card = forecastForMonth(bundle.db, "2026-10", TODAY)!;
    const grid = recurringCalendar(bundle.db, "2026-10", TODAY);
    // the gym's Oct 22, nothing has paid it: the one bill both still count
    expect(grid.upcomingNetCents).toBe(-10000);
    expect(card.committed.netCents).toBe(grid.upcomingNetCents);
  });

  test("/recurring's Upcoming tab and the dashboard strip list neither — the rent's next is Nov 1", () => {
    expect(ours(upcomingOccurrences(bundle.db, TODAY, 30))).toEqual([]);
    expect(ours(dashboardData(bundle.db, TODAY).upcoming.items)).toEqual([]);
    expect(ours(upcomingOccurrences(bundle.db, TODAY, 60))).toEqual([
      [RENT, "2026-11-01"],
      [UTIL, "2026-11-01"],
    ]);
  });

  test("each page's Next expected and the All tab's Next name Nov 1 — the End dialog's next charge too", () => {
    for (const id of [RENT, UTIL]) {
      expect(seriesDetail(bundle.db, id, TODAY).nextExpected.map((o) => o.date)).toEqual([
        "2026-11-01",
        "2026-12-01",
        "2027-01-01",
      ]);
      expect(listSeries(bundle.db, TODAY).find((s) => s.id === id)?.nextExpectedOn).toBe("2026-11-01");
    }
  });

  /*
   * ⛔ The series SENTENCE is the schedule: its editor opens on this date and saves it back as the anchor
   * (`seriesDetail.nextExpectedOn`, payday-paid-early.test's block on the sentence). A day paid early is still on the
   * schedule — saved past it, Oct 1 would leave the walk the Sep 30 payment paid. "monthly around the 1st" either way.
   */
  test("the sentence's day stays the schedule's Oct 1 — the date its editor writes as the anchor", () => {
    expect(seriesDetail(bundle.db, RENT, TODAY).nextExpectedOn).toBe("2026-10-01");
  });

  /*
   * ⛔ A RATE is not a list of what is still to pay (`committedBook`): twelve months hold twelve rents whatever day it
   * is asked on — "a posted bill still belongs in it". Dropping the paid Oct 1 would publish $1,933.25 a month for a
   * $2,109.00 bill, the sawtooth its docstring measured and refused.
   */
  test("the runway's committed book is still twelve rents at $2,109.00 a month — a rate, paid or not", () => {
    const rent = committedBook(bundle.db, TODAY).lines.find((l) => l.seriesId === RENT)!;
    expect([rent.occurrences, rent.totalCents]).toEqual([12, 12 * 210900]);
  });

  test("the gym nothing has paid is still coming on every reader — the control", () => {
    expect(upcomingOccurrences(bundle.db, TODAY, 30).filter((o) => o.seriesId === GYM).map((o) => o.date)).toEqual([
      "2026-10-22",
    ]);
    expect(seriesDetail(bundle.db, GYM, TODAY).nextExpected[0]?.date).toBe("2026-10-22");
  });
});

describe("the boundary is the rent's own grace — the arrears' and the calendar's test (`paymentFor`)", () => {
  test("paid Sep 28, three days early: Oct 1 is paid, and listed nowhere ahead", () => {
    rentPaid("2026-09-28");
    expect(octoberBills()).toEqual([]);
    expect(ours(upcomingOccurrences(bundle.db, TODAY, 30))).toEqual([]);
  });

  test("paid Sep 27, four days early: Oct 1 is still coming — and the calendar says so too", () => {
    rentPaid("2026-09-27");
    expect(octoberBills()).toEqual([
      `${RENT_NAME} 1 × -$2,109.00 (monthly), next Oct 1`,
      `${UTIL_NAME} 1 × -$182.21 (monthly), next Oct 1`,
    ]);
    expect(ours(upcomingOccurrences(bundle.db, TODAY, 30))).toEqual([
      [RENT, "2026-10-01"],
      [UTIL, "2026-10-01"],
    ]);
    const oct1 = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay["2026-10-01"] ?? [];
    expect(oct1.map((e) => [e.seriesId, e.state])).toEqual([
      [RENT, "upcoming"],
      [UTIL, "upcoming"],
    ]);
  });

  test("unlinked, the rent's payment pays the rent alone: the utilities' Oct 1 is still coming", () => {
    rentPaid("2026-09-30");
    bundle.db.update(recurringSeries).set({ userBilledWithSeriesId: null }).where(eq(recurringSeries.id, UTIL)).run();
    expect(ours(upcomingOccurrences(bundle.db, TODAY, 30))).toEqual([[UTIL, "2026-10-01"]]);
    expect(octoberBills()).toEqual([`${UTIL_NAME} 1 × -$182.21 (monthly), next Oct 1`]);
  });
});

/*
 * 🔴 ONE OCCURRENCE DRAWN TWICE (review of the 2026-10-08 batch, §6A 59). The rent paid in two halves either side of
 * the month's edge — Sep 30 and Oct 2, each a day from its Oct 1 — and October drew its Oct 1 twice: a $2,109.00
 * "paid (paid by its payment of Sep 30, 2026)" mark, and beside it the Oct 2 row. The arrears' test names the nearer,
 * the earlier of two as near (`paymentFor`): Sep 30, on September's grid — so the mark stood while the Oct 2 row, a
 * posting of its own within its grace on THIS grid, stood for the same day.
 */
describe("a rent split either side of the month's edge is one occurrence on October's grid", () => {
  const today = "2026-10-05";
  beforeEach(() => {
    pay("t-rent-sep30", RENT, "2026-09-30", -110000);
    pay("t-rent-oct2", RENT, "2026-10-02", -119121);
  });

  test("the rent's Oct 1 is the Oct 2 row it draws — no second mark naming Sep 30 beside it", () => {
    const grid = recurringCalendar(bundle.db, "2026-10", today).entriesByDay;
    const rent = Object.entries(grid).flatMap(([day, entries]) =>
      entries.filter((e) => e.seriesId === RENT).map((e) => [day, e.transactionId, e.paidWith]),
    );
    expect(rent).toEqual([["2026-10-02", "t-rent-oct2", null]]);
  });

  test("what the rent carries names the payment drawn beside it, Oct 2 — the one the reader can find on this grid", () => {
    const oct1 = recurringCalendar(bundle.db, "2026-10", today).entriesByDay["2026-10-01"] ?? [];
    expect(oct1.map((e) => [e.seriesId, e.state, e.paidWith, e.settledCents])).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02" }, 0],
    ]);
  });

  test("September draws its own half on the day it landed, and no occurrence of October's", () => {
    const sep = recurringCalendar(bundle.db, "2026-09", today).entriesByDay;
    expect(sep["2026-09-30"]?.map((e) => [e.seriesId, e.transactionId])).toEqual([[RENT, "t-rent-sep30"]]);
  });
});

/*
 * ⛔ EACH PAYMENT IS JUDGED BY ITS OWN SERIES' TOLERANCE — never the widest one the read was widened by. Every reader
 * reads postings the widest tolerance either side of its window (`billPaymentsBySeries`, `carrierPaymentsBySeries`,
 * the calendar's step 1) and then holds each to its own series' days (`paymentFor`). 🔴 Nothing pinned the second half
 * (review of the 2026-10-08 batch): judging every posting by the widest passed every test. On his ledger copy
 * 2026-10-12 the Venture X annual fee has 14 days and the rent 3 — so a rent payment five days off its 1st would have
 * paid it, on every surface.
 *
 * Here the gym gets an annual fee's 14 days and a series billed inside it, so it is a carrier too: the rent's payments
 * are held to the rent's 3, and so is what the rent carries.
 */
describe("a payment pays a bill only within ITS series' grace — a wider one elsewhere in the ledger lends it none", () => {
  beforeEach(() => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 14 }).where(eq(recurringSeries.id, GYM)).run();
    bundle.db
      .insert(recurringSeries)
      .values({
        id: "locker",
        name: "Gym locker",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        toleranceDays: 3,
        nextExpectedOn: "2026-10-22",
        nextExpectedAmountCents: -1500,
        userAmountCents: -1500,
        anchorDay: 22,
        status: "confirmed",
        userCategoryId: categoryId,
        userBilledWithSeriesId: GYM,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  });

  test("paid Sep 26, five days early: Oct 1 is still coming on every reader that looks ahead — and what it carries", () => {
    rentPaid("2026-09-26");
    expect(ours(upcomingOccurrences(bundle.db, TODAY, 30))).toEqual([
      [RENT, "2026-10-01"],
      [UTIL, "2026-10-01"],
    ]);
    expect(octoberBills()).toEqual([
      `${RENT_NAME} 1 × -$2,109.00 (monthly), next Oct 1`,
      `${UTIL_NAME} 1 × -$182.21 (monthly), next Oct 1`,
    ]);
  });

  test("paid Oct 6, five days late: Oct 1 is owed — the arrears, and the calendar beside the Oct 6 row", () => {
    rentPaid("2026-10-06");
    const today = "2026-10-08";
    // asked of every bill, as the runway asks: the gym's 14 days widen the read, and lend the rent none of them
    const all = new Set([RENT, UTIL, GYM, "locker"]);
    expect(arrearsThisMonth(bundle.db, all, today).series.map((s) => [s.id, s.amountCents])).toEqual([
      [RENT, 210900],
      [UTIL, 18221],
    ]);
    const grid = recurringCalendar(bundle.db, "2026-10", today).entriesByDay;
    expect(grid["2026-10-01"]?.map((e) => [e.seriesId, e.transactionId, e.paidWith])).toEqual([
      [RENT, null, null],
      [UTIL, null, null],
    ]);
    expect(grid["2026-10-06"]?.map((e) => [e.seriesId, e.transactionId])).toEqual([[RENT, "t-rent-2026-10-06"]]);
  });
});

/*
 * The same hole inside one month: the calendar covers a bill's day with a posting of its own within its grace, while
 * the month forecast — and /budgets' tail, and the dashboard's free-to-spend through it — still counted the day on
 * top of the posting its "spent so far" already holds.
 */
describe("a bill paid two days early inside the month leaves what the month still owes", () => {
  beforeEach(() => pay("t-gym", GYM, "2026-10-20", -10000));
  const today = "2026-10-21";

  test("the month forecast, the Upcoming tab and /budgets' tail no longer count the gym's Oct 22", () => {
    const gym = (list: readonly { seriesId: string; date: string }[]) => list.filter((o) => o.seriesId === GYM);
    expect(forecastCurrentMonth(bundle.db, today).components.filter((c) => c.label === "Gym")).toEqual([]);
    expect(gym(upcomingOccurrences(bundle.db, today, 30))).toEqual([]);
    expect(budgetTail(bundle.db, categoryId, "2026-10-31", today).series.map((s) => s.id)).not.toContain(GYM);
    // …which the calendar already said: the Oct 20 row is the Oct 22 bill, and no Oct 22 is drawn
    const grid = recurringCalendar(bundle.db, "2026-10", today).entriesByDay;
    expect(grid["2026-10-20"]?.find((e) => e.seriesId === GYM)).toMatchObject({ transactionId: "t-gym" });
    expect(grid["2026-10-22"]?.find((e) => e.seriesId === GYM)).toBeUndefined();
  });
});
