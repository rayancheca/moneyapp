import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { fileSha256 } from "@/lib/hash";
import { DbTargetRefusal } from "./db-target";
import { STAGED_PATH_RUNBOOK, archiveRootsFor, refuseArchiveFolders } from "./statement-folders";

/**
 * 🔴 The review of the §6A 23 runbook, 2026-09-30: `pnpm import-statements data/statements/chase-checking-3522` — the
 * archive's own folder, where every original is kept as `<sha>-<name>` — recorded the 75 statements under the
 * sha-prefixed name, archived each AGAIN as `<sha>-<sha>-<name>`, and read the folder's archived activity CSV, which no
 * profile matches by that name: a FAILED row on /imports. Restoring the ledger leaves the duplicate files behind.
 * `pnpm trial-import` took the same folder and printed a diff for it.
 *
 * Both commands are run here as the operator runs them — tsx, from a checkout — on a throwaway one: a seeded ledger at
 * data/moneyapp.db and one original archived under data/statements the way the import archives it.
 */

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const MIGRATIONS = path.join(REPO, "src", "db", "migrations");
const FIXTURE = path.join(REPO, "tests", "fixtures", "synthetic", "chase", "Chase1111_Activity_2026-07-01_2026-07-05.CSV");
const ACCOUNT_FOLDER = path.join("data", "statements", "chase-checking-1111");
const SPAWN_TIMEOUT_MS = 120_000;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  // os.tmpdir() on macOS is /var/folders/…, a symlink away from the /private/var/… the scripts' cwd reads
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `statement-folders-${label}-`));
  made.push(dir);
  return dir;
}

/** The archived copy's name, as `recordFile` gives it: the first 16 hex of the sha256, a dash, the name. */
function archivedName(bytes: Buffer, name: string): string {
  return `${fileSha256(bytes).slice(0, 16)}-${name}`;
}

/** A checkout the scripts can run from: data/moneyapp.db (seeded) and one original in its account's archive folder. */
function checkout(): string {
  const root = tempDir("checkout");
  // the scripts migrate the ledger they open from <cwd>/src/db/migrations
  fs.mkdirSync(path.join(root, "src", "db"), { recursive: true });
  fs.symlinkSync(MIGRATIONS, path.join(root, "src", "db", "migrations"));
  const { db, sqlite } = createDatabase(path.join(root, "data", "moneyapp.db"), MIGRATIONS);
  seedDatabase(db);
  sqlite.close();
  const bytes = fs.readFileSync(FIXTURE);
  fs.mkdirSync(path.join(root, ACCOUNT_FOLDER), { recursive: true });
  fs.writeFileSync(path.join(root, ACCOUNT_FOLDER, archivedName(bytes, path.basename(FIXTURE))), bytes);
  return root;
}

/** The runbook's staged folder: outside data/, one sha subfolder, the name the ledger records. */
function staged(): string {
  const dir = tempDir("staged");
  const bytes = fs.readFileSync(FIXTURE);
  const sub = path.join(dir, fileSha256(bytes).slice(0, 16));
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, path.basename(FIXTURE)), bytes);
  return dir;
}

interface Run {
  readonly status: number | null;
  readonly out: string;
  readonly err: string;
}

