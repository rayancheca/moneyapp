import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles, printedLines, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, unimportFile, type ImportInput } from "@/services/import/service";
import type { AccountHint, ParsedStatement, ParserProfile } from "@/services/import/types";
import { scanPrintedLines, writePrintedLines } from "./record-printed-lines";

/**
 * An export and a statement imported before `printed_lines` existed: the imports that would record what each prints are
 * replayed, and their records deleted, so the script has to find them again from the original bytes alone.
 */
const PREFIX = "printed-lines-backfill-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "5201" };
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "COFFEE ROASTERS 12" };
const GROCER = { postedOn: "2026-03-12", amountCents: -2500, rawDescription: "CORNER GROCER" };
const SECTIONS: Record<string, ParsedStatement[]> = {
  export: [{ accountHint: CHECKING, txns: [COFFEE, GROCER] }],
  statement: [
    {
      accountHint: CHECKING,
      txns: [
        { ...COFFEE, rawDescription: "COFFEE ROASTERS #12 MIAMI FL" },
        { ...GROCER, rawDescription: "CORNER GROCER MIAMI FL" },
      ],
      period: { start: "2026-03-01", end: "2026-03-31", beginCents: 10_000, endCents: 6_500 },
    },
  ],
};
const profile: ParserProfile = {
  id: "test-printed-lines-backfill",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => SECTIONS[f.text.trim()]!,
};

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-printed-lines-backfill-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
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
});

const EXPORT: ImportInput = { name: `${PREFIX}export.csv`, buffer: Buffer.from("export") };
const STATEMENT: ImportInput = { name: `${PREFIX}statement.csv`, buffer: Buffer.from("statement") };
const fileId = (input: ImportInput) => bundle.db.select().from(importFiles).where(eq(importFiles.fileName, input.name)).get()!.id;
const strip = (rows: (typeof printedLines.$inferSelect)[]) =>
  rows.map(({ importFileId, accountId, lines }) => ({ importFileId, accountId, lines })).sort((a, b) => a.importFileId.localeCompare(b.importFileId));

async function importedWithoutARecord(): Promise<(typeof printedLines.$inferSelect)[]> {
  await importStatementFiles(bundle.db, [EXPORT]);
  await importStatementFiles(bundle.db, [STATEMENT]);
  const recorded = bundle.db.select().from(printedLines).all();
  bundle.db.delete(printedLines).run();
  return recorded;
}

describe("record-printed-lines — what each file imported before the importer recorded it prints", () => {
  test("reads each file again and records exactly what the import records", async () => {
    const recorded = await importedWithoutARecord();
    expect(recorded).toHaveLength(2);

    const scan = await scanPrintedLines(bundle, 0, 100);
    expect(scan.read).toBe(2);
    expect(scan.planned.map((p) => [p.fileName, p.lines.length, p.recordedByARow])).toEqual([
      [EXPORT.name, 2, 2],
      [STATEMENT.name, 2, 2],
    ]);
    writePrintedLines(bundle, scan.planned);
    expect(strip(bundle.db.select().from(printedLines).all())).toEqual(strip(recorded));

    // a second run has nothing to do
    const again = await scanPrintedLines(bundle, 0, 100);
    expect({ planned: again.planned.length, alreadyRecorded: again.alreadyRecorded }).toEqual({ planned: 0, alreadyRecorded: 2 });

    // …and the record does what it is for: the export's un-import keeps the rows the statement prints
    unimportFile(bundle.db, fileId(EXPORT));
    expect(bundle.db.select().from(transactions).all().map((t) => t.importFileId)).toEqual([fileId(STATEMENT), fileId(STATEMENT)]);
    expect(bundle.db.select().from(statementPeriods).get()!.reconciliation).toBe("reconciled");
  });

  test("skips a file none of whose lines any row on its account records, and one its profile reads at another version", async () => {
    await importedWithoutARecord();
    bundle.db.delete(transactions).run();
    const scan = await scanPrintedLines(bundle, 0, 100);
    expect(scan.planned).toEqual([]);
    expect(scan.skipped.filter((s) => s.includes("no row on the account records any of its 2 lines"))).toHaveLength(2);

    profile.version = 2;
    const bumped = await scanPrintedLines(bundle, 0, 100);
    expect(bumped.read).toBe(0);
    expect(bumped.skipped).toHaveLength(2);
  });
});
