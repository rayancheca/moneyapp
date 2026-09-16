import { and, asc, count, desc, eq, exists, isNotNull, ne, not, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";

/**
 * A balance a statement prints is recorded ONCE per account and day (`balance_anchors`), though two statements can
 * print it: one's closing balance is the next one's opening balance, and a second download of a statement adopts the
 * first download's period and prints every day it prints. The anchor belongs to whichever file wrote it last
 * (`upsertAnchor`, `upsertAnchorAtDayBefore` in services/import/service.ts).
 *
 * 🔴 Removing a file's contribution — un-import, or a parser-version re-read that retires it — deleted every anchor
 * the file owned, while another statement, still imported, prints the day. Measured on a copy of the real ledger,
 * 2026-09-16: 240 of the 265 statement anchors name a day another file's printed period also prints, and 106 are
 * owned by one of 59 second downloads that own no row and no period.
 *
 * ⚠️ Statement anchors only: nothing but the anchor itself records an OFX ledger balance.
 */

type Operand = SQLWrapper | string;

/**
 * A printed-balance period of a file other than `anchor.importFileId`, on the anchor's account, that prints the
 * anchor's day: it closes on it, or opens the day after. ONE rule for the hand-over and for the /imports
 * confirmation's count of what an un-import removes.
 */
function printsTheDay(anchor: { accountId: Operand; day: Operand; importFileId: Operand }): SQL {
  return and(
    eq(statementPeriods.accountId, anchor.accountId),
    ne(statementPeriods.importFileId, anchor.importFileId),
    isNotNull(statementPeriods.beginningBalanceCents),
    isNotNull(statementPeriods.endingBalanceCents),
    or(eq(statementPeriods.periodEnd, anchor.day), sql`date(${statementPeriods.periodStart}, '-1 day') = ${anchor.day}`),
  )!;
}

/**
 * Hands each statement anchor `importFileId` owns to another file's period that prints the same day, instead of
 * letting it go with the file: the period that closes on the day first, then the most recently imported file. The
 * balance, the file and the period move together, as `upsertAnchor` moves them. Call it inside the transaction that
 * removes the file's anchors, before the delete.
 */
export function handOverPrintedAnchors(tx: AppDatabase, importFileId: string): void {
  const owned = tx
    .select({ id: balanceAnchors.id, accountId: balanceAnchors.accountId, day: balanceAnchors.anchoredOn })
    .from(balanceAnchors)
    .where(and(eq(balanceAnchors.importFileId, importFileId), eq(balanceAnchors.source, "statement")))
    .all();
  for (const anchor of owned) {
    const printer = tx
      .select({
        id: statementPeriods.id,
        importFileId: statementPeriods.importFileId,
        periodEnd: statementPeriods.periodEnd,
        beginningBalanceCents: statementPeriods.beginningBalanceCents,
        endingBalanceCents: statementPeriods.endingBalanceCents,
      })
      .from(statementPeriods)
      .innerJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
      .where(printsTheDay({ accountId: anchor.accountId, day: anchor.day, importFileId }))
      .orderBy(desc(eq(statementPeriods.periodEnd, anchor.day)), desc(importFiles.importedAt), asc(statementPeriods.id))
      .get();
    if (!printer) continue;
    tx.update(balanceAnchors)
      .set({
        balanceCents: printer.periodEnd === anchor.day ? printer.endingBalanceCents! : printer.beginningBalanceCents!,
        importFileId: printer.importFileId,
        statementPeriodId: printer.id,
      })
      .where(eq(balanceAnchors.id, anchor.id))
      .run();
  }
}

/**
 * A statement anchor that names `period` and belongs to ANOTHER file holding no period of its own on the account: the
 * file that adopted the period — a second download of the same statement (`writeMember` adopts the first copy's row
 * and takes over every balance it prints). ONE rule for the hand-over and for the /imports confirmation's count.
 */
function adoptsThePeriod(period: { id: Operand; accountId: Operand; importFileId: Operand }): SQL {
  return and(
    eq(balanceAnchors.statementPeriodId, period.id),
    eq(balanceAnchors.source, "statement"),
    isNotNull(balanceAnchors.importFileId),
    ne(balanceAnchors.importFileId, period.importFileId),
    // one period per file and account (`ux_statement_periods_file_account`)
    sql`NOT EXISTS (SELECT 1 FROM statement_periods own WHERE own.import_file_id = ${balanceAnchors.importFileId} AND own.account_id = ${period.accountId})`,
  )!;
}

/**
 * Hands each period `importFileId` owns to the file that adopted it (`adoptsThePeriod`) — the most recently imported
 * one — instead of letting the period go while that file, still imported, prints it. Call it inside the transaction
 * that removes the file's balances, before `handOverPrintedAnchors`.
 *
 * 🔴 A second download owns no period, so un-importing the first took the month's period away and left the copy's
 * balances standing with nothing to reconcile them against — and a brokerage book's month, known only by its period,
 * stopped standing on the months before it (`laterBookStatements`). Measured 2026-09-16 on a copy of the real ledger
 * with a constructed Robinhood Agentic November downloaded twice: after un-importing the first copy, un-importing
 * October was no longer refused, the sold 0.1 WMT came back (+$10.95 of net worth on Nov 30), and `pnpm ledger-check`
 * exited 1.
 */
export function handOverAdoptedPeriods(tx: AppDatabase, importFileId: string): void {
  const owned = tx
    .select({ id: statementPeriods.id, accountId: statementPeriods.accountId })
    .from(statementPeriods)
    .where(eq(statementPeriods.importFileId, importFileId))
    .all();
  for (const period of owned) {
    const adopter = tx
      .select({ importFileId: importFiles.id })
      .from(balanceAnchors)
      .innerJoin(importFiles, eq(importFiles.id, balanceAnchors.importFileId))
      .where(adoptsThePeriod({ id: period.id, accountId: period.accountId, importFileId }))
      .orderBy(desc(importFiles.importedAt), asc(importFiles.id))
      .get();
    if (adopter) tx.update(statementPeriods).set({ importFileId: adopter.importFileId }).where(eq(statementPeriods.id, period.id)).run();
  }
}

/** How many statement periods un-importing each file removes: the ones it owns that no other file adopted (`handOverAdoptedPeriods`). */
export function periodsRemovedByFile(db: AppDatabase): Map<string, number> {
  const adopted = db
    .select({ id: balanceAnchors.id })
    .from(balanceAnchors)
    .where(adoptsThePeriod({ id: statementPeriods.id, accountId: statementPeriods.accountId, importFileId: statementPeriods.importFileId }));
  return new Map(
    db
      .select({ importFileId: statementPeriods.importFileId, n: count() })
      .from(statementPeriods)
      .where(not(exists(adopted)))
      .groupBy(statementPeriods.importFileId)
      .all()
      .map((r) => [r.importFileId, r.n] as const),
  );
}

/**
 * How many recorded balances un-importing each file removes: the anchors it owns, less the ones another statement
 * still prints (`handOverPrintedAnchors`). One grouped query; a file that removes none is absent.
 */
export function balancesRemovedByFile(db: AppDatabase): Map<string, number> {
  const printedElsewhere = db
    .select({ id: statementPeriods.id })
    .from(statementPeriods)
    .where(
      printsTheDay({
        accountId: balanceAnchors.accountId,
        day: balanceAnchors.anchoredOn,
        importFileId: balanceAnchors.importFileId,
      }),
    );
  return new Map(
    db
      .select({ importFileId: balanceAnchors.importFileId, n: count() })
      .from(balanceAnchors)
      .where(
        and(
          isNotNull(balanceAnchors.importFileId),
          not(and(eq(balanceAnchors.source, "statement"), exists(printedElsewhere))!),
        ),
      )
      .groupBy(balanceAnchors.importFileId)
      .all()
      .flatMap((r) => (r.importFileId === null ? [] : [[r.importFileId, r.n] as const])),
  );
}
