import fs from "node:fs";
import path from "node:path";
import { isWithin } from "@/lib/path-within";
import { defaultStatementsRoot, originalOfArchivedCopy, type ImportInput } from "@/services/import/service";
import { DbTargetRefusal, originalsDirFor, type DbTarget } from "./db-target";

/**
 * The statement folders an import's command line names — `pnpm import-statements` and `pnpm trial-import` read every
 * file in them, subfolders included — and the places those folders must stay out of: the archives of originals, and
 * the folder the trial wipes.
 *
 * ⛔ The archive keeps each original as `<sha>-<name>` (the import's `archivedName`). Handed a folder inside it, the
 * import records every file under that sha-prefixed name, archives each AGAIN as `<sha>-<sha>-<name>`, and reads an
 * archived activity CSV that no profile matches by that name: a FAILED row on /imports. 🔴 Measured on a copy in the
 * review of the §6A 23 runbook: `data/statements/chase-checking-3522` recorded its 75 statements that way and left 75
 * duplicate PDFs in the archive — which restoring the ledger does not remove. The archive is re-dropped from a staged
 * folder.
 */

/** The runbook whose step 2 stages the archive's originals outside data/ before an import reads them. */
export const STAGED_PATH_RUNBOOK = "scripts/pin-fordham-aid-2026-09-28.ts";

/** What the import reads from a folder: every statement file in it, subfolders included. */
const STATEMENT_FILE = /\.(pdf|csv|qfx|ofx)$/i;

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

/**
 * A folder the statement folders must stay out of, and must not hold: an archive of originals, by its path — or a
 * folder the run wipes before the import reads, `{ wiped }`: the trial's own, .trial/.
 */
export type OffLimits = string | { readonly wiped: string };

