import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { duplicateCandidates, type DuplicateResolution } from "@/db/schema/duplicate-candidates";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { descriptionScore } from "@/lib/description-score";
import { todayIso } from "@/lib/dates";
import { isReplayStatus, rebuildAccount } from "./derivation";
// STILL_ASKABLE and openDuplicateCount live in a LEAF module because the root
// layout reads the count on every route and this file reaches the PDF parser
// through ./import/service. Re-exported so the queue and the badge share one
// definition and can never drift apart.
import { openDuplicateCount, STILL_ASKABLE } from "./duplicate-count";
import { flagDuplicateCandidates } from "./duplicate-flags";
// the same "nothing else still asks about it" a re-import asks when it retires a copy again
import { clearReviewIfSettled } from "./duplicate-lifecycle";
import { reconcileAccounts } from "./import/service";
import { hasSplits } from "./transaction-splits";

/**
 * Resolving a duplicate pair — the owner's decision, never the app's.
 *
 * `duplicate-flags.ts` only ever asks the question. This module is the answer,
 * and it has exactly two: the two rows are the same charge (retire one), or they
 * are not (dismiss, and never ask again). Both are reversible; neither deletes.
 *
 * Retiring sets `status = 'superseded'`, which takes the row out of balance
 * replay (derivation.REPLAY_STATUSES) and out of every analytics total, while
 * leaving it in the table. That status is otherwise written only by the
 * importer's takeover path, so the row it retires here is one nothing else will
 * touch — and `retired_from_status` remembers what it was, so undo restores the
 * row the owner had rather than a guess.
 */

/**
 * The guards, all re-checked at RESOLVE time rather than trusted from flag time.
 * A candidate can sit in the queue for weeks, and every one of these can change
 * underneath it: a side can be linked as a transfer, excluded, quarantined, or
 * proved correct by a statement that arrived after the flag.
 */
export class DuplicateResolutionError extends Error {}

const RETIRE = "confirmed_duplicate" satisfies DuplicateResolution;
const DISMISS = "dismissed" satisfies DuplicateResolution;