function run(cwd: string, script: "import-statements" | "trial-import", args: readonly string[]): Run {
  // an override in the caller's environment would move the archive the run writes; these runs use the checkout's.
  // A variable set to undefined is left out of the child's environment, not passed as the text "undefined".
  const env: NodeJS.ProcessEnv = { ...process.env, MONEYAPP_ORIGINALS_DIR: undefined, MONEYAPP_DB_PATH: undefined };
  const r = spawnSync(TSX, ["--tsconfig", path.join(REPO, "tsconfig.json"), path.join(REPO, "scripts", `${script}.ts`), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** Every file under `dir`, by path, with its sha256 — a refused run must leave this exactly as it was. */
function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fileSha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function expectRefusedWithTheStagedPath(r: Run, folder: string): void {
  expect(r.status).toBe(2);
  expect(r.err).toContain("REFUSED:");
  expect(r.err).toContain(folder);
  // the staged path the runbook re-drops the archive from (scripts/pin-fordham-aid-2026-09-28.ts, step 2)
  expect(r.err).toContain("scripts/pin-fordham-aid-2026-09-28.ts");
  expect(r.err).toContain("S=$(mktemp -d)");
  expect(r.err).toContain('pnpm trial-import "$S"');
  expect(r.err).toContain('pnpm import-statements "$S" --confirm');
}

/** A bare checkout for the guard itself: data/statements/chase-checking-1111, the drop folder, data/backups. */
function shelves(): string {
  const root = tempDir("shelves");
  for (const dir of [ACCOUNT_FOLDER, path.join("statements", "discover"), path.join("data", "backups"), path.join("data", "statements-staged")]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

const ownArchive = (root: string): string[] => [path.join(root, "data", "statements")];

function refusalOf(folder: string, root: string, archives: readonly string[] = ownArchive(root)): string {
  try {
    refuseArchiveFolders([folder], archives, root);
  } catch (error: unknown) {
    if (error instanceof DbTargetRefusal) return error.message;
    throw error;
  }
  return "accepted";
}

describe("refuseArchiveFolders — a statement folder must stay out of the archive of originals", () => {
  test("the folders an import is meant to read are accepted: the drop folder, a staged folder, data/'s other folders", () => {
    const root = shelves();
    const stage = staged();
    expect(refusalOf("statements/discover", root)).toBe("accepted");
    expect(refusalOf(stage, root)).toBe("accepted");
    expect(refusalOf("data/backups", root)).toBe("accepted");
    // shares the archive's name as a prefix — compared by path component, not by string
    expect(refusalOf("data/statements-staged", root)).toBe("accepted");
  });

  test("⛔ inside the archive, the archive itself, and a folder holding it — the import reads every subfolder", () => {
    const root = shelves();
    expect(refusalOf(ACCOUNT_FOLDER, root)).toMatch(/^data\/statements\/chase-checking-1111 is inside the statement archive, data\/statements\./);
    expect(refusalOf("data/statements", root)).toMatch(/^data\/statements is the statement archive, data\/statements, and the import reads every subfolder\./);
    expect(refusalOf("data", root)).toMatch(/^data holds the statement archive, data\/statements, and the import reads every subfolder\./);
    expect(refusalOf(".", root)).toMatch(/^\. holds the statement archive/);
  });

  test("⛔ by REAL path: absolute through /var → /private/var, a symlink, `..`, a symlink followed before its `..`", () => {
    const root = shelves();
    // os.tmpdir() is /var/folders/… on macOS; the archive's real path is /private/var/folders/…
    expect(refusalOf(path.join(root, ACCOUNT_FOLDER), root)).toContain("is inside the statement archive");
    fs.symlinkSync(path.join(root, "data", "statements"), path.join(root, "shelf"));
    expect(refusalOf("shelf/chase-checking-1111", root)).toMatch(/^shelf\/chase-checking-1111 is inside the statement archive/);
    expect(refusalOf("shelf", root)).toMatch(/^shelf is the statement archive/);
    expect(refusalOf("data/backups/../statements/chase-checking-1111", root)).toContain("is inside the statement archive");
    // the file system follows `hop` and THEN climbs: hop/.. is data/statements, where `path.resolve` would say <root>
    fs.symlinkSync(path.join(root, ACCOUNT_FOLDER), path.join(root, "hop"));
    expect(refusalOf("hop/../chase-checking-1111", root)).toMatch(/^hop\/\.\.\/chase-checking-1111 is inside the statement archive/);
  });

  test("⛔ the archive reached through a symlink is the archive: its real path is what is compared", () => {
    const root = shelves();
    const elsewhere = tempDir("elsewhere");
    fs.symlinkSync(path.join(root, "data", "statements"), path.join(elsewhere, "statements"));
    expect(refusalOf(ACCOUNT_FOLDER, root, [path.join(elsewhere, "statements")])).toContain("is inside the statement archive");
  });

  const caseBlind = ((): boolean => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "statement-folders-case-"));
    try {
      return fs.existsSync(probe.toUpperCase());
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  })();

  test.runIf(caseBlind)("⛔ a letter case the file system ignores names the same folder (realpathSync.native)", () => {
    const root = shelves();
    expect(refusalOf("DATA/Statements/Chase-Checking-1111", root)).toContain("is inside the statement archive");
  });

  test("⛔ a folder with nothing behind it is refused — there is no real path to compare", () => {
    const root = shelves();
    expect(refusalOf("statements/nope", root)).toBe(`no statement folder at ${path.join(root, "statements", "nope")}`);
  });

  test("an archive not made yet holds nothing, and is passed over", () => {
    const root = shelves();
    expect(refusalOf("statements/discover", root, [path.join(root, "never", "made")])).toBe("accepted");
  });

  test("anything else the file system says is not swallowed", () => {
    const root = shelves();
    const denied = (): string => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    expect(() => refuseArchiveFolders(["statements/discover"], ownArchive(root), root, denied)).toThrow("EACCES");
  });

  test("the refusal names the staged path, copying from the folder named — or from the archive's own account folders", () => {
    const root = shelves();
    const inside = refusalOf(ACCOUNT_FOLDER, root);
    expect(inside).toContain(`Re-drop the originals from the staged path instead (${STAGED_PATH_RUNBOOK}, step 2)`);
    expect(inside).toContain(
      '  S=$(mktemp -d); for f in data/statements/chase-checking-1111/*.pdf; do b=$(basename "$f"); h=${b%%-*}; ' +
        'mkdir -p "$S/$h" && cp "$f" "$S/$h/${b#????????????????-}"; done\n' +
        '  pnpm trial-import "$S"\n' +
        '  pnpm import-statements "$S" --confirm',
    );
    expect(refusalOf("data", root)).toContain("for f in data/statements/<account>/*.pdf;");
    // an archive outside the working directory is named whole
    const copy = tempDir("copy-archive");
    expect(refusalOf(copy, root, [copy])).toContain(`${copy} is the statement archive, ${copy},`);
  });
});

describe("archiveRootsFor — the archives an import against that ledger must not read from", () => {
  const CWD = "/repo";
  const OWN = "/repo/data/statements";
  const REAL = { path: "/repo/data/moneyapp.db", isReal: true };
  const COPY = { path: "/scratch/rehearsal/copy.db", isReal: false };

  test("the real ledger: its own archive, data/statements", () => {
    expect(archiveRootsFor(REAL, CWD, {})).toEqual([OWN]);
  });

  test("a copy: the checkout's archive — the real run's — and the copy's own, beside it", () => {
    expect(archiveRootsFor(COPY, CWD, {})).toEqual([OWN, "/scratch/rehearsal/originals"]);
  });

  test("MONEYAPP_ORIGINALS_DIR moves the archive the run writes, resolved from the working directory", () => {
    expect(archiveRootsFor(REAL, CWD, { MONEYAPP_ORIGINALS_DIR: "elsewhere" })).toEqual([OWN, "/repo/elsewhere"]);
    expect(archiveRootsFor(COPY, CWD, { MONEYAPP_ORIGINALS_DIR: "/tmp/x" })).toEqual([OWN, "/tmp/x"]);
  });
});

describe("⛔ pnpm import-statements refuses a folder inside the statement archive", { timeout: SPAWN_TIMEOUT_MS }, () => {
  test("a dry run is refused before anything is read, and the refusal names the staged path", () => {
    const root = checkout();
    const r = run(root, "import-statements", [ACCOUNT_FOLDER]);
    expectRefusedWithTheStagedPath(r, ACCOUNT_FOLDER);
    expect(r.out).not.toContain("Would import");
  });

  test("--confirm writes nothing: no restore point, no import row, no <sha>-<sha>- copy in the archive", () => {
    const root = checkout();
    const before = listing(path.join(root, "data"));
    const r = run(root, "import-statements", [ACCOUNT_FOLDER, "--confirm"]);
    // the damage first, so a regression reads as what it does to the archive and the ledger
    expect(listing(path.join(root, "data"))).toEqual(before);
    const sqlite = new Database(path.join(root, "data", "moneyapp.db"), { readonly: true, fileMustExist: true });
    try {
      expect(sqlite.prepare("SELECT file_name FROM import_files").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
    expectRefusedWithTheStagedPath(r, ACCOUNT_FOLDER);
  });

  test("by its real path: absolute through macOS's /var → /private/var, and through a symlink to the archive", () => {
    const root = checkout();
    expectRefusedWithTheStagedPath(run(root, "import-statements", [path.join(root, ACCOUNT_FOLDER)]), path.join(root, ACCOUNT_FOLDER));
    fs.symlinkSync(path.join(root, "data", "statements"), path.join(root, "shelf"));
    expectRefusedWithTheStagedPath(run(root, "import-statements", ["shelf/chase-checking-1111"]), "shelf/chase-checking-1111");
  });

  test("a folder that HOLDS the archive is refused too: the import walks every subfolder", () => {
    const root = checkout();
    expectRefusedWithTheStagedPath(run(root, "import-statements", ["data"]), "data");
  });

  test("--db=<copy>: the copy's own archive, beside it, is refused as well as the checkout's", () => {
    const root = checkout();
    const copyDir = tempDir("copy");
    fs.copyFileSync(path.join(root, "data", "moneyapp.db"), path.join(copyDir, "copy.db"));
    const copysArchive = path.join(copyDir, "originals", "chase-1111");
    fs.mkdirSync(copysArchive, { recursive: true });
    for (const f of fs.readdirSync(path.join(root, ACCOUNT_FOLDER))) {
      fs.copyFileSync(path.join(root, ACCOUNT_FOLDER, f), path.join(copysArchive, f));
    }
    const db = `--db=${path.join(copyDir, "copy.db")}`;
    expectRefusedWithTheStagedPath(run(root, "import-statements", [copysArchive, db]), copysArchive);
    expectRefusedWithTheStagedPath(run(root, "import-statements", [ACCOUNT_FOLDER, db]), ACCOUNT_FOLDER);
  });

  test("the staged folder — outside data/, under the name the ledger records — is accepted", () => {
    const root = checkout();
    const stage = staged();
    const r = run(root, "import-statements", [stage]);
    expect(r.err).not.toContain("REFUSED");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`Would import 1 files from ${stage}`);
  });
});

describe("⛔ pnpm trial-import refuses the same folders", { timeout: SPAWN_TIMEOUT_MS }, () => {
  test("refused before the trial copy is made: no .trial/, and the refusal names the staged path", () => {
    const root = checkout();
    const r = run(root, "trial-import", [ACCOUNT_FOLDER]);
    expectRefusedWithTheStagedPath(r, ACCOUNT_FOLDER);
    expect(r.out).not.toContain("Trial-importing");
    expect(fs.existsSync(path.join(root, ".trial"))).toBe(false);
  });

  test("through a symlink to the archive, and a folder holding it", () => {
    const root = checkout();
    fs.symlinkSync(path.join(root, "data", "statements"), path.join(root, "shelf"));
    expectRefusedWithTheStagedPath(run(root, "trial-import", ["shelf/chase-checking-1111"]), "shelf/chase-checking-1111");
    expectRefusedWithTheStagedPath(run(root, "trial-import", ["."]), ".");
    expect(fs.existsSync(path.join(root, ".trial"))).toBe(false);
  });

  test("the staged folder is trialled as before", () => {
    const root = checkout();
    const stage = staged();
    const r = run(root, "trial-import", [stage]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`Trial-importing 1 files from ${stage}`);
    expect(r.out).toContain("parsed               1");
  });
});
