import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { transactions, type CategorizationSource } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { validateSplitDraft, type SplitRow } from "@/lib/transaction-splits";

/**
 * Transaction splitting (docs/future-ideas.md, RocketMoney-style) — the write
 * + batch-read layer over the `transaction_splits` overlay table.
 *
 * A split re-attributes a transaction's amount across categories WITHOUT
 * touching the parent ledger row: no amount/date/description edit, no
 * rebuildAccount, no anchor replay — daily_balances/net worth are untouched
 * because the parts sum exactly to the parent. Only spend/income category
 * analytics change (via activeTxnsInRange's explode).
 */

export interface SplitRecord {
  id: string;
  transactionId: string;
  categoryId: string;
  amountCents: number;
  note: string | null;
  sortOrder: number;
}

export interface SplitLineInput {
  categoryId: string;
  amountCents: number;
  note?: string | null;
}

/** Prior state captured before a split mutation so it can be losslessly undone —
 *  the split rows AND the parent fields the mutation stamps. */
export interface SplitSnapshot {
  transactionId: string;
  lines: { categoryId: string; amountCents: number; note: string | null; sortOrder: number }[];
  parent: {
    needsReview: boolean;
    categoryId: string | null;
    categorizationSource: CategorizationSource | null;
    categorizationConfidence: number | null;
  };
}

/** Ordered splits for one transaction (empty when unsplit). */
export function listSplits(db: AppDatabase, transactionId: string): SplitRecord[] {
  return db
    .select({
      id: transactionSplits.id,
      transactionId: transactionSplits.transactionId,
      categoryId: transactionSplits.categoryId,
      amountCents: transactionSplits.amountCents,
      note: transactionSplits.note,
      sortOrder: transactionSplits.sortOrder,
    })
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, transactionId))
    .orderBy(asc(transactionSplits.sortOrder), asc(transactionSplits.id))
    .all();
}

/** Split part-counts for a set of transactions (0 when unsplit). For the ledger chip. */
export function splitCountsByTxn(db: AppDatabase, txnIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (txnIds.length === 0) return counts;
  const rows = db
    .select({ transactionId: transactionSplits.transactionId, id: transactionSplits.id })
    .from(transactionSplits)
    .where(inArray(transactionSplits.transactionId, [...txnIds]))
    .all();
  for (const r of rows) counts.set(r.transactionId, (counts.get(r.transactionId) ?? 0) + 1);
  return counts;
}

/**
 * All split parts for ACTIVE transactions in the date window, grouped by parent
 * transaction id (ordered). The explode source for activeTxnsInRange — joined on
 * the parent so it shares the exact status/range predicate, scaling without an
 * id-list. Returns an empty map when nothing in range is split.
 */
