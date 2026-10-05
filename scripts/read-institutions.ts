/**
 * The backfill of `import_files.institution_id` (§6C of the 2026-10-01 handoff), as plan, write and guards. The CLI and
 * the runbook are `scripts/record-read-institutions-2026-10-05.ts`; everything here is importable so the plan, the
 * write and every guard are unit-tested against the app's own import.
 *
 * ## Why
 *
 * The import recorded the bank it GUESSED from a file's name and first lines (`guessInstitution`: "chase" first, and
 * Chase when nothing matches) and never corrected it once the read resolved its accounts. Measured on a copy of the
 * real ledger, 2026-10-05: of the reads whose rows land in one bank's accounts, 22 live and 24 retired named another.
 * Nothing reads the column outside tests, but it states something false. The import now records the bank of the
 * accounts a read resolved as it settles the read (`recordReadInstitution`); this records it for the rows read before.
 *
 * ## What is written
 *
 * For each `import_files` row, the bank `institutionReadBy` reads from what the row's records name — the import's own
 * rule, asked rather than restated: its rows of any status, its periods and recorded balances, what it prints, the
 * statements it prints a copy of (a book it wrote trades to, through its period) — where that differs from the bank it
 * names. A row whose records name no account (a read that failed before it wrote, or withheld every section; a retired
 * read whose retirement kept no row) or accounts at two banks keeps the bank it names. `institution_id` alone,
 * `updated_at` too left as it is, in ONE transaction.
 *
 * ## Guards — refuse before, throw after
 *
 * Before: the plan is made again inside the write's transaction and must be the one shown — each row still naming the
 * bank it named, and no other to correct — or nothing is written. After, before vs after: every table but `import_files`
 * byte-identical · every `import_files` column but `institution_id`, on every row · `institution_id` moved on exactly
 * the planned rows, each from the bank it named to the one planned · a second run plans nothing to do.
 */
import os from "node:os";
import path from "node:path";
import type { DbBundle } from "@/db/client";
import { importFiles, type ImportStatus } from "@/db/schema/imports";
import { institutionReadBy } from "@/services/import/service";
import { dbTargetFrom, strayFlags, type DbTargetOptions } from "./db-target";
import { changedKeys, sha256Json } from "./guarded-write-harness";

export const SNAPSHOT_LABEL = "record-read-institutions";

/** Nothing was written: the command line or the ledger is not what this write expects. */
export class InstitutionRefusal extends Error {}

/** One read whose records name accounts at one bank, and the bank it names is another. */
export interface InstitutionChange {
  readonly id: string;
  readonly fileName: string;
  readonly status: ImportStatus;
  /** the bank the row names now — the importer's guess */
  readonly from: string;
  /** the bank of the accounts its records name */
  readonly to: string;
}

export interface InstitutionPlan {
  readonly changes: readonly InstitutionChange[];
  /** rows whose records name no account, or accounts at two banks: the bank they name stays */
  readonly unresolved: number;
  /** rows that name the bank of their accounts already */
  readonly agreeing: number;
}

export function planInstitutions({ db }: Pick<DbBundle, "db">): InstitutionPlan {
  const reads = db
    .select({ id: importFiles.id, fileName: importFiles.fileName, status: importFiles.status, institutionId: importFiles.institutionId })
    .from(importFiles)
    .orderBy(importFiles.id)
    .all();
  const changes: InstitutionChange[] = [];
  let unresolved = 0;
  let agreeing = 0;
  for (const read of reads) {
    const resolved = institutionReadBy(db, read.id);
    if (resolved === null) unresolved += 1;
    else if (resolved === read.institutionId) agreeing += 1;
    else changes.push({ id: read.id, fileName: read.fileName, status: read.status, from: read.institutionId, to: resolved });
  }
  return { changes, unresolved, agreeing };
}

/**
 * The write: each planned row's `institution_id`, in ONE transaction — `updated_at` with it, left as it is. A ledger
 * that no longer plans exactly `changes` rolls all of it back.
 */
export function applyInstitutions(bundle: DbBundle, changes: readonly InstitutionChange[]): void {
  bundle.sqlite.transaction(() => {
    const now = planInstitutions(bundle).changes;
    if (sha256Json(now) !== sha256Json(changes)) {
      throw new InstitutionRefusal(`the ledger moved since the plan: it plans ${now.length} row(s) now, ${changes.length} were shown`);
    }
    const set = bundle.sqlite.prepare("UPDATE import_files SET institution_id = ? WHERE id = ?");
    for (const change of changes) set.run(change.to, change.id);
  })();
}

