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
import { cashEarningsReadings } from "./cash-earnings";

/**
 * 🔴 The /spending note said "none of it reached an account" of paydays nobody
 * had read: it asked the calendar, never how far the account the pay lands in
 * has been imported. The reading now carries that frontier — the dashboard's
 * rule (`earliestVerified` over the pay's landing accounts), moved here so both
 * surfaces read one definition of "read through".
 *
 * ⛔ The fixture must hold paydays AFTER the frontier but on or before today,
 * missed paydays before it, and windows that are unread, straddling and fully
 * read — the real ledger's shape on 2026-09-14 (Chase Checking read through
 * Aug 12, a Thursday schedule, today a Monday).
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-14";
const CHASE = "acct-chase";
const SERIES = "series-cash-job";

function salaryId(): string {
  const income = bundle.db.select().from(categories).where(and(eq(categories.name, "Income"), isNull(categories.parentId))).get()!;
  return bundle.db.select().from(categories).where(and(eq(categories.name, "Salary"), eq(categories.parentId, income.id))).get()!.id;
}

function addAccount(id: string): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: id,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cash-earnings-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(CHASE);
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  // the one attributed deposit: a Thursday, so the schedule's paydays are Thursdays
  bundle.db
    .insert(transactions)
    .values({
      id: "t-1",
      accountId: CHASE,
      postedOn: "2026-06-04",
      amountCents: 100_000,
      rawDescription: "ATM CASH DEPOSIT",
      normalizedDescription: "ATM CASH DEPOSIT",
      categoryId: salaryId(),
      recurringSeriesId: SERIES,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: "h-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function coverThrough(accountId: string, from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

/** A payroll deposit attributed to the series — $14,000, fourteen of its $1,000 paydays in one lump. */
function payroll(id: string, accountId: string, postedOn: string): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      postedOn,
      amountCents: 1_400_000,
      rawDescription: "PAYROLL",
      normalizedDescription: "PAYROLL",
      categoryId: salaryId(),
      recurringSeriesId: SERIES,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

const read = (from: string, to: string) =>
  cashEarningsReadings(bundle.db, { from, to, today: TODAY, withChecked: true })[0]!;

describe("cashEarningsReadings — how much of a window the landing account has been read", () => {
  test("names the day the pay's account is read through, and counts the paydays on or before it", () => {
    coverThrough(CHASE, "2026-06-01", "2026-08-12");

    const sep = read("2026-09-01", "2026-09-30");
    expect(sep.checkedThrough).toBe("2026-08-12");
    expect([sep.periodsCovered, sep.checkedPeriodsCovered]).toEqual([2, 0]); // Sep 3, 10 — both unread

    const aug = read("2026-08-01", "2026-08-31");
    expect([aug.periodsCovered, aug.checkedPeriodsCovered]).toEqual([4, 1]); // only Aug 6 is on a read day

    const jul = read("2026-07-01", "2026-07-31");
    expect([jul.periodsCovered, jul.checkedPeriodsCovered]).toEqual([5, 5]);

    // the schedule's silence, by the calendar and on read days — the dashboard's 14 and 9
    expect([sep.periodsSinceBanked, sep.checkedPeriodsSinceBanked]).toEqual([14, 9]);
  });

  /**
   * 🔴 /spending's note reads the same frontier as the dashboard and /recurring.
   * On a copy of the owner's ledger 2026-10-07, a series naming Wells Fargo
   * (checked through Sep 24) took Chase Checking's Aug 12 from two June
   * deposits, and its as-of-Aug-12 silence (9) outran the real one (1).
   */
  test("a series naming its account is read there, and its read silence never outruns the silence", () => {
    const WF = "acct-wf";
    addAccount(WF);
    bundle.db.update(recurringSeries).set({ accountId: WF }).where(eq(recurringSeries.id, SERIES)).run();
    payroll("t-wf", WF, "2026-09-03");
    coverThrough(CHASE, "2026-06-01", "2026-08-12");
    coverThrough(WF, "2026-06-01", "2026-09-10");

    const sep = read("2026-09-01", "2026-09-30");
    expect(sep.checkedThrough).toBe("2026-09-10");
    expect(sep.periodsSinceBanked).toBe(1); // Sep 10
    expect(sep.checkedPeriodsSinceBanked).toBe(1);
  });

  /**
   * …and the read silence never outruns the silence — which the test above cannot show: its frontier (Sep 10) is
   * past the last deposit (Sep 3), where the silence read as of the frontier IS the silence. 🔴 With `checkedSilence`
   * deleted from `cashEarningsReadings` every test here stayed green (mutation-checked 2026-10-08). Here the named
   * account is read only through Jul 9, BEFORE the last deposit, which landed elsewhere: as of Jul 9 the schedule had
   * been silent four Thursdays since Jun 11, against the one (Sep 10) it really has — and every silent payday falls
   * after Sep 3, so none of them is on a read day.
   */
  test("a frontier before the last deposit reads none of the silence, never more than there is", () => {
    const WF = "acct-wf";
    addAccount(WF);
    bundle.db.update(recurringSeries).set({ accountId: WF }).where(eq(recurringSeries.id, SERIES)).run();
    payroll("t-jun", WF, "2026-06-11");
    payroll("t-sep", CHASE, "2026-09-03");
    coverThrough(WF, "2026-06-01", "2026-07-09");
    coverThrough(CHASE, "2026-06-01", "2026-09-10");

    const sep = read("2026-09-01", "2026-09-30");
    expect(sep.checkedThrough).toBe("2026-07-09");
    expect(sep.periodsSinceBanked).toBe(1); // Sep 10
    expect(sep.checkedPeriodsSinceBanked).toBe(0);
  });

  test("a landing account with no checked record has no frontier, and nothing is counted as read", () => {
    const r = read("2026-07-01", "2026-07-31");
    expect(r.checkedThrough).toBeNull();
    expect(r.checkedPeriodsCovered).toBe(0);
    expect(r.checkedPeriodsSinceBanked).toBe(0);
  });

  test("without asking for it, a reading carries no frontier — the dashboard's cost is unchanged", () => {
    coverThrough(CHASE, "2026-06-01", "2026-08-12");
    const r = cashEarningsReadings(bundle.db, { from: "2026-07-01", to: "2026-07-31", today: TODAY })[0]!;
    expect(r.checkedThrough).toBeUndefined();
  });
});
