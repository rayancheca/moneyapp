import path from "node:path";
import { isRealDatabasePath } from "@/db/backup";

/**
 * Which database a write script opens, as its command line names it — ONE
 * reading of `--db=<path>` (import-statements, the account script) and
 * `--from=<path>` (trial-import), so a multi-step write can be rehearsed on a
 * copy with the exact commands the real run will use.
 *
 * ⛔ Every ambiguity is refused rather than resolved:
 *  - a path with nothing behind it — `createDatabase` would quietly CREATE an
 *    empty ledger there, migrate it, and import into it;
 *  - `--db <path>` with a space — the scripts read every non-flag argument as a
 *    statement folder, so the path would be imported and the flag ignored;
 *  - an empty value, or the flag given twice;
 *  - a flag the script requires, missing — it never defaults to the real file.
 */
export class DbTargetRefusal extends Error {}

export interface DbTarget {
  /** absolute */
  readonly path: string;
  /** the owner's ledger (`data/moneyapp.db` under the working directory) rather than a copy */
  readonly isReal: boolean;
}

export interface DbTargetOptions {
  readonly flag: "--db" | "--from";
  readonly required: boolean;
  readonly cwd: string;
  readonly exists: (absolutePath: string) => boolean;
}

export function dbTargetFrom(argv: readonly string[], options: DbTargetOptions): DbTarget {
  const prefix = `${options.flag}=`;
  const given = argv.filter((a) => a === options.flag || a.startsWith(prefix));
  if (given.length > 1) {
    throw new DbTargetRefusal(`${options.flag} given ${given.length} times — which database?`);
  }
  const [arg] = given;
  if (arg === options.flag || arg === prefix) {
    throw new DbTargetRefusal(`${options.flag} needs a path: ${prefix}<path>`);
  }
  if (arg === undefined && options.required) {
    throw new DbTargetRefusal(`${prefix}<path> is required — this script never guesses which database to open`);
  }
  const resolved = path.resolve(options.cwd, arg === undefined ? path.join("data", "moneyapp.db") : arg.slice(prefix.length));
  if (!options.exists(resolved)) {
    throw new DbTargetRefusal(`no database at ${resolved} — refusing to create an empty one`);
  }
  return { path: resolved, isReal: isRealDatabasePath(resolved, options.cwd) };
}

/**
 * The `--flags` a script does not know. ⛔ An unknown flag is not harmless:
 * `pnpm trial-import <folder> --db=<copy>` (import-statements' spelling) would
 * be ignored, and the trial would quietly read the REAL ledger instead of the
 * copy the rehearsal just wrote to.
 */
export function strayFlags(argv: readonly string[], known: readonly string[]): string[] {
  return argv.filter((a) => a.startsWith("--") && !known.some((flag) => a === flag || a.startsWith(`${flag}=`)));
}

/**
 * Where an import against `target` archives the originals it reads.
 *
 * The real ledger archives where the service always has (`undefined`: its own
 * default, data/statements/). ⛔ A copy archives BESIDE itself: otherwise a
 * rehearsal writes the owner's real archive and leaves the copy's
 * `import_files.storage_path` pointing into it. An explicit
 * MONEYAPP_ORIGINALS_DIR wins for either.
 */
export function originalsDirFor(
  target: DbTarget,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configured = env.MONEYAPP_ORIGINALS_DIR;
  if (configured !== undefined && configured !== "") return configured;
  return target.isReal ? undefined : path.join(path.dirname(target.path), "originals");
}
