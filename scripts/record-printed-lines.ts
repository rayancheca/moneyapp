/**
 * REAL-DB WRITE, insert-only. Records what each imported file prints (`printed_lines`, migration 0022), for the files
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
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { printedLines } from "@/db/schema/imports";
import { printerHandOvers } from "@/services/import/printed-lines";
import { copyHandOvers } from "@/services/import/statement-copies";
import { dbTargetFrom, parseBackfillArgs } from "./db-target";
import { onRehearsalCopy, sha256Json } from "./guarded-write-harness";
import { LEDGER_TABLES } from "./reread-imported";
import { scanPrintedLines, writePrintedLines, type PlannedLines } from "@/services/import/import-records/printed-lines";

export { scanPrintedLines, writePrintedLines };

const SNAPSHOT_LABEL = "record-printed-lines";

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

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // ⛔ before anything is opened: every argument this script does not take is refused (`parseBackfillArgs`)
  const args = parseBackfillArgs(argv);
  const target = dbTargetFrom(argv, { flag: "--db", required: true, cwd: process.cwd(), exists: fs.existsSync });
  const scratch = args.scratch ?? os.tmpdir();
  if (!fs.existsSync(scratch)) throw new Error(`no scratch directory at ${scratch}`);
  const { offset, limit } = args;
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
    if (!args.confirm || rehearsal.failures.length > 0) {
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
