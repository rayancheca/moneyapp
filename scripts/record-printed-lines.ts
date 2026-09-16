/**
 * REAL-DB WRITE, insert-only. Records what each imported file prints (`printed_lines`, migration 0021), for the files
 * imported before the importer recorded it itself.
 *
 * ## Why
 *
 * A line another record of the same money already held is absorbed by the import, not written, so nothing said the
 * file prints it — and un-importing the file whose row held the line deleted money a still-imported file prints.
 * Measured on a copy of the real ledger, 2026-09-16: un-importing Spending Report PDF (1).pdf put Chase Sapphire's 8
 * reconciled periods from 2025-12-03 to 2026-08-02 into gap, and un-importing 3ab6c2a8-….csv took 75 Robinhood Cash
 * rows b5cbc3ca37399e25-rh-redownload.csv prints. Since this change an import records every line it reads, and
 * `unimportFile` hands a row a still-imported file prints to that file (`services/import/printed-lines`). The files
 * already in the ledger need the record too, and only the original bytes say what each prints — so this reads each
 * imported file again with the profile and version that imported it (`rereadImported`), and records its lines on each
 * account, as the import does (`printedLineOf`).
 *
 * ## What is written
 *
 * One `printed_lines` row per (file, account). Nothing else: the guards compare every ledger table before and after,
 * byte for byte.
 *
 * ## What is skipped, and said
 *
 * Everything `rereadImported` skips (bytes missing or changed, profile gone or at another version, unreadable); a
 * section no account in the ledger matches; a section none of whose lines any row on its account records (the account
 * it names is not where the import filed it).
 *
 *   pnpm tsx scripts/record-printed-lines.ts --db=data/moneyapp.db [--offset=0] [--limit=60]
 *   pnpm tsx scripts/record-printed-lines.ts --db=data/moneyapp.db [--offset=0] [--limit=60] --confirm
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy (`--scratch=<dir>`, default the OS
 * temp directory). `--confirm` rehearses again, takes a restore point, writes, and re-checks. A second run over the
 * same files reads "nothing to do". `--offset`/`--limit` read the parsed files in import order, a slice at a time.
 */
import fs from "node:fs";
import os from "node:os";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { accounts } from "@/db/schema/accounts";
import { printedLines } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { findAccountId, storedLines } from "@/services/import/service";
import { appendPrintedLines, printedLineOf, printerHandOvers, type PrintedLine } from "@/services/import/printed-lines";
import { copyHandOvers } from "@/services/import/statement-copies";
import { dbTargetFrom, strayFlags } from "./db-target";
import { onRehearsalCopy, sha256Json } from "./guarded-write-harness";
import { LEDGER_TABLES, rereadImported, wholeNumberFlag } from "./reread-imported";

const SNAPSHOT_LABEL = "record-printed-lines";

export interface PlannedLines {
  importFileId: string;
  fileName: string;
  accountId: string;
  accountName: string;
  lines: PrintedLine[];
  /** how many of the lines some live row on the account records by money and day */
  recordedByARow: number;
}

export interface LinesScan {
  planned: PlannedLines[];
  alreadyRecorded: number;
  skipped: string[];
  read: number;
}

/** Whether a live row on the account has the line's money on one of its days. */
function rowRecords(db: DbBundle["db"], accountId: string): (line: PrintedLine) => boolean {
  const keys = new Set<string>();
  for (const r of db
    .select({ postedOn: transactions.postedOn, transactedOn: transactions.transactedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), inArray(transactions.status, ["active", "quarantined", "excluded"])))
    .all()) {
    keys.add(`${r.amountCents}|${r.postedOn}`);
    if (r.transactedOn !== null) keys.add(`${r.amountCents}|${r.transactedOn}`);
  }
  return (line) =>
    [line.printedOn, line.postedOn, line.transactedOn].some((day) => day !== null && keys.has(`${line.amountCents}|${day}`));
}

/** Reads each file again with the profile and version that imported it, and names the lines it prints on each account. */
export async function scanPrintedLines(bundle: DbBundle, offset: number, limit: number): Promise<LinesScan> {
  const { db } = bundle;
  const { reads, skipped } = await rereadImported(bundle, offset, limit);
  const scan: LinesScan = { planned: [], alreadyRecorded: 0, skipped, read: reads.length };
  const records = new Map<string, (line: PrintedLine) => boolean>();
  for (const { file, statements } of reads) {
    const byAccount = new Map<string, PrintedLine[]>();
    for (const statement of statements) {
      const accountId = findAccountId(db, statement.accountHint);
      if (accountId === null) {
        scan.skipped.push(`${file.fileName} (${file.id}): no account for ${statement.accountHint.institution} ····${statement.accountHint.last4 ?? "?"}`);
        continue;
      }
      const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
      const lines = storedLines(accountId, account, statement).map(({ printed, stored }) => printedLineOf(printed, stored));
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), ...lines]);
    }
    for (const [accountId, lines] of byAccount) {
      const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
      const recorded = db
        .select()
        .from(printedLines)
        .where(and(eq(printedLines.importFileId, file.id), eq(printedLines.accountId, accountId)))
        .get();
      if (recorded?.lines === JSON.stringify(lines)) {
        scan.alreadyRecorded += 1;
        continue;
      }
      if (recorded !== undefined) {
        scan.skipped.push(`${file.fileName} (${file.id}) / ${account.name}: recorded already, with other lines`);
        continue;
      }
      if (!records.has(accountId)) records.set(accountId, rowRecords(db, accountId));
      const recordedByARow = lines.filter(records.get(accountId)!).length;
      if (lines.length > 0 && recordedByARow === 0) {
        scan.skipped.push(`${file.fileName} (${file.id}) / ${account.name}: no row on the account records any of its ${lines.length} lines`);
        continue;
      }
      scan.planned.push({ importFileId: file.id, fileName: file.fileName, accountId, accountName: account.name, lines, recordedByARow });
    }
  }
  return scan;
}

