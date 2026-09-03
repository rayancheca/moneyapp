import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { moversCard, TOP_MOVERS } from "./movers-card";

/**
 * The card's whole job is choosing an honest comparison, so most of these tests
 * are about which month it picks and what it refuses to say — not about
 * arithmetic. The arithmetic belongs to `monthlySpending`, which is already
 * tested; what is new here is the refusal.
 */

let dir: string;
let bundle: DbBundle;

/** deliberately mid-month, and mid-import: the shape the real ledger is in */
const TODAY = "2026-08-26";
const MAIN = "acct-main";
const OTHER = "acct-other";

function topLevelId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get()!.id;
}

let seq = 0;
function addTxn(day: string, cents: number, categoryName: string | null, accountId: string = MAIN): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: categoryName === null ? null : topLevelId(categoryName),
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/**
 * A row that moves the import frontier and nothing else.
 *
 * An uncategorized CREDIT is excluded from spending everywhere (`spendingBucket`
 * hands the review queue positive category-less rows), so it proves the ledger
 * was shown this account on this day without adding a cent of spend to it.
 */
function importedThrough(day: string, accountId: string): void {
  addTxn(day, 1, null, accountId);
}

/** Spend in every baseline month, so the account counts as a live spender. */
function spendAllBaselineMonths(categoryName: string, cents: number, accountId: string = MAIN): void {
  for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    addTxn(`${m}-10`, -cents, categoryName, accountId);
  }
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-movers-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(MAIN, "Chase Checking");
  addAccount(OTHER, "Venture X");
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("moversCard — which month it compares", () => {
  test("compares the newest complete, fully imported month against the six before it", () => {
    spendAllBaselineMonths("Food", 10_000); // $100 a month
    addTxn("2026-07-10", -30_000, "Food"); // $300 in July
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.month).toBe("2026-07");
    expect(card.baselineMonths).toBe(6);
    expect(card.baselineFromLabel).toBe("Jan 2026");
    expect(card.baselineToLabel).toBe("Jun 2026");
    expect(card.monthTotalCents).toBe(30_000);
    expect(card.usualMonthlyCents).toBe(10_000);
    expect(card.totalDeltaCents).toBe(20_000);
    expect(card.direction).toBe("up");
    expect(card.headline).toBe(formatCents(20_000));
    expect(card.movers[0]!.categoryName).toBe("Food");
    expect(card.movers[0]!.pctLabel).toBe("+200%");
  });

  /**
   * ⛔ THE trap this card exists for. August is 26 days in and three of its
   * accounts are mid-import; measured on the real ledger the naive comparison
   * published "Food −87%" for a month nobody had finished importing.
   */
  test("the running month is never the compared one, however much of it is in", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -25_000, "Food");
    addTxn("2026-08-10", -1_000, "Food"); // a thin part-month — must not be read
    importedThrough("2026-08-26", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.month).toBe("2026-07");
    expect(card.monthTotalCents).toBe(25_000);
    // and the card says so, rather than leaving the reader to wonder
    expect(card.currentMonthNote).toContain("Aug 2026");
    expect(card.currentMonthNote).toContain("still running");
  });

  /**
   * ⚠️ Recorded because a mutation that let the running month be a candidate
   * SURVIVED the suite above: on an ordinary mid-month day the import frontier
   * blocks it by accident, since nobody has been shown the end of a month that
   * has not happened. That is a guard doing the wrong job, and the day it stops
   * working is the last day of the month — when the frontier CAN reach the
   * month's end and only the calendar rule is left. `spendBaseline` excludes
   * the current month whatever day it is, and so does this.
   */
  test("the last day of the month is still not the end of it", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -25_000, "Food");
    addTxn("2026-08-10", -90_000, "Food"); // a fully imported August, on Aug 31
    importedThrough("2026-08-31", MAIN);

    const card = moversCard(bundle.db, "2026-08-31")!;
    expect(card.month).toBe("2026-07");
    expect(card.monthTotalCents).toBe(25_000);
  });

  /**
   * A month can be OVER and still be missing: statements land weeks after the
   * period they cover. July is complete on 2026-08-26 and unimported, so the
   * card steps back to June rather than reporting a fall it cannot support.
   */
  test("a complete month nobody has imported is skipped, not compared", () => {
    for (const m of ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]) {
      addTxn(`${m}-10`, -10_000, "Food");
    }
    addTxn("2026-06-10", -25_000, "Food");
    addTxn("2026-07-10", -90_000, "Food"); // a big July nobody has seen the end of
    importedThrough("2026-07-15", MAIN); // …the ledger stops mid-July

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.month).toBe("2026-06");
    expect(card.baselineFromLabel).toBe("Dec 2025");
    expect(card.baselineToLabel).toBe("May 2026");
    expect(card.monthTotalCents).toBe(25_000);
    /*
     * ⛔ WHAT THE WINDOW AVERAGES, not what it is LABELLED. `baselineKeys` is
     * computed independently of how many months are actually loaded, so a grid
     * one month too shallow still prints "the mean of the 6 complete months
     * before it, Dec 2025 to May 2026" and averages FIVE — December silently a
     * zero inside a window the sentence names by date. Six months at $100 is
     * $100, and $83.33 is the shape of that bug. The labels above cannot see it.
     *
     * This is the deepest the card ever reaches (the fallback month, two behind),
     * and it is the ONLY test that gets here — which is why `monthsLoaded`'s
     * `+ 1` survived every one of the other 24.
     */
    expect(card.usualMonthlyCents).toBe(10_000);
    // and every category is seen in all six, not five
    expect(card.movers.every((m) => m.monthsSeen === 6)).toBe(true);
    /*
     * 🔴 …and the skip is SAID. The dashboard read "Sep 2026 is still running…"
     * over July's figures with August passed over in silence. Killed by
     * mutation: dropping the skipped clause leaves the running-month sentence
     * alone, and this line finds no July in it.
     */
    expect(card.currentMonthNote).toContain(
      "Jul 2026 is complete, but not every account you spend from has been imported through its last day — so these read Jun 2026 rather than Jul 2026.",
    );
  });

  test("the compared month right before the running one names no skip", () => {
    for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
      addTxn(`${m}-10`, -10_000, "Food");
    }
    addTxn("2026-07-10", -25_000, "Food");
    importedThrough("2026-08-20", MAIN);
    const card = moversCard(bundle.db, TODAY)!;
    expect(card.month).toBe("2026-07");
    expect(card.currentMonthNote).not.toContain("is complete, but");
  });

  /**
   * 🔴 "WHAT MOVED MOST" IS A MAGNITUDE, and nothing pinned the `Math.abs`.
   *
   * Dropping it — sorting by the signed delta — puts every rise above every
   * fall, so the single largest FALL drops off a card whose whole job is to
   * show the biggest moves, and lands in the "smaller moves" line instead.
   * Every other fixture in this file happens to sort identically under both
   * comparators, which is why the mutant survived all 25 of them.
   *
   * Six categories against five slots, and the biggest mover of all is the one
   * that went DOWN.
   */
  test("the biggest FALL outranks a smaller rise", () => {
    for (const name of ["Food", "Travel", "Shopping", "Health", "Utilities", "Education"]) {
      spendAllBaselineMonths(name, 10_000);
    }
    addTxn("2026-07-10", -60_000, "Food"); // +$500 — the biggest rise
    addTxn("2026-07-10", -1_000, "Travel"); // −$90
    addTxn("2026-07-10", -12_000, "Shopping"); // +$20
    addTxn("2026-07-10", -13_000, "Health"); // +$30
    addTxn("2026-07-10", -14_000, "Utilities"); // +$40
    // Education: nothing at all in July — −$100, the biggest move on the card
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.movers[0]!.categoryName).toBe("Food");
    const names = card.movers.map((m) => m.categoryName);
    expect(names).toContain("Education");
    // …and it is the SECOND row, not swept below the cut by five smaller rises
    expect(names[1]).toBe("Education");
    expect(card.movers.find((m) => m.categoryName === "Education")!.deltaCents).toBe(-10_000);
  });

  test("returns null when no month within reach has been imported through", () => {
    spendAllBaselineMonths("Food", 10_000);
    importedThrough("2026-06-10", MAIN); // nothing since June: both candidates are blind

    expect(moversCard(bundle.db, TODAY)).toBeNull();
  });

  /**
   * 🔴 `frontierForSeries`' recorded lesson, in a second place: one dormant
   * account must not be able to veto the card forever. SoFi Checking spent
   * twice in six months on the real ledger and has had no transaction since
   * May — under a rule that asks EVERY account with any spend to be current, it
   * would block every month from July onward, permanently.
   */
  test("a dormant account that barely spends does not veto the comparison", () => {
    spendAllBaselineMonths("Food", 10_000, MAIN);
    addTxn("2026-07-10", -20_000, "Food", MAIN);
    importedThrough("2026-08-20", MAIN);
    // OTHER spent in two of the six baseline months and has been silent since
    addTxn("2026-01-05", -5_000, "Shopping", OTHER);
    addTxn("2026-03-05", -5_000, "Shopping", OTHER);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.month).toBe("2026-07");
  });

  test("…but an account you really do spend from, left unimported, does block it", () => {
    spendAllBaselineMonths("Food", 10_000, MAIN);
    addTxn("2026-07-10", -20_000, "Food", MAIN);
    importedThrough("2026-08-20", MAIN);
    // three of six months makes OTHER a live spender, and it stops in March
    addTxn("2026-01-05", -5_000, "Shopping", OTHER);
    addTxn("2026-02-05", -5_000, "Shopping", OTHER);
    addTxn("2026-03-05", -5_000, "Shopping", OTHER);

    const card = moversCard(bundle.db, TODAY);
    // July is blocked; June is too (OTHER stops in March), so there is no honest month
    expect(card).toBeNull();
  });

  /**
   * A baseline that averages months the ledger did not exist for is not a
   * "usual" — it divides real spending by imaginary zeroes and turns every
   * category into a rise.
   */
  test("returns null when the ledger opens after the baseline does", () => {
    for (const m of ["2026-03", "2026-04", "2026-05", "2026-06"]) addTxn(`${m}-10`, -10_000, "Food");
    addTxn("2026-07-10", -30_000, "Food");
    importedThrough("2026-08-20", MAIN);

    expect(moversCard(bundle.db, TODAY)).toBeNull();
  });

  test("returns null on an empty ledger rather than a card of zeroes", () => {
    expect(moversCard(bundle.db, TODAY)).toBeNull();
  });

  test("returns null when nothing moved at all", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -10_000, "Food"); // exactly the usual
    importedThrough("2026-08-20", MAIN);

    expect(moversCard(bundle.db, TODAY)).toBeNull();
  });
});

