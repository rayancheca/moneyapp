/**
 * REAL-DB WRITE, insert-only. Records the card numbers an account's statements printed before its current one
 * (`account_numbers`, migration 0020), read from the statements already filed under it.
 *
 * ## Why
 *
 * The import matched a statement to an account by `accounts.last4` alone. Venture X is 4208, merged by hand from the
 * numbers its earlier statements print (9082, then 4147 — docs/future-ideas.md, pass 12), so un-importing any of
 * capitalone-venturex-statement-2026-02..06.pdf and importing the same bytes again created a second "Venture X" and
 * filed the statement under it. Measured on a copy of the real ledger, 2026-09-16: re-importing 2026-03 made
 * accounts 13 → 14 and took net worth −$149.15. `resolveAccount` now asks `account_numbers` after `last4`.
 *
 * ## What is recorded, and the evidence for it
 *
 * For each parsed file read again with the profile and version that imported it (`rereadImported`): each statement
 * section that prints a number and a period, whose period this file holds (or prints as a copy, `statement_copies`) on
 * an account with a DIFFERENT number — the owner filed that statement under that account. Refused when another
 * account at the institution carries the printed number (the import would match that one), or when two accounts would
 * take it.
 *
 * Nothing else is written; the guards compare every ledger table before and after, and check that each recorded
 * statement's hint now resolves to the account that holds it.
 *
 *   pnpm tsx scripts/record-account-numbers.ts --db=data/moneyapp.db [--offset=0] [--limit=60]
 *   pnpm tsx scripts/record-account-numbers.ts --db=data/moneyapp.db [--offset=0] [--limit=60] --confirm
 *
 * The dry run rehearses on a throwaway `.backup` copy (`--scratch=<dir>`); `--confirm` rehearses, takes a restore
 * point, writes and re-checks. A second run reads "nothing to do".
 */
