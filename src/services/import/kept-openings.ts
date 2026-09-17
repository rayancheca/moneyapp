import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { KEPT_OPENING_SOURCE, balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { addDays } from "@/lib/dates";
import type { PrinterHandOver } from "./printed-lines";

/**
 * ⚖️ Owner decision (20), 2026-09-17 — the opening balance an un-imported statement printed, kept.
 *
 * Un-importing a statement whose rows stay under another still-imported file (`printed-lines`) and which leaves the
 * account with NO recorded balance keeps the OPENING balance that statement printed, as a `balance_anchors` row of
 * source `unimported_statement` owned by the file that keeps the rows. The kept rows replay from it, so net worth does
 * not move; every day it carries is `derived_unverified` (`deriveDailyRows`), so nothing reads it as checked.
 *
 * - Only an opening the statement PRINTED: its own period's beginning balance, on the day before the period opens —
 *   never a closing, never a zero nobody printed. A file with no printed period (an export, an OFX) keeps nothing.
 * - Only for an account left with nothing: an account that keeps any other recorded balance keeps no opening.
 * - Only for rows another file keeps: a statement whose rows all leave with it keeps nothing.
 * - Never for an investment account: its rows do not move a recorded value.
 * - It goes when a document records the day again (`replaceKeptOpening` — importing the statement again), and when the
 *   account is left with no live row at all: the file that holds it is un-imported (`removeFileBalances` deletes the
 *   anchors a file owns) or read again at a version that writes nothing there (`settleKeptOpenings`). While ANY file
 *   keeps a live row on the account the opening goes to that file — the one that prints the holder's own rows first
 *   (`heirsByAccount`), else the one that keeps the most of the account's rows (`keeperOfRows`).
 * - A re-read that stops reading an account keeps the opening its retired read printed, as un-importing that read
 *   would (`retiredOpenings`, `keepRetiredOpenings`).
 *
 * 🔴 Un-importing 2026-08-25-everyday-checking.pdf kept Wells Fargo Everyday Checking's 39 rows under
 * rocket-money-export-2026-08-25.csv and took both of its balances, and a balance is derived only from a recorded
 * one: net worth fell 11,312,501 → 11,072,834 cents (a backfilled copy of the real ledger, 2026-09-16).
 */

/** The opening an account keeps if the un-import leaves it no recorded balance. */
export interface KeptOpeningPlan {
  accountId: string;
  /** the day before the statement's period opens — where the import recorded the opening */
  day: string;
  balanceCents: number;
  /** the still-imported file that keeps the most of the statement's rows on the account; it owns the kept opening */
  heirFileId: string;
}

/**
 * Per account the un-import of `fileId` hands rows to another file on (`printers`): the opening its oldest own
 * printed period recorded, and the heir that will own it. Periods in `handedPeriodIds` go to another download of the
 * statement (`statement-copies`) and are not the file's to keep an opening of. Read before the file's periods go.
 */
export function keptOpeningPlans(
  db: AppDatabase,
  fileId: string,
  printers: readonly PrinterHandOver[],
  handedPeriodIds: ReadonlySet<string> = new Set(),
): KeptOpeningPlan[] {
  const plans: KeptOpeningPlan[] = [];
  for (const [accountId, heirFileId] of heirsByAccount(fileId, printers)) {
    const account = db.select({ type: accounts.type }).from(accounts).where(eq(accounts.id, accountId)).get();
    if (account === undefined || account.type === "investment") continue;
    const opening = db
      .select({ id: statementPeriods.id, periodStart: statementPeriods.periodStart, begin: statementPeriods.beginningBalanceCents })
      .from(statementPeriods)
      .where(
        and(
          eq(statementPeriods.importFileId, fileId),
          eq(statementPeriods.accountId, accountId),
          isNotNull(statementPeriods.beginningBalanceCents),
          isNotNull(statementPeriods.endingBalanceCents),
        ),
      )
      .orderBy(asc(statementPeriods.periodStart), asc(statementPeriods.id))
      .all()
      .find((p) => !handedPeriodIds.has(p.id));
    if (opening === undefined || opening.begin === null) continue;
    plans.push({ accountId, day: addDays(opening.periodStart, -1), balanceCents: opening.begin, heirFileId });
  }
  return plans;
}

/** A file still imported — its rows are in the ledger. */
const LIVE_FILE = ["parsed", "parsed_with_claude"] as const;
/** A row still in the ledger. */
const LIVE_ROW = ["active", "quarantined", "excluded"] as const;

/**
 * Where no file prints the rows of the file the opening leaves with (`heirsByAccount`): the still-imported file that
 * keeps the most parsed rows on the account once `going`'s are gone — the lower id on a tie, the same choice. The rows
 * a removal hands to a file that prints them are already filed under it when this is read (`handOverToPrinters`,
 * `settleHeldRows`); a row filed by hand under a file is not the file's to keep, and counts for none.
 *
 * ⚖️ Owner decision 20: an account that keeps live rows and records no balance keeps the opening, and an anchor is
 * owned by a file. A file a read is writing is not `parsed` until the whole read is (`markParsed`, called after this),
 * so it is never the keeper; a caller that must not name it says so in `going` too, and does not lean on that order.
 * 🔴 The opening was deleted with the file that held it whenever no file printed THAT file's rows,
 * though another download kept the account's rows: un-importing one half of a split export left Wells Fargo Everyday
 * Checking with 19 rows, no balance and net worth 11,312,501 → 11,072,834 cents; a re-read of that half at a version
 * that reads nothing did the same, with nothing in the upload outcome (the review of uc/final-integrate, 2026-09-17).
 */
export function keeperOfRows(db: AppDatabase, accountId: string, going: readonly string[]): string | undefined {
  const rows = new Map<string, number>();
  for (const r of db
    .select({ fileId: transactions.importFileId, n: count() })
    .from(transactions)
    .innerJoin(importFiles, eq(importFiles.id, transactions.importFileId))
    .where(
      and(
        eq(transactions.accountId, accountId),
        inArray(transactions.status, [...LIVE_ROW]),
        isNull(transactions.fileLinkSource),
        inArray(importFiles.status, [...LIVE_FILE]),
      ),
    )
    .groupBy(transactions.importFileId)
    .all()) {
    if (r.fileId !== null && !going.includes(r.fileId)) rows.set(r.fileId, r.n);
  }
  return [...rows].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * Per account where `printers` keep rows of `fileId`: the file that keeps the most of them — the lower id on a tie. ONE
 * choice of who owns a kept opening, for an opening kept and for one that follows its rows. Where no file prints them,
 * the caller falls back to the file that keeps the account's other rows (`keeperOfRows`).
 */
export function heirsByAccount(fileId: string, printers: readonly PrinterHandOver[]): Map<string, string> {
  const heirs = new Map<string, { heirFileId: string; rows: number }>();
  for (const p of printers) {
    if (p.fromFileId !== fileId || p.rowIds.length === 0) continue;
    const best = heirs.get(p.accountId);
    const better = !best || p.rowIds.length > best.rows || (p.rowIds.length === best.rows && p.heirFileId < best.heirFileId);
    if (better) heirs.set(p.accountId, { heirFileId: p.heirFileId, rows: p.rowIds.length });
  }
  return new Map([...heirs].map(([accountId, h]) => [accountId, h.heirFileId] as const));
}

/** An opening a file keeps for a statement he un-imported, and the file its rows go to. */
export interface FollowingOpening extends KeptOpeningPlan {
  anchorId: string;
  /** the file that holds the opening now */
  fromFileId: string;
}

/**
 * Per file: the openings it keeps for a statement he un-imported (`keepOpenings`) that follow its rows when it is
 * un-imported — to the file that keeps the most of them on the account (`printers`, `heirsByAccount`), or, where no
 * file prints them, to the one that keeps the account's other rows (`keeperOfRows`). An opening on an account where NO
 * live row stays is not here: it goes with the file (`removeFileBalances`). Read-only — ONE plan for the un-import and
 * for its /imports confirmation.
 */
export function followingOpeningsByFile(
  db: AppDatabase,
  printers: ReadonlyMap<string, readonly PrinterHandOver[]>,
): Map<string, FollowingOpening[]> {
  const byFile = new Map<string, FollowingOpening[]>();
  const kept = db
    .select({
      anchorId: balanceAnchors.id,
      accountId: balanceAnchors.accountId,
      day: balanceAnchors.anchoredOn,
      balanceCents: balanceAnchors.balanceCents,
      fromFileId: balanceAnchors.importFileId,
    })
    .from(balanceAnchors)
    .where(and(eq(balanceAnchors.source, KEPT_OPENING_SOURCE), isNotNull(balanceAnchors.importFileId)))
    .orderBy(asc(balanceAnchors.id))
    .all();
  for (const opening of kept) {
    const fromFileId = opening.fromFileId!;
    const printed = printers.get(fromFileId) ?? [];
    const heirFileId =
      heirsByAccount(fromFileId, printed).get(opening.accountId) ?? keeperOfRows(db, opening.accountId, [fromFileId]);
    if (heirFileId === undefined) continue;
    byFile.set(fromFileId, [...(byFile.get(fromFileId) ?? []), { ...opening, fromFileId, heirFileId }]);
  }
  return byFile;
}

/**
 * Files each following opening under the file its rows go to. Call it inside the un-import's transaction, before the
 * file's balances are removed.
 *
 * 🔴 An opening kept for an un-imported statement went with the file that held it, though its rows stayed under
 * another file that prints them: un-importing the Rocket Money export after the Wells Fargo statement, with the export
 * downloaded twice, kept the 39 rows and took Wells Fargo out of net worth (the review of uc/final-integrate, 2026-09-17).
 */
export function handOverKeptOpenings(tx: AppDatabase, following: readonly FollowingOpening[]): void {
  for (const opening of following) {
    tx.update(balanceAnchors)
      .set({ importFileId: opening.heirFileId })
      .where(and(eq(balanceAnchors.id, opening.anchorId), eq(balanceAnchors.source, KEPT_OPENING_SOURCE)))
      .run();
  }
}

/**
 * After the un-import removed the file's balances: each planned account that records no balance any more keeps its
 * opening, under the heir. Returns the accounts that kept one.
 */
export function keepOpenings(tx: AppDatabase, plans: readonly KeptOpeningPlan[]): string[] {
  const kept: string[] = [];
  for (const plan of plans) {
    const left = tx.select({ n: count() }).from(balanceAnchors).where(eq(balanceAnchors.accountId, plan.accountId)).get()?.n ?? 0;
    if (left > 0) continue;
    tx.insert(balanceAnchors)
      .values({
        accountId: plan.accountId,
        anchoredOn: plan.day,
        balanceCents: plan.balanceCents,
        source: KEPT_OPENING_SOURCE,
        importFileId: plan.heirFileId,
        statementPeriodId: null,
      })
      .run();
    kept.push(plan.accountId);
  }
  return kept;
}

/**
 * A document records `day` on the account again: the opening kept for that day goes — importing the statement again
 * puts its own balance there, and two balances for one day would be one too many.
 */
export function replaceKeptOpening(tx: AppDatabase, accountId: string, day: string): void {
  tx.delete(balanceAnchors)
    .where(
      and(
        eq(balanceAnchors.accountId, accountId),
        eq(balanceAnchors.anchoredOn, day),
        eq(balanceAnchors.source, KEPT_OPENING_SOURCE),
      ),
    )
    .run();
}

/**
 * A re-read retired `staleIds` and wrote `successorId`: an opening one of them kept follows the rows to the successor
 * — or, where the successor writes no live row on the account any more, to the file that took back the most of the
 * retired read's rows there (`heldBack`, `settleHeldRows`), or to the file that keeps the account's other rows
 * (`keeperOfRows`) — or goes, where no live row stays. Call it once the read is written and its held rows settled,
 * inside the same transaction; the retirement left those openings in place (`removeFileBalances`).
 *
 * 🔴 It went whenever the successor wrote nothing on the account, though the rows stayed under a re-download that
 * prints them (the review of uc/final-integrate, 2026-09-17) — and again where the rows another download keeps are
 * its own, not the retired read's, with nothing in the upload outcome (the review of uc/last-two-fixes, 2026-09-17).
 */
export function settleKeptOpenings(
  tx: AppDatabase,
  staleIds: readonly string[],
  successorId: string,
  heldBack: readonly PrinterHandOver[] = [],
): void {
  if (staleIds.length === 0) return;
  const openings = tx
    .select({ id: balanceAnchors.id, accountId: balanceAnchors.accountId, fileId: balanceAnchors.importFileId })
    .from(balanceAnchors)
    .where(and(inArray(balanceAnchors.importFileId, [...staleIds]), eq(balanceAnchors.source, KEPT_OPENING_SOURCE)))
    .all();
  for (const opening of openings) {
    const keepsRows = tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.importFileId, successorId),
          eq(transactions.accountId, opening.accountId),
          inArray(transactions.status, ["active", "quarantined", "excluded"]),
        ),
      )
      .limit(1)
      .get();
    const heir = keepsRows
      ? successorId
      : (heirsByAccount(opening.fileId!, heldBack).get(opening.accountId) ??
        keeperOfRows(tx, opening.accountId, [opening.fileId!, successorId]));
    if (heir !== undefined) tx.update(balanceAnchors).set({ importFileId: heir }).where(eq(balanceAnchors.id, opening.id)).run();
    else tx.delete(balanceAnchors).where(eq(balanceAnchors.id, opening.id)).run();
  }
}