export const resolveDuplicateSchema = z
  .object({
    candidateId: z.string().min(1),
    decision: z.enum([RETIRE, DISMISS]),
    /** required for 'confirmed_duplicate'; must be one of the pair's two ids */
    retiredTransactionId: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.decision !== RETIRE || v.retiredTransactionId !== undefined, {
    message: "Confirming a duplicate must say which side to retire",
    path: ["retiredTransactionId"],
  });
export type ResolveDuplicateInput = z.infer<typeof resolveDuplicateSchema>;

interface PairSide {
  id: string;
  accountId: string;
  postedOn: string;
  status: TransactionStatus;
  transferGroupId: string | null;
  normalizedDescription: string;
}

function loadSide(db: AppDatabase, id: string): PairSide | undefined {
  return db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      status: transactions.status,
      transferGroupId: transactions.transferGroupId,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
}

/**
 * Has a statement already proved this row's own money correct?
 *
 * `reconcileAccounts` sums EVERY row of an account inside a period's date range
 * — no import-file filter — and compares it to the balances the statement itself
 * prints. A period that comes out `reconciled` has proved to the cent that the
 * money in it is right, so retiring a row from inside one would make the
 * statement stop footing, and the next reconcile would find a gap and quarantine
 * every row of that period's file.
 *
 * The detector's own guard (duplicate-flags.NOT_ALREADY_PROVEN) is deliberately
 * one-sided: it asks the question of `t1` alone. Because the join can pair two
 * rows that agree on `transacted_on` while disagreeing on `posted_on`, a pair can
 * be recorded with one side inside a reconciled period and one side outside it.
 * That is why this has to be asked again here, per side, about the side the owner
 * actually chose to retire.
 */
function isProvenByReconciliation(db: AppDatabase, side: PairSide): boolean {
  const proven = db.get<{ n: number }>(sql`
    SELECT COUNT(*) AS n
      FROM statement_periods p
     WHERE p.account_id = ${side.accountId}
       AND p.reconciliation = 'reconciled'
       AND ${side.postedOn} BETWEEN p.period_start AND p.period_end
  `);
  return (proven?.n ?? 0) > 0;
}

export interface ResolveDuplicateResult {
  resolution: DuplicateResolution;
  retiredTransactionId: string | null;
  accountId: string;
}

/**
 * Record the owner's verdict on one duplicate pair.
 *
 * Not wrapped in a transaction at the top level: the retire branch takes a
 * pre-mutation restore point, and that VACUUMs, which throws inside one
 * (db/backup.ts). The write itself is transactional inside the snapshot.
 */
export function resolveDuplicate(
  db: AppDatabase,
  input: ResolveDuplicateInput,
): ResolveDuplicateResult {
  const parsed = resolveDuplicateSchema.parse(input);
  const candidate = db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.id, parsed.candidateId))
    .get();
  if (!candidate) throw new DuplicateResolutionError("That duplicate is no longer on the list");
  if (candidate.resolution !== "unresolved") {
    throw new DuplicateResolutionError("That duplicate has already been resolved");
  }
  if (candidate.transactionIdA === null || candidate.transactionIdB === null) {
    // One side was hard-deleted (un-import, or a manual row deleted) and the FK
    // set it null. There is no pair left to judge.
    throw new DuplicateResolutionError("One of these transactions no longer exists");
  }

  const a = loadSide(db, candidate.transactionIdA);
  const b = loadSide(db, candidate.transactionIdB);
  if (!a || !b) throw new DuplicateResolutionError("One of these transactions no longer exists");

  if (parsed.decision === DISMISS) {
    db.update(duplicateCandidates)
      .set({ resolution: DISMISS, resolvedAt: todayIso() })
      .where(eq(duplicateCandidates.id, candidate.id))
      .run();
    // No money moved, so no snapshot, no rebuild, no reconcile. The pair_key
    // now carries this answer forward across any future re-import.
    clearReviewIfSettled(db, [a.id, b.id]);
    return { resolution: DISMISS, retiredTransactionId: null, accountId: candidate.accountId };
  }

  const retiredId = parsed.retiredTransactionId;
  if (retiredId !== a.id && retiredId !== b.id) {
    throw new DuplicateResolutionError("That transaction is not part of this pair");
  }
  const retired = retiredId === a.id ? a : b;
  const survivor = retiredId === a.id ? b : a;

  // Every clause of the detector's predicate, asked again about today's rows.
  if (!isReplayStatus(retired.status) || !isReplayStatus(survivor.status)) {
    throw new DuplicateResolutionError(
      "One of these transactions is no longer counted, so there is nothing to de-duplicate",
    );
  }
  if (retired.transferGroupId !== null || survivor.transferGroupId !== null) {
    throw new DuplicateResolutionError(
      "These are linked as a transfer — two sides of one movement are meant to exist twice",
    );
  }
  if (
    retired.normalizedDescription === "" ||
    survivor.normalizedDescription === "" ||
    descriptionScore(retired.normalizedDescription, survivor.normalizedDescription) <= 0
  ) {
    throw new DuplicateResolutionError("These no longer look like the same charge");
  }
  if (isProvenByReconciliation(db, retired)) {
    throw new DuplicateResolutionError(
      "A statement already proves this charge is real — its period reconciles to the cent",
    );
  }
  if (hasSplits(db, retired.id)) {
    throw new DuplicateResolutionError(
      "This transaction is split across categories — undo the split before retiring it",
    );
  }

  withPreMutationSnapshot(db, "retire-duplicate", () => {
    db.transaction((tx) => {
      tx.update(transactions)
        .set({ status: "superseded" })
        .where(eq(transactions.id, retired.id))
        .run();
      tx.update(duplicateCandidates)
        .set({
          resolution: RETIRE,
          resolvedAt: todayIso(),
          retiredTransactionId: retired.id,
          retiredFromStatus: retired.status,
        })
        .where(eq(duplicateCandidates.id, candidate.id))
        .run();
    });
    // Outside the write transaction: each of these opens its own, and a nested
    // BEGIN on a synchronous driver throws.
    //
    // The order is the one every settle path in the app uses (importFile,
    // unimportFile): reconcile first, because it is the last thing that MOVES
    // rows in or out of replay, then rebuild the derived balances, then ask the
    // duplicate question again about whatever the reconcile promoted.
    reconcileAccounts(db, [candidate.accountId]);
    rebuildAccount(db, candidate.accountId);
    clearReviewIfSettled(db, [a.id, b.id]);
    flagDuplicateCandidates(db, [candidate.accountId]);
  });

  return { resolution: RETIRE, retiredTransactionId: retired.id, accountId: candidate.accountId };
}

