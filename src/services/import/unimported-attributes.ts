import { eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions } from "@/db/schema/transactions";
import { unimportedRowAttributes } from "@/db/schema/unimported-row-attributes";

/**
 * What the owner had set on the rows an un-import deleted, given back when an import writes the same lines again
 * (`unimported_row_attributes`).
 *
 * ⚖️ Owner, 2026-09-16 (decision 18): an un-import → re-import round trip gives back the hand categories, notes and
 * recurring links on the rows it removed — and whatever else the re-parse carry-forward already moves (splits,
 * exclusions) — as it now does for hand-linked transfers (`unimported-transfers`).
 *
 * 🔴 The un-import deleted the rows and everything on them, and the import wrote the lines back bare: on a copy of the
 * real ledger, 2026-09-16 (before the statement-copies backfill, which now keeps that statement's rows under its second
 * download), a round trip of sofi-statement-2025-03.pdf moved 27 rows (−$4,355.96) to Uncategorized, 10 of them
 * categorized by hand and 17 with no recorded source.
 *
 * The record is claimed as the re-parse carry is (`takeCarry`, services/import/service.ts): the same account, amount and
 * day — the day the charge was made first, then the posted day, and never a line that contradicts the day the record
 * says it was made — and, since any later import may claim it, not only the same file's, the same line
 * (`dedupe_hash`) or words that describe the same charge (`descriptionScore` above 0). It lands where the carry lands,
 * and is spent once it has; a record whose line another record absorbs, or no import writes, waits.
 */

export type RememberedInsert = typeof unimportedRowAttributes.$inferInsert;

/** A split part as the record keeps it. */
export interface RememberedSplit {
  categoryId: string;
  amountCents: number;
  note: string | null;
  sortOrder: number;
}

/** A record as an import reads it: every id it names still exists, or is dropped. */
export interface Remembered {
  id: string;
  accountId: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  normalizedDescription: string;
  dedupeHash: string;
  categoryId: string | null;
  categorizationSource: (typeof transactions.$inferSelect)["categorizationSource"];
  categorizationConfidence: number | null;
  merchantId: string | null;
  needsReview: boolean;
  notes: string | null;
  recurringSeriesId: string | null;
  seriesLinkSource: (typeof transactions.$inferSelect)["seriesLinkSource"];
  excluded: boolean;
  splits: RememberedSplit[];
}

/** records per statement — well under SQLite's bound-parameter limit */
const CHUNK = 50;

/** The split parts of each row, as the record keeps them. */
export function splitsOf(tx: AppDatabase, rowIds: readonly string[]): Map<string, RememberedSplit[]> {
  const parts = new Map<string, RememberedSplit[]>();
  for (let i = 0; i < rowIds.length; i += 500) {
    for (const s of tx
      .select()
      .from(transactionSplits)
      .where(inArray(transactionSplits.transactionId, rowIds.slice(i, i + 500)))
      .orderBy(transactionSplits.sortOrder)
      .all()) {
      const part = { categoryId: s.categoryId, amountCents: s.amountCents, note: s.note, sortOrder: s.sortOrder };
      parts.set(s.transactionId, [...(parts.get(s.transactionId) ?? []), part]);
    }
  }
  return parts;
}

/** Keeps what the owner set on rows an un-import is about to delete. Call it inside the un-import's transaction. */
export function rememberRowAttributes(tx: AppDatabase, records: readonly RememberedInsert[]): void {
  for (let i = 0; i < records.length; i += CHUNK) tx.insert(unimportedRowAttributes).values(records.slice(i, i + CHUNK)).run();
}

function idsIn<T extends { id: string }>(rows: T[]): Set<string> {
  return new Set(rows.map((r) => r.id));
}

/**
 * Every record, with what no longer exists taken out: a deleted category (and the splits naming one), merchant or
 * series. A link to a deleted series is no link, and no "not this one" either.
 */
export function rememberedRows(db: AppDatabase): Remembered[] {
  const records = db.select().from(unimportedRowAttributes).all();
  if (records.length === 0) return [];
  const categoryIds = idsIn(db.select({ id: categories.id }).from(categories).all());
  const merchantIds = idsIn(db.select({ id: merchants.id }).from(merchants).all());
  const seriesIds = idsIn(db.select({ id: recurringSeries.id }).from(recurringSeries).all());
  return records.map((r) => {
    const category = r.categoryId !== null && categoryIds.has(r.categoryId);
    // "Uncategorized" picked by hand: no category, and the owner's word that it has none (`applyCorrection`)
    const cleared = r.categoryId === null && r.categorizationSource === "user";
    const series = r.recurringSeriesId !== null && seriesIds.has(r.recurringSeriesId);
    const splits = r.splits === null ? [] : (JSON.parse(r.splits) as RememberedSplit[]);
    return {
      ...r,
      categoryId: category ? r.categoryId : null,
      categorizationSource: category || cleared ? r.categorizationSource : null,
      categorizationConfidence: category || cleared ? r.categorizationConfidence : null,
      needsReview: category ? r.needsReview : false,
      merchantId: r.merchantId !== null && merchantIds.has(r.merchantId) ? r.merchantId : null,
      recurringSeriesId: series ? r.recurringSeriesId : null,
      seriesLinkSource: series || r.recurringSeriesId === null ? r.seriesLinkSource : null,
      splits: splits.every((s) => categoryIds.has(s.categoryId)) ? splits : [],
    };
  });
}

/** A record has been given back. */
export function forgetRemembered(tx: AppDatabase, id: string): void {
  tx.delete(unimportedRowAttributes).where(eq(unimportedRowAttributes.id, id)).run();
}

/** The records of accounts that no longer exist (a brokerage book an un-import removed). */
export function forgetRememberedOn(tx: AppDatabase, accountIds: readonly string[]): void {
  if (accountIds.length === 0) return;
  tx.delete(unimportedRowAttributes).where(inArray(unimportedRowAttributes.accountId, [...accountIds])).run();
}

/**
 * Gives a row back the split parts it had, where it has none and is no transfer (a split and a transfer exclude each
 * other). The parts sum to its amount by construction — the record was claimed on the same money — and are checked.
 */
export function restoreRememberedSplits(tx: AppDatabase, splits: readonly RememberedSplit[], rowId: string): void {
  if (splits.length === 0) return;
  const row = tx.select().from(transactions).where(eq(transactions.id, rowId)).get();
  if (!row || row.transferGroupId !== null) return;
  if (tx.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, rowId)).get()) return;
  if (splits.reduce((n, s) => n + s.amountCents, 0) !== row.amountCents) return;
  tx.insert(transactionSplits)
    .values(splits.map((s) => ({ transactionId: rowId, categoryId: s.categoryId, amountCents: s.amountCents, note: s.note, sortOrder: s.sortOrder })))
    .run();
}
