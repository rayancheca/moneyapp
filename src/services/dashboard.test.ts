import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { dashboardData } from "./dashboard";
import { rebuildAccount } from "./derivation";
import { addDays } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { priceCache } from "@/db/schema/holdings";
import { rebuildInvestmentHistory } from "./crypto-history";
import { upsertHolding } from "./holdings";
import { portfolioOverview } from "./portfolio";

/*
 * Deterministic prices for the investments teaser's fixture. Set at module
 * scope the way `performance-card.test.ts` does — vitest gives each file its own
 * worker, so this cannot leak into another suite, and no other test in this file
 * holds a position.
 */
process.env.MONEYAPP_FAKE_PRICES = "1";

const TODAY = "2026-07-08";

let dir: string;
let bundle: DbBundle;
let checking: string;

function seedSeries(opts: {
  name: string;
  kind: SeriesKind;
  cadence: Cadence;
  nextExpectedOn: string;
  amountCents: number;
  lastMatchedOn: string;
  intervalDaysAvg: number;
}): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind,
      cadence: opts.cadence,
      intervalDaysAvg: opts.intervalDaysAvg,
      nextExpectedOn: opts.nextExpectedOn,
      nextExpectedAmountCents: opts.amountCents,
      amountCentsAvg: opts.amountCents,
      lastMatchedOn: opts.lastMatchedOn,
      status: "confirmed",
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

function spend(desc: string, postedOn: string, amountCents: number) {
  bundle.db
    .insert(transactions)
    .values({
      accountId: checking,
      postedOn,
      amountCents,
      rawDescription: desc,
      normalizedDescription: desc,
      dedupeHash: `${desc}-${postedOn}`,
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-dashboard-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  checking = createAccount(bundle.db, { institutionId: instId, name: "Chase Checking", type: "checking" });
  addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 500_00 });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dashboardData: static drill targets", () => {
  test("review + investments hrefs are wired even with no data", () => {
    const data = dashboardData(bundle.db, TODAY);
    expect(data.reviewHref).toBe("/transactions?view=review");
    expect(data.pace?.href).toBe("/spending");
  });

  /*
   * ⛔ TWO BACKLOGS, TWO COUNTS. The all-clear on this card claimed "every
   * transaction is categorized" from the REVIEW FLAG count. Measured on the
   * real ledger at today = 2026-09-01: 0 flagged, 9 with no category.
   */
  test("the uncategorized backlog is counted apart from the review flag", () => {
    /*
     * ⚠️ `spend()` leaves `category_id` NULL — its first argument is the
     * DESCRIPTION, not a category. Every existing row this fixture makes is
     * therefore uncategorized, which is why a categorized one has to be built
     * by hand here.
     */
    const groceries = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Groceries"))
      .get()!.id;
    bundle.db
      .insert(transactions)
      .values({
        accountId: checking,
        postedOn: "2026-07-02",
        amountCents: -50_00,
        rawDescription: "CATEGORISED",
        normalizedDescription: "CATEGORISED",
        categoryId: groceries,
        dedupeHash: "cat-1",
      })
      .run();
    const data = dashboardData(bundle.db, TODAY);
    expect(data.reviewCount).toBe(0);
    expect(data.uncategorizedCount).toBe(0);
    expect(data.uncategorizedHref).toBe("/transactions?category=uncategorized");

    bundle.db
      .insert(transactions)
      .values({
        accountId: checking,
        postedOn: "2026-07-03",
        amountCents: -12_00,
        rawDescription: "UNCATEGORISED",
        normalizedDescription: "UNCATEGORISED",
        categoryId: null,
        dedupeHash: "uncat-1",
      })
      .run();
    const after = dashboardData(bundle.db, TODAY);
    expect(after.reviewCount).toBe(0); // still nothing FLAGGED…
    expect(after.uncategorizedCount).toBe(1); // …and one row with no category
  });

  test("investments teaser is null without an investment position", () => {
    expect(dashboardData(bundle.db, TODAY).investments).toBeNull();
  });
});