describe("moversCard — the numbers", () => {
  /**
   * ⛔ `WHERE amount_cents < 0` is the obvious query and it is wrong. An inflow
   * inside an expense category is a silent NEGATIVE expense; pass 66 found
   * twelve of them understating spending by $487.50. On a card about CHANGE it
   * is worse than elsewhere — a refund in one month and not the next IS the
   * change, and filtering would report it as a fall in purchasing.
   */
  test("a refund NETS against the month instead of being ignored", () => {
    spendAllBaselineMonths("Shopping", 10_000);
    addTxn("2026-07-05", -30_000, "Shopping");
    addTxn("2026-07-20", 12_000, "Shopping"); // returned

    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    const shopping = card.movers.find((m) => m.categoryName === "Shopping")!;
    expect(shopping.monthCents).toBe(18_000);
    expect(shopping.deltaCents).toBe(8_000);
  });

  /** ⛔ `x / 0` is Infinity, and "Infinity%" is worse than saying nothing. */
  test("a category with no usual gets no percentage, not an infinite one", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -10_000, "Food");
    addTxn("2026-07-11", -50_000, "Travel"); // never spent before
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    const travel = card.movers.find((m) => m.categoryName === "Travel")!;
    expect(travel.usualMonthlyCents).toBe(0);
    expect(travel.pctOfUsual).toBeNull();
    expect(travel.pctLabel).toBeNull();
    expect(travel.thinNote).toBe("nothing in the 6 months before");
  });

  /**
   * ⛔ Worse than dividing by zero, because it divides CLEANLY: a category that
   * net-refunded across the baseline has a negative usual, and `delta / usual`
   * then comes out with the wrong SIGN — more money going out, printed as a
   * fall.
   */
  test("a negative usual gets no percentage either", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-02-10", 20_000, "Travel"); // a refund with no purchase behind it
    addTxn("2026-07-11", -5_000, "Travel");
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    const travel = card.movers.find((m) => m.categoryName === "Travel")!;
    expect(travel.usualMonthlyCents).toBeLessThan(0);
    expect(travel.deltaCents).toBeGreaterThan(0);
    expect(travel.pctOfUsual).toBeNull();
  });

  /** one row must not print two different minus signs — see `pctLabelOf` */
  test("a fall's percentage wears the same minus sign as its money", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -4_000, "Food");
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.movers[0]!.pctLabel).toBe("-60%");
    expect(formatCentsSigned(card.movers[0]!.deltaCents).startsWith("-")).toBe(true);
  });

  /**
   * ⛔ `Math.round(-0.17)` is `-0` and `formatCents(-0)` renders "-$0.00". It
   * hides, too: `-0 + 0 === 0`, so every total stays right while one cell wears
   * a minus sign it does not have. This shipped to the dashboard once.
   */
  test("a usual that rounds to zero from below is 0, never -0", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-02-10", 1, "Travel"); // one cent BACK across six months
    addTxn("2026-07-11", -5_000, "Travel");
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    const travel = card.movers.find((m) => m.categoryName === "Travel")!;
    expect(travel.usualMonthlyCents).toBe(0);
    expect(Object.is(travel.usualMonthlyCents, -0)).toBe(false);
    expect(formatCents(travel.usualMonthlyCents)).toBe("$0.00");
  });

  test("a quiet baseline month counts as a zero, not as a missing sample", () => {
    spendAllBaselineMonths("Shopping", 10_000); // an ordinary category alongside
    // $600 in one month and nothing in the other five is a $100 usual, not $600
    addTxn("2026-01-10", -60_000, "Food");
    addTxn("2026-07-10", -20_000, "Food");
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    const food = card.movers.find((m) => m.categoryName === "Food")!;
    expect(food.usualMonthlyCents).toBe(10_000);
    expect(food.deltaCents).toBe(10_000);
  });

  test("movers are ranked by money, not by percentage", () => {
    spendAllBaselineMonths("Food", 100_000); // $1,000 a month
    spendAllBaselineMonths("Personal Care", 100); // $1 a month
    addTxn("2026-07-10", -150_000, "Food"); // +$500, +50%
    addTxn("2026-07-11", -2_000, "Personal Care"); // +$19, +1900%
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.movers.map((m) => m.categoryName)).toEqual(["Food", "Personal Care"]);
  });

  test("the rows always add up to the headline", () => {
    const names = ["Food", "Shopping", "Travel", "Transport", "Health", "Fees", "Utilities"];
    for (const [i, name] of names.entries()) {
      spendAllBaselineMonths(name, 1_000 * (i + 1));
      addTxn("2026-07-10", -1_000 * (i + 1) * (i + 2), name);
    }
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.movers.length).toBe(TOP_MOVERS);
    expect(card.otherCount).toBe(names.length - TOP_MOVERS);
    const shown = card.movers.reduce((sum, m) => sum + m.deltaCents, 0);
    expect(shown + card.otherDeltaCents).toBe(card.totalDeltaCents);
    expect(card.monthTotalCents - card.usualMonthlyCents).toBe(card.totalDeltaCents);
  });

  /**
   * `MIN_OCCURRENCES` is the app's own line between an anecdote and a pattern.
   * Education reads "$384 less than usual" on the real ledger off two spends in
   * six months, one of them a single $2,250 charge — lumpiness, not a habit.
   */
  test("a usual built on fewer than three months says so", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-02-10", -60_000, "Education");
    addTxn("2026-04-10", -60_000, "Education");
    addTxn("2026-07-10", -10_000, "Food");
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    const education = card.movers.find((m) => m.categoryName === "Education")!;
    expect(education.monthsSeen).toBe(2);
    expect(education.thinNote).toBe("only in 2 of the 6 months before");
  });

  test("a usual built on three months does not", () => {
    spendAllBaselineMonths("Food", 10_000);
    for (const m of ["2026-02", "2026-03", "2026-04"]) addTxn(`${m}-10`, -60_000, "Education");
    addTxn("2026-07-10", -10_000, "Food");
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    const education = card.movers.find((m) => m.categoryName === "Education")!;
    expect(education.monthsSeen).toBe(3);
    expect(education.thinNote).toBeNull();
  });
});

