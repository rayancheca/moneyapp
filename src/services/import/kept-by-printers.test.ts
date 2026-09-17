import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { balancesRemovedByFile } from "./printed-anchors";
import { latestBalances } from "@/services/derivation";
import { PROFILES } from "./profiles";
import { importStatementFiles, unimportFile, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";
import { netWorthEffectsByFile } from "./unimport-counts";

/**
 * ⚖️ Owner decision 20 (2026-09-17): the opening an un-imported statement printed stays with the rows another file
 * keeps. Un-importing the file that holds such an opening, while yet another file prints its rows, hands the rows and
 * the opening to that file together.
 *
 * 🔴 The opening went with the file that held it, though its rows stayed under a re-download: on a backfilled copy of
 * the real ledger, 2026-09-17 (the review of uc/final-integrate), un-importing 2026-08-25-everyday-checking.pdf, then
 * importing rocket-money-export-2026-08-25.csv again in other bytes and un-importing the first export, kept Wells
 * Fargo Everyday Checking's 39 rows under the re-download with no balance — net worth 11,312,501 → 11,072,834 cents,
 * the account missing from it — and the confirmation named the account as leaving.
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
