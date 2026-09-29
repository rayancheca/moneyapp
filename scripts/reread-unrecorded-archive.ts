/**
 * Where the originals of scripts/reread-unrecorded-files.ts live: the archive the live run writes, the rehearsal's copy
 * of it, and what a run must leave there.
 */
import fs from "node:fs";
import path from "node:path";
import type { DbBundle } from "@/db/client";
import { importFiles } from "@/db/schema/imports";
import { fileSha256 } from "@/lib/hash";
import { defaultStatementsRoot } from "@/services/import/service";
import { DbTargetRefusal, originalsDirFor, type DbTarget } from "./db-target";
import type { RereadTarget } from "./reread-unrecorded-face";

/**
 * Where the live run archives the re-reads' originals.
 *
 * ⛔ The real ledger archives into ITS OWN statements root — data/statements beside it (`defaultStatementsRoot`), where
 * every original it names lives — and nowhere else. 🔴 With MONEYAPP_ORIGINALS_DIR set, a real `--confirm` archived the
 * live re-reads' originals outside data/statements, left the owner's rows naming them there, and still read PASS: the
 * check compared only `<folder>/<name>` (the review of uc/reread-34-runbook, 2026-09-29). So an override that names
 * anywhere else is refused, before anything is read.
 *
 * A copy archives beside itself, or where MONEYAPP_ORIGINALS_DIR says (`originalsDirFor`) — never into a checkout's
 * data/statements, which is an owner's archive: this checkout's or, from a worktree, the main one's (as `dbTargetFrom`
 * refuses a ledger named like a checkout's).
 */
export function liveArchiveRoot(target: DbTarget, cwd: string, env: Readonly<Record<string, string | undefined>>): string {
  const own = defaultStatementsRoot(cwd);
  if (!target.isReal) {
    const copys = path.resolve(cwd, originalsDirFor(target, env) ?? path.join(path.dirname(target.path), "originals"));
    // any checkout's: `own` read from its checkout down — data/statements
    if (copys.endsWith(path.sep + path.relative(cwd, own))) {
      throw new DbTargetRefusal(`${copys} is a checkout's archive — a copy of the ledger never archives into one: point MONEYAPP_ORIGINALS_DIR elsewhere`);
    }
    return copys;
  }
  const configured = env.MONEYAPP_ORIGINALS_DIR;
  if (configured !== undefined && configured !== "" && path.resolve(cwd, configured) !== own) {
    throw new DbTargetRefusal(
      `MONEYAPP_ORIGINALS_DIR=${configured} would archive the real ledger's re-reads outside its own statements root, ${own} — unset it`,
    );
  }
  return own;
}

/** Every original under the archive root, with its size — a write to the ledger must leave this as it was. */
export function archiveListing(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(root, full), fs.statSync(full).size);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** The archive after a run: every original it held, as it was; anything new only a new read's own original, whole. */
export function archiveFailures(
  before: ReadonlyMap<string, number>,
  root: string,
  bundle: DbBundle,
  targets: readonly RereadTarget[],
): string[] {
  const after = archiveListing(root);
  const failures = [...before].filter(([p, size]) => after.get(p) !== size).map(([p]) => `the archive's ${p} is gone or changed`);
  const fresh = bundle.db
    .select()
    .from(importFiles)
    .all()
    .filter((f) => targets.some((t) => t.sha === f.fileSha256 && t.version === f.parserVersion));
  const owned = new Set(fresh.map((f) => path.relative(root, f.storagePath)));
  for (const p of after.keys()) if (!before.has(p) && !owned.has(p)) failures.push(`a file the re-read left in the archive: ${p}`);
  for (const f of fresh) {
    const whole = fs.existsSync(f.storagePath) && fileSha256(fs.readFileSync(f.storagePath)) === f.fileSha256;
    if (!whole) failures.push(`${f.fileName}'s original at ${f.storagePath} is not its bytes`);
  }
  return failures;
}

/** A re-read file as the archive knows it: the name its original is archived under, and its bytes' hash. */
export interface ArchivedFile {
  name: string;
  sha: string;
}

/** The archive as a write found it: what a put-back takes the write's own originals back out of (`sweepLeftovers`). */
export interface ArchiveBefore {
  root: string;
  /** every file under `root` before the write, by its path there */
  held: string[];
  files: ArchivedFile[];
}

