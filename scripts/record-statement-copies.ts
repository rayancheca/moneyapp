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
import { and, eq } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { accounts } from "@/db/schema/accounts";
import { statementCopies, statementPeriods } from "@/db/schema/imports";
import type { DuplicatePairSide } from "@/lib/hash";
import { findAccountId, statementCopyLines, storedLines } from "@/services/import/service";
import { copyHandOvers, recordStatementCopy } from "@/services/import/statement-copies";
import { dbTargetFrom, strayFlags } from "./db-target";
import { onRehearsalCopy, sha256Json } from "./guarded-write-harness";
import { LEDGER_TABLES, rereadImported, wholeNumberFlag } from "./reread-imported";

const SNAPSHOT_LABEL = "record-statement-copies";

export interface PlannedCopy {
  importFileId: string;
  fileName: string;
  accountId: string;
  accountName: string;
  periodStart: string;
  periodEnd: string;
  ownerFileId: string;
  lines: DuplicatePairSide[];
}

export interface CopyScan {
  planned: PlannedCopy[];
  alreadyRecorded: number;
  skipped: string[];
  read: number;
}

/** Reads each file again with the profile and version that imported it, and names the periods it prints as a copy. */
export async function scanCopies(bundle: DbBundle, offset: number, limit: number): Promise<CopyScan> {
  const { db } = bundle;
  const { reads, skipped } = await rereadImported(bundle, offset, limit);
  const scan: CopyScan = { planned: [], alreadyRecorded: 0, skipped, read: reads.length };
  for (const { file, statements } of reads) {
    const skip = (why: string) => scan.skipped.push(`${file.fileName} (${file.id}): ${why}`);
    const owned = new Set(
      db
        .select({ accountId: statementPeriods.accountId })
        .from(statementPeriods)
        .where(eq(statementPeriods.importFileId, file.id))
        .all()
        .map((p) => p.accountId),
    );
    for (const statement of statements) {
      const { period } = statement;
      if (!period) continue;
      const accountId = findAccountId(db, statement.accountHint);
      if (accountId === null) {
        skip(`no account for ${statement.accountHint.institution} ····${statement.accountHint.last4 ?? "?"}`);
        continue;
      }
      if (owned.has(accountId)) continue;
      const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
      const held = db
        .select()
        .from(statementPeriods)
        .where(
          and(
            eq(statementPeriods.accountId, accountId),
            eq(statementPeriods.periodStart, period.start),
            eq(statementPeriods.periodEnd, period.end),
          ),
        )
        .get();
      if (!held) {
        skip(`${account.name} ${period.start} → ${period.end}: no statement period holds it`);
        continue;
      }
      const lines = statementCopyLines(storedLines(accountId, account, statement));
      const recorded = db
        .select()
        .from(statementCopies)
        .where(and(eq(statementCopies.importFileId, file.id), eq(statementCopies.accountId, accountId)))
        .get();
      if (
        recorded &&
        recorded.periodStart === period.start &&
        recorded.periodEnd === period.end &&
        recorded.lines === JSON.stringify(lines)
      ) {
        scan.alreadyRecorded += 1;
        continue;
      }
      scan.planned.push({
        importFileId: file.id,
        fileName: file.fileName,
        accountId,
        accountName: account.name,
        periodStart: period.start,
        periodEnd: period.end,
        ownerFileId: held.importFileId,
        lines,
      });
    }
  }
  return scan;
}

/** Every table the write must leave alone, hashed row by row. */
function untouched(bundle: DbBundle): Record<string, string> {
  return Object.fromEntries(
    LEDGER_TABLES.map((t) => [t, sha256Json(bundle.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())]),
  );
}

export function writeCopies(bundle: DbBundle, planned: readonly PlannedCopy[]): void {
  bundle.db.transaction((tx) => {
    for (const copy of planned) {
      recordStatementCopy(tx, {
        importFileId: copy.importFileId,
        accountId: copy.accountId,
        periodStart: copy.periodStart,
        periodEnd: copy.periodEnd,
        lines: copy.lines,
      });
    }
  });
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

if (process.argv[1]?.endsWith("record-statement-copies.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
