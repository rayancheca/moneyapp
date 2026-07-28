import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import {
  transactions,
  CATEGORIZATION_SOURCES,
  SERIES_LINK_SOURCES,
  TRANSACTION_STATUSES,
  type TransactionStatus,
} from "@/db/schema/transactions";
import { isValidIsoDate, todayIso } from "@/lib/dates";
import { changesReplayMembership, rebuildAccount } from "./derivation";
import { loadRecomputeCtx, recomputeSeriesStats } from "./recurring";
import { hasSplits, splitTxnIdsIn } from "./transaction-splits";
import { transferCategoryResolver, transferKindCategoryIds } from "./transfer-links";
import { matchingTransactionIds } from "./transactions-query";
import type { TxnFilters, TxnView } from "@/components/transactions/query";

/**
 * Batch mutations with server-captured inverse patches (ux-overhaul-plan
 * §3.0/§3.5). Every bulk operation returns an UndoPatch — the per-row
 * previous values of exactly the fields it touched — so the toast's Undo is
 * a lossless restore, not a guess. Category changes always stamp
 * categorizationSource='user': bulk edits ARE user actions, and the
 * pipeline's precedence (user > everything) then protects them forever.
 *
 * Two invariants these mutations share with the rest of the app:
 * - "Transfer" means ONE thing. Marking a row a transfer stamps the same
 *   Transfers-kind category linkTransferPair stamps, because analytics keys off
 *   category KIND — a row holding only a transfer_group_id still counts as
 *   spending. (Analytics must NEVER key off transfer_group_id itself: a
 *   self-group has no counterparty, and skipping it would hide a real outflow.)
 * - daily_balances is a derived cache that cannot notice its own inputs
 *   changing, so a status flip that moves a row in or out of balance replay
 *   rebuilds that account here (see derivation.REPLAY_STATUSES).
 */

export const txnPatchSchema = z
  .object({
    categoryId: z.string().min(1).optional(),
    /** desired reviewed state: true clears needsReview, false re-flags */
    markReviewed: z.boolean().optional(),
    exclude: z.boolean().optional(),
    restore: z.boolean().optional(),
    markTransfer: z.boolean().optional(),
    clearTransfer: z.boolean().optional(),
  })
  .strict();
export type TxnPatch = z.infer<typeof txnPatchSchema>;

