/**
 * REAL-DB WRITE. Re-reads every live file its profile has moved past, so each records what it prints — and refuses
 * unless nothing but the records changes.
 *
 * ## Why
 *
 * 34 files on the real ledger have no record of what they print: `Discover-AllAvailable-20260710.csv` (read at v1, its
 * profile at v2) and 33 Robinhood brokerage statements (v3/v4, profile v5). The backfills read a file only at the
 * version that imported it, so nothing but a re-read at today's version records them, and without the record an
 * un-import of any file whose rows one of them also prints loses those rows (`printerHandOvers` knows a printer only by
 * its record). `pnpm ledger-check` names them on every run.
 *
 * ⚖️ Owner, 2026-09-28 (§6A 26): re-read them so the records exist, KEEPING every category — refuse if anything but
 * the records changes. (An earlier rehearsal had moved Robinhood Agentic's +$26.64 leg to Internal Transfer and
 * /summary's 2026 return 33.87% → 33.81%; `engineCategoryCarry` has carried detection's category with its link since.)
 *
 * ## Measured on a copy of the real ledger, 2026-09-28 (main 604334c)
 *
 * All 34 parsed; 737 rows re-written (625 Discover, 112 Robinhood), 0 quarantined, 0 withheld; 62 printed-line
 * records, and `ledger-check` then names 0 files. Every live row keeps its money, day, description, category, source,
 * merchant, note, transfer group and series; periods, the balance on every anchored day, holding events, series,
 * budgets and every other table are unchanged by content; net worth is unchanged on every day, and /summary 2022–2026
 * (his returns among them) is byte-identical. Read on both copies through `next dev`, 33 surfaces: every page but two
 * is identical, text and figures. What moves, each allowed here only in exactly this form and named in the output:
 *  - /imports: 340 → 374 files — each re-read file twice, its new read "Parsed, imported <today>" and the old one
 *    "Superseded" (every un-import confirmation reads as it did);
 *  - 3 Discover dedupe keys (2024-10-29 +$40.00 ×2, 2024-09-18 −$0.79) now derive from the day each row carries: the
 *    v1 keys came from the back-dated Post Date that fix-discover-backdated-adjustments.ts re-dated in place;
 *  - 40 balance days carried to today — the import rebuilds the accounts it read, whose caches were last rebuilt Sep
 *    14/15: Discover 14, Robinhood Agentic 13, Robinhood Cash 13. So the dashboard's and /imports' "Robinhood Cash …
 *    15 days unchecked, of 41" reads the true "28 days … of 54" (it has been 28 days since Sep 1), "68 of 7,752
 *    days … rest on nothing" reads "81 of 7,792", and "882 days … carried forward" reads "909";
 *  - 26 Robinhood month-end balances cite the statement that opens the next day instead of the one that closes on
 *    them — both print the same balance on that day; the re-read reads the months oldest first, and the last file to
 *    write a day owns it (`upsertAnchor`). Seen only in that day's provenance sheet.
 *
 * ## How it guards
 *
 *  1. Refuse before anything: a target whose profile is gone or not newer, whose original is missing or is not the
 *     imported bytes.
 *  2. Rehearse on a `.backup` copy (`--scratch`), archiving into a scratch folder: import the 34, then compare the
 *     copy's face with the ledger's (`reread-unrecorded-face`). New balance days must be exactly what `rebuildAccount`
 *     writes on a second copy of the untouched ledger.
 *  3. Dry run stops there. `--confirm`: the ledger must still be the one rehearsed; a restore point; the import; the
 *     same comparison on the real ledger, which must make exactly the rehearsal's allowed changes, leave the archive
 *     holding the same originals, and record every file. Any failure RESTORES the restore point and says so.
 *  4. A second run finds nothing to re-read: "Nothing to do."
 *
 *   pnpm tsx scripts/reread-unrecorded-files.ts --db=data/moneyapp.db             # rehearse, write nothing
 *   pnpm tsx scripts/reread-unrecorded-files.ts --db=data/moneyapp.db --confirm   # restore point, write, re-check
 *
 * ⛔ Stop the dev server first: the write replaces the database file if its after-check fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { restoreFromSnapshot, takeRestorePoint } from "@/db/backup";
import { accounts } from "@/db/schema/accounts";
import { importFiles } from "@/db/schema/imports";
import { fileSha256 } from "@/lib/hash";
import { rebuildAccount } from "@/services/derivation";
import { filesWithoutPrintedLines } from "@/services/import/import-records";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, statementsRoot, type FileOutcome, type ImportInput } from "@/services/import/service";
import { DbTargetRefusal, dbTargetFrom, originalsDirFor } from "./db-target";
import { onRehearsalCopy } from "./guarded-write-harness";
import {
  archivedAs,
  balancesOf,
  compareFaces,
  ledgerFace,
  sameFace,
  type LedgerFace,
  type RereadTarget,
  type Verdict,
} from "./reread-unrecorded-face";

const LABEL = "reread-unrecorded-files";

export interface RunResult {
  outcome: "nothing-to-do" | "refused" | "dry-run" | "written" | "restored";
  /** what refused the run, or what the write broke before it was put back */
  failures: string[];
  /** what changed that a re-read may change — the rehearsal's, or the write's */
  allowed: string[];
  restorePoint: string | null;
}

