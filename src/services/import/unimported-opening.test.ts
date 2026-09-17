import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { importFiles } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { addManualAnchor } from "@/services/anchors";
import { accountCoverage } from "@/services/coverage";
import { latestBalances, netWorthSeries } from "@/services/derivation";
import { provenanceFor } from "@/services/provenance";
import { PROFILES } from "./profiles";
import { importStatementFiles, unimportFile, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";
import { accountsLeftWithoutBalance, openingsKeptByFile, unimportCountsByFile } from "./unimport-counts";

/**
 * ⚖️ Owner decision (20), 2026-09-17: un-importing a statement whose rows stay under another still-imported file, and
 * which leaves the account with no recorded balance, keeps the OPENING balance that statement printed — marked as a
 * statement he un-imported. The kept rows replay from it, so net worth does not move, and nothing reads it as checked.
 * Importing the statement again puts its own balances back and takes the kept opening away; un-importing the file
 * that keeps the rows takes it too.
 *
 * 🔴 Wells Fargo Everyday Checking's shape: un-importing 2026-08-25-everyday-checking.pdf kept its 39 rows under the
 * Rocket Money export and took both of its balances, and net worth fell 11,312,501 → 11,072,834 cents (a backfilled
 * copy of the real ledger, 2026-09-16).
 */

let dir: string;
let bundle: DbBundle;

const PREFIX = "unimported-opening-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "4301" };
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "COFFEE ROASTERS 12" };
const GROCER = { postedOn: "2026-03-12", amountCents: -2500, rawDescription: "CORNER GROCER" };
const LATE = { postedOn: "2026-04-02", amountCents: -700, rawDescription: "LATE NIGHT TACOS" };
const OPENED = "2026-02-28";
const BROKER: AccountHint = { institution: "Chase", type: "investment", last4: "4302" };
const DIVIDEND = { postedOn: "2026-03-10", amountCents: 1_000, rawDescription: "DIVIDEND XYZ" };

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
  // the month before: its closing prints the day the March statement opens on
  "statement 2026-02": [
    { accountHint: CHECKING, txns: [], period: { start: "2026-02-01", end: "2026-02-28", beginCents: 10_000, endCents: 10_000 } },
  ],
  "brokerage export": [{ accountHint: BROKER, txns: [DIVIDEND] }],
  "brokerage statement 2026-03": [
    {
      accountHint: BROKER,
      txns: [{ ...DIVIDEND, rawDescription: "DIVIDEND XYZ CORP" }],
      period: { start: "2026-03-01", end: "2026-03-31", beginCents: 50_000, endCents: 51_000 },
    },
  ],
};

/** when set, the export read at version 2 no longer reads the account */
let exportStopsReading = false;

const profile: ParserProfile = {
  id: "test-unimported-opening",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => {
    const text = f.text.trim();
    if (text === "export" && exportStopsReading) return [];
    return SECTIONS[text]!;
  },
};

const file = (name: string, text: string): ImportInput => ({ name: `${PREFIX}${name}.csv`, buffer: Buffer.from(text) });
const EXPORT = file("export", "export");
const STATEMENT = file("statement-2026-03", "statement 2026-03");
const FEBRUARY = file("statement-2026-02", "statement 2026-02");
const BROKERAGE_EXPORT = file("brokerage-export", "brokerage export");
const BROKERAGE_STATEMENT = file("brokerage-statement-2026-03", "brokerage statement 2026-03");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-unimported-opening-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  exportStopsReading = false;
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
const accountOf = (hint: AccountHint) => bundle.db.select().from(accounts).where(eq(accounts.last4, hint.last4!)).get()!.id;
const accountId = () => accountOf(CHECKING);
const accountName = () => bundle.db.select().from(accounts).where(eq(accounts.id, accountId())).get()!.name;
const live = () =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId()), ne(transactions.status, "superseded")))
    .orderBy(transactions.postedOn, transactions.amountCents)
    .all();
const anchors = (account: string = accountId()) =>
  bundle.db
    .select({
      anchoredOn: balanceAnchors.anchoredOn,
      balanceCents: balanceAnchors.balanceCents,
      source: balanceAnchors.source,
      importFileId: balanceAnchors.importFileId,
      statementPeriodId: balanceAnchors.statementPeriodId,
    })
    .from(balanceAnchors)
    .where(eq(balanceAnchors.accountId, account))
    .orderBy(asc(balanceAnchors.anchoredOn), asc(balanceAnchors.source))
    .all();
