import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { unimportedTransferLegs } from "@/db/schema/unimported-transfer-legs";
import { normalizeDescription } from "@/lib/normalize";
import { balancesRemovedByFile } from "./printed-anchors";
import { heldForPrinters, printerHandOvers, settleHeldRows, type PrinterHandOver } from "./printed-lines";
import { latestBalances } from "@/services/derivation";
import { PROFILES } from "./profiles";
import { importStatementFiles, unimportFile, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";
import { netWorthEffectsByFile, unimportCountsByFile } from "./unimport-counts";

/**
 * A parser-version re-read keeps what an un-import keeps: a row another still-imported file prints, and the opening
 * kept with such rows, stay when the new read no longer writes them — filed under that file.
 *
 * ⚖️ Owner decisions 15 (the rows a file took over come back while their own file is imported), 16 (a newer version that
 * stops reading an account keeps what the owner filed there) and 20 (the opening an un-imported statement printed stays
 * with the rows another file keeps) — the un-import's rules, for the other path that retires a read.
 *
 * 🔴 The re-read retired them all. Measured on a backfilled copy of the real ledger, 2026-09-17 (the review of
 * uc/final-integrate): 2026-08-25-everyday-checking.pdf uploaded again at a version that reads no statement left Wells
 * Fargo Everyday Checking's 39 PDF rows and the Rocket Money export's 39 twins all superseded and the account with no
 * balance — net worth 11,312,501 → 11,072,834 cents — while un-importing the same file keeps all 39 under the export.
 * 🔴 …and the opening kept for an un-imported statement went with the file that held it, though its rows stayed under a
 * re-download: un-importing the Rocket Money export after the statement took the account out of net worth again.
 */

let dir: string;
let bundle: DbBundle;

const PREFIX = "kept-by-printers-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "4501" };
/** the account the other leg of his hand-linked transfer sits in */
const SAVINGS: AccountHint = { institution: "Chase", type: "savings", last4: "9001" };
const SENT = { postedOn: "2026-03-05", amountCents: 1000, rawDescription: "TRANSFER TO CHECKING" };
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "COFFEE ROASTERS 12" };
const GROCER = { postedOn: "2026-03-12", amountCents: -2500, rawDescription: "CORNER GROCER" };
const LATE = { postedOn: "2026-04-02", amountCents: -700, rawDescription: "LATE NIGHT TACOS" };
const MOVIE = { postedOn: "2026-05-01", amountCents: -1500, rawDescription: "CINEMA DOWNTOWN" };
const BOOKS = { postedOn: "2026-05-02", amountCents: -800, rawDescription: "BOOKS AND MORE" };
const OPENED = "2026-02-28";

