import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles } from "@/db/schema/imports";
import { PROFILES } from "@/services/import/profiles";
import { banksReadBy, banksReadByEvery, importStatementFiles, institutionReadBy, type ImportInput } from "@/services/import/service";
import type { AccountHint, ParsedFile, ParsedStatement, ParserProfile } from "@/services/import/types";
import { readAcrossBanksNotice, readsAcrossBanks } from "./reads-across-banks";

/**
 * A read whose accounts are at two banks: `import_files.institution_id` holds one bank, so the import cannot record the
 * bank it resolved (`institutionReadBy` is null) and the importer's guess from the file's name and first lines stands — Chase, for a
 * name that names no bank (`guessInstitution`). Nothing said so. `pnpm ledger-check` names it now (`readsAcrossBanks`).
 */

let dir: string;
let bundle: DbBundle;

/** a name and first lines that name no bank: the importer guesses Chase */
const UNNAMED = "9b1e0a77-";
const ROBINHOOD: AccountHint = { institution: "Robinhood", type: "checking", last4: "7307" };
const SOFI: AccountHint = { institution: "SoFi", type: "checking", last4: "9067" };
const statementOf = (accountHint: AccountHint): ParsedStatement => ({
  accountHint,
  txns: [{ postedOn: "2026-03-10", amountCents: -1200, rawDescription: "COFFEE" }],
  period: { start: "2026-03-01", end: "2026-03-31", beginCents: 5000, endCents: 3800 },
});

/** what each file prints, by the words its name ends in */
const READS: Record<string, () => ParsedFile> = {
  "two banks": () => ({ statements: [statementOf(ROBINHOOD), statementOf(SOFI)], withheld: [] }),
  "one bank": () => ({ statements: [statementOf({ ...ROBINHOOD, last4: "7308" })], withheld: [] }),
  /** two statements that print no row: a retirement keeps nothing that names their accounts (`supersedeFileContribution`) */
  "two banks quiet": () => ({ statements: [quietOf({ ...ROBINHOOD, last4: "7309" }), quietOf({ ...SOFI, last4: "9068" })], withheld: [] }),
  /** a read that fails before it writes: it names no account */
  broken: () => {
    throw new Error("unreadable");
  },
};
const quietOf = (accountHint: AccountHint): ParsedStatement => ({
  accountHint,
  txns: [],
  period: { start: "2026-04-01", end: "2026-04-30", beginCents: 3800, endCents: 3800 },
});
const profile: ParserProfile = {
  id: "test-reads-across-banks",
  version: 1,
  matches: (f) => f.name.startsWith(UNNAMED),
  parse: (f) => READS[f.name.slice(UNNAMED.length).replace(/\.txt$/, "")]!(),
};
const file = (words: string): ImportInput => ({ name: `${UNNAMED}${words}.txt`, buffer: Buffer.from(words) });
const TWO_BANKS = file("two banks");
const ONE_BANK = file("one bank");

const read = (name: string) => bundle.db.select().from(importFiles).where(eq(importFiles.fileName, name)).get()!;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reads-across-banks-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  process.env.MONEYAPP_BACKUPS_DIR = path.join(dir, "backups");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  PROFILES.unshift(profile);
  for (const input of [TWO_BANKS, ONE_BANK]) {
    const [outcome] = await importStatementFiles(bundle.db, [input]);
    expect(outcome!.status).toBe("parsed");
  }
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
  delete process.env.MONEYAPP_BACKUPS_DIR;
});

describe("a read whose accounts are at two banks", () => {
  test("the import cannot record its bank, so the importer's guess stands", () => {
    expect(institutionReadBy(bundle.db, read(TWO_BANKS.name).id)).toBeNull();
    expect(institutionReadBy(bundle.db, read(ONE_BANK.name).id)).not.toBeNull();
  });

  test("is listed — by its file, both banks, and the bank it records, the guess — and a read at one bank is not", () => {
    expect(readsAcrossBanks(bundle.db)).toEqual([
      { id: read(TWO_BANKS.name).id, fileName: TWO_BANKS.name, status: "parsed", banks: ["Robinhood", "SoFi"], recorded: "Chase" },
    ]);
  });

  test("its sentence says the recorded bank is the importer's guess, and guesses none", () => {
    const [found] = readsAcrossBanks(bundle.db);
    expect(readAcrossBanksNotice(found!)).toBe(
      `${TWO_BANKS.name} reads accounts at Robinhood and SoFi — one column names one bank, so the Chase it records is the importer's guess`,
    );
  });

  test("a retired read says so", () => {
    expect(readAcrossBanksNotice({ fileName: "x.pdf", status: "superseded", banks: ["Robinhood", "SoFi", "Chase"], recorded: "Chase" })).toBe(
      "x.pdf (retired) reads accounts at Robinhood, SoFi and Chase — one column names one bank, so the Chase it records is the importer's guess",
    );
  });
});

describe("retired reads, and every read at once", () => {
  const TWO_BANKS_QUIET = file("two banks quiet");
  const BROKEN = file("broken");

  /** both two-bank files read again at a newer version: each read it retires keeps its rows — the quiet one has none */
  beforeEach(async () => {
    const [quiet] = await importStatementFiles(bundle.db, [TWO_BANKS_QUIET]);
    expect(quiet!.status).toBe("parsed");
    const [broken] = await importStatementFiles(bundle.db, [BROKEN]);
    expect(broken!.status).toBe("failed");
    profile.version = 2;
    for (const input of [TWO_BANKS, TWO_BANKS_QUIET]) {
      const [outcome] = await importStatementFiles(bundle.db, [input]);
      expect(outcome!.status).toBe("parsed");
    }
  });

  const readOf = (name: string, status: string) =>
    bundle.db.select().from(importFiles).where(eq(importFiles.fileName, name)).all().find((r) => r.status === status)!;

  test("a retired read at two banks is listed — by its own rows, or, kept none, by the read in place of its bytes", () => {
    expect(banksReadBy(bundle.db, readOf(TWO_BANKS_QUIET.name, "superseded").id)).toHaveLength(2);
    expect(
      readsAcrossBanks(bundle.db)
        .map((r) => `${r.fileName} ${r.status} ${r.banks.join("+")} ${r.recorded}`)
        .sort(),
    ).toEqual(
      [
        `${TWO_BANKS.name} parsed Robinhood+SoFi Chase`,
        `${TWO_BANKS.name} superseded Robinhood+SoFi Chase`,
        `${TWO_BANKS_QUIET.name} parsed Robinhood+SoFi Chase`,
        `${TWO_BANKS_QUIET.name} superseded Robinhood+SoFi Chase`,
      ].sort(),
    );
  });

  test("every read at once resolves each read as it is resolved alone", () => {
    const every = banksReadByEvery(bundle.db);
    const reads = bundle.db.select().from(importFiles).all();
    // the ledger holds what the two must agree on: live and retired reads at two banks, one at one bank, a failed read
    expect(reads.map((r) => `${r.status} ${banksReadBy(bundle.db, r.id).length}`).sort()).toEqual(
      ["failed 0", "parsed 1", "parsed 2", "parsed 2", "superseded 2", "superseded 2"].sort(),
    );
    expect([...every.keys()].sort()).toEqual(reads.map((r) => r.id).sort());
    for (const r of reads) expect([...every.get(r.id)!].sort()).toEqual([...banksReadBy(bundle.db, r.id)].sort());
  });
});