/** For the tests: something the rehearsal did not do, done to the real ledger right after the import. */
export interface Seams {
  afterWrite?: (real: DbBundle) => void;
}

interface Args {
  db: string;
  isReal: boolean;
  confirm: boolean;
  scratch: string;
}

/**
 * `--db=<path>` (required), `--confirm` bare, `--scratch=<dir>`. ⛔ Anything else is refused — `--confirm=yes` passing
 * for the switch while the write asked for a bare `--confirm` ran a dry run that read like a write (db-target.ts).
 */
function readArgs(argv: readonly string[]): Args {
  const stray = argv.filter((a) => a !== "--confirm" && !a.startsWith("--db=") && !a.startsWith("--scratch="));
  if (stray.length > 0) {
    throw new DbTargetRefusal(`unknown argument(s): ${stray.join(" ")} — this script takes --db=<path>, --scratch=<dir> and --confirm`);
  }
  for (const flag of ["--confirm", "--db=", "--scratch="]) {
    if (argv.filter((a) => a.startsWith(flag)).length > 1) throw new DbTargetRefusal(`${flag.replace("=", "")} given twice`);
  }
  const target = dbTargetFrom(argv, { flag: "--db", required: true, cwd: process.cwd(), exists: fs.existsSync });
  const scratch = argv.find((a) => a.startsWith("--scratch="))?.slice("--scratch=".length) ?? os.tmpdir();
  if (!fs.existsSync(scratch)) throw new DbTargetRefusal(`no scratch directory at ${scratch}`);
  return { db: target.path, isReal: target.isReal, confirm: argv.includes("--confirm"), scratch };
}

interface Plan {
  targets: RereadTarget[];
  inputs: ImportInput[];
  refusals: string[];
}

/** The files the backfills cannot read (`filesWithoutPrintedLines` — the rule ledger-check names them by), each checked. */
function planReread(bundle: DbBundle): Plan {
  const plan: Plan = { targets: [], inputs: [], refusals: [] };
  for (const unrecorded of filesWithoutPrintedLines(bundle.db).filter((f) => !f.backfillCanRead)) {
    const file = bundle.db.select().from(importFiles).where(eq(importFiles.id, unrecorded.id)).get()!;
    const refuse = (why: string) => plan.refusals.push(`${file.fileName} (${file.id}): ${why}`);
    const profile = PROFILES.find((p) => p.id === file.parserProfile);
    if (profile === undefined) {
      refuse(`no profile ${file.parserProfile ?? "(none)"} reads it any more`);
      continue;
    }
    if (profile.version <= file.parserVersion) {
      refuse(`read at ${profile.id} v${file.parserVersion} and the profile is at v${profile.version} — not a re-read`);
      continue;
    }
    if (!fs.existsSync(file.storagePath)) {
      refuse(`no original at ${file.storagePath}`);
      continue;
    }
    const buffer = fs.readFileSync(file.storagePath);
    if (fileSha256(buffer) !== file.fileSha256) {
      refuse(`${file.storagePath} is not the imported bytes`);
      continue;
    }
    plan.targets.push({
      id: file.id,
      fileName: file.fileName,
      sha: file.fileSha256,
      profile: profile.id,
      version: profile.version,
      archived: archivedAs(file.storagePath),
    });
    // the name it was imported under: the archive name is derived from it, so the new read lands on the same original
    plan.inputs.push({ name: file.fileName, buffer });
  }
  return plan;
}

/** A read that did not parse whole is not a re-read that changed nothing but the records. */
function outcomeFailures(outcomes: readonly FileOutcome[], plan: Plan): string[] {
  const failures = outcomes.flatMap((o) => [
    ...(o.status === "parsed" ? [] : [`${o.fileName}: ${o.status}${o.error ? ` — ${o.error}` : ""}`]),
    ...o.withheld.map((w) => `${o.fileName}: withheld — ${w.notice}`),
  ]);
  const read = new Set(outcomes.map((o) => o.fileName));
  return [...failures, ...plan.targets.filter((t) => !read.has(t.fileName)).map((t) => `${t.fileName}: never read`)];
}

