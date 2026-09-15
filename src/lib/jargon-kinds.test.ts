import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "@/services/accounts";
import { activeTxnsInRange, categorySpending, loadCategoryIndex, spendingBucket } from "@/services/analytics";
import { createCategory } from "@/services/category-edit";
import { periodTotals } from "@/services/spending";
import { transferCategoryResolver } from "@/services/transfer-links";
import { CATEGORY_KIND_JARGON } from "./jargon";

/**
 * 🔴 S21 / S35 / S34 — each kind definition on /categories agrees with the rule
 * that counts that kind, measured on a real database rather than on the words.
 *
 * `jargon.ts` said its definitions were grounded in `analytics.ts`'s header
 * contract, and the contract had gone stale: the owner decision of 2026-09-03
 * made system-filed money out part of the Uncategorized SPENDING bucket, and the
 * header still said system-kind was excluded. Measured on the real ledger
 * 2026-09-15:
 *
 *   system    "Kept out of spending totals" — while `spendingBucket` buckets its
 *             6 rows' $93.07 of outflow and `periodTotals` adds it to Spent.
 *   expense   "The only kind counted as spending" — false for the same reason.
 *   income    "A repayment … nets against the original" — `periodTotals` keeps
 *             positive rows only (a repayment is left out, never subtracted);
 *             only the category's own total nets both signs.
 *   transfer  "Money moving between accounts you own" — Reimbursements (721
 *             rows), Gifts received (40), Pass-through (29) and Loans (3) all
 *             sit under Transfers, and `transferCategoryResolver` can stamp only
 *             the three own-account subcategories.
 *
 * Owner decision 2026-09-14: keep those four under Transfers, change COPY only.
 */

const WINDOW = { from: "2026-07-01", to: "2026-07-31" } as const;
const KEPT_OUT = "Kept out of spending totals";
/** the seed's root category for each kind */
const KIND_ROOT = {
  expense: "Food",
  income: "Income",
  rewards: "Rewards",
  investment: "Investments",
  transfer: "Transfers",
  system: "Uncategorized",
} as const;

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;
let brokerageId: string;
let seq = 0;

function rootId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get()!.id;
}

function childId(parentId: string, name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, parentId)))
    .get()!.id;
}

function addTxn(categoryId: string | null, cents: number, accountId: string = checkingId): string {
  seq += 1;
  const id = `t-${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      importFileId: null,
      postedOn: "2026-07-10",
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId,
      merchantId: null,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

/** Whether `spendingBucket` counts this row as spending — the rule, asked directly. */
function countedAsSpending(txnId: string): boolean {
  const idx = loadCategoryIndex(bundle.db);
  const row = activeTxnsInRange(bundle.db, WINDOW.from, WINDOW.to).find((t) => t.id === txnId)!;
  return spendingBucket(idx, row) !== null;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-jargon-kinds-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  brokerageId = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("each kind definition agrees with the rule that counts it", () => {
  /*
   * One-way on purpose: a definition that SAYS money is kept out of spending must
   * be about money the rule does not count. The converse is not a claim — income
   * money out is not spending either, and its definition has no reason to say so.
   */
  test("no definition says money is kept out of spending when money out filed there is counted as spending", () => {
    expect(Object.keys(KIND_ROOT).sort()).toEqual(Object.keys(CATEGORY_KIND_JARGON).sort());
    const claims = Object.entries(KIND_ROOT).map(([kind, root]) => ({
      kind,
      saysKeptOut: CATEGORY_KIND_JARGON[kind]!.includes(KEPT_OUT),
      counted: countedAsSpending(addTxn(rootId(root), -1_000)),
    }));
    // the check is not vacuous: some kinds do make the claim, and some are counted
    expect(claims.filter((c) => c.saysKeptOut).length).toBeGreaterThan(0);
    expect(claims.filter((c) => c.counted).length).toBeGreaterThan(0);
    expect(claims.filter((c) => c.saysKeptOut && c.counted).map((c) => c.kind)).toEqual([]);
  });

  test("the spending definition does not claim to be the only kind counted, while uncategorized money out is", () => {
    const food = addTxn(rootId("Food"), -2_000);
    const system = addTxn(rootId("Uncategorized"), -1_000);
    const unfiled = addTxn(null, -500);

    expect([food, system, unfiled].map(countedAsSpending)).toEqual([true, true, true]);
    expect(periodTotals(bundle.db, WINDOW).spentCents).toBe(3_500);
    expect(CATEGORY_KIND_JARGON.expense).not.toMatch(/only kind/i);
  });

  test("the income definition says a repayment is left out of the income figure, not netted against it", () => {
    const income = rootId("Income");
    const salary = childId(income, "Salary");
    addTxn(salary, 100_000);
    addTxn(salary, -5_000);

    // the figure: positive rows only — the repayment is not subtracted
    expect(periodTotals(bundle.db, WINDOW).earnedCents).toBe(100_000);
    // the category's own total: both signs, netted
    expect(categorySpending(bundle.db, { categoryId: income, ...WINDOW }).spentCents).toBe(-95_000);

    expect(CATEGORY_KIND_JARGON.income).not.toMatch(/nets against/);
    expect(CATEGORY_KIND_JARGON.income).toMatch(/left out/);
    expect(CATEGORY_KIND_JARGON.income).toMatch(/nets both/);
  });

  test("the transfer definition covers money to or from other people, not only money between your own accounts", () => {
    const transfers = rootId("Transfers");
    const resolve = transferCategoryResolver(bundle.db);
    const ownAccountCategories = new Set([resolve([checkingId]), resolve([cardId]), resolve([brokerageId])]);
    /*
     * The owner's own subcategory, which no own-account resolution can produce.
     * ⚠️ Inserted directly: `createCategory` refuses new children under
     * Transfers ("detection depends on them"), yet the real ledger holds four —
     * Reimbursements, Gifts received, Pass-through and Loans — so the
     * definition has to be true of rows the app's own form could not file.
     */
    expect(() => createCategory(bundle.db, { name: "Pass-through", parentId: transfers })).toThrow(/cannot take new subcategories/);
    const now = new Date().toISOString();
    bundle.db
      .insert(categories)
      .values({ id: "cat-pass-through", name: "Pass-through", parentId: transfers, kind: "transfer", createdAt: now, updatedAt: now })
      .run();
    const passThrough = { id: "cat-pass-through" };
    const out = addTxn(passThrough.id, -49_100);
    addTxn(passThrough.id, 10_000);

    expect(ownAccountCategories.size).toBe(3);
    expect(ownAccountCategories.has(passThrough.id)).toBe(false);
    expect(countedAsSpending(out)).toBe(false);
    expect(periodTotals(bundle.db, WINDOW).earnedCents).toBe(0);

    expect(CATEGORY_KIND_JARGON.transfer).toMatch(/other people/);
    expect(CATEGORY_KIND_JARGON.transfer).toMatch(/neither spending nor income/);
  });
});
