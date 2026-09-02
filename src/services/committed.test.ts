import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { addCalendarMonths, addDays, daysInMonthOf, monthKey } from "@/lib/dates";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { baselineWindow, carCard, committedBook, runwayCard, spendBaseline, SPEND_BASELINE_MONTHS } from "./committed";
import { forecastCurrentMonth } from "./forecast";

/**
 * A seeded ledger shaped like the real one at 2026-08-24, small enough to reason
 * about: $8,000/month of spending across six complete months, a $2,000/month
 * income series, one $1,000/month bill, and balances that make the headline
 * arithmetic checkable by hand.
 */
const TODAY = "2026-08-24";
/** The six complete months the baseline averages: 2026-02 … 2026-07. */
const BASELINE_MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"] as const;

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;
let brokerageId: string;
let groceriesId: string;
let seq = 0;

function insertTxn(opts: {
  accountId?: string;
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  categoryId?: string | null;
}): string {
  seq += 1;
  const accountId = opts.accountId ?? checkingId;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.rawDescription,
      normalizedDescription: normalizeDescription(opts.rawDescription),
      categoryId: opts.categoryId ?? groceriesId,
      dedupeHash: dedupeHash({
        accountId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.rawDescription}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function setBalance(accountId: string, day: string, balanceCents: number): void {
  bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents, basis: "carried" }).run();
}

