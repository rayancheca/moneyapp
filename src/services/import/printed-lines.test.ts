import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { importFiles, printedLines, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { PROFILES } from "./profiles";
import { importStatementFiles, unimportFile, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";
import { unimportCountsByFile } from "./unimport-counts";

/**
 * A line another still-imported file prints is not deleted with the file whose row records it.
 *
 * 🔴 A file's line absorbed by another file's row belongs to no row of its own, and nothing said the file prints it.
 * Un-importing the file whose row records the line deleted money a still-imported file prints. Measured on a copy of the
 * real ledger, 2026-09-16: un-importing Spending Report PDF (1).pdf put all 8 of Chase Sapphire's reconciled periods
 * from 2025-12-03 to 2026-08-02 into gap (20260602-statements-9805-.pdf prints 86 lines, 80 of them recorded by the
 * report's rows), and un-importing 3ab6c2a8-….csv deleted 75 Robinhood Cash rows the still-imported
 * rh-redownload.csv prints — which, skipped as a duplicate, could not be imported again to bring them back.
 */

let dir: string;
let bundle: DbBundle;

const PREFIX = "printed-lines-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "4201" };
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "COFFEE ROASTERS 12" };
const GROCER = { postedOn: "2026-03-12", amountCents: -2500, rawDescription: "CORNER GROCER" };
const LATE = { postedOn: "2026-04-02", amountCents: -700, rawDescription: "LATE NIGHT TACOS" };

/** Each file's sections, by its text. The statement prints two of the export's lines, in its own words. */
const SECTIONS: Record<string, ParsedStatement[]> = {
  export: [{ accountHint: CHECKING, txns: [COFFEE, GROCER, LATE] }],
  "statement 2026-03": [
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

/** when set, a read fails after its first section: the next section names an institution the app does not know */
let breaksMidFile = false;
const UNKNOWN: ParsedStatement = {
  accountHint: { institution: "Nowhere Bank" as AccountHint["institution"], type: "checking", last4: "4299" },
  txns: [],
};

const profile: ParserProfile = {
  id: "test-printed-lines",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => [...SECTIONS[f.text.trim()]!, ...(breaksMidFile ? [UNKNOWN] : [])],
};

const file = (name: string, text: string): ImportInput => ({ name: `${PREFIX}${name}.csv`, buffer: Buffer.from(text) });
const EXPORT = file("export", "export");
/** the export downloaded again: the same lines in different bytes */
const EXPORT_AGAIN = file("export (1)", "export\n");
const STATEMENT = file("statement-2026-03", "statement 2026-03");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-printed-lines-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  breaksMidFile = false;
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

const fileId = (input: ImportInput) =>
  bundle.db
    .select()
    .from(importFiles)
    .where(and(eq(importFiles.fileName, input.name), ne(importFiles.status, "superseded")))
    .get()!.id;
const accountId = () => bundle.db.select().from(accounts).where(eq(accounts.last4, CHECKING.last4!)).get()!.id;
const live = () =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId()), ne(transactions.status, "superseded")))
    .orderBy(transactions.postedOn, transactions.amountCents)
    .all();
const rowsOf = (input: ImportInput) => live().filter((r) => r.importFileId === fileId(input));
const march = () => bundle.db.select().from(statementPeriods).where(eq(statementPeriods.periodStart, "2026-03-01")).get()!;

