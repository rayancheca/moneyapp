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
 * ## What it may change — his rule, exactly (`reread-unrecorded-face`)
 *
 * The files read again (each older read `superseded`, a new read `parsed` at the profile's version, same name, bytes and
 * archived original) and the records they write (`printed_lines`, `statement_copies`, `account_numbers`). Nothing else:
 * every live row keeps its money, day, words, category and its source, merchant, note, link, transfer group, series,
 * dedupe key and statement; every period its days, balances, verdict and statement; every recorded balance its amount
 * and the statement it cites; every cached balance day its balance and basis, and no day is added; net worth on every
 * day, and no day added; every /summary year; every other table.
 *
 * 🔴 Measured on a copy of the real ledger (2026-09-28/29), the import changes three more things on its way, and an
 * earlier cut of this script let them through, "allowed, and named" — each one the owner sees (the review of
 * uc/reread-34-runbook, 2026-09-29). The re-read now keeps each as the ledger had it:
 *  - 26 Robinhood month-ends came to cite the next statement's opening instead of the statement that closes on them
 *    (same day, same balance, the other statement in the day's provenance sheet): a re-read keeps each balance citing
 *    the statement it cited (`keepCitations`, services/import/reread-citations.ts);
 *  - the import rebuilds the accounts it reads to today: Discover 15 days, Robinhood Agentic 14, Robinhood Cash 14 and
 *    Robinhood Brokerage 1 were added, the dashboard's "Robinhood Cash … 15 days unchecked" read 28, net worth ran a day
 *    further, and /summary's 2026 return moved with its valuation day (36.34% → 36.17%): the added days are taken back
 *    out (`keepAsTheLedgerHad`);
 *  - 3 Discover dedupe keys (2024-10-29 +$40.00 ×2, 2024-09-18 −$0.79) came back derived from the day each row carries
 *    (their v1 keys come from the back-dated Post Date scripts/fix-discover-backdated-adjustments.ts re-dated in place
 *    without re-keying): each new row keeps its older read's key. Whether to re-key those three is its own question.
 * Each is said in the output ("kept"), and the comparison refuses any it did not keep.
 *
 * Rehearsed on copies of the real ledger (sha 2bc4573f…), 2026-09-29: dry run PASS — 34 files read again, 62
 * printed-line records, 0 statement copies, 0 card numbers, nothing else; --confirm WRITTEN PASS, the archive
 * byte-identical, no journal left; a second run "Nothing to do"; `ledger-check` exit 0 naming 0 files. Diffed in SQL
 * against the copy it wrote: every cached day, all 314 recorded balances (by the file name and period they cite),
 * 10,328 live rows (with their key and file name) and every period (with its verdict and file name) identical;
 * printed_lines 306 → 368, import_files 340 → 374.
 *
 * ## How it guards
 *
 *  1. Refuse before anything: a write left unfinished (6); the real ledger archiving anywhere but its own statements
 *     root, data/statements (`liveArchiveRoot`); a target whose profile is gone or not newer, whose original is missing
 *     or is not the imported bytes, or whose bytes a read at today's version already holds — the import would take
 *     that read up, and move its original, instead of writing a new one.
 *  2. Rehearse on a `.backup` copy (`--scratch`) whose every row names a file inside scratch, archiving into a scratch
 *     copy of every original the re-read can reach (`copyArchiveInto`): the rehearsal does to that copy exactly what the
 *     write will do to the archive, and a dry run moves and removes nothing outside scratch. The import, then what it
 *     changed that is not a record put back as the ledger had it (`reread-unrecorded-keep`); then compare the copy's
 *     face with the ledger's (`reread-unrecorded-face`), and the archive's copy as the write's archive is compared.
 *  3. Dry run stops there. `--confirm`: the ledger must still be the one rehearsed; a restore point, and a journal beside
 *     the ledger naming it; the import and its keep; the same comparison on the real ledger, which must make exactly the
 *     rehearsal's allowed changes and keep exactly what it kept, name each new read's original where the run archived
 *     it, leave the archive holding the same originals, and record every file.
 *  4. Past the restore point, every way out is that check passing or the restore point put back — a failed check and a
 *     fault alike, and the output says which. A put-back also takes the write's own originals back out of the archive
 *     (`sweepLeftovers`), so nothing it left stops the next rehearsal. The journal goes with either.
 *  5. A second run finds nothing to re-read: "Nothing to do."
 *  6. A journal still there is a write neither checked nor put back — its process killed, or its put-back failed — and
 *     the ledger may hold part of it. Every later run says UNFINISHED rather than plan over it (a half-applied re-read
 *     would pass for done); `--confirm` puts the journal's restore point back, saving what the ledger holds first, takes
 *     the write's own originals out of the archive, and the run after that starts over. Measured on a copy of the real
 *     ledger, 2026-09-29: killed 6 s into the write, the Discover CSV's read left `failed` at v2 and its copy in
 *     discover/; the next dry run said UNFINISHED, `--confirm` put both back, and the run after rehearsed clean.
 *
 *   pnpm tsx scripts/reread-unrecorded-files.ts --db=data/moneyapp.db             # rehearse, write nothing
 *   pnpm tsx scripts/reread-unrecorded-files.ts --db=data/moneyapp.db --confirm   # restore point, write, re-check
 *
 * ⛔ Stop the dev server first: the write replaces the database file if its after-check fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { restoreFromSnapshot, takeRestorePoint } from "@/db/backup";
import { importFiles } from "@/db/schema/imports";
import { todayIso } from "@/lib/dates";
import { fileSha256 } from "@/lib/hash";
import { filesWithoutPrintedLines } from "@/services/import/import-records";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, type FileOutcome, type ImportInput } from "@/services/import/service";
import { DbTargetRefusal, dbTargetFrom } from "./db-target";
import { onRehearsalCopy } from "./guarded-write-harness";
import {
  archiveFailures,
  archiveListing,
  copyArchiveInto,
  liveArchiveRoot,
  sweepLeftovers,
  type ArchiveBefore,
} from "./reread-unrecorded-archive";
import {
  archivedAs,
  compareFaces,
  ledgerFace,
  sameFace,
  withStoragePaths,
  type LedgerFace,
  type RereadTarget,
  type Verdict,
} from "./reread-unrecorded-face";
import { keepAsTheLedgerHad, whatTheLedgerHad } from "./reread-unrecorded-keep";