function addSeries(opts: {
  name: string;
  kind: "bill" | "income" | "subscription" | "transfer" | "other";
  nextExpectedOn: string;
  amountCents: number;
  userCategoryId?: string | null;
  userEndsOn?: string | null;
  lastMatchedOn?: string | null;
}): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind,
      cadence: "monthly",
      status: "confirmed",
      intervalDaysAvg: 30,
      toleranceDays: 4,
      nextExpectedOn: opts.nextExpectedOn,
      nextExpectedAmountCents: opts.amountCents,
      userCategoryId: opts.userCategoryId ?? null,
      userEndsOn: opts.userEndsOn ?? null,
      lastMatchedOn: opts.lastMatchedOn ?? null,
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-committed-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  brokerageId = createAccount(bundle.db, {
    institutionId: chase.id,
    name: "Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  groceriesId = bundle.db.select().from(categories).where(eq(categories.name, "Groceries")).get()!.id;
  seq = 0;

  /*
   * $8,000 of spending in each of the six complete baseline months.
   *
   * ⚠️ On the FIRST, not the fifth. `spendBaseline` excludes the ledger's
   * opening month unless the ledger opened on that month's first day — a stub
   * is not a month — and with these rows on the 5th the ledger opened
   * 2026-02-05, which made February this window's partial first month and
   * shrank it to five. The day of the month carries no meaning here; the
   * amounts and the months do.
   */
  for (const m of BASELINE_MONTHS) {
    insertTxn({ postedOn: `${m}-01`, amountCents: -800000, rawDescription: "SUPERMARKET" });
  }
  // …and a smaller, incomplete August, which must NOT drag the average down
  insertTxn({ postedOn: "2026-08-05", amountCents: -100000, rawDescription: "SUPERMARKET" });

  setBalance(checkingId, TODAY, 500000); // $5,000 cash
  setBalance(cardId, TODAY, -80000); // $800 owed
  setBalance(brokerageId, TODAY, 2000000); // $20,000 invested
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("spendBaseline", () => {
  test("averages the complete months and excludes the current one", () => {
    const b = spendBaseline(bundle.db, TODAY);
    expect(b).toMatchObject({ monthlyCents: 800000, months: 6, fromMonth: "2026-02", toMonth: "2026-07" });
  });

  test("the incomplete current month is excluded, not prorated", () => {
    // August holds $1,000. Averaged in over 7 months it would read $6,857.14;
    // prorated it would read lower still. Neither is what this publishes.
    expect(spendBaseline(bundle.db, TODAY).monthlyCents).toBe(800000);
  });

  test("a month with no spending counts as a zero, not as a missing sample", () => {
    bundle.db.delete(transactions).where(eq(transactions.postedOn, "2026-04-01")).run();
    // five months of $8,000 over a SIX month window = $6,666.67, not $8,000
    expect(spendBaseline(bundle.db, TODAY).monthlyCents).toBe(666667);
  });

  test("an empty ledger averages to zero rather than dividing by nothing", () => {
    bundle.db.delete(transactions).run();
    expect(spendBaseline(bundle.db, TODAY).monthlyCents).toBe(0);
  });

  test("the window length is the published one", () => {
    expect(spendBaseline(bundle.db, TODAY).months).toBe(SPEND_BASELINE_MONTHS);
  });

  /*
   * 🔴 A month with no spending is a real zero — that is why this averages over
   * whole months rather than months-that-had-rows. A month BEFORE THE LEDGER
   * BEGAN is not a measurement at all, and counting it as a zero divides real
   * spending by imports that were never made.
   *
   * Measured on the owner's own ledger at today = 2022-11-01 (it opens
   * 2022-08-25): $1,961.04 of spending sat in three of the six month keys and
   * published $326.84 a month against the $653.68 those three come to. The
   * runway divides net cash by that rate, so it read roughly twice as long.
   *
   * ⚠️ `moversCard` already stated the rule and applied it. This was the third
   * surface asking one question and the only one answering it.
   */
  test("the window cannot reach back further than the ledger does", () => {
    // wipe the fixture's history and give the ledger a start on a month's FIRST
    // day, so nothing is partial and only the floor is under test
    bundle.db.delete(transactions).run();
    insertTxn({ postedOn: "2026-06-01", amountCents: -300000, rawDescription: "SUPERMARKET" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -300000, rawDescription: "SUPERMARKET" });

    const b = spendBaseline(bundle.db, TODAY);
    // June and July are the only complete months inside the ledger
    expect(b.months).toBe(2);
    expect(b.fromMonth).toBe("2026-06");
    expect(b.toMonth).toBe("2026-07");
    expect(b.monthlyCents).toBe(300000);
  });

  /*
   * ⛔ THE LEDGER'S OPENING MONTH IS NOT A MONTH unless the ledger opened on its
   * first day. The caption this figure carries says "averaged over N COMPLETE
   * months"; a stub is not one, and averaging it in as if it were divides real
   * spending by days nobody imported.
   *
   * Measured on the owner's own ledger, which opens 2022-08-25 with $46.44 of
   * spending in its seven days:
   *
   *     today = 2022-10-01   $519.61/mo over "2 complete months, 2022-08 to
   *                          2022-09" — the one month covered in full spent
   *                          $992.78
   *     today = 2022-11-01   $653.68/mo where the two complete months come to
   *                          $957.30
   *
   * The runway divides net cash by this rate, so it reads roughly twice as long
   * on a ledger's first weeks — which is exactly when a new user is looking.
   */
  test("a ledger that opened mid-month does not count that month as a whole one", () => {
    bundle.db.delete(transactions).run();
    insertTxn({ postedOn: "2026-06-25", amountCents: -10000, rawDescription: "SUPERMARKET" }); // 6 days
    insertTxn({ postedOn: "2026-07-10", amountCents: -300000, rawDescription: "SUPERMARKET" });

    const b = spendBaseline(bundle.db, TODAY);
    // June is a six-day stub; July is the only complete month the ledger holds
    expect(b.months).toBe(1);
    expect(b.fromMonth).toBe("2026-07");
    expect(b.toMonth).toBe("2026-07");
    expect(b.monthlyCents).toBe(300000);
  });

  test("a ledger that opened ON the first is complete from that month", () => {
    bundle.db.delete(transactions).run();
    insertTxn({ postedOn: "2026-06-01", amountCents: -10000, rawDescription: "SUPERMARKET" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -300000, rawDescription: "SUPERMARKET" });

    const b = spendBaseline(bundle.db, TODAY);
    expect(b.months).toBe(2);
    expect(b.fromMonth).toBe("2026-06");
    expect(b.monthlyCents).toBe(Math.round(310000 / 2));
  });

  test("a quiet month inside the ledger is still a zero, not a missing sample", () => {
    bundle.db.delete(transactions).run();
    // the ledger opens on February's FIRST day, so all six months are inside it
    // whole — and the four with nothing in them are real zeroes that must pull
    // the average down
    insertTxn({ postedOn: "2026-02-01", amountCents: -300000, rawDescription: "SUPERMARKET" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -300000, rawDescription: "SUPERMARKET" });

    const b = spendBaseline(bundle.db, TODAY);
    expect(b.months).toBe(SPEND_BASELINE_MONTHS);
    expect(b.monthlyCents).toBe(Math.round(600000 / SPEND_BASELINE_MONTHS));
  });

  test("a ledger with no complete month behind it reports no months rather than NaN", () => {
    bundle.db.delete(transactions).run();
    insertTxn({ postedOn: "2026-08-10", amountCents: -300000, rawDescription: "SUPERMARKET" });

    const b = spendBaseline(bundle.db, TODAY);
    expect(b.months).toBe(0);
    expect(b.monthlyCents).toBe(0);
  });

});

describe("committedBook", () => {
  test("rolls up a live bill across the horizon", () => {
    addSeries({ name: "Rent", kind: "bill", nextExpectedOn: "2026-09-01", amountCents: -100000 });
    const book = committedBook(bundle.db, TODAY, 12);
    expect(book.lines.map((l) => l.name)).toEqual(["Rent"]);
    expect(book.totalCents).toBe(1200000);
    expect(book.perMonthCents).toBe(100000);
  });

  /**
   * The reason income is filtered in the SERVICE rather than left to the pure
   * module: `committedOutflows` would report it as `inflowCents`, which is meant
   * to be an alarm. Routine income leaking into it would make the alarm useless.
   */
  test("an income series contributes nothing, and raises no false alarm", () => {
    addSeries({ name: "Rent", kind: "bill", nextExpectedOn: "2026-09-01", amountCents: -100000 });
    addSeries({ name: "Salary", kind: "income", nextExpectedOn: "2026-09-01", amountCents: 200000 });
    const book = committedBook(bundle.db, TODAY, 12);
    expect(book.totalCents).toBe(1200000);
    expect(book.inflowCents).toBe(0);
    expect(book.inflowCount).toBe(0);
  });

  /**
   * A transfer moves money between accounts the owner already holds — nothing
   * leaves, so it is not a committed outflow. Measured on the e2e fixture, the
   * looser "anything but income" filter admitted eight transfer series and
   * published $7,530.90/month of committed spending against a $4,799.17/month
   * total.
   */
  test("a transfer between own accounts is not a commitment", () => {
    addSeries({ name: "Rent", kind: "bill", nextExpectedOn: "2026-09-01", amountCents: -100000 });
    addSeries({ name: "To savings", kind: "transfer", nextExpectedOn: "2026-09-02", amountCents: -50000 });
    const book = committedBook(bundle.db, TODAY, 12);
    expect(book.lines.map((l) => l.name)).toEqual(["Rent"]);
    expect(book.totalCents).toBe(1200000);
  });

  test("an unclassified series is not a commitment either", () => {
    addSeries({ name: "Something", kind: "other", nextExpectedOn: "2026-09-02", amountCents: -50000 });
    expect(committedBook(bundle.db, TODAY, 12).totalCents).toBe(0);
  });

  test("a subscription IS a commitment", () => {
    addSeries({ name: "Netflix", kind: "subscription", nextExpectedOn: "2026-09-02", amountCents: -1549 });
    expect(committedBook(bundle.db, TODAY, 12).totalCents).toBe(1549 * 12);
  });

  /* ── the two window boundaries ───────────────────────────────────────────
     🔴 Both of these were live on the dashboard, and NEITHER could be reached
     by the fixture above: `TODAY` is the 24th while every bill in these tests is
     anchored on the 1st or 2nd, so no bill can coincide with today and no anchor
     can land on the horizon's last day. Twenty-three green tests with both
     boundaries structurally unreachable — so these use a today that is
     deliberately ON the anchor. */

  /** A month-anchored bill whose due day IS `on`. */
  const rentDueOn = (on: string) =>
    addSeries({ name: "Rent", kind: "bill", nextExpectedOn: on, amountCents: -210900 });

  /**
   * 🔴 Measured on the real ledger at today = 2026-09-01: rent counted THREE
   * times in one month, publishing $8,150.02/month of committed bills against
   * the forecast card's $3,567.60 for the same series and the same month.
   * One of the three was this — the overdue window `[monthStart, today]` and the
   * upcoming window `[today, …]` both claiming the bill due today.
   */
  test("a bill due TODAY is counted once, not once per window", () => {
    const DUE_TODAY = "2026-09-01";
    rentDueOn(DUE_TODAY);
    const book = committedBook(bundle.db, DUE_TODAY, 1);

    const rent = book.lines.find((l) => l.name === "Rent")!;
    expect(rent.occurrences).toBe(1);
    expect(rent.totalCents).toBe(210900);
    expect(book.totalCents).toBe(210900);
    /*
     * ⚠️ It is the FORWARD leg that owns it, and this assertion flipped when
     * the horizon became a rate window. A bill due today and unposted is not
     * late — it is due. The arrears leg closes the day BEFORE today so the two
     * still abut exactly, and "nothing is late" on the day rent falls due is
     * the honest reading of the runway card's own sentence.
     */
    expect(book.overdueCents).toBe(0);
  });

  /**
   * The second of the three. `addCalendarMonths("2026-09-01", 6)` is
   * 2027-03-01, and projecting through it INCLUSIVE catches a seventh
   * first-of-month. Six calendar months must mean six payments.
   */
  test("an N-month horizon projects exactly N payments of a monthly bill", () => {
    const DUE_TODAY = "2026-09-01";
    rentDueOn(DUE_TODAY);
    for (const months of [1, 3, 6, 12]) {
      const book = committedBook(bundle.db, DUE_TODAY, months);
      const rent = book.lines.find((l) => l.name === "Rent")!;
      expect(rent.occurrences, `${months}-month horizon`).toBe(months);
      expect(rent.perMonthCents, `${months}-month horizon`).toBe(210900);
    }
  });

  /**
   * ⚠️ The FAR edge, pinned exactly. The near edge (a bill due today) and the
   * payment count both survive a horizon that is a day too short, because every
   * other bill here is anchored on the 1st and nothing sits near the end. Found
   * by mutation: shrinking `horizonEnd` by one more day broke nothing until a
   * bill was anchored ON it.
   *
   * today = 2026-09-01 with a 1-month horizon ends on 2026-09-30, so a bill due
   * that day is the last one inside it — and it belongs there.
   */
  test("a bill due on the horizon's last day is inside it", () => {
    const DUE_TODAY = "2026-09-01";
    addSeries({ name: "Late bill", kind: "bill", nextExpectedOn: "2026-09-30", amountCents: -5000 });
    const book = committedBook(bundle.db, DUE_TODAY, 1);
    const line = book.lines.find((l) => l.name === "Late bill");
    expect(line?.occurrences).toBe(1);
    expect(book.totalCents).toBe(5000);
  });

  /**
   * …and the day AFTER it is outside. Together these two fix the boundary to a
   * single day rather than "somewhere around the end of the month".
   */
  test("a bill due the day after the horizon is outside it", () => {
    const DUE_TODAY = "2026-09-01";
    addSeries({ name: "Next month", kind: "bill", nextExpectedOn: "2026-10-01", amountCents: -5000 });
    const book = committedBook(bundle.db, DUE_TODAY, 1);
    expect(book.lines.find((l) => l.name === "Next month")).toBeUndefined();
    expect(book.totalCents).toBe(0);
  });

  /**
   * 🔴 THE FOURTH PHRASING — and the six tests above could not see it, because
   * every one of them asks on 2026-09-01, the single day of the month where it
   * does not fire.
   *
   * The overdue leg opens at `periodBounds(today,"monthly").start` and the
   * horizon was anchored on `today`, so the numerator spanned
   * `[monthStart, today + N months)` — N months PLUS however many days into the
   * month it happens to be — while the divisor stayed `N`. A monthly bill that
   * is overdue therefore contributes N+1 payments to an N-month average.
   *
   * Measured on the owner's real ledger, with NO September rows in it at all —
   * nothing changed between these two days except the question:
   *
   *     2026-09-01   $3,542.21 a month   (rent: 12 payments, $2,109.00/mo)
   *     2026-09-02   $3,733.14 a month   (rent: 13 payments, $2,284.75/mo)
   *     2026-09-23   $3,809.38 a month
   *     2026-10-01   $3,512.08 a month   ← and it resets
   *
   * A $267.17 sawtooth on the runway card's headline, every month. The rent
   * line published $2,284.75 as the monthly burden of a $2,109.00 bill: a
   * monthly series can never cost more per month than its own bill.
   * `CommittedLine.perMonthCents` defends `total ÷ months` with the insurance
   * case — a series that ENDS inside the horizon and gets FEWER than N — and
   * never contemplated a series getting MORE.
   *
   * ⚠️ `carCard` does NOT share this and must not be "fixed" the same way: it
   * has no overdue leg, so its window really does start at `today` and its
   * denominator really does span it. Swept day by day across September on the
   * real ledger, its all-in monthly figure is constant at $1,325.60. Copying
   * this fix onto it would move its window a month backwards for nothing.
   */
  test("a per-month figure does not depend on which day of the month you ask", () => {
    // rent anchored on the 1st, unposted — so it is overdue from the 2nd onward
    rentDueOn("2026-09-01");
    addSeries({ name: "Netflix", kind: "subscription", nextExpectedOn: "2026-09-15", amountCents: -1549 });

    for (const months of [1, 3, 12]) {
      const onTheFirst = committedBook(bundle.db, "2026-09-01", months);
      for (const day of ["2026-09-02", "2026-09-08", "2026-09-15", "2026-09-16", "2026-09-30"]) {
        const book = committedBook(bundle.db, day, months);
        expect(book.perMonthCents, `${months}mo asked on ${day}`).toBe(onTheFirst.perMonthCents);
        expect(book.totalCents, `${months}mo asked on ${day}`).toBe(onTheFirst.totalCents);
        const rent = book.lines.find((l) => l.name === "Rent")!;
        expect(rent.occurrences, `${months}mo asked on ${day}`).toBe(months);
        // the bill's own amount, never a fraction more
        expect(rent.perMonthCents, `${months}mo asked on ${day}`).toBe(210900);
      }
    }
  });

  /**
   * The horizon opens on `today` and the arrears leg closes the day before, so
   * the two abut with no day in both and no day in neither. Pinned on a today
   * deep inside the month, which is the only place the alternatives differ.
   */
  test("the arrears leg and the horizon abut on today, and arrears stay outside", () => {
    const MID = "2026-09-16";
    rentDueOn("2026-09-01"); // unposted since the 1st: arrears by the 16th
    const book = committedBook(bundle.db, MID, 12);

    const rent = book.lines.find((l) => l.name === "Rent")!;
    // twelve months from 2026-09-16 hold twelve first-of-months: 2026-10 … 2027-09
    expect(rent.occurrences).toBe(12);
    expect(rent.totalCents).toBe(210900 * 12);
    // …and the payment it slid past is arrears, once, beside the total
    expect(rent.overdueCents).toBe(210900);
    expect(book.overdueCents).toBe(210900);
    expect(book.overdueCount).toBe(1);
    expect(book.totalCents).toBe(210900 * 12);
  });

  /** The far edge of the forward window, pinned to a single day from a mid-month today. */
  test("the horizon's far edge is exactly N months after today", () => {
    const MID = "2026-09-16";
    addSeries({ name: "Edge", kind: "bill", nextExpectedOn: "2027-09-15", amountCents: -700 });
    addSeries({ name: "Beyond", kind: "bill", nextExpectedOn: "2027-09-16", amountCents: -900 });

    const book = committedBook(bundle.db, MID, 12);
    // 2027-09-15 is the last day of [2026-09-16, 2027-09-16) — inside it
    expect(book.lines.find((l) => l.name === "Edge")?.occurrences).toBe(1);
    // …and the very next day is outside, which fixes the edge to one day
    expect(book.lines.find((l) => l.name === "Beyond")).toBeUndefined();
  });

  /**
   * ⭐ The check that actually caught this: two independently-computed surfaces
   * answering one question. `committedBook` walks `upcomingOccurrences` plus an
   * overdue leg; the forecast card partitions `forecastCurrentMonth`'s own
   * components. They share no arithmetic, so agreement is evidence rather than
   * tautology — and before the fix they disagreed by 2.3×.
   */
  test("agrees with the forecast card about the running month", () => {
    const DUE_TODAY = "2026-09-01";
    rentDueOn(DUE_TODAY);
    addSeries({ name: "Netflix", kind: "subscription", nextExpectedOn: "2026-09-15", amountCents: -1549 });

    const book = committedBook(bundle.db, DUE_TODAY, 1);
    const card = forecastCurrentMonth(bundle.db, DUE_TODAY);
    expect(book.totalCents).toBe(-card.committed.spendCents);
  });

  /**
   * ⚠️ A bill that already POSTED today belongs to neither window. `overdue`
   * drops it because it is paid; `upcoming` must not resurrect it as a future
   * commitment simply because its date is not strictly in the past.
   */
  test("a bill that posted today is counted nowhere", () => {
    const DUE_TODAY = "2026-09-01";
    const rentId = rentDueOn(DUE_TODAY);
    insertTxn({
      postedOn: DUE_TODAY,
      amountCents: -210900,
      rawDescription: "FLAMINGO RENT",
      categoryId: null,
    });
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: rentId })
      .where(eq(transactions.rawDescription, "FLAMINGO RENT"))
      .run();

    const book = committedBook(bundle.db, DUE_TODAY, 1);
    /*
     * ⚠️ This assertion flipped too, and it is the honest consequence of the
     * horizon being a RATE. A rent paid on the 1st still cost $2,109.00 that
     * month, so it belongs in "committed bills come to $X a month"; what it is
     * NOT is arrears. The alternative — dropping a bill from the rate the
     * moment it posts — is what made the same $2,109.00 bill read $1,933.25 a
     * month when the window was anchored on the month's start instead. Measured
     * on the real ledger before it was rejected.
     */
    expect(book.lines.find((l) => l.name === "Rent")?.occurrences).toBe(1);
    expect(book.totalCents).toBe(210900);
    // …and nothing is late: it posted
    expect(book.overdueCents).toBe(0);
  });

  test("a series that ends inside the horizon stops there", () => {
    addSeries({
      name: "Insurance",
      kind: "bill",
      nextExpectedOn: "2026-09-01",
      amountCents: -50000,
      userEndsOn: "2027-01-01",
    });
    const line = committedBook(bundle.db, TODAY, 12).lines.find((l) => l.name === "Insurance");
    expect(line).toMatchObject({ occurrences: 5, totalCents: 250000 });
  });

  test("a bill that came due this month and never posted is committed money", () => {
    addSeries({
      name: "Internet",
      kind: "bill",
      nextExpectedOn: "2026-08-10",
      amountCents: -5000,
      lastMatchedOn: "2026-07-10",
    });
    const book = committedBook(bundle.db, TODAY, 12);
    expect(book.overdueCents).toBe(5000);
    const line = book.lines.find((l) => l.name === "Internet");
    expect(line?.overdueCents).toBe(5000);
  });

  test("a commitment with no postings is counted and flagged unevidenced", () => {
    addSeries({ name: "Car lease", kind: "bill", nextExpectedOn: "2026-09-11", amountCents: -55989 });
    const book = committedBook(bundle.db, TODAY, 12);
    expect(book.unevidencedCents).toBe(55989 * 12);
    expect(book.lines[0]).toMatchObject({ neverPosted: true });
  });

  test("an empty book is zero rather than an error", () => {
    expect(committedBook(bundle.db, TODAY, 12)).toMatchObject({ totalCents: 0, perMonthCents: 0 });
  });
});