const undoFieldsSchema = z
  .object({
    categoryId: z.string().nullable().optional(),
    categorizationSource: z.enum(CATEGORIZATION_SOURCES).nullable().optional(),
    categorizationConfidence: z.number().nullable().optional(),
    needsReview: z.boolean().optional(),
    status: z.enum(TRANSACTION_STATUSES).optional(),
    transferGroupId: z.string().nullable().optional(),
    merchantId: z.string().nullable().optional(),
    recurringSeriesId: z.string().nullable().optional(),
    seriesLinkSource: z.enum(SERIES_LINK_SOURCES).nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();
export type UndoFields = z.infer<typeof undoFieldsSchema>;

export const undoPatchSchema = z
  .object({
    rows: z.array(z.object({ id: z.string().min(1), prev: undoFieldsSchema }).strict()),
  })
  .strict();
export type UndoPatch = z.infer<typeof undoPatchSchema>;

export interface BulkResult {
  affected: number;
  undo: UndoPatch;
}

interface EffectiveOps {
  categoryId?: string;
  reviewed?: boolean;
  status?: "excluded" | "active";
  transfer?: "mark" | "clear";
}

function effectiveOps(patch: TxnPatch): EffectiveOps {
  if (patch.exclude && patch.restore) {
    throw new Error("exclude and restore are mutually exclusive");
  }
  if (patch.markTransfer && patch.clearTransfer) {
    throw new Error("markTransfer and clearTransfer are mutually exclusive");
  }
  const ops: EffectiveOps = {};
  if (patch.categoryId !== undefined) ops.categoryId = patch.categoryId;
  if (patch.markReviewed !== undefined) ops.reviewed = patch.markReviewed;
  if (patch.exclude) ops.status = "excluded";
  if (patch.restore) ops.status = "active";
  if (patch.markTransfer) ops.transfer = "mark";
  if (patch.clearTransfer) ops.transfer = "clear";
  if (Object.keys(ops).length === 0) throw new Error("Patch has no effect");
  return ops;
}

type TxnUpdate = Partial<typeof transactions.$inferInsert>;

/**
 * better-sqlite3 binds one host parameter per id in an IN(...) list;
 * SQLITE_MAX_VARIABLE_NUMBER is 32766, so the id-select must be chunked or a
 * large ledger throws "too many SQL variables". 500 keeps us far clear.
 */
const ID_SELECT_CHUNK = 500;

export function bulkApply(db: AppDatabase, ids: readonly string[], patch: TxnPatch): BulkResult {
  const ops = effectiveOps(txnPatchSchema.parse(patch));
  if (ids.length === 0) return { affected: 0, undo: { rows: [] } };

  // Superseded rows are excluded: they share account_id+dedupe_hash with an
  // active twin under the partial unique index `WHERE status != 'superseded'`,
  // so flipping one to active/excluded would either resurrect a phantom or
  // trip a UNIQUE violation that aborts the whole transaction. Silently skip
  // them — affected then reflects only real rows.
  const rows: Array<{
    id: string;
    accountId: string;
    categoryId: string | null;
    categorizationSource: (typeof CATEGORIZATION_SOURCES)[number] | null;
    categorizationConfidence: number | null;
    needsReview: boolean;
    status: (typeof TRANSACTION_STATUSES)[number];
    transferGroupId: string | null;
  }> = [];
  for (let start = 0; start < ids.length; start += ID_SELECT_CHUNK) {
    const chunk = ids.slice(start, start + ID_SELECT_CHUNK);
    const chunkRows = db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        categoryId: transactions.categoryId,
        categorizationSource: transactions.categorizationSource,
        categorizationConfidence: transactions.categorizationConfidence,
        needsReview: transactions.needsReview,
        status: transactions.status,
        transferGroupId: transactions.transferGroupId,
      })
      .from(transactions)
      .where(and(inArray(transactions.id, [...chunk]), ne(transactions.status, "superseded")))
      .all();
    rows.push(...chunkRows);
  }

  // A split row's category is driven by its parts, not the parent's stamp, and it
  // can't become a transfer — so a bulk category-set OR transfer-mark must SKIP
  // split rows (recategorizing the whole row from a group action would silently
  // desync the stamp from the parts; the single-row surfaces hide the control).
  const splitIds =
    ops.categoryId !== undefined || ops.transfer === "mark"
      ? splitTxnIdsIn(db, rows.map((r) => r.id))
      : new Set<string>();

  // resolved once for the whole batch (account types + the Transfers categories)
  const transferStamp =
    ops.transfer === "mark"
      ? { categoryFor: transferCategoryResolver(db), alreadyTransfer: transferKindCategoryIds(db) }
      : null;

  const undoRows: UndoPatch["rows"] = [];
  // accounts whose replay membership changed — rebuilt after the write closes
  const staleAccounts = new Set<string>();
  db.transaction((tx) => {
    for (const row of rows) {
      const prev: UndoFields = {};
      const set: TxnUpdate = {};
      if (ops.categoryId !== undefined && !splitIds.has(row.id)) {
        prev.categoryId = row.categoryId;
        prev.categorizationSource = row.categorizationSource;
        prev.categorizationConfidence = row.categorizationConfidence;
        prev.needsReview = row.needsReview;
        set.categoryId = ops.categoryId;
        set.categorizationSource = "user";
        set.categorizationConfidence = 1;
        set.needsReview = false;
      }
      if (ops.reviewed !== undefined) {
        prev.needsReview = row.needsReview;
        set.needsReview = !ops.reviewed;
      }
      if (ops.status !== undefined) {
        prev.status = row.status;
        set.status = ops.status;
      }
      if (ops.transfer !== undefined && !(ops.transfer === "mark" && splitIds.has(row.id))) {
        prev.transferGroupId = row.transferGroupId;
        // mark without a detected pair: a self-group (kept when already
        // grouped) — pairing tuning is a later stage, the flag is honest now
        set.transferGroupId = ops.transfer === "mark" ? (row.transferGroupId ?? row.id) : null;
        // …and the group id alone does not mean "transfer" to analytics, which
        // reads the category's KIND. Stamp the same Transfers category
        // linkTransferPair stamps, or this row keeps counting as spending.
        // Two things outrank the implied category: a categoryId in the same
        // patch (the user named one explicitly) and a transfer-kind category
        // the row already carries (whoever set it saw both legs).
        if (
          transferStamp &&
          ops.categoryId === undefined &&
          !(row.categoryId !== null && transferStamp.alreadyTransfer.has(row.categoryId))
        ) {
          prev.categoryId = row.categoryId;
          prev.categorizationSource = row.categorizationSource;
          prev.categorizationConfidence = row.categorizationConfidence;
          set.categoryId = transferStamp.categoryFor([row.accountId]);
          set.categorizationSource = "user";
          set.categorizationConfidence = 1;
          // an explicit markReviewed in the same patch stays authoritative
          if (ops.reviewed === undefined) {
            prev.needsReview = row.needsReview;
            set.needsReview = false;
          }
        }
      }
      // a row can be a no-op (e.g. a transfer-mark skipped on a split row) — an
      // empty .set({}) throws "No values to set" and would abort the whole batch
      if (Object.keys(set).length === 0) continue;
      tx.update(transactions).set(set).where(eq(transactions.id, row.id)).run();
      undoRows.push({ id: row.id, prev });
      if (set.status !== undefined && changesReplayMembership(row.status, set.status)) {
        staleAccounts.add(row.accountId);
      }
    }
  });

  // OUTSIDE the write transaction: rebuildAccount opens its own, and a nested
  // BEGIN on a synchronous driver throws
  for (const accountId of staleAccounts) rebuildAccount(db, accountId);

  // affected reflects rows actually mutated (skipped split rows don't count)
  return { affected: undoRows.length, undo: { rows: undoRows } };
}

