import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import {
  categorySpending,
  incomeByMonth,
  monthlySpending,
  spendingTransactions,
} from "./analytics";
import { largestTransactions, periodTotals, topMerchants } from "./spending";
import { setSplits } from "./transaction-splits";

/**
 * End-to-end proof that a split transaction is attributed to its PARTS'
 * categories across the shared aggregators, while grand totals (which the parent
 * amount drives) are unchanged. The single activeTxnsInRange explode is the
 * leverage point — this asserts it lands everywhere at once.
 */

let dir: string;
let bundle: DbBundle;
let accountId: string;

function cat(name: string): string {
  const row = bundle.db.select({ id: categories.id }).from(categories).where(eq(categories.name, name)).get();
  if (!row) throw new Error(`missing category ${name}`);
  return row.id;
}

function insertTxn(overrides: Partial<typeof transactions.$inferInsert>): string {
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: "2026-07-10",
      amountCents: -20_000,
      rawDescription: "TARGET",
      normalizedDescription: "TARGET",
      dedupeHash: `h-${Math.random()}`,
      ...overrides,
    })
    .returning({ id: transactions.id })
    .get().id;
}

const RANGE = { from: "2026-07-01", to: "2026-07-31" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-analytics-splits-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  accountId = bundle.db
    .insert(accounts)
    .values({ institutionId: chase.id, name: "Chase Checking", type: "checking" })
    .returning({ id: accounts.id })
    .get().id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("split attribution across expense categories", () => {
  test("a $200 purchase split $150 Groceries + $50 Home Supplies lands in each subtree", () => {
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping") });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 },
      { categoryId: cat("Home Supplies"), amountCents: -5_000 },
    ]);

    // each part rolls into its OWN subtree, not the stale parent (Shopping)
    expect(categorySpending(bundle.db, { categoryId: cat("Food"), ...RANGE }).spentCents).toBe(15_000);
    expect(categorySpending(bundle.db, { categoryId: cat("Housing"), ...RANGE }).spentCents).toBe(5_000);
    expect(categorySpending(bundle.db, { categoryId: cat("Shopping"), ...RANGE }).spentCents).toBe(0);
  });

  test("grand spending total is unchanged vs the same amount unsplit", () => {
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping") });
    const before = periodTotals(bundle.db, RANGE).spentCents;
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 },
      { categoryId: cat("Home Supplies"), amountCents: -5_000 },
    ]);
    const after = periodTotals(bundle.db, RANGE).spentCents;
    expect(after).toBe(before); // parts sum to the parent — net spend identical
    expect(after).toBe(20_000);
  });

  test("categorySpending txnCount counts distinct transactions, not split parts", () => {
    // both parts land under Food → one transaction, not two
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping") });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 },
      { categoryId: cat("Dining"), amountCents: -5_000 },
    ]);
    const food = categorySpending(bundle.db, { categoryId: cat("Food"), ...RANGE });
    expect(food.spentCents).toBe(20_000);
    expect(food.txnCount).toBe(1); // one real bank transaction, not 2
  });

  test("spendingTransactions returns one part-row per matching split part", () => {
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping") });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 },
      { categoryId: cat("Dining"), amountCents: -5_000 },
    ]);
    // both parts are under Food → two distinct rows, each a split part of the same txn
    const rows = spendingTransactions(bundle.db, { categoryId: cat("Food"), ...RANGE });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.id === txnId)).toBe(true);
    expect(rows.map((r) => r.splitId).every((s) => s !== null)).toBe(true);
    expect(rows.reduce((sum, r) => sum - r.amountCents, 0)).toBe(20_000);
  });

  test("monthlySpending splits the parent across top-level buckets", () => {
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping") });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 },
      { categoryId: cat("Home Supplies"), amountCents: -5_000 },
    ]);
    const cells = monthlySpending(bundle.db, { months: 1, refDate: "2026-07-15" });
    const byName = new Map(cells.map((c) => [c.categoryName, c.spentCents]));
    expect(byName.get("Food")).toBe(15_000);
    expect(byName.get("Housing")).toBe(5_000);
  });
});

describe("split attribution across income categories (the flagship case)", () => {
  test("Robert Cohn +$2,500 = +$1,500 Refunds + +$1,000 Other Income counts both as income", () => {
    const txnId = insertTxn({ amountCents: 250_000, categoryId: cat("Other Income"), rawDescription: "ROBERT COHN" });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Refunds & Reimbursements"), amountCents: 150_000 },
      { categoryId: cat("Other Income"), amountCents: 100_000 },
    ]);
    const cells = incomeByMonth(bundle.db, { months: 1, refDate: "2026-07-15" });
    const byName = new Map(cells.map((c) => [c.categoryName, c.incomeCents]));
    expect(byName.get("Refunds & Reimbursements")).toBe(150_000);
    expect(byName.get("Other Income")).toBe(100_000);
    // total earned unchanged from the parent amount
    expect(periodTotals(bundle.db, RANGE).earnedCents).toBe(250_000);
  });
});

describe("category-scoped merchant totals use the matching part", () => {
  test("topMerchants scoped to a category counts only that category's split portion", () => {
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping"), rawDescription: "COSTCO WHOLESALE" });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 },
      { categoryId: cat("Home Supplies"), amountCents: -5_000 },
    ]);
    // scoped to Food → only the $150 Groceries part contributes to this merchant
    const scoped = topMerchants(bundle.db, RANGE, 8, { categoryId: cat("Food") });
    const total = scoped.entries.reduce((sum, e) => sum + e.spentCents, 0);
    expect(total).toBe(15_000);
  });
});

describe("mixed-kind split: largest purchases reflect only the spending portion", () => {
  test("a purchase split into an expense part + a transfer part counts only the expense", () => {
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping"), rawDescription: "SPLIT PAY" });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 }, // real spend
      { categoryId: cat("Internal Transfer"), amountCents: -5_000 }, // transfer-kind, not spend
    ]);
    // Spent total and Largest Purchases both see only the $150 spend, not $200
    expect(periodTotals(bundle.db, RANGE).spentCents).toBe(15_000);
    const largest = largestTransactions(bundle.db, RANGE, 5);
    const row = largest.find((r) => r.id === txnId);
    expect(row?.amountCents).toBe(-15_000);
  });
});

describe("transfer-linked split parts never leak into spend/income", () => {
  test("marking a split transaction a transfer stops its parts faking spend", () => {
    const txnId = insertTxn({ amountCents: -20_000, categoryId: cat("Shopping") });
    setSplits(bundle.db, txnId, [
      { categoryId: cat("Groceries"), amountCents: -15_000 }, // → Food
      { categoryId: cat("Home Supplies"), amountCents: -5_000 }, // → Housing
    ]);
    // before: the Housing part shows as Housing spend
    expect(categorySpending(bundle.db, { categoryId: cat("Housing"), ...RANGE }).spentCents).toBe(5_000);

    // user later marks the whole transaction a transfer (transferGroupId set)
    bundle.db.update(transactions).set({ transferGroupId: txnId }).where(eq(transactions.id, txnId)).run();

    // the split parts are no longer exploded — the Housing part stops faking spend
    expect(categorySpending(bundle.db, { categoryId: cat("Housing"), ...RANGE }).spentCents).toBe(0);
    // the split rows still exist on the row — only analytics ignore them now
    expect(bundle.db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, txnId)).all()).toHaveLength(2);
  });
});