describe("runwayCard", () => {
  test("nets card debt off the cash base and reports it as a positive debt", () => {
    const card = runwayCard(bundle.db, TODAY);
    expect(card.runway.netCashCents).toBe(500000 - 80000);
    expect(card.runway.assumptions.find((a) => a.id === "cards")?.cents).toBe(80000);
  });

  test("counts investment accounts as the second horizon, not the first", () => {
    const card = runwayCard(bundle.db, TODAY);
    expect(card.runway.liquid.cents).toBe(420000);
    expect(card.runway.withInvestments.cents).toBe(420000 + 2000000);
  });

  test("burns measured spend against the income rate", () => {
    addSeries({ name: "Salary", kind: "income", nextExpectedOn: "2026-09-01", amountCents: 200000 });
    const card = runwayCard(bundle.db, TODAY);
    expect(card.spend.monthlyCents).toBe(800000);
    // $8,000 spend − $2,000 income rate = $6,000/month
    expect(card.runway.netBurnCents).toBe(600000);
    expect(card.runway.kind).toBe("burning");
  });

  test("carries the committed subset alongside, without double-counting it", () => {
    addSeries({ name: "Rent", kind: "bill", nextExpectedOn: "2026-09-01", amountCents: -100000 });
    const card = runwayCard(bundle.db, TODAY);
    expect(card.committed.perMonthCents).toBe(100000);
    // the committed book informs; the burn is still measured spend vs income
    expect(card.runway.netBurnCents).toBe(800000 - card.runway.assumptions.find((a) => a.id === "income")!.cents);
  });

  test("names the basis its income term came from", () => {
    expect(runwayCard(bundle.db, TODAY).incomeBasisExplanation).toBeTruthy();
  });
});

