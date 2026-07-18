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
import { applyUndoPatch, bulkApply, setTransactionFlags } from "./bulk-edit";
import { editManualTransaction } from "./manual-transactions";
import {
  activeSplitsInRange,
  clearSplits,
  listSplits,
  migrateSplits,
  restoreSplits,
  setSplits,
  splitCountsByTxn,
} from "./transaction-splits";

let dir: string;
let bundle: DbBundle;
let accountId: string;
let catId: {
  groceries: string;
  household: string;
  refunds: string;
  otherIncome: string;
  internalTransfer: string;
};

function categoryId(name: string): string {
  const row = bundle.db.select({ id: categories.id }).from(categories).where(eq(categories.name, name)).get();
  if (!row) throw new Error(`missing category ${name}`);
  return row.id;
}

function insertTxn(overrides: Partial<typeof transactions.$inferInsert> = {}): string {
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: "2026-07-10",
      amountCents: -2_000,
      rawDescription: "PURCHASE",
      normalizedDescription: "PURCHASE",
      dedupeHash: `h-${Math.random()}`,
      ...overrides,
    })
    .returning({ id: transactions.id })
    .get().id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-splits-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  accountId = bundle.db
    .insert(accounts)
    .values({ institutionId: chase.id, name: "Chase Checking", type: "checking" })
    .returning({ id: accounts.id })
    .get().id;
  catId = {
    groceries: categoryId("Groceries"),
    household: categoryId("Home Supplies"),
    refunds: categoryId("Refunds & Reimbursements"),
    otherIncome: categoryId("Other Income"),
    internalTransfer: categoryId("Internal Transfer"),
  };
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("setSplits", () => {
  test("persists valid parts and clears needsReview", () => {
    const txnId = insertTxn({ needsReview: true });
    setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);

    const splits = listSplits(bundle.db, txnId);
    expect(splits.map((s) => s.amountCents)).toEqual([-1_500, -500]);
    expect(splits.map((s) => s.sortOrder)).toEqual([0, 1]);
    const parent = bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
    expect(parent.needsReview).toBe(false);
    // the parent ledger amount is UNTOUCHED — net worth invariant
    expect(parent.amountCents).toBe(-2_000);
    // parent is stamped with the dominant part's category (the -1500 Groceries
    // part) so raw-categoryId readers (coverage, categorizeAll, filters) treat it
    // as a categorized, reviewed row
    expect(parent.categoryId).toBe(catId.groceries);
    expect(parent.categorizationSource).toBe("user");
  });

  test("replaces prior splits rather than appending", () => {
    const txnId = insertTxn();
    setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_000 },
      { categoryId: catId.household, amountCents: -1_000 },
    ]);
    setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    expect(listSplits(bundle.db, txnId)).toHaveLength(2);
  });

  test("rejects parts that do not sum to the parent amount", () => {
    const txnId = insertTxn();
    expect(() =>
      setSplits(bundle.db, txnId, [
        { categoryId: catId.groceries, amountCents: -1_500 },
        { categoryId: catId.household, amountCents: -400 },
      ]),
    ).toThrow(/add up/i);
    expect(listSplits(bundle.db, txnId)).toHaveLength(0);
  });

  test("blocks splitting a transfer-linked transaction", () => {
    const txnId = insertTxn({ transferGroupId: "grp-1" });
    expect(() =>
      setSplits(bundle.db, txnId, [
        { categoryId: catId.groceries, amountCents: -1_500 },
        { categoryId: catId.household, amountCents: -500 },
      ]),
    ).toThrow(/transfer/i);
  });

  test("supports the flagship same-sign, mixed-category positive split", () => {
    const txnId = insertTxn({ amountCents: 250_000, rawDescription: "ROBERT COHN" });
    setSplits(bundle.db, txnId, [
      { categoryId: catId.refunds, amountCents: 150_000 },
      { categoryId: catId.otherIncome, amountCents: 100_000 },
    ]);
    expect(listSplits(bundle.db, txnId).map((s) => s.amountCents)).toEqual([150_000, 100_000]);
  });

  test("rejects an unknown category", () => {
    const txnId = insertTxn();
    expect(() =>
      setSplits(bundle.db, txnId, [
        { categoryId: catId.groceries, amountCents: -1_500 },
        { categoryId: "nope", amountCents: -500 },
      ]),
    ).toThrow(/category/i);
  });

  test("stamps the largest SPEND/EARN-kind part as the parent primary, not a bigger transfer part", () => {
    // largest part is a transfer (kind=transfer); the parent must still be
    // stamped with the expense part so it stays a real spending row (and never
    // looks like a transfer to the auto-detector)
    const txnId = insertTxn({ amountCents: -2_000 });
    setSplits(bundle.db, txnId, [
      { categoryId: catId.internalTransfer, amountCents: -1_500 }, // transfer, larger
      { categoryId: catId.groceries, amountCents: -500 }, // expense, smaller
    ]);
    const parent = bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
    expect(parent.categoryId).toBe(catId.groceries);
  });

  test("blocks changing a split transaction's amount (would break the sum invariant)", () => {
    // a manual (importFileId null) row so editManualTransaction is permitted
    const txnId = insertTxn({ amountCents: -2_000 });
    setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    expect(() => editManualTransaction(bundle.db, txnId, { amountCents: -3_000 })).toThrow(/amount/i);
    // description-only edit (amount unchanged) is still allowed
    expect(() => editManualTransaction(bundle.db, txnId, { description: "RENAMED" })).not.toThrow();
    // splits are intact — the amount never changed
    expect(listSplits(bundle.db, txnId).reduce((s, x) => s + x.amountCents, 0)).toBe(-2_000);
  });
});