/** An opening a re-read would keep for a retired read (`keptOpeningPlans`), before it knows which file keeps the rows. */
export interface RetiredOpening {
  fileId: string;
  plan: KeptOpeningPlan;
}

/**
 * Read before a re-read retires `fileIds`: the opening each retired read printed, per account where an un-import of it
 * would keep rows under another file (`held`). `copyPeriodIds` are the months its copies take (`statement-copies`).
 */
export function retiredOpenings(
  db: AppDatabase,
  fileIds: readonly string[],
  held: readonly PrinterHandOver[],
  copyPeriodIds: ReadonlySet<string>,
): RetiredOpening[] {
  return fileIds.flatMap((fileId) => keptOpeningPlans(db, fileId, held, copyPeriodIds).map((plan) => ({ fileId, plan })));
}

/**
 * ⚖️ Owner decision 20 on a re-read: an account the new read leaves with rows held back for another file
 * (`settleHeldRows`) and no recorded balance keeps the opening the retired read printed, under the file that took back
 * the most of its rows — or, where none came back, under the file that keeps the account's other rows
 * (`keeperOfRows`) — as un-importing the retired read would have. Never under a `successorId` of this read: the
 * opening is kept as a statement the ledger no longer reads, and the successor is the file read again. Call it after
 * `settleKeptOpenings`.
 */
export function keepRetiredOpenings(
  tx: AppDatabase,
  openings: readonly RetiredOpening[],
  heldBack: readonly PrinterHandOver[],
  successorIds: readonly string[] = [],
): string[] {
  const plans = openings.flatMap(({ fileId, plan }) => {
    const heirFileId =
      heirsByAccount(fileId, heldBack).get(plan.accountId) ??
      keeperOfRows(tx, plan.accountId, [fileId, ...successorIds]);
    return heirFileId === undefined ? [] : [{ ...plan, heirFileId }];
  });
  return keepOpenings(tx, plans);
}
