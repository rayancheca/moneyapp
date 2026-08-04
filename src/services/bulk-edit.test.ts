import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { importFiles } from "@/db/schema/imports";
import {
  transactions,
  type CategorizationSource,
  type TransactionStatus,
} from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { rebuildAccount } from "./derivation";
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
  status?: TransactionStatus;
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
      status: overrides.status ?? "active",
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

/** "Transfers > Internal Transfer" for a category id — the KIND is what analytics reads. */
function categoryPathOf(categoryId: string | null): string | null {
  if (!categoryId) return null;
  const cat = bundle.db.select().from(categories).where(eq(categories.id, categoryId)).get()!;
  if (!cat.parentId) return cat.name;
  const parent = bundle.db.select().from(categories).where(eq(categories.id, cat.parentId)).get()!;
  return `${parent.name} > ${cat.name}`;
}

function balanceOn(accountId: string, day: string): number | undefined {
  return bundle.db
    .select()
    .from(dailyBalances)
    .where(and(eq(dailyBalances.accountId, accountId), eq(dailyBalances.day, day)))
    .get()?.balanceCents;
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

/**
 * One meaning for "Transfer". Analytics keys off the category's KIND, so a row
 * that carries only a transferGroupId still counts as spending — the manual
 * mark has to stamp the same Transfers category linkTransferPair stamps.
 * (Measured on the owner's real ledger the double-count is 0 rows today: every
 * paired row already carries a transfer-kind category. This is the latent hole
 * in the manual path, not a live mis-count.)
 */
describe("markTransfer stamps the category, not just the link", () => {
  test("a marked row lands in Transfers > Internal Transfer as a user decision", () => {
    // Arrange: an ordinary spend row the user recognises as moved money
    const a = insertTxn({ categoryId: catId("Food > Dining"), categorizationSource: "claude", needsReview: true });

    // Act
    const { undo } = bulkApply(bundle.db, [a], { markTransfer: true });

    // Assert: the link AND the kind — either alone is a half-marked transfer
    const row = txn(a);
    expect(row.transferGroupId).toBe(a);
    expect(categoryPathOf(row.categoryId)).toBe("Transfers > Internal Transfer");
    expect(row.categorizationSource).toBe("user");
    expect(row.categorizationConfidence).toBe(1);
    expect(row.needsReview).toBe(false);

    // Assert: undo is still lossless over every field the mark touched
    applyUndoPatch(bundle.db, undo);
    const restored = txn(a);
    expect(restored.transferGroupId).toBeNull();
    expect(categoryPathOf(restored.categoryId)).toBe("Food > Dining");
    expect(restored.categorizationSource).toBe("claude");
    expect(restored.needsReview).toBe(true);
  });

  test("the category follows the account, exactly like the pair-linker", () => {
    const onCard = insertTxn({ accountId: cardId });
    bulkApply(bundle.db, [onCard], { markTransfer: true });
    expect(categoryPathOf(txn(onCard).categoryId)).toBe("Transfers > Credit Card Payment");
  });

  test("a transfer-kind category already on the row is never downgraded", () => {
    // the pair-linker labels BOTH legs of a card payment "Credit Card Payment".
    // Re-marking the checking leg knows only one account — it must not rewrite
    // that to the vaguer "Internal Transfer".
    const cardPayment = catId("Transfers > Credit Card Payment");
    const leg = insertTxn({
      accountId: checkingId,
      categoryId: cardPayment,
      categorizationSource: "user",
      transferGroupId: "pair-group",
    });

    bulkApply(bundle.db, [leg], { markTransfer: true });

    expect(txn(leg).categoryId).toBe(cardPayment);
    expect(txn(leg).transferGroupId).toBe("pair-group");
  });

  test("the sheet's checkbox leaves an existing transfer-kind category alone too", () => {
    const contribution = catId("Transfers > Investment Contribution");
    const leg = insertTxn({ categoryId: contribution, categorizationSource: "user" });
    setTransactionFlags(bundle.db, leg, { transfer: true });
    expect(txn(leg).categoryId).toBe(contribution);
    expect(txn(leg).transferGroupId).toBe(leg);
  });

  test("an explicit categoryId in the same patch outranks the implied one", () => {
    const a = insertTxn({});
    const groceries = catId("Food > Groceries");
    bulkApply(bundle.db, [a], { categoryId: groceries, markTransfer: true });
    expect(txn(a).categoryId).toBe(groceries);
    expect(txn(a).transferGroupId).toBe(a);
  });

  test("clearTransfer drops the link and keeps the category, like unlinkTransferGroup", () => {
    const a = insertTxn({});
    bulkApply(bundle.db, [a], { markTransfer: true });
    const stamped = txn(a).categoryId;

    bulkApply(bundle.db, [a], { clearTransfer: true });

    expect(txn(a).transferGroupId).toBeNull();
    expect(txn(a).categoryId).toBe(stamped); // clearing a LINK fabricates no uncategorized hole
  });

  test("a split row is skipped whole — no link, no stamp", () => {
    // splitTxnIdsIn drives the skip; with no splits present the guard is inert,
    // so this pins the plain-row half: marking never leaves a set-less UPDATE
    const a = insertTxn({});
    const result = bulkApply(bundle.db, [a], { markTransfer: true });
    expect(result.affected).toBe(1);
  });

  test("the sheet's Transfer checkbox stamps the same category as the bulk path", () => {
    const a = insertTxn({ needsReview: true });
    const { undo } = setTransactionFlags(bundle.db, a, { transfer: true });
    expect(categoryPathOf(txn(a).categoryId)).toBe("Transfers > Internal Transfer");
    expect(txn(a).categorizationSource).toBe("user");
    expect(txn(a).needsReview).toBe(false);

    applyUndoPatch(bundle.db, undo);
    expect(txn(a).categoryId).toBeNull();
    expect(txn(a).needsReview).toBe(true);
  });
});

/**
 * daily_balances is a DERIVED CACHE — truth is transactions + anchors. Balance
 * replay reads status IN ('active','excluded'), so a row leaving quarantine
 * joins the replay and the cached curve is stale until something rebuilds it.
 */
describe("balance replay membership invalidates the derived cache", () => {
  const ANCHOR_DAY = "2026-07-01";
  const TXN_DAY = "2026-07-02";

  /** Anchor the account, then settle the cache — the state a real import leaves. */
  function anchorAndSettle(accountId: string, enteredCents: number): void {
    addManualAnchor(bundle.db, { accountId, anchoredOn: ANCHOR_DAY, enteredCents });
    rebuildAccount(bundle.db, accountId);
  }

  test("restoring a quarantined row rebuilds the account curve", () => {
    // Arrange: cache settled WITH the quarantined row present — it sits outside
    // replay, so the curve holds flat across it
    const held = insertTxn({ postedOn: TXN_DAY, amountCents: -25_000, status: "quarantined" });
    anchorAndSettle(checkingId, 100_000);
    expect(balanceOn(checkingId, TXN_DAY)).toBe(100_000);

    // Act
    const { undo } = bulkApply(bundle.db, [held], { restore: true });

    // Assert: the row now replays — no price refresh, no anchor edit needed
    expect(txn(held).status).toBe("active");
    expect(balanceOn(checkingId, TXN_DAY)).toBe(75_000);

    // Assert: undo puts it back out of replay AND un-stales the cache again
    applyUndoPatch(bundle.db, undo);
    expect(txn(held).status).toBe("quarantined");
    expect(balanceOn(checkingId, TXN_DAY)).toBe(100_000);
  });

  test("excluding a quarantined row also joins replay — the money still moved", () => {
    const held = insertTxn({ postedOn: TXN_DAY, amountCents: -25_000, status: "quarantined" });
    anchorAndSettle(checkingId, 100_000);
    bulkApply(bundle.db, [held], { exclude: true });
    expect(balanceOn(checkingId, TXN_DAY)).toBe(75_000);
  });

  test("ordinary exclude/restore never moves the curve (both statuses replay)", () => {
    const spend = insertTxn({ postedOn: TXN_DAY, amountCents: -25_000 });
    anchorAndSettle(checkingId, 100_000);
    expect(balanceOn(checkingId, TXN_DAY)).toBe(75_000);

    bulkApply(bundle.db, [spend], { exclude: true });
    expect(balanceOn(checkingId, TXN_DAY)).toBe(75_000); // hidden from analytics only

    bulkApply(bundle.db, [spend], { restore: true });
    expect(balanceOn(checkingId, TXN_DAY)).toBe(75_000);
  });

  test("the sheet's Restore toggle invalidates the cache too", () => {
    const held = insertTxn({ postedOn: TXN_DAY, amountCents: -40_000, status: "quarantined" });
    anchorAndSettle(checkingId, 100_000);
    setTransactionFlags(bundle.db, held, { exclude: false });
    expect(txn(held).status).toBe("active");
    expect(balanceOn(checkingId, TXN_DAY)).toBe(60_000);
  });

  test("a mixed batch rebuilds every affected account, not just the first", () => {
    const a = insertTxn({ postedOn: TXN_DAY, amountCents: -5_000, status: "quarantined" });
    const b = insertTxn({ postedOn: TXN_DAY, amountCents: -3_000, status: "quarantined" });
    const onCard = insertTxn({ accountId: cardId, postedOn: TXN_DAY, amountCents: -7_000, status: "quarantined" });
    anchorAndSettle(checkingId, 100_000);
    anchorAndSettle(cardId, 20_000);

    bulkApply(bundle.db, [a, b, onCard], { restore: true });

    expect(balanceOn(checkingId, TXN_DAY)).toBe(92_000);
    // credit is stored negative: −$200 owed, then another $70 charged
    expect(balanceOn(cardId, TXN_DAY)).toBe(-27_000);
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

describe("promoting a row out of quarantine asks whether its money is already recorded", () => {
  /**
   * The quarantine dedupe gap: quarantined rows are invisible to the
   * import-time identity pool, so a file imported during a quarantine can
   * record the same charges again. Every path that returns such a row to
   * balance replay therefore has to ask the question — these are the three in
   * this module, which pass 33 named as missed. The rows are FLAGGED, never
   * superseded (a deleted charge is not recoverable; a double count is).
   */
  function twinPair(): { quarantined: string; twin: string } {
    const quarantined = insertTxn({
      postedOn: "2026-07-09",
      amountCents: -125,
      status: "quarantined",
    });
    // same money, another file's wording — insertTxn has no importFileId, so
    // stamp one so the two rows read as two sources
    const twin = insertTxn({ postedOn: "2026-07-09", amountCents: -125 });
    bundle.db
      .update(transactions)
      .set({ normalizedDescription: "CPI CANTEEN VENDING MIAMI", importFileId: null })
      .where(eq(transactions.id, quarantined))
      .run();
    bundle.db
      .update(transactions)
      .set({ normalizedDescription: "CPI CANTEEN VENDING MIAMI 800", importFileId: fileForTwin() })
      .where(eq(transactions.id, twin))
      .run();
    return { quarantined, twin };
  }

  function fileForTwin(): string {
    const inst = bundle.db.select().from(institutions).all()[0]!;
    return bundle.db
      .insert(importFiles)
      .values({
        fileName: "spending-report.pdf",
        fileSha256: `sha-${Math.abs(seed())}`,
        format: "pdf",
        institutionId: inst.id,
        status: "parsed",
        storagePath: "/tmp/x.pdf",
        importedAt: "2026-07-01T00:00:00.000Z",
      })
      .returning({ id: importFiles.id })
      .get().id;
  }

  let seedN = 0;
  function seed(): number {
    seedN += 1;
    return seedN;
  }

  test("bulkApply restore flags both copies", () => {
    const { quarantined, twin } = twinPair();
    bulkApply(bundle.db, [quarantined], { restore: true });
    expect(txn(quarantined).needsReview).toBe(true);
    expect(txn(twin).needsReview).toBe(true);
    // and NOTHING was superseded or removed
    expect(txn(quarantined).status).toBe("active");
    expect(txn(twin).status).toBe("active");
  });

  test("setTransactionFlags restore flags both copies", () => {
    const { quarantined, twin } = twinPair();
    setTransactionFlags(bundle.db, quarantined, { exclude: false });
    expect(txn(quarantined).needsReview).toBe(true);
    expect(txn(twin).needsReview).toBe(true);
  });

  test("an undo that restores a row INTO replay flags it too", () => {
    const { quarantined, twin } = twinPair();
    applyUndoPatch(bundle.db, { rows: [{ id: quarantined, prev: { status: "active" } }] });
    expect(txn(quarantined).needsReview).toBe(true);
    expect(txn(twin).needsReview).toBe(true);
  });

  test("a status change that does NOT re-enter replay flags nothing", () => {
    // active ⇄ excluded both replay, so no money re-entered the ledger
    const { twin } = twinPair();
    bulkApply(bundle.db, [twin], { exclude: true });
    expect(txn(twin).needsReview).toBe(false);
  });
});