/**
 * ⚠️ The seeded category tree has no `Car` — it is a top-level category the
 * owner added in pass 44 when he leased the car, and `seedDatabase` predates
 * it. So these tests create it, and the absent-case test below asserts BOTH
 * halves: null before, non-null after. Asserting only the null half would have
 * passed on a database where the feature could never work.
 */
function createCarCategory(): string {
  return bundle.db
    .insert(categories)
    .values({ name: "Car", parentId: null, kind: "expense", sortOrder: 99 })
    .returning({ id: categories.id })
    .get().id;
}

/**
 * ⛔ THE SWEEP THE FIXTURES COULD NOT DO.
 *
 * Every fixture in this repo pins `today` to a day no fixture bill is anchored
 * on — the 8th and the 24th — and three live boundary bugs shipped underneath
 * that. A fixture that cannot express a condition cannot test it, and the
 * condition here is a PAIR: which day of the month the bill falls on, and which
 * day of the month you happen to ask on. Every hand-written test fixes both.
 *
 * So this fixes neither. It states the invariant the three bugs each broke — a
 * monthly bill is exactly `months` payments in a `months`-month book — and
 * grades it over every (anchor day, asking day) pair across a 62-day span:
 * 31 series × 62 days, on days no hand-written fixture picked.
 */
