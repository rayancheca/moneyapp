import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { KEPT_OPENING_SOURCE, balanceAnchors } from "@/db/schema/balances";
import { statementPeriods } from "@/db/schema/imports";
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
 * - It goes when a document records the day again (`replaceKeptOpening` — importing the statement again), when the
 *   file that keeps the rows is un-imported (`removeFileBalances` deletes the anchors a file owns), and when a re-read
 *   of that file no longer writes a row on the account (`settleKeptOpenings`).
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
  const heirs = new Map<string, { heirFileId: string; rows: number }>();
  for (const p of printers) {
    if (p.fromFileId !== fileId || p.rowIds.length === 0) continue;
    const best = heirs.get(p.accountId);
    const better = !best || p.rowIds.length > best.rows || (p.rowIds.length === best.rows && p.heirFileId < best.heirFileId);
    if (better) heirs.set(p.accountId, { heirFileId: p.heirFileId, rows: p.rowIds.length });
  }
  const plans: KeptOpeningPlan[] = [];
  for (const [accountId, heir] of heirs) {
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
    plans.push({ accountId, day: addDays(opening.periodStart, -1), balanceCents: opening.begin, heirFileId: heir.heirFileId });
  }
  return plans;
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
 * — or goes, where the successor writes no live row on the account any more. Call it once the successor is written,
 * inside the same transaction; the retirement left those openings in place (`removeFileBalances`).
 */
export function settleKeptOpenings(tx: AppDatabase, staleIds: readonly string[], successorId: string): void {
  if (staleIds.length === 0) return;
  const openings = tx
    .select({ id: balanceAnchors.id, accountId: balanceAnchors.accountId })
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
    if (keepsRows) tx.update(balanceAnchors).set({ importFileId: successorId }).where(eq(balanceAnchors.id, opening.id)).run();
    else tx.delete(balanceAnchors).where(eq(balanceAnchors.id, opening.id)).run();
  }
}
