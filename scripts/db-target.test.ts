import path from "node:path";
import { describe, expect, test } from "vitest";
import { DbTargetRefusal, dbTargetFrom, originalsDirFor, strayFlags, type DbTargetOptions } from "./db-target";

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