/** Each file's sections, by its text. The statement prints two of the export's lines, in its own words. */
const SECTIONS: Record<string, ParsedStatement[]> = {
  export: [{ accountHint: CHECKING, txns: [COFFEE, GROCER, LATE] }],
  // the export split in two: each download prints part of what one export prints
  "part a": [{ accountHint: CHECKING, txns: [COFFEE, GROCER] }],
  "part b": [{ accountHint: CHECKING, txns: [LATE] }],
  "part grocer": [{ accountHint: CHECKING, txns: [GROCER] }],
  "part coffee": [{ accountHint: CHECKING, txns: [COFFEE] }],
  // …and two later downloads of the same account, of two rows and of one
  "part cd": [{ accountHint: CHECKING, txns: [MOVIE, BOOKS] }],
  "part movie": [{ accountHint: CHECKING, txns: [MOVIE] }],
  // …and one that prints the coffee in the statement's words
  "export miami": [{ accountHint: CHECKING, txns: [{ ...COFFEE, rawDescription: "COFFEE ROASTERS #12 MIAMI FL" }] }],
  // the savings side of the transfer he linked by hand
  partner: [{ accountHint: SAVINGS, txns: [SENT] }],
  // …the same leg, on a download that says which day it was made
  "partner dated": [{ accountHint: SAVINGS, txns: [{ ...SENT, transactedOn: "2026-03-04" }] }],
  // …and a later download that posts it 03-07, beside a NEIGHBOURING credit of the same money made 03-05 and posted
  // on the day the leg used to be posted
  "partner again": [
    {
      accountHint: SAVINGS,
      txns: [
        { postedOn: "2026-03-07", transactedOn: "2026-03-04", amountCents: 1000, rawDescription: "TRANSFER TO CHECKING" },
        { postedOn: "2026-03-05", transactedOn: "2026-03-05", amountCents: 1000, rawDescription: "DEPOSIT AT BRANCH" },
      ],
    },
  ],
  // a statement over both months: two of its lines are one download's, the third the other's
  "statement q1": [
    {
      accountHint: CHECKING,
      txns: [
        { ...COFFEE, rawDescription: "COFFEE ROASTERS #12 MIAMI FL" },
        { ...GROCER, rawDescription: "CORNER GROCER MIAMI FL" },
        { ...LATE, rawDescription: "LATE NIGHT TACOS MIAMI FL" },
      ],
      period: { start: "2026-03-01", end: "2026-04-30", beginCents: 10_000, endCents: 5_800 },
    },
  ],
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

/** what version 2 reads of a file, by its text — every section when absent */
let atVersion2: Record<string, ParsedStatement[]> = {};

const profile: ParserProfile = {
  id: "test-kept-by-printers",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => {
    const text = f.text.trim();
    return profile.version === 2 && text in atVersion2 ? atVersion2[text]! : SECTIONS[text]!;
  },
};

const file = (name: string, text: string): ImportInput => ({ name: `${PREFIX}${name}.csv`, buffer: Buffer.from(text) });
const EXPORT = file("export", "export");
/** the export downloaded again: the same lines in different bytes */
const EXPORT_AGAIN = file("export (1)", "export\n");
const STATEMENT = file("statement-2026-03", "statement 2026-03");
const STATEMENT_Q1 = file("statement-q1", "statement q1");
/** two downloads that split the export's lines between them, and two that print one line each */
const PART_A = file("part-a", "part a");
const PART_B = file("part-b", "part b");
const PART_GROCER = file("part-grocer", "part grocer");
const PART_COFFEE = file("part-coffee", "part coffee");
const PART_CD = file("part-cd", "part cd");
const PART_MOVIE = file("part-movie", "part movie");
const MIAMI = file("export-miami", "export miami");
const PARTNER = file("partner", "partner");
const PARTNER_DATED = file("partner-dated", "partner dated");
const PARTNER_AGAIN = file("partner-again", "partner again");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-kept-by-printers-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  atVersion2 = {};
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
const accountName = () => bundle.db.select().from(accounts).where(eq(accounts.id, accountId())).get()!.name;
const live = () =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId()), ne(transactions.status, "superseded")))
    .orderBy(transactions.postedOn, transactions.amountCents)
    .all();
const byFile = () => live().map((r) => [r.postedOn, r.amountCents, r.status, r.importFileId]);
const anchors = () =>
  bundle.db
    .select({
      anchoredOn: balanceAnchors.anchoredOn,
      balanceCents: balanceAnchors.balanceCents,
      source: balanceAnchors.source,
      importFileId: balanceAnchors.importFileId,
    })
    .from(balanceAnchors)
    .where(eq(balanceAnchors.accountId, accountId()))
    .orderBy(asc(balanceAnchors.anchoredOn), asc(balanceAnchors.source))
    .all();
const netWorth = () => [...latestBalances(bundle.db).values()].reduce((n, b) => n + (b.balanceCents ?? 0), 0);
const balance = () => latestBalances(bundle.db).get(accountId())?.balanceCents ?? null;
const keptOpening = (input: ImportInput) => [{ anchoredOn: OPENED, balanceCents: 10_000, source: "unimported_statement", importFileId: fileId(input) }];

/** The owner's note and category on the statement's coffee row. */
function handWork(): { rowId: string; categoryId: string } {
  const coffee = live().find((r) => r.amountCents === COFFEE.amountCents)!;
  const categoryId = bundle.db.select().from(categories).all()[0]!.id;
  bundle.db
    .update(transactions)
    .set({ notes: "with Carson", categoryId, categorizationSource: "user" })
    .where(eq(transactions.id, coffee.id))
    .run();
  return { rowId: coffee.id, categoryId };
}

/** Wells Fargo's shape: the statement is the account's only balance, and the export prints every line it holds. */
async function statementThenExport(): Promise<void> {
  await importStatementFiles(bundle.db, [STATEMENT]);
  await importStatementFiles(bundle.db, [EXPORT]);
  expect(anchors().map((a) => a.source)).toEqual(["statement", "statement"]);
  expect(byFile()).toEqual([
    [COFFEE.postedOn, COFFEE.amountCents, "active", fileId(STATEMENT)],
    [GROCER.postedOn, GROCER.amountCents, "active", fileId(STATEMENT)],
    [LATE.postedOn, LATE.amountCents, "active", fileId(EXPORT)],
  ]);
}