const storedDays = () =>
  bundle.db
    .select({ day: dailyBalances.day, balanceCents: dailyBalances.balanceCents, basis: dailyBalances.basis })
    .from(dailyBalances)
    .where(eq(dailyBalances.accountId, accountId()))
    .orderBy(asc(dailyBalances.day))
    .all();
const netWorth = () => [...latestBalances(bundle.db).values()].reduce((n, b) => n + (b.balanceCents ?? 0), 0);
const coverageOf = () => accountCoverage(bundle.db).find((c) => c.accountId === accountId())!;

async function bothImported(): Promise<void> {
  await importStatementFiles(bundle.db, [STATEMENT]);
  await importStatementFiles(bundle.db, [EXPORT]);
  // the premise: the statement is the account's only balance, and the export prints every line it holds
  expect(anchors().map((a) => a.source)).toEqual(["statement", "statement"]);
  expect(live()).toHaveLength(3);
}

describe("un-importing a statement whose rows another file keeps keeps the opening balance it printed", () => {
  test("net worth does not move, and no day of the account reads checked", async () => {
    await bothImported();
    const before = netWorth();
    const balance = latestBalances(bundle.db).get(accountId())!.balanceCents;
    expect(balance).toBe(10_000 + COFFEE.amountCents + GROCER.amountCents + LATE.amountCents);

    unimportFile(bundle.db, fileId(STATEMENT));

    expect(live().map((r) => r.importFileId)).toEqual([fileId(EXPORT), fileId(EXPORT), fileId(EXPORT)]);
    expect(anchors()).toEqual([
      { anchoredOn: OPENED, balanceCents: 10_000, source: "unimported_statement", importFileId: fileId(EXPORT), statementPeriodId: null },
    ]);
    expect(netWorth()).toBe(before);
    expect(latestBalances(bundle.db).get(accountId())).toMatchObject({ balanceCents: balance, basis: "derived_unverified" });
    const days = storedDays();
    expect(days[0]).toEqual({ day: OPENED, balanceCents: 10_000, basis: "derived_unverified" });
    expect(days.find((d) => d.day === "2026-03-31")).toMatchObject({ balanceCents: 6_500 });
    expect(new Set(days.map((d) => d.basis))).toEqual(new Set(["derived_unverified"]));
    // coverage: nothing closes, and nothing is his count
    expect(coverageOf()).toMatchObject({ grade: "unverified", verifiedThrough: null, countedOn: null, keptOpeningOn: OPENED });
    // net worth: in the total, unchecked, and not a hole
    const today = netWorthSeries(bundle.db).at(-1)!;
    expect(today.unverifiedAccounts).toContain(accountName());
    expect(today.gapAccounts).not.toContain(accountName());
    expect(today.missingAccounts).not.toContain(accountName());
  });

  test("the balance proof names a statement he un-imported, never the export that keeps the rows, and never a check", async () => {
    await bothImported();
    unimportFile(bundle.db, fileId(STATEMENT));

    const proof = provenanceFor(bundle.db, { kind: "accountBalance", accountId: accountId() })!;
    expect(proof.verdict).toBe("unverified");
    expect(proof.checkedThrough).toBeNull();
    expect(proof.headline).toContain("the opening balance of a statement you un-imported, printed for Feb 28, 2026");
    expect(proof.sources[0]).toMatchObject({ kind: "anchor", label: "a statement you un-imported", on: OPENED });
    expect(JSON.stringify(proof)).not.toContain(EXPORT.name);
    const opening = provenanceFor(bundle.db, { kind: "accountBalance", accountId: accountId(), day: OPENED })!;
    expect(opening.verdict).toBe("unverified");
    // a row the export keeps: the export never recorded a balance, though it owns the kept opening
    const late = live().find((r) => r.amountCents === LATE.amountCents)!;
    const row = provenanceFor(bundle.db, { kind: "transaction", id: late.id })!;
    expect(row.verdict).toBe("unverified");
    expect(row.headline).toContain(`This row came from ${EXPORT.name}`);
    expect(row.headline).not.toContain("recorded");
  });

  test("the confirmation says the balance stays, on the opening it keeps, instead of leaving net worth", async () => {
    await bothImported();
    expect(accountsLeftWithoutBalance(bundle.db).get(fileId(STATEMENT))).toBeUndefined();
    expect(openingsKeptByFile(bundle.db).get(fileId(STATEMENT))).toEqual([
      { accountId: accountId(), name: accountName(), day: OPENED, balanceCents: 10_000, keptRows: 3, heirFileName: EXPORT.name },
    ]);
    expect(openingsKeptByFile(bundle.db).get(fileId(EXPORT))).toBeUndefined();
    unimportFile(bundle.db, fileId(STATEMENT));
    // …and the export's un-import then takes the kept opening and every row: nothing is left to leave net worth
    expect(accountsLeftWithoutBalance(bundle.db).get(fileId(EXPORT))).toBeUndefined();
  });

  test("importing the statement again puts its own balances back and takes the kept opening away", async () => {
    await bothImported();
    const start = storedDays();
    const startAnchors = anchors().map(({ anchoredOn, balanceCents, source }) => ({ anchoredOn, balanceCents, source }));
    unimportFile(bundle.db, fileId(STATEMENT));

    await importStatementFiles(bundle.db, [STATEMENT]);

    expect(anchors().map(({ anchoredOn, balanceCents, source }) => ({ anchoredOn, balanceCents, source }))).toEqual(startAnchors);
    expect(anchors().every((a) => a.importFileId === fileId(STATEMENT))).toBe(true);
    expect(storedDays()).toEqual(start);
  });

  test("un-importing the export too takes the kept opening with its rows", async () => {
    await bothImported();
    unimportFile(bundle.db, fileId(STATEMENT));

    unimportFile(bundle.db, fileId(EXPORT));

    expect(live()).toEqual([]);
    expect(anchors()).toEqual([]);
    expect(storedDays()).toEqual([]);
  });

  test("a re-read of the export at a new version keeps the opening, under the re-read", async () => {
    await bothImported();
    const before = netWorth();
    unimportFile(bundle.db, fileId(STATEMENT));
    const retired = fileId(EXPORT);

    profile.version = 2;
    await importStatementFiles(bundle.db, [EXPORT]);

    expect(fileId(EXPORT)).not.toBe(retired);
    expect(anchors()).toEqual([
      { anchoredOn: OPENED, balanceCents: 10_000, source: "unimported_statement", importFileId: fileId(EXPORT), statementPeriodId: null },
    ]);
    expect(live().map((r) => r.importFileId)).toEqual([fileId(EXPORT), fileId(EXPORT), fileId(EXPORT)]);
    expect(netWorth()).toBe(before);
  });

  test("…and a re-read that stops reading the account takes the opening with the rows it no longer writes", async () => {
    await bothImported();
    unimportFile(bundle.db, fileId(STATEMENT));

    profile.version = 2;
    exportStopsReading = true;
    await importStatementFiles(bundle.db, [EXPORT]);

    expect(live()).toEqual([]);
    expect(anchors()).toEqual([]);
    expect(storedDays()).toEqual([]);
  });
});

