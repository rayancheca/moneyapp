import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { importFiles, type ImportStatus } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { diffDays } from "@/lib/dates";
import { descriptionScore } from "@/lib/description-score";
import type { LineLeftOutFacts } from "@/lib/import-file-label";
import {
  LIVE_FILE,
  augment,
  heirsOn,
  indexRows,
  matchHeir,
  rowsOn,
  takenBack,
  type Matching,
  type PrintedLine,
  type Row,
} from "./printed-lines";

/**
 * A line a still-imported file prints that no live row records: a re-read retired the row that recorded it, and no
 * later read of the file writes that line again.
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
  /** the retired row that recorded it — of the last version to record it, when several did (`chargesOf`) */
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

/** One read of a file's bytes that wrote them: retired since, or imported now. */
interface Read {
  id: string;
  sha: string;
  status: ImportStatus;
}

/** Every read of the bytes `readIds` read that wrote them, the oldest parser version first. */
function readsOfTheSameBytes(db: AppDatabase, readIds: readonly string[]): Read[] {
  if (readIds.length === 0) return [];
  const shas = db
    .selectDistinct({ sha: importFiles.fileSha256 })
    .from(importFiles)
    .where(inArray(importFiles.id, [...readIds]))
    .all()
    .map((f) => f.sha);
  return db
    .select({ id: importFiles.id, sha: importFiles.fileSha256, status: importFiles.status })
    .from(importFiles)
    .where(and(inArray(importFiles.fileSha256, shas), inArray(importFiles.status, ["superseded", ...LIVE_FILE])))
    .orderBy(asc(importFiles.parserVersion))
    .all();
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
 * The most days a version can move a line and still be writing the SAME line: under a week. A version that reads a
 * file's other date moves a line by the days a charge takes to post — one to three between a Chase card statement and
 * its Spending Report (`identityWeight`), one to five for a card payment's bank post (`card_payment_mirror`) — while
 * his pay comes round at one amount every week, so a week a version drops never passes for its neighbour re-dated.
 *
 * 🔴 Unbounded, any line of the same money stood in for the line a version dropped, whatever its day: the review of
 * uc/loud-dropped-line, 2026-09-28, measured a version that moved each week of pay a day later and dropped 06-12 name
 * 06-19 as the week left out, and one that dropped a week and read one the first version missed name nothing.
 *
 * ⚠️ A version that moves a line further — a year it infers anew — has that line named as left out until the files
 * still printing the old day are read again: loud, and never money added on a guess. And a line of the same money the
 * new version reads for the first time within these days of one it dropped still stands in for it: the words cannot
 * tell them apart, since a version may re-word a line as it re-dates it.
 */
const RE_DATED_WITHIN_DAYS = 6;

/**
 * Which row of a later read of the same bytes writes each row of an earlier read again, as [earlier, later]. First each
 * line the later read writes on the same money and day (`matchHeir`, the matching `printed-lines` makes); then each
 * line it DATES anew, paired with an unpaired row of the same money within `RE_DATED_WITHIN_DAYS` — the nearest day
 * first, then the surest words, as many pairs as there can be (Kuhn). A version that dates a line differently writes it
 * again (`settleHeldRows`): a re-download still printing the old day is no money missing, and saying so would be a
 * false alarm.
 */
function rowsWrittenAgain(earlier: readonly Row[], later: readonly Row[]): [earlierId: string, laterId: string][] {
  const { m: same } = matchHeir(later.map(asLine), indexRows(earlier));
  const unpaired = earlier.filter((r) => !same.lineOf.has(r.id));
  const dated = later.filter((_, i) => !same.rowOf.has(i));
  const candidates = dated.map((line) => {
    const days = (r: Row) => Math.abs(diffDays(r.postedOn, line.postedOn));
    const words = (r: Row) => descriptionScore(r.normalizedDescription, line.normalizedDescription);
    return unpaired
      .filter((r) => r.amountCents === line.amountCents && days(r) <= RE_DATED_WITHIN_DAYS)
      .sort((a, b) => days(a) - days(b) || words(b) - words(a) || a.id.localeCompare(b.id));
  });
  const redated: Matching = { lineOf: new Map(), rowOf: new Map() };
  for (let i = 0; i < dated.length; i++) augment(i, candidates, () => true, redated, new Set());
  return [
    ...[...same.lineOf].map(([id, i]) => [id, later[i]!.id] as [string, string]),
    ...[...redated.lineOf].map(([id, i]) => [id, dated[i]!.id] as [string, string]),
  ];
}

/**
 * The charge each retired row records: the row its line was written as LAST — the row the next read of the same bytes
 * that writes it again writes it as (`rowsWrittenAgain`), and so on until no later read does. A retired row is a line
 * left out only when that last row is one of `rows` too: a line a read imported now writes again is in the ledger, and
 * a copy he retired as a duplicate is recorded by the row his verdict kept (`retiredRowsOn`) — neither is here.
 *
 * So each charge is named ONCE, however many versions recorded it, as the row the last of them wrote; an earlier
 * version's row is how a file still printing that version's words or day finds it.
 *
 * 🔴 Only the imported read was asked, so a charge kept a retired row for every version that had read it, and two
 * re-downloads read at versions that word it differently each took their own: the review of uc/loud-dropped-line,
 * 2026-09-28, measured one +$25.00 deposit named twice by ledger-check and under the read on /imports, and once by the
 * upload, which asks only of the read it retired.
 */
function chargesOf(db: AppDatabase, accountId: string, rows: readonly Row[]): Map<string, string> {
  const writtenAs = new Map<string, string>();
  const reads = readsOfTheSameBytes(db, [...new Set(rows.map((r) => r.importFileId!))]);
  for (const sha of new Set(reads.map((r) => r.sha))) {
    const readings = reads.filter((r) => r.sha === sha).map((r) => parsedRowsOf(db, r.id, accountId));
    readings.forEach((earlier, i) => {
      // the soonest later version that writes the line again is the one its row stands for
      for (const later of readings.slice(i + 1)) {
        for (const [from, to] of rowsWrittenAgain(earlier, later)) if (!writtenAs.has(from)) writtenAs.set(from, to);
      }
    });
  }
  const last = (id: string): string => (writtenAs.has(id) ? last(writtenAs.get(id)!) : id);
  const retired = new Set(rows.map((r) => r.id));
  return new Map(rows.map((r) => [r.id, last(r.id)] as const).filter(([, charge]) => retired.has(charge)));
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
 * (`takenBack`) that stands for a charge no read imported now writes again (`chargesOf`): one charge, however many
 * files print it and however many versions recorded it. Read-only — ONE answer for the upload outcome, /imports and
 * `pnpm ledger-check`.
 */
export function linesLeftOut(db: AppDatabase, fromFileIds?: readonly string[]): LineLeftOut[] {
  if (fromFileIds !== undefined && fromFileIds.length === 0) return [];
  // …with every earlier read of the same files: its row is how a file printing that version's line finds the charge
  const scope =
    fromFileIds === undefined ? undefined : readsOfTheSameBytes(db, fromFileIds).flatMap((r) => (r.status === "superseded" ? [r.id] : []));
  const out: LineLeftOut[] = [];
  for (const accountId of accountsWithRetiredRows(db, fromFileIds)) {
    const heirs = heirsOn(db, accountId);
    if (heirs.length === 0) continue;
    const rows = retiredRowsOn(db, accountId, scope);
    const charges = chargesOf(db, accountId, rows);
    const retired = new Map(rows.filter((r) => charges.has(r.id)).map((r) => [r.id, r] as const));
    const index = indexRows([...rowsOn(db, accountId), ...retired.values()]);
    const taken = new Map<string, { line: PrintedLine; printers: string[] }>();
    for (const heir of heirs) {
      for (const [rowId, i] of takenBack(heir, index, (id) => !retired.has(id), () => true)) {
        const charge = charges.get(rowId)!;
        const held = taken.get(charge);
        taken.set(charge, { line: held?.line ?? heir.lines[i]!, printers: [...(held?.printers ?? []), heir.fileId] });
      }
    }
    // a re-read's outcome names what its own retirement left out: the charges the reads it retired wrote last
    const left = [...taken].filter(([charge]) => fromFileIds?.includes(retired.get(charge)!.importFileId!) ?? true);
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