describe("a re-read that stops reading an account keeps the rows a still-imported file prints, as un-import does", () => {
  test("K3: the statement read again at a version that reads nothing keeps its rows under the export, and its opening", async () => {
    await statementThenExport();
    const work = handWork();
    const before = { netWorth: netWorth(), balance: balance() };
    // the premise: un-importing the statement keeps both of its rows
    expect(unimportCountsByFile(bundle.db).get(fileId(STATEMENT))).toMatchObject({ deleted: 0, keptByPrinters: 2 });
    const retired = fileId(STATEMENT);

    profile.version = 2;
    atVersion2 = { "statement 2026-03": [] };
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 0, keptByPrinters: 2 });
    expect(fileId(STATEMENT)).not.toBe(retired);
    expect(byFile()).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, "active", fileId(EXPORT)],
      [GROCER.postedOn, GROCER.amountCents, "active", fileId(EXPORT)],
      [LATE.postedOn, LATE.amountCents, "active", fileId(EXPORT)],
    ]);
    // the same row, with everything the owner put on it
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, work.rowId)).get()).toMatchObject({
      status: "active",
      importFileId: fileId(EXPORT),
      notes: "with Carson",
      categoryId: work.categoryId,
      categorizationSource: "user",
    });
    expect(anchors()).toEqual(keptOpening(EXPORT));
    expect({ netWorth: netWorth(), balance: balance() }).toEqual(before);
    expect(latestBalances(bundle.db).get(accountId())).toMatchObject({ basis: "derived_unverified" });
  });

  test("a row he excluded comes back excluded", async () => {
    await statementThenExport();
    const grocer = live().find((r) => r.amountCents === GROCER.amountCents)!;
    bundle.db.update(transactions).set({ status: "excluded" }).where(eq(transactions.id, grocer.id)).run();

    profile.version = 2;
    atVersion2 = { "statement 2026-03": [] };
    await importStatementFiles(bundle.db, [STATEMENT]);

    expect(bundle.db.select().from(transactions).where(eq(transactions.id, grocer.id)).get()).toMatchObject({
      status: "excluded",
      importFileId: fileId(EXPORT),
    });
  });

  /**
   * The new read still covers the month: it answers for every line of it. A row the export prints on a day the new
   * read covers is not brought back beside it — a version that dates or prices a line differently writes that line
   * again, and the retired row would count it twice.
   */
  test("a version that dates a line differently records it once: the retired row is not brought back beside it", async () => {
    await statementThenExport();
    const before = balance();
    const [coffee, grocer] = SECTIONS["statement 2026-03"]![0]!.txns;

    profile.version = 2;
    atVersion2 = {
      "statement 2026-03": [{ ...SECTIONS["statement 2026-03"]![0]!, txns: [coffee!, { ...grocer!, postedOn: "2026-03-13" }] }],
    };
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 2, keptByPrinters: 0 });
    expect(byFile()).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, "active", fileId(STATEMENT)],
      ["2026-03-13", GROCER.amountCents, "active", fileId(STATEMENT)],
      [LATE.postedOn, LATE.amountCents, "active", fileId(EXPORT)],
    ]);
    const march = bundle.db.select().from(statementPeriods).where(eq(statementPeriods.accountId, accountId())).get()!;
    expect(march.reconciliation).toBe("reconciled");
    expect(balance()).toBe(before);
  });

  test("…and a version that drops a line of a month it still reads leaves that line to its own period's gap", async () => {
    await statementThenExport();

    profile.version = 2;
    atVersion2 = {
      "statement 2026-03": [{ ...SECTIONS["statement 2026-03"]![0]!, txns: [SECTIONS["statement 2026-03"]![0]!.txns[0]!] }],
    };
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 1, keptByPrinters: 0 });
    expect(live().map((r) => [r.postedOn, r.importFileId])).toEqual([
      [COFFEE.postedOn, fileId(STATEMENT)],
      [LATE.postedOn, fileId(EXPORT)],
    ]);
    const march = bundle.db.select().from(statementPeriods).where(eq(statementPeriods.accountId, accountId())).get()!;
    expect(march).toMatchObject({ reconciliation: "gap", gapCents: GROCER.amountCents });
  });

  test("a version that reads every line again keeps nothing back: its own rows record them", async () => {
    await statementThenExport();
    const before = balance();

    profile.version = 2;
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 2, keptByPrinters: 0 });
    expect(byFile()).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, "active", fileId(STATEMENT)],
      [GROCER.postedOn, GROCER.amountCents, "active", fileId(STATEMENT)],
      [LATE.postedOn, LATE.amountCents, "active", fileId(EXPORT)],
    ]);
    expect(balance()).toBe(before);
  });

  test("K4: an export read again at a version that reads nothing keeps its rows under the re-download that prints them", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    const ids = live().map((r) => r.id);
    expect(ids).toHaveLength(3);
    expect(unimportCountsByFile(bundle.db).get(fileId(EXPORT))).toMatchObject({ deleted: 0, keptByPrinters: 3 });

    profile.version = 2;
    atVersion2 = { export: [] };
    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 0, keptByPrinters: 3 });
    expect(live().map((r) => r.id)).toEqual(ids);
    expect(live().every((r) => r.importFileId === fileId(EXPORT_AGAIN) && r.status === "active")).toBe(true);
  });

  test("an export read again that dates a line a day later, past the days it read before, records it once, though the re-download prints the old day", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    const before = balance();

    profile.version = 2;
    atVersion2 = { export: [{ accountHint: CHECKING, txns: [{ ...COFFEE, postedOn: "2026-03-06" }, GROCER, LATE] }] };
    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 3, keptByPrinters: 0 });
    expect(live().map((r) => [r.postedOn, r.importFileId])).toEqual([
      ["2026-03-06", fileId(EXPORT)],
      [GROCER.postedOn, fileId(EXPORT)],
      [LATE.postedOn, fileId(EXPORT)],
    ]);
    expect(balance()).toBe(before);
  });

  test("…and the opening kept for an un-imported statement follows those rows to the re-download", async () => {
    await statementThenExport();
    unimportFile(bundle.db, fileId(STATEMENT));
    expect(anchors()).toEqual(keptOpening(EXPORT));
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    const before = { netWorth: netWorth(), balance: balance() };

    profile.version = 2;
    atVersion2 = { export: [] };
    await importStatementFiles(bundle.db, [EXPORT]);

    expect(live()).toHaveLength(3);
    expect(live().every((r) => r.importFileId === fileId(EXPORT_AGAIN))).toBe(true);
    expect(anchors()).toEqual(keptOpening(EXPORT_AGAIN));
    expect({ netWorth: netWorth(), balance: balance() }).toEqual(before);
  });

  test("a re-read with no other file printing its rows retires them, and its balances with them", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);

    profile.version = 2;
    atVersion2 = { "statement 2026-03": [] };
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", keptByPrinters: 0 });
    expect(live()).toEqual([]);
    expect(anchors()).toEqual([]);
  });
});

