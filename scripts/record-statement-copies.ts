/**
 * REAL-DB WRITE, insert-only. Records which imported files are second downloads of a statement another file holds
 * (`statement_copies`, migration 0019), for the files imported before the importer recorded it itself.
 *
 * ## Why
 *
 * A statement downloaded twice, in different bytes, is kept once: the second download adopts the first one's period
 * and every line it prints is absorbed by the first one's rows, so it owns nothing. Un-importing the FIRST download
 * then deleted a period and rows a still-imported file prints. Measured on a copy of the real ledger, 2026-09-16:
 * un-importing 019f5d66 (20230810-statements-3522-.pdf, one of three downloads) removed Chase Checking's reconciled
 * 2023-07-14 → 2023-08-10 period and its 85 rows (−$1,636.84), and turned 60 balance days to `gap`. 73 parsed files
 * own no row and no period.
 *
 * Since this change an import records the copy when it adopts a period, and `unimportFile` hands the period and the
 * rows the copy prints to it (`services/import/statement-copies`). The rows already in the ledger need the record
 * too, and only the original bytes can say what each file prints — so this reads each imported file again with the
 * profile and version that imported it, and records, for each period it prints that ANOTHER file owns, the lines it
 * prints there (`statementCopyLines`, the importer's own rule).
 *
 * ## What is written
 *
 * One `statement_copies` row per (file, account) found. Nothing else: no transaction, period, anchor, balance day or
 * file row moves, and the guards compare every one of those tables before and after, byte for byte.
 *
 * ## What is skipped, and said
 *
 * A file whose bytes are missing or differ from its recorded hash; one whose profile or version is not the one that
 * imported it (a re-read is pending — the re-read records it); one its profile cannot parse; a period no account or no
 * statement period in the ledger matches.
 *
 *   pnpm tsx scripts/record-statement-copies.ts --db=data/moneyapp.db [--offset=0] [--limit=60]
 *   pnpm tsx scripts/record-statement-copies.ts --db=data/moneyapp.db [--offset=0] [--limit=60] --confirm
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy (`--scratch=<dir>`, default the OS
 * temp directory). `--confirm` rehearses again, takes a restore point, writes, and re-checks. A second run over the
 * same files reads "nothing to do". `--offset`/`--limit` read the parsed files in import order, a slice at a time.
 */
import fs from "node:fs";
import os from "node:os";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { statementCopies } from "@/db/schema/imports";
import { copyHandOvers } from "@/services/import/statement-copies";
import { dbTargetFrom, parseBackfillArgs } from "./db-target";
import { onRehearsalCopy, sha256Json } from "./guarded-write-harness";
import { LEDGER_TABLES } from "./reread-imported";
import { scanCopies, writeCopies, type PlannedCopy } from "@/services/import/import-records/statement-copies";

export { scanCopies, writeCopies };

const SNAPSHOT_LABEL = "record-statement-copies";

/** Every table the write must leave alone, hashed row by row. */
function untouched(bundle: DbBundle): Record<string, string> {
  return Object.fromEntries(
    LEDGER_TABLES.map((t) => [t, sha256Json(bundle.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())]),
  );
}

interface GuardResult {
  failures: string[];
  handedRows: number;
  handedPeriods: number;
}

function writeAndGuard(bundle: DbBundle, planned: readonly PlannedCopy[], snapshot: boolean): GuardResult {
  const before = untouched(bundle);
  const copiesBefore = bundle.db.select().from(statementCopies).all().length;
  const write = () => writeCopies(bundle, planned);
  if (snapshot) withPreMutationSnapshot(bundle.db, SNAPSHOT_LABEL, write);
  else write();
  const after = untouched(bundle);
  const failures = Object.keys(before).filter((t) => before[t] !== after[t]).map((t) => `${t} changed`);
  const copiesAfter = bundle.db.select().from(statementCopies).all();
  const inserted = copiesAfter.length - copiesBefore;
  if (inserted > planned.length) failures.push(`${inserted} copies inserted for ${planned.length} planned`);
  for (const copy of planned) {
    const row = copiesAfter.find((c) => c.importFileId === copy.importFileId && c.accountId === copy.accountId);
    if (!row || row.lines !== JSON.stringify(copy.lines) || row.periodStart !== copy.periodStart || row.periodEnd !== copy.periodEnd) {
      failures.push(`${copy.fileName} / ${copy.accountName} not recorded as planned`);
    }
  }
  const plans = [...copyHandOvers(bundle.db).values()].flat();
  return {
    failures,
    handedRows: plans.reduce((n, p) => n + p.rowIds.length, 0),
    handedPeriods: plans.length,
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
    const scan = await scanCopies(bundle, offset, limit);
    console.log(`read ${scan.read} files; ${scan.alreadyRecorded} copies already recorded; ${scan.planned.length} to record`);
    for (const s of scan.skipped) console.log(`  skipped  ${s}`);
    for (const c of scan.planned) {
      console.log(`  RECORD   ${c.fileName} (${c.importFileId}) prints ${c.accountName} ${c.periodStart} → ${c.periodEnd}, ${c.lines.length} lines — held by ${c.ownerFileId}`);
    }
    if (scan.planned.length === 0) {
      console.log("\nNothing to do.");
      return;
    }
    const rehearsal = await onRehearsalCopy(bundle, scratch, SNAPSHOT_LABEL, (copy) => writeAndGuard(copy, scan.planned, false));
    console.log(`\nREHEARSAL  ${rehearsal.failures.length === 0 ? "PASS" : `FAIL — ${rehearsal.failures.join("; ")}`}`);
    console.log(`  un-importing a statement's holder now keeps ${rehearsal.handedPeriods} periods and ${rehearsal.handedRows} rows under another download`);
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

if (process.argv[1]?.endsWith("record-statement-copies.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