/** `folder` as the file system reads it from `cwd`: joined, never `path.resolve`d, which folds `link/..` away first. */
function fromCwd(folder: string, cwd: string): string {
  return path.isAbsolute(folder) ? folder : `${cwd}${path.sep}${folder}`;
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

/** Why `where` is refused, and the staged path that re-drops the originals `source` holds. */
function refusal(where: string, source: string): string {
  return [
    `${where}. The archive keeps each original as <sha>-<name>: read as an original, every such file is recorded ` +
      "under that name and archived AGAIN as <sha>-<sha>-<name> — copies a restore of the ledger leaves behind — and " +
      "an archived activity CSV matches no profile by its name: a FAILED import.",
    `Re-drop the originals from the staged path instead (${STAGED_PATH_RUNBOOK}, step 2) — a folder OUTSIDE data/, one ` +
      "sha subfolder per original, each under the name the ledger recorded:",
    `  S=$(mktemp -d); for f in ${source}/*.pdf; do b=$(basename "$f"); h=\${b%%-*}; ` +
      'mkdir -p "$S/$h" && cp "$f" "$S/$h/${b#????????????????-}"; done',
    '  pnpm trial-import "$S"',
    '  pnpm import-statements "$S" --confirm',
  ].join("\n");
}

type Relation = "inside" | "is" | "holds";

/** `p` as the operator reads it: from the working directory when it lies inside it, whole when it does not. */
const shownFrom = (p: string, cwd: string): string => (isWithin(p, cwd) ? path.relative(cwd, p) || "." : p);

function folderRefusal(folder: string, archive: string, relation: Relation, cwd: string): string {
  const shown = shownFrom(archive, cwd);
  if (relation === "inside") return refusal(`${folder} is inside the statement archive, ${shown}`, folder);
  // the loop copies from an account's folder: the archive's own, as the folder named holds no originals of its own
  return refusal(
    `${folder} ${relation} the statement archive, ${shown}, and the import reads every subfolder`,
    path.join(shown, "<account>"),
  );
}

/**
 * Why `folder` is refused when the run wipes `wiped` before the import reads. 🔴 The trial refused only its archive,
 * .trial/originals, and wipes all of .trial/ AFTER it reads the folders: a folder staged at .trial/staged was trialled
 * (exit 0, "parsed 1"), deleted with the rest, and the import the trial stood in for found no folder to read.
 */
function wipedRefusal(folder: string, wiped: string, relation: Relation, cwd: string): string {
  const verb = relation === "inside" ? "is inside" : relation;
  const reads = relation === "holds" ? ", and the import reads every subfolder" : "";
  return [
    `${folder} ${verb} the trial's own folder, ${shownFrom(wiped, cwd)}, which every trial wipes before it ` +
      `imports${reads}: the trial would read the statements in it and then delete them, and the import it stands in ` +
      "for would find nothing to read.",
    "Stage the statements outside it, then trial and import them from there:",
    `  S=$(mktemp -d); cp -R ${relation === "holds" ? "<statements>" : folder}/. "$S"`,
    '  pnpm trial-import "$S"',
    '  pnpm import-statements "$S" --confirm',
  ].join("\n");
}

/**
 * ⛔ Refuses any of `folders` that is inside one of `offLimits` or holds one — before a byte of it is read, and in the
 * order `offLimits` lists them. Compared by REAL path, so a symlink, macOS's /var → /private/var and a letter case the
 * file system ignores all name the same folder. `realpathSync.native`, not `realpathSync` — measured, the JS one gets
 * two of those wrong: it hands `/USERS/…/DEV` back in the case typed, and it folds `link/..` away before following
 * `link`.
 *
 * A folder with nothing behind it is refused too: there is no real path to compare, and the import would only crash
 * on it later. An archive not made yet holds nothing, so it is passed over.
 */
export function refuseArchiveFolders(
  folders: readonly string[],
  offLimits: readonly OffLimits[],
  cwd: string,
  realpath: (p: string) => string = fs.realpathSync.native,
): void {
  const roots = offLimits.flatMap((place) => {
    const given = typeof place === "string" ? place : place.wiped;
    const real = realOrNothing(given, realpath);
    return real === undefined ? [] : [{ given, real, wiped: typeof place !== "string" }];
  });
  for (const folder of folders) {
    const real = realOrNothing(fromCwd(folder, cwd), realpath);
    if (real === undefined) throw new DbTargetRefusal(`no statement folder at ${path.resolve(cwd, folder)}`);
    for (const root of roots) {
      const relation: Relation | null =
        real === root.real ? "is" : isWithin(real, root.real) ? "inside" : isWithin(root.real, real) ? "holds" : null;
      if (relation === null) continue;
      const why = root.wiped ? wipedRefusal : folderRefusal;
      throw new DbTargetRefusal(why(folder, root.given, relation, cwd));
    }
  }
}

interface Found {
  /** the file's path from the folder as it was named, for the operator */
  readonly shown: string;
  readonly input: ImportInput;
}

/** Every statement file under `dir`. Paths are joined as strings, for the same reason as `fromCwd`. */
function walk(dir: string, shown: string): Found[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Found[] => {
    const at = `${dir}${path.sep}${entry.name}`;
    const as = path.join(shown, entry.name);
    if (entry.isDirectory()) return walk(at, as);
    if (!STATEMENT_FILE.test(entry.name)) return [];
    return [{ shown: as, input: { name: entry.name, buffer: fs.readFileSync(at) } }];
  });
}

/**
 * Every statement file in `folders`, subfolders included — what both commands hand the import — once every folder has
 * passed `refuseArchiveFolders`.
 *
 * ⛔ And a file named as the archive names its own copy (`originalOfArchivedCopy`, after its own bytes) is refused
 * wherever it lies: an archive folder copied out with `cp -r`, another checkout's archive read from a worktree (which
 * has none of its own to compare), a symlink under the archive's name. Read as an original, it does what the archive's
 * folder does. The /imports upload refuses the same files by the same rule.
 */
export function statementFiles(
  folders: readonly string[],
  offLimits: readonly OffLimits[],
  cwd: string,
  realpath: (p: string) => string = fs.realpathSync.native,
): ImportInput[] {
  refuseArchiveFolders(folders, offLimits, cwd, realpath);
  const found = folders.flatMap((folder) => walk(fromCwd(folder, cwd), folder));
  const copy = found.find(({ input }) => originalOfArchivedCopy(input) !== undefined);
  if (copy !== undefined) {
    throw new DbTargetRefusal(
      refusal(`${copy.shown} is a copy out of the statement archive: named <sha>-<name> after its own bytes`, path.dirname(copy.shown)),
    );
  }
  return found.map(({ input }) => input);
}