describe("a held row comes back only for a line no live row records", () => {
  test("a line a row entered since records takes nothing back, however the rows sort", async () => {
    await statementThenExport();
    const statement = fileId(STATEMENT);
    const held = heldForPrinters(bundle.db, new Map(), [statement]);
    expect(held.plans.flatMap((p) => p.rowIds)).toHaveLength(2);
    // the retirement, and a record of the grocer's money entered meanwhile, in words far from the line's
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.importFileId, statement)).run();
    const { id: _id, dedupeHash, ...template } = live().find((r) => r.amountCents === LATE.amountCents)!;
    bundle.db
      .insert(transactions)
      .values({
        ...template,
        postedOn: GROCER.postedOn,
        amountCents: GROCER.amountCents,
        rawDescription: "ENTERED BY HAND",
        normalizedDescription: "entered by hand",
        importFileId: null,
        dedupeHash: `${dedupeHash}-by-hand`,
      })
      .run();

    const back = settleHeldRows(bundle.db, held, []);

    expect(back.flatMap((p) => p.rowIds)).toHaveLength(1);
    expect(live().map((r) => [r.postedOn, r.rawDescription])).toEqual([
      [COFFEE.postedOn, "COFFEE ROASTERS #12 MIAMI FL"],
      [GROCER.postedOn, "ENTERED BY HAND"],
      [LATE.postedOn, LATE.rawDescription],
    ]);
  });
});

/**
 * A re-read that retires several reads at once (a brokerage book's months) retires all of their rows together: a line
 * two of them record must keep one of the two. Weighed one file at a time, each counted on the other's row, and the
 * line kept neither.
 */