export const undoDuplicateResolutionSchema = z
  .object({ candidateId: z.string().min(1) })
  .strict();
export type UndoDuplicateResolutionInput = z.infer<typeof undoDuplicateResolutionSchema>;

/**
 * Put back a retired duplicate, or re-open a dismissed one.
 *
 * This exists because nothing else in the app can. `applyUndoPatch` refuses to
 * write `status` back onto a superseded row and refuses to SET 'superseded' at
 * all (bulk-edit.ts), `setTransactionFlags` throws on one, and no transactions
 * view renders one — so without this, retiring would be a silent, unreachable
 * delete from the owner's point of view.
 */
export function undoDuplicateResolution(
  db: AppDatabase,
  input: UndoDuplicateResolutionInput,
): ResolveDuplicateResult {
  const parsed = undoDuplicateResolutionSchema.parse(input);
  const candidate = db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.id, parsed.candidateId))
    .get();
  if (!candidate) throw new DuplicateResolutionError("That duplicate is no longer on the list");
  if (candidate.resolution === "unresolved") {
    throw new DuplicateResolutionError("That duplicate has not been resolved yet");
  }

  if (candidate.resolution === DISMISS) {
    db.update(duplicateCandidates)
      .set({ resolution: "unresolved", resolvedAt: null })
      .where(eq(duplicateCandidates.id, candidate.id))
      .run();
    reflagPair(db, candidate.transactionIdA, candidate.transactionIdB);
    return { resolution: "unresolved", retiredTransactionId: null, accountId: candidate.accountId };
  }

  const retiredId = candidate.retiredTransactionId;
  if (retiredId === null) {
    throw new DuplicateResolutionError("The retired transaction no longer exists");
  }
  const retired = loadSide(db, retiredId);
  if (!retired) throw new DuplicateResolutionError("The retired transaction no longer exists");
  if (retired.status !== "superseded") {
    throw new DuplicateResolutionError("That transaction is already back in your ledger");
  }
  assertRestorable(db, retiredId);

  // 'active' is the fallback only for a row retired before retired_from_status
  // existed; a status outside balance replay would resurrect the row into a
  // state the pair could never have contained.
  const restoreTo: TransactionStatus =
    candidate.retiredFromStatus !== null && isReplayStatus(candidate.retiredFromStatus)
      ? candidate.retiredFromStatus
      : "active";

  withPreMutationSnapshot(db, "restore-duplicate", () => {
    db.transaction((tx) => {
      tx.update(transactions)
        .set({ status: restoreTo })
        .where(eq(transactions.id, retiredId))
        .run();
      tx.update(duplicateCandidates)
        .set({ resolution: "unresolved", resolvedAt: null, retiredTransactionId: null, retiredFromStatus: null })
        .where(eq(duplicateCandidates.id, candidate.id))
        .run();
    });
    reconcileAccounts(db, [candidate.accountId]);
    rebuildAccount(db, candidate.accountId);
    reflagPair(db, candidate.transactionIdA, candidate.transactionIdB);
  });

  return { resolution: "unresolved", retiredTransactionId: null, accountId: candidate.accountId };
}

/**
 * A restored row re-enters the partial unique index
 * `ux_transactions_account_dedupe … WHERE status != 'superseded'`. Two things
 * can have taken its slot while it was retired: a re-import that inserted the
 * same parsed row, or a manual entry, whose occurrence_index is numbered over
 * NON-superseded rows only (manual-transactions.ts) and so can collide with a
 * row that was invisible when the number was handed out. Restoring blind would
 * abort on a UNIQUE violation with a driver-level message.
 */
function assertRestorable(db: AppDatabase, retiredId: string): void {
  const row = db
    .select({ accountId: transactions.accountId, dedupeHash: transactions.dedupeHash })
    .from(transactions)
    .where(eq(transactions.id, retiredId))
    .get();
  if (!row) throw new DuplicateResolutionError("The retired transaction no longer exists");
  const claimed = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, row.accountId),
        eq(transactions.dedupeHash, row.dedupeHash),
        ne(transactions.status, "superseded"),
        ne(transactions.id, retiredId),
      ),
    )
    .get();
  if (claimed) {
    throw new DuplicateResolutionError(
      "Another copy of this transaction is already in your ledger, so putting this one back would double it",
    );
  }
}

