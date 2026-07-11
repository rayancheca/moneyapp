import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions, type CategorizationSource } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import {
  applyUndoPatch,
  bulkApply,
  bulkApplyByFilter,
  markAllReviewedBefore,
  setTransactionFlags,
} from "./bulk-edit";
import type { TxnFilters } from "@/components/transactions/query";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-bulk-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get()!;
  if (!subName) return parent.id;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get()!.id;
}

let seq = 0;
function insertTxn(overrides: {
  accountId?: string;
  postedOn?: string;
  amountCents?: number;
  categoryId?: string | null;
  categorizationSource?: CategorizationSource | null;
  needsReview?: boolean;
  transferGroupId?: string | null;
  notes?: string | null;
}): string {
  seq += 1;
  const accountId = overrides.accountId ?? checkingId;
  const postedOn = overrides.postedOn ?? "2026-06-15";
  const amountCents = overrides.amountCents ?? -1_000;
  const rawDescription = `TXN ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId: overrides.categoryId ?? null,
      categorizationSource: overrides.categorizationSource ?? null,
      needsReview: overrides.needsReview ?? false,
      transferGroupId: overrides.transferGroupId ?? null,
      notes: overrides.notes ?? null,
      dedupeHash: dedupeHash({
        accountId,
        postedOn,
        amountCents,
        rawDescription: `${rawDescription}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function txn(id: string) {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
}

/**
 * A retired duplicate: shares account_id + dedupe_hash with `activeId` but
 * carries status='superseded', so the partial unique index
 * (`WHERE status != 'superseded'`) lets both coexist. Flipping it to any
 * non-superseded status would collide with its active twin.
 */
function insertSupersededTwinOf(activeId: string): string {
  const a = txn(activeId);
  return bundle.db
    .insert(transactions)
    .values({
      accountId: a.accountId,
      postedOn: a.postedOn,
      amountCents: a.amountCents,
      rawDescription: a.rawDescription,
      normalizedDescription: a.normalizedDescription,
      status: "superseded",
      dedupeHash: a.dedupeHash,
    })
    .returning({ id: transactions.id })
    .get().id;
}

describe("bulkApply — category changes", () => {
  test("sets category as a user decision and captures a lossless undo", () => {
    // Arrange
    const groceries = catId("Food > Groceries");
    const dining = catId("Food > Dining");
    const a = insertTxn({ categoryId: dining, categorizationSource: "claude", needsReview: true });
    const b = insertTxn({});

    // Act
    const { affected, undo } = bulkApply(bundle.db, [a, b], { categoryId: groceries });

    // Assert: applied
    expect(affected).toBe(2);
    for (const id of [a, b]) {
      const row = txn(id);
      expect(row.categoryId).toBe(groceries);
      expect(row.categorizationSource).toBe("user");
      expect(row.categorizationConfidence).toBe(1);
      expect(row.needsReview).toBe(false);
    }
    // Assert: undo restores the exact previous values
    applyUndoPatch(bundle.db, undo);
    expect(txn(a).categoryId).toBe(dining);
    expect(txn(a).categorizationSource).toBe("claude");
    expect(txn(a).needsReview).toBe(true);
    expect(txn(b).categoryId).toBeNull();
    expect(txn(b).categorizationSource).toBeNull();
  });
});

describe("bulkApply — flags", () => {
  test("markReviewed clears and re-flags needsReview", () => {
    const a = insertTxn({ needsReview: true });
    const { undo } = bulkApply(bundle.db, [a], { markReviewed: true });
    expect(txn(a).needsReview).toBe(false);
    bulkApply(bundle.db, [a], { markReviewed: false });
    expect(txn(a).needsReview).toBe(true);
    applyUndoPatch(bundle.db, undo);
    expect(txn(a).needsReview).toBe(true);
  });

  test("exclude and restore flip status; undo restores it", () => {
    const a = insertTxn({});
    const { undo } = bulkApply(bundle.db, [a], { exclude: true });
    expect(txn(a).status).toBe("excluded");
    bulkApply(bundle.db, [a], { restore: true });
    expect(txn(a).status).toBe("active");
    bulkApply(bundle.db, [a], { exclude: true });
    applyUndoPatch(bundle.db, undo);
    expect(txn(a).status).toBe("active");
  });

  test("markTransfer self-groups ungrouped rows and keeps existing groups", () => {
    const a = insertTxn({});
    const b = insertTxn({ transferGroupId: "existing-group" });
    bulkApply(bundle.db, [a, b], { markTransfer: true });
    expect(txn(a).transferGroupId).toBe(a);
    expect(txn(b).transferGroupId).toBe("existing-group");
    const { undo } = bulkApply(bundle.db, [a, b], { clearTransfer: true });
    expect(txn(a).transferGroupId).toBeNull();
    expect(txn(b).transferGroupId).toBeNull();
    applyUndoPatch(bundle.db, undo);
    expect(txn(b).transferGroupId).toBe("existing-group");
  });

  test("rejects conflicting and empty patches", () => {
    const a = insertTxn({});
    expect(() => bulkApply(bundle.db, [a], { exclude: true, restore: true })).toThrow(
      /mutually exclusive/,
    );
    expect(() => bulkApply(bundle.db, [a], { markTransfer: true, clearTransfer: true })).toThrow(
      /mutually exclusive/,
    );
    expect(() => bulkApply(bundle.db, [a], {})).toThrow(/no effect/);
    // false-only booleans for one-way flags do nothing either
    expect(() => bulkApply(bundle.db, [a], { exclude: false })).toThrow(/no effect/);
  });

  test("empty id list is a no-op with an empty undo", () => {
    expect(bulkApply(bundle.db, [], { markReviewed: true })).toEqual({
      affected: 0,
      undo: { rows: [] },
    });
  });
});

describe("bulkApply — superseded rows are never resurrected", () => {
  test("a superseded twin is skipped by exclude/restore and its active twin is untouched", () => {
    // Arrange
    const active = insertTxn({});
    const superseded = insertSupersededTwinOf(active);
    expect(txn(superseded).status).toBe("superseded");

    // Act + Assert: exclude on the superseded id is a silent skip, not a
    // UNIQUE-violation abort (pre-fix, setting status='excluded' collides with
    // the active twin under the partial unique index).
    const excluded = bulkApply(bundle.db, [superseded], { exclude: true });
    expect(excluded.affected).toBe(0);
    expect(excluded.undo.rows).toEqual([]);
    expect(txn(superseded).status).toBe("superseded");
    expect(txn(active).status).toBe("active");

    // Act + Assert: restore is likewise skipped, no throw.
    const restored = bulkApply(bundle.db, [superseded], { restore: true });
    expect(restored.affected).toBe(0);
    expect(txn(superseded).status).toBe("superseded");
    expect(txn(active).status).toBe("active");
  });

  test("a mixed id list applies to the active row and skips the superseded twin", () => {
    const active = insertTxn({});
    const superseded = insertSupersededTwinOf(active);

    const { affected, undo } = bulkApply(bundle.db, [active, superseded], { exclude: true });

    expect(affected).toBe(1);
    expect(undo.rows.map((r) => r.id)).toEqual([active]);
    expect(txn(active).status).toBe("excluded");
    expect(txn(superseded).status).toBe("superseded");
  });

  test("applyUndoPatch honors the invariant against a crafted patch (client boundary)", () => {
    // undoPatchSchema validates shape, not business rules — the undo action is
    // client-callable, so applyUndoPatch must enforce the superseded invariant.
    const active = insertTxn({});
    const superseded = insertSupersededTwinOf(active);

    // a crafted undo targeting the superseded row is skipped by the WHERE guard
    expect(
      applyUndoPatch(bundle.db, { rows: [{ id: superseded, prev: { needsReview: true } }] }),
    ).toBe(0);
    expect(txn(superseded).status).toBe("superseded");

    // a crafted undo trying to retire the active twin drops the status write
    // (else it would trip the partial unique dedupe index)
    applyUndoPatch(bundle.db, { rows: [{ id: active, prev: { status: "superseded" } }] });
    expect(txn(active).status).toBe("active");
  });
});

describe("bulkApply — chunked id-select over a large ledger", () => {
  // Inserts 33k rows to exceed SQLITE_MAX_VARIABLE_NUMBER — inherently slow, and
  // it races vitest's 5s default when the full suite loads every worker at once.
  test("applies to every id past the SQL-variable cap with a full undo", { timeout: 30_000 }, () => {
    // A single IN(...) binds one host parameter per id, and SQLite caps that at
    // 32766 (SQLITE_MAX_VARIABLE_NUMBER). The list must exceed the cap to
    // actually exercise the chunking fix — at counts below it the pre-fix code
    // never threw. All UPDATEs stay inside one transaction, so the undo is
    // still lossless.
    const COUNT = 33_000;
    const ids: string[] = [];
    bundle.db.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) ids.push(insertTxn({ needsReview: true }));
    });

    const { affected, undo } = bulkApply(bundle.db, ids, { markReviewed: true });

    expect(affected).toBe(COUNT);
    expect(undo.rows.length).toBe(COUNT);
    expect(txn(ids[0]!).needsReview).toBe(false);
    expect(txn(ids[COUNT - 1]!).needsReview).toBe(false);

    const restoredCount = applyUndoPatch(bundle.db, undo);
    expect(restoredCount).toBe(COUNT);
    expect(txn(ids[0]!).needsReview).toBe(true);
    expect(txn(ids[COUNT - 1]!).needsReview).toBe(true);
  });
});