export function activeSplitsInRange(
  db: AppDatabase,
  from: string,
  to: string,
): Map<string, SplitRow[]> {
  const rows = db
    .select({
      id: transactionSplits.id,
      transactionId: transactionSplits.transactionId,
      categoryId: transactionSplits.categoryId,
      amountCents: transactionSplits.amountCents,
      sortOrder: transactionSplits.sortOrder,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(
      and(
        eq(transactions.status, "active"),
        // a transfer-linked parent is NEVER exploded into its parts — the whole
        // row is handled by the transfer-kind category exclusion, so its splits
        // must not leak back into spend/income (the reverse of the split→transfer
        // block). Keeps analytics correct even if a split row is later marked a
        // transfer by any of the several transferGroupId-setting write paths.
        isNull(transactions.transferGroupId),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .orderBy(asc(transactionSplits.transactionId), asc(transactionSplits.sortOrder))
    .all();

  const byTxn = new Map<string, SplitRow[]>();
  for (const r of rows) {
    const list = byTxn.get(r.transactionId) ?? [];
    list.push({ id: r.id, categoryId: r.categoryId, amountCents: r.amountCents });
    byTxn.set(r.transactionId, list);
  }
  return byTxn;
}

interface ParentState {
  amountCents: number;
  needsReview: boolean;
  transferGroupId: string | null;
  status: string;
  categoryId: string | null;
  categorizationSource: CategorizationSource | null;
  categorizationConfidence: number | null;
}

function loadParent(db: AppDatabase, transactionId: string): ParentState {
  const parent = db
    .select({
      amountCents: transactions.amountCents,
      needsReview: transactions.needsReview,
      transferGroupId: transactions.transferGroupId,
      status: transactions.status,
      categoryId: transactions.categoryId,
      categorizationSource: transactions.categorizationSource,
      categorizationConfidence: transactions.categorizationConfidence,
    })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();
  if (!parent) throw new Error("Unknown transaction");
  return parent;
}

function snapshotOf(db: AppDatabase, parent: ParentState, transactionId: string): SplitSnapshot {
  return {
    transactionId,
    parent: {
      needsReview: parent.needsReview,
      categoryId: parent.categoryId,
      categorizationSource: parent.categorizationSource,
      categorizationConfidence: parent.categorizationConfidence,
    },
    lines: listSplits(db, transactionId).map((s) => ({
      categoryId: s.categoryId,
      amountCents: s.amountCents,
      note: s.note,
      sortOrder: s.sortOrder,
    })),
  };
}

/**
 * The category to stamp on the parent as its display 'primary'. Prefers the
 * largest-magnitude part whose category is a REAL spend/earn kind (expense or
 * income); only if no part is spend/earn does it fall back to the largest part
 * overall. This keeps the parent classified as spending/income for the
 * raw-categoryId readers (the 'spending'/'income' StatCard drill-downs,
 * coverage) AND — critically — avoids stamping a Transfers-kind primary, which
 * would make the whole row look like a transfer to the auto-transfer detector.
 */
function representativeCategoryId(
  lines: readonly SplitLineInput[],
  spendEarnIds: ReadonlySet<string>,
): string {
  const pick = (pool: readonly SplitLineInput[]): SplitLineInput => {
    let best = pool[0]!;
    for (const l of pool) if (Math.abs(l.amountCents) > Math.abs(best.amountCents)) best = l;
    return best;
  };
  const spendEarn = lines.filter((l) => spendEarnIds.has(l.categoryId));
  return pick(spendEarn.length > 0 ? spendEarn : lines).categoryId;
}

/**
 * Replaces a transaction's splits with `lines` (atomically), enforcing the
 * sum/sign/category invariant. Stamps the parent as a categorized, reviewed row
 * (categoryId = the dominant part, source 'user', needsReview off) so every
 * raw-categoryId reader (coverage, categorizeAll, filter tokens) treats it as
 * handled. Returns the PRIOR state so the caller can losslessly undo.
 */
export function setSplits(
  db: AppDatabase,
  transactionId: string,
  lines: readonly SplitLineInput[],
): SplitSnapshot {
  const parent = loadParent(db, transactionId);
  if (parent.status !== "active") throw new Error("Only active transactions can be split.");
  if (parent.transferGroupId !== null) {
    throw new Error("Transfer-linked transactions can't be split — unlink the transfer first.");
  }

  const validation = validateSplitDraft(
    parent.amountCents,
    lines.map((l) => ({ categoryId: l.categoryId, amountCents: l.amountCents })),
  );
  if (!validation.ok) throw new Error(validation.message);

  const uniqueCategoryIds = [...new Set(lines.map((l) => l.categoryId))];
  const known = db
    .select({ id: categories.id, kind: categories.kind })
    .from(categories)
    .where(inArray(categories.id, uniqueCategoryIds))
    .all();
  if (known.length !== uniqueCategoryIds.length) throw new Error("Unknown category in split");

  const prior = snapshotOf(db, parent, transactionId);
  const spendEarnIds = new Set(
    known.filter((c) => c.kind === "expense" || c.kind === "income").map((c) => c.id),
  );
  const primaryCategoryId = representativeCategoryId(lines, spendEarnIds);

  db.transaction((tx) => {
    tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();
    tx.insert(transactionSplits)
      .values(
        lines.map((l, i) => ({
          transactionId,
          categoryId: l.categoryId,
          amountCents: l.amountCents,
          note: l.note ?? null,
          sortOrder: i,
        })),
      )
      .run();
    tx.update(transactions)
      .set({
        categoryId: primaryCategoryId,
        categorizationSource: "user",
        categorizationConfidence: 1,
        needsReview: false,
      })
      .where(eq(transactions.id, transactionId))
      .run();
  });

  return prior;
}

/** Removes all splits from a transaction (un-split). Leaves the parent's stamped
 *  category in place (it is now a real, single category). Returns the PRIOR state. */
export function clearSplits(db: AppDatabase, transactionId: string): SplitSnapshot {
  const parent = loadParent(db, transactionId);
  const prior = snapshotOf(db, parent, transactionId);
  db.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();
  return prior;
}

/** Restores a transaction's splits AND the parent fields to a prior snapshot — the undo. */
export function restoreSplits(db: AppDatabase, snapshot: SplitSnapshot): void {
  db.transaction((tx) => {
    tx.delete(transactionSplits)
      .where(eq(transactionSplits.transactionId, snapshot.transactionId))
      .run();
    if (snapshot.lines.length > 0) {
      tx.insert(transactionSplits)
        .values(
          snapshot.lines.map((l) => ({
            transactionId: snapshot.transactionId,
            categoryId: l.categoryId,
            amountCents: l.amountCents,
            note: l.note,
            sortOrder: l.sortOrder,
          })),
        )
        .run();
    }
    tx.update(transactions)
      .set({
        needsReview: snapshot.parent.needsReview,
        categoryId: snapshot.parent.categoryId,
        categorizationSource: snapshot.parent.categorizationSource,
        categorizationConfidence: snapshot.parent.categorizationConfidence,
      })
      .where(eq(transactions.id, snapshot.transactionId))
      .run();
  });
}

/** True when a transaction has any split parts — the guard other write paths use
 *  to keep split rows and transfers mutually exclusive. */
export function hasSplits(db: AppDatabase, transactionId: string): boolean {
  return (
    db
      .select({ one: transactionSplits.id })
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, transactionId))
      .get() !== undefined
  );
}

/** Of a set of transaction ids, those that have splits (for bulk guards). */
export function splitTxnIdsIn(db: AppDatabase, txnIds: readonly string[]): Set<string> {
  if (txnIds.length === 0) return new Set();
  const rows = db
    .selectDistinct({ transactionId: transactionSplits.transactionId })
    .from(transactionSplits)
    .where(inArray(transactionSplits.transactionId, [...txnIds]))
    .all();
  return new Set(rows.map((r) => r.transactionId));
}

/**
 * Moves a transaction's splits onto a DIFFERENT transaction and carries its
 * stamp — the import takeover uses this with its DIRECT victim→replacement
 * correspondence (the two rows are the same real charge, so the amount, and the
 * sum invariant, are preserved). Must be called inside the import transaction so
 * the move is atomic with the supersede/insert. A no-op when `fromTxnId` is
 * unsplit or `toTxnId` doesn't exist.
 */
export function migrateSplits(db: AppDatabase, fromTxnId: string, toTxnId: string): void {
  const parts = listSplits(db, fromTxnId);
  if (parts.length === 0) return;
  const from = db
    .select({
      categoryId: transactions.categoryId,
      categorizationSource: transactions.categorizationSource,
      categorizationConfidence: transactions.categorizationConfidence,
    })
    .from(transactions)
    .where(eq(transactions.id, fromTxnId))
    .get();
  const to = db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, toTxnId)).get();
  if (!from || !to) return;
  // the destination is a freshly-inserted twin — clear any splits defensively
  db.delete(transactionSplits).where(eq(transactionSplits.transactionId, toTxnId)).run();
  db.delete(transactionSplits).where(eq(transactionSplits.transactionId, fromTxnId)).run();
  db.insert(transactionSplits)
    .values(
      parts.map((s) => ({
        transactionId: toTxnId,
        categoryId: s.categoryId,
        amountCents: s.amountCents,
        note: s.note,
        sortOrder: s.sortOrder,
      })),
    )
    .run();
  db.update(transactions)
    .set({
      categoryId: from.categoryId,
      categorizationSource: from.categorizationSource,
      categorizationConfidence: from.categorizationConfidence,
      needsReview: false,
    })
    .where(eq(transactions.id, toTxnId))
    .run();
}