let seq = 0;
function hand(postedOn: string, amountCents: number, raw: string): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: accountId(),
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: normalizeDescription(raw),
      dedupeHash: dedupeHash({ accountId: accountId(), postedOn, amountCents, rawDescription: raw, occurrenceIndex: 9000 + seq }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

describe("a line a still-imported file prints survives the un-import of the file whose row records it", () => {
  test("un-importing an export keeps the rows a statement imported after it prints, under the statement", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [STATEMENT]);
    // the premise: the statement wrote no row, and its period closes on the export's rows
    expect(rowsOf(STATEMENT)).toEqual([]);
    expect(march()).toMatchObject({ importFileId: fileId(STATEMENT), reconciliation: "reconciled" });
    const coffee = rowsOf(EXPORT).find((r) => r.amountCents === COFFEE.amountCents)!;
    const dining = bundle.db.select().from(categories).all()[0]!.id;
    bundle.db
      .update(transactions)
      .set({ notes: "with Carson", categoryId: dining, categorizationSource: "user" })
      .where(eq(transactions.id, coffee.id))
      .run();
    expect(unimportCountsByFile(bundle.db).get(fileId(EXPORT))).toMatchObject({ deleted: 1, keptByPrinters: 2 });

    unimportFile(bundle.db, fileId(EXPORT));

    expect(live().map((r) => [r.postedOn, r.amountCents, r.status])).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, "active"],
      [GROCER.postedOn, GROCER.amountCents, "active"],
    ]);
    expect(rowsOf(STATEMENT).map((r) => r.id).sort()).toEqual(live().map((r) => r.id).sort());
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, coffee.id)).get()).toMatchObject({
      importFileId: fileId(STATEMENT),
      notes: "with Carson",
      categoryId: dining,
      categorizationSource: "user",
    });
    expect(march().reconciliation).toBe("reconciled");
  });

  test("…and un-importing the statement then removes them: no file prints them any more", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [STATEMENT]);
    unimportFile(bundle.db, fileId(EXPORT));
    expect(unimportCountsByFile(bundle.db).get(fileId(STATEMENT))).toMatchObject({ deleted: 2, keptByPrinters: 0 });

    unimportFile(bundle.db, fileId(STATEMENT));
    expect(live()).toEqual([]);
  });

  test("un-importing a statement keeps the rows an export imported after it prints, under the export", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [EXPORT]);
    expect(rowsOf(STATEMENT)).toHaveLength(2);

    unimportFile(bundle.db, fileId(STATEMENT));

    expect(live().map((r) => [r.postedOn, r.amountCents, r.importFileId])).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, fileId(EXPORT)],
      [GROCER.postedOn, GROCER.amountCents, fileId(EXPORT)],
      [LATE.postedOn, LATE.amountCents, fileId(EXPORT)],
    ]);
  });

  test("an export downloaded twice: un-importing the first keeps every row, under the second, and importing the first again counts nothing twice", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    expect(rowsOf(EXPORT_AGAIN)).toEqual([]);
    const before = live().map((r) => r.id);

    unimportFile(bundle.db, fileId(EXPORT));
    expect(live().map((r) => r.id)).toEqual(before);
    expect(rowsOf(EXPORT_AGAIN).map((r) => r.id)).toEqual(before);

    const [again] = await importStatementFiles(bundle.db, [EXPORT]);
    expect(again!.status).toBe("parsed");
    expect(live().map((r) => r.id)).toEqual(before);

    // each still prints them: un-importing either keeps them
    unimportFile(bundle.db, fileId(EXPORT_AGAIN));
    expect(live().map((r) => r.id)).toEqual(before);
    expect(rowsOf(EXPORT).map((r) => r.id)).toEqual(before);
  });

  test("a line another row already records is not held back: the un-imported file's own copy of it goes", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    // the owner entered the coffee by hand as well: two rows of the same money, and the statement prints it once
    const byHand = hand(COFFEE.postedOn, COFFEE.amountCents, "COFFEE — entered by hand");
    await importStatementFiles(bundle.db, [STATEMENT]);
    expect(march().reconciliation).toBe("gap");

    unimportFile(bundle.db, fileId(EXPORT));

    expect(live().map((r) => [r.postedOn, r.amountCents])).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents],
      [GROCER.postedOn, GROCER.amountCents],
    ]);
    expect(live().some((r) => r.id === byHand)).toBe(true);
    expect(march().reconciliation).toBe("reconciled");
  });

  test("a line the file's own row records takes nothing from the file being un-imported, however the rows sort", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [EXPORT]);
    // the export's copy of the coffee, in the statement's own words and sorting before the statement's row
    const theirs = bundle.db
      .insert(transactions)
      .values({
        id: "00000000-0000-7000-8000-000000000001",
        accountId: accountId(),
        importFileId: fileId(EXPORT),
        postedOn: COFFEE.postedOn,
        amountCents: COFFEE.amountCents,
        rawDescription: "COFFEE ROASTERS #12 MIAMI FL",
        normalizedDescription: normalizeDescription("COFFEE ROASTERS #12 MIAMI FL"),
        dedupeHash: "hand-made copy of the coffee",
      })
      .returning({ id: transactions.id })
      .get().id;
    const ours = rowsOf(STATEMENT).find((r) => r.amountCents === COFFEE.amountCents)!;
    expect(theirs < ours.id).toBe(true);

    unimportFile(bundle.db, fileId(EXPORT));

    expect(live().some((r) => r.id === theirs)).toBe(false);
    expect(rowsOf(STATEMENT).map((r) => r.amountCents).sort()).toEqual([GROCER.amountCents, COFFEE.amountCents].sort());
  });

  test("a row two still-imported files print goes to one of them, the statement whose period holds its day", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    // the re-download is the most recent: the statement is chosen for its period, not its age
    bundle.db.update(importFiles).set({ importedAt: "2099-01-01T00:00:00.000Z" }).where(eq(importFiles.id, fileId(EXPORT_AGAIN))).run();
    const before = live().map((r) => r.id);

    unimportFile(bundle.db, fileId(EXPORT));

    expect(live().map((r) => r.id)).toEqual(before);
    expect(rowsOf(STATEMENT).map((r) => r.amountCents).sort()).toEqual([GROCER.amountCents, COFFEE.amountCents].sort());
    expect(rowsOf(EXPORT_AGAIN).map((r) => r.amountCents)).toEqual([LATE.amountCents]);
    expect(march().reconciliation).toBe("reconciled");
  });

  test("the file's record of what it prints goes with the file, and a re-read at a new version records it again", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    const recorded = () => bundle.db.select().from(printedLines).where(eq(printedLines.importFileId, fileId(EXPORT))).all();
    expect(recorded()).toHaveLength(1);
    expect(JSON.parse(recorded()[0]!.lines)).toHaveLength(3);
    const first = fileId(EXPORT);

    profile.version = 2;
    await importStatementFiles(bundle.db, [EXPORT]);
    expect(fileId(EXPORT)).not.toBe(first);
    expect(bundle.db.select().from(printedLines).where(eq(printedLines.importFileId, first)).all()).toEqual([]);
    expect(recorded()).toHaveLength(1);

    unimportFile(bundle.db, fileId(EXPORT));
    expect(bundle.db.select().from(printedLines).all()).toEqual([]);
  });

  test("a read that failed part-way and is read again records each line once", async () => {
    breaksMidFile = true;
    const [failed] = await importStatementFiles(bundle.db, [EXPORT]);
    expect(failed!.status).toBe("failed");
    const lines = () => bundle.db.select().from(printedLines).all().flatMap((r) => JSON.parse(r.lines) as unknown[]);
    expect(lines()).toHaveLength(3);

    breaksMidFile = false;
    const [again] = await importStatementFiles(bundle.db, [EXPORT]);
    expect(again!.status).toBe("parsed");
    expect(lines()).toHaveLength(3);
  });
});

