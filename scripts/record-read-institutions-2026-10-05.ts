/**
 * REAL-DB WRITE — §6C of the 2026-10-01 handoff: `import_files.institution_id` names the bank of the accounts each
 * read resolved, not the bank the importer guessed from the file's name and first lines (`guessInstitution` — Chase,
 * whenever nothing else matches). The import records it as it settles a read now (`recordReadInstitution`); this
 * records it for the rows read before.
 *
 * The plan, the write and every guard are in `scripts/read-institutions.ts`. This file is the command line.
 *
 * ## The runbook — from the main checkout, with the dev server stopped
 *
 *   pnpm tsx scripts/record-read-institutions-2026-10-05.ts --db=data/moneyapp.db             # dry run: plan + rehearsal
 *   pnpm tsx scripts/record-read-institutions-2026-10-05.ts --db=data/moneyapp.db --confirm   # restore point, write, guards
 *   pnpm tsx scripts/record-read-institutions-2026-10-05.ts --db=data/moneyapp.db             # NOTHING TO DO
 *   pnpm ledger-check
 *
 * ## Measured
 *
 * By the round that queued it, on a copy of the real ledger, 2026-10-05: of the reads whose rows land in one bank's
 * accounts, 22 live and 24 retired name another. The rule here also reads a read's periods, recorded balances, printed
 * lines and copy records, so a second download that wrote no row counts too: the dry run prints the count it plans.
 * ⏳ Not yet run on the real ledger, nor on a copy of it, by the branch that wrote it (uc/import-institution-resolved).
 *
 * The dry run rehearses the write and every guard on a throwaway `.backup` copy (in `--scratch=<dir>`, default the OS
 * temp directory; removed afterwards). `--confirm` rehearses again, takes a `pre-*-record-read-institutions.db`
 * restore point beside the ledger, writes, and re-checks every guard. Nothing but `import_files.institution_id` may
 * change; a second run has nothing to do.
 */
import fs from "node:fs";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { isLiveFile } from "@/db/schema/imports";
import { onRehearsalCopy } from "./guarded-write-harness";
import {
  SNAPSHOT_LABEL,
  applyInstitutions,
  captureInstitutionState,
  compareInstitutions,
  parseInstitutionsCli,
  planInstitutions,
  rehearseInstitutions,
  type InstitutionPlan,
} from "./read-institutions";

/** The plan by how a read stands and which bank it moves from and to, with a few of its files. */
function printPlan({ sqlite }: Pick<DbBundle, "sqlite">, plan: InstitutionPlan): void {
  const bankOf = (id: string) => (sqlite.prepare("SELECT name FROM institutions WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? id;
  const groups = new Map<string, string[]>();
  for (const change of plan.changes) {
    const standing = isLiveFile(change.status) ? "in place" : change.status === "superseded" ? "retired" : change.status;
    const key = `${standing.padEnd(8)}  ${`${bankOf(change.from)} → ${bankOf(change.to)}`.padEnd(28)}`;
    groups.set(key, [...(groups.get(key) ?? []), change.fileName]);
  }
  for (const [key, files] of [...groups].sort()) {
    console.log(`  ${key}  ${String(files.length).padStart(4)}  e.g. ${files.slice(0, 3).join(", ")}`);
  }
  console.log(`  ${plan.agreeing} name their accounts' bank already; ${plan.unresolved} name no account, or accounts at two banks: left as they are`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseInstitutionsCli(argv, { cwd: process.cwd(), exists: fs.existsSync });
  const real = createDatabase(cli.dbPath);
  try {
    const plan = planInstitutions(real);
    const count = plan.changes.length;
    console.log(`\n── plan on ${cli.dbPath}: ${count === 0 ? "NOTHING TO DO" : `${count} read(s) name a bank their accounts are not at`}`);
    printPlan(real, plan);
    if (count === 0) return void console.log("NOTHING TO DO — every read whose accounts are at one bank names it");

    const rehearsal = await onRehearsalCopy(real, cli.scratch, SNAPSHOT_LABEL, (copy) => rehearseInstitutions(copy));
    if (rehearsal.failures.length > 0) {
      for (const failure of rehearsal.failures) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ rehearsed on a copy: ${rehearsal.plan.changes.length} row(s), every guard holds, and a second run has nothing to do`);
    if (!cli.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");

    const before = captureInstitutionState(real);
    withPreMutationSnapshot(real.db, SNAPSHOT_LABEL, () => applyInstitutions(real, plan.changes));
    const failures = compareInstitutions(before, captureInstitutionState(real), plan.changes);
    if (failures.length > 0) {
      throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${SNAPSHOT_LABEL}.db restore point:\n${failures.join("\n")}`);
    }
    const again = planInstitutions(real).changes.length;
    console.log(`APPLIED — ${count} row(s); every guard holds; ${again === 0 ? "a second run has nothing to do" : `⚠ a second run plans ${again}`}`);
  } finally {
    real.sqlite.close();
  }
}

if (process.argv[1]?.endsWith("record-read-institutions-2026-10-05.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
