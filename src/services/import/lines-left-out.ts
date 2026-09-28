import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { importFiles } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { descriptionScore } from "@/lib/description-score";
import type { LineLeftOutFacts } from "@/lib/import-file-label";
import { LIVE_FILE, heirsOn, indexRows, matchHeir, rowsOn, takenBack, type PrintedLine, type Row } from "./printed-lines";

/**
 * A line a still-imported file prints that no live row records: a re-read retired the row that recorded it, and the
 * file's newest read does not write that money again.
 *
 * ⚖️ Owner, 2026-09-28: the row stays out — the ledger never adds money on a guess — and is named: counted in the upload
 * outcome (`FileOutcome.leftOut`), under the read on /imports, and by `pnpm ledger-check`.
 *
 * 🔴 It left silently. An export re-read at a version that drops a line retires the row a re-download still prints; the
 * day lies inside the window the re-read answers for, so `settleHeldRows` brings nothing back, and an export's period is
 * `not_applicable`, so no gap opens. Measured in a rehearsal on a copy of the real ledger, 2026-09-28: dropping Wells
 * Fargo's +$25.00 opening deposit moved the account $2,396.67 → $2,371.67, and net worth with it — and the outcome
 * counted nothing and ledger-check found nothing.
 */
export interface LineLeftOut extends LineLeftOutFacts {
  accountId: string;
  /** the retired read's row that recorded it */
  rowId: string;
  /** the ids of `printedBy`, in its order */
  printerFileIds: string[];
  /** the id of `readBy` */
  readById: string | null;
}

/** The parsed rows of retired reads — `fromFileIds`' only, when given. */
function retiredRows(fromFileIds: readonly string[] | undefined) {
  return and(
    eq(transactions.status, "superseded"),
    isNull(transactions.fileLinkSource),
    eq(importFiles.status, "superseded"),
    ...(fromFileIds === undefined ? [] : [inArray(importFiles.id, [...fromFileIds])]),
  );
}

/**
 * The account's parsed rows of retired reads, less the copies he retired as duplicates: his verdict says another row
 * records that money (`takenOverLines` leaves them out for the same reason).
 */