const LABEL = "reread-unrecorded-files";

export interface RunResult {
  /** `unfinished`: a write neither checked nor put back — found by this run, or left by it */
  outcome: "nothing-to-do" | "refused" | "dry-run" | "written" | "restored" | "unfinished";
  /** what refused the run, or what the write broke before it was put back */
  failures: string[];
  /** what changed that a re-read may change — the rehearsal's, or the write's */
  allowed: string[];
  restorePoint: string | null;
}

/** For the tests. */
export interface Seams {
  /**
   * something the rehearsal did not do, done to the real ledger right after the write (the import, and what it keeps as
   * the ledger had it) — or a fault, or a kill
   */
  afterWrite?: (real: DbBundle) => void | Promise<void>;
  /** the checkout the ledger is judged real against — `process.cwd()` unless a test lays one out */
  cwd?: string;
}

interface Args {
  db: string;
  isReal: boolean;
  confirm: boolean;
  scratch: string;
  /** where the live run archives the re-reads' originals (`liveArchiveRoot`) */
  archiveRoot: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `--db=<path>` (required), `--confirm` bare, `--scratch=<dir>`. ⛔ Anything else is refused — `--confirm=yes` passing
 * for the switch while the write asked for a bare `--confirm` ran a dry run that read like a write (db-target.ts).
 */
function readArgs(argv: readonly string[], cwd: string): Args {
  const stray = argv.filter((a) => a !== "--confirm" && !a.startsWith("--db=") && !a.startsWith("--scratch="));
  if (stray.length > 0) {
    throw new DbTargetRefusal(`unknown argument(s): ${stray.join(" ")} — this script takes --db=<path>, --scratch=<dir> and --confirm`);
  }
  for (const flag of ["--confirm", "--db=", "--scratch="]) {
    if (argv.filter((a) => a.startsWith(flag)).length > 1) throw new DbTargetRefusal(`${flag.replace("=", "")} given twice`);
  }
  const target = dbTargetFrom(argv, { flag: "--db", required: true, cwd, exists: fs.existsSync });
  const scratch = argv.find((a) => a.startsWith("--scratch="))?.slice("--scratch=".length) ?? os.tmpdir();
  if (!fs.existsSync(scratch)) throw new DbTargetRefusal(`no scratch directory at ${scratch}`);
  return {
    db: target.path,
    isReal: target.isReal,
    confirm: argv.includes("--confirm"),
    scratch,
    archiveRoot: liveArchiveRoot(target, cwd, process.env),
  };
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
    // ⛔ the import would take such a read up — its row, and the original it names, wherever that lies — instead of
    // writing a new one (`openMember`, `REIMPORTABLE_STATUSES`): a failed read's original was moved into the rehearsal's
    // scratch, and deleted with it
    const taken = bundle.db
      .select()
      .from(importFiles)
      .where(and(eq(importFiles.fileSha256, file.fileSha256), eq(importFiles.parserVersion, profile.version)))
      .all();
    if (taken.length > 0) {
      const reads = taken.map((t) => `${t.status}, ${t.id}, its original at ${t.storagePath}`).join("; ");
      refuse(`already read at ${profile.id} v${profile.version} (${reads}) — the import would take that read up, not write a new one`);
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

/**
 * The re-read itself, on a ledger: the import, then what it changed that is not a record put back as the ledger had it
 * (`reread-unrecorded-keep`) — the same steps on the rehearsal copy and on the ledger.
 */
async function reread(
  bundle: DbBundle,
  plan: Plan,
  before: LedgerFace,
  archiveRoot: string,
): Promise<{ outcomes: FileOutcome[]; kept: string[] }> {
  const had = whatTheLedgerHad(bundle, plan.targets.map((t) => t.id));
  const outcomes = await archivingInto(archiveRoot, () => importStatementFiles(bundle.db, plan.inputs));
  const fresh = bundle.db
    .select({ id: importFiles.id, sha: importFiles.fileSha256, version: importFiles.parserVersion })
    .from(importFiles)
    .all()
    .filter((f) => !before.files.has(f.id) && plan.targets.some((t) => t.sha === f.sha && t.version === f.version))
    .map((f) => f.id);
  return { outcomes, kept: keepAsTheLedgerHad(bundle, had, fresh) };
}

/** Run with MONEYAPP_ORIGINALS_DIR at `dir` — the import's archive root — put back after. */
async function archivingInto<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.MONEYAPP_ORIGINALS_DIR;
  process.env.MONEYAPP_ORIGINALS_DIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.MONEYAPP_ORIGINALS_DIR;
    else process.env.MONEYAPP_ORIGINALS_DIR = saved;
  }
}

/**
 * The re-read on a throwaway copy of the ledger, archiving into a throwaway copy of the archive (`copyArchiveInto`): the
 * real ledger and archive never see it, and the copy names no file outside scratch. Compared with the ledger as the
 * copy reads it — its rows' originals pointed into scratch, nothing else — and the archive's copy as the write's is.
 */
async function rehearse(real: DbBundle, args: Args, plan: Plan, before: LedgerFace, today: string): Promise<Rehearsal> {
  const work = fs.mkdtempSync(path.join(args.scratch, `${LABEL}-originals-`));
  try {
    return await onRehearsalCopy(real, args.scratch, LABEL, async (copy) => {
      const archive = copyArchiveInto(copy, plan.targets, args.archiveRoot, work);
      const held = archiveListing(archive.root);
      const asCopied = withStoragePaths(before, archive.paths);
      const { outcomes, kept } = await reread(copy, plan, asCopied, archive.root);
      const after = ledgerFace(copy, today);
      const verdict = compareFaces(asCopied, after, { targets: plan.targets, archiveRoot: archive.root });
      const archived = archiveFailures(held, archive.root, copy, plan.targets);
      return { ...verdict, failures: [...outcomeFailures(outcomes, plan), ...verdict.failures, ...archived], kept, headline: after.headline };
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A rehearsal's verdict, what it kept as the ledger had it, and the figures it left. */
interface Rehearsal extends Verdict {
  kept: string[];
  headline: string;
}

function print(title: string, verdict: Pick<Verdict, "failures" | "allowed">, kept: readonly string[] = []): void {
  console.log(`\n${title}  ${verdict.failures.length === 0 ? "PASS" : `FAIL — ${verdict.failures.length} finding(s)`}`);
  for (const f of verdict.failures) console.log(`  ✗ ${f}`);
  for (const a of verdict.allowed) console.log(`  · ${a}`);
  for (const k of kept) console.log(`  = kept: ${k}`);
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
  console.log(`Archive:  ${args.archiveRoot}`);
  const plan = planReread(bundle);
  console.log(`${plan.targets.length} file(s) read at a version their profile has moved past; ${plan.refusals.length} refused`);
  for (const t of plan.targets) console.log(`  RE-READ  ${t.fileName} → ${t.profile} v${t.version}`);
  const backfillable = filesWithoutPrintedLines(bundle.db).filter((f) => f.backfillCanRead).length;
  if (backfillable > 0) console.log(`  (${backfillable} unrecorded file(s) at their profile's version are the backfills' — scripts/record-*.ts)`);
  return plan;
}

/**
 * A write begun and not yet checked nor put back — kept BESIDE the ledger, so a later run finds it whatever became of
 * the run that wrote it. Written after the restore point and before the import touches the ledger; removed once the
 * write passes its check, or the restore point is back.
 *
 * 🔴 Past the restore point a fault escaped as "REFUSED:" and left the re-read written and unchecked — as a kill does —
 * and a second run, finding no file left to re-read, said "Nothing to do" (the review of uc/reread-34-runbook,
 * 2026-09-29).
 */
interface Journal {
  startedAt: string;
  restorePoint: string;
  /** the archive as the write found it — what a put-back takes the write's own originals back out of */
  archive: ArchiveBefore;
}

const journalPath = (db: string): string => `${fs.realpathSync(db)}.${LABEL}.unfinished.json`;

function beginJournal(db: string, journal: Journal): void {
  const at = journalPath(db);
  const staged = `${at}.${process.pid}.tmp`;
  const fd = fs.openSync(staged, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(staged, at);
}

function readJournal(db: string): Journal | null {
  const at = journalPath(db);
  if (!fs.existsSync(at)) return null;
  let read: Partial<Journal> | null = null;
  try {
    read = JSON.parse(fs.readFileSync(at, "utf8")) as Partial<Journal>;
  } catch {
    // named below: a journal that does not read is still a write that may be unfinished
  }
  const archive = read?.archive;
  if (
    typeof read?.restorePoint !== "string" ||
    typeof read.startedAt !== "string" ||
    typeof archive?.root !== "string" ||
    !Array.isArray(archive.held) ||
    !Array.isArray(archive.files)
  ) {
    throw new DbTargetRefusal(`${at} does not name its restore point and archive — a write may be unfinished: read it before anything else`);
  }
  return {
    startedAt: read.startedAt,
    restorePoint: read.restorePoint,
    archive: {
      root: archive.root,
      held: archive.held.map(String),
      files: archive.files.map((f) => ({ name: String(f.name), sha: String(f.sha) })),
    },
  };
}

/** The write is checked or put back: the journal goes — and if it cannot, the next run says so rather than guess. */
function endJournal(db: string): void {
  try {
    fs.rmSync(journalPath(db), { force: true });
  } catch (error: unknown) {
    console.log(`  ✗ the journal ${journalPath(db)} could not be removed (${messageOf(error)}): the next run will call this write unfinished`);
  }
}

/** Once the restore point is back: the write's own originals out of the archive, each said — or why they are not. */
function sweep(restored: DbBundle, archive: ArchiveBefore): string | null {
  try {
    for (const taken of sweepLeftovers(archive, restored)) console.log(`  · took the write's own copy ${taken} out of the archive — nothing names it now`);
    return null;
  } catch (error: unknown) {
    return `the write's own originals could not all be taken out of the archive (${messageOf(error)})`;
  }
}

/**
 * A write the journal says was never checked nor put back. Nothing is planned over it: a dry run says so and stops;
 * `--confirm` puts the journal's restore point back — `restoreFromSnapshot` saves what the ledger holds first — and the
 * write's own originals out of the archive, and the next run starts over.
 */
function unfinished(args: Args, journal: Journal): RunResult {
  const what =
    `a --confirm begun ${journal.startedAt} took the restore point ${journal.restorePoint} and was never checked nor put ` +
    `back — it was killed, or its put-back failed — so the ledger may hold part of the re-read of ${journal.archive.files.length} file(s)`;
  if (!args.confirm) {
    print("UNFINISHED", { failures: [what], allowed: [] });
    console.log("\nNothing was done. Re-run with --confirm to put the restore point back (what the ledger holds is saved first), then run again.");
    return result("unfinished", [what], [], journal.restorePoint);
  }
  const bundle = createDatabase(args.db);
  let reopened: DbBundle | undefined;
  try {
    const restored = restoreFromSnapshot(bundle, journal.restorePoint);
    reopened = restored.reopened;
    const saved = restored.preRestorePath === null ? "" : ` — what the ledger held is saved as ${restored.preRestorePath}`;
    console.log(`\nRESTORED from ${journal.restorePoint}${saved}`);
    const unswept = sweep(reopened, journal.archive);
    if (unswept !== null) {
      const stuck = `${unswept} — run again with --confirm to put the restore point back and take them out again`;
      console.log(`  ✗ ${stuck}`);
      return result("unfinished", [what, stuck], [], journal.restorePoint);
    }
    endJournal(args.db);
    console.log("Run again to plan the re-read afresh.");
    return result("restored", [what], [], journal.restorePoint);
  } catch (error: unknown) {
    const stuck = `the restore point could not be put back: ${messageOf(error)}`;
    print("UNFINISHED", { failures: [what, stuck], allowed: [] });
    return result("unfinished", [what, stuck], [], journal.restorePoint);
  } finally {
    if (reopened?.sqlite.open) reopened.sqlite.close();
    if (bundle.sqlite.open) bundle.sqlite.close();
  }
}

interface Rehearsed {
  plan: Plan;
  before: LedgerFace;
  rehearsal: Rehearsal;
  /** the day every face of this run reads /summary through */
  today: string;
}

/**
 * The write, behind a restore point and a journal, checked as the rehearsal was — and put back when it does not read as
 * its rehearsal did, or faults before it is read. It archives into `args.archiveRoot`: the real ledger's own statements
 * root, or beside a copy (`liveArchiveRoot`).
 */
async function write(bundle: DbBundle, args: Args, rehearsed: Rehearsed, seams: Seams): Promise<RunResult> {
  const { plan, before, rehearsal, today } = rehearsed;
  if (!sameFace(ledgerFace(bundle, today), before)) {
    const moved = ["the ledger changed after the rehearsal read it — run again"];
    print("REFUSED", { failures: moved, allowed: [] });
    return result("refused", moved, rehearsal.allowed);
  }
  const archived = archiveListing(args.archiveRoot);
  const archive: ArchiveBefore = {
    root: args.archiveRoot,
    held: [...archived.keys()],
    files: plan.targets.map((t) => ({ name: path.basename(t.archived), sha: t.sha })),
  };
  const point = takeRestorePoint(bundle.db, LABEL);
  if (point.path === null) return result("refused", [`no restore point was written (${point.reason ?? "skipped"}), so nothing was`]);
  console.log(`\nRestore point: ${point.path}`);
  try {
    beginJournal(args.db, { startedAt: new Date().toISOString(), restorePoint: point.path, archive });
  } catch (error: unknown) {
    const why = [`no journal could be written beside the ledger (${messageOf(error)}), so nothing was written`];
    print("REFUSED", { failures: why, allowed: [] });
    return result("refused", why, rehearsal.allowed);
  }

  // ⛔ from here the ledger may be written: every way out is the check passing, or the restore point put back
  let checked: Pick<Verdict, "failures" | "allowed">;
  try {
    checked = await checkedWrite(bundle, args, rehearsed, archived, seams);
  } catch (error: unknown) {
    checked = { failures: [`the write faulted before it was checked: ${messageOf(error)}`], allowed: [] };
    print("WRITE FAULTED", checked);
  }
  if (checked.failures.length > 0) return putBack(bundle, args, { restorePoint: point.path, before, archive, today }, checked);
  endJournal(args.db);
  console.log("\nDone. Now run `pnpm ledger-check` — it should name no file read at a version its profile has moved past.");
  return result("written", [], checked.allowed, point.path);
}

/** The import on the real ledger, then every check its rehearsal passed. */
async function checkedWrite(
  bundle: DbBundle,
  args: Args,
  { plan, before, rehearsal, today }: Rehearsed,
  archived: ReadonlyMap<string, number>,
  seams: Seams,
): Promise<Pick<Verdict, "failures" | "allowed">> {
  const { outcomes, kept } = await reread(bundle, plan, before, args.archiveRoot);
  await seams.afterWrite?.(bundle);
  const after = ledgerFace(bundle, today);
  const verdict = compareFaces(before, after, { targets: plan.targets, archiveRoot: args.archiveRoot });
  const failures = [
    ...outcomeFailures(outcomes, plan),
    ...verdict.failures,
    ...(verdict.signature === rehearsal.signature ? [] : ["the write did not make the changes its rehearsal made"]),
    ...(JSON.stringify(kept) === JSON.stringify(rehearsal.kept) ? [] : ["the write kept other things as the ledger had them than its rehearsal kept"]),
    ...archiveFailures(archived, args.archiveRoot, bundle, plan.targets),
  ];
  print("WRITTEN", { failures, allowed: verdict.allowed }, kept);
  console.log(`  = after:  ${after.headline}`);
  return { failures, allowed: verdict.allowed };
}

/** What a put-back returns the ledger and its archive to. */
interface PutBackTo {
  restorePoint: string;
  before: LedgerFace;
  archive: ArchiveBefore;
  today: string;
}

/**
 * Restores the restore point over the ledger — which closes `bundle` — says whether it reads as it did, and takes the
 * write's own originals out of the archive. A put-back that cannot be made keeps the journal, so the next run says
 * UNFINISHED: "unfinished".
 */
function putBack(
  bundle: DbBundle,
  args: Args,
  { restorePoint, before, archive, today }: PutBackTo,
  { failures, allowed }: Pick<Verdict, "failures" | "allowed">,
): RunResult {
  let reopened: DbBundle;
  try {
    reopened = restoreOver(bundle, args.db, restorePoint);
  } catch (error: unknown) {
    const stuck =
      `the restore point could not be put back (${messageOf(error)}): the ledger may hold part of the re-read — ` +
      `the next run says UNFINISHED, and its --confirm puts ${restorePoint} back`;
    console.log(`\nNOT RESTORED\n  ✗ ${stuck}`);
    return result("unfinished", [...failures, stuck], allowed, restorePoint);
  }
  try {
    const back = readsAsBefore(reopened, before, today);
    console.log(`\nRESTORED from ${restorePoint}${back === true ? " — the ledger is as it was" : ""}`);
    const unlike = back === true ? [] : [`${back} — compare it with the restore point by hand`];
    for (const u of unlike) console.log(`  ✗ ${u}`);
    const unswept = sweep(reopened, archive);
    if (unswept !== null) {
      const stuck = `${unswept} — the next run says UNFINISHED, and its --confirm puts the restore point back and takes them out again`;
      console.log(`  ✗ ${stuck}`);
      return result("unfinished", [...failures, ...unlike, stuck], allowed, restorePoint);
    }
    endJournal(args.db);
    return result("restored", [...failures, ...unlike], allowed, restorePoint);
  } finally {
    reopened.sqlite.close();
  }
}

/** Whether the restored ledger reads as `before` — or, when it does not or cannot be read, why. */
function readsAsBefore(reopened: DbBundle, before: LedgerFace, today: string): true | string {
  try {
    return sameFace(ledgerFace(reopened, today), before) || "the restored ledger does not read as it did before the write";
  } catch (error: unknown) {
    return `the restored ledger could not be read (${messageOf(error)})`;
  }
}

/** `restoreFromSnapshot` through a handle that can take it — idle and open, which a fault may have left it neither. */
function restoreOver(bundle: DbBundle, db: string, restorePoint: string): DbBundle {
  if (bundle.sqlite.open && bundle.sqlite.inTransaction) bundle.sqlite.exec("ROLLBACK");
  const live = bundle.sqlite.open ? bundle : createDatabase(db);
  try {
    return restoreFromSnapshot(live, restorePoint).reopened;
  } finally {
    if (live !== bundle && live.sqlite.open) live.sqlite.close();
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2), seams: Seams = {}): Promise<RunResult> {
  const args = readArgs(argv, seams.cwd ?? process.cwd());
  const journal = readJournal(args.db);
  if (journal !== null) return unfinished(args, journal);
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
    // one day for every face of the run: /summary reads its years through it, and a run that crosses midnight must not
    // read the clock as a change to the ledger
    const today = todayIso();
    const before = ledgerFace(bundle, today);
    const rehearsal = await rehearse(bundle, args, plan, before, today);
    print("REHEARSAL on a copy", rehearsal, rehearsal.kept);
    console.log(`  = before: ${before.headline}`);
    console.log(`  = after:  ${rehearsal.headline}`);
    if (rehearsal.failures.length > 0) return result("refused", rehearsal.failures, rehearsal.allowed);
    if (!args.confirm) {
      console.log("\nDry run: nothing was written. Re-run with --confirm to write.");
      return result("dry-run", [], rehearsal.allowed);
    }
    return await write(bundle, args, { plan, before, rehearsal, today }, seams);
  } finally {
    // a put-back closed it, and opened the restored file under its own handle
    if (bundle.sqlite.open) bundle.sqlite.close();
  }
}

if (process.argv[1]?.endsWith("reread-unrecorded-files.ts")) {
  main().then(
    (r) => {
      process.exitCode = r.outcome === "refused" || r.outcome === "restored" || r.outcome === "unfinished" ? 1 : 0;
    },
    (error: unknown) => {
      console.error(`REFUSED: ${messageOf(error)}`);
      process.exitCode = 2;
    },
  );
}