export interface InstitutionState {
  /** every table but `import_files`, hashed — this write touches none */
  readonly tables: ReadonlyMap<string, string>;
  /** every `import_files` column but `institution_id`, per row */
  readonly besideInstitution: ReadonlyMap<string, string>;
  readonly institutions: ReadonlyMap<string, string>;
}

export function captureInstitutionState({ sqlite }: Pick<DbBundle, "sqlite">): InstitutionState {
  const names = (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'import_files' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  const tables = new Map(names.map((name) => [name, sha256Json(sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())]));
  const besideInstitution = new Map<string, string>();
  const institutions = new Map<string, string>();
  for (const row of sqlite.prepare("SELECT * FROM import_files ORDER BY id").all() as Record<string, unknown>[]) {
    const { institution_id: institution, ...rest } = row;
    const id = String(row.id);
    besideInstitution.set(id, JSON.stringify(rest));
    institutions.set(id, String(institution));
  }
  return { tables, besideInstitution, institutions };
}

/** Every guard, before vs after. Empty means the write did exactly what it says and nothing else. */
export function compareInstitutions(before: InstitutionState, after: InstitutionState, changes: readonly InstitutionChange[]): string[] {
  const failures: string[] = [];
  for (const table of changedKeys(before.tables, after.tables)) failures.push(`${table} changed — the write touches no table but import_files`);
  const beside = changedKeys(before.besideInstitution, after.besideInstitution);
  if (beside.length > 0) {
    failures.push(`an import_files column other than institution_id changed on ${beside.length} row(s): ${beside.slice(0, 5).join(", ")}`);
  }
  const planned = changes.map((c) => c.id).sort();
  const moved = changedKeys(before.institutions, after.institutions);
  if (JSON.stringify(moved) !== JSON.stringify(planned)) {
    failures.push(`institution_id moved on ${JSON.stringify(moved)}, expected ${JSON.stringify(planned)}`);
  }
  for (const change of changes) {
    const [from, to] = [before.institutions.get(change.id), after.institutions.get(change.id)];
    if (from !== change.from || to !== change.to) failures.push(`${change.id}: ${from} → ${to}, planned ${change.from} → ${change.to}`);
  }
  return failures;
}

export interface InstitutionRehearsal {
  readonly failures: string[];
  readonly plan: InstitutionPlan;
}

/** Plan, write, guard and re-plan on `copy` — a throwaway `.backup` in the CLI, an imported ledger in the tests. */
export function rehearseInstitutions(copy: DbBundle): InstitutionRehearsal {
  const plan = planInstitutions(copy);
  if (plan.changes.length === 0) throw new InstitutionRefusal("the rehearsal copy plans nothing to write");
  const before = captureInstitutionState(copy);
  applyInstitutions(copy, plan.changes);
  const failures = compareInstitutions(before, captureInstitutionState(copy), plan.changes);
  const again = planInstitutions(copy).changes.length;
  if (again > 0) failures.push(`a second run on the copy plans ${again} row(s), not nothing to do`);
  return { failures, plan };
}

export interface InstitutionsCli {
  readonly dbPath: string;
  readonly confirm: boolean;
  readonly scratch: string;
}

/**
 * `--db=<path>` (required, never guessed — `dbTargetFrom`), `--confirm`, `--scratch=<dir>`; anything else is refused.
 * ⛔ `--confirm` only bare: `--confirm=yes` reads like a write and ran a dry run in the backfills (`parseBackfillArgs`).
 */
export function parseInstitutionsCli(argv: readonly string[], env: Pick<DbTargetOptions, "cwd" | "exists">): InstitutionsCli {
  const stray = [...strayFlags(argv.filter((a) => a !== "--confirm"), ["--db", "--scratch"]), ...argv.filter((a) => !a.startsWith("--"))];
  if (stray.length > 0) {
    throw new InstitutionRefusal(`unknown argument "${stray[0]}" — this write takes --db=<path>, --confirm and --scratch=<dir>`);
  }
  const target = dbTargetFrom(argv, { flag: "--db", required: true, ...env });
  const scratchArgs = argv.filter((a) => a === "--scratch" || a.startsWith("--scratch="));
  if (scratchArgs.length > 1) throw new InstitutionRefusal(`--scratch given ${scratchArgs.length} times`);
  const [scratchArg] = scratchArgs;
  if (scratchArg === "--scratch" || scratchArg === "--scratch=") throw new InstitutionRefusal("--scratch needs a directory: --scratch=<dir>");
  const scratch = scratchArg === undefined ? os.tmpdir() : path.resolve(env.cwd, scratchArg.slice("--scratch=".length));
  if (!env.exists(scratch)) throw new InstitutionRefusal(`no scratch directory at ${scratch}`);
  return { dbPath: target.path, confirm: argv.includes("--confirm"), scratch };
}
