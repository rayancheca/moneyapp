import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { importFiles, printedLines, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { descriptionScore } from "@/lib/description-score";
import { normalizeDescription } from "@/lib/normalize";
import type { CopyHandOver } from "./statement-copies";
import type { CanonicalTxn } from "./types";

/**
 * What each imported file prints, and the rows an un-import hands to a file that prints them (`printed_lines`).
 *
 * The import writes a line only where no row records its money yet: a line another record already holds is absorbed,
 * and a line a more trusted file covers is owned by it. Either way the file prints the line and no row of its own
 * records it.
 *
 * 🔴 Un-importing the file whose row held such a line deleted money a still-imported file prints. Measured on a copy of
 * the real ledger, 2026-09-16 (backfills applied): un-importing Spending Report PDF (1).pdf took Chase Sapphire from
 * 1,895 active rows to 1,430 and 109 quarantined, and all 8 reconciled periods from 2025-12-03 to 2026-08-02 went to
 * gap (20260602-statements-9805-.pdf prints 86 lines; the report's rows recorded 80); un-importing
 * 3ab6c2a8-5f00-5de8-b339-c3e514d5b7a7.csv took 75 rows b5cbc3ca37399e25-rh-redownload.csv prints, put four Robinhood
 * Cash periods into gap, and uploading the re-download again was skipped as a duplicate.
 *
 * ⚖️ The rule `statement-copies` set for a second download, for every file: a row a still-imported file prints is
 * handed to it — re-filed, every attribute kept — not deleted. Which rows: each such file's lines are matched to the
 * account's rows — its own, and every other row the un-import leaves — and a line only the un-imported file's rows can
 * record takes one of them. So a line another record already holds (the file's own row, a row entered by hand, a third
 * file's) takes nothing, and the un-imported file's copy of it goes.
 */

export interface PrintedLine {
  /** the day the file prints */
  printedOn: string;
  /** the day the import stored the line on (`placeInsidePeriod`) */
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  normalizedDescription: string;
}

/** What un-importing `fromFileId` hands to one file that prints its rows. */
export interface PrinterHandOver {
  fromFileId: string;
  heirFileId: string;
  accountId: string;
  /** rows the un-imported file parsed that only they record of the heir's lines */
  rowIds: string[];
}

const LIVE_FILE = ["parsed", "parsed_with_claude"] as const;
const LIVE_ROW = ["active", "quarantined", "excluded"] as const;
/** row ids per statement — well under SQLite's bound-parameter limit */
const ROW_CHUNK = 500;

/** A line as `printed_lines` keeps it: the printed and the stored day, the money and the words. */
export function printedLineOf(printed: CanonicalTxn, stored: CanonicalTxn): PrintedLine {
  return {
    printedOn: printed.postedOn,
    postedOn: stored.postedOn,
    transactedOn: stored.transactedOn ?? printed.transactedOn ?? null,
    amountCents: printed.amountCents,
    normalizedDescription: normalizeDescription(printed.rawDescription),
  };
}

/** Adds lines a file prints on an account. A file with two sections on one account prints both. */
export function appendPrintedLines(tx: AppDatabase, importFileId: string, accountId: string, lines: readonly PrintedLine[]): void {
  const where = and(eq(printedLines.importFileId, importFileId), eq(printedLines.accountId, accountId));
  const held = tx.select().from(printedLines).where(where).get();
  if (held === undefined) {
    tx.insert(printedLines).values({ importFileId, accountId, lines: JSON.stringify(lines) }).run();
    return;
  }
  const all = [...(JSON.parse(held.lines) as PrintedLine[]), ...lines];
  tx.update(printedLines).set({ lines: JSON.stringify(all) }).where(eq(printedLines.id, held.id)).run();
}

/** Forgets what a file prints: its read is being removed, retired, or written again. */
export function forgetPrintedLines(tx: AppDatabase, importFileId: string): void {
  tx.delete(printedLines).where(eq(printedLines.importFileId, importFileId)).run();
}

interface Row {
  id: string;
  importFileId: string | null;
  parsed: boolean;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  normalizedDescription: string;
}

/** Rows keyed by money and day: the posted day under `p`, the transaction day under `t`. */
function indexRows(rows: readonly Row[]): Map<string, Row[]> {
  const index = new Map<string, Row[]>();
  const add = (key: string, row: Row) => index.set(key, [...(index.get(key) ?? []), row]);
  for (const row of rows) {
    add(`${row.amountCents}|p|${row.postedOn}`, row);
    if (row.transactedOn !== null) add(`${row.amountCents}|t|${row.transactedOn}`, row);
  }
  return index;
}

/**
 * The day a row must have been TRANSACTED on to record a line: the line's own transaction day — or, for a line that
 * prints one day and no transaction day, that day. A statement line printed before its period opens is stored on the
 * period's first day with the printed day as its transaction day (`placeInsidePeriod`), and an export printing that
 * charge on the printed day is the file whose row it took over (`pickTakeoverVictim` looks on the printed day).
 *
 * 🔴 Only the posted day was asked of such a line, so un-importing the statement deleted a charge the still-imported
 * export prints (the review of uc/final-integrate, 2026-09-16).
 */
function transactionDayOf(line: PrintedLine): string {
  return line.transactedOn ?? line.printedOn;
}

/** How surely a row records a line: the same money, and the same transaction day (2) and/or posted day (1). */
function weight(line: PrintedLine, row: Row): number {
  const sameDay = row.postedOn === line.printedOn || row.postedOn === line.postedOn ? 1 : 0;
  const sameTransactionDay = row.transactedOn === transactionDayOf(line) ? 2 : 0;
  return sameDay + sameTransactionDay;
}

/** The rows that may record a line, surest first. */
function candidatesFor(line: PrintedLine, index: ReadonlyMap<string, Row[]>): Row[] {
  const keys = [`${line.amountCents}|p|${line.printedOn}`, `${line.amountCents}|p|${line.postedOn}`, `${line.amountCents}|t|${transactionDayOf(line)}`];
  const unique = new Map(keys.flatMap((k) => index.get(k) ?? []).map((r) => [r.id, r] as const));
  return [...unique.values()].sort(
    (a, b) =>
      weight(line, b) - weight(line, a) ||
      descriptionScore(b.normalizedDescription, line.normalizedDescription) -
        descriptionScore(a.normalizedDescription, line.normalizedDescription) ||
      a.id.localeCompare(b.id),
  );
}

/** A matching of one file's lines to rows: which line each row records, and which row each line has. */
interface Matching {
  lineOf: Map<string, number>;
  rowOf: Map<number, string>;
}

/** Kuhn's augmenting search from `line`, over rows `usable` allows. */
function augment(line: number, candidates: readonly Row[][], usable: (row: Row) => boolean, m: Matching, seen: Set<string>): boolean {
  for (const row of candidates[line]!) {
    if (seen.has(row.id) || !usable(row)) continue;
    seen.add(row.id);
    const other = m.lineOf.get(row.id);
    if (other === undefined || augment(other, candidates, usable, m, seen)) {
      m.lineOf.set(row.id, line);
      m.rowOf.set(line, row.id);
      return true;
    }
  }
  return false;
}

/**
 * A maximum matching of the heir's lines to the account's rows, any file's. Which rows it picks does not change how many
 * lines lose their row when one file's rows go (`rowsOnlyFromFile`): that is the matching's size less the size of the
 * best matching without them.
 */
function matchHeir(lines: readonly PrintedLine[], index: ReadonlyMap<string, Row[]>): { m: Matching; candidates: Row[][] } {
  const candidates = lines.map((line) => candidatesFor(line, index));
  const m: Matching = { lineOf: new Map(), rowOf: new Map() };
  for (let i = 0; i < lines.length; i++) augment(i, candidates, () => true, m, new Set());
  return { m, candidates };
}

/**
 * The rows of `fromFileId` the heir's lines cannot do without: the lines those rows hold are placed again on every
 * other row (Kuhn — a line that finds no path now finds none later), and a line left over takes the row it had.
 */
function rowsOnlyFromFile(
  heirFileId: string,
  fromFileId: string,
  kept: ReadonlySet<string>,
  { m, candidates }: { m: Matching; candidates: Row[][] },
  rowsById: ReadonlyMap<string, Row>,
): string[] {
  const doomed = (row: Row) => row.importFileId === fromFileId && row.parsed && !kept.has(row.id);
  const freed = [...m.lineOf].filter(([rowId]) => doomed(rowsById.get(rowId)!));
  if (freed.length === 0 || fromFileId === heirFileId) return [];
  const copy: Matching = { lineOf: new Map(m.lineOf), rowOf: new Map(m.rowOf) };
  for (const [rowId, line] of freed) {
    copy.lineOf.delete(rowId);
    copy.rowOf.delete(line);
  }
  const usable = (row: Row) => !doomed(row);
  return freed.filter(([, line]) => !augment(line, candidates, usable, copy, new Set())).map(([rowId]) => rowId);
}

interface Heir {
  fileId: string;
  importedAt: string;
  lines: PrintedLine[];
  /** the statement periods it holds on the account */
  periods: { start: string; end: string }[];
}

/** Of several heirs for one row: the one whose statement period holds its day, then the most recently imported. */
function pickHeir(heirs: readonly Heir[], row: Row): Heir {
  const holds = (h: Heir) => (h.periods.some((p) => p.start <= row.postedOn && row.postedOn <= p.end) ? 1 : 0);
  return [...heirs].sort((a, b) => holds(b) - holds(a) || b.importedAt.localeCompare(a.importedAt) || a.fileId.localeCompare(b.fileId))[0]!;
}

/**
 * What a live file with no `printed_lines` record on the account is known to print without a live row of its own: the
 * lines of its parsed rows a more trusted file took over (`superseded`). Not a retired read's rows — its file is not
 * live — and not a copy the owner retired as a duplicate: un-importing the file of the row his verdict kept puts that
 * copy back in its place (`restoreDuplicatesLosingTheirSurvivor`), which is his verdict's reading of the charge.
 *
 * ⚖️ Owner, 2026-09-16: when a file that took over rows is un-imported, the rows it replaced come back if their own
 * file is still imported. 🔴 They came back only through the record, and a file imported before `printed_lines` existed
 * has none where the backfill could not read it again at the version that imported it (on the real ledger,
 * 2026-09-16: Discover-AllAvailable-20260710.csv and 36 Robinhood statements), so un-importing the file that took its
 * rows over deleted them. The takeover moved everything the owner had set onto the row that took over (`insertTxn`), so
 * that row is what stays, filed under the file whose line it records.
 */
function takenOverLines(db: AppDatabase, accountId: string, recordedFileIds: readonly string[]): Omit<Heir, "periods">[] {
  const rows = db
    .select({
      fileId: importFiles.id,
      importedAt: importFiles.importedAt,
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
        eq(transactions.status, "superseded"),
        isNull(transactions.fileLinkSource),
        inArray(importFiles.status, [...LIVE_FILE]),
        notInArray(importFiles.id, [...recordedFileIds]),
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
    .all();
  const heirs = new Map<string, Omit<Heir, "periods">>();
  for (const { fileId, importedAt, ...row } of rows) {
    const heir = heirs.get(fileId) ?? { fileId, importedAt, lines: [] };
    heirs.set(fileId, { ...heir, lines: [...heir.lines, { printedOn: row.postedOn, ...row }] });
  }
  return [...heirs.values()];
}

function heirsOn(db: AppDatabase, accountId: string): Heir[] {
  const periods = db
    .select({ fileId: statementPeriods.importFileId, start: statementPeriods.periodStart, end: statementPeriods.periodEnd })
    .from(statementPeriods)
    .where(eq(statementPeriods.accountId, accountId))
    .all();
  const recorded = db
    .select({ fileId: printedLines.importFileId, importedAt: importFiles.importedAt, lines: printedLines.lines })
    .from(printedLines)
    .innerJoin(importFiles, eq(importFiles.id, printedLines.importFileId))
    .where(and(eq(printedLines.accountId, accountId), inArray(importFiles.status, [...LIVE_FILE])))
    .all()
    .map((h) => ({ ...h, lines: JSON.parse(h.lines) as PrintedLine[] }));
  // …and a live file the record says nothing about on this account, known by the rows it lost to a takeover
  const known = takenOverLines(
    db,
    accountId,
    recorded.map((h) => h.fileId),
  );
  return [...recorded, ...known]
    .sort((a, b) => a.fileId.localeCompare(b.fileId))
    .map((h) => ({ ...h, periods: periods.filter((p) => p.fileId === h.fileId) }));
}

function rowsOn(db: AppDatabase, accountId: string): Row[] {
  return db
    .select({
      id: transactions.id,
      importFileId: transactions.importFileId,
      fileLinkSource: transactions.fileLinkSource,
      postedOn: transactions.postedOn,
      transactedOn: transactions.transactedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), inArray(transactions.status, [...LIVE_ROW])))
    .all()
    .map(({ fileLinkSource, ...r }) => ({ ...r, parsed: fileLinkSource === null }));
}

/** The accounts where `fileIds` (every file, when absent) have parsed rows. */
function accountsInScope(db: AppDatabase, fileIds?: readonly string[]): string[] {
  const where = and(
    isNull(transactions.fileLinkSource),
    inArray(transactions.status, [...LIVE_ROW]),
    ...(fileIds === undefined ? [] : [inArray(transactions.importFileId, [...fileIds])]),
  );
  return db.selectDistinct({ accountId: transactions.accountId }).from(transactions).where(where).all().map((r) => r.accountId);
}

/**
 * For each file (all files, or `fileIds`), what un-importing it hands to the files that print its rows. `copyPlans` is
 * what the same un-import hands to another download of its statement (`copyHandOvers`): those rows stay, under that
 * download, so every heir may count on them. Read-only — ONE plan for the un-import and for its /imports confirmation.
 */
export function printerHandOvers(
  db: AppDatabase,
  copyPlans: ReadonlyMap<string, readonly CopyHandOver[]>,
  fileIds?: readonly string[],
): Map<string, PrinterHandOver[]> {
  const plans = new Map<string, PrinterHandOver[]>();
  for (const accountId of accountsInScope(db, fileIds)) {
    const heirs = heirsOn(db, accountId);
    if (heirs.length === 0) continue;
    const rows = rowsOn(db, accountId);
    const rowsById = new Map(rows.map((r) => [r.id, r] as const));
    const index = indexRows(rows);
    const fromFiles = [...new Set(rows.filter((r) => r.parsed && r.importFileId !== null).map((r) => r.importFileId!))].filter(
      (f) => fileIds === undefined || fileIds.includes(f),
    );
    const matched = heirs.map((heir) => ({ heir, matching: matchHeir(heir.lines, index) }));
    for (const fromFileId of fromFiles) {
      const kept = new Set((copyPlans.get(fromFileId) ?? []).flatMap((p) => p.rowIds));
      const claims = new Map<string, Heir[]>();
      for (const { heir, matching } of matched) {
        for (const rowId of rowsOnlyFromFile(heir.fileId, fromFileId, kept, matching, rowsById)) {
          claims.set(rowId, [...(claims.get(rowId) ?? []), heir]);
        }
      }
      const byHeir = new Map<string, string[]>();
      for (const [rowId, claimants] of claims) {
        const heir = pickHeir(claimants, rowsById.get(rowId)!);
        byHeir.set(heir.fileId, [...(byHeir.get(heir.fileId) ?? []), rowId]);
      }
      const list = [...byHeir].map(([heirFileId, rowIds]) => ({ fromFileId, heirFileId, accountId, rowIds: rowIds.sort() }));
      if (list.length > 0) plans.set(fromFileId, [...(plans.get(fromFileId) ?? []), ...list]);
    }
  }
  return plans;
}

/** A row an un-import deletes, as `printedWordsOfRows` reads it. */
export interface RowToRemember {
  id: string;
  accountId: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  normalizedDescription: string;
}

/**
 * The words the file `importFileId` prints for the line each of its rows records. For a row the file wrote, its own
 * words; for a row another file wrote, handed to this file because this file prints its money (`handOverToPrinters`),
 * the words of the line it records. A row the file prints no line for is left out.
 *
 * A record of what the owner set on a row the un-import deletes waits for an import that writes its line
 * (`unimported-attributes`), and a line claims a record by its words. 🔴 A row handed over in the export's words left a
 * record no line of the statement could claim: the statement's next import gave the owner's newer work back to nothing
 * (found while checking the review of uc/final-integrate, 2026-09-17).
 */
export function printedWordsOfRows(db: AppDatabase, importFileId: string, rows: readonly RowToRemember[]): Map<string, string> {
  const words = new Map<string, string>();
  const records = db.select().from(printedLines).where(eq(printedLines.importFileId, importFileId)).all();
  for (const record of records) {
    const lines = JSON.parse(record.lines) as PrintedLine[];
    const mine: Row[] = rows
      .filter((r) => r.accountId === record.accountId)
      .map(({ accountId: _a, ...r }) => ({ ...r, importFileId, parsed: true }));
    if (mine.length === 0 || lines.length === 0) continue;
    const index = indexRows(mine);
    const candidates = lines.map((line) => candidatesFor(line, index));
    const m: Matching = { lineOf: new Map(), rowOf: new Map() };
    // each line's own row first — the one it wrote, in its words — and never taken from it; then, for each line left,
    // a row another file wrote. 🔴 Matched in one pass, a line another row absorbed took the file's own row of the same
    // money and day, and the record waited for that line's words — and a line of the same money could claim it.
    const own = candidates.map((rows, i) => rows.filter((r) => r.normalizedDescription === lines[i]!.normalizedDescription));
    for (let i = 0; i < lines.length; i++) augment(i, own, () => true, m, new Set());
    const wrote = new Set(m.lineOf.keys());
    for (let i = 0; i < lines.length; i++) if (!m.rowOf.has(i)) augment(i, candidates, (r) => !wrote.has(r.id), m, new Set());
    for (const [rowId, line] of m.lineOf) words.set(rowId, lines[line]!.normalizedDescription);
  }
  return words;
}

/** Files each planned row under its heir. Call it inside the un-import's transaction, before anything reads "the file's rows". */
export function handOverToPrinters(tx: AppDatabase, plans: readonly PrinterHandOver[]): void {
  for (const plan of plans) {
    for (let i = 0; i < plan.rowIds.length; i += ROW_CHUNK) {
      tx.update(transactions)
        .set({ importFileId: plan.heirFileId })
        .where(
          and(
            inArray(transactions.id, plan.rowIds.slice(i, i + ROW_CHUNK)),
            eq(transactions.importFileId, plan.fromFileId),
            isNull(transactions.fileLinkSource),
          ),
        )
        .run();
    }
  }
}

/** Every row a set of plans keeps under another file. */
export function printerRowIds(plans: Iterable<readonly PrinterHandOver[]>): Set<string> {
  return new Set([...plans].flatMap((list) => list.flatMap((p) => p.rowIds)));
}
