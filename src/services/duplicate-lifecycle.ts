import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { duplicatePairKey, type DuplicatePairSide } from "@/lib/hash";
import { isReplayStatus } from "./derivation";
import { detachTransferLegs, staleTransferLegs } from "./transfer-links";

/**
 * What happens to a resolved duplicate when one of its rows is hard-deleted —
 * and when the row that was deleted comes back.
 *
 * A leaf module on purpose: the delete paths live in import/service.ts and
 * manual-transactions.ts, and duplicate-resolution.ts already imports
 * reconcileAccounts FROM import/service.ts, so putting this beside the resolver
 * would make that a cycle.
 *
 * ⚖️ A confirmed pair is the owner's verdict — "these two rows are one charge,
 * and this one is the copy" — and it outlives the kept row. When the kept row
 * is deleted the copy stands in for it: back in the ledger, the pair still
 * `confirmed_duplicate` and still naming it as retired, its other side NULL
 * (the FK's ON DELETE SET NULL). That shape — a confirmed pair whose retired
 * row is live and whose kept side is gone — is a STAND-IN, and nothing else
 * writes it: a pair re-derived with both rows live is re-opened by the
 * detector, and an undo re-opens it too.
 *
 * 🔴 The restore used to re-open the pair instead ("unresolved", nothing
 * retired). With a NULL side it is on no queue, so the verdict was simply gone,
 * and a re-import of the kept side's statement inserted the line beside the
 * copy. Measured 2026-09-16 on a copy of the real ledger: un-importing and
 * re-importing 20260302-statements-9805-.pdf left its period at `gap`
 * −$798.48 with 9 rows quarantined and `pnpm ledger-check` exit 1 — its four
 * parsed payments are kept sides of card_payment_mirror pairs.
 */

type Row = typeof transactions.$inferSelect;
type Pair = typeof duplicateCandidates.$inferSelect;

/** The side a confirmed pair kept — the one it did not retire; NULL once that row is deleted. */
function keptSideOf(c: Pick<Pair, "retiredTransactionId" | "transactionIdA" | "transactionIdB">): string | null {
  return c.retiredTransactionId === c.transactionIdA ? c.transactionIdB : c.transactionIdA;
}

/** A row as `duplicatePairKey` reads it. The import builds the same shape from the rows it writes. */
export function pairSideOf(row: Pick<Row, "postedOn" | "transactedOn" | "amountCents" | "normalizedDescription">): DuplicatePairSide {
  return {
    postedOn: row.postedOn,
    transactedOn: row.transactedOn,
    amountCents: row.amountCents,
    normalizedDescription: row.normalizedDescription,
  };
}

function rowById(db: AppDatabase, id: string): Row | undefined {
  return db.select().from(transactions).where(eq(transactions.id, id)).get();
}

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
 * The copy takes the kept row's place whole: its money, and its transfer link
 * when it has none of its own — the link belongs to the money, and the partner
 * leg would otherwise be left alone in its group and unlinked (`legsLeftAloneBy`),
 * where `detectTransfers` pairs it with whatever it finds. The pair keeps its
 * verdict (see the module note) and is keyed on the two rows as they are NOW,
 * the content a re-import of the kept row's statement will write: one of the
 * owner's 71 pairs was keyed before a later write moved its kept line.
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
    const survivorId = keptSideOf(c);
    if (survivorId === null || !doomed.has(survivorId)) continue;
    // Restoring puts the row back inside the partial unique index
    // `ux_transactions_account_dedupe … WHERE status != 'superseded'`, and its
    // slot may have been taken while it was retired — an edited manual row is
    // renumbered over non-superseded rows only, so it can land on exactly this
    // identity. SKIP that candidate rather than throw: the row holding the slot
    // IS this money, so there is nothing to rescue, and throwing here would
    // convert "one restore skipped" into "this file can never be un-imported".
    if (slotTaken(db, retiredId)) continue;
    const retired = rowById(db, retiredId);
    const survivor = rowById(db, survivorId);
    if (!retired || !survivor) continue;
    // A superseded kept row records no money: a takeover or a re-parse moved it
    // to another row (which the verdict now names, `moveKeptSide`), or the
    // owner retired it in turn as the copy of a third row, which records the
    // charge. Deleting it takes nothing out of the ledger, so the copy has
    // nothing to stand in for, and restoring it would count the charge twice.
    // A QUARANTINED kept row is not that — its charge is held for a statement's
    // proof, recorded nowhere else — so with its file gone the copy records it,
    // as it would had the file never been imported.
    if (survivor.status === "superseded") continue;
    // 'active' only as the floor for a row retired before retired_from_status
    // existed. A status outside balance replay would put the row back in a state
    // the pair could never have held.
    const restoreTo: TransactionStatus =
      c.retiredFromStatus !== null && isReplayStatus(c.retiredFromStatus)
        ? c.retiredFromStatus
        : "active";
    const takesTheLink = retired.transferGroupId === null && survivor.transferGroupId !== null;
    db.update(transactions)
      .set({
        status: restoreTo,
        needsReview: true,
        ...(takesTheLink ? { transferGroupId: survivor.transferGroupId } : {}),
      })
      .where(eq(transactions.id, retiredId))
      .run();
    db.update(duplicateCandidates)
      .set({ pairKey: duplicatePairKey(c.accountId, pairSideOf(survivor), pairSideOf(retired)) })
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

