import { and, eq, inArray, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { isReplayStatus } from "./derivation";

/**
 * What happens to a resolved duplicate when one of its rows is hard-deleted.
 *
 * A leaf module on purpose: the delete paths live in import/service.ts and
 * manual-transactions.ts, and duplicate-resolution.ts already imports
 * reconcileAccounts FROM import/service.ts, so putting this beside the resolver
 * would make that a cycle.
 */

/**
 * Restore any row that was retired as a duplicate of a row that is ABOUT to be
 * hard-deleted, and return the ids restored.
 *
 * Without this, un-importing the SURVIVOR's file loses the charge outright: the
 * survivor row is deleted, the retired copy stays `superseded`, and the money is
 * then recorded by ZERO live rows — gone from balance replay, from net worth and
 * from every total, with no error and nothing on screen to say so. The owner
 * asked the app to remove one file and it quietly removed a charge that the
 * other file still reports.
 *
 * Must be called with the caller's TRANSACTION handle, before its delete, so
 * the restore and the delete really do stand or fall together. Passing the bare
 * db instead would autocommit each restore while a later failure left the
 * deletes un-run — rows restored beside survivors that were never removed, which
 * is the double count this module exists to prevent.
 */
export function restoreDuplicatesLosingTheirSurvivor(
  db: AppDatabase,
  doomedTransactionIds: readonly string[],
): string[] {
  if (doomedTransactionIds.length === 0) return [];
  const doomed = new Set(doomedTransactionIds);
  const restored: string[] = [];
  const confirmed = db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.resolution, "confirmed_duplicate"))
    .all();
  for (const c of confirmed) {
    const retiredId = c.retiredTransactionId;
    // The retired row is going too — then no money is left to rescue, and the
    // FK's ON DELETE SET NULL will retire the pairing on its own.
    if (retiredId === null || doomed.has(retiredId)) continue;
    const survivorId = retiredId === c.transactionIdA ? c.transactionIdB : c.transactionIdA;
    if (survivorId === null || !doomed.has(survivorId)) continue;
    // Restoring puts the row back inside the partial unique index
    // `ux_transactions_account_dedupe … WHERE status != 'superseded'`, and its
    // slot may have been taken while it was retired — an edited manual row is
    // renumbered over non-superseded rows only, so it can land on exactly this
    // identity. SKIP that candidate rather than throw: the row holding the slot
    // IS this money, so there is nothing to rescue, and throwing here would
    // convert "one restore skipped" into "this file can never be un-imported".
    if (slotTaken(db, retiredId)) continue;
    // 'active' only as the floor for a row retired before retired_from_status
    // existed. A status outside balance replay would put the row back in a state
    // the pair could never have held.
    const restoreTo: TransactionStatus =
      c.retiredFromStatus !== null && isReplayStatus(c.retiredFromStatus)
        ? c.retiredFromStatus
        : "active";
    db.update(transactions).set({ status: restoreTo, needsReview: true }).where(eq(transactions.id, retiredId)).run();
    db.update(duplicateCandidates)
      .set({
        resolution: "unresolved",
        resolvedAt: null,
        retiredTransactionId: null,
        retiredFromStatus: null,
      })
      .where(eq(duplicateCandidates.id, c.id))
      .run();
    restored.push(retiredId);
  }
  return restored;
}

/** Does a live row already hold this retired row's (account, dedupe_hash) slot? */
function slotTaken(db: AppDatabase, retiredId: string): boolean {
  const row = db
    .select({ accountId: transactions.accountId, dedupeHash: transactions.dedupeHash })
    .from(transactions)
    .where(eq(transactions.id, retiredId))
    .get();
  if (!row) return true;
  return (
    db
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
      .get() !== undefined
  );
}

/** The accounts a set of transactions belong to — the rebuild scope after a restore. */
export function accountsOfTransactions(
  db: AppDatabase,
  transactionIds: readonly string[],
): string[] {
  if (transactionIds.length === 0) return [];
  return db
    .selectDistinct({ accountId: transactions.accountId })
    .from(transactions)
    .where(inArray(transactions.id, [...transactionIds]))
    .all()
    .map((r) => r.accountId);
}
