import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { linesLeftOut } from "./lines-left-out";
import { PROFILES } from "./profiles";
import { importStatementFiles, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";

/**
 * A re-read that DROPS a line a still-imported file prints leaves that line out of the ledger — and says so.
 *
 * ⚖️ Owner, 2026-09-28: leave the row out — never add money on a guess — but make it loud: the upload outcome counts
 * it, naming the line and the still-imported file that prints it, and `pnpm ledger-check` raises a finding naming it.
 *
 * 🔴 It left silently. An export re-read at a version that drops a line takes the retired read's row with it, and a
 * re-download that still prints the line brings nothing back: the day lies inside the window the re-read answers for
 * (`settleHeldRows`), an export's period is `not_applicable` so no gap opens, the outcome counted nothing and
 * ledger-check found nothing. Measured in a rehearsal on a copy of the real ledger, 2026-09-28: dropping Wells Fargo's
 * +$25.00 opening deposit moved the account $2,396.67 → $2,371.67, and net worth with it.
 */

let dir: string;
let bundle: DbBundle;

const PREFIX = "lines-left-out-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "4501" };
const OPENING = { postedOn: "2026-06-01", amountCents: 2500, rawDescription: "WFB OPENING DEPOSIT FROM CARD" };
const COFFEE = { postedOn: "2026-06-03", amountCents: -1000, rawDescription: "COFFEE ROASTERS 12" };
const GROCER = { postedOn: "2026-06-12", amountCents: -2500, rawDescription: "CORNER GROCER" };

/** June's statement: it prints the export's three lines, and balances that close across them */
const JUNE = { start: "2026-06-01", end: "2026-06-30", beginCents: 10_000, endCents: 9_000 };

const SECTIONS: Record<string, ParsedStatement[]> = {
  export: [{ accountHint: CHECKING, txns: [OPENING, COFFEE, GROCER] }],
  statement: [{ accountHint: CHECKING, txns: [OPENING, COFFEE, GROCER], period: JUNE }],
  // another export of the account, of a later month
  other: [{ accountHint: CHECKING, txns: [{ postedOn: "2026-07-02", amountCents: -700, rawDescription: "LATE NIGHT TACOS" }] }],
};

/** what version 2 reads of a file, by its text — every section when absent */
let atVersion2: Record<string, ParsedStatement[]> = {};
/** version 2 of the export: the same lines less the opening deposit */
const DROPS_OPENING = { export: [{ accountHint: CHECKING, txns: [COFFEE, GROCER] }] };

const profile: ParserProfile = {
  id: "test-lines-left-out",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => {
    const text = f.text.trim();
    return profile.version === 2 && text in atVersion2 ? atVersion2[text]! : SECTIONS[text]!;
  },
};

const file = (name: string, text: string): ImportInput => ({ name: `${PREFIX}${name}.csv`, buffer: Buffer.from(text) });
const EXPORT = file("export", "export");
/** the export downloaded again: the same lines in different bytes — and a third time */
const EXPORT_AGAIN = file("export (1)", "export\n");
const EXPORT_THIRD = file("export (2)", "export\n\n");
const STATEMENT = file("statement-2026-06", "statement");
const OTHER = file("export-july", "other");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-lines-left-out-"));
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
const account = () => bundle.db.select().from(accounts).where(eq(accounts.last4, CHECKING.last4!)).get()!;
const live = () =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, account().id), ne(transactions.status, "superseded")))
    .orderBy(transactions.postedOn)
    .all();
/** the money the ledger records on the account — an export prints no balance to anchor one */
const money = () => live().reduce((n, r) => n + r.amountCents, 0);

/** The export and its re-download, both imported: the re-download's lines are the export's rows. */
async function exportAndRedownload(): Promise<void> {
  await importStatementFiles(bundle.db, [EXPORT]);
  await importStatementFiles(bundle.db, [EXPORT_AGAIN]);
  expect(live().map((r) => [r.postedOn, r.importFileId])).toEqual([
    [OPENING.postedOn, fileId(EXPORT)],
    [COFFEE.postedOn, fileId(EXPORT)],
    [GROCER.postedOn, fileId(EXPORT)],
  ]);
}