describe("bulkApplyByFilter", () => {
  test("applies to exactly the filter+view match set and reports the count", () => {
    // Arrange
    const inSet = insertTxn({ accountId: cardId, needsReview: true });
    insertTxn({ accountId: checkingId, needsReview: true }); // other account
    insertTxn({ accountId: cardId, needsReview: false }); // not in review view
    const filters: TxnFilters = {
      view: "review",
      account: cardId,
      category: null,
      merchant: null,
      from: null,
      to: null,
      q: null,
      amountMinCents: null,
      amountMaxCents: null,
      flow: null,
      page: 1,
    };

    // Act
    const { affected, undo } = bulkApplyByFilter(bundle.db, filters, "review", {
      markReviewed: true,
    });

    // Assert
    expect(affected).toBe(1);
    expect(undo.rows.map((r) => r.id)).toEqual([inSet]);
    expect(txn(inSet).needsReview).toBe(false);
  });
});

describe("setTransactionFlags", () => {
  test("sets sheet toggles including notes, with a combined undo row", () => {
    // Arrange
    const a = insertTxn({ needsReview: true, notes: "old note" });

    // Act
    const { affected, undo } = setTransactionFlags(bundle.db, a, {
      transfer: true,
      reviewed: true,
      notes: "paid back by roommate",
    });

    // Assert
    expect(affected).toBe(1);
    const row = txn(a);
    expect(row.transferGroupId).toBe(a);
    expect(row.needsReview).toBe(false);
    expect(row.notes).toBe("paid back by roommate");
    applyUndoPatch(bundle.db, undo);
    const restored = txn(a);
    expect(restored.transferGroupId).toBeNull();
    expect(restored.needsReview).toBe(true);
    expect(restored.notes).toBe("old note");
  });

  test("exclude toggle and null notes; rejects unknown txns and empty flag sets", () => {
    const a = insertTxn({ notes: "x" });
    setTransactionFlags(bundle.db, a, { exclude: true, notes: null });
    expect(txn(a).status).toBe("excluded");
    expect(txn(a).notes).toBeNull();
    setTransactionFlags(bundle.db, a, { exclude: false });
    expect(txn(a).status).toBe("active");
    expect(() => setTransactionFlags(bundle.db, "nope", { reviewed: true })).toThrow(
      /Unknown transaction/,
    );
    expect(() => setTransactionFlags(bundle.db, a, {})).toThrow(/No flags/);
  });

  test("refuses to edit a superseded row and leaves its active twin untouched", () => {
    const active = insertTxn({});
    const superseded = insertSupersededTwinOf(active);
    expect(() => setTransactionFlags(bundle.db, superseded, { exclude: true })).toThrow(
      /superseded/,
    );
    expect(txn(superseded).status).toBe("superseded");
    expect(txn(active).status).toBe("active");
  });
});

describe("markAllReviewedBefore — the §3.3 amnesty", () => {
  test("clears strictly-before rows only and returns a working undo", () => {
    // Arrange
    const old1 = insertTxn({ postedOn: "2026-05-01", needsReview: true });
    const old2 = insertTxn({ postedOn: "2026-06-14", needsReview: true });
    const boundary = insertTxn({ postedOn: "2026-06-15", needsReview: true });
    insertTxn({ postedOn: "2026-05-01", needsReview: false });

    // Act
    const { affected, undo } = markAllReviewedBefore(bundle.db, "2026-06-15");

    // Assert
    expect(affected).toBe(2);
    expect(txn(old1).needsReview).toBe(false);
    expect(txn(old2).needsReview).toBe(false);
    expect(txn(boundary).needsReview).toBe(true); // on-date row untouched
    applyUndoPatch(bundle.db, undo);
    expect(txn(old1).needsReview).toBe(true);
  });

  test("rejects malformed dates; empty backlog is a clean no-op", () => {
    expect(() => markAllReviewedBefore(bundle.db, "junk")).toThrow(/Invalid date/);
    expect(markAllReviewedBefore(bundle.db, "2026-06-15")).toEqual({
      affected: 0,
      undo: { rows: [] },
    });
  });
});