describe("committedBook, over every day of the month", () => {
  const FROM = "2026-08-15";
  const SPAN_DAYS = 400;
  const HORIZON = 6;

  /**
   * ⛔ ONE SERIES IS DELIBERATELY LATE, on every asking day. Without it the
   * sweep pays every bill on time, the arrears leg is empty on all 62 days, and
   * "arrears are never inside the horizon" asserts nothing at all — the shape
   * this repo keeps finding, an assertion loose enough to survive the bug. Its
   * anchor moves with `today`, so it is late by ten days from every day of the
   * month in turn.
   */
  const LATE = "Bill 99";

  function seedOnePerAnchorDay(): void {
    addSeries({ name: LATE, kind: "bill", nextExpectedOn: "2026-08-05", amountCents: -99000 });
    for (let day = 1; day <= 31; day++) {
      addSeries({
        name: `Bill ${String(day).padStart(2, "0")}`,
        kind: "bill",
        nextExpectedOn: `2026-08-${String(day).padStart(2, "0")}`,
        amountCents: -1000 * day,
        lastMatchedOn: `2026-07-${String(day).padStart(2, "0")}`,
      });
    }
  }

  /**
   * ⚠️ A SERIES NOBODY PAYS STOPS BEING FORECAST, and rightly — `seriesHasLapsed`
   * ends a projection whose evidence has run out. A static fixture therefore
   * dissolves partway through a two-month sweep and the sweep reads that as a
   * boundary bug. Advancing the evidence is what an import does, so the sweep
   * does it too: on each asking day every series has last posted on its own most
   * recent anchor day.
   */
  function payEveryoneThrough(today: string): void {
    for (const s of bundle.db.select().from(recurringSeries).all()) {
      if (s.name === LATE) {
        // due ten days ago and unpaid for forty — late, and still well inside
        // the lapse threshold, so it is forecast AND in arrears
        bundle.db
          .update(recurringSeries)
          .set({ nextExpectedOn: addDays(today, -10), lastMatchedOn: addDays(today, -40) })
          .where(eq(recurringSeries.id, s.id))
          .run();
        continue;
      }
      const day = Number(s.nextExpectedOn!.slice(8));
      /*
       * ⛔ STRICTLY GREATER: a bill due TODAY has not posted yet. Paying it on
       * its own anchor day is what a fixture does and a bank does not, and it
       * hides the condition the two legs meet at — a payment that is due today
       * is inside the horizon and must not ALSO be in arrears. With `>=` here
       * the sweep survived an overdue leg widened to include today.
       */
      const month = Number(today.slice(8)) > day ? today.slice(0, 7) : monthKey(addCalendarMonths(`${today.slice(0, 7)}-01`, -1));
      // the calendar clamps a 31st into a 30-day month, exactly as the engine does
      const posted = Math.min(day, daysInMonthOf(`${month}-01`));
      bundle.db
        .update(recurringSeries)
        .set({ lastMatchedOn: `${month}-${String(posted).padStart(2, "0")}` })
        .where(eq(recurringSeries.id, s.id))
        .run();
    }
  }

  /**
   * ✅ THE CLAMP, FOUND BY THIS SWEEP AND NOW FIXED — and the list below is
   * empty on purpose, because it used to have six entries in it.
   *
   * `addCalendarMonths("2026-08-29", 6)` is `2027-02-28`, because 29 February
   * 2027 does not exist, so a half-open `[today, to)` ran a day short of six
   * whole months and a bill anchored on the 28th lost its sixth payment while
   * the rate still divided by six:
   *
   *     2026-08-29  Bill 28      2026-08-31  Bill 28
   *     2026-08-30  Bill 28      2026-08-31  Bill 29
   *     2026-08-30  Bill 29      2026-08-31  Bill 30
   *
   * ⛔ THE OBVIOUS FIX WAS THE MIRRORED DEFECT, and it was measured before it
   * was rejected: the recurring engine clamps too, so the series anchored on
   * the 28th, 29th, 30th AND 31st all project onto 2027-02-28. Making that day
   * inclusive fixes the 28th and hands the 29th and 30th a SEVENTH payment. No
   * date cut can separate four anchors that share a date — which is why
   * membership moved into MONTH SPACE (`MonthHorizon`), judged against the day
   * each series is really billed on rather than the day the calendar could fit.
   *
   * Keep this list empty. Both halves are graded below: `short` catches a
   * window that has lost a payment, `other` catches one that has gained one.
   */
  const KNOWN_CLAMP_SHORTFALLS: string[] = [];

  test("a monthly bill is exactly `months` payments, whatever day it falls on and whatever day you ask", () => {
    seedOnePerAnchorDay();
    const short: string[] = [];
    const other: string[] = [];
    for (let i = 0; i < SPAN_DAYS; i++) {
      const today = addDays(FROM, i);
      payEveryoneThrough(today);
      const book = committedBook(bundle.db, today, HORIZON);
      expect(book.months).toBe(HORIZON);
      // every series is live on every asking day: none may vanish
      expect(book.lines.length).toBe(32);
      for (const line of book.lines) {
        if (line.occurrences === HORIZON) continue;
        (line.occurrences === HORIZON - 1 ? short : other).push(`${today} ${line.name}`);
      }
    }
    // nothing is ever LONG, and nothing is ever short by more than one
    expect(other).toEqual([]);
    expect([...short].sort()).toEqual(KNOWN_CLAMP_SHORTFALLS);
  });

  /**
   * The other half of the same boundary: the two legs must ABUT. A payment that
   * is late is not also scheduled — otherwise one bill is two rows, and the rate
   * divides a numerator that reaches back before the window by a divisor that
   * does not.
   */
  test("arrears are never inside the horizon they are reported beside", () => {
    seedOnePerAnchorDay();
    const wrong: string[] = [];
    let arrearsDays = 0;
    for (let i = 0; i < SPAN_DAYS; i++) {
      const today = addDays(FROM, i);
      payEveryoneThrough(today);
      const book = committedBook(bundle.db, today, HORIZON);
      /*
       * ⛔ THE ARREARS LEG IS SCOPED TO THE CALENDAR MONTH, and the card says so
       * — "a further $X came due earlier this month and never posted". So a bill
       * due on the 22nd is arrears on the 31st and NOT arrears on the 1st, with
       * nothing paid in between. Pinned here rather than asserted away: it is
       * the wording's own scope, and whether an unpaid bill should survive the
       * turn of the month is the owner's call, not a bug to fix quietly.
       */
      const lateInThisMonth = monthKey(addDays(today, -10)) === monthKey(today);
      // and there are real arrears on plenty of the sweep's days, or every
      // assertion about them below is vacuous
      arrearsDays += book.overdueCount >= 1 ? 1 : 0;
      for (const line of book.lines) {
        // the horizon total is `occurrences` payments of one bill and nothing
        // else; arrears live in their own field or the rate is wrong
        const perPayment = 1000 * Number(line.name.slice(-2));
        if (line.totalCents !== line.occurrences * perPayment) wrong.push(`${today} ${line.name} total`);
        if (line.perMonthCents !== Math.round(line.totalCents / HORIZON)) wrong.push(`${today} ${line.name} rate`);
        if (line.name === LATE && line.overdueCents !== (lateInThisMonth ? perPayment : 0)) {
          wrong.push(`${today} ${line.name} arrears ${line.overdueCents}`);
        }
        /*
         * ⛔ THE DAY THE TWO LEGS MEET. The bill anchored on today's own day of
         * the month is due TODAY, which is the first day of the horizon — so it
         * is scheduled, and it must not ALSO be late. This is the one condition
         * the fixtures could never state: every `TODAY` in this repo is a day no
         * fixture bill is anchored on, and here every asking day is some bill's
         * anchor day. `payEveryoneThrough` deliberately leaves it unpaid.
         */
        if (line.name === `Bill ${today.slice(8)}` && line.overdueCents !== 0) {
          wrong.push(`${today} ${line.name} is due today AND ${line.overdueCents} late`);
        }
      }
      // and the book's own total never borrows from the arrears it reports
      expect(book.totalCents).toBe(book.lines.reduce((s2, l) => s2 + l.totalCents, 0));
    }
    expect(wrong).toEqual([]);
    // the late bill is genuinely in arrears on most of the swept days
    expect(arrearsDays).toBeGreaterThan(SPAN_DAYS / 2);
  });
});