describe("moversCard — what it admits it cannot see", () => {
  test("names the live spenders the ledger has not been shown through today", () => {
    spendAllBaselineMonths("Food", 10_000, MAIN);
    addTxn("2026-07-10", -20_000, "Food", MAIN);
    importedThrough("2026-08-02", MAIN); // three weeks behind

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.lagging.map((l) => l.name)).toEqual(["Chase Checking"]);
    expect(card.lagging[0]!.through).toBe("2026-08-02");
    expect(card.lagging[0]!.throughLabel).toBe("Aug 2");
    expect(card.lagging[0]!.sharePct).toBeCloseTo(100);
    expect(card.currentMonthNote).toContain("not fully imported");
    expect(card.currentMonthNote).toContain("Aug 2");
  });

  test("says nothing about lag when every spending account is current", () => {
    spendAllBaselineMonths("Food", 10_000, MAIN);
    addTxn("2026-07-10", -20_000, "Food", MAIN);
    importedThrough(TODAY, MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.lagging).toEqual([]);
    expect(card.currentMonthNote).not.toContain("not fully imported");
    expect(card.currentMonthNote).toContain("part month");
  });

  /**
   * The mirror of the lag, at the other end of the window: an account that
   * joined part way through the baseline drags its own months toward zero, so
   * "usual" sits below what was really spent and every category looks like it
   * grew.
   */
  test("names a live spender that was missing from whole baseline months", () => {
    spendAllBaselineMonths("Food", 10_000, MAIN);
    addTxn("2026-07-10", -20_000, "Food", MAIN);
    importedThrough("2026-08-20", MAIN);
    for (const m of ["2026-04", "2026-05", "2026-06"]) addTxn(`${m}-10`, -5_000, "Shopping", OTHER);
    addTxn("2026-07-10", -5_000, "Shopping", OTHER);
    importedThrough("2026-08-20", OTHER);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.historyNote).toContain("Venture X (3 of 6)");
  });

  test("stays quiet about history when every live spender covers the whole window", () => {
    spendAllBaselineMonths("Food", 10_000, MAIN);
    addTxn("2026-07-10", -20_000, "Food", MAIN);
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.historyNote).toBeNull();
  });

  test("the summary states both windows, so the headline cannot be misread", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -30_000, "Food");
    importedThrough("2026-08-20", MAIN);

    const card = moversCard(bundle.db, TODAY)!;
    expect(card.summary).toContain("Jul 2026");
    expect(card.summary).toContain("Jan 2026 to Jun 2026");
    expect(card.summary).toContain("6 complete months");
    expect(card.headlineNoun).toContain("Jul 2026");
  });
});