describe("dashboardData: upcoming bills", () => {
  test("lists occurrences in the next 14 days, date-sorted, with per-series hrefs", () => {
    const rent = seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-09", amountCents: -1500_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 });
    const payroll = seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    const netflix = seedSeries({ name: "Netflix", kind: "subscription", cadence: "monthly", nextExpectedOn: "2026-07-20", amountCents: -15_99, lastMatchedOn: "2026-06-20", intervalDaysAvg: 30 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    expect(upcoming.items.map((i) => i.name)).toEqual(["Rent", "Payroll", "Netflix"]);
    expect(upcoming.items.map((i) => i.href)).toEqual([
      `/recurring/${rent}`,
      `/recurring/${payroll}`,
      `/recurring/${netflix}`,
    ]);
    // net = -1500 + 2000 - 15.99
    expect(upcoming.netCents).toBe(-1500_00 + 2000_00 - 15_99);
  });

  test('"before your next paycheck" sums bills due on or before the next income date', () => {
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-09", amountCents: -1500_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 });
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    seedSeries({ name: "Netflix", kind: "subscription", cadence: "monthly", nextExpectedOn: "2026-07-20", amountCents: -15_99, lastMatchedOn: "2026-06-20", intervalDaysAvg: 30 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    // Rent (07-09) is before the paycheck (07-10); Netflix (07-20) is after → excluded
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-07-10", cents: -1500_00 });
  });

  /*
   * ⛔ "ON OR BEFORE" — and only a bill that lands ON payday can say so. Rent
   * and a paycheque routinely share a day (both are 1st-of-month or mid-month
   * anchored), and on the owner's ledger the pay is weekly, so the collision is
   * common rather than exotic. Found by mutation: tightening `<= 0` to `< 0`
   * changed no test, because no fixture bill and paycheque shared a date.
   *
   * The cost is the dashboard understating what he must cover before the money
   * arrives — by a whole rent payment, on the day it matters most.
   */
  test("a bill due ON the paycheck day is counted before it, not after", () => {
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-10", amountCents: -1500_00, lastMatchedOn: "2026-06-10", intervalDaysAvg: 30 });
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-07-10", cents: -1500_00 });
  });

  /*
   * ⛔ THE HEADING AND THE LIST DESCRIBE ONE WINDOW. `UpcomingBillsStrip`
   * prints "next {windowDays} days" beside the rows the query returned, and
   * nothing tied the two together: widening the query alone changed no test.
   * That is precisely this session's `section-notes` defect — a count from one
   * set standing over another.
   */
  test("the window the heading names is the window the rows come from", () => {
    seedSeries({ name: "Edge", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-21", amountCents: -10_00, lastMatchedOn: "2026-06-21", intervalDaysAvg: 30 });
    seedSeries({ name: "Beyond", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-22", amountCents: -20_00, lastMatchedOn: "2026-06-22", intervalDaysAvg: 30 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    // today is day one, so a 14-day window's last day is 2026-07-21
    expect(upcoming.windowDays).toBe(14);
    expect(upcoming.items.map((i) => i.name)).toContain("Edge");
    expect(upcoming.items.map((i) => i.name)).not.toContain("Beyond");
    // and every row really is inside the window the heading names
    const last = addDays(TODAY, upcoming.windowDays - 1);
    expect(upcoming.items.every((i) => i.date >= TODAY && i.date <= last)).toBe(true);
  });

  test("no income series → no before-paycheck line", () => {
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-09", amountCents: -1500_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 });
    expect(dashboardData(bundle.db, TODAY).upcoming.beforePaycheck).toBeNull();
  });

  test("recurring TRANSFERS are net-worth-neutral: excluded from items and before-paycheck", () => {
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    // an auto-transfer to savings: a negative leg due BEFORE the paycheck
    seedSeries({ name: "To Savings", kind: "transfer", cadence: "biweekly", nextExpectedOn: "2026-07-09", amountCents: -500_00, lastMatchedOn: "2026-06-25", intervalDaysAvg: 14 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    // the transfer is neither a "bill due" nor counted before the paycheck
    expect(upcoming.items.map((i) => i.name)).not.toContain("To Savings");
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-07-10", cents: 0 });
  });
});

describe("dashboardData: spending pace", () => {
  test("cumulative actual is null after today; the ideal line ends near the projection", () => {
    spend("Groceries", "2026-07-02", -50_00);
    spend("Gas", "2026-07-05", -30_00);
    const { pace } = dashboardData(bundle.db, TODAY);
    expect(pace).not.toBeNull();
    // one point per day of July
    expect(pace!.points).toHaveLength(31);
    // days the ledger has read carry a cumulative number; later days are null
    const beforeToday = pace!.points.filter((p) => p.actualCents !== null);
    expect(beforeToday.length).toBeGreaterThan(0);
    expect(pace!.points.at(-1)!.actualCents).toBeNull();
    // cumulative actuals never go backwards — spend buckets exclude refunds
    const actuals = beforeToday.map((p) => p.actualCents!);
    for (let i = 1; i < actuals.length; i++) expect(actuals[i]!).toBeGreaterThanOrEqual(actuals[i - 1]!);
    expect(pace!.actualToDateCents).toBe(80_00);
  });

  /*
   * ⛔ TODAY IS PART OF "SO FAR". The pace line marks a bucket as past with
   * `b.from <= today`; with `<` today's cumulative point disappears every day,
   * and on the FIRST of a month every point becomes null — the actual-spend
   * line vanishes from the dashboard entirely while the projection still draws.
   * Found by mutation; nothing asserted the count of non-null points.
   *
   * ⚠️ The ledger has to OPEN by the 1st for the 1st to be drawn: a day before
   * the records begin carries no running total (see the staircase test below).
   */
  test("today's bucket is part of the line, and the 1st of a month still draws one", () => {
    spend("Coffee", "2026-07-01", -5_00);
    spend("Groceries", "2026-07-08", -25_00); // today
    const { pace } = dashboardData(bundle.db, TODAY);
    // eight days of July have passed, today included
    expect(pace!.points.filter((p) => p.actualCents !== null)).toHaveLength(8);
    expect(pace!.points[7]!.actualCents).toBe(30_00);

    // and on the 1st, exactly one point is drawn rather than none — and the row
    // dated the 8th, a week after that "today", does not pull a step onto a day
    // that has not happened (to the graph a bucket holding a row is a figure)
    const firstOfMonth = dashboardData(bundle.db, "2026-07-01").pace!;
    expect(firstOfMonth.points.filter((p) => p.actualCents !== null)).toHaveLength(1);
  });

  /*
   * 🔴 THE STAIRCASE RAN FLAT THROUGH DAYS ITS OWN TEXT SAYS ARE NOT IMPORTED.
   * The tile marked a bucket drawn by `b.from <= today`, so the last total read
   * was held level across every elapsed day after it — while the words beside
   * it said "at least" and "3 days of September 2026 not imported yet". /spending's
   * graph lens ends its running totals at the frontier (`plottedRunningTotals`);
   * the tile was the second surface drawing a cumulative line, and it did not.
   * Measured on the owner's ledger 2026-09-15 (newest row 2026-09-12): Sep 13,
   * 14 and 15 at $1,431.05, all `after-records`. On the e2e fixture (fake today
   * 2026-07-08, newest row 2026-07-04): Jul 5–8 at $2,607.01.
   *
   * ⛔ Both ends: a day before the records begin is not a $0 day either.
   */
  test("the staircase stops where the ledger does, at both ends", () => {
    spend("Groceries", "2026-07-02", -80_00);
    spend("Gas", "2026-07-04", -30_00);
    const { pace } = dashboardData(bundle.db, TODAY);
    // Jul 1 is before the records begin; Jul 5–8 have passed and are not imported yet
    expect(pace!.points.slice(0, 9).map((p) => p.actualCents)).toEqual([
      null, 80_00, 80_00, 110_00, null, null, null, null, null,
    ]);
    // the undrawn days past Jul 4 are the four the text counts; Jul 1 is not
    // counted there, because it is not "not imported yet" (`daysNotImportedYet`)
    expect(pace!.uncoveredDays).toBe(4);
    // the figures beside it do not move
    expect(pace!.actualToDateCents).toBe(110_00);
  });

  test("free-to-spend = full-month income minus spend-so-far and upcoming fixed bills", () => {
    spend("Groceries", "2026-07-02", -80_00);
    // one biweekly paycheck stream (07-10, 07-24 within the month) + one fixed bill
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-12", amountCents: -1500_00, lastMatchedOn: "2026-06-12", intervalDaysAvg: 30 });

    const { pace } = dashboardData(bundle.db, TODAY);
    // income: 2 × 2000 remaining; spend so far: 80; upcoming fixed bill: 1500
    // free = 4000 - 80 - 1500 = 2420
    expect(pace!.freeToSpendCents).toBe(2420_00);
    // the newest row here is 2026-07-02 against a today of the 8th, so six of
    // the eight elapsed days are unimported — the figure still stands, because
    // part of the window IS measured, and the widget says how much is not
    expect(pace!.uncoveredDays).toBe(6);
  });

  /*
   * 🔴 THE TILE ASSERTED "$0.00 spent" OVER DAYS NOTHING HAD BEEN IMPORTED FOR.
   *
   * /budgets already refuses to grade those days — "Their spend and percentages
   * are lower bounds, not measurements, so no verdict is shown for them" — and
   * the income card says the same thing in words: "An empty month is what an
   * unimported month looks like as well as what an unpaid one looks like." The
   * dashboard's spending tile was the surface that did not ask.
   *
   * Measured on the real ledger, whose newest active row is 2026-08-24:
   *
   *     today = 2026-09-01   0 of 1 elapsed days imported → "$0.00 spent"
   *     today = 2026-09-20   0 of 20 elapsed days imported → "$0.00 spent",
   *                          "$0.00 projected", "≈ $947.00 free to spend"
   *
   * Twenty days into a month with nothing imported, the tile read as a
   * measurement of a month in which he had spent nothing.
   *
   * ⚠️ Unreachable in e2e: every account in the fixture is imported through
   * E2E_FAKE_TODAY, so all 8 elapsed days are covered and this branch cannot
   * render in any of the 590 pixel tests.
   */
  describe("days the ledger has not reached", () => {
    test("counts the elapsed days no import covers", () => {
      spend("Groceries", "2026-07-02", -80_00);
      // newest active row is 2026-07-02; today is the 8th
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.uncoveredDays).toBe(6);
      // …and the figure still stands, because part of the window IS measured
      expect(pace!.freeToSpendCents).not.toBeNull();
      expect(pace!.actualToDateCents).toBe(80_00);
    });

    test("a month with nothing imported at all has no free-to-spend figure", () => {
      // every row is in a PREVIOUS month: July is entirely unimported
      spend("Groceries", "2026-06-20", -80_00);
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.uncoveredDays).toBe(8); // all eight elapsed days of July
      /*
       * ⛔ null, not 0. "$0.00 spent, so you have $X free" is a claim about a
       * month nobody has looked at. The em dash is the same refusal
       * `dayChangeLabel` makes for a portfolio with no prior close — an
       * omission costs no information, an assertion costs the truth.
       */
      expect(pace!.freeToSpendCents).toBeNull();
      expect(pace!.actualToDateCents).toBe(0);
    });

    /*
     * 🔴 S32: a statement that closes after the newest charge is an import of
     * its quiet days too. Measured 2026-09-14: newest active row Sep 12, Venture
     * X's statement closes Sep 13, and the tile read "2 days of September 2026
     * not imported yet" beside MoversCard's "Venture X imported through Sep 13".
     *
     * ⚠️ The fixture above holds NO statement periods, so until this test it
     * could not express the case at all.
     */
    test("a statement that closes after the newest row covers its quiet days", () => {
      spend("Groceries", "2026-07-02", -80_00);
      const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
      const now = new Date().toISOString();
      bundle.db
        .insert(importFiles)
        .values({
          id: "stmt-1",
          fileName: "20260705-statements.pdf",
          fileSha256: "sha-stmt-1",
          format: "pdf",
          institutionId: instId,
          parserVersion: 1,
          status: "parsed",
          storagePath: "/tmp/20260705-statements.pdf",
          importedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      bundle.db
        .insert(statementPeriods)
        .values({
          id: "period-1",
          importFileId: "stmt-1",
          accountId: checking,
          periodStart: "2026-06-06",
          periodEnd: "2026-07-05",
          reconciliation: "reconciled",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const { pace } = dashboardData(bundle.db, TODAY);
      // Jul 6, 7 and 8 — not Jul 3, 4 and 5, which the statement covers
      expect(pace!.uncoveredDays).toBe(3);
    });

    test("an import that reaches today leaves nothing uncovered", () => {
      spend("Groceries", TODAY, -80_00);
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.uncoveredDays).toBe(0);
      expect(pace!.freeToSpendCents).not.toBeNull();
    });
  });
});

describe("dashboardData: net worth summary", () => {
  test("reflects the anchored balance as the latest point", () => {
    const { netWorth } = dashboardData(bundle.db, TODAY);
    // the $500 anchor carries forward to the real "today" as the latest point
    expect(netWorth.latestCents).toBe(500_00);
    expect(netWorth.assetsCents).toBe(500_00);
    expect(netWorth.liabilitiesCents).toBe(0);
    expect(netWorth.asOf).not.toBeNull();
    expect(netWorth.series.length).toBeGreaterThan(0);
    expect(netWorth.inTransitCents).toBe(0);
  });

  test("a float covering the latest day is surfaced so the hero can explain the headline", () => {
    // the doc's sparse-coverage case (docs/inflight-dips.md): the receiver's
    // stale curve never restates the arrival, so the bridge reaches today —
    // latestCents includes it while assets/liabilities (stored) do not, and
    // inTransitCents is the number the hero must speak
    const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "SoFi")).get()!.id;
    const receiver = createAccount(bundle.db, { institutionId: instId, name: "SoFi Savings", type: "savings" });
    addManualAnchor(bundle.db, { accountId: receiver, anchoredOn: "2026-06-01", enteredCents: 100_00 });
    const leg = (accountId: string, postedOn: string, amountCents: number) =>
      bundle.db
        .insert(transactions)
        .values({
          accountId,
          postedOn,
          amountCents,
          rawDescription: `LEG-${amountCents}`,
          normalizedDescription: `LEG-${amountCents}`,
          transferGroupId: "float-1",
          dedupeHash: `LEG-${amountCents}-${postedOn}`,
        })
        .run();
    leg(checking, "2026-07-02", -50_00);
    leg(receiver, "2026-07-20", 50_00); // posted past the receiver's coverage
    rebuildAccount(bundle.db, checking, TODAY);
    rebuildAccount(bundle.db, receiver, "2026-06-01"); // stale — never restates

    const { netWorth } = dashboardData(bundle.db, TODAY);
    expect(netWorth.inTransitCents).toBe(50_00);
    const last = netWorth.series.at(-1)!;
    expect(last.inTransitCents).toBe(50_00);
    // bridged headline = stored assets − liabilities + the in-transit money
    expect(netWorth.latestCents).toBe(netWorth.assetsCents - netWorth.liabilitiesCents + 50_00);
  });
});

/*
 * ⛔ `investmentsTeaser` HAD NO UNIT COVERAGE AT ALL.
 *
 * Found by mutation audit: two independent edits to `services/dashboard.ts`
 * changed nothing anywhere in the suite —
 *
 *   `portfolioSeries(db).slice(-SPARKLINE_DAYS)` → `.slice(0, SPARKLINE_DAYS)`
 *       the card draws the OLDEST thirty days instead of the newest, so the
 *       line beside "today's move" describes a month that ended long ago;
 *   `dayChangeTerm(overview.asOf, overview.dayChangeVsDay, …)` → the two dates
 *       swapped, so the phrase names the interval backwards.
 *
 * ⚠️ The second is this session's first defect wearing a different coat. The
 * whole point of `dayChangeTerm` is that a figure names the days it was
 * measured between; naming them in the wrong order is the same lie in a
 * different tense, and the e2e fixture cannot see it — every price there is
 * quoted through `E2E_FAKE_TODAY`, so the term is always the literal "today"
 * and the interval branch never renders.
 */
describe("dashboardData: the investments teaser", () => {
  /** `price_cache.close` is a per-share DOLLAR price; one share is worth 100× it in cents. */
  const cache = (symbol: string, day: string, close: number): void => {
    bundle.db
      .insert(priceCache)
      .values({ symbol, assetType: "stock", quotedOn: day, close, source: "yahoo", fetchedAt: `${day}T20:00:00.000Z` })
      .run();
  };

  const hold = (day: string, symbol: string, quantityE8: number, avgCostCents: number): void => {
    upsertHolding(bundle.db, {
      accountId: brokerage(),
      symbol,
      assetType: "stock",
      quantityE8,
      avgCostCents,
      occurredOn: day,
    });
  };

  let brokerageId: string | null = null;
  const brokerage = (): string => {
    if (brokerageId === null) {
      const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
      brokerageId = createAccount(bundle.db, {
        institutionId: rh.id,
        name: "Robinhood Brokerage",
        type: "investment",
        subtype: "brokerage",
      });
    }
    return brokerageId;
  };

  beforeEach(() => {
    brokerageId = null;
  });

  /**
   * 40 daily closes ending 2026-07-06 — two days BEFORE today on purpose, so
   * the "today" branch of the term is not the one under test. One share, so the
   * portfolio's value in cents is the close itself and every point is
   * recognisable by eye.
   */
  const seedFortyDays = (): { days: string[]; closes: number[] } => {
    const days: string[] = [];
    const closes: number[] = [];
    for (let i = 39; i >= 0; i--) {
      const day = addDays("2026-07-06", -i);
      const close = 1_000 + (39 - i); // dollars, strictly rising, all distinct
      days.push(day);
      closes.push(close);
      cache("AAPL", day, close);
    }
    hold(days[0]!, "AAPL", 100_000_000, 90_000);
    rebuildInvestmentHistory(bundle.db, brokerage(), "2026-07-06");
    return { days, closes };
  };

  test("returns null when there is no portfolio at all", () => {
    expect(dashboardData(bundle.db, TODAY).investments).toBeNull();
  });

  /*
   * ⛔ TWO reasons the card is withheld, and only one of them is "no account".
   * A book that has been sold down to nothing still has an `asOf` — every price
   * it was ever marked at is still cached — so the value guard is the one doing
   * the work here. Without it the dashboard prints a card headlined $0.00 with
   * an empty sparkline, which is the shape the guard's own comment rejects: a
   * card of zeroes is worse than no card.
   */
  test("a book sold down to nothing is withheld, not headlined as $0.00", () => {
    for (let i = 2; i >= 0; i--) cache("AAPL", addDays("2026-07-06", -i), 1_000);
    hold("2026-07-04", "AAPL", 100_000_000, 90_000);
    hold("2026-07-06", "AAPL", 0, 90_000); // sold out
    rebuildInvestmentHistory(bundle.db, brokerage(), "2026-07-06");

    const overview = portfolioOverview(bundle.db);
    expect(overview.asOf).not.toBeNull(); // it HAS a history…
    expect(overview.valueCents).toBe(0); // …and it is worth nothing
    expect(dashboardData(bundle.db, TODAY).investments).toBeNull();
  });

  test("the sparkline is the NEWEST 30 days, ending on the value the headline shows", () => {
    const { closes } = seedFortyDays();
    const teaser = dashboardData(bundle.db, TODAY).investments!;

    expect(teaser.sparkline).toHaveLength(30);
    // the last point IS the headline, not a number from a month ago
    expect(teaser.sparkline.at(-1)).toBe(teaser.valueCents);
    expect(teaser.sparkline.at(-1)).toBe(closes.at(-1)! * 100);
    // …and the first point is the 30th day back, not the 40th
    expect(teaser.sparkline[0]).toBe(closes[closes.length - 30]! * 100);
    expect(teaser.sparkline).not.toContain(closes[0]! * 100); // the oldest day is OUT
  });

  test("the term names the two days in the order they happened, newest first", () => {
    seedFortyDays();
    const teaser = dashboardData(bundle.db, TODAY).investments!;

    // the newest close is 2026-07-06 and today is the 8th, so this is NOT today
    expect(teaser.dayChangeTerm).not.toBe("today");
    const [newer, older] = teaser.dayChangeTerm.split(" vs ");
    expect(newer).toBe(formatDayShort("2026-07-06"));
    expect(older).toBe(formatDayShort("2026-07-05"));
    // and the figure it names really is the move between those two closes: $1
    expect(teaser.dayChangeCents).toBe(100);
  });

  test("a portfolio priced through today says the word, and names no dates", () => {
    for (let i = 2; i >= 0; i--) cache("AAPL", addDays(TODAY, -i), 1_000 + (2 - i));
    hold(addDays(TODAY, -2), "AAPL", 100_000_000, 90_000);
    rebuildInvestmentHistory(bundle.db, brokerage(), TODAY);

    const teaser = dashboardData(bundle.db, TODAY).investments!;
    expect(teaser.dayChangeTerm).toBe("today");
    expect(teaser.dayChangeTerm).not.toContain("vs");
  });

  /*
   * ⚠️ ONE EQUIVALENT MUTANT, RECORDED RATHER THAN PAPERED OVER.
   * `dayChangeExact: true` in place of `overview.dayChangeExact` survives, and
   * it survives because it is currently true by construction: `buildPortfolio`
   * writes `flowByDay.set(day, { flowCents, exact: true })` unconditionally
   * (portfolio.ts:169) and nothing else ever sets it false, so the "≈" the
   * teaser renders for an estimated move cannot be reached from any fixture.
   * A test for it would assert the fixture back to itself. If a producer ever
   * marks a day inexact, this is the assertion to add.
   */

  /**
   * The mover is the biggest move by MAGNITUDE across winners and losers, not
   * the biggest winner. A 4% fall matters more than a 1% rise, and the card has
   * room for exactly one.
   */
  test("the top mover is the largest by magnitude, loser or winner", () => {
    for (let i = 1; i >= 0; i--) {
      cache("AAPL", addDays("2026-07-06", -i), i === 1 ? 10_000 : 10_100); // +1%
      cache("TSLA", addDays("2026-07-06", -i), i === 1 ? 10_000 : 9_600); // −4%
    }
    hold("2026-07-05", "AAPL", 100_000_000, 9_000);
    hold("2026-07-05", "TSLA", 100_000_000, 9_000);
    rebuildInvestmentHistory(bundle.db, brokerage(), "2026-07-06");

    const teaser = dashboardData(bundle.db, TODAY).investments!;
    expect(teaser.topMover?.symbol).toBe("TSLA");
    expect(teaser.topMover?.dayChangePct).toBeLessThan(0);
    expect(teaser.topMover?.href).toBe("/investments/stock/TSLA");
  });
});