/** Every account rebuilt on a copy of the untouched ledger — the only balances a new cached day may hold. */
async function rebuiltBalances(real: DbBundle, scratch: string): Promise<Map<string, string>> {
  return onRehearsalCopy(real, scratch, `${LABEL}-rebuild`, (copy) => {
    for (const { id } of copy.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(copy.db, id);
    return balancesOf(copy);
  });
}

/** Run with MONEYAPP_ORIGINALS_DIR at `dir`, put back after. */
async function archivingInto<T>(dir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.MONEYAPP_ORIGINALS_DIR;
  if (dir !== undefined) process.env.MONEYAPP_ORIGINALS_DIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.MONEYAPP_ORIGINALS_DIR;
    else process.env.MONEYAPP_ORIGINALS_DIR = saved;
  }
}

/** The re-read on a throwaway copy, archiving into a throwaway folder — the real archive and ledger never see it. */
async function rehearse(
  real: DbBundle,
  plan: Plan,
  before: LedgerFace,
  rebuilt: Map<string, string>,
  scratch: string,
): Promise<Verdict & { headline: string }> {
  const originals = fs.mkdtempSync(path.join(scratch, `${LABEL}-originals-`));
  try {
    return await archivingInto(originals, () =>
      onRehearsalCopy(real, scratch, LABEL, async (copy) => {
        const outcomes = await importStatementFiles(copy.db, plan.inputs);
        const after = ledgerFace(copy);
        const verdict = compareFaces(before, after, { targets: plan.targets, rebuilt });
        return { ...verdict, failures: [...outcomeFailures(outcomes, plan), ...verdict.failures], headline: after.headline };
      }),
    );
  } finally {
    fs.rmSync(originals, { recursive: true, force: true });
  }
}

/** Every original under the archive root, with its size — a write to the ledger must leave this as it was. */
function archiveListing(root: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(root, full), fs.statSync(full).size);
    }
  };
  walk(root);
  return out;
}

/** The archive after the write: every original it held, as it was; anything new only a new read's own original, whole. */
function archiveFailures(before: ReadonlyMap<string, number>, root: string, real: DbBundle, plan: Plan): string[] {
  const after = archiveListing(root);
  const failures = [...before].filter(([p, size]) => after.get(p) !== size).map(([p]) => `the archive's ${p} is gone or changed`);
  const fresh = real.db
    .select()
    .from(importFiles)
    .all()
    .filter((f) => plan.targets.some((t) => t.sha === f.fileSha256 && t.version === f.parserVersion));
  const owned = new Set(fresh.map((f) => path.relative(root, f.storagePath)));
  for (const p of after.keys()) if (!before.has(p) && !owned.has(p)) failures.push(`a file the re-read left in the archive: ${p}`);
  for (const f of fresh) {
    const whole = fs.existsSync(f.storagePath) && fileSha256(fs.readFileSync(f.storagePath)) === f.fileSha256;
    if (!whole) failures.push(`${f.fileName}'s original at ${f.storagePath} is not its bytes`);
  }
  return failures;
}

function print(title: string, verdict: Pick<Verdict, "failures" | "allowed">): void {
  console.log(`\n${title}  ${verdict.failures.length === 0 ? "PASS" : `FAIL — ${verdict.failures.length} finding(s)`}`);
  for (const f of verdict.failures) console.log(`  ✗ ${f}`);
  for (const a of verdict.allowed) console.log(`  · ${a}`);
}

const result = (outcome: RunResult["outcome"], failures: string[], allowed: string[] = [], restorePoint: string | null = null): RunResult => ({
  outcome,
  failures,
  allowed,
  restorePoint,
});

/** The plan, said: what is re-read, and what refuses it. */
function planned(bundle: DbBundle, args: Args): Plan {
  console.log(`Database: ${args.db}${args.isReal ? " (the real ledger)" : ""}`);
  const plan = planReread(bundle);
  console.log(`${plan.targets.length} file(s) read at a version their profile has moved past; ${plan.refusals.length} refused`);
  for (const t of plan.targets) console.log(`  RE-READ  ${t.fileName} → ${t.profile} v${t.version}`);
  const backfillable = filesWithoutPrintedLines(bundle.db).filter((f) => f.backfillCanRead).length;
  if (backfillable > 0) console.log(`  (${backfillable} unrecorded file(s) at their profile's version are the backfills' — scripts/record-*.ts)`);
  return plan;
}

