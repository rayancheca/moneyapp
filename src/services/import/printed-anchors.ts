import { and, asc, count, desc, eq, exists, isNotNull, ne, not, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { copyHandOvers, type CopyHandOver } from "./statement-copies";

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
 * How many recorded balances un-importing each file removes: the anchors it owns, less the ones another statement
 * still prints (`handOverPrintedAnchors`) — and less the ones its own period prints when that period goes to another
 * download of the statement (`plans`, `statement-copies`: the un-import hands the period over first, so the anchor
 * follows it). One grouped query; a file that removes none is absent.
 */
export function balancesRemovedByFile(
  db: AppDatabase,
  plans: ReadonlyMap<string, readonly CopyHandOver[]> = copyHandOvers(db),
): Map<string, number> {
  const handedPeriodIds = JSON.stringify([...plans.values()].flatMap((list) => list.map((p) => p.periodId)));
  const printedElsewhere = db
    .select({ id: statementPeriods.id })
    .from(statementPeriods)
    .where(
      or(
        printsTheDay({
          accountId: balanceAnchors.accountId,
          day: balanceAnchors.anchoredOn,
          importFileId: balanceAnchors.importFileId,
        }),
        and(
          sql`${statementPeriods.id} IN (SELECT value FROM json_each(${handedPeriodIds}))`,
          eq(statementPeriods.accountId, balanceAnchors.accountId),
          eq(statementPeriods.importFileId, balanceAnchors.importFileId),
          isNotNull(statementPeriods.beginningBalanceCents),
          isNotNull(statementPeriods.endingBalanceCents),
          or(
            eq(statementPeriods.periodEnd, balanceAnchors.anchoredOn),
            sql`date(${statementPeriods.periodStart}, '-1 day') = ${balanceAnchors.anchoredOn}`,
          ),
        ),
      ),
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