describe("carCard", () => {
  test("is absent without a Car category, and present once there is one", () => {
    expect(carCard(bundle.db, TODAY)).toBeNull();
    createCarCategory();
    expect(carCard(bundle.db, TODAY)).not.toBeNull();
  });

  /**
   * 🔴 A NUMERATOR THAT FOLLOWS THE WINDOW AND A DENOMINATOR THAT DOES NOT.
   *
   * The "before the car" figure removes car spending from the baseline so the
   * car is not counted twice — once inside the average and again as its own
   * amortised cost. The removal was divided by the CONSTANT six while the
   * average it is subtracted from was divided by `baseline.months`, which
   * shrinks to the months the ledger can prove. On a ledger under seven months
   * old that leaves most of the car spending inside the total whose whole job
   * is to have it taken out.
   */
  test("subtracts car spending over the window's own months, not the constant six", () => {
    const carId = createCarCategory();
    addSeries({
      name: "Car lease",
      kind: "bill",
      nextExpectedOn: "2026-05-11",
      amountCents: -55989,
      userCategoryId: carId,
    });
    // $600 of car spending inside a window the ledger has shortened to THREE
    // months (2026-02 … 2026-04): $200 a month, not $100.
    insertTxn({
      postedOn: "2026-03-10",
      amountCents: -60000,
      rawDescription: "CAR PAYMENT",
      categoryId: carId,
    });

    const asked = spendBaseline(bundle.db, "2026-05-15");
    expect(asked.months).toBe(3);

    const c = carCard(bundle.db, "2026-05-15")!;
    expect(c.baseline.months).toBe(3);
    expect(c.baseline.monthlyCents).toBe(asked.monthlyCents - 20000);
    expect(c.baseline.monthlyCents).not.toBe(asked.monthlyCents - 10000);
  });

  test("prices the monthly bill from the commitments, not from the horizon average", () => {
    const carId = createCarCategory();
    addSeries({
      name: "Car lease",
      kind: "bill",
      nextExpectedOn: "2026-09-11",
      amountCents: -55989,
      userCategoryId: carId,
    });
    addSeries({
      name: "Car insurance",
      kind: "bill",
      nextExpectedOn: "2026-09-11",
      amountCents: -36149,
      userCategoryId: carId,
      userEndsOn: "2027-01-11",
    });
    const c = carCard(bundle.db, TODAY)!;
    // the bill he pays in September, not $8,526.13 ÷ 12
    expect(c.cost.monthlyCents).toBe(55989 + 36149);
    expect(c.cost.committedCents).toBe(55989 * 12 + 36149 * 5);
    expect(c.cost.monthlyCents).not.toBe(Math.round(c.cost.committedCents / 12));
  });

  /**
   * 🔴 The SECOND phrasing of one boundary, left behind when `committedBook`'s
   * was fixed — and the reason to grep for who else answers a question before
   * fixing one caller.
   *
   * Measured on the real ledger: on 2026-09-15, the lease's own anchor day, a
   * twelve-month horizon `[2026-09-15, 2027-09-15]` caught THIRTEEN lease
   * payments and the card published $10,481.48 where the days either side both
   * said $9,786.44. One spike, $695.04 — exactly one payment — on one day per
   * month per series.
   *
   * ⚠️ `TODAY` is the 24th and the fixture bills are anchored on the 11th, so
   * this could not fire there either. It takes a today ON the anchor.
   */
  test("a twelve-month horizon holds twelve payments, even on the anchor day", () => {
    const carId = createCarCategory();
    const ANCHOR = "2026-09-15";
    addSeries({
      name: "Car lease",
      kind: "bill",
      nextExpectedOn: ANCHOR,
      amountCents: -69504,
      userCategoryId: carId,
    });

    const onAnchor = carCard(bundle.db, ANCHOR)!;
    expect(onAnchor.cost.committedCents).toBe(69504 * 12);

    // …and it does not spike relative to the days either side
    const before = carCard(bundle.db, "2026-09-14")!;
    const after = carCard(bundle.db, "2026-09-16")!;
    expect(onAnchor.cost.committedCents).toBe(before.cost.committedCents);
    expect(onAnchor.cost.committedCents).toBe(after.cost.committedCents);
  });

  /**
   * ⚠️ And the OPPOSITE mistake must not be made here. `committedBook` skips an
   * occurrence dated `today` because its overdue leg already owns that day;
   * `carCard` has no overdue leg, so a bill due today belongs in its book and
   * skipping it would silently lose a payment. Same file, same constant, two
   * deliberately different rules.
   */
  test("a car bill due TODAY is inside the book, not skipped", () => {
    const carId = createCarCategory();
    const ANCHOR = "2026-09-15";
    addSeries({
      name: "Car lease",
      kind: "bill",
      nextExpectedOn: ANCHOR,
      amountCents: -69504,
      userCategoryId: carId,
      userEndsOn: "2026-09-15",
    });
    const c = carCard(bundle.db, ANCHOR)!;
    expect(c.cost.committedCents).toBe(69504);
    expect(c.cost.monthlyCents).toBe(69504);
  });

  test("discloses the first date a car commitment runs out", () => {
    const carId = createCarCategory();
    addSeries({
      name: "Car lease",
      kind: "bill",
      nextExpectedOn: "2026-09-11",
      amountCents: -55989,
      userCategoryId: carId,
      userEndsOn: "2028-08-11",
    });
    addSeries({
      name: "Car insurance",
      kind: "bill",
      nextExpectedOn: "2026-09-11",
      amountCents: -36149,
      userCategoryId: carId,
      userEndsOn: "2027-01-11",
    });
    // the insurance, not the lease — past it the monthly figure stops being true
    expect(carCard(bundle.db, TODAY)!.cost.evidencedThrough).toBe("2027-01-11");
  });

  /**
   * The share's denominator must not contain the car twice. On the real ledger
   * the baseline months predate every car row so the correction is zero today,
   * but it stops being zero once a car month enters the window.
   */
  test("car spending inside the baseline window is removed from the denominator", () => {
    const carId = createCarCategory();
    insertTxn({ postedOn: "2026-07-05", amountCents: -60000, rawDescription: "DEALER", categoryId: carId });
    const c = carCard(bundle.db, TODAY)!;
    // baseline is $8,000 + ($600 ÷ 6 months) = $8,100 gross; the car's $100 comes out
    expect(c.baseline.monthlyCents).toBe(800000);
  });
});