/** Select-all-matching-filter bulk edit — the countMatching set, exactly. */
export function bulkApplyByFilter(
  db: AppDatabase,
  filters: TxnFilters,
  view: TxnView,
  patch: TxnPatch,
): BulkResult {
  return bulkApply(db, matchingTransactionIds(db, filters, view), patch);
}

/**
 * Lossless inverse of a bulk operation. Returns rows restored. Enforces the
 * same superseded invariant as its forward siblings even though the patch is
 * client-supplied (undoPatchSchema validates shape, not business rules): a
 * superseded row is never mutated (WHERE guard), and status is never SET to
 * 'superseded' — a crafted patch must not resurrect a phantom or retire an
 * active twin, which would break the partial unique dedupe index.
 */
export function applyUndoPatch(db: AppDatabase, undo: UndoPatch): number {
  const parsed = undoPatchSchema.parse(undo);
  let restored = 0;
  // restoring a series link must also settle that series' stats — collect
  // every id the patch moves rows INTO plus the ids rows currently sit ON
  const touchedSeriesIds = new Set<string>();
  // Undoing a status restore can move a row back OUT of balance replay
  // (active/excluded → quarantined) — the same invalidation as the forward
  // edit, so read the CURRENT status of exactly those rows first (chunked,
  // like bulkApply's id-select) and rebuild the affected accounts after.
  const beforeStatus = currentStatusOf(
    db,
    parsed.rows.filter((r) => r.prev.status !== undefined).map((r) => r.id),
  );
  const staleAccounts = new Set<string>();
  db.transaction((tx) => {
    for (const row of parsed.rows) {
      const set: TxnUpdate = {};
      if (row.prev.categoryId !== undefined) set.categoryId = row.prev.categoryId;
      if (row.prev.categorizationSource !== undefined)
        set.categorizationSource = row.prev.categorizationSource;
      if (row.prev.categorizationConfidence !== undefined)
        set.categorizationConfidence = row.prev.categorizationConfidence;
      if (row.prev.needsReview !== undefined) set.needsReview = row.prev.needsReview;
      if (row.prev.status !== undefined && row.prev.status !== "superseded")
        set.status = row.prev.status;
      // never restore a transfer link onto a row that has SINCE been split (a
      // stale undo toast from before the split) — it would strand the parts and
      // leak the whole stamped row into spend. Restoring null (unlink) is fine.
      if (
        row.prev.transferGroupId !== undefined &&
        !(row.prev.transferGroupId !== null && hasSplits(tx, row.id))
      ) {
        set.transferGroupId = row.prev.transferGroupId;
      }
      if (row.prev.merchantId !== undefined) set.merchantId = row.prev.merchantId;
      if (row.prev.recurringSeriesId !== undefined) {
        set.recurringSeriesId = row.prev.recurringSeriesId;
        if (row.prev.recurringSeriesId) touchedSeriesIds.add(row.prev.recurringSeriesId);
        const current = tx
          .select({ recurringSeriesId: transactions.recurringSeriesId })
          .from(transactions)
          .where(eq(transactions.id, row.id))
          .get();
        if (current?.recurringSeriesId) touchedSeriesIds.add(current.recurringSeriesId);
      }
      if (row.prev.seriesLinkSource !== undefined) set.seriesLinkSource = row.prev.seriesLinkSource;
      if (row.prev.notes !== undefined) set.notes = row.prev.notes;
      if (Object.keys(set).length === 0) continue;
      const changed = tx
        .update(transactions)
        .set(set)
        .where(and(eq(transactions.id, row.id), ne(transactions.status, "superseded")))
        .run().changes;
      restored += changed;
      const before = beforeStatus.get(row.id);
      if (changed > 0 && set.status !== undefined && before) {
        if (changesReplayMembership(before.status, set.status)) staleAccounts.add(before.accountId);
      }
    }
    if (touchedSeriesIds.size > 0) {
      const ctx = loadRecomputeCtx(db);
      const today = todayIso();
      for (const seriesId of touchedSeriesIds) recomputeSeriesStats(tx, seriesId, today, ctx);
    }
  });
  for (const accountId of staleAccounts) rebuildAccount(db, accountId);
  return restored;
}

