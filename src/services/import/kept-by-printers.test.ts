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
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "COFFEE ROASTERS 12" };
const GROCER = { postedOn: "2026-03-12", amountCents: -2500, rawDescription: "CORNER GROCER" };
const LATE = { postedOn: "2026-04-02", amountCents: -700, rawDescription: "LATE NIGHT TACOS" };
const OPENED = "2026-02-28";

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