/*
 * ⭐ THE WHOLE POINT OF SHARING A WINDOW: five cards on one dashboard, one
 * ledger, one set of months. Five services import `SPEND_BASELINE_MONTHS`
 * precisely so they cannot quote different windows — and a constant is not
 * enough on its own, because the FLOOR is data-dependent. When `spendBaseline`
 * learned to shrink and the cards did not, a young ledger could put "3 complete
 * months" and "6 complete months" in two captions a reader can see at once.
 */
describe("baselineWindow — one window for every card that quotes one", () => {
  test("a ledger older than the window gets the whole window", () => {
    const w = baselineWindow(bundle.db, TODAY);
    expect(w.months).toBe(SPEND_BASELINE_MONTHS);
    expect(w.fromMonth).toBe("2026-02");
    expect(w.toMonth).toBe("2026-07");
    expect(w.from).toBe("2026-02-01");
    expect(w.to).toBe("2026-07-31"); // the real last day, never a notional 31st
    expect(w.keys).toHaveLength(SPEND_BASELINE_MONTHS);
  });

  test("a ledger younger than the window gets what it can prove", () => {
    bundle.db.delete(transactions).run();
    insertTxn({ postedOn: "2026-05-01", amountCents: -1000, rawDescription: "SUPERMARKET" });
    const w = baselineWindow(bundle.db, TODAY);
    expect(w.months).toBe(3); // May, June, July
    expect(w.fromMonth).toBe("2026-05");
    expect(w.toMonth).toBe("2026-07");
  });

  test("the last month's real length is the window's end, February included", () => {
    // today in March: the window closes at the end of February
    expect(baselineWindow(bundle.db, "2026-03-15").to).toBe("2026-02-28");
    expect(baselineWindow(bundle.db, "2028-03-15").to).toBe("2028-02-29");
  });

  test("an empty ledger has no window at all, and says so rather than guessing", () => {
    bundle.db.delete(transactions).run();
    const w = baselineWindow(bundle.db, TODAY);
    expect(w.months).toBe(0);
    expect(w.keys).toEqual([]);
  });

  test("spendBaseline reports exactly this window, never its own", () => {
    for (const today of [TODAY, "2026-03-15", "2022-11-01"]) {
      const w = baselineWindow(bundle.db, today);
      const b = spendBaseline(bundle.db, today);
      expect(b.months, today).toBe(w.months);
      expect(b.fromMonth, today).toBe(w.fromMonth);
      expect(b.toMonth, today).toBe(w.toMonth);
    }
  });
});
