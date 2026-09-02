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
import { incomeCard } from "./income-card";

/**
 * The card exists to keep one sentence off the dashboard: "your income
 * collapsed". So the tests that matter are the ones about which silences the
 * ledger has actually LOOKED at, which deposits are allowed to count as pay,
 * and what the difference between two numbers is allowed to be called.
 */

let dir: string;
let bundle: DbBundle;

const TODAY = "2026-08-26";
const CHASE = "acct-chase";
const SOFI = "acct-sofi";
const SERIES = "series-cash-job";
/** the window opens 6 months back, so 2026-02-01 */
const PAY_START = "2026-06-04"; // a Thursday

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

function addAccount(id: string, name: string): void {
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/**
 * A weekly cash-job schedule the owner has CONFIRMED. `userAmountCents` rather
 * than the detected average, because that is the shape on the real ledger and
 * `cashEarningsReadings` prefers it.
 */
function addSeries(overrides: Partial<typeof recurringSeries.$inferInsert> = {}): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      id: SERIES,
      name: "Cash job (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 100_000,
      userAmountCents: 100_000,
      status: "confirmed",
      // the projection walk needs an anchor and a per-occurrence amount, and
      // without them `incomeBasis` levels NOTHING and falls through to its
      // calendar branch — where its figure and the schedule's happen to
      // coincide, so a headline test over that fixture asserts 0 === 0 and
      // could not fail. Measured by mutation: swapping the headline to
      // `scheduledCents` survived until these two columns were set.
      nextExpectedOn: PAY_START,
      nextExpectedAmountCents: 100_000,
      toleranceDays: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    })
    .run();
}

