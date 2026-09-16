import path from "node:path";
import { describe, expect, test } from "vitest";
import { DbTargetRefusal, dbTargetFrom, originalsDirFor, parseBackfillArgs, strayFlags, type DbTargetOptions } from "./db-target";

const CWD = "/repo";
const REAL = path.join(CWD, "data", "moneyapp.db");
const COPY = "/scratch/rehearsal/copy.db";
const everything = (): boolean => true;
const opts = (over: Partial<DbTargetOptions> = {}): DbTargetOptions => ({
  flag: "--db",
  required: false,
  cwd: CWD,
  exists: everything,
  ...over,
});

describe("dbTargetFrom — the database a write script opens, named on its command line", () => {
  test("no flag: the real ledger under the working directory", () => {
    expect(dbTargetFrom(["statements/robinhood", "--confirm"], opts())).toEqual({ path: REAL, isReal: true });
  });

  test("--db=<copy> names a copy, resolved to an absolute path", () => {
    expect(dbTargetFrom([`--db=${COPY}`], opts())).toEqual({ path: COPY, isReal: false });
    expect(dbTargetFrom(["--db=rehearsal.db"], opts())).toEqual({ path: path.join(CWD, "rehearsal.db"), isReal: false });
  });

  test("the real ledger named explicitly is still the real ledger", () => {
    expect(dbTargetFrom(["--db=data/moneyapp.db"], opts())).toEqual({ path: REAL, isReal: true });
    expect(dbTargetFrom([`--db=${REAL}`], opts())).toEqual({ path: REAL, isReal: true });
  });

  test("the flag is the caller's: trial-import reads --from, and ignores --db", () => {
    expect(dbTargetFrom([`--from=${COPY}`, "--db=/elsewhere.db"], opts({ flag: "--from" }))).toEqual({ path: COPY, isReal: false });
  });

  test("⛔ a required flag never falls back to the real ledger", () => {
    expect(() => dbTargetFrom(["--confirm"], opts({ required: true }))).toThrow(DbTargetRefusal);
    expect(() => dbTargetFrom(["--confirm"], opts({ required: true }))).toThrow(/--db=<path> is required/);
  });

  test("⛔ refuses a path with no database behind it, rather than letting createDatabase make an empty one", () => {
    const exists = (p: string): boolean => p === REAL;
    expect(() => dbTargetFrom([`--db=${COPY}`], opts({ exists }))).toThrow(/no database at \/scratch\/rehearsal\/copy\.db/);
    // the default too — a worktree has no data/moneyapp.db
    expect(() => dbTargetFrom([], opts({ exists: () => false }))).toThrow(/no database at \/repo\/data\/moneyapp\.db/);
  });

  test("⛔ refuses a bare flag, an empty value and a repeated flag — each would otherwise pick a database silently", () => {
    // `--db <path>` would leave <path> to be read as a statement folder
    expect(() => dbTargetFrom(["--db", COPY], opts())).toThrow(/--db needs a path/);
    expect(() => dbTargetFrom(["--db="], opts())).toThrow(/--db needs a path/);
    expect(() => dbTargetFrom([`--db=${COPY}`, "--db=/other.db"], opts())).toThrow(/--db given 2 times/);
  });
});

