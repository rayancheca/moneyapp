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
import { resolvePeriod } from "@/lib/period";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { bulkApply } from "./bulk-edit";
import { checkedThrough as checkedThroughFixture } from "./checked-days-fixture";
import { dashboardData } from "./dashboard";
import { cashFlowByPeriod } from "./spending";
import { rebuildAccount } from "./derivation";
import { provenanceFor } from "./provenance";
import { addDays } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { passedPaydaysWords } from "@/lib/unbanked-income";
import { forecastCurrentMonth } from "./forecast";
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

function spend(desc: string, postedOn: string, amountCents: number, accountId: string = checking) {
  bundle.db
    .insert(transactions)
    .values({
      accountId,
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

  test('"due by your next paycheck" sums bills due on or before the next income date', () => {
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
   * arrives — by a whole rent payment, on the day it matters most. Named in the
   * strip's own word since 06801fc: "due BY your next paycheck".
   */
  test("a bill due ON the paycheck day is due by it — counted, not left for after the pay", () => {
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

  test('no income series → no "due by your next paycheck" line', () => {
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-09", amountCents: -1500_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 });
    expect(dashboardData(bundle.db, TODAY).upcoming.beforePaycheck).toBeNull();
  });

  test("recurring TRANSFERS are net-worth-neutral: excluded from items and from what is due by the paycheck", () => {
    seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    // an auto-transfer to savings: a negative leg due BEFORE the paycheck
    seedSeries({ name: "To Savings", kind: "transfer", cadence: "biweekly", nextExpectedOn: "2026-07-09", amountCents: -500_00, lastMatchedOn: "2026-06-25", intervalDaysAvg: 14 });

    const { upcoming } = dashboardData(bundle.db, TODAY);
    // the transfer is neither a "bill due" nor counted in what is due by the paycheck
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
    // with ONE account the undrawn days past Jul 4 are the four the text counts; Jul 1 is not counted there, because it
    // is not "not imported yet" (`daysNotImportedYet`) — with two, see the next test
    expect(pace!.partlyRead?.uncoveredDays).toBe(4);
    // the figures beside it do not move
    expect(pace!.actualToDateCents).toBe(110_00);
  });

  /*
   * ⚠️ …and with MORE THAN ONE ACCOUNT the staircase and the text stop on different days, by design. The line is drawn
   * through the newest day ANY account reached (`ledgerReaches`, /spending's graph lens: `plottedRunningTotals`); the
   * text counts from the day EVERY account he spends from reached (`spendingReadThrough`, decision 72), and its figures
   * are lower bounds. 🔴 The test above claimed "the undrawn days are the ones the text counts", true only of one account
   * (review of the pace card, batch 4/5). On his ledger copy 2026-10-21 the tile draws Oct 1–14 (Venture X, Oct 14),
   * the "measuring stops" marker on Oct 14 at $1,603.00, under "spending imported through Aug 12 · 21 days of this period
   * unaccounted" — Chase Checking read through Aug 12.
   */
  test("with two accounts the staircase runs to the newer one's day; the text counts from the older one's", () => {
    const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
    const card = createAccount(bundle.db, { institutionId: instId, name: "Venture X", type: "credit" });
    spend("Groceries", "2026-07-02", -80_00);
    spend("Gas", "2026-07-05", -30_00, card);
    const { pace } = dashboardData(bundle.db, TODAY);
    expect(pace!.points.slice(0, 9).map((p) => p.actualCents)).toEqual([
      null, 80_00, 80_00, 80_00, 110_00, null, null, null, null,
    ]);
    // drawn through Jul 5, counted from Jul 2: Jul 3 – 5 are drawn AND unaccounted
    expect(pace!.partlyRead).toEqual({
      uncoveredDays: 6,
      line: "spending imported through Jul 2 · 6 days of this period unaccounted",
    });
  });

  test("free-to-spend = full-month income minus spend-so-far and upcoming fixed bills", () => {
    spend("Groceries", "2026-07-02", -80_00);
    // one biweekly paycheck stream (07-10, 07-24 within the month) + one fixed bill
    const pay = seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
    seedSeries({ name: "Rent", kind: "bill", cadence: "monthly", nextExpectedOn: "2026-07-12", amountCents: -1500_00, lastMatchedOn: "2026-06-12", intervalDaysAvg: 30 });
    // ⚖️ §6A 68: the pay lands in checking, checked through Jul 2 — so July's $0.00 posted is a term. A schedule naming no
    // account lands nowhere the ledger has looked, and the figure waits for income ("a month whose income …" below)
    bundle.db.update(recurringSeries).set({ accountId: checking }).where(eq(recurringSeries.id, pay)).run();
    checkedThroughFixture(bundle.db, checking, "2026-07-02");

    const { pace } = dashboardData(bundle.db, TODAY);
    // income: 2 × 2000 remaining; spend so far: 80; upcoming fixed bill: 1500
    // free = 4000 - 80 - 1500 = 2420
    expect(pace!.freeToSpendCents).toBe(2420_00);
    // the newest row here is 2026-07-02 against a today of the 8th, so six of
    // the eight elapsed days are unimported — the figure still stands, because
    // part of the window IS measured, and the widget says how much is not
    expect(pace!.partlyRead?.uncoveredDays).toBe(6);
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
      expect(pace!.partlyRead?.uncoveredDays).toBe(6);
      // …and the figure still stands, because part of the window IS measured
      expect(pace!.freeToSpendCents).not.toBeNull();
      expect(pace!.actualToDateCents).toBe(80_00);
    });

    test("a month with nothing imported at all has no free-to-spend figure", () => {
      // every row is in a PREVIOUS month: July is entirely unimported
      spend("Groceries", "2026-06-20", -80_00);
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.partlyRead?.uncoveredDays).toBe(8); // all eight elapsed days of July
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
      expect(pace!.partlyRead?.uncoveredDays).toBe(3);
    });

    test("an import that reaches today leaves nothing uncovered", () => {
      spend("Groceries", TODAY, -80_00);
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.partlyRead).toBeNull();
      expect(pace!.freeToSpendCents).not.toBeNull();
    });
  });

  /*
   * ⚖️ His decision 72 (2026-10-13): a total over days not every account is read for is "partly read", with /budgets'
   * line under it. 🔴 Measured on his ledger copy 2026-10-21: the tile read "at least $1,603.00 spent · 7 days of
   * October 2026 not imported yet" — Oct 15–21, the days NO account has read (Venture X reaches Oct 14) — with no chip,
   * while /spending, one click away, read "partly read" and "spending imported through Aug 12 · 21 days of this period
   * unaccounted": Chase Checking and Wells Fargo have read no day of October. The tile now counts by /spending's proof.
   */
  describe("a month not every account he spends from has read", () => {
    function closeStatement(accountId: string, periodStart: string, periodEnd: string): void {
      const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
      const now = new Date().toISOString();
      const id = `${accountId}-${periodEnd}`;
      bundle.db
        .insert(importFiles)
        .values({
          id,
          fileName: `${periodEnd}-statement.pdf`,
          fileSha256: `sha-${id}`,
          format: "pdf",
          institutionId: instId,
          parserVersion: 1,
          status: "parsed",
          storagePath: `/tmp/${id}.pdf`,
          importedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      bundle.db
        .insert(statementPeriods)
        .values({
          id: `period-${id}`,
          importFileId: id,
          accountId,
          periodStart,
          periodEnd,
          reconciliation: "reconciled",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    function card(): string {
      const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
      return createAccount(bundle.db, { institutionId: instId, name: "Venture X", type: "credit" });
    }

    test("counts the days /spending counts, wears its chip, and keeps the figures it found as lower bounds", () => {
      spend("Rent", "2026-06-20", -900_00); // checking: read through Jun 20, no day of July
      const venture = card();
      spend("Groceries", "2026-07-03", -25_00, venture);
      spend("Coffee", TODAY, -5_00, venture); // the card reaches today, so no day is unread by EVERY account

      const { pace } = dashboardData(bundle.db, TODAY);
      // every elapsed day of July: checking has read none of them
      expect(pace!.partlyRead).toEqual({
        uncoveredDays: 8,
        line: "spending imported through Jun 20 · 8 days of this period unaccounted",
      });
      expect(pace!.provenance?.verdict).toBe("partly_read");
      // ⛔ one proof for one window: /spending's own, asked of the same month on the same day — its line is the tile's
      const july = { from: "2026-07-01", to: "2026-07-31", label: "July 2026", today: TODAY };
      expect(provenanceFor(bundle.db, { kind: "allSpend", ...july })).toEqual(pace!.provenance);
      expect(pace!.provenance?.partlyRead).toEqual(pace!.partlyRead);
      // $30.00 was found, so the figures stand — as the lower bounds the chip says they are
      expect(pace!.actualToDateCents).toBe(30_00);
      expect(pace!.freeToSpendCents).not.toBeNull();
      expect(pace!.spendingNotFound).toBeNull();
    });

    /*
     * ⚖️ Decision 64 (2026-10-12), asked of the window /spending's Spent card asks it of
     * (`CashFlow.spendingUnaccounted`): no spending found and not one elapsed day read by the day every account he
     * spends from is read through is no "$0.00 spent". The card's statement reads Jul 1–5, so the ledger reaches Jul 5
     * and the old count (3 days) let "≈ $X free to spend" stand over a July checking has not been read for at all.
     */
    test("no spending found past that day is a dash, in /spending's words", () => {
      spend("Rent", "2026-06-20", -900_00);
      const venture = card();
      spend("Groceries", "2026-06-10", -25_00, venture);
      closeStatement(venture, "2026-06-06", "2026-07-05");

      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.freeToSpendCents).toBeNull();
      expect(pace!.spendingNotFound).toBe("spending imported through Jun 20");
      // no proof is built beside the dash — the tile mounts none there (see the next test)
      expect(pace!.provenance).toBeNull();
    });

    /*
     * ⛔ The month's proof proves a rendered figure, so it is built only beside one. 🔴 It was built on every render —
     * 18.4 ms a proof against 419 ms for the whole dashboard on his ledger copy (review of the pace card, batch 4/5) —
     * even where the figure is withheld and the tile never mounts its chip. Latent on his copy 2026-10-21: October's
     * figure stands ($1,603.00 found), so the proof is still built there.
     */
    test("the month's proof is built beside a figure, never beside the dash", () => {
      spend("Groceries", "2026-06-20", -80_00); // July is entirely unimported
      expect(dashboardData(bundle.db, TODAY).pace!.provenance).toBeNull();
      spend("Coffee", "2026-07-02", -5_00);
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.freeToSpendCents).not.toBeNull();
      expect(pace!.provenance?.verdict).toBe("partly_read");
    });
  });

  /*
   * ⚖️ §6A 68 — no Income, no Free to spend: the figure is `earned + fixed income still due − spent − fixed bills still
   * due`, and a month's posted income nobody has looked for (`CashFlow.incomeUnread`, the rule the dashboard's own Income
   * card dashes by) is no term to add. The spending figures under it were found, and stand. 🔴 On his ledger copy
   * 2026-10-21 the tile read "Free to spend ≈ −$2,839.14" — $0.00 + $2,283.84 − $1,603.00 − $3,519.98 — beside an Income
   * card reading "—", Wells Fargo checked through Sep 24; the three paydays Oct 1, 8 and 15 ($3,425.76) were in neither
   * leg, and with them banked it reads +$586.62 (review of 6cb97ea).
   */
  describe("a month whose income nobody has looked for", () => {
    /** his pay lands in an account of its own (his Wells Fargo), checked through `checkedThrough`; he spends from Chase */
    function payLandsInChecking(checkedThrough: string): void {
      const pay = seedSeries({ name: "Payroll", kind: "income", cadence: "biweekly", nextExpectedOn: "2026-07-10", amountCents: 2000_00, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 });
      const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
      const wells = createAccount(bundle.db, { institutionId: instId, name: "Wells Fargo", type: "checking" });
      bundle.db.update(recurringSeries).set({ accountId: wells }).where(eq(recurringSeries.id, pay)).run();
      checkedThroughFixture(bundle.db, wells, checkedThrough);
    }

    test("Free to spend waits for income; what was spent, its proof and its line stand", () => {
      spend("Groceries", "2026-07-02", -80_00);
      payLandsInChecking("2026-06-30");
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.freeToSpendCents).toBeNull();
      expect(pace!.waitsForIncome).toBe(true);
      expect(pace!.spendingNotFound).toBeNull();
      expect(pace!.actualToDateCents).toBe(80_00);
      expect(pace!.provenance).not.toBeNull();
    });

    test("one day of the month checked where the pay lands makes its $0.00 a term: the figure stands", () => {
      spend("Groceries", "2026-07-02", -80_00);
      payLandsInChecking("2026-07-01");
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.waitsForIncome).toBe(false);
      expect(pace!.freeToSpendCents).toBe(4000_00 - 80_00);
    });

    // ⛔ the one rule: /spending's reading of the same month, never a second one
    test("the tile waits exactly where /spending's Income card dashes", () => {
      spend("Groceries", "2026-07-02", -80_00);
      payLandsInChecking("2026-06-30");
      const july = resolvePeriod({}, TODAY);
      const { incomeUnread } = cashFlowByPeriod(bundle.db, july, TODAY);
      expect(incomeUnread).toBe(true);
      expect(dashboardData(bundle.db, TODAY).pace!.waitsForIncome).toBe(incomeUnread);
    });

    // …and where the month's spending is no figure either, the tile says spending's words, as it did
    test("a month whose spending is not found either keeps spending's dash and words", () => {
      spend("Groceries", "2026-06-20", -80_00);
      payLandsInChecking("2026-06-30");
      const { pace } = dashboardData(bundle.db, TODAY);
      expect(pace!.freeToSpendCents).toBeNull();
      expect(pace!.waitsForIncome).toBe(false);
      expect(pace!.provenance).toBeNull();
    });

    // ⛔ beside the dash it names nothing: a figure withheld leaves nothing out, and "until income is found" says why
    test("a payday nobody has looked for is not named beside the dash", () => {
      spend("Groceries", "2026-07-02", -80_00);
      payLandsInChecking("2026-06-30");
      const { pace } = dashboardData(bundle.db, "2026-07-13"); // Jul 10's payday has passed
      expect(pace!.freeToSpendCents).toBeNull();
      expect(pace!.waitsForIncome).toBe(true);
      expect(pace!.paydaysLeftOut).toBeNull();
    });
  });

  /*
   * 🔴 FREE TO SPEND LEFT OUT A PAYDAY NOBODY HAD LOOKED FOR, AND SAID NOTHING (review of a5ce8b15, MEDIUM). Its
   * income is the month's posted income (through today) plus the forecast's fixed income still to come (from today),
   * so a payday between the pay account's last checked day and today is in neither leg: weekly $1,000 found Jul 2, its
   * account checked through Jul 2, read $4,920.00 on Jul 8 and on the payday Jul 9, and $3,920.00 on Jul 10 — under
   * only spending's "spending imported through Jul 2 · 8 days of this period unaccounted". Nothing said Jul 9 was
   * never looked for, while the dashboard's Earned vs banked said so of the same payday. On a copy of today's trial
   * import of his Wells Fargo statement (checked through Mon Oct 26), filed, Oct 29's $1,141.92 leaves both legs on
   * Oct 30: ≈ $734.74 on Oct 29, ≈ −$407.18 on Oct 30 and 31.
   */
  describe("a payday after the day its pay's account is checked through", () => {
    /**
     * weekly $1,000 into an account of its own (his Wells Fargo) — Jul 2's found and attached, the account checked
     * through `checkedThrough`; he spends $80 from Chase. (Not into Chase: its anchor on Jul 8 checks it through
     * Jul 8.)
     */
    function weeklyPayFoundJul2(checkedThrough: string): { pay: string; wells: string } {
      const pay = seedSeries({ name: "Payroll", kind: "income", cadence: "weekly", nextExpectedOn: "2026-07-09", amountCents: 1000_00, lastMatchedOn: "2026-07-02", intervalDaysAvg: 7 });
      const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
      const wells = createAccount(bundle.db, { institutionId: instId, name: "Wells Fargo", type: "checking" });
      bundle.db.update(recurringSeries).set({ accountId: wells }).where(eq(recurringSeries.id, pay)).run();
      const salary = bundle.db.select().from(categories).where(eq(categories.name, "Salary")).get()!.id;
      bundle.db
        .insert(transactions)
        .values({
          accountId: wells,
          postedOn: "2026-07-02",
          amountCents: 1000_00,
          rawDescription: "Payroll",
          normalizedDescription: "Payroll",
          dedupeHash: "Payroll-2026-07-02",
          categoryId: salary,
          recurringSeriesId: pay,
        })
        .run();
      checkedThroughFixture(bundle.db, wells, checkedThrough);
      spend("Groceries", "2026-07-02", -80_00);
      return { pay, wells };
    }

    /** an unfiled credit, then filed Income › `category` from the review queue — the category picker's write */
    function filedFromTheReviewQueue(accountId: string, postedOn: string, amountCents: number, category: string): string {
      const id = bundle.db
        .insert(transactions)
        .values({
          accountId,
          postedOn,
          amountCents,
          rawDescription: `CREDIT ${postedOn}`,
          normalizedDescription: `CREDIT ${postedOn}`,
          dedupeHash: `credit-${accountId}-${postedOn}`,
        })
        .returning({ id: transactions.id })
        .get().id;
      const categoryId = bundle.db.select().from(categories).where(eq(categories.name, category)).get()!.id;
      bulkApply(bundle.db, [id], { categoryId });
      return id;
    }

    test("Free to spend names the payday it has in neither leg, in the forecast's words", () => {
      weeklyPayFoundJul2("2026-07-02");
      // Jul 8, and the payday itself: Jul 9 is still to come, the forecast's leg — nothing is left out
      for (const day of ["2026-07-08", "2026-07-09"]) {
        const pace = dashboardData(bundle.db, day).pace!;
        expect(pace.freeToSpendCents).toBe(1000_00 + 4 * 1000_00 - 80_00);
        expect(pace.paydaysLeftOut).toBeNull();
      }
      // the day after, Jul 9 is past and after Jul 2: no posted row holds it, and the forecast opens on today
      const pace = dashboardData(bundle.db, "2026-07-10").pace!;
      expect(pace.freeToSpendCents).toBe(1000_00 + 3 * 1000_00 - 80_00);
      expect(pace.waitsForIncome).toBe(false);
      expect(pace.paydaysLeftOut).toEqual({
        text:
          "1 payday worth $1,000.00 already passed this month — not in Free to spend. It falls after Jul 2, the " +
          "last day every account that pay lands in has been checked through — so the ledger has not looked for its " +
          "deposit.",
        warning: false,
      });
    });

    // ⛔ one reading of those paydays: the forecast's, whose note calls the same days "not counted above"
    test("the paydays it names are the forecast's own passed paydays, by the forecast's words", () => {
      weeklyPayFoundJul2("2026-07-02");
      const day = "2026-07-17"; // Jul 9 and Jul 16 passed, both after Jul 2
      const passed = forecastCurrentMonth(bundle.db, day).unbankedIncome;
      expect(passed).toMatchObject({ totalCents: 2000_00, occurrenceCount: 2, checkedOccurrenceCount: 0 });
      const words = passedPaydaysWords(passed, formatDayShort);
      expect(words.unread).toContain("Both fall after Jul 2");
      expect(dashboardData(bundle.db, day).pace!.paydaysLeftOut?.text).toBe(
        `${words.count} worth $2,000.00 ${words.passed} — not in Free to spend. ${words.unread}`,
      );
    });

    /*
     * ⛔ The checked day says its year when it is not this month's (`formatDayShortIn`): a bare "Dec 31" under
     * January's figure reads as a day eleven months away. Here January's interest is found, so the figure stands, and
     * Thu Jan 7's pay falls after Dec 31, the last day its account is checked through.
     */
    test("a checked day in another year is named with its year", () => {
      const pay = seedSeries({ name: "Payroll", kind: "income", cadence: "weekly", nextExpectedOn: "2027-01-07", amountCents: 1000_00, lastMatchedOn: "2026-12-31", intervalDaysAvg: 7 });
      const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
      const wells = createAccount(bundle.db, { institutionId: instId, name: "Wells Fargo", type: "checking" });
      bundle.db.update(recurringSeries).set({ accountId: wells }).where(eq(recurringSeries.id, pay)).run();
      checkedThroughFixture(bundle.db, wells, "2026-12-31");
      const interest = bundle.db.select().from(categories).where(eq(categories.name, "Interest")).get()!.id;
      bundle.db
        .insert(transactions)
        .values({
          accountId: checking,
          postedOn: "2027-01-02",
          amountCents: 5_00,
          rawDescription: "Interest",
          normalizedDescription: "Interest",
          dedupeHash: "Interest-2027-01-02",
          categoryId: interest,
        })
        .run();
      spend("Groceries", "2027-01-02", -80_00);
      const pace = dashboardData(bundle.db, "2027-01-08").pace!;
      expect(pace.freeToSpendCents).not.toBeNull();
      expect(pace.paydaysLeftOut?.text).toContain("It falls after Dec 31, 2026, the last day every account");
    });

    // …and a payday the ledger DID look for and found no deposit for is in neither leg too: named, in the warning
    test("a checked payday with no deposit is named as the forecast names it", () => {
      weeklyPayFoundJul2("2026-07-13"); // Jul 9 and its three days to land are checked
      const pace = dashboardData(bundle.db, "2026-07-14").pace!;
      expect(pace.freeToSpendCents).toBe(1000_00 + 3 * 1000_00 - 80_00);
      expect(pace.paydaysLeftOut).toEqual({
        text:
          "1 payday worth $1,000.00 already passed this month with no deposit imported — not in Free to spend. Pay " +
          "that never reaches a bank cannot be projected as arriving.",
        warning: true,
      });
    });

    /*
     * 🔴 THE LINE READ ONE SET OF ROWS AND THE FIGURE ANOTHER (review of 5c1c4903, MEDIUM). The paydays it names are
     * settlement's, which reads only rows ATTACHED to the pay (attributed deposits only, `lib/payday-settlement`); the
     * figure's posted leg counts every row filed under Income (`hisIncomeRows`). Jul 9's $1,000 filed Income › Salary
     * from the review queue and attached to nothing: Free to spend read $4,920.00 — the attached case's figure, the
     * deposit in its posted leg — over "1 payday worth $1,000.00 already passed this month with no deposit imported —
     * not in Free to spend. …", in the warning's tone.
     */
    test("a deposit filed as Income where the pay lands, attached to no schedule, is never called left out", () => {
      const { pay, wells } = weeklyPayFoundJul2("2026-07-13");
      const jul9 = filedFromTheReviewQueue(wells, "2026-07-09", 1000_00, "Salary");
      const pace = dashboardData(bundle.db, "2026-07-14").pace!;
      // its posted leg holds Jul 9's deposit: Jul 2 and Jul 9 + Jul 16, 23 and 30 to come − $80
      expect(pace.freeToSpendCents).toBe(2 * 1000_00 + 3 * 1000_00 - 80_00);
      // …so the payday is named in the forecast's words, and nothing is said of the figure
      expect(pace.paydaysLeftOut).toEqual({
        text:
          "1 payday worth $1,000.00 already passed this month with no deposit imported. Pay that never reaches a bank " +
          "cannot be projected as arriving.",
        warning: true,
      });
      // attached, it is the same figure, and no payday passed with no deposit
      bundle.db.update(transactions).set({ recurringSeriesId: pay }).where(eq(transactions.id, jul9)).run();
      const attached = dashboardData(bundle.db, "2026-07-14").pace!;
      expect(attached.freeToSpendCents).toBe(pace.freeToSpendCents);
      expect(attached.paydaysLeftOut).toBeNull();
    });

    /*
     * ⛔ …and Income attached to nothing that cannot be its pay leaves the claim standing: in an account the pay does
     * not land in, or filed as no pay of his is filed — his filing is his word for what the money is. ⚖️ His Sep 4
     * $468.20 from It America LLC on Wells Fargo, filed under Refunds & Reimbursements, is "them paying them back for
     * claude subscription" (his words, 2026-09-28), not pay.
     */
    test.each([
      ["filed as his pay is, in an account the pay does not land in", "checking", "Salary"],
      ["filed as no pay of his is filed, where the pay lands", "wells", "Refunds & Reimbursements"],
    ])("Income attached to no schedule %s leaves the payday called left out", (_, where, category) => {
      const { wells } = weeklyPayFoundJul2("2026-07-13");
      filedFromTheReviewQueue(where === "wells" ? wells : checking, "2026-07-09", 1000_00, category);
      const pace = dashboardData(bundle.db, "2026-07-14").pace!;
      expect(pace.freeToSpendCents).toBe(2 * 1000_00 + 3 * 1000_00 - 80_00);
      expect(pace.paydaysLeftOut?.text).toBe(
        "1 payday worth $1,000.00 already passed this month with no deposit imported — not in Free to spend. Pay " +
          "that never reaches a bank cannot be projected as arriving.",
      );
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
   * `dayChangeExact: true` in place of `dayChange.exact` survives, and
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

  /*
   * 🔴 THE HEADLINE MEASURED A DAY NO CLOSE WAS PRINTED ON, AND CALLED IT
   * "today". Measured on the real ledger, Tue 2026-09-15: every held close is
   * Monday's, the NAV series is carried to today with no change, and the teaser
   * read "$0.00 (+0.00%) today" over a portfolio that had moved +$1,904.99
   * between its last closes. This fixture is that shape: closes end two days
   * back, history carried to today.
   */
  test("a series carried past its newest close headlines the move INTO that close, and names it", () => {
    for (let i = 1; i >= 0; i--) {
      cache("AAPL", addDays("2026-07-06", -i), i === 1 ? 10_000 : 10_100);
    }
    hold("2026-07-05", "AAPL", 100_000_000, 9_000);
    rebuildInvestmentHistory(bundle.db, brokerage(), TODAY);
    expect(portfolioOverview(bundle.db).asOf).toBe(TODAY); // the shape: carried to today

    const teaser = dashboardData(bundle.db, TODAY).investments!;
    expect(teaser.dayChangeTerm).toBe(`${formatDayShort("2026-07-06")} vs ${formatDayShort("2026-07-05")}`);
    // one share, $10,000 → $10,100 — not the $0.00 between two carried days
    expect(teaser.dayChangeCents).toBe(10_000);
    expect(teaser.dayChangePct).toBeCloseTo(1, 10);
    // the mover's closes ARE the headline's now, so they are said once
    expect(teaser.topMover?.symbol).toBe("AAPL");
    expect(teaser.topMover?.dayChangeTerm).toBeNull();
  });

  test("holdings whose previous closes differ headline no date, and the mover names its own", () => {
    cache("AAPL", "2026-07-03", 10_000);
    cache("AAPL", "2026-07-06", 10_100); // +1%, Jul 3 → Jul 6
    cache("TSLA", "2026-07-05", 10_000);
    cache("TSLA", "2026-07-06", 9_600); // −4%, Jul 5 → Jul 6
    hold("2026-07-03", "AAPL", 100_000_000, 9_000);
    hold("2026-07-05", "TSLA", 100_000_000, 9_000);
    rebuildInvestmentHistory(bundle.db, brokerage(), TODAY);

    const teaser = dashboardData(bundle.db, TODAY).investments!;
    // no one pair of days is true of both moves, so the phrase claims none
    expect(teaser.dayChangeTerm).toBe("day change");
    // both end at Jul 6's closes, each from its own previous one: +$100 − $400
    expect(teaser.dayChangeCents).toBe(10_000 - 40_000);
    expect(teaser.topMover?.symbol).toBe("TSLA");
    expect(teaser.topMover?.dayChangeTerm).toBe(`${formatDayShort("2026-07-06")} vs ${formatDayShort("2026-07-05")}`);
  });

  test("a holding whose closes stopped earlier neither moves the headline's day nor un-dates it", () => {
    cache("TSLA", "2026-07-01", 10_000);
    cache("TSLA", "2026-07-02", 9_000); // its last move, four days before AAPL's
    cache("AAPL", "2026-07-05", 10_000);
    cache("AAPL", "2026-07-06", 10_100);
    hold("2026-07-01", "TSLA", 100_000_000, 9_000);
    hold("2026-07-05", "AAPL", 100_000_000, 9_000);
    rebuildInvestmentHistory(bundle.db, brokerage(), TODAY);

    const teaser = dashboardData(bundle.db, TODAY).investments!;
    // TSLA sat on its Jul 2 close from Jul 5 to Jul 6, so the move is AAPL's alone…
    expect(teaser.dayChangeCents).toBe(10_000);
    // …and it is named by AAPL's closes, not left undated by TSLA's
    expect(teaser.dayChangeTerm).toBe(`${formatDayShort("2026-07-06")} vs ${formatDayShort("2026-07-05")}`);
  });

  test("a top mover measured over the headline's own days does not repeat the dates", () => {
    seedFortyDays();
    const teaser = dashboardData(bundle.db, TODAY).investments!;
    expect(teaser.dayChangeTerm).toBe(`${formatDayShort("2026-07-06")} vs ${formatDayShort("2026-07-05")}`);
    expect(teaser.topMover).not.toBeNull();
    expect(teaser.topMover!.dayChangeTerm).toBeNull();
  });
});