describe("a re-read that drops a line a still-imported file prints", () => {
  test("leaves the row out, and the upload outcome names the line and the file that prints it", async () => {
    await exportAndRedownload();
    const before = money();

    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    // the owner's call: the row stays out — no money added on a guess
    expect(live().map((r) => r.postedOn)).toEqual([COFFEE.postedOn, GROCER.postedOn]);
    expect(money()).toBe(before - OPENING.amountCents);
    // …and it is counted, not silent
    expect(outcome).toMatchObject({ status: "parsed", inserted: 2, keptByPrinters: 0 });
    expect(outcome!.leftOut).toEqual([
      expect.objectContaining({
        accountId: account().id,
        accountName: account().name,
        printedOn: OPENING.postedOn,
        amountCents: OPENING.amountCents,
        description: "WFB OPENING DEPOSIT FROM CARD",
        printedBy: [EXPORT_AGAIN.name],
        readBy: EXPORT.name,
      }),
    ]);
    expect(outcome!.leftOut[0]!.notice).toContain("+$25.00");
    expect(outcome!.leftOut[0]!.notice).toContain(EXPORT_AGAIN.name);
  });

  test("the ledger reads the same line left out — the rule `pnpm ledger-check` and /imports read", async () => {
    await exportAndRedownload();

    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    await importStatementFiles(bundle.db, [EXPORT]);

    const found = linesLeftOut(bundle.db);
    expect(found).toEqual([
      expect.objectContaining({
        accountId: account().id,
        printedOn: OPENING.postedOn,
        amountCents: OPENING.amountCents,
        printedBy: [EXPORT_AGAIN.name],
        printerFileIds: [fileId(EXPORT_AGAIN)],
        readBy: EXPORT.name,
        readById: fileId(EXPORT),
      }),
    ]);
    // the row it names is the retired read's, still superseded
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, found[0]!.rowId)).get()).toMatchObject({
      status: "superseded",
      amountCents: OPENING.amountCents,
    });
  });

  test("the re-download read again at the same version prints the line no more, and nothing is left out", async () => {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    await importStatementFiles(bundle.db, [EXPORT]);
    expect(linesLeftOut(bundle.db)).toHaveLength(1);

    const [outcome] = await importStatementFiles(bundle.db, [EXPORT_AGAIN]);

    expect(outcome!.leftOut).toEqual([]);
    expect(linesLeftOut(bundle.db)).toEqual([]);
  });

  test("another file read again later does not name it: its outcome is what its own retirement left out", async () => {
    await exportAndRedownload();
    await importStatementFiles(bundle.db, [OTHER]);
    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    await importStatementFiles(bundle.db, [EXPORT]);

    const [outcome] = await importStatementFiles(bundle.db, [OTHER]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 1 });
    expect(outcome!.leftOut).toEqual([]);
    expect(linesLeftOut(bundle.db)).toEqual([expect.objectContaining({ printedOn: OPENING.postedOn, readBy: EXPORT.name })]);
  });

  test("one charge two re-downloads print is one line left out, naming both", async () => {
    await exportAndRedownload();
    await importStatementFiles(bundle.db, [EXPORT_THIRD]);

    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(outcome!.leftOut).toEqual([
      expect.objectContaining({ printedOn: OPENING.postedOn, printedBy: [EXPORT_AGAIN.name, EXPORT_THIRD.name] }),
    ]);
    expect(outcome!.leftOut[0]!.notice).toContain(`${EXPORT_AGAIN.name}, ${EXPORT_THIRD.name} still print it;`);
  });

  /**
   * Only a new DAY pairs a line with the row it replaced (`writtenAgain`): at other money the two files disagree about
   * the charge, the ledger holds the new read's, and the money the re-download prints is in no row.
   */
  test("a version that reads a line at other money: the money the re-download prints is named", async () => {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = { export: [{ accountHint: CHECKING, txns: [OPENING, { ...COFFEE, amountCents: -1001 }, GROCER] }] };

    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(live().map((r) => r.amountCents)).toEqual([OPENING.amountCents, -1001, GROCER.amountCents]);
    expect(outcome!.leftOut).toEqual([
      expect.objectContaining({ printedOn: COFFEE.postedOn, amountCents: COFFEE.amountCents, printedBy: [EXPORT_AGAIN.name] }),
    ]);
  });

  /**
   * A statement's month still read opens a gap for the line it drops (`settleHeldRows`) — and the line the export still
   * prints is named as well: the gap says the month is short, not which money.
   */
  test("a statement read again that drops a line of a month it still reads: a gap, and the line named", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    await importStatementFiles(bundle.db, [EXPORT]);

    profile.version = 2;
    atVersion2 = { statement: [{ accountHint: CHECKING, txns: [COFFEE, GROCER], period: JUNE }] };
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    const june = bundle.db.select().from(statementPeriods).where(eq(statementPeriods.accountId, account().id)).get();
    expect(june).toMatchObject({ reconciliation: "gap", gapCents: OPENING.amountCents });
    expect(outcome!.leftOut).toEqual([
      expect.objectContaining({ printedOn: OPENING.postedOn, printedBy: [EXPORT.name], readBy: STATEMENT.name }),
    ]);
  });
});

