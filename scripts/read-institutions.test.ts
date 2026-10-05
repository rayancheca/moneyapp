import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles, statementCopies } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, type ImportInput } from "@/services/import/service";
import type { AccountHint, ParsedFile, ParsedStatement, ParserProfile } from "@/services/import/types";
import { DbTargetRefusal } from "./db-target";
import { onRehearsalCopy } from "./guarded-write-harness";
import {
  InstitutionRefusal,
  SNAPSHOT_LABEL,
  applyInstitutions,
  captureInstitutionState,
  compareInstitutions,
  parseInstitutionsCli,
  planInstitutions,
  rehearseInstitutions,
  type InstitutionChange,
} from "./read-institutions";
import { main } from "./record-read-institutions-2026-10-05";

/**
 * A ledger shaped like his: Robinhood statements named by a UUID, whose name and first lines name no bank, so the
 * importer guesses Chase (`guessInstitution`). The reads reach the ledger through the app's own import — which records
 * the bank they resolve now — and each row is then set back to the guess, as the importer before it left every row.
 */

let dir: string;
let bundle: DbBundle;

/** a name and first lines that name no bank: the importer guesses Chase */
const UNNAMED = "4c3487e8-";
const CASH: AccountHint = { institution: "Robinhood", type: "checking", last4: "7307" };
const SOFI: AccountHint = { institution: "SoFi", type: "checking", last4: "9067" };
const CHASE: AccountHint = { institution: "Chase", type: "checking", last4: "3522" };
const statementOf = (accountHint: AccountHint): ParsedStatement => ({
  accountHint,
  txns: [{ postedOn: "2026-03-10", amountCents: -1200, rawDescription: "COFFEE" }],
  period: { start: "2026-03-01", end: "2026-03-31", beginCents: 5000, endCents: 3800 },
});

/** what each file prints, by the words its name ends in */
const READS: Record<string, () => ParsedFile> = {
  "2026-03": () => ({ statements: [statementOf(CASH)], withheld: [] }),
  "2026-04 withheld": () => ({
    statements: [],
    withheld: [{ accountHint: CASH, accountNumber: "XXXX7307", period: { start: "2026-04-01", end: "2026-04-30" }, reason: "cannot prove it" }],
  }),
  "2026-05 two banks": () => ({ statements: [statementOf({ ...CASH, last4: "7308" }), statementOf(SOFI)], withheld: [] }),
  "chase 2026-03": () => ({ statements: [statementOf(CHASE)], withheld: [] }),
};
const profile: ParserProfile = {
  id: "test-read-institutions",
  version: 1,
  matches: (f) => f.name.startsWith(UNNAMED),
  parse: (f) => {
    const words = f.name.slice(UNNAMED.length).replace(/( \(\d\))?\.txt$/, "");
    return READS[words]!();
  },
};
const file = (words: string): ImportInput => ({ name: `${UNNAMED}${words}.txt`, buffer: Buffer.from(words) });
const MARCH = file("2026-03");
/** a second download of March: it writes no row, and records the copy it is and what it prints */
const MARCH_COPY: ImportInput = { name: `${UNNAMED}2026-03 (1).txt`, buffer: Buffer.from("2026-03\n") };

const bankId = (name: string) => bundle.db.select().from(institutions).where(eq(institutions.name, name)).get()!.id;
const bankOf = (id: string) => bundle.db.select().from(institutions).where(eq(institutions.id, id)).get()!.name;
const read = (name: string, status?: string) =>
  bundle.db
    .select()
    .from(importFiles)
    .where(eq(importFiles.fileName, name))
    .all()
    .find((r) => status === undefined || r.status === status)!;
/** every read set back to the bank the importer guessed — Chase, for all of these — as it left them */
const asTheImporterLeftThem = () => bundle.sqlite.prepare("UPDATE import_files SET institution_id = ?").run(bankId("Chase"));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-read-institutions-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  process.env.MONEYAPP_BACKUPS_DIR = path.join(dir, "backups");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  PROFILES.unshift(profile);
  for (const input of [MARCH, MARCH_COPY, file("2026-04 withheld"), file("2026-05 two banks"), file("chase 2026-03")]) {
    const [outcome] = await importStatementFiles(bundle.db, [input]);
    expect(outcome!.status).toBe("parsed");
  }
  // March read again at a newer version: the read it retires keeps its row
  profile.version = 2;
  await importStatementFiles(bundle.db, [MARCH]);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
  delete process.env.MONEYAPP_BACKUPS_DIR;
});