describe("reads retired together are weighed together", () => {
  test("a line two retiring files record keeps one of their rows", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    await importStatementFiles(bundle.db, [STATEMENT]);
    // the statement holds a second record of the coffee — as a read that absorbed nothing would have written it
    const coffee = live().find((r) => r.amountCents === COFFEE.amountCents)!;
    const { id: _id, dedupeHash, ...rest } = coffee;
    bundle.db
      .insert(transactions)
      .values({ ...rest, importFileId: fileId(STATEMENT), dedupeHash: `${dedupeHash}-second-record` })
      .run();
    const both = [fileId(EXPORT), fileId(STATEMENT)];
    const kept = (plans: Map<string, PrinterHandOver[]>) => [...plans.values()].flat().flatMap((p) => p.rowIds);

    // alone, each file's coffee row can lean on the other's
    expect(kept(printerHandOvers(bundle.db, new Map(), both))).toHaveLength(2);
    // together, the coffee keeps one of them
    const together = printerHandOvers(bundle.db, new Map(), both, { together: true });
    expect(kept(together)).toHaveLength(3);
    expect([...together.values()].flat().every((p) => p.heirFileId === fileId(EXPORT_AGAIN))).toBe(true);
  });
});

describe("un-importing the file that holds a kept opening hands it to the file its rows go to", () => {
  test("K1: the export's un-import keeps the rows under the re-download, and the account stays in net worth", async () => {
    await statementThenExport();
    unimportFile(bundle.db, fileId(STATEMENT));
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    const before = { netWorth: netWorth(), balance: balance() };
    expect(before.balance).toBe(10_000 + COFFEE.amountCents + GROCER.amountCents + LATE.amountCents);

    // the confirmation: the account keeps its opening, under the re-download, and no balance is removed
    const effects = netWorthEffectsByFile(bundle.db);
    expect(effects.leaving.get(fileId(EXPORT))).toBeUndefined();
    expect(effects.keeping.get(fileId(EXPORT))).toEqual([
      { accountId: accountId(), name: accountName(), day: OPENED, balanceCents: 10_000, keptRows: 3, heirFileName: EXPORT_AGAIN.name },
    ]);
    expect(balancesRemovedByFile(bundle.db).get(fileId(EXPORT)) ?? 0).toBe(0);

    unimportFile(bundle.db, fileId(EXPORT));

    expect(live()).toHaveLength(3);
    expect(live().every((r) => r.importFileId === fileId(EXPORT_AGAIN))).toBe(true);
    expect(anchors()).toEqual(keptOpening(EXPORT_AGAIN));
    expect({ netWorth: netWorth(), balance: balance() }).toEqual(before);
  });

  test("…and un-importing the re-download too takes the opening with the last of the rows", async () => {
    await statementThenExport();
    unimportFile(bundle.db, fileId(STATEMENT));
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    unimportFile(bundle.db, fileId(EXPORT));
    expect(balancesRemovedByFile(bundle.db).get(fileId(EXPORT_AGAIN))).toBe(1);

    unimportFile(bundle.db, fileId(EXPORT_AGAIN));

    expect(live()).toEqual([]);
    expect(anchors()).toEqual([]);
  });
});

/**
 * The account's rows are split between two downloads, and only one of them prints what the file holding the opening
 * holds. The opening belongs to the rows, not to the file: while ANY still-imported file keeps a live row on the
 * account, the opening goes to that file.
 *
 * 🔴 It was deleted with its holder whenever no file printed that holder's own rows. On a backfilled copy of the real
 * ledger, 2026-09-17: the Rocket Money export split in two, both halves imported, the statement and the whole export
 * un-imported, and un-importing the first half left Wells Fargo Everyday Checking with 19 active rows under the second
 * half, no anchor, net worth 11,312,501 → 11,072,834 cents and lastPoint complete=false. Re-reading that half at a
 * version that reads nothing did the same, with an outcome that said inserted 0, keptByPrinters 0.
 */
