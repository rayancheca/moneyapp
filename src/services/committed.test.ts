import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { carCard, committedBook, runwayCard, spendBaseline, SPEND_BASELINE_MONTHS } from "./committed";
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

  // $8,000 of spending in each of the six complete baseline months
  for (const m of BASELINE_MONTHS) {
    insertTxn({ postedOn: `${m}-05`, amountCents: -800000, rawDescription: "SUPERMARKET" });
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
    bundle.db.delete(transactions).where(eq(transactions.postedOn, "2026-04-05")).run();
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
    // it is the OVERDUE leg that owns it — unposted, and due on or before today
    expect(book.overdueCents).toBe(210900);
    expect(book.totalCents).toBe(210900);
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
    expect(book.lines.find((l) => l.name === "Rent")).toBeUndefined();
    expect(book.totalCents).toBe(0);
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

describe("carCard", () => {
  test("is absent without a Car category, and present once there is one", () => {
    expect(carCard(bundle.db, TODAY)).toBeNull();
    createCarCategory();
    expect(carCard(bundle.db, TODAY)).not.toBeNull();
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
