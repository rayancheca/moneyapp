import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { importFiles, statementCopies, statementPeriods } from "@/db/schema/imports";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { descriptionScore } from "@/lib/description-score";
import type { DuplicatePairSide } from "@/lib/hash";
import { attachedRow, parsedRow } from "./attached-rows";

/**
 * A statement downloaded twice, in different bytes (`statement_copies`).
 *
 * The import keeps ONE period row for an account's statement: the second download ADOPTS the first one's
 * (`writeMember`), and every line of it that the first download's rows already record is absorbed, not written.
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
 * ⛔ A parser-version re-read hands over the PERIOD alone, and only lends it (`lendToCopies`, from
 * `supersedeFileContribution`): the new read writes the rows again — a hand-over of rows would leave the older read's
 * rows standing under the copy for good, where no re-read ever reaches them — and a period it writes again it takes
 * back (`reclaimFromCopy`), so the copy stays a copy. A period the new read no longer writes (a section it now
 * withholds) stays with the copy, which prints it.
 *
 * 🔴 ONE rule with one home. The agent's brokerage book had its own (`handOverAdoptedPeriods`, 2026-09-16): the file
 * holding a statement anchor on the period and no period of its own took it, on un-import and on a re-read alike.
 * Two rules decided who keeps a month a second download prints, and they disagreed on a re-read: the anchor rule gave
 * the month to the copy before the new read wrote it, this one left it to the new read. The record here is the one
 * that knows what the copy prints; files imported before it existed get it from scripts/record-statement-copies.ts.
 */

type CopyLine = DuplicatePairSide;

const LIVE_FILE = ["parsed", "parsed_with_claude"] as const;
const LIVE_ROW = ["active", "quarantined", "excluded"] as const;
/** row ids per statement — well under SQLite's bound-parameter limit */
const ROW_CHUNK = 500;

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

/**
 * Every account a file prints a statement of that another download put in the ledger: the accounts its copies name.
 */