/** Re-open the review flag on a pair whose question is live again. */
function reflagPair(db: AppDatabase, a: string | null, b: string | null): void {
  const ids = [a, b].filter((id): id is string => id !== null);
  if (ids.length === 0) return;
  db.update(transactions).set({ needsReview: true }).where(inArray(transactions.id, ids)).run();
}

export interface DuplicatePairRow {
  candidateId: string;
  accountId: string;
  accountName: string;
  reasonDetail: string;
  resolution: DuplicateResolution;
  retiredTransactionId: string | null;
  sides: DuplicatePairSideRow[];
}

export interface DuplicatePairSideRow {
  id: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  description: string;
  status: TransactionStatus;
  /** the statement or file this copy came from — the owner's main way to judge */
  sourceLabel: string;
  /** a statement period proves this side's money; it can be shown but not retired */
  provenByStatement: boolean;
}



interface PairQueryRow {
  candidateId: string;
  accountId: string;
  accountName: string;
  reasonDetail: string;
  resolution: DuplicateResolution;
  retiredTransactionId: string | null;
  transactionIdA: string;
  transactionIdB: string;
}

/**
 * The duplicates queue: unresolved pairs first, then whatever the owner has
 * already settled, so a retired row stays reachable and its undo stays clickable.
 * Pairs missing a side are skipped — a hard-deleted row nulls the FK, and half a
 * pair is not a question anyone can answer.
 */
export function listDuplicatePairs(db: AppDatabase, limit = 100): DuplicatePairRow[] {
  const rows = db.all<PairQueryRow>(sql`
    SELECT d.id                     AS candidateId,
           d.account_id             AS accountId,
           a.name                   AS accountName,
           d.reason_detail          AS reasonDetail,
           d.resolution             AS resolution,
           d.retired_transaction_id AS retiredTransactionId,
           d.transaction_id_a       AS transactionIdA,
           d.transaction_id_b       AS transactionIdB
      FROM duplicate_candidates d
      JOIN accounts a ON a.id = d.account_id
     WHERE d.transaction_id_a IS NOT NULL
       AND d.transaction_id_b IS NOT NULL
       AND ${STILL_ASKABLE}
     ORDER BY CASE d.resolution WHEN 'unresolved' THEN 0 ELSE 1 END,
              d.created_at DESC
     LIMIT ${limit}
  `);
  return rows
    .map((r) => {
      const sides = [r.transactionIdA, r.transactionIdB]
        .map((id) => loadPairSide(db, id))
        .filter((s): s is DuplicatePairSideRow => s !== undefined);
      if (sides.length !== 2) return undefined;
      return {
        candidateId: r.candidateId,
        accountId: r.accountId,
        accountName: r.accountName,
        reasonDetail: r.reasonDetail,
        resolution: r.resolution,
        retiredTransactionId: r.retiredTransactionId,
        sides,
      };
    })
    .filter((p): p is DuplicatePairRow => p !== undefined);
}

interface SideQueryRow {
  id: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  description: string;
  status: TransactionStatus;
  accountId: string;
  sourceLabel: string | null;
}

function loadPairSide(db: AppDatabase, id: string): DuplicatePairSideRow | undefined {
  const row = db.get<SideQueryRow>(sql`
    SELECT t.id               AS id,
           t.posted_on        AS postedOn,
           t.transacted_on    AS transactedOn,
           t.amount_cents     AS amountCents,
           t.raw_description  AS description,
           t.status           AS status,
           t.account_id       AS accountId,
           f.file_name        AS sourceLabel
      FROM transactions t
      LEFT JOIN import_files f ON f.id = t.import_file_id
     WHERE t.id = ${id}
  `);
  if (!row) return undefined;
  return {
    id: row.id,
    postedOn: row.postedOn,
    transactedOn: row.transactedOn,
    amountCents: row.amountCents,
    description: row.description,
    status: row.status,
    // A null import file is a hand-entered row, not an unknown one — saying so
    // is the difference between "you typed this" and "some file did".
    sourceLabel: row.sourceLabel ?? "Entered by hand",
    provenByStatement: isProvenByReconciliation(db, {
      id: row.id,
      accountId: row.accountId,
      postedOn: row.postedOn,
      status: row.status,
      transferGroupId: null,
      normalizedDescription: "",
    }),
  };
}



/** Re-exported from the leaf module so the tab badge and the queue agree. */
export { openDuplicateCount };
