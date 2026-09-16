import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { importFiles, statementCopies, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { descriptionScore } from "@/lib/description-score";
import type { DuplicatePairSide } from "@/lib/hash";
import { attachedRow, parsedRow } from "./attached-rows";

/**
 * A statement downloaded twice, in different bytes (`statement_copies`).
 *
 * The import keeps ONE period row for an account's statement: the second download ADOPTS the first one's
 * (`importOneFile`), and every line of it that the first download's rows already record is absorbed, not written.
 * So the second download owns nothing, and nothing said it prints anything.
 *
 * 🔴 Un-importing the FIRST download deleted its period and its rows while the second download stayed "Parsed".
 * Measured on a copy of the real ledger, 2026-09-16: un-importing 019f5d66 (20230810-statements-3522-.pdf, one of
 * three downloads) removed Chase Checking's reconciled 2023-07-14 → 2023-08-10 period and its 85 rows (−$1,636.84),
 * and turned 60 of its balance days to `gap`. 73 parsed files own no row and no period; 59 of them are second
 * downloads of a statement another file owns.
 *
 * ⚖️ The rule: what a still-imported file ALSO prints is handed to it, not deleted — the period, the rows it prints
 * (re-pointed, every attribute kept), and the rows filed by hand on the period's days. Only un-importing every
 * download removes them.
 *
 * ⛔ A parser-version re-read does NOT hand anything over (`supersedeFileContribution`): the new read writes the
 * period and its rows again, and a hand-over there would leave the older read's rows standing under the copy for
 * good, where no re-read ever reaches them.
 */

type CopyLine = DuplicatePairSide;

const LIVE_FILE = ["parsed", "parsed_with_claude"] as const;
const LIVE_ROW = ["active", "quarantined", "excluded"] as const;

/**
 * Records that `importFileId` prints an account's period another file owns, with the lines it prints there. Call it
 * inside the write that adopts the period. A file prints one period per account (`ux_statement_periods_file_account`),
 * so a second call for the same file and account replaces the first.
 */
export function recordStatementCopy(
  tx: AppDatabase,
  copy: { importFileId: string; accountId: string; periodStart: string; periodEnd: string; lines: readonly CopyLine[] },
): void {
  const lines = JSON.stringify(copy.lines);
  tx.insert(statementCopies)
    .values({ ...copy, lines })
    .onConflictDoUpdate({
      target: [statementCopies.importFileId, statementCopies.accountId],
      set: { periodStart: copy.periodStart, periodEnd: copy.periodEnd, lines },
    })
    .run();
}

/** Forgets what a file prints as a copy: its read is being removed or retired. */
export function forgetStatementCopies(tx: AppDatabase, importFileId: string): void {
  tx.delete(statementCopies).where(eq(statementCopies.importFileId, importFileId)).run();
}

/** What un-importing a file hands to another download of one of its statements, instead of deleting it. */
export interface CopyHandOver {
  /** the file being un-imported */
  fromFileId: string;
  periodId: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  /** the still-imported download that takes the period */
  heirFileId: string;
  /** rows the file parsed that the heir prints — they move to it, with everything on them */
  rowIds: string[];
  /** rows filed under the file by hand whose day the period holds — filed under the heir, marker kept */
  attachedRowIds: string[];
}

interface RowForMatch {
  id: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  normalizedDescription: string;
}

/**
 * The heir's lines each claim one row: the heir's own rows first (a line it wrote itself is not the other file's),
 * then the rows filed by hand, then the rows the file parsed — on the posted day, then on the transaction day, as
 * `consumeIdentity` absorbs a line; the description only ranks rows that already match on money and day.
 * Returns the ids of `parsed` rows claimed.
 *
 * ⚠️ Known limit: at the heir's import a line could also have been absorbed by a third source's row (an export, a
 * row entered by hand); only this file's rows and the heir's are asked here. For a true second download the two
 * files print the same lines and the answer is exact.
 */
function claimedRows(lines: readonly CopyLine[], own: readonly RowForMatch[], attached: readonly RowForMatch[], parsed: readonly RowForMatch[]): string[] {
  const open = lines.map((line) => ({ line, taken: false }));
  const lenses: ((line: CopyLine, row: RowForMatch) => boolean)[] = [
    (line, row) => line.postedOn === row.postedOn && line.amountCents === row.amountCents,
    (line, row) => line.transactedOn !== null && line.transactedOn === row.transactedOn && line.amountCents === row.amountCents,
  ];
  const claimed: string[] = [];
  for (const [pool, isParsed] of [[own, false], [attached, false], [parsed, true]] as const) {
    const waiting = [...pool].sort((a, b) => a.id.localeCompare(b.id));
    for (const matches of lenses) {
      for (const row of [...waiting]) {
        const winner = open
          .filter((slot) => !slot.taken && matches(slot.line, row))
          .sort((a, b) => descriptionScore(b.line.normalizedDescription, row.normalizedDescription) - descriptionScore(a.line.normalizedDescription, row.normalizedDescription))[0];
        if (winner === undefined) continue;
        winner.taken = true;
        waiting.splice(waiting.indexOf(row), 1);
        if (isParsed) claimed.push(row.id);
      }
    }
  }
  return claimed;
}

function rowsFor(db: AppDatabase, where: SQL): RowForMatch[] {
  return db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      transactedOn: transactions.transactedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
    })
    .from(transactions)
    .where(where)
    .all();
}