function retiredRowsOn(db: AppDatabase, accountId: string, fromFileIds: readonly string[] | undefined): Row[] {
  return db
    .select({
      id: transactions.id,
      importFileId: transactions.importFileId,
      postedOn: transactions.postedOn,
      transactedOn: transactions.transactedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .innerJoin(importFiles, eq(importFiles.id, transactions.importFileId))
    .where(
      and(
        eq(transactions.accountId, accountId),
        retiredRows(fromFileIds),
        notInArray(
          transactions.id,
          db
            .select({ id: sql<string>`${duplicateCandidates.retiredTransactionId}` })
            .from(duplicateCandidates)
            .where(and(eq(duplicateCandidates.resolution, "confirmed_duplicate"), isNotNull(duplicateCandidates.retiredTransactionId))),
        ),
      ),
    )
    .orderBy(asc(transactions.id))
    .all()
    .map((r) => ({ ...r, parsed: true }));
}

/** Every row `fileId` parsed on the account, whatever became of it since — the file's reading of the account. */
function parsedRowsOf(db: AppDatabase, fileId: string, accountId: string): Row[] {
  return db
    .select({
      id: transactions.id,
      importFileId: transactions.importFileId,
      postedOn: transactions.postedOn,
      transactedOn: transactions.transactedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(and(eq(transactions.importFileId, fileId), eq(transactions.accountId, accountId), isNull(transactions.fileLinkSource)))
    .orderBy(asc(transactions.id))
    .all()
    .map((r) => ({ ...r, parsed: true }));
}

/** The imported read of the same bytes a retired read was replaced by — a re-read is the same file at a newer version. */
function newestReadOf(db: AppDatabase, retiredFileId: string): { id: string; fileName: string } | null {
  const retired = db.select({ sha: importFiles.fileSha256 }).from(importFiles).where(eq(importFiles.id, retiredFileId)).get();
  if (retired === undefined) return null;
  return (
    db
      .select({ id: importFiles.id, fileName: importFiles.fileName })
      .from(importFiles)
      .where(and(eq(importFiles.fileSha256, retired.sha), inArray(importFiles.status, [...LIVE_FILE])))
      .get() ?? null
  );
}

/** A row as `candidatesFor` weighs a line: the day it was stored on is the day it prints. */
const asLine = (row: Row): PrintedLine => ({
  printedOn: row.postedOn,
  postedOn: row.postedOn,
  transactedOn: row.transactedOn,
  amountCents: row.amountCents,
  normalizedDescription: row.normalizedDescription,
});

/**
 * Of the retired rows no live row stands in for, the ones the newest read writes again: its rows the retired read has
 * no row of the same money and day for — a line it dates or prices anew — each paired with a retired row of the same
 * money, the surest words first. A version that dates a line differently writes it again (`settleHeldRows`): a
 * re-download still printing the old day is not money missing, and saying so would be a false alarm.
 *
 * ⚠️ Paired by the money alone — the day is what moved. So a line the new version drops and one of the same money it
 * reads for the first time pair up, and that drop goes unsaid. Asking the words to agree too would call every line a
 * version re-words AND re-dates a drop.
 */
function writtenAgain(db: AppDatabase, accountId: string, rows: readonly Row[]): Set<string> {
  const again = new Set<string>();
  for (const readId of [...new Set(rows.map((r) => r.importFileId!))]) {
    const newest = newestReadOf(db, readId);
    if (newest === null) continue;
    const newRows = parsedRowsOf(db, newest.id, accountId);
    const { m } = matchHeir(newRows.map(asLine), indexRows(parsedRowsOf(db, readId, accountId)));
    let waiting = rows.filter((r) => r.importFileId === readId);
    for (const row of newRows.filter((_, i) => !m.rowOf.has(i))) {
      const words = (r: Row) => descriptionScore(r.normalizedDescription, row.normalizedDescription);
      const pair = waiting.filter((r) => r.amountCents === row.amountCents).sort((a, b) => words(b) - words(a))[0];
      if (pair === undefined) continue;
      again.add(pair.id);
      waiting = waiting.filter((r) => r.id !== pair.id);
    }
  }
  return again;
}

/** Accounts holding parsed rows of retired reads — `fromFileIds`' only, when given. */
function accountsWithRetiredRows(db: AppDatabase, fromFileIds: readonly string[] | undefined): string[] {
  return db
    .selectDistinct({ accountId: transactions.accountId })
    .from(transactions)
    .innerJoin(importFiles, eq(importFiles.id, transactions.importFileId))
    .where(retiredRows(fromFileIds))
    .all()
    .map((r) => r.accountId);
}

/** The names of files, by id. */
function fileNames(db: AppDatabase, fileIds: readonly string[]): Map<string, string> {
  if (fileIds.length === 0) return new Map();
  const rows = db.select({ id: importFiles.id, fileName: importFiles.fileName }).from(importFiles).where(inArray(importFiles.id, [...fileIds])).all();
  return new Map(rows.map((f) => [f.id, f.fileName] as const));
}

/**
 * The words each retired row was read with. ⛔ Not the printed line's normalized words: normalizing strips every run of
 * five digits or more, so a Robinhood dividend of "0.312739 shares" is named "0. SHARES" — a line nobody can find.
 */
function rawWords(db: AppDatabase, rowIds: readonly string[]): Map<string, string> {
  const rows = db.select({ id: transactions.id, raw: transactions.rawDescription }).from(transactions).where(inArray(transactions.id, [...rowIds])).all();
  return new Map(rows.map((r) => [r.id, r.raw] as const));
}

/**
 * Every line left out of the ledger (`LineLeftOut`) — by every retired read, or by `fromFileIds`, the reads one re-read
 * retires. Each heir's lines are matched to the account's live rows, and a line left over takes a retired row
 * (`takenBack`): one charge, however many files print it. Read-only — ONE answer for the upload outcome, /imports and
 * `pnpm ledger-check`.
 */
export function linesLeftOut(db: AppDatabase, fromFileIds?: readonly string[]): LineLeftOut[] {
  if (fromFileIds !== undefined && fromFileIds.length === 0) return [];
  const out: LineLeftOut[] = [];
  for (const accountId of accountsWithRetiredRows(db, fromFileIds)) {
    const heirs = heirsOn(db, accountId);
    if (heirs.length === 0) continue;
    const retired = new Map(retiredRowsOn(db, accountId, fromFileIds).map((r) => [r.id, r] as const));
    const index = indexRows([...rowsOn(db, accountId), ...retired.values()]);
    const taken = new Map<string, { line: PrintedLine; printers: string[] }>();
    for (const heir of heirs) {
      for (const [rowId, i] of takenBack(heir, index, (id) => !retired.has(id), () => true)) {
        const held = taken.get(rowId);
        taken.set(rowId, { line: held?.line ?? heir.lines[i]!, printers: [...(held?.printers ?? []), heir.fileId] });
      }
    }
    const again = writtenAgain(db, accountId, [...taken.keys()].map((id) => retired.get(id)!));
    const left = [...taken].filter(([rowId]) => !again.has(rowId));
    if (left.length === 0) continue;
    const accountName = db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, accountId)).get()!.name;
    const names = fileNames(db, [...new Set(left.flatMap(([, { printers }]) => printers))]);
    const words = rawWords(db, left.map(([rowId]) => rowId));
    for (const [rowId, { line, printers }] of left) {
      const newest = newestReadOf(db, retired.get(rowId)!.importFileId!);
      out.push({
        accountId,
        accountName,
        printedOn: line.printedOn,
        amountCents: line.amountCents,
        description: words.get(rowId) ?? line.normalizedDescription,
        printedBy: printers.map((id) => names.get(id)!),
        printerFileIds: printers,
        readBy: newest?.fileName ?? null,
        readById: newest?.id ?? null,
        rowId,
      });
    }
  }
  return out.sort((a, b) => a.accountName.localeCompare(b.accountName) || a.printedOn.localeCompare(b.printedOn) || a.rowId.localeCompare(b.rowId));
}