import fs from "node:fs";
import os from "node:os";
import { and, eq, or } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { accountNumbers } from "@/db/schema/account-numbers";
import { accounts } from "@/db/schema/accounts";
import { statementCopies, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { recordFormerNumber } from "@/services/import/account-numbers";
import { findAccountId } from "@/services/import/service";
import type { AccountHint } from "@/services/import/types";
import { dbTargetFrom, parseBackfillArgs } from "./db-target";
import { onRehearsalCopy, sha256Json } from "./guarded-write-harness";
import { LEDGER_TABLES, rereadImported } from "./reread-imported";

const SNAPSHOT_LABEL = "record-account-numbers";

export interface PlannedNumber {
  accountId: string;
  accountName: string;
  currentLast4: string;
  last4: string;
  /** the statements that print it, with the hint each carries */
  evidence: { fileName: string; period: string; hint: AccountHint }[];
}

export interface NumberScan {
  planned: PlannedNumber[];
  alreadyRecorded: number;
  skipped: string[];
  read: number;
}

/** The account holding a file's statement for these dates: the file's own period, or the one it prints as a copy. */
function holderOf(bundle: DbBundle, fileId: string, start: string, end: string): string[] {
  const { db } = bundle;
  const own = db
    .select({ accountId: statementPeriods.accountId })
    .from(statementPeriods)
    .where(and(eq(statementPeriods.importFileId, fileId), eq(statementPeriods.periodStart, start), eq(statementPeriods.periodEnd, end)))
    .all();
  const copied = db
    .select({ accountId: statementCopies.accountId })
    .from(statementCopies)
    .where(and(eq(statementCopies.importFileId, fileId), eq(statementCopies.periodStart, start), eq(statementCopies.periodEnd, end)))
    .all();
  return [...new Set([...own, ...copied].map((r) => r.accountId))];
}

export async function scanNumbers(bundle: DbBundle, offset: number, limit: number): Promise<NumberScan> {
  const { db } = bundle;
  const { reads, skipped } = await rereadImported(bundle, offset, limit);
  const scan: NumberScan = { planned: [], alreadyRecorded: 0, skipped, read: reads.length };
  const byKey = new Map<string, PlannedNumber>();
  for (const { file, statements } of reads) {
    for (const statement of statements) {
      const { period, accountHint: hint } = statement;
      if (!period || hint.last4 === undefined) continue;
      const holders = holderOf(bundle, file.id, period.start, period.end);
      if (holders.length !== 1) continue;
      const account = db
        .select({ id: accounts.id, name: accounts.name, last4: accounts.last4, institution: institutions.name })
        .from(accounts)
        .innerJoin(institutions, eq(institutions.id, accounts.institutionId))
        .where(eq(accounts.id, holders[0]!))
        .get()!;
      if (account.last4 === null || account.last4 === hint.last4 || account.institution !== hint.institution) continue;
      const where = `${file.fileName} (${file.id}) prints ····${hint.last4} for ${account.name} ····${account.last4}`;
      const rival = db
        .select({ name: accounts.name })
        .from(accounts)
        .where(and(eq(accounts.institutionId, db.select({ id: institutions.id }).from(institutions).where(eq(institutions.name, hint.institution))), eq(accounts.last4, hint.last4)))
        .get();
      if (rival) {
        scan.skipped.push(`${where}: ${rival.name} carries that number`);
        continue;
      }
      const recorded = db
        .select()
        .from(accountNumbers)
        .where(and(eq(accountNumbers.accountId, account.id), eq(accountNumbers.last4, hint.last4)))
        .get();
      if (recorded) {
        scan.alreadyRecorded += 1;
        continue;
      }
      const key = `${account.id}\x1f${hint.last4}`;
      const planned = byKey.get(key) ?? { accountId: account.id, accountName: account.name, currentLast4: account.last4, last4: hint.last4, evidence: [] };
      planned.evidence.push({ fileName: file.fileName, period: `${period.start} → ${period.end}`, hint });
      byKey.set(key, planned);
    }
  }
  // a number two accounts would take is nobody's
  const takers = new Map<string, string[]>();
  for (const p of byKey.values()) takers.set(p.last4, [...(takers.get(p.last4) ?? []), p.accountName]);
  for (const p of byKey.values()) {
    const names = takers.get(p.last4)!;
    if (names.length > 1) scan.skipped.push(`····${p.last4} is printed by statements of ${names.join(" and ")} — recorded for neither`);
    else scan.planned.push(p);
  }
  return scan;
}

export function writeNumbers(bundle: DbBundle, planned: readonly PlannedNumber[]): void {
  bundle.db.transaction((tx) => {
    for (const p of planned) recordFormerNumber(tx, p.accountId, p.last4);
  });
}

function untouched(bundle: DbBundle): Record<string, string> {
  return Object.fromEntries(
    LEDGER_TABLES.map((t) => [t, sha256Json(bundle.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())]),
  );
}

function writeAndGuard(bundle: DbBundle, planned: readonly PlannedNumber[], snapshot: boolean): string[] {
  const before = untouched(bundle);
  const write = () => writeNumbers(bundle, planned);
  if (snapshot) withPreMutationSnapshot(bundle.db, SNAPSHOT_LABEL, write);
  else write();
  const after = untouched(bundle);
  const failures = Object.keys(before).filter((t) => before[t] !== after[t]).map((t) => `${t} changed`);
  for (const p of planned) {
    const row = bundle.db
      .select()
      .from(accountNumbers)
      .where(and(eq(accountNumbers.accountId, p.accountId), eq(accountNumbers.last4, p.last4)))
      .get();
    if (!row) failures.push(`${p.accountName} ····${p.last4} not recorded`);
    for (const e of p.evidence) {
      const resolved = findAccountId(bundle.db, e.hint);
      if (resolved !== p.accountId) failures.push(`${e.fileName} would still resolve to ${resolved ?? "a new account"}`);
    }
  }
  const stray = bundle.db
    .select()
    .from(accountNumbers)
    .where(or(...planned.map((p) => and(eq(accountNumbers.accountId, p.accountId), eq(accountNumbers.last4, p.last4)))))
    .all().length;
  if (planned.length > 0 && stray !== planned.length) failures.push(`${stray} rows for ${planned.length} planned numbers`);
  return failures;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // ⛔ before anything is opened: every argument this script does not take is refused (`parseBackfillArgs`)
  const args = parseBackfillArgs(argv);
  const target = dbTargetFrom(argv, { flag: "--db", required: true, cwd: process.cwd(), exists: fs.existsSync });
  const scratch = args.scratch ?? os.tmpdir();
  if (!fs.existsSync(scratch)) throw new Error(`no scratch directory at ${scratch}`);
  const bundle = createDatabase(target.path);
  try {
    const scan = await scanNumbers(bundle, args.offset, args.limit);
    console.log(`read ${scan.read} files; ${scan.alreadyRecorded} numbers already recorded; ${scan.planned.length} to record`);
    for (const s of scan.skipped) console.log(`  skipped  ${s}`);
    for (const p of scan.planned) {
      console.log(`  RECORD   ${p.accountName} (····${p.currentLast4}) also printed ····${p.last4}:`);
      for (const e of p.evidence) console.log(`             ${e.fileName} ${e.period}`);
    }
    if (scan.planned.length === 0) {
      console.log("\nNothing to do.");
      return;
    }
    const rehearsal = await onRehearsalCopy(bundle, scratch, SNAPSHOT_LABEL, (copy) => writeAndGuard(copy, scan.planned, false));
    console.log(`\nREHEARSAL  ${rehearsal.length === 0 ? "PASS" : `FAIL — ${rehearsal.join("; ")}`}`);
    if (rehearsal.length > 0) {
      process.exitCode = 1;
      return;
    }
    if (!args.confirm) {
      console.log("\nDry run. Re-run with --confirm to write.");
      return;
    }
    const real = writeAndGuard(bundle, scan.planned, true);
    console.log(`\nWRITTEN    ${real.length === 0 ? "PASS" : `FAIL — ${real.join("; ")}`}`);
    if (real.length > 0) process.exitCode = 1;
  } finally {
    bundle.sqlite.close();
  }
}

if (process.argv[1]?.endsWith("record-account-numbers.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