/**
 * Once the restore point is back: the originals the write itself left in the archive, taken out — each file under the
 * root that was not there before it, bears a re-read file's archived name, holds that file's bytes, and no row of the
 * restored ledger names. Only the import writes such a file: its own copy, archived before it reads the file and moved
 * or removed after (`archiveTo`, `relocateArchive`), or a new read's original. Returns what it took, by path.
 *
 * 🔴 A write killed part-way through a file left its copy in the institution's folder (measured on a copy of the real
 * ledger, 2026-09-29: `discover/7831e92d0df25ccb-Discover-AllAvailable-20260710.csv`), and after the put-back every
 * rehearsal refused, since the write would remove it. Nothing that was in the archive before the write is touched, nor
 * any file a row names, nor anything that is not a copy of a re-read file.
 */
export function sweepLeftovers(archive: ArchiveBefore, restored: DbBundle): string[] {
  const held = new Set(archive.held);
  const heldDirs = new Set(archive.held.map((p) => path.dirname(path.join(archive.root, p))));
  const named = new Set(restored.db.select({ storagePath: importFiles.storagePath }).from(importFiles).all().map((f) => f.storagePath));
  const taken: string[] = [];
  for (const relative of archiveListing(archive.root).keys()) {
    const full = path.join(archive.root, relative);
    const file = archive.files.find((f) => f.name === path.basename(relative));
    if (held.has(relative) || file === undefined || named.has(full) || fileSha256(fs.readFileSync(full)) !== file.sha) continue;
    fs.rmSync(full);
    taken.push(relative);
    const folder = path.dirname(full);
    if (folder !== archive.root && !heldDirs.has(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
  }
  return taken;
}

/** `file` as a path under `root`, or null when it lies outside it. */
function within(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  const outside = relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? null : relative;
}

export interface ArchiveCopy {
  /** the rehearsal's archive root */
  root: string;
  /** each row's `storage_path` on the rehearsal copy, by `import_files.id` */
  paths: Map<string, string>;
}

/**
 * The rehearsal's archive: a scratch copy of every original under `liveRoot` the re-read can reach — and every row of
 * the rehearsal copy pointed inside scratch.
 *
 * The import moves and removes only the original its row names, and files under its archive root named after a file it
 * reads, `<sha16>-<name>` (`archiveTo`, `relocateArchive`). So each file under `liveRoot` bearing a re-read file's name
 * is copied in, in whatever folder it lies; each row's `storage_path` becomes its place in the copy — or
 * `<work>/elsewhere/<id>/<name>` when it lies outside `liveRoot`; and the rehearsal archives into the copy. It does
 * there exactly what the write will do to the archive, and nothing it does can reach a file outside scratch.
 *
 * 🔴 It archived into an empty scratch folder while the rehearsal copy's rows named the owner's originals. A read of the
 * same bytes at today's version (a failed one) was taken up by the rehearsal, its REAL original moved into scratch — and
 * scratch deleted after: a DRY RUN removed an original from the ledger's own archive. And an original the write would
 * remove was never there for the rehearsal to see (the review of uc/reread-34-runbook, 2026-09-29).
 */
export function copyArchiveInto(copy: DbBundle, targets: readonly RereadTarget[], liveRoot: string, work: string): ArchiveCopy {
  const root = path.join(work, "archive");
  fs.mkdirSync(root, { recursive: true });
  const reachable = new Set(targets.map((t) => path.basename(t.archived)));
  for (const relative of archiveListing(liveRoot).keys()) {
    if (!reachable.has(path.basename(relative))) continue;
    const to = path.join(root, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(liveRoot, relative), to, fs.constants.COPYFILE_FICLONE);
  }
  const paths = new Map<string, string>();
  for (const { id, storagePath } of copy.db.select({ id: importFiles.id, storagePath: importFiles.storagePath }).from(importFiles).all()) {
    const under = within(liveRoot, storagePath);
    paths.set(id, under === null ? path.join(work, "elsewhere", id, path.basename(storagePath)) : path.join(root, under));
  }
  const repoint = copy.sqlite.prepare("UPDATE import_files SET storage_path = ? WHERE id = ?");
  copy.sqlite.transaction(() => {
    for (const [id, storagePath] of paths) repoint.run(storagePath, id);
  })();
  return { root, paths };
}
