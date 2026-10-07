import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles } from "@/db/schema/imports";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, institutionReadBy, type ImportInput } from "@/services/import/service";
import type { AccountHint, ParsedFile, ParsedStatement, ParserProfile } from "@/services/import/types";
import { readAcrossBanksNotice, readsAcrossBanks } from "./reads-across-banks";

/**
 * A read whose accounts are at two banks: `import_files.institution_id` holds one bank, so the import cannot record the
 * bank it resolved (`institutionReadBy` is null) and the importer's guess from the file's name stands — Chase, for a
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
};
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
      `${TWO_BANKS.name} reads accounts at Robinhood and SoFi — one column names one bank, so the Chase it records is the importer's guess from its name`,
    );
  });

  test("a retired read says so", () => {
    expect(readAcrossBanksNotice({ fileName: "x.pdf", status: "superseded", banks: ["Robinhood", "SoFi", "Chase"], recorded: "Chase" })).toBe(
      "x.pdf (retired) reads accounts at Robinhood, SoFi and Chase — one column names one bank, so the Chase it records is the importer's guess from its name",
    );
  });
});
