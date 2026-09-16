import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accountNumbers } from "@/db/schema/account-numbers";
import { accounts } from "@/db/schema/accounts";
import { importFiles, printedLines, statementCopies, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { PROFILES } from "../profiles";
import { findAccountId, importStatementFiles, unimportFile, type ImportInput } from "../service";
import type { ParsedStatement, ParserProfile } from "../types";
import { filesWithoutPrintedLines, recordImportedFiles } from ".";

/**
 * A ledger with its imported files and none of the records of what they print: what restoring a snapshot taken before
 * the records existed leaves (`import-records`).
 */

const PREFIX = "import-records-";
const CARD = { institution: "Capital One", type: "credit", name: "Venture X" } as const;

/** Each file's sections, by its text: "<last4> <month>", and "export" for the card's activity export. */
function sections(text: string): ParsedStatement[] {
  if (text === "export") {
    return [{ accountHint: { ...CARD, last4: "4208" }, txns: [{ postedOn: "2026-03-10", amountCents: -1000, rawDescription: "PURCHASE 03 EXPORT" }] }];
  }
  const [last4, month] = text.split(" ") as [string, string];
  return [
    {
      accountHint: { ...CARD, last4 },
      txns: [
        { postedOn: `2026-${month}-10`, amountCents: -1000, rawDescription: `PURCHASE ${month}` },
        { postedOn: `2026-${month}-12`, amountCents: -2500, rawDescription: `DINNER ${month}` },
      ],
      period: { start: `2026-${month}-01`, end: `2026-${month}-28`, beginCents: 0, endCents: -3500 },
    },
  ];
}

const profile: ParserProfile = {
  id: "test-import-records",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => sections(f.text.trim()),
};
const file = (name: string, text: string): ImportInput => ({ name: `${PREFIX}${name}.txt`, buffer: Buffer.from(text) });
/** March printed under the card's earlier number */
const MARCH = file("2026-03", "9082 03");
/** …downloaded a second time, in other bytes */
const MARCH_AGAIN = file("2026-03 (1)", "9082 03\n");
const APRIL = file("2026-04", "4208 04");
const EXPORT = file("export", "export");

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-import-records-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  process.env.MONEYAPP_BACKUPS_DIR = path.join(dir, "backups");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
  delete process.env.MONEYAPP_BACKUPS_DIR;
});

const fileId = (input: ImportInput) =>
  bundle.db
    .select()
    .from(importFiles)
    .where(and(eq(importFiles.fileName, input.name), ne(importFiles.status, "superseded")))
    .get()!.id;

/** The owner's shape: March imported under 9082, the card then reissued as 4208, and April under it. */
async function ledger(): Promise<string> {
  await importStatementFiles(bundle.db, [MARCH]);
  const card = bundle.db.select().from(accounts).where(eq(accounts.last4, "9082")).get()!.id;
  bundle.db.update(accounts).set({ last4: "4208" }).where(eq(accounts.id, card)).run();
  await importStatementFiles(bundle.db, [APRIL, EXPORT]);
  // the reissue is known by the number the owner filed under the card (as scripts/record-account-numbers.ts records it)
  const { recordFormerNumber } = await import("../account-numbers");
  recordFormerNumber(bundle.db, card, "9082");
  await importStatementFiles(bundle.db, [MARCH_AGAIN]);
  return card;
}

/** Every record, by content. */
function records() {
  const strip = <T extends { id: string; createdAt?: string; updatedAt?: string }>({ id: _i, createdAt: _c, updatedAt: _u, ...rest }: T) => rest;
  const sort = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
  return {
    numbers: sort(bundle.db.select().from(accountNumbers).all().map(strip)),
    copies: sort(bundle.db.select().from(statementCopies).all().map(strip)),
    lines: sort(bundle.db.select().from(printedLines).all().map(strip)),
  };
}

function forgetRecords(): void {
  for (const table of [accountNumbers, statementCopies, printedLines]) bundle.db.delete(table).run();
}

describe("the records of what imported files print, for a ledger that has the files and not the records", () => {
  test("a ledger whose records are whole names no file", async () => {
    await ledger();
    expect(filesWithoutPrintedLines(bundle.db)).toEqual([]);
  });

  test("every file is named when the records are gone — the export whose one line another row records too — and recording them again gives back what the import wrote", async () => {
    const card = await ledger();
    const whole = records();
    expect(whole.numbers).toHaveLength(1);
    expect(whole.copies).toHaveLength(1);
    expect(whole.lines).toHaveLength(4);
    forgetRecords();

    expect(filesWithoutPrintedLines(bundle.db).map((f) => f.fileName).sort()).toEqual([MARCH, MARCH_AGAIN, APRIL, EXPORT].map((f) => f.name).sort());

    const recorded = await recordImportedFiles(bundle);

    expect(recorded.skipped).toEqual([]);
    expect(recorded).toMatchObject({ numbers: 1, copies: 1, printedLines: 4 });
    expect(records()).toEqual(whole);
    expect(filesWithoutPrintedLines(bundle.db)).toEqual([]);
    expect(findAccountId(bundle.db, { ...CARD, last4: "9082" })).toBe(card);
    // …and once more records nothing twice
    expect(await recordImportedFiles(bundle)).toMatchObject({ numbers: 0, copies: 0, printedLines: 0 });
    expect(records()).toEqual(whole);
  });

  /** The review's measurement, in small: the first of two downloads un-imported on a ledger without its records. */
  test("with the records back, un-importing the first download keeps the rows and the period the second prints", async () => {
    const card = await ledger();
    forgetRecords();
    await recordImportedFiles(bundle);
    const march = fileId(MARCH);
    const live = () =>
      bundle.db
        .select({ amountCents: transactions.amountCents, postedOn: transactions.postedOn })
        .from(transactions)
        .where(and(eq(transactions.accountId, card), ne(transactions.status, "superseded")))
        .orderBy(transactions.postedOn, transactions.amountCents)
        .all();
    const before = live();

    unimportFile(bundle.db, march);

    expect(live()).toEqual(before);
    expect(bundle.db.select().from(statementPeriods).where(eq(statementPeriods.periodStart, "2026-03-01")).get()).toMatchObject({
      importFileId: fileId(MARCH_AGAIN),
      reconciliation: "reconciled",
    });
  });

  test("a file read at a version its profile has moved past is not named: its re-read records it", async () => {
    await ledger();
    forgetRecords();
    profile.version = 2;
    expect(filesWithoutPrintedLines(bundle.db)).toEqual([]);
    expect(await recordImportedFiles(bundle)).toMatchObject({ numbers: 0, copies: 0, printedLines: 0 });
  });
});