export function accountsCopiedBy(db: AppDatabase, importFileId: string): string[] {
  return db
    .select({ accountId: statementCopies.accountId })
    .from(statementCopies)
    .where(eq(statementCopies.importFileId, importFileId))
    .all()
    .map((r) => r.accountId);
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
 * the import absorbs a line (`identityWeight`); the description only ranks rows that already match on money and day.
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

/**
 * A re-read's retirement: each planned period goes to its heir while the heir STAYS recorded as a copy of it — it holds
 * the period only until the re-read writes the period again (`reclaimFromCopy`). No row moves. Call it inside the
 * retirement's transaction, before the retired read's periods are removed.
 *
 * 🔴 Without it, a re-read that no longer writes an account (a section it now withholds) deleted the month a second
 * download still prints: the copy's balances left standing with nothing to reconcile them against, and a brokerage
 * book's later month no longer standing on it — as un-importing the first download did before `handOverToCopies`
 * (measured 2026-09-16 on a real-ledger copy with a constructed Robinhood Agentic November downloaded twice: un-importing
 * October was then no longer refused, the sold 0.1 WMT came back, +$10.95 of net worth on Nov 30, and
 * `pnpm ledger-check` exited 1).
 */
export function lendToCopies(tx: AppDatabase, plans: readonly CopyHandOver[]): void {
  for (const plan of plans) {
    tx.update(statementPeriods).set({ importFileId: plan.heirFileId }).where(eq(statementPeriods.id, plan.periodId)).run();
  }
}

/** A lent period's plan, read before the retirement, with the status each row it names had then. */
export interface LentPeriod {
  plan: CopyHandOver;
  statuses: ReadonlyMap<string, TransactionStatus>;
}

/**
 * What a re-read's retirement will lend (`lendToCopies`), read while the retired read's rows are still live — the rows
 * the copy prints are the ones an un-import would hand it (`copyHandOvers`).
 */
export function lentPeriodsOf(tx: AppDatabase, fileId: string): LentPeriod[] {
  const plans = copyHandOvers(tx, [fileId]).get(fileId) ?? [];
  const ids = plans.flatMap((p) => p.rowIds);
  const statuses = new Map<string, TransactionStatus>();
  for (let i = 0; i < ids.length; i += ROW_CHUNK) {
    for (const r of tx
      .select({ id: transactions.id, status: transactions.status })
      .from(transactions)
      .where(inArray(transactions.id, ids.slice(i, i + ROW_CHUNK)))
      .all()) {
      statuses.set(r.id, r.status);
    }
  }
  return plans.map((plan) => ({ plan, statuses }));
}

/**
 * After a re-read is written: each month it lent a copy and did not take back is the copy's for good — with the rows the
 * copy prints that no live row records now, as un-importing the retired read would have handed them over
 * (`handOverToCopies`). They come back with the status they had, filed under the copy, and the copy is no longer a copy
 * of the month. Returns the ids brought back. Call it inside the re-read's transaction, after every member is written.
 *
 * ⚖️ Owner, 2026-09-16 (decision 16): the rows filed by hand on an account the new version no longer reads are kept as
 * un-import keeps them. 🔴 The re-read lent the copy the month alone, on the premise that the new read writes its rows
 * again; a read that no longer reads the account does not, so the month went to gap under the copy and the payments
 * filed by hand were filed there and quarantined. Measured on a copy of the real ledger, 2026-09-16 (the review of
 * uc/final-integrate): 20260702-statements-9805-.pdf re-read at a version that stops reading Chase Sapphire left
 * 2026-06-03 → 2026-07-02 at gap $51.02 under its second download and 4 hand-filed payments ($2,134.27) quarantined.
 */
export function settleLentPeriods(tx: AppDatabase, lent: readonly LentPeriod[]): string[] {
  const restored: string[] = [];
  for (const { plan, statuses } of lent) {
    const period = tx.select({ importFileId: statementPeriods.importFileId }).from(statementPeriods).where(eq(statementPeriods.id, plan.periodId)).get();
    // taken back by the new read (`reclaimFromCopy`), or gone
    if (period?.importFileId !== plan.heirFileId || plan.rowIds.length === 0) continue;
    const copy = tx
      .select({ lines: statementCopies.lines })
      .from(statementCopies)
      .where(
        and(
          eq(statementCopies.importFileId, plan.heirFileId),
          eq(statementCopies.accountId, plan.accountId),
          eq(statementCopies.periodStart, plan.periodStart),
          eq(statementCopies.periodEnd, plan.periodEnd),
        ),
      )
      .get();
    if (copy === undefined) continue;
    const retired: RowForMatch[] = [];
    for (let i = 0; i < plan.rowIds.length; i += ROW_CHUNK) {
      const ids = plan.rowIds.slice(i, i + ROW_CHUNK);
      retired.push(
        ...rowsFor(tx, and(inArray(transactions.id, ids), eq(transactions.status, "superseded"), eq(transactions.importFileId, plan.fromFileId))!),
      );
    }
    // every live row of the account records a line before a retired one may: the new read's, a row filed by hand, the copy's
    const live = rowsFor(tx, and(eq(transactions.accountId, plan.accountId), inArray(transactions.status, [...LIVE_ROW]))!);
    const back = claimedRows(JSON.parse(copy.lines) as CopyLine[], live, [], retired);
    if (back.length === 0) continue;
    for (const id of back) {
      tx.update(transactions)
        .set({ status: statuses.get(id) ?? "active", importFileId: plan.heirFileId })
        .where(and(eq(transactions.id, id), eq(transactions.status, "superseded")))
        .run();
    }
    tx.delete(statementCopies)
      .where(and(eq(statementCopies.importFileId, plan.heirFileId), eq(statementCopies.accountId, plan.accountId)))
      .run();
    restored.push(...back);
  }
  return restored;
}

/**
 * A period a file is about to adopt goes back to it instead, when the file holding it only prints it as a copy — the
 * period a re-read's retirement lent it (`lendToCopies`) — and the writer holds no period of its own on the account
 * (`ux_statement_periods_file_account`). Returns whether it did; the copy stays recorded as one.
 */
export function reclaimFromCopy(
  tx: AppDatabase,
  period: { id: string; importFileId: string; accountId: string; periodStart: string; periodEnd: string },
  writerFileId: string,
): boolean {
  const lent = tx
    .select({ id: statementCopies.id })
    .from(statementCopies)
    .where(
      and(
        eq(statementCopies.importFileId, period.importFileId),
        eq(statementCopies.accountId, period.accountId),
        eq(statementCopies.periodStart, period.periodStart),
        eq(statementCopies.periodEnd, period.periodEnd),
      ),
    )
    .get();
  if (lent === undefined) return false;
  const held = tx
    .select({ id: statementPeriods.id })
    .from(statementPeriods)
    .where(and(eq(statementPeriods.importFileId, writerFileId), eq(statementPeriods.accountId, period.accountId)))
    .get();
  if (held !== undefined) return false;
  tx.update(statementPeriods).set({ importFileId: writerFileId }).where(eq(statementPeriods.id, period.id)).run();
  return true;
}

/** Every row id a set of plans moves to an heir, parsed rows only (the un-import's `deleted` side). */
export function handedRowIds(plans: Iterable<readonly CopyHandOver[]>): Set<string> {
  return new Set([...plans].flatMap((list) => list.flatMap((p) => p.rowIds)));
}