/** A copy standing in for the kept side of a confirmed pair that left the ledger. */
export interface StandIn {
  candidateId: string;
  pairKey: string;
  copy: Pick<Row, "id" | "postedOn" | "transactedOn" | "amountCents" | "normalizedDescription">;
}

/** Every stand-in on an account, in a fixed order so two runs claim alike. */
export function standInsOn(db: AppDatabase, accountId: string): StandIn[] {
  const pairs = db
    .select()
    .from(duplicateCandidates)
    .where(
      and(
        eq(duplicateCandidates.accountId, accountId),
        eq(duplicateCandidates.resolution, "confirmed_duplicate"),
        isNotNull(duplicateCandidates.retiredTransactionId),
      ),
    )
    .orderBy(duplicateCandidates.id)
    .all();
  const out: StandIn[] = [];
  for (const c of pairs) {
    if (keptSideOf(c) !== null) continue;
    const copy = rowById(db, c.retiredTransactionId!);
    if (!copy || !isReplayStatus(copy.status)) continue;
    out.push({ candidateId: c.id, pairKey: c.pairKey, copy });
  }
  return out;
}

/**
 * Is this row the kept side the stand-in replaced? Exactly the verdict's key —
 * the same day, transaction day, amount and words the kept row had when it
 * left — so a charge that merely shares a day and an amount never qualifies.
 */
function isKeptSideOf(accountId: string, side: DuplicatePairSide, standIn: StandIn): boolean {
  return (
    side.amountCents === standIn.copy.amountCents &&
    duplicatePairKey(accountId, side, pairSideOf(standIn.copy)) === standIn.pairKey
  );
}

/**
 * The stand-ins some of a statement's lines would bring the kept side of. Asked
 * BEFORE the lines land: the importer reads these as already retired, as they
 * were before the un-import, so a same-day copy cannot absorb the very line it
 * was retired for.
 */
export function standInsReturnedBy(
  accountId: string,
  lines: readonly DuplicatePairSide[],
  standIns: readonly StandIn[],
): StandIn[] {
  return standIns.filter((s) => lines.some((line) => isKeptSideOf(accountId, line, s)));
}

/**
 * Pair each stand-in with one freshly written row that is its kept side — each
 * row claimed at most once, in the order given, so a statement that prints two
 * identical lines retires one copy for one of them and leaves the other line a
 * charge of its own.
 */
export function claimKeptSides(
  accountId: string,
  rows: readonly Pick<Row, "id" | "postedOn" | "transactedOn" | "amountCents" | "normalizedDescription">[],
  standIns: readonly StandIn[],
): { standIn: StandIn; keptId: string }[] {
  const taken = new Set<string>();
  const claims: { standIn: StandIn; keptId: string }[] = [];
  for (const standIn of standIns) {
    const kept = rows.find((r) => !taken.has(r.id) && isKeptSideOf(accountId, pairSideOf(r), standIn));
    if (!kept) continue;
    taken.add(kept.id);
    claims.push({ standIn, keptId: kept.id });
  }
  return claims;
}

/**
 * The kept side is back: retire its copy again, as the verdict said. The copy's
 * transfer link returns to the kept row when that row has none (a superseded
 * row is no transfer leg), and a partner the copy's leaving would leave alone
 * is unlinked, as `detectTransfers` pairs only unlinked rows. The pair names
 * the new row, and the copy leaves the review queue unless another open pair
 * still asks about it — what resolving a pair does.
 *
 * Call it with the transaction that wrote the kept row, so no reader ever sees
 * the charge twice.
 */