describe("⛔ the owner's ledger named from ANOTHER checkout — agents run in worktrees", () => {
  const MAIN = "/Users/owner/dev/MoneyApp";
  const WORKTREE = `${MAIN}/.claude/worktrees/wf-1`;
  const OWNER_LEDGER = `${MAIN}/data/moneyapp.db`;

  test("refused, in any spelling: `isReal` compares against <cwd>/data/moneyapp.db, so it would be read as a COPY", () => {
    // 🔴 measured on the branch: from a worktree this was { isReal: false }, and import-statements would have
    // archived the real import's originals into <main>/data/originals and pointed its storage_path there
    for (const argv of [[`--db=${OWNER_LEDGER}`], ["--db=../../../data/moneyapp.db"]]) {
      expect(() => dbTargetFrom(argv, opts({ cwd: WORKTREE }))).toThrow(DbTargetRefusal);
      expect(() => dbTargetFrom(argv, opts({ cwd: WORKTREE }))).toThrow(
        /\/Users\/owner\/dev\/MoneyApp\/data\/moneyapp\.db is a checkout's real ledger, not this checkout's/,
      );
    }
    expect(() => dbTargetFrom([`--from=${OWNER_LEDGER}`], opts({ cwd: WORKTREE, flag: "--from" }))).toThrow(/a checkout's real ledger/);
  });

  test("a copy is never named like one — it would be refused the same way", () => {
    expect(() => dbTargetFrom(["--db=/scratch/rehearsal/data/moneyapp.db"], opts())).toThrow(/a checkout's real ledger/);
  });

  test("the real ledger reached through another path to the SAME file is still the real ledger", () => {
    const ALIAS = "/private/owner/dev/MoneyApp/data/moneyapp.db";
    const sameFile = (a: string, b: string): boolean => [a, b].every((p) => p === OWNER_LEDGER || p === ALIAS);
    expect(dbTargetFrom([`--db=${ALIAS}`], opts({ cwd: MAIN, sameFile }))).toEqual({ path: ALIAS, isReal: true });
    // and a different file is not, whatever its name
    expect(dbTargetFrom([`--db=${COPY}`], opts({ cwd: MAIN, sameFile }))).toEqual({ path: COPY, isReal: false });
  });
});

describe("strayFlags — a flag the script does not know is refused, not ignored", () => {
  test("known flags pass, bare or with a value", () => {
    expect(strayFlags(["folder", "--confirm", `--db=${COPY}`, "--db"], ["--confirm", "--db"])).toEqual([]);
  });

  test("⛔ trial-import reads --from: import-statements' --db would otherwise be ignored and the REAL ledger trialled", () => {
    expect(strayFlags(["folder", `--db=${COPY}`], ["--from"])).toEqual([`--db=${COPY}`]);
  });

  test("a flag that merely starts like a known one is not it", () => {
    expect(strayFlags(["--dbx=/a.db", "--confirmed", "--name=Robinhood Agentic Cash"], ["--confirm", "--db"])).toEqual([
      "--dbx=/a.db",
      "--confirmed",
      "--name=Robinhood Agentic Cash",
    ]);
  });
});

/**
 * 🔴 A backfill takes no positional argument, and `strayFlags` refuses only what starts with `--`: on a copy of the real
 * ledger, 2026-09-16, `record-account-numbers.ts --db=<copy> -confirm` (and `… confirm`) ran a dry run and exited 0.
 * 🔴 …and `--confirm=yes` passed as the known flag while the write asked for a bare `--confirm`: a dry run, exit 0
 * (the review of uc/final-integrate, 2026-09-16).
 */
describe("parseBackfillArgs — a backfill takes only its own flags, each spelled one way", () => {
  test("its flags, with their values", () => {
    expect(parseBackfillArgs([`--db=${COPY}`, "--confirm", "--scratch=/tmp", "--offset=60", "--limit=30"])).toEqual({
      confirm: true,
      scratch: "/tmp",
      offset: 60,
      limit: 30,
    });
    expect(parseBackfillArgs([`--db=${COPY}`])).toEqual({ confirm: false, scratch: undefined, offset: 0, limit: Number.MAX_SAFE_INTEGER });
  });

  test.each([
    ["a single-dash flag", "-confirm"],
    ["a bare word", "confirm"],
    ["a misspelled flag", "--confrim"],
    ["a dash that is not two hyphens", "—confirm"],
    ["a value on the flag that takes none", "--confirm=yes"],
    ["another value on it", "--confirm=true"],
  ])("⛔ %s is refused: %s", (_, arg) => {
    expect(() => parseBackfillArgs([`--db=${COPY}`, arg])).toThrow(DbTargetRefusal);
    expect(() => parseBackfillArgs([`--db=${COPY}`, arg])).toThrow(`unknown argument(s): ${arg}`);
  });

  test.each([
    ["--db", [`--db`, COPY]],
    ["--scratch", ["--scratch", "/tmp"]],
    ["--limit", ["--limit", "30"]],
    ["--offset", ["--offset="]],
  ])("⛔ %s without a value is refused, and its value is not left for anything else to read", (flag, argv) => {
    expect(() => parseBackfillArgs(argv)).toThrow(`${flag} needs a value: ${flag}=<value>`);
  });

  test("⛔ a flag given twice, or a count that is not a whole number, is refused", () => {
    expect(() => parseBackfillArgs(["--confirm", "--confirm"])).toThrow("--confirm given 2 times");
    expect(() => parseBackfillArgs(["--limit=30", "--limit=60"])).toThrow("--limit given 2 times");
    expect(() => parseBackfillArgs(["--limit=-1"])).toThrow("--limit must be a whole number, got -1");
    expect(() => parseBackfillArgs(["--offset=1.5"])).toThrow("--offset must be a whole number, got 1.5");
  });
});

describe("originalsDirFor — where an import against that database archives its originals", () => {
  test("the real ledger archives where the service always has (its own default)", () => {
    expect(originalsDirFor({ path: REAL, isReal: true }, {})).toBeUndefined();
  });

  test("⛔ a copy archives BESIDE itself — never into the real data/statements/", () => {
    expect(originalsDirFor({ path: COPY, isReal: false }, {})).toBe("/scratch/rehearsal/originals");
  });

  test("an explicit MONEYAPP_ORIGINALS_DIR is honoured for either", () => {
    const env = { MONEYAPP_ORIGINALS_DIR: "/tmp/elsewhere" };
    expect(originalsDirFor({ path: COPY, isReal: false }, env)).toBe("/tmp/elsewhere");
    expect(originalsDirFor({ path: REAL, isReal: true }, env)).toBe("/tmp/elsewhere");
  });
});