/**
 * 🔴 An export more trusted than the statement that kept its rows takes them back when it is imported again — each
 * line the row it had. The takeover picked among same-day, same-amount rows by words and then by id, so of two equal
 * charges a line could retire the OTHER line's row, find its own still live under the same hash, and write nothing:
 * one charge gone. Measured on a copy of the real ledger, 2026-09-16, with rows kept under the statements that print
 * them: un-importing and re-importing Discover-AllAvailable-20260710.csv took Discover from 1,044 active rows to 1,039
 * and put three periods into gap.
 */
describe("an export read again takes back its rows from the statement that kept them", () => {
  const TWIN = { postedOn: "2026-03-20", amountCents: -290, rawDescription: "CITY PARKING METER" };
  const TAKEBACK_SECTIONS: Record<string, ParsedStatement[]> = {
    [`${PREFIX}takeback-export.csv`]: [{ accountHint: CHECKING, txns: [TWIN, TWIN, GROCER] }],
    [`${PREFIX}takeback-statement.pdf`]: [
      {
        accountHint: CHECKING,
        txns: [TWIN, TWIN, GROCER],
        period: { start: "2026-03-01", end: "2026-03-31", beginCents: 10_000, endCents: 6_920 },
      },
    ],
  };
  const byName: ParserProfile = {
    id: "test-printed-lines-by-name",
    version: 1,
    matches: (f) => f.name in TAKEBACK_SECTIONS,
    parse: (f) => TAKEBACK_SECTIONS[f.name]!,
  };
  // a CSV outranks a PDF: the statement's lines on the export's days are the export's to record
  const CSV: ImportInput = { name: `${PREFIX}takeback-export.csv`, buffer: Buffer.from("takeback export") };
  const PDF: ImportInput = { name: `${PREFIX}takeback-statement.pdf`, buffer: Buffer.from("%PDF-1.4 takeback statement") };

  beforeEach(() => {
    PROFILES.unshift(byName);
  });
  afterEach(() => {
    PROFILES.splice(PROFILES.indexOf(byName), 1);
  });

  test.each([["the first line's row sorts first"], ["the second line's row sorts first"]])("%s", async (order) => {
    await importStatementFiles(bundle.db, [CSV]);
    await importStatementFiles(bundle.db, [PDF]);
    const twins = rowsOf(CSV).filter((r) => r.amountCents === TWIN.amountCents);
    expect(twins).toHaveLength(2);
    expect(rowsOf(PDF)).toEqual([]);
    // row ids decide the tie: each line's own row sorts first, in turn
    const [low, high] = ["00000000-0000-7000-8000-00000000000a", "00000000-0000-7000-8000-00000000000b"];
    const lineHash = (occurrenceIndex: number) => dedupeHash({ accountId: accountId(), ...TWIN, occurrenceIndex });
    const a = twins.find((r) => r.dedupeHash === lineHash(0));
    const b = twins.find((r) => r.dedupeHash === lineHash(1));
    expect([a, b].every((r) => r !== undefined)).toBe(true);
    const [first, second] = order.startsWith("the first") ? [low, high] : [high, low];
    bundle.db.update(transactions).set({ id: first }).where(eq(transactions.id, a!.id)).run();
    bundle.db.update(transactions).set({ id: second }).where(eq(transactions.id, b!.id)).run();

    unimportFile(bundle.db, fileId(CSV));
    expect(rowsOf(PDF)).toHaveLength(3);

    const [again] = await importStatementFiles(bundle.db, [CSV]);
    expect(again).toMatchObject({ status: "parsed", supersededTakeover: 3, inserted: 3 });
    expect(live().map((r) => [r.postedOn, r.amountCents, r.importFileId])).toEqual([
      [GROCER.postedOn, GROCER.amountCents, fileId(CSV)],
      [TWIN.postedOn, TWIN.amountCents, fileId(CSV)],
      [TWIN.postedOn, TWIN.amountCents, fileId(CSV)],
    ]);
    const period = bundle.db.select().from(statementPeriods).where(eq(statementPeriods.importFileId, fileId(PDF))).get()!;
    expect(period.reconciliation).toBe("reconciled");
  });
});