export function retireStandIn(db: AppDatabase, accountId: string, standIn: StandIn, keptId: string): void {
  const copy = rowById(db, standIn.copy.id);
  const kept = rowById(db, keptId);
  if (!copy || !kept || !isReplayStatus(copy.status)) return;
  db.update(transactions)
    .set({ status: "superseded", transferGroupId: null })
    .where(eq(transactions.id, copy.id))
    .run();
  if (copy.transferGroupId !== null) {
    if (kept.transferGroupId === null) {
      db.update(transactions).set({ transferGroupId: copy.transferGroupId }).where(eq(transactions.id, kept.id)).run();
    } else {
      const left = staleTransferLegs(db, copy.transferGroupId);
      if (left.length === 1) detachTransferLegs(db, left);
    }
  }
  const [a, b] = [kept.id, copy.id].sort() as [string, string];
  db.update(duplicateCandidates)
    .set({
      transactionIdA: a,
      transactionIdB: b,
      retiredFromStatus: copy.status,
      pairKey: duplicatePairKey(accountId, pairSideOf(kept), pairSideOf(copy)),
    })
    .where(eq(duplicateCandidates.id, standIn.candidateId))
    .run();
  clearReviewIfSettled(db, [copy.id]);
}

/** Confirmed pairs that keep this row — it is their kept side, not their retired one. */
function pairsKeeping(db: AppDatabase, ids: readonly string[]): Pair[] {
  if (ids.length === 0) return [];
  const set = new Set(ids);
  return db
    .select()
    .from(duplicateCandidates)
    .where(
      and(
        eq(duplicateCandidates.resolution, "confirmed_duplicate"),
        isNotNull(duplicateCandidates.retiredTransactionId),
        or(inArray(duplicateCandidates.transactionIdA, [...ids]), inArray(duplicateCandidates.transactionIdB, [...ids])),
      ),
    )
    .all()
    .filter((c) => {
      const kept = keptSideOf(c);
      return kept !== null && set.has(kept);
    });
}

/** Which of these rows a confirmed duplicate keeps — a re-parse must hand that on like any user-set attribute. */
export function keptSidesAmong(db: AppDatabase, ids: readonly string[]): Set<string> {
  return new Set(pairsKeeping(db, ids).map((c) => keptSideOf(c)!));
}

/**
 * A re-parse or a takeover moved a kept row's money onto its successor: the
 * verdict follows it. (An owner's retire does not: the row it retires is the
 * copy in a second verdict, and the first verdict stays on it —
 * `restoreDuplicatesLosingTheirSurvivor` skips a superseded kept row.)
 *
 * 🔴 It stayed on the superseded row. A parser-version re-parse of
 * 20260302-statements-9805-.pdf carried its four payments' links onto the new
 * rows, and the four pairs went on naming the old ones — so un-importing the
 * new version deleted the payments and restored nothing, and the ledger
 * recorded them nowhere: `pnpm ledger-check` found 2026-01-02 → 2026-04-02 off
 * by $798.48 (a copy of the real ledger, 2026-09-16). A takeover left it on
 * its victim too, so un-importing the taken-over export restored the copy
 * beside the row that had taken over: the charge counted twice.
 *
 * `toId` is a live row and a confirmed pair's copy is superseded, so the
 * successor is never the copy, and no other pair can already name the two.
 */
export function moveKeptSide(db: AppDatabase, fromId: string, toId: string): void {
  for (const c of pairsKeeping(db, [fromId])) {
    const [a, b] = [toId, c.retiredTransactionId!].sort() as [string, string];
    db.update(duplicateCandidates)
      .set({ transactionIdA: a, transactionIdB: b })
      .where(eq(duplicateCandidates.id, c.id))
      .run();
  }
}

/**
 * Clear `needs_review` on a row only when nothing else is still asking about it.
 *
 * Retiring one side used to leave the SURVIVOR flagged forever: it drops out of
 * the duplicates queue (its partner is gone) but stays in the review queue with
 * no partner and no reason — an orphan the owner cannot act on or explain.
 */
export function clearReviewIfSettled(db: AppDatabase, ids: readonly string[]): void {
  for (const id of ids) {
    const stillOpen = db
      .select({ id: duplicateCandidates.id })
      .from(duplicateCandidates)
      .where(
        and(
          eq(duplicateCandidates.resolution, "unresolved"),
          or(eq(duplicateCandidates.transactionIdA, id), eq(duplicateCandidates.transactionIdB, id)),
        ),
      )
      .get();
    if (stillOpen) continue;
    db.update(transactions).set({ needsReview: false }).where(eq(transactions.id, id)).run();
  }
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
