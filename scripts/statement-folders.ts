import fs from "node:fs";
import path from "node:path";
import { defaultStatementsRoot } from "@/services/import/service";
import { DbTargetRefusal, originalsDirFor, type DbTarget } from "./db-target";

/**
 * The statement folders an import's command line names — `pnpm import-statements` and `pnpm trial-import` read every
 * file in them, subfolders included — and the archives of originals those folders must stay out of.
 *
 * ⛔ The archive keeps each original as `<sha>-<name>` (the import's `recordFile`). Handed a folder inside it, the import
 * records every file under that sha-prefixed name, archives each AGAIN as `<sha>-<sha>-<name>`, and reads an archived
 * activity CSV that no profile matches by that name: a FAILED row on /imports. 🔴 Measured on a copy in the review of
 * the §6A 23 runbook: `data/statements/chase-checking-3522` recorded its 75 statements that way and left 75 duplicate
 * PDFs in the archive — which restoring the ledger does not remove. The archive is re-dropped from a staged folder.
 */

/** The runbook whose step 2 stages the archive's originals outside data/ before an import reads them. */
export const STAGED_PATH_RUNBOOK = "scripts/pin-fordham-aid-2026-09-28.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The archives an import against `target` must not read from: the checkout's own (`defaultStatementsRoot`) — a
 * rehearsal on a copy stands in for the real run, so it refuses what the real run refuses — and the one this run
 * archives into (`originalsDirFor`: a copy's, beside it, or MONEYAPP_ORIGINALS_DIR).
 */
export function archiveRootsFor(target: DbTarget, cwd: string, env: Env): string[] {
  const own = defaultStatementsRoot(cwd);
  const written = originalsDirFor(target, env);
  return written === undefined ? [own] : [own, path.resolve(cwd, written)];
}

/** `child` is `parent` or below it. Both absolute; compared by path components, so data/statements-x is not inside. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real path, or undefined when nothing is there. Anything else the file system says is not ours to swallow. */
function realOrNothing(p: string, realpath: (p: string) => string): string | undefined {
  try {
    return realpath(p);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

interface Overlap {
  readonly folder: string;
  readonly archive: string;
  readonly relation: "inside" | "is" | "holds";
}

function refusal({ folder, archive, relation }: Overlap, cwd: string): string {
  const shown = within(archive, cwd) ? path.relative(cwd, archive) || "." : archive;
  const where =
    relation === "inside"
      ? `${folder} is inside the statement archive, ${shown}`
      : `${folder} ${relation} the statement archive, ${shown}, and the import reads every subfolder`;
  // an account's folder is what the loop copies from: the one named, or the archive's own <account> folders
  const source = relation === "inside" ? folder : path.join(shown, "<account>");
  return [
    `${where}. The archive keeps each original as <sha>-<name>: read from there, every file is recorded under that ` +
      "name and archived AGAIN as <sha>-<sha>-<name> — copies a restore of the ledger leaves behind — and an archived " +
      "activity CSV matches no profile by its name: a FAILED import.",
    `Re-drop the originals from the staged path instead (${STAGED_PATH_RUNBOOK}, step 2) — a folder OUTSIDE data/, one ` +
      "sha subfolder per original, each under the name the ledger recorded:",
    `  S=$(mktemp -d); for f in ${source}/*.pdf; do b=$(basename "$f"); h=\${b%%-*}; ` +
      'mkdir -p "$S/$h" && cp "$f" "$S/$h/${b#????????????????-}"; done',
    '  pnpm trial-import "$S"',
    '  pnpm import-statements "$S" --confirm',
  ].join("\n");
}

/**
 * ⛔ Refuses any of `folders` that is inside one of `archives` or holds one — before a byte of it is read. Compared by
 * REAL path, so a symlink, macOS's /var → /private/var and a letter case the file system ignores all name the same
 * folder. `realpathSync.native`, not `realpathSync`: on macOS only the native one returns the case on disk (measured:
 * the JS one handed `/USERS/…/DEV` back as typed).
 *
 * A folder with nothing behind it is refused too: there is no real path to compare, and the import would only crash
 * on it later. An archive not made yet holds nothing, so it is passed over.
 */
export function refuseArchiveFolders(
  folders: readonly string[],
  archives: readonly string[],
  cwd: string,
  realpath: (p: string) => string = fs.realpathSync.native,
): void {
  const roots = archives.flatMap((given) => {
    const real = realOrNothing(given, realpath);
    return real === undefined ? [] : [{ given, real }];
  });
  for (const folder of folders) {
    // joined, never `path.resolve`d: resolving folds `link/..` away before the file system follows `link`
    const real = realOrNothing(path.isAbsolute(folder) ? folder : `${cwd}${path.sep}${folder}`, realpath);
    if (real === undefined) throw new DbTargetRefusal(`no statement folder at ${path.resolve(cwd, folder)}`);
    for (const root of roots) {
      const relation = real === root.real ? "is" : within(real, root.real) ? "inside" : within(root.real, real) ? "holds" : null;
      if (relation !== null) throw new DbTargetRefusal(refusal({ folder, archive: root.given, relation }, cwd));
    }
  }
}