describe("the opening stays while the account keeps a row, whichever file keeps it", () => {
  test("R1: un-importing the download that holds it leaves it with the download that keeps the last row", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [PART_A]);
    await importStatementFiles(bundle.db, [PART_B]);
    unimportFile(bundle.db, fileId(STATEMENT));
    // part a keeps two of the statement's rows and part b none: the opening goes to the file that keeps the most
    expect(anchors()).toEqual(keptOpening(PART_A));
    expect(balance()).toBe(10_000 + COFFEE.amountCents + GROCER.amountCents + LATE.amountCents);

    // the confirmation: the account keeps its opening, under part b, and no balance is removed
    const effects = netWorthEffectsByFile(bundle.db);
    expect(effects.leaving.get(fileId(PART_A))).toBeUndefined();
    expect(effects.keeping.get(fileId(PART_A))).toEqual([
      { accountId: accountId(), name: accountName(), day: OPENED, balanceCents: 10_000, keptRows: 1, heirFileName: PART_B.name },
    ]);
    expect(balancesRemovedByFile(bundle.db).get(fileId(PART_A)) ?? 0).toBe(0);

    unimportFile(bundle.db, fileId(PART_A));

    // its own two rows go with it — no file prints them — and the third stays, on the opening
    expect(byFile()).toEqual([[LATE.postedOn, LATE.amountCents, "active", fileId(PART_B)]]);
    expect(anchors()).toEqual(keptOpening(PART_B));
    expect(balance()).toBe(10_000 + LATE.amountCents);

    // …and the file that keeps the last row takes the opening with it
    unimportFile(bundle.db, fileId(PART_B));
    expect(live()).toEqual([]);
    expect(anchors()).toEqual([]);
  });

  /** Two downloads print the statement's rows, one more of them than the other. */
  test("…to the download that keeps the most of the statement's own rows", async () => {
    await importStatementFiles(bundle.db, [STATEMENT_Q1]);
    await importStatementFiles(bundle.db, [PART_A]); // prints two of its three lines
    await importStatementFiles(bundle.db, [PART_B]); // …and this one the third

    unimportFile(bundle.db, fileId(STATEMENT_Q1));

    expect(byFile()).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, "active", fileId(PART_A)],
      [GROCER.postedOn, GROCER.amountCents, "active", fileId(PART_A)],
      [LATE.postedOn, LATE.amountCents, "active", fileId(PART_B)],
    ]);
    expect(anchors()).toEqual(keptOpening(PART_A));
  });

  test("…and on a tie, to the lower file id", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [PART_COFFEE]);
    await importStatementFiles(bundle.db, [PART_GROCER]);

    unimportFile(bundle.db, fileId(STATEMENT));

    // one row each: the tie
    expect(byFile()).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, "active", fileId(PART_COFFEE)],
      [GROCER.postedOn, GROCER.amountCents, "active", fileId(PART_GROCER)],
    ]);
    const lower = [fileId(PART_COFFEE), fileId(PART_GROCER)].sort()[0]!;
    expect(anchors()).toEqual([{ anchoredOn: OPENED, balanceCents: 10_000, source: "unimported_statement", importFileId: lower }]);
  });

  /** The holder's own rows are printed by nobody, and two other downloads keep rows: the opening goes to the larger. */
  test("…to the file that keeps the most of the account's rows", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [PART_A]);
    await importStatementFiles(bundle.db, [PART_B]); // one row
    await importStatementFiles(bundle.db, [PART_CD]); // two
    unimportFile(bundle.db, fileId(STATEMENT));
    expect(anchors()).toEqual(keptOpening(PART_A));

    unimportFile(bundle.db, fileId(PART_A));

    expect(anchors()).toEqual(keptOpening(PART_CD));
    expect(balance()).toBe(10_000 + LATE.amountCents + MOVIE.amountCents + BOOKS.amountCents);

    // …and when that file goes too, to the one that keeps the last row
    unimportFile(bundle.db, fileId(PART_CD));
    expect(anchors()).toEqual(keptOpening(PART_B));
  });

  /** A row he filed under a file by hand stays when that file goes (`detachAttachedRows`): it keeps nothing for it. */
  test("…counting only the rows a file parsed, never the ones filed under it by hand", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [PART_A]);
    await importStatementFiles(bundle.db, [PART_B]); // one parsed row
    await importStatementFiles(bundle.db, [PART_CD]); // two, filed there by hand below
    bundle.db
      .update(transactions)
      .set({ fileLinkSource: "attached" })
      .where(eq(transactions.importFileId, fileId(PART_CD)))
      .run();
    unimportFile(bundle.db, fileId(STATEMENT));
    expect(anchors()).toEqual(keptOpening(PART_A));

    unimportFile(bundle.db, fileId(PART_A));

    expect(anchors()).toEqual(keptOpening(PART_B));
    expect(live()).toHaveLength(3);
  });

  test("…and on a tie between two files that keep the account's other rows, to the lower file id", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [PART_A]);
    await importStatementFiles(bundle.db, [PART_B]);
    await importStatementFiles(bundle.db, [PART_MOVIE]);
    unimportFile(bundle.db, fileId(STATEMENT));

    unimportFile(bundle.db, fileId(PART_A));

    const lower = [fileId(PART_B), fileId(PART_MOVIE)].sort()[0]!;
    expect(anchors()).toEqual([{ anchoredOn: OPENED, balanceCents: 10_000, source: "unimported_statement", importFileId: lower }]);
  });

  /**
   * The re-read still writes the statement's lines, so none of its rows is held back for the download that prints
   * them — but it prints no period any more, and the account records no balance. The opening it printed stays, under
   * the file that keeps the account's other rows; never under the successor, which is the file read again.
   */
  test("a re-read that stops printing the statement's period keeps its opening under a file that keeps rows", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [PART_A]); // prints both of the statement's lines
    await importStatementFiles(bundle.db, [PART_B]); // …and writes the late night tacos
    expect(anchors().map((a) => a.source)).toEqual(["statement", "statement"]);

    profile.version = 2;
    atVersion2 = { "statement 2026-03": [{ accountHint: CHECKING, txns: SECTIONS["statement 2026-03"]![0]!.txns }] };
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 2, keptByPrinters: 0 });
    expect(live()).toHaveLength(3);
    expect(anchors()).toEqual(keptOpening(PART_B));
    expect(balance()).toBe(10_000 + COFFEE.amountCents + GROCER.amountCents + LATE.amountCents);
  });

  test("R2: reading the holder again at a version that reads nothing leaves it with the download that keeps a row", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [PART_A]);
    await importStatementFiles(bundle.db, [PART_B]);
    unimportFile(bundle.db, fileId(STATEMENT));
    expect(anchors()).toEqual(keptOpening(PART_A));

    profile.version = 2;
    atVersion2 = { "part a": [] };
    const [outcome] = await importStatementFiles(bundle.db, [PART_A]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 0 });
    expect(byFile()).toEqual([[LATE.postedOn, LATE.amountCents, "active", fileId(PART_B)]]);
    expect(anchors()).toEqual(keptOpening(PART_B));
    expect(balance()).toBe(10_000 + LATE.amountCents);
  });
});