describe("nothing is left out where no money left", () => {
  /**
   * His duplicate verdict says another row records that money: a retired copy is no line missing (`takenOverLines`
   * reads the same verdict the same way).
   */
  test("a retired row he confirmed as a duplicate's copy", async () => {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    await importStatementFiles(bundle.db, [EXPORT]);
    const [left] = linesLeftOut(bundle.db);
    const survivor = live()[0]!;

    bundle.db
      .insert(duplicateCandidates)
      .values({
        accountId: account().id,
        transactionIdA: survivor.id,
        transactionIdB: left!.rowId,
        pairKey: "lines-left-out-verdict",
        reason: "cross_source_same_day",
        reasonDetail: "the owner's verdict",
        resolution: "confirmed_duplicate",
        retiredTransactionId: left!.rowId,
        retiredFromStatus: "active",
      })
      .run();

    expect(linesLeftOut(bundle.db)).toEqual([]);
  });

  test("before any re-read", async () => {
    await exportAndRedownload();
    expect(linesLeftOut(bundle.db)).toEqual([]);
  });

  test("a version that reads every line again", async () => {
    await exportAndRedownload();
    profile.version = 2;
    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);
    expect(outcome!.leftOut).toEqual([]);
    expect(linesLeftOut(bundle.db)).toEqual([]);
  });

  /**
   * A version that dates a line differently writes it again, and records it once, though the re-download prints the
   * old day (`settleHeldRows`): the money is in the ledger, on the day the new read prints.
   */
  test("a version that dates a line a day later", async () => {
    await exportAndRedownload();
    const before = money();
    profile.version = 2;
    atVersion2 = { export: [{ accountHint: CHECKING, txns: [OPENING, { ...COFFEE, postedOn: "2026-06-04" }, GROCER] }] };

    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(money()).toBe(before);
    expect(outcome!.leftOut).toEqual([]);
    expect(linesLeftOut(bundle.db)).toEqual([]);
  });

  test("a line no other imported file prints: the new version's reading stands", async () => {
    await importStatementFiles(bundle.db, [EXPORT]);
    profile.version = 2;
    atVersion2 = DROPS_OPENING;

    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(live()).toHaveLength(2);
    expect(outcome!.leftOut).toEqual([]);
    expect(linesLeftOut(bundle.db)).toEqual([]);
  });
});