export function writePrintedLines(bundle: DbBundle, planned: readonly PlannedLines[]): void {
  bundle.db.transaction((tx) => {
    for (const p of planned) appendPrintedLines(tx, p.importFileId, p.accountId, p.lines);
  });
}

function untouched(bundle: DbBundle): Record<string, string> {
  return Object.fromEntries(
    LEDGER_TABLES.map((t) => [t, sha256Json(bundle.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())]),
  );
}

interface GuardResult {
  failures: string[];
  /** files whose un-import now keeps rows under a file that prints them, and how many rows in all */
  filesKeeping: number;
  rowsKept: number;
}

function writeAndGuard(bundle: DbBundle, planned: readonly PlannedLines[], snapshot: boolean): GuardResult {
  const before = untouched(bundle);
  const countBefore = bundle.db.select().from(printedLines).all().length;
  const write = () => writePrintedLines(bundle, planned);
  if (snapshot) withPreMutationSnapshot(bundle.db, SNAPSHOT_LABEL, write);
  else write();
  const after = untouched(bundle);
  const failures = Object.keys(before).filter((t) => before[t] !== after[t]).map((t) => `${t} changed`);
  const rows = bundle.db.select().from(printedLines).all();
  if (rows.length - countBefore !== planned.length) failures.push(`${rows.length - countBefore} records inserted for ${planned.length} planned`);
  for (const p of planned) {
    const row = rows.find((r) => r.importFileId === p.importFileId && r.accountId === p.accountId);
    if (row?.lines !== JSON.stringify(p.lines)) failures.push(`${p.fileName} / ${p.accountName} not recorded as planned`);
  }
  const plans = printerHandOvers(bundle.db, copyHandOvers(bundle.db));
  return {
    failures,
    filesKeeping: plans.size,
    rowsKept: [...plans.values()].flat().reduce((n, p) => n + p.rowIds.length, 0),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stray = strayFlags(argv, ["--db", "--confirm", "--scratch", "--offset", "--limit"]);
  if (stray.length > 0) throw new Error(`unknown flag(s): ${stray.join(" ")}`);
  const target = dbTargetFrom(argv, { flag: "--db", required: true, cwd: process.cwd(), exists: fs.existsSync });
  const scratch = argv.find((a) => a.startsWith("--scratch="))?.slice("--scratch=".length) ?? os.tmpdir();
  if (!fs.existsSync(scratch)) throw new Error(`no scratch directory at ${scratch}`);
  const offset = wholeNumberFlag(argv, "offset", 0);
  const limit = wholeNumberFlag(argv, "limit", Number.MAX_SAFE_INTEGER);
  const bundle = createDatabase(target.path);
  try {
    const scan = await scanPrintedLines(bundle, offset, limit);
    const lines = scan.planned.reduce((n, p) => n + p.lines.length, 0);
    console.log(`read ${scan.read} files; ${scan.alreadyRecorded} records already written; ${scan.planned.length} to write (${lines} lines)`);
    for (const s of scan.skipped) console.log(`  skipped  ${s}`);
    for (const p of scan.planned) {
      console.log(`  RECORD   ${p.fileName} (${p.importFileId}) / ${p.accountName}: ${p.lines.length} lines, ${p.recordedByARow} with a row of their money`);
    }
    if (scan.planned.length === 0) {
      console.log("\nNothing to do.");
      return;
    }
    const rehearsal = await onRehearsalCopy(bundle, scratch, SNAPSHOT_LABEL, (copy) => writeAndGuard(copy, scan.planned, false));
    console.log(`\nREHEARSAL  ${rehearsal.failures.length === 0 ? "PASS" : `FAIL — ${rehearsal.failures.join("; ")}`}`);
    console.log(`  un-importing any of ${rehearsal.filesKeeping} files now keeps rows another file prints (${rehearsal.rowsKept} rows in all)`);
    if (rehearsal.failures.length > 0) process.exitCode = 1;
    if (!argv.includes("--confirm") || rehearsal.failures.length > 0) {
      if (rehearsal.failures.length === 0) console.log("\nDry run. Re-run with --confirm to write.");
      return;
    }
    const real = writeAndGuard(bundle, scan.planned, true);
    console.log(`\nWRITTEN    ${real.failures.length === 0 ? "PASS" : `FAIL — ${real.failures.join("; ")}`}`);
    if (real.failures.length > 0) process.exitCode = 1;
  } finally {
    bundle.sqlite.close();
  }
}

if (process.argv[1]?.endsWith("record-printed-lines.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