/**
 * Which file a held row comes back under is the plan's choice (`printerHandOvers`, `pickHeir`), not the first heir that
 * prints its line: each heir takes the rows planned for it before it takes any other one still waiting.
 */
describe("a held row comes back under the file the plan names", () => {
  test("the heir that prints both lines takes only the one planned for it", async () => {
    await importStatementFiles(bundle.db, [PART_A]); // writes the coffee and the grocer
    await importStatementFiles(bundle.db, [EXPORT]); // prints both, and writes the late night tacos
    await importStatementFiles(bundle.db, [PART_GROCER]); // prints the grocer, and is the last file that does
    const coffee = live().find((r) => r.amountCents === COFFEE.amountCents)!;
    const grocer = live().find((r) => r.amountCents === GROCER.amountCents)!;
    // the premise: the coffee is planned for the export, the grocer for the download imported last
    const planned = new Map(heldForPrinters(bundle.db, new Map(), [fileId(PART_A)]).plans.map((p) => [p.heirFileId, p.rowIds] as const));
    expect(planned.get(fileId(EXPORT))).toEqual([coffee.id]);
    expect(planned.get(fileId(PART_GROCER))).toEqual([grocer.id]);
    expect(planned.size).toBe(2);

    profile.version = 2;
    atVersion2 = { "part a": [] };
    const [outcome] = await importStatementFiles(bundle.db, [PART_A]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 0, keptByPrinters: 2 });
    expect(byFile()).toEqual([
      [COFFEE.postedOn, COFFEE.amountCents, "active", fileId(EXPORT)],
      [GROCER.postedOn, GROCER.amountCents, "active", fileId(PART_GROCER)],
      [LATE.postedOn, LATE.amountCents, "active", fileId(EXPORT)],
    ]);
    // the same rows, not fresh ones
    expect(live().map((r) => r.id)).toContain(coffee.id);
    expect(live().map((r) => r.id)).toContain(grocer.id);
  });
});

/**
 * Two files print the same line while two reads retired together each hold a row of it: ONE row comes back. A row a
 * printer has already taken back records the line, as any live row does — otherwise the second printer takes the second
 * row and the charge is counted twice.
 */