/** Chunked {id → account, status} read — the pre-mutation side of a status flip. */
function currentStatusOf(
  db: AppDatabase,
  ids: readonly string[],
): Map<string, { accountId: string; status: TransactionStatus }> {
  const byId = new Map<string, { accountId: string; status: TransactionStatus }>();
  for (let start = 0; start < ids.length; start += ID_SELECT_CHUNK) {
    const chunk = ids.slice(start, start + ID_SELECT_CHUNK);
    const rows = db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        status: transactions.status,
      })
      .from(transactions)
      .where(inArray(transactions.id, [...chunk]))
      .all();
    for (const r of rows) byId.set(r.id, { accountId: r.accountId, status: r.status });
  }
  return byId;
}

export const txnFlagsSchema = z
  .object({
    transfer: z.boolean().optional(),
    exclude: z.boolean().optional(),
    reviewed: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type TxnFlags = z.infer<typeof txnFlagsSchema>;

/** Single-transaction sheet toggles (transfer/exclude/reviewed/notes). */
export function setTransactionFlags(
  db: AppDatabase,
  transactionId: string,
  flags: TxnFlags,
): BulkResult {
  const parsed = txnFlagsSchema.parse(flags);
  const row = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
  if (!row) throw new Error("Unknown transaction");
  // A superseded row is a retired duplicate under the partial unique index;
  // flipping its status/flags would resurrect a phantom or trip a UNIQUE
  // violation against its active twin.
  if (row.status === "superseded") throw new Error("Cannot edit a superseded transaction");

  const prev: UndoFields = {};
  const set: TxnUpdate = {};
  if (parsed.transfer !== undefined) {
    // a split transaction can't also be a transfer (its parts would be stranded)
    if (parsed.transfer && hasSplits(db, transactionId)) {
      throw new Error("Remove the split before marking this transaction a transfer.");
    }
    prev.transferGroupId = row.transferGroupId;
    set.transferGroupId = parsed.transfer ? (row.transferGroupId ?? row.id) : null;
    // same one meaning for "Transfer" as the bulk path and linkTransferPair:
    // analytics reads the category's KIND, so the link alone leaves the row in
    // spending. A transfer-kind category already on the row is left alone (it
    // was set with both legs in view). Clearing the flag keeps the category,
    // exactly like unlinkTransferGroup — dropping the LINK must not fabricate
    // an uncategorized hole; the undo patch is the way back.
    if (parsed.transfer && !(row.categoryId !== null && transferKindCategoryIds(db).has(row.categoryId))) {
      prev.categoryId = row.categoryId;
      prev.categorizationSource = row.categorizationSource;
      prev.categorizationConfidence = row.categorizationConfidence;
      set.categoryId = transferCategoryResolver(db)([row.accountId]);
      set.categorizationSource = "user";
      set.categorizationConfidence = 1;
      if (parsed.reviewed === undefined) {
        prev.needsReview = row.needsReview;
        set.needsReview = false;
      }
    }
  }
  if (parsed.exclude !== undefined) {
    prev.status = row.status;
    set.status = parsed.exclude ? "excluded" : "active";
  }
  if (parsed.reviewed !== undefined) {
    prev.needsReview = row.needsReview;
    set.needsReview = !parsed.reviewed;
  }
  if (parsed.notes !== undefined) {
    prev.notes = row.notes;
    set.notes = parsed.notes;
  }
  if (Object.keys(set).length === 0) throw new Error("No flags provided");

  db.update(transactions).set(set).where(eq(transactions.id, row.id)).run();
  // un-quarantining through the sheet stales this account's replay just as the
  // bulk path does (active ⇄ excluded both replay, so those cost nothing)
  if (set.status !== undefined && changesReplayMembership(row.status, set.status)) {
    rebuildAccount(db, row.accountId);
  }
  return { affected: 1, undo: { rows: [{ id: row.id, prev }] } };
}

/** The §3.3 amnesty: clear the review backlog strictly before a date. */
export function markAllReviewedBefore(db: AppDatabase, before: string): BulkResult {
  if (!isValidIsoDate(before)) throw new Error(`Invalid date "${before}"`);
  const ids = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        eq(transactions.needsReview, true),
        lt(transactions.postedOn, before),
      ),
    )
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return { affected: 0, undo: { rows: [] } };
  return bulkApply(db, ids, { markReviewed: true });
}
