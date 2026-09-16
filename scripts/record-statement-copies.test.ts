import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles, statementCopies, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, unimportFile, type ImportInput } from "@/services/import/service";
import type { ParsedStatement, ParserProfile } from "@/services/import/types";
import { scanCopies, writeCopies } from "./record-statement-copies";

/**
 * A statement downloaded twice before `statement_copies` existed: the import that would record the copy is replayed,
 * and its record deleted, so the script has to find it again from the original bytes alone.
 */
const PREFIX = "copied-statement-";
const STATEMENT: ParsedStatement[] = [
  {
    accountHint: { institution: "Chase", type: "checking", last4: "5101" },
    txns: [
      { postedOn: "2026-03-10", amountCents: 1000, rawDescription: "PAYROLL DEPOSIT MAR" },
      { postedOn: "2026-03-12", amountCents: -400, rawDescription: "SHELL OIL 555 MIAMI FL" },
    ],
    period: { start: "2026-03-01", end: "2026-03-31", beginCents: 0, endCents: 600 },
  },
];
const profile: ParserProfile = {
  id: "test-copied-statement",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: () => STATEMENT,
};

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-copies-"));
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

const FIRST: ImportInput = { name: `${PREFIX}march.txt`, buffer: Buffer.from("march") };
const SECOND: ImportInput = { name: `${PREFIX}march (1).txt`, buffer: Buffer.from("march\n") };

async function twoDownloadsWithoutARecord(): Promise<{ recorded: unknown[] }> {
  await importStatementFiles(bundle.db, [FIRST]);
  await importStatementFiles(bundle.db, [SECOND]);
  const recorded = bundle.db.select().from(statementCopies).all();
  bundle.db.delete(statementCopies).run();
  return { recorded };
}

describe("record-statement-copies — the copies imported before the importer recorded them", () => {
  test("finds the second download from its bytes and records exactly what the import records", async () => {
    const { recorded } = await twoDownloadsWithoutARecord();
    expect(recorded).toHaveLength(1);

    const scan = await scanCopies(bundle, 0, 100);
    expect(scan.read).toBe(2);
    expect(scan.planned).toHaveLength(1);
    writeCopies(bundle, scan.planned);

    const strip = (rows: unknown[]) =>
      (rows as (typeof statementCopies.$inferSelect)[]).map(({ importFileId, accountId, periodStart, periodEnd, lines }) => ({
        importFileId,
        accountId,
        periodStart,
        periodEnd,
        lines,
      }));
    expect(strip(bundle.db.select().from(statementCopies).all())).toEqual(strip(recorded));
    // a second run has nothing to do
    const again = await scanCopies(bundle, 0, 100);
    expect({ planned: again.planned.length, alreadyRecorded: again.alreadyRecorded }).toEqual({ planned: 0, alreadyRecorded: 1 });

    // …and the record does what it is for: the first download's un-import keeps the period and both rows
    const holder = bundle.db.select().from(statementPeriods).get()!.importFileId;
    unimportFile(bundle.db, holder);
    expect(bundle.db.select().from(statementPeriods).all()).toHaveLength(1);
    expect(bundle.db.select().from(transactions).all()).toHaveLength(2);
  });

  test("skips a file its profile no longer reads at the imported version, and one whose original is gone", async () => {
    await twoDownloadsWithoutARecord();
    const [first, second] = bundle.db.select().from(importFiles).all();
    fs.rmSync(second!.storagePath);
    profile.version = 2;
    const bumped = await scanCopies(bundle, 0, 100);
    expect(bumped.read).toBe(0);
    expect(bumped.skipped).toHaveLength(2);
    profile.version = 1;
    const scan = await scanCopies(bundle, 0, 100);
    expect(scan.read).toBe(1);
    expect(scan.planned).toEqual([]);
    expect(scan.skipped.some((s) => s.includes(second!.id) && s.includes("no original"))).toBe(true);
    expect(first!.storagePath).not.toBe(second!.storagePath);
  });
});