describe("clearSplits + restoreSplits (undo)", () => {
  test("clearSplits removes all parts and restoreSplits reinstates them", () => {
    const txnId = insertTxn({ needsReview: true });
    const before = setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    // before-snapshot captured the pre-split (empty) state with needsReview=true
    expect(before.lines).toHaveLength(0);
    expect(before.parent.needsReview).toBe(true);

    const afterSplit = clearSplits(bundle.db, txnId);
    expect(listSplits(bundle.db, txnId)).toHaveLength(0);

    restoreSplits(bundle.db, afterSplit);
    expect(listSplits(bundle.db, txnId).map((s) => s.categoryId)).toEqual([
      catId.groceries,
      catId.household,
    ]);
  });

  test("undoing a setSplits (restore to empty) also restores needsReview", () => {
    const txnId = insertTxn({ needsReview: true });
    const prior = setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_000 },
      { categoryId: catId.household, amountCents: -1_000 },
    ]);
    restoreSplits(bundle.db, prior);
    expect(listSplits(bundle.db, txnId)).toHaveLength(0);
    const parent = bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
    expect(parent.needsReview).toBe(true);
  });
});

describe("split ⇄ transfer mutual exclusion", () => {
  test("marking a split transaction a transfer is blocked", () => {
    const txnId = insertTxn();
    setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    expect(() => setTransactionFlags(bundle.db, txnId, { transfer: true })).toThrow(/transfer/i);
    // clearing the transfer flag on a (non-transfer) split row is a harmless no-op
    expect(() => setTransactionFlags(bundle.db, txnId, { transfer: false })).not.toThrow();
  });

  test("bulk category-set skips split rows (their category lives in the parts)", () => {
    const splitId = insertTxn({ dedupeHash: "split-cat" });
    setSplits(bundle.db, splitId, [
      { categoryId: catId.groceries, amountCents: -1_500 }, // stamps parent = Groceries
      { categoryId: catId.household, amountCents: -500 },
    ]);
    const plainId = insertTxn({ dedupeHash: "plain-cat" });

    const result = bulkApply(bundle.db, [splitId, plainId], { categoryId: catId.refunds });
    expect(result.affected).toBe(1); // only the plain row

    const split = bundle.db.select().from(transactions).where(eq(transactions.id, splitId)).get()!;
    const plain = bundle.db.select().from(transactions).where(eq(transactions.id, plainId)).get()!;
    expect(split.categoryId).toBe(catId.groceries); // stamp untouched; parts still drive analytics
    expect(plain.categoryId).toBe(catId.refunds);
  });

  test("applyUndoPatch does not restore a transfer link onto a now-split row", () => {
    const txnId = insertTxn({ dedupeHash: "undo-tg" });
    bulkApply(bundle.db, [txnId], { markTransfer: true }); // transferGroupId = txnId
    const clear = bulkApply(bundle.db, [txnId], { clearTransfer: true }); // undo.prev.transferGroupId = txnId
    setSplits(bundle.db, txnId, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    // a stale "Transfer off" undo toast must NOT resurrect the transfer on the split row
    applyUndoPatch(bundle.db, clear.undo);
    const row = bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
    expect(row.transferGroupId).toBeNull();
    expect(listSplits(bundle.db, txnId)).toHaveLength(2);
  });

  test("bulk mark-transfer skips split rows without crashing the batch", () => {
    const splitId = insertTxn({ dedupeHash: "split-row" });
    setSplits(bundle.db, splitId, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    const plainId = insertTxn({ dedupeHash: "plain-row" });

    // the batch mixes a split row and a plain row — must NOT throw on the empty
    // set for the skipped split row, and must mark only the plain row
    const result = bulkApply(bundle.db, [splitId, plainId], { markTransfer: true });
    expect(result.affected).toBe(1); // only the plain row

    const split = bundle.db.select().from(transactions).where(eq(transactions.id, splitId)).get()!;
    const plain = bundle.db.select().from(transactions).where(eq(transactions.id, plainId)).get()!;
    expect(split.transferGroupId).toBeNull(); // split row untouched
    expect(plain.transferGroupId).not.toBeNull(); // plain row marked
  });
});

describe("batch readers", () => {
  test("splitCountsByTxn counts parts per transaction", () => {
    const a = insertTxn();
    const b = insertTxn({ dedupeHash: "h-b" });
    setSplits(bundle.db, a, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    const counts = splitCountsByTxn(bundle.db, [a, b]);
    expect(counts.get(a)).toBe(2);
    expect(counts.has(b)).toBe(false);
  });

  test("migrateSplits moves splits onto the replacement row and carries the stamp", () => {
    // an imported row that was split, then superseded by a re-import takeover;
    // the replacement is the same real charge (different raw text / dedupe hash)
    const oldId = insertTxn({ amountCents: -2_000, status: "superseded" });
    bundle.db
      .insert(transactionSplits)
      .values([
        { transactionId: oldId, categoryId: catId.groceries, amountCents: -1_500, sortOrder: 0 },
        { transactionId: oldId, categoryId: catId.household, amountCents: -500, sortOrder: 1 },
      ])
      .run();
    bundle.db
      .update(transactions)
      .set({ categoryId: catId.groceries, categorizationSource: "user" })
      .where(eq(transactions.id, oldId))
      .run();
    const twinId = insertTxn({ amountCents: -2_000, dedupeHash: "twin-hash", status: "active" });

    migrateSplits(bundle.db, oldId, twinId);

    expect(listSplits(bundle.db, oldId)).toHaveLength(0);
    expect(listSplits(bundle.db, twinId).map((s) => s.categoryId)).toEqual([
      catId.groceries,
      catId.household,
    ]);
    // the twin carries the split parent's stamp
    const twin = bundle.db.select().from(transactions).where(eq(transactions.id, twinId)).get()!;
    expect(twin.categoryId).toBe(catId.groceries);
  });

  test("activeSplitsInRange groups active in-window parts by transaction", () => {
    const inRange = insertTxn({ postedOn: "2026-07-10" });
    const outOfRange = insertTxn({ postedOn: "2026-01-01", dedupeHash: "h-old" });
    const superseded = insertTxn({ postedOn: "2026-07-11", dedupeHash: "h-sup", status: "superseded" });
    setSplits(bundle.db, inRange, [
      { categoryId: catId.groceries, amountCents: -1_500 },
      { categoryId: catId.household, amountCents: -500 },
    ]);
    // splits on out-of-range / superseded parents must be excluded
    bundle.db
      .insert(transactionSplits)
      .values([
        { transactionId: outOfRange, categoryId: catId.groceries, amountCents: -1_000, sortOrder: 0 },
        { transactionId: outOfRange, categoryId: catId.household, amountCents: -1_000, sortOrder: 1 },
        { transactionId: superseded, categoryId: catId.groceries, amountCents: -1_000, sortOrder: 0 },
        { transactionId: superseded, categoryId: catId.household, amountCents: -1_000, sortOrder: 1 },
      ])
      .run();

    const map = activeSplitsInRange(bundle.db, "2026-07-01", "2026-07-31");
    expect([...map.keys()]).toEqual([inRange]);
    expect(map.get(inRange)!.map((s) => s.amountCents)).toEqual([-1_500, -500]);
  });
});