/**
 * For each file (all files, or `fileIds`), what un-importing it hands over: every period it owns that a still-imported
 * file prints as a copy. The heir is the most recently imported such file that owns no period of its own on the
 * account (`ux_statement_periods_file_account`). Read-only — ONE plan for the un-import and for its /imports
 * confirmation.
 */
export function copyHandOvers(db: AppDatabase, fileIds?: readonly string[]): Map<string, CopyHandOver[]> {
  const candidates = db
    .select({
      periodId: statementPeriods.id,
      fromFileId: statementPeriods.importFileId,
      accountId: statementPeriods.accountId,
      periodStart: statementPeriods.periodStart,
      periodEnd: statementPeriods.periodEnd,
      heirFileId: statementCopies.importFileId,
      lines: statementCopies.lines,
      importedAt: importFiles.importedAt,
    })
    .from(statementPeriods)
    .innerJoin(
      statementCopies,
      and(
        eq(statementCopies.accountId, statementPeriods.accountId),
        eq(statementCopies.periodStart, statementPeriods.periodStart),
        eq(statementCopies.periodEnd, statementPeriods.periodEnd),
      ),
    )
    .innerJoin(importFiles, eq(importFiles.id, statementCopies.importFileId))
    .where(
      and(
        inArray(importFiles.status, [...LIVE_FILE]),
        ...(fileIds === undefined ? [] : [inArray(statementPeriods.importFileId, [...fileIds])]),
      ),
    )
    .orderBy(asc(statementPeriods.id), desc(importFiles.importedAt), asc(statementCopies.importFileId))
    .all()
    .filter((c) => c.heirFileId !== c.fromFileId);
  if (candidates.length === 0) return new Map();

  const periodOwners = new Set(
    db
      .select({ importFileId: statementPeriods.importFileId, accountId: statementPeriods.accountId })
      .from(statementPeriods)
      .where(inArray(statementPeriods.importFileId, [...new Set(candidates.map((c) => c.heirFileId))]))
      .all()
      .map((p) => `${p.importFileId}\x1f${p.accountId}`),
  );
  const plans = new Map<string, CopyHandOver[]>();
  const planned = new Set<string>();
  for (const c of candidates) {
    if (planned.has(c.periodId) || periodOwners.has(`${c.heirFileId}\x1f${c.accountId}`)) continue;
    planned.add(c.periodId);
    const onAccount = (fileId: string, which: SQL): SQL =>
      and(eq(transactions.importFileId, fileId), eq(transactions.accountId, c.accountId), inArray(transactions.status, [...LIVE_ROW]), which)!;
    const attached = rowsFor(db, onAccount(c.fromFileId, attachedRow())).filter(
      (r) => c.periodStart <= r.postedOn && r.postedOn <= c.periodEnd,
    );
    const rowIds = claimedRows(
      JSON.parse(c.lines) as CopyLine[],
      rowsFor(db, onAccount(c.heirFileId, parsedRow())),
      attached,
      rowsFor(db, onAccount(c.fromFileId, parsedRow())),
    );
    const plan: CopyHandOver = {
      fromFileId: c.fromFileId,
      periodId: c.periodId,
      accountId: c.accountId,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      heirFileId: c.heirFileId,
      rowIds,
      attachedRowIds: attached.map((r) => r.id),
    };
    plans.set(c.fromFileId, [...(plans.get(c.fromFileId) ?? []), plan]);
  }
  return plans;
}

/**
 * Hands each planned period, and the rows it names, to its heir; the heir owns the period now, so it is no longer a
 * copy of it. Call it inside the un-import's transaction, before anything reads "the file's rows" — after it, those
 * are exactly what the un-import deletes and detaches.
 */
export function handOverToCopies(tx: AppDatabase, plans: readonly CopyHandOver[]): void {
  for (const plan of plans) {
    tx.update(statementPeriods).set({ importFileId: plan.heirFileId }).where(eq(statementPeriods.id, plan.periodId)).run();
    const rowIds = [...plan.rowIds, ...plan.attachedRowIds];
    if (rowIds.length > 0) {
      tx.update(transactions)
        .set({ importFileId: plan.heirFileId })
        .where(and(inArray(transactions.id, rowIds), eq(transactions.importFileId, plan.fromFileId)))
        .run();
    }
    tx.delete(statementCopies)
      .where(and(eq(statementCopies.importFileId, plan.heirFileId), eq(statementCopies.accountId, plan.accountId)))
      .run();
  }
}

/** Every row id a set of plans moves to an heir, parsed rows only (the un-import's `deleted` side). */
export function handedRowIds(plans: Iterable<readonly CopyHandOver[]>): Set<string> {
  return new Set([...plans].flatMap((list) => list.flatMap((p) => p.rowIds)));
}