let seq = 0;
function addTxn(
  day: string,
  cents: number,
  opts: { seriesId?: string | null; accountId?: string } = {},
): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: opts.accountId ?? CHASE,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ATM CASH DEPOSIT ${seq}`,
      normalizedDescription: `ATM CASH DEPOSIT ${seq}`,
      categoryId: salaryId(),
      recurringSeriesId: opts.seriesId === undefined ? SERIES : opts.seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/** Daily balances are what `accountCoverage` reads a verified-through date off. */
function coverThrough(accountId: string, from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db
      .insert(dailyBalances)
      .values({ accountId, day, balanceCents: 100_000, basis: "derived" })
      .run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-income-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(CHASE, "Chase Checking");
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("incomeCard", () => {
  test("reconciles what the schedule implies against what reached a bank", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    addTxn("2026-06-11", 40_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-12");

    const card = incomeCard(bundle.db, TODAY)!;
    const line = card.pay[0]!;
    // Jun 4 → Aug 26 inclusive, stepping weekly: 12 paydays
    expect(line.paydays).toBe(12);
    expect(line.impliedCents).toBe(1_200_000);
    expect(line.bankedCents).toBe(140_000);
    expect(line.gapCents).toBe(1_060_000);
    expect(line.gapMagnitudeCents).toBe(1_060_000);
    expect(line.gapLabel).toBe("never reached a bank");
    expect(card.totals.bankedCents).toBe(140_000);
    expect(card.bankedSharePct).toBe(12);
    expect(card.summary).toContain("12% of it");
  });

  /**
   * The whole point of the card. A silence the records already cover means the
   * ledger LOOKED and no deposit was there; a silence inside the stretch nobody
   * has imported means it has not looked. Saying the first when the second is
   * true is the false alarm this card exists to refuse.
   */
  test("a silence the records cover is reported as pay that did not arrive", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-12");

    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.basis).toBe("series-stale");
    expect(line.checkedThrough).toBe("2026-08-12");
    expect(line.unreadDays).toBe(14);
    // Jun 11 … Aug 6 fall at or before Aug 12; Aug 13 and Aug 20 do not
    expect(line.silentPeriods).toBe(11);
    expect(line.checkedSilentPeriods).toBe(9);
    expect(line.verdict).toContain("the pay did not reach a bank");
    expect(line.verdict).not.toContain("has not looked");
  });

  test("a silence inside the unimported tail is reported as the ledger not having looked", () => {
    addSeries();
    // seven paydays of silence — stale by any measure — but the records stop
    // one week in, so six of them are days nobody has imported
    addTxn("2026-07-02", 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-07-09");

    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.basis).toBe("series-stale");
    expect(line.checkedThrough).toBe("2026-07-09");
    expect(line.unreadDays).toBe(48);
    expect(line.silentPeriods).toBe(7);
    expect(line.checkedSilentPeriods).toBe(1);
    expect(line.verdict).toContain("has not looked");
    expect(line.verdict).not.toContain("did not reach a bank");
  });

  /**
   * The bar for "the ledger looked and found nothing" is `STALE_PERIODS`, the
   * same three periods `cashEarnings` uses to call a series stale. A second
   * threshold for one idea is a defect whichever number it holds, so this
   * asserts the boundary rather than a comfortable case well past it.
   */
  test("three checked missed paydays is enough to say the pay did not arrive", () => {
    addSeries();
    addTxn("2026-07-02", 100_000);
    // Jul 9, 16, 23 fall at or before the cut-off; Jul 30 onward do not
    coverThrough(CHASE, "2026-06-01", "2026-07-23");

    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.checkedSilentPeriods).toBe(3);
    expect(line.verdict).toContain("the pay did not reach a bank");
  });

  /**
   * ⛔ An account nothing checks cannot be used to say the ledger looked. A
   * single unverified landing place collapses the answer to null, because a
   * deposit could be sitting in it unseen.
   */
  test("an unchecked landing account withholds the verdict rather than guessing", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    // no daily_balances at all for CHASE

    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.checkedThrough).toBeNull();
    expect(line.unreadDays).toBeNull();
    expect(line.checkedSilentPeriods).toBe(0);
    expect(line.verdict).toContain("cannot say whether the pay arrived");
  });

  test("the earliest verified date across every landing account is the one used", () => {
    addAccount(SOFI, "SoFi Checking");
    addSeries();
    addTxn(PAY_START, 100_000, { accountId: CHASE });
    addTxn("2026-06-11", 100_000, { accountId: SOFI });
    coverThrough(CHASE, "2026-06-01", "2026-08-12");
    coverThrough(SOFI, "2026-06-01", "2026-07-31");

    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.checkedThrough).toBe("2026-07-31");
  });

  /**
   * ⛔ Only ATTRIBUTED deposits are pay. On the real ledger a $6,900 ATM pair is
   * his mother's money; a heuristic wide enough to catch a payday sweeps it in,
   * and the card would report money he never earned as wages banked.
   */
  test("a cash deposit with no series attached is never counted as pay", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    addTxn("2026-07-21", 690_000, { seriesId: null });
    coverThrough(CHASE, "2026-06-01", "2026-08-12");

    expect(incomeCard(bundle.db, TODAY)!.totals.bankedCents).toBe(100_000);
  });

  /**
   * ⛔ `x / 0` is Infinity, which renders as "Infinity%". A window holding no
   * payday has no share to publish.
   */
  test("a window with no payday yields a null share rather than Infinity", () => {
    // the schedule's only evidence is a deposit AFTER today, so the series has
    // no life inside the window and implies nothing
    addSeries();
    addTxn("2026-09-03", 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-12");

    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.totals.impliedCents).toBe(0);
    expect(card.bankedSharePct).toBeNull();
    expect(Number.isFinite(card.bankedSharePct ?? 0)).toBe(true);
    expect(card.summary).not.toContain("Infinity");
    expect(card.summary).toContain("nothing to reconcile yet");
  });

  /*
   * 🔴 The row said "13 paydays in this window" one line under a summary saying
   * "Measured from Mar 2026 to today". Thirteen WEEKLY paydays cannot span
   * twenty-six weeks — `cashEarnings` bounds the count by the series' own life
   * (`PAY_START`), and only the window was ever named. The row names its own
   * span now, and a reader can check it: Jun 4 to Aug 20 is eleven weeks and
   * twelve Thursdays.
   */
  test("a payday count names the span it covers, not the window that contains it", () => {
    addSeries();
    addTxn(PAY_START, 100_000); // one deposit, so the card has something to report
    coverThrough(CHASE, "2026-06-01", "2026-08-26");

    const card = incomeCard(bundle.db, TODAY)!;
    const line = card.pay[0]!;
    // the window opens months before the job did — the summary says so
    expect(card.summary).toContain("Measured from Feb 2026 to today.");
    expect(card.windowFrom < PAY_START).toBe(true);
    // …and the row does NOT borrow that window for its own count
    expect(line.paydaysLabel).toBe(`${line.paydays} paydays, Jun 4 – Aug 20`);
    expect(line.paydaysLabel).not.toContain("this window");
  });

  /* One payday is a DAY, not a range. "1 payday, Aug 20 – Aug 20" reads as two
     dates for one event; found by mutation, which collapsed the branch and
     survived every other assertion. */
  test("a single covered payday names one day, not a range", () => {
    // a schedule that starts a week before today has exactly one payday behind it
    addSeries({ nextExpectedOn: "2026-08-20" });
    addTxn("2026-08-20", 100_000);
    coverThrough(CHASE, "2026-08-01", "2026-08-26");

    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.pay[0]!.paydays).toBe(1);
    expect(card.pay[0]!.paydaysLabel).toBe("1 payday, Aug 20");
  });

  /**
   * ⛔ NEGATIVE ZERO. `-0` formats as "-$0.00" while every total stays correct,
   * because `-0 + 0 === 0` — it is invisible to arithmetic and visible only on
   * the page.
   */
  test("a schedule banked exactly on time reports a positive zero difference", () => {
    addSeries();
    // twelve paydays at $1,000, all of them banked
    for (let i = 0; i < 12; i += 1) addTxn(addDays(PAY_START, i * 7), 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-26");

    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.totals.gapCents).toBe(0);
    expect(Object.is(card.totals.gapMagnitudeCents, -0)).toBe(false);
    expect(card.totals.gapLabel).toBe("exactly what this window implies you earned");
    expect(card.summary).toContain("exactly what the confirmed schedule implies");
    expect(card.summary).toContain("Measured from Feb 2026 to today.");
  });

  /**
   * He banks in lumps, so banking MORE than a window implies is ordinary and
   * must read as a magnitude with the other word — never as a negative total.
   */
  test("banking more than the window implies flips the label, not the sign", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    addTxn("2026-06-05", 5_000_000); // a lump covering months of work
    coverThrough(CHASE, "2026-06-01", "2026-08-26");

    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.totals.gapCents).toBeLessThan(0);
    expect(card.totals.gapMagnitudeCents).toBeGreaterThan(0);
    expect(card.totals.gapLabel).toBe("more than this window implies you earned");
    expect(card.summary).toContain("more than the confirmed schedule implies");
  });

  /**
   * The headline is `/budgets`' own figure. Two monthly income rates on one
   * dashboard is a contradiction the reader has to resolve.
   */
  test("the headline is incomeBasis' figure unchanged", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-12");

    const month = periodBounds(TODAY, "monthly");
    const expectation = incomeExpectation(bundle.db, month.start, month.end, TODAY);
    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.monthlyRateCents).toBe(expectation.basis.cents);
    // $1,000 a week annualised, not the four paydays August happens to hold —
    // and the two must differ here, or this test could not tell them apart
    expect(card.monthlyRateCents).toBe(433_333);
    expect(expectation.scheduledCents).not.toBe(card.monthlyRateCents);
  });

  /**
   * ⛔ ONE unchecked landing place is enough to withhold the verdict. A deposit
   * could be sitting in it unseen, and reporting the OTHER account's date would
   * claim the ledger looked everywhere it needed to.
   */
  test("one unverified landing account withholds the date even when another is verified", () => {
    addAccount(SOFI, "SoFi Checking");
    addSeries();
    addTxn(PAY_START, 100_000, { accountId: CHASE });
    addTxn("2026-06-11", 100_000, { accountId: SOFI });
    coverThrough(CHASE, "2026-06-01", "2026-08-12");
    // SoFi has no daily balances at all

    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.checkedThrough).toBeNull();
    expect(line.verdict).toContain("cannot say whether the pay arrived");
  });

  /**
   * A cached balance dated past today has still not been READ against today.
   * Without the clamp `unreadDays` goes negative and the verdict offers to
   * explain a silence with days that have not happened.
   */
  test("coverage running past today is clamped to today", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-09-30");

    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.checkedThrough).toBe(TODAY);
    expect(line.unreadDays).toBe(0);
  });

  /**
   * Unlike the spend cards, this window runs to TODAY. The current month's
   * silence is the thing the card exists to explain and stopping a month short
   * would hide it.
   */
  test("the current, incomplete month is inside the window", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    addTxn("2026-08-13", 25_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-26");

    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.windowFrom).toBe("2026-02-01");
    expect(card.today).toBe(TODAY);
    expect(card.totals.bankedCents).toBe(125_000);
    expect(card.pay[0]!.lastBankedOn).toBe("2026-08-13");
  });

  test("an empty current month is described as unread rather than as unpaid", () => {
    addSeries();
    addTxn(PAY_START, 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-12");

    const card = incomeCard(bundle.db, TODAY)!;
    expect(card.postedThisMonthCents).toBe(0);
    expect(card.postedMonth).toBe("Aug 2026");
    expect(card.postedNote).toContain("what an unimported month looks like");
  });

  test("the caveat against reading a difference as findable money is always published", () => {
    addSeries();
    addTxn(PAY_START, 100_000);

    expect(incomeCard(bundle.db, TODAY)!.caveat).toContain("not money the app has found");
  });

  test("a ledger with no confirmed income series returns null rather than a card of zeroes", () => {
    expect(incomeCard(bundle.db, TODAY)).toBeNull();
  });

  /**
   * A `detected` series is a hypothesis the owner has not agreed to. Implying
   * earnings from a guess is the fabrication this whole module refuses.
   */
  test("an unconfirmed series is not a schedule and returns null", () => {
    addSeries({ status: "detected" });
    addTxn(PAY_START, 100_000);

    expect(incomeCard(bundle.db, TODAY)).toBeNull();
  });

  test("a confirmed series with no attributed deposit returns null", () => {
    addSeries();
    addTxn(PAY_START, 100_000, { seriesId: null });

    expect(incomeCard(bundle.db, TODAY)).toBeNull();
  });

  test("pay arriving on schedule reads as arriving, not as a warning", () => {
    addSeries();
    for (let i = 0; i < 12; i += 1) addTxn(addDays(PAY_START, i * 7), 100_000);
    coverThrough(CHASE, "2026-06-01", "2026-08-26");

    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.basis).toBe("series-live");
    expect(line.verdict).toContain("Pay is arriving");
  });
});
