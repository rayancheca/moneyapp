import { and, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { statementPeriods } from "@/db/schema/imports";
import { transactions, type FileLinkSource, type TransactionStatus } from "@/db/schema/transactions";

/**
 * Rows filed under a statement they were not parsed from (`file_link_source`).
 *
 * ⚖️ OWNER, 2026-09-15: if a statement that such a row points at is
 * un-imported, the row STAYS — detached from the file, with its money,
 * category, transfer group, recurring link and notes.
 *
 * 🔴 `unimportFile` deleted every row carrying the file's id. On 2026-09-15
 * `scripts/attach-sapphire-payment-rows-2026-09-14.ts` had filed 34
 * hand-reconstructed Chase Sapphire card payments ($9,680.91) under the 12
 * statements that print them. The card parser never inserted those lines — each
 * was absorbed by the hand row already recording it — so un-importing any of
 * the 12 took money out of the ledger that no re-import would put back as the
 * same rows, and nothing on a row could tell the two kinds apart.
 *
 * ⛔ Why a column the importer never writes, and not something already on the row:
 *  - `dedupe_hash` differs from the parser's hash for the line, but proving
 *    that means re-parsing the archived original inside the un-import: slow,
 *    impossible when the file has moved, and wrong after a parser version
 *    changes the hashes of rows it DID produce.
 *  - `created_at < import_files.imported_at` picks out exactly those 34 rows on
 *    today's ledger, but only by the accident that the rows predate their
 *    statements. A row recorded after its statement and then attached would be
 *    deleted with no warning, and once detached (file NULL) no timestamp says
 *    the row was ever filed anywhere — so a re-import could not file it again.
 *  - `statement_period_id` is an FK into the periods the un-import deletes.
 *
 * The marker belongs to the MONEY, like a note: a parser-version re-parse
 * that prints the row's line supersedes the attached row with the rest of its
 * file, and the carry puts the marker on the fresh row that inherits its note
 * and links (`CarryAttributes`, services/import/service.ts). Without it,
 * un-importing after a bump deleted that row as parsed. A re-parse that does
 * not print the line keeps the row itself, detached (`keepRetiredAttachedRows`).
 */
export const ATTACHED: FileLinkSource = "attached";

/** A row attached to its file. NULL-safe, so a left join's empty side is never one. */
export function attachedRow(): SQL {
  return sql`${transactions.fileLinkSource} IS ${ATTACHED}`;
}

/** A row its file's parser produced. On a left join, pair it with a non-null row id. */
export function parsedRow(): SQL {
  return sql`${transactions.fileLinkSource} IS NULL`;
}

/** The rows un-importing `importFileId` deletes — the one predicate the delete and its confirmation share. */
export function parsedFromFile(importFileId: string): SQL {
  return and(eq(transactions.importFileId, importFileId), parsedRow())!;
}

/**
 * Detaches every row attached to `importFileId`, for the un-import about to
 * delete the file: `import_file_id` := NULL, the marker kept, because it is how
 * a later import finds the row again. A row the file's gap had quarantined comes
 * back `active` — the verdict that held it belongs to the period being deleted.
 * Nothing else moves: amount, dates, description, category, transfer group,
 * recurring link, notes and splits all stay. Returns the ids detached.
 *
 * Call it inside the un-import's transaction and before anything reads "the
 * file's rows": after it, those are exactly what the file parsed.
 *
 * A SUPERSEDED attached row is detached too — history, never deleted, and its
 * file is about to go — but it is no kept money (`UnimportCounts.kept`), and
 * `reattachDetachedRows` files only its live successor again.
 */
export function detachAttachedRows(tx: AppDatabase, importFileId: string): string[] {
  const ofFile = and(eq(transactions.importFileId, importFileId), attachedRow());
  const ids = tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(ofFile)
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return [];
  tx.update(transactions)
    .set({ status: "active" })
    .where(and(ofFile, eq(transactions.status, "quarantined")))
    .run();
  tx.update(transactions).set({ importFileId: null }).where(ofFile).run();
  return ids;
}

/**
 * Keeps rows a parser-version re-read retired with their file when no line of the new read took them over
 * (`unclaimedAttachedRows`, services/import/service.ts): each comes back as `detachAttachedRows` leaves a row —
 * `import_file_id` NULL, the marker kept, the status it had before the re-read, except that a quarantine (the retired
 * period's verdict) comes back `active`. Nothing else moves. The same import then files each one again under the
 * statement that holds its day, if exactly one does (`reattachDetachedRows`). Call it inside the re-read's
 * transaction, after the new read's lines are written. Returns the ids kept.
 *
 * 🔴 An attached row survived a re-read only through the carry, which lands on a row the new read inserts, so a read
 * that withholds the row's section, no longer reads its account or no longer prints its line superseded the owner's
 * money with no successor. Measured on a copy of the real ledger, 2026-09-16: the January 2026 Sapphire statement
 * re-read with Sapphire's section withheld reported `parsed` and superseded its 4 attached payments ($1,223.54).
 */
export function keepRetiredAttachedRows(
  tx: AppDatabase,
  rows: readonly { id: string; status: TransactionStatus; fileLinkSource: FileLinkSource | null }[],
): string[] {
  const kept: string[] = [];
  for (const row of rows) {
    if (row.fileLinkSource !== ATTACHED || row.status === "superseded") continue;
    const changes = tx
      .update(transactions)
      .set({ importFileId: null, status: row.status === "quarantined" ? "active" : row.status })
      .where(and(eq(transactions.id, row.id), eq(transactions.status, "superseded"), attachedRow()))
      .run().changes;
    if (changes === 1) kept.push(row.id);
  }
  return kept;
}

/**
 * Files each detached attached row of these accounts under the statement that
 * holds it now: the one printed-balance period of its own account whose dates
 * contain its posted day. The inverse of `detachAttachedRows` — un-import a
 * statement, import it again, and the row is where it was.
 *
 * ⛔ Only rows carrying the marker. An import ABSORBS a file-less row that
 * already records one of its lines (`absorbedLines`), and absorbing is not
 * attaching: that row stays the owner's, with no file, as imports always left it.
 *
 * ⛔ Printed-balance periods only (a beginning AND an ending balance). An
 * export's declared date range proves nothing was printed, and it overlaps
 * the statements of the same account. A day two printed periods contain is
 * ambiguous, and the row stays detached rather than be guessed into one.
 *
 * Run by an import before it reconciles, so a gap holds the row together with
 * the file's own rows, as it did before the un-import. Returns the ids filed —
 * the import did not insert them, and must not claim them as its own.
 */
export function reattachDetachedRows(db: AppDatabase, accountIds: readonly string[]): string[] {
  if (accountIds.length === 0) return [];
  const detached = db
    .select({ id: transactions.id, accountId: transactions.accountId, postedOn: transactions.postedOn })
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, [...accountIds]),
        attachedRow(),
        isNull(transactions.importFileId),
        ne(transactions.status, "superseded"),
      ),
    )
    .all();
  if (detached.length === 0) return [];
  const periods = db
    .select({
      accountId: statementPeriods.accountId,
      importFileId: statementPeriods.importFileId,
      periodStart: statementPeriods.periodStart,
      periodEnd: statementPeriods.periodEnd,
    })
    .from(statementPeriods)
    .where(
      and(
        inArray(statementPeriods.accountId, [...new Set(detached.map((r) => r.accountId))]),
        isNotNull(statementPeriods.beginningBalanceCents),
        isNotNull(statementPeriods.endingBalanceCents),
      ),
    )
    .all();
  const filed: string[] = [];
  db.transaction((tx) => {
    for (const row of detached) {
      const holders = periods.filter(
        (p) => p.accountId === row.accountId && p.periodStart <= row.postedOn && row.postedOn <= p.periodEnd,
      );
      if (holders.length !== 1) continue;
      const changes = tx
        .update(transactions)
        .set({ importFileId: holders[0]!.importFileId })
        .where(and(eq(transactions.id, row.id), isNull(transactions.importFileId)))
        .run().changes;
      if (changes === 1) filed.push(row.id);
    }
  });
  return filed;
}