describe("the plan", () => {
  test("the ledger is as measured: a read in place, a retired read, a second download, and three the rule leaves", () => {
    expect(read(MARCH.name, "parsed").parserVersion).toBe(2);
    const retired = read(MARCH.name, "superseded");
    expect(bundle.db.select().from(transactions).where(eq(transactions.importFileId, retired.id)).all()).toHaveLength(1);
    const copy = read(MARCH_COPY.name);
    expect(bundle.db.select().from(transactions).where(eq(transactions.importFileId, copy.id)).all()).toEqual([]);
    expect(bundle.db.select().from(statementCopies).where(eq(statementCopies.importFileId, copy.id)).all()).toHaveLength(1);
  });

  test("the import records the bank each read resolved now, and leaves the backfill nothing to do", () => {
    expect(planInstitutions(bundle).changes).toEqual([]);
    expect(bankOf(read(MARCH.name, "parsed").institutionId)).toBe("Robinhood");
  });

  test("plans every read whose records name one other bank — in place, retired, a second download — and leaves the rest", () => {
    asTheImporterLeftThem();

    const plan = planInstitutions(bundle);

    const planned = plan.changes.map((c) => [c.fileName, c.status, bankOf(c.from), bankOf(c.to)]);
    expect(planned.sort()).toEqual(
      [
        [MARCH.name, "parsed", "Chase", "Robinhood"],
        [MARCH.name, "superseded", "Chase", "Robinhood"],
        [MARCH_COPY.name, "parsed", "Chase", "Robinhood"],
      ].sort(),
    );
    // withheld every section, and two banks: nothing resolves which — the Chase statement names its bank already
    expect([plan.unresolved, plan.agreeing]).toEqual([2, 1]);
  });
});

describe("the write", () => {
  test("rehearsed: exactly the planned rows, institution_id alone, and a second run has nothing to do", () => {
    asTheImporterLeftThem();
    const stamps = bundle.db.select({ id: importFiles.id, updatedAt: importFiles.updatedAt }).from(importFiles).all();

    const { failures, plan } = rehearseInstitutions(bundle);

    expect(failures).toEqual([]);
    expect(plan.changes).toHaveLength(3);
    expect(bankOf(read(MARCH.name, "superseded").institutionId)).toBe("Robinhood");
    expect(bankOf(read(file("2026-04 withheld").name).institutionId)).toBe("Chase");
    expect(bundle.db.select({ id: importFiles.id, updatedAt: importFiles.updatedAt }).from(importFiles).all()).toEqual(stamps);
    expect(planInstitutions(bundle).changes).toEqual([]);
  });

  test("on a rehearsal copy, the ledger it was copied from is left as it was", async () => {
    asTheImporterLeftThem();
    const before = captureInstitutionState(bundle);

    const rehearsal = await onRehearsalCopy(bundle, dir, SNAPSHOT_LABEL, (copy) => rehearseInstitutions(copy));

    expect(rehearsal.failures).toEqual([]);
    expect(compareInstitutions(before, captureInstitutionState(bundle), [])).toEqual([]);
    expect(planInstitutions(bundle).changes).toHaveLength(3);
  });

  test("refuses, and writes nothing, once the ledger plans other rows than the ones shown", () => {
    asTheImporterLeftThem();
    const { changes } = planInstitutions(bundle);
    // one of them corrected since the plan was shown
    const moved = changes[0]!;
    bundle.sqlite.prepare("UPDATE import_files SET institution_id = ? WHERE id = ?").run(moved.to, moved.id);
    const before = captureInstitutionState(bundle);

    expect(() => applyInstitutions(bundle, changes)).toThrow(InstitutionRefusal);

    expect(compareInstitutions(before, captureInstitutionState(bundle), [])).toEqual([]);
  });
});