interface Rehearsed {
  plan: Plan;
  before: LedgerFace;
  rebuilt: Map<string, string>;
  rehearsal: Verdict;
}

/**
 * The write, behind a restore point, checked as the rehearsal was — and put back when it does not read as its
 * rehearsal did. ⛔ A write to a COPY archives beside the copy (`originalsDirFor`): otherwise it writes the owner's real
 * archive and leaves the copy's `storage_path` pointing into it. The real ledger archives where the import always does.
 */
async function write(bundle: DbBundle, args: Args, { plan, before, rebuilt, rehearsal }: Rehearsed, seams: Seams): Promise<RunResult> {
  if (!sameFace(ledgerFace(bundle), before)) {
    const moved = ["the ledger changed after the rehearsal read it — run again"];
    print("REFUSED", { failures: moved, allowed: [] });
    return result("refused", moved, rehearsal.allowed);
  }
  const archive = originalsDirFor({ path: args.db, isReal: args.isReal }, process.env);
  const root = archive ?? statementsRoot();
  const archived = archiveListing(root);
  const point = takeRestorePoint(bundle.db, LABEL);
  if (point.path === null) return result("refused", [`no restore point was written (${point.reason ?? "skipped"}), so nothing was`]);
  console.log(`\nRestore point: ${point.path}`);

  const outcomes = await archivingInto(archive, () => importStatementFiles(bundle.db, plan.inputs));
  seams.afterWrite?.(bundle);
  const after = ledgerFace(bundle);
  const verdict = compareFaces(before, after, { targets: plan.targets, rebuilt });
  const failures = [
    ...outcomeFailures(outcomes, plan),
    ...verdict.failures,
    ...(verdict.signature === rehearsal.signature ? [] : ["the write did not make the changes its rehearsal made"]),
    ...archiveFailures(archived, root, bundle, plan),
  ];
  print("WRITTEN", { failures, allowed: verdict.allowed });
  console.log(`  = after:  ${after.headline}`);
  if (failures.length === 0) {
    console.log("\nDone. Now run `pnpm ledger-check` — it should name no file read at a version its profile has moved past.");
    return result("written", [], verdict.allowed, point.path);
  }
  return putBack(bundle, point.path, before, failures, verdict.allowed);
}

/** Restores the restore point over the ledger — which closes `bundle` — and says whether it reads as it did. */
function putBack(bundle: DbBundle, restorePoint: string, before: LedgerFace, failures: string[], allowed: string[]): RunResult {
  const { reopened } = restoreFromSnapshot(bundle, restorePoint);
  try {
    const back = sameFace(ledgerFace(reopened), before);
    console.log(`\nRESTORED from ${restorePoint}${back ? " — the ledger is as it was" : ""}`);
    if (back) return result("restored", failures, allowed, restorePoint);
    const unlike = "the restored ledger does not read as it did before the write — compare it with the restore point by hand";
    console.log(`  ✗ ${unlike}`);
    return result("restored", [...failures, unlike], allowed, restorePoint);
  } finally {
    reopened.sqlite.close();
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2), seams: Seams = {}): Promise<RunResult> {
  const args = readArgs(argv);
  const bundle = createDatabase(args.db);
  try {
    const plan = planned(bundle, args);
    if (plan.refusals.length > 0) {
      print("REFUSED before anything was read", { failures: plan.refusals, allowed: [] });
      return result("refused", plan.refusals);
    }
    if (plan.targets.length === 0) {
      console.log("\nNothing to do.");
      return result("nothing-to-do", []);
    }
    const before = ledgerFace(bundle);
    const rebuilt = await rebuiltBalances(bundle, args.scratch);
    const rehearsal = await rehearse(bundle, plan, before, rebuilt, args.scratch);
    print("REHEARSAL on a copy", rehearsal);
    console.log(`  = before: ${before.headline}`);
    console.log(`  = after:  ${rehearsal.headline}`);
    if (rehearsal.failures.length > 0) return result("refused", rehearsal.failures, rehearsal.allowed);
    if (!args.confirm) {
      console.log("\nDry run: nothing was written. Re-run with --confirm to write.");
      return result("dry-run", [], rehearsal.allowed);
    }
    return await write(bundle, args, { plan, before, rebuilt, rehearsal }, seams);
  } finally {
    // a put-back closed it, and opened the restored file under its own handle
    if (bundle.sqlite.open) bundle.sqlite.close();
  }
}

if (process.argv[1]?.endsWith("reread-unrecorded-files.ts")) {
  main().then(
    (r) => {
      process.exitCode = r.outcome === "refused" || r.outcome === "restored" ? 1 : 0;
    },
    (error: unknown) => {
      console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