describe("only an opening the statement printed, only for an account left with nothing else", () => {
  test("a statement no other file keeps a row of keeps nothing: its rows and its balances leave together", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    unimportFile(bundle.db, fileId(STATEMENT));
    expect(live()).toEqual([]);
    expect(anchors()).toEqual([]);
  });

  test("a statement whose closing prints the kept day replaces the kept opening", async () => {
    await bothImported();
    unimportFile(bundle.db, fileId(STATEMENT));

    await importStatementFiles(bundle.db, [FEBRUARY]);

    expect(anchors().map((a) => [a.anchoredOn, a.balanceCents, a.source])).toEqual([
      ["2026-01-31", 10_000, "statement"],
      [OPENED, 10_000, "statement"],
    ]);
  });

  test("an investment account keeps no opening: its rows do not move a recorded value", async () => {
    await importStatementFiles(bundle.db, [BROKERAGE_STATEMENT]);
    await importStatementFiles(bundle.db, [BROKERAGE_EXPORT]);
    const broker = accountOf(BROKER);
    // the premise: the export prints the statement's line, and the account's balances are the statement's alone
    expect(anchors(broker).map((a) => a.source)).toEqual(["statement", "statement"]);
    expect(unimportCountsByFile(bundle.db).get(fileId(BROKERAGE_STATEMENT))).toMatchObject({ deleted: 0, keptByPrinters: 1 });
    expect(openingsKeptByFile(bundle.db).get(fileId(BROKERAGE_STATEMENT))).toBeUndefined();

    unimportFile(bundle.db, fileId(BROKERAGE_STATEMENT));

    expect(anchors(broker)).toEqual([]);
  });

  test("an account that keeps a balance he recorded keeps no opening beside it", async () => {
    await bothImported();
    addManualAnchor(bundle.db, { accountId: accountId(), anchoredOn: "2026-04-10", enteredCents: 5_800 });
    expect(openingsKeptByFile(bundle.db).get(fileId(STATEMENT))).toBeUndefined();

    unimportFile(bundle.db, fileId(STATEMENT));

    expect(anchors().map((a) => [a.anchoredOn, a.source])).toEqual([["2026-04-10", "manual"]]);
  });
});