describe("the guards", () => {
  let changes: readonly InstitutionChange[];
  beforeEach(() => {
    asTheImporterLeftThem();
    changes = planInstitutions(bundle).changes;
  });
  const set = (sql: string, ...params: string[]) => bundle.sqlite.prepare(sql).run(...params);

  test("hold for the write as planned", () => {
    const before = captureInstitutionState(bundle);
    applyInstitutions(bundle, changes);
    expect(compareInstitutions(before, captureInstitutionState(bundle), changes)).toEqual([]);
  });

  test.each<[string, (planned: readonly InstitutionChange[]) => void, RegExp]>([
    ["another table", () => set("UPDATE accounts SET name = name || ' (edited)' WHERE last4 = '7307'"), /accounts changed/],
    ["another column of import_files", (p) => set("UPDATE import_files SET error = 'edited' WHERE id = ?", p[0]!.id), /other than institution_id/],
    ["the bank of a row it did not plan", () => set("UPDATE import_files SET institution_id = ? WHERE file_name LIKE '%withheld%'", bankId("SoFi")), /moved on/],
    ["a planned row's bank, to another", (p) => set("UPDATE import_files SET institution_id = ? WHERE id = ?", bankId("SoFi"), p[0]!.id), /planned/],
  ])("catch a write that also changed %s", (_, alsoChange, failure) => {
    const before = captureInstitutionState(bundle);
    applyInstitutions(bundle, changes);
    alsoChange(changes);
    expect(compareInstitutions(before, captureInstitutionState(bundle), changes).join("\n")).toMatch(failure);
  });

  test("catch a planned row the write left as it was — and refuse to write less than the plan", () => {
    expect(() => applyInstitutions(bundle, changes.slice(1))).toThrow(/the ledger moved since the plan/);
    const before = captureInstitutionState(bundle);
    applyInstitutions(bundle, changes);
    set("UPDATE import_files SET institution_id = ? WHERE id = ?", changes[0]!.from, changes[0]!.id);
    expect(compareInstitutions(before, captureInstitutionState(bundle), changes).join("\n")).toMatch(/moved on/);
  });
});

describe("the command line", () => {
  const env = {
    cwd: "/repo",
    exists: (p: string) => p === "/repo/copy.db" || p === "/scratch" || p === os.tmpdir(),
  };

  test("requires --db and never guesses a database", () => {
    expect(() => parseInstitutionsCli([], env)).toThrow(DbTargetRefusal);
    expect(() => parseInstitutionsCli(["--db=missing.db"], env)).toThrow(DbTargetRefusal);
  });

  test("refuses a flag it does not know, a bare argument, and --confirm with a value", () => {
    expect(() => parseInstitutionsCli(["--db=copy.db", "--dry-run"], env)).toThrow(InstitutionRefusal);
    expect(() => parseInstitutionsCli(["--db=copy.db", "copy.db"], env)).toThrow(InstitutionRefusal);
    expect(() => parseInstitutionsCli(["--db=copy.db", "--confirm=yes"], env)).toThrow(InstitutionRefusal);
  });

  test("reads --db, --confirm and --scratch; a dry run is the default", () => {
    expect(parseInstitutionsCli(["--db=copy.db", "--confirm", "--scratch=/scratch"], env)).toEqual({
      dbPath: "/repo/copy.db",
      confirm: true,
      scratch: "/scratch",
    });
    expect(parseInstitutionsCli(["--db=copy.db"], env)).toEqual({ dbPath: "/repo/copy.db", confirm: false, scratch: os.tmpdir() });
  });

  test("refuses a scratch directory that is not there, and a --scratch with no value", () => {
    expect(() => parseInstitutionsCli(["--db=copy.db", "--scratch=/nope"], env)).toThrow(/no scratch directory/);
    expect(() => parseInstitutionsCli(["--db=copy.db", "--scratch"], env)).toThrow(InstitutionRefusal);
  });

  test("the runbook: a dry run writes nothing, --confirm takes a restore point and writes, a third run has nothing to do", async () => {
    asTheImporterLeftThem();
    const ledger = path.join(dir, "t.db");
    const said: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...words: unknown[]) => void said.push(words.join(" ")));
    try {
      const before = captureInstitutionState(bundle);
      await main([`--db=${ledger}`, `--scratch=${dir}`]);
      expect(said.join("\n")).toMatch(/3 read\(s\) name a bank[\s\S]*✓ rehearsed[\s\S]*DRY RUN — nothing written/);
      expect(compareInstitutions(before, captureInstitutionState(bundle), [])).toEqual([]);

      said.length = 0;
      const { changes } = planInstitutions(bundle);
      await main([`--db=${ledger}`, `--scratch=${dir}`, "--confirm"]);
      expect(said.join("\n")).toMatch(/APPLIED — 3 row\(s\); every guard holds; a second run has nothing to do/);
      expect(compareInstitutions(before, captureInstitutionState(bundle), changes)).toEqual([]);
      expect(fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(`-${SNAPSHOT_LABEL}.db`))).toHaveLength(1);

      said.length = 0;
      await main([`--db=${ledger}`, `--scratch=${dir}`]);
      expect(said.join("\n")).toMatch(/NOTHING TO DO/);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