describe("a line two files print takes one row back, not one each", () => {
  test("the second printer's line is recorded by the row the first took back", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [STATEMENT]);
    // the statement holds a second record of the coffee, in its own words — as a read that absorbed nothing wrote it
    const coffee = live().find((r) => r.amountCents === COFFEE.amountCents)!;
    const { id: _id, dedupeHash, ...rest } = coffee;
    const miamiWords = "COFFEE ROASTERS #12 MIAMI FL";
    bundle.db
      .insert(transactions)
      .values({
        ...rest,
        importFileId: fileId(STATEMENT),
        rawDescription: miamiWords,
        normalizedDescription: normalizeDescription(miamiWords),
        dedupeHash: `${dedupeHash}-second-record`,
      })
      .run();
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]); // prints the export's three lines
    await importStatementFiles(bundle.db, [MIAMI]); // …and this one prints the coffee in the statement's words
    const both = [fileId(EXPORT), fileId(STATEMENT)];
    const held = heldForPrinters(bundle.db, new Map(), both);
    // the premise: the two reads are weighed together, so all four rows are planned — a coffee for each printer
    expect(held.plans.flatMap((p) => p.rowIds)).toHaveLength(4);

    for (const id of both) bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.importFileId, id)).run();
    const back = settleHeldRows(bundle.db, held, []);

    expect(back.flatMap((p) => p.rowIds)).toHaveLength(3);
    expect(live()).toHaveLength(3);
    expect(live().reduce((n, r) => n + r.amountCents, 0)).toBe(COFFEE.amountCents + GROCER.amountCents + LATE.amountCents);
  });
});

/**
 * A transfer an un-import took apart waits by the row that stayed (`unimported-transfers`). A re-read of that row's
 * file retires it and the record is kept by its content (`keepStayingLegsByContent`); when a printer takes the row
 * back, the record must name it again (`waitByRowsAgain`) — otherwise it waits for an import that writes its line
 * while a live row already records it, and importing the partner's file again leaves his pair apart.
 */
describe("a held row that is a transfer leg waits by that row again", () => {
  test("the kept leg names the row the printer took back", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
    await importStatementFiles(bundle.db, [PARTNER]);
    const coffee = live().find((r) => r.amountCents === COFFEE.amountCents)!;
    const other = bundle.db.select().from(transactions).where(eq(transactions.importFileId, fileId(PARTNER))).get()!;
    // his pair, linked by hand — the one detection could not prove
    for (const id of [coffee.id, other.id]) {
      bundle.db.update(transactions).set({ transferGroupId: "g-by-hand" }).where(eq(transactions.id, id)).run();
    }
    const waiting = () => bundle.db.select().from(unimportedTransferLegs).all();

    // taken apart: the leg that stays waits by its row
    unimportFile(bundle.db, fileId(PARTNER));
    expect(waiting().map((l) => l.transactionId).filter((id) => id !== null)).toEqual([coffee.id]);

    profile.version = 2;
    atVersion2 = { export: [] };
    await importStatementFiles(bundle.db, [EXPORT]);

    // the row came back under the re-download — the same row — and the record names it again
    expect(live().find((r) => r.amountCents === COFFEE.amountCents)).toMatchObject({
      id: coffee.id,
      importFileId: fileId(EXPORT_AGAIN),
    });
    expect(waiting().map((l) => l.transactionId).filter((id) => id !== null)).toEqual([coffee.id]);
  });

  /**
   * 🔴 The lost leg claimed a candidate by the posted day first, and no lens refused one that contradicts the day the
   * leg says the charge was made (`claim`, unimported-transfers.ts) — the same rule the attribute memory answered the
   * old way (`claimCarry`, fixed 2026-09-22). A later download posts the leg on its own day, so the leg's posted day
   * is a NEIGHBOURING credit's: his pair came back around the branch deposit, and the transfer he linked by hand was
   * left pointing at money that was never his transfer.
   */
  test("the returning leg is the one made on the leg's transaction day, not the neighbour that shares its posted day", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [PARTNER_DATED]);
    const coffee = live().find((r) => r.amountCents === COFFEE.amountCents)!;
    const sent = bundle.db.select().from(transactions).where(eq(transactions.importFileId, fileId(PARTNER_DATED))).get()!;
    for (const id of [coffee.id, sent.id]) {
      bundle.db.update(transactions).set({ transferGroupId: "g-by-hand" }).where(eq(transactions.id, id)).run();
    }
    unimportFile(bundle.db, fileId(PARTNER_DATED));

    await importStatementFiles(bundle.db, [PARTNER_AGAIN]);

    const savings = bundle.db.select().from(transactions).where(eq(transactions.importFileId, fileId(PARTNER_AGAIN))).all();
    const back = savings.find((r) => r.rawDescription === "TRANSFER TO CHECKING")!;
    const deposit = savings.find((r) => r.rawDescription === "DEPOSIT AT BRANCH")!;
    const group = bundle.db.select().from(transactions).where(eq(transactions.id, coffee.id)).get()!.transferGroupId;
    expect(group).not.toBeNull();
    expect(back.transferGroupId).toBe(group);
    expect(deposit.transferGroupId).toBeNull();
    expect(bundle.db.select().from(unimportedTransferLegs).all()).toEqual([]);
  });
});
