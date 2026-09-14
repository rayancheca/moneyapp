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
import { deviationRowsFrom } from "@/lib/deviation-layout";
import { resolvePeriod } from "@/lib/period";
import { categoryBreakdown } from "./analytics";
import { moversCard, spendingCoverageThrough } from "./movers-card";
import { cashFlowByPeriod, periodComparison, spendingProjection } from "./spending";

/**
 * The closing edge of a /spending comparison, through a ledger whose accounts
 * have been imported to DIFFERENT days — the only shape that can express it.
 *
 * ⛔ A fixture where every account shares one frontier cannot tell a
 * whole-ledger cut from a per-account one, and that is exactly the real case:
 * cut at the ledger's newest row (Sep 12), Sep 1–12 against Aug 1–12 still read
 * Housing −$2,229.85, because the Aug 4 rent sits on an account with no
 * September rows. Measured 2026-09-14.
 */

let dir: string;
let bundle: DbBundle;

const TODAY = "2026-09-14";
/** imported through Sep 12, the way Venture X is on the real ledger */
const AHEAD = "acct-ahead";
/** imported through Aug 12, the way Chase Checking is */
const BEHIND = "acct-behind";
const AUG = resolvePeriod({ period: "2026-08" }, TODAY);

function topLevelId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get()!.id;
}

let seq = 0;
function addTxn(day: string, cents: number, categoryName: string | null, accountId: string): void {
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

/** a row that moves an account's import frontier and adds no spending (an uncategorized credit) */
function importedThrough(day: string, accountId: string): void {
  addTxn(day, 1, null, accountId);
}

/** spend in every month of the baseline the dashboard card uses for July, so the account is a live spender */
function spendAllBaselineMonths(categoryName: string, cents: number, accountId: string): void {
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-compared-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(AHEAD, "Card Ahead");
  addAccount(BEHIND, "Checking Behind");
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Two live spenders imported to different days, with a charge on the one
 * BEHIND inside the part of July that August's cut has not reached.
 */
function ledgerShownToDifferentDays(): void {
  spendAllBaselineMonths("Food", 10_000, AHEAD);
  spendAllBaselineMonths("Shopping", 5_000, BEHIND);
  addTxn("2026-07-05", -3_000, "Shopping", BEHIND); // July, before the 12th
  addTxn("2026-07-10", -20_000, "Food", AHEAD);
  addTxn("2026-07-20", -200_000, "Housing", BEHIND); // the rent — in the part of July August has not reached
  addTxn("2026-08-03", -1_000, "Shopping", BEHIND);
  addTxn("2026-08-05", -4_000, "Food", AHEAD);
  addTxn("2026-09-02", -2_000, "Food", AHEAD);
  importedThrough("2026-09-12", AHEAD);
  importedThrough("2026-08-12", BEHIND);
}

describe("the closing edge, through the ledger", () => {
  test("August draws no ghost against July: an account you spend from stops on Aug 12", () => {
    ledgerShownToDifferentDays();
    const flow = cashFlowByPeriod(bundle.db, AUG, TODAY);
    expect(spendingProjection(bundle.db, AUG, TODAY, flow.pace, flow.totals.spentCents).prior).toBeNull();
  });

  test("the cut is the earliest day among the accounts you spend from — the day the dashboard names", () => {
    ledgerShownToDifferentDays();
    expect(spendingCoverageThrough(bundle.db, TODAY)).toBe("2026-08-12");
    // ⛔ one rule, two surfaces: the dashboard's "shown through Aug 12 at the earliest"
    const card = moversCard(bundle.db, TODAY)!;
    expect(card.lagging.map((l) => l.through).sort()[0]).toBe("2026-08-12");
    expect(card.currentMonthNote).toContain("Aug 12");
  });

  test("What moved sets Aug 1 – 12 against Jul 1 – 12, and the Jul 20 rent is not in it", () => {
    ledgerShownToDifferentDays();
    const c = periodComparison(bundle.db, AUG, TODAY);
    expect(c).toMatchObject({
      kind: "clipped",
      current: { from: "2026-08-01", to: "2026-08-12", label: "Aug 1 – 12, 2026" },
      prior: { from: "2026-07-01", to: "2026-07-12", label: "Jul 1 – 12, 2026" },
    });
    if (c.kind !== "clipped") throw new Error("expected a cut comparison");

    const rows = deviationRowsFrom(categoryBreakdown(bundle.db, c.current), categoryBreakdown(bundle.db, c.prior));
    expect(rows.map((r) => [r.label, r.currentCents, r.previousCents]).sort()).toEqual([
      ["Food", 4_000, 20_000],
      ["Shopping", 1_000, 3_000],
    ]);
    // …where the whole months read the rent as a $2,000.00 fall that is only an unimported tail
    const july = resolvePeriod({ period: "2026-07" }, TODAY);
    const whole = deviationRowsFrom(categoryBreakdown(bundle.db, AUG), categoryBreakdown(bundle.db, july));
    expect(whole.find((r) => r.label === "Housing")).toMatchObject({ currentCents: 0, previousCents: 200_000 });
  });

  test("September is refused, and the sentence names the day the cut stops", () => {
    ledgerShownToDifferentDays();
    const sep = resolvePeriod({ period: "2026-09" }, TODAY);
    const c = periodComparison(bundle.db, sep, TODAY);
    expect(c).toMatchObject({ kind: "refused", reason: "not-imported" });
    expect(c.kind === "refused" ? c.sentence : "").toContain("Aug 12, 2026");
  });

  test("July, wholly before the cut, is compared whole — and keeps its ghost", () => {
    ledgerShownToDifferentDays();
    const july = resolvePeriod({ period: "2026-07" }, TODAY);
    expect(periodComparison(bundle.db, july, TODAY)).toMatchObject({
      kind: "whole",
      current: { label: "July 2026" },
      prior: { label: "June 2026" },
    });
    const flow = cashFlowByPeriod(bundle.db, july, TODAY);
    expect(spendingProjection(bundle.db, july, TODAY, flow.pace, flow.totals.spentCents).prior).toMatchObject({
      label: "June 2026",
    });
  });

  /**
   * `moversCard`'s recorded lesson, and the reason the cut is not "every
   * account": SoFi spent in 1 of the months and its statements end Jul 31 — under
   * an every-account rule August would be refused outright.
   */
  test("an account that barely spends cannot drag the cut back", () => {
    ledgerShownToDifferentDays();
    addAccount("acct-dormant", "Dormant Savings");
    addTxn("2026-02-05", -5_000, "Shopping", "acct-dormant");
    importedThrough("2026-05-31", "acct-dormant");
    expect(spendingCoverageThrough(bundle.db, TODAY)).toBe("2026-08-12");
  });

  test("a ledger with no habitual spender yet is cut at its least-imported account", () => {
    addTxn("2026-08-01", -1_000, "Food", AHEAD);
    importedThrough("2026-08-20", AHEAD);
    addTxn("2026-08-02", -1_000, "Food", BEHIND);
    importedThrough("2026-08-05", BEHIND);
    expect(spendingCoverageThrough(bundle.db, TODAY)).toBe("2026-08-05");
  });
});
