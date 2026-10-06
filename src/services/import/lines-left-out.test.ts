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
import { lineLeftOutNotice } from "@/lib/import-file-label";
import { acknowledgementWrites, leftOutToken, planAcknowledging } from "@/lib/left-out-acknowledgement";
import { readLeftOutAcknowledgements, writeLeftOutAcknowledgements } from "@/services/left-out-acknowledgements";
import { acknowledgementsMatchingNothing, linesLeftOut } from "./lines-left-out";
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

/** a week's pay: one amount, the same words, every week */
const pay = (postedOn: string) => ({ postedOn, amountCents: 114_192, rawDescription: "IT AMERICA LLC PAYROLL" });

/** June's statement: it prints the export's three lines, and balances that close across them */
const JUNE = { start: "2026-06-01", end: "2026-06-30", beginCents: 10_000, endCents: 9_000 };

const SECTIONS: Record<string, ParsedStatement[]> = {
  export: [{ accountHint: CHECKING, txns: [OPENING, COFFEE, GROCER] }],
  statement: [{ accountHint: CHECKING, txns: [OPENING, COFFEE, GROCER], period: JUNE }],
  // another export of the account, of a later month
  other: [{ accountHint: CHECKING, txns: [{ postedOn: "2026-07-02", amountCents: -700, rawDescription: "LATE NIGHT TACOS" }] }],
  // an export of the account ending sooner than `export`, which prints its lines again
  earlier: [{ accountHint: CHECKING, txns: [OPENING, COFFEE] }],
  // an export printing one deposit twice: two lines alike
  twins: [{ accountHint: CHECKING, txns: [OPENING, OPENING, COFFEE] }],
  // three weeks of pay
  payroll: [{ accountHint: CHECKING, txns: [pay("2026-06-05"), pay("2026-06-12"), pay("2026-06-19")] }],
};

/** what version 2 reads of a file, by its text — every section when absent */
let atVersion2: Record<string, ParsedStatement[]> = {};
/** …and version 3 — version 2's reading when absent */
let atVersion3: Record<string, ParsedStatement[]> = {};
/** version 2 of the export: the same lines less the opening deposit */
const DROPS_OPENING = { export: [{ accountHint: CHECKING, txns: [COFFEE, GROCER] }] };

const profile: ParserProfile = {
  id: "test-lines-left-out",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => {
    const text = f.text.trim();
    if (profile.version === 3 && text in atVersion3) return atVersion3[text]!;
    return profile.version >= 2 && text in atVersion2 ? atVersion2[text]! : SECTIONS[text]!;
  },
};

const file = (name: string, text: string): ImportInput => ({ name: `${PREFIX}${name}.csv`, buffer: Buffer.from(text) });
const EXPORT = file("export", "export");
/** the export downloaded again: the same lines in different bytes — and a third time */
const EXPORT_AGAIN = file("export (1)", "export\n");
const EXPORT_THIRD = file("export (2)", "export\n\n");
const STATEMENT = file("statement-2026-06", "statement");
const OTHER = file("export-july", "other");
/** two exports of the account that overlap, named as Chase names them: the older one sorts first */
const EXPORT_AUGUST = file("Chase4501_Activity_20260812", "earlier");
const EXPORT_SEPTEMBER = file("Chase4501_Activity_20260901", "export");
const TWINS = file("twins", "twins");
const TWINS_AGAIN = file("twins (1)", "twins\n");
const PAYROLL = file("payroll", "payroll");
const PAYROLL_AGAIN = file("payroll (1)", "payroll\n");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-lines-left-out-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  atVersion2 = {};
  atVersion3 = {};
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

  test("the file read again at a version that still leaves the line out: named by the read that left it out, not again", async () => {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    const [second] = await importStatementFiles(bundle.db, [EXPORT]);
    expect(second!.leftOut).toHaveLength(1);

    profile.version = 3;
    const [third] = await importStatementFiles(bundle.db, [EXPORT]);

    // its retirement took no row the deposit had: version 2's read had none
    expect(third!.leftOut).toEqual([]);
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
   * Every read of the export retires the one before it, so the ledger holds a retired row of the deposit for each
   * version that read it. 🔴 Two re-downloads read at versions that word it differently each took the row in their own
   * words: the review of uc/loud-dropped-line, 2026-09-28, measured one $25.00 charge named twice by ledger-check and
   * under the read on /imports, and once by the upload.
   */
  test("one charge two re-downloads print in two versions' words is one line left out, as the upload names it", async () => {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = { export: [{ accountHint: CHECKING, txns: [{ ...OPENING, rawDescription: "OPENING DEPOSIT" }, COFFEE, GROCER] }] };
    await importStatementFiles(bundle.db, [EXPORT]);
    await importStatementFiles(bundle.db, [EXPORT_THIRD]);
    const before = money();

    profile.version = 3;
    atVersion3 = DROPS_OPENING;
    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(money()).toBe(before - OPENING.amountCents);
    const found = linesLeftOut(bundle.db);
    expect(found).toEqual([
      expect.objectContaining({ printedOn: OPENING.postedOn, printedBy: [EXPORT_AGAIN.name, EXPORT_THIRD.name], readBy: EXPORT.name }),
    ]);
    expect(found.map(lineLeftOutNotice)).toEqual(outcome!.leftOut.map((l) => l.notice));
  });

  /**
   * A version between them re-dated the deposit, and the re-download still prints the first version's day: the row of it
   * the version between wrote is the charge, and the first version's row is how the re-download's line finds it.
   */
  test("a line a version re-dated and a later version dropped: named for the re-download that prints the first day", async () => {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = { export: [{ accountHint: CHECKING, txns: [{ ...OPENING, postedOn: "2026-06-02" }, COFFEE, GROCER] }] };
    await importStatementFiles(bundle.db, [EXPORT]);
    expect(linesLeftOut(bundle.db)).toEqual([]);
    const before = money();

    profile.version = 3;
    atVersion3 = DROPS_OPENING;
    const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

    expect(money()).toBe(before - OPENING.amountCents);
    const found = linesLeftOut(bundle.db);
    expect(found).toEqual([expect.objectContaining({ printedOn: OPENING.postedOn, printedBy: [EXPORT_AGAIN.name], readBy: EXPORT.name })]);
    expect(found.map(lineLeftOutNotice)).toEqual(outcome!.leftOut.map((l) => l.notice));
  });

  /**
   * Only a new DAY pairs a line with the row it replaced (`rowsWrittenAgain`): at other money the two files disagree about
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

  /**
   * An upload reads its files one turn at a time, and a later turn can read again the very file an earlier turn's
   * outcome says still prints the line. 🔴 Each outcome was read at the end of its own turn: the review of
   * uc/loud-dropped-line, 2026-09-28, measured the August export's outcome naming the +$25.00 as printed by the September
   * export, while the same upload's read of September dropped it too and the ledger named nothing.
   */
  test("an upload that reads again the file an earlier outcome says still prints the line: the outcome is the ledger's", async () => {
    await importStatementFiles(bundle.db, [EXPORT_AUGUST]);
    await importStatementFiles(bundle.db, [EXPORT_SEPTEMBER]);
    profile.version = 2;
    atVersion2 = { ...DROPS_OPENING, earlier: [{ accountHint: CHECKING, txns: [COFFEE] }] };

    const outcomes = await importStatementFiles(bundle.db, [EXPORT_SEPTEMBER, EXPORT_AUGUST]);

    expect(outcomes.map((o) => [o.fileName, o.status])).toEqual([
      [EXPORT_AUGUST.name, "parsed"],
      [EXPORT_SEPTEMBER.name, "parsed"],
    ]);
    // no imported file prints the deposit now: nothing is left out, and no outcome says otherwise
    expect(linesLeftOut(bundle.db)).toEqual([]);
    expect(outcomes.flatMap((o) => o.leftOut)).toEqual([]);
  });
});

/**
 * A version that DATES a line differently writes it again (`settleHeldRows`), so the retired row of it is no money
 * missing — only a line of the same money, moved by days, stands in for it. 🔴 Any row of the same money did, whatever
 * its day: the review of uc/loud-dropped-line, 2026-09-28, measured a version that moved each week of pay a day later
 * and dropped the 06-12 week name 06-19 as the week left out, and a version that dropped a week and read one the first
 * version missed name nothing — the money gone from the ledger, and no surface saying so.
 */
describe("a version that dates a line differently and drops one of the same money", () => {
  async function payrollAndRedownload(): Promise<void> {
    await importStatementFiles(bundle.db, [PAYROLL]);
    await importStatementFiles(bundle.db, [PAYROLL_AGAIN]);
  }

  test("each week moved a day later and one dropped: the week it dropped is named", async () => {
    await payrollAndRedownload();
    const before = money();
    profile.version = 2;
    atVersion2 = { payroll: [{ accountHint: CHECKING, txns: [pay("2026-06-06"), pay("2026-06-20")] }] };

    const [outcome] = await importStatementFiles(bundle.db, [PAYROLL]);

    expect(live().map((r) => r.postedOn)).toEqual(["2026-06-06", "2026-06-20"]);
    expect(money()).toBe(before - 114_192);
    expect(outcome!.leftOut.map((l) => [l.printedOn, l.printedBy])).toEqual([["2026-06-12", [PAYROLL_AGAIN.name]]]);
    expect(linesLeftOut(bundle.db).map((l) => l.printedOn)).toEqual(["2026-06-12"]);
  });

  test("each week moved a day earlier and one dropped: the week it dropped is named, not the one read before it", async () => {
    await payrollAndRedownload();
    profile.version = 2;
    atVersion2 = { payroll: [{ accountHint: CHECKING, txns: [pay("2026-06-04"), pay("2026-06-18")] }] };

    const [outcome] = await importStatementFiles(bundle.db, [PAYROLL]);

    // 06-18 is a day from 06-19 and six from 06-12: the nearer week is the one it re-dates
    expect(outcome!.leftOut.map((l) => l.printedOn)).toEqual(["2026-06-12"]);
    expect(linesLeftOut(bundle.db).map((l) => l.printedOn)).toEqual(["2026-06-12"]);
  });

  test("a week dropped and the next one read for the first time: the week dropped is named", async () => {
    await payrollAndRedownload();
    profile.version = 2;
    atVersion2 = { payroll: [{ accountHint: CHECKING, txns: [pay("2026-06-05"), pay("2026-06-12"), pay("2026-06-26")] }] };

    const [outcome] = await importStatementFiles(bundle.db, [PAYROLL]);

    expect(live().map((r) => r.postedOn)).toEqual(["2026-06-05", "2026-06-12", "2026-06-26"]);
    expect(outcome!.leftOut.map((l) => l.printedOn)).toEqual(["2026-06-19"]);
    expect(linesLeftOut(bundle.db).map((l) => l.printedOn)).toEqual(["2026-06-19"]);
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

  test("a version that dates every week of the pay two days later", async () => {
    await importStatementFiles(bundle.db, [PAYROLL]);
    await importStatementFiles(bundle.db, [PAYROLL_AGAIN]);
    const before = money();
    profile.version = 2;
    atVersion2 = { payroll: [{ accountHint: CHECKING, txns: [pay("2026-06-07"), pay("2026-06-14"), pay("2026-06-21")] }] };

    const [outcome] = await importStatementFiles(bundle.db, [PAYROLL]);

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

/**
 * ⚖️ Owner, 2026-10-02 (§6A 30): once a session has read a line left out on the statement, it may record it
 * ACKNOWLEDGED — the guarded `pnpm ledger-check --acknowledge-left-out=<mark> --reason='<what it read>' [--confirm]`,
 * kept in the ledger like the witness marks. Every reader still names the line, says on what day it was acknowledged
 * and what the session read, and ledger-check stops failing on it; a line nobody acknowledged still fails.
 */
describe("a line left out, acknowledged", () => {
  const ON = "2026-10-05";
  const READ = { on: ON, reason: "Wells Fargo export, 07-27: the opening deposit, reversed by the card the same day" };

  /** what a session does once it has read each line on its statement: the dry run's plan, confirmed */
  function acknowledgeAll(): void {
    const lines = linesLeftOut(bundle.db);
    const plan = planAcknowledging(lines, lines.map(leftOutToken), READ);
    expect(plan.unmatched).toEqual([]);
    writeLeftOutAcknowledgements(bundle.db, acknowledgementWrites(plan.open, READ));
  }

  async function droppedOpening(): Promise<void> {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = DROPS_OPENING;
    await importStatementFiles(bundle.db, [EXPORT]);
  }

  test("is named still, and says on what day and what was read — by the whole ledger's reading and the re-read's own", async () => {
    await droppedOpening();
    const [left] = linesLeftOut(bundle.db);
    expect(left!.acknowledged).toBeNull();

    acknowledgeAll();

    const found = linesLeftOut(bundle.db);
    expect(found).toEqual([expect.objectContaining({ printedOn: OPENING.postedOn, rowId: left!.rowId, acknowledged: READ })]);
    expect(lineLeftOutNotice(found[0]!).endsWith(` Acknowledged on ${ON}: ${READ.reason}`)).toBe(true);
    // the question the upload outcome asks of the read its re-read retired: the same line, the same acknowledgement
    const retiredRead = bundle.db.select().from(transactions).where(eq(transactions.id, left!.rowId)).get()!.importFileId!;
    expect(linesLeftOut(bundle.db, [retiredRead])).toEqual(found);
    expect(acknowledgementsMatchingNothing(bundle.db, found)).toEqual([]);
  });

  test("kept in the ledger, keyed by what the line is — its account, day, money, words and the printing file's bytes", async () => {
    await droppedOpening();
    acknowledgeAll();
    const sha = bundle.db.select().from(importFiles).where(eq(importFiles.id, fileId(EXPORT_AGAIN))).get()!.fileSha256;
    expect(readLeftOutAcknowledgements(bundle.db)).toEqual([
      expect.objectContaining({
        accountId: account().id,
        printedOn: OPENING.postedOn,
        amountCents: OPENING.amountCents,
        printedWords: "WFB OPENING DEPOSIT FROM CARD",
        printerSha256: sha,
        acknowledgedOn: ON,
        reason: READ.reason,
      }),
    ]);
  });

  test("the file read again at a version that still leaves it out: still acknowledged", async () => {
    await droppedOpening();
    acknowledgeAll();

    profile.version = 3;
    await importStatementFiles(bundle.db, [EXPORT]);

    expect(linesLeftOut(bundle.db)).toEqual([expect.objectContaining({ printedOn: OPENING.postedOn, acknowledged: READ })]);
  });

  /**
   * 🔴 The leaving it acknowledged ended — a version wrote the deposit again — and a later version dropped it again:
   * the same day, money, words and printing file. Keyed by those alone, the old acknowledgement would hide a regression
   * nobody read on the statement.
   */
  test("⛔ written again and then left out again: a new leaving, unacknowledged — the old acknowledgement hides nothing", async () => {
    await droppedOpening();
    acknowledgeAll();

    profile.version = 3;
    atVersion3 = { export: SECTIONS.export! };
    await importStatementFiles(bundle.db, [EXPORT]);
    expect(linesLeftOut(bundle.db)).toEqual([]);
    expect(acknowledgementsMatchingNothing(bundle.db, [])).toEqual([expect.objectContaining({ printedOn: OPENING.postedOn })]);

    profile.version = 4;
    await importStatementFiles(bundle.db, [EXPORT]);

    const found = linesLeftOut(bundle.db);
    expect(found).toEqual([expect.objectContaining({ printedOn: OPENING.postedOn, acknowledged: null })]);
    expect(acknowledgementsMatchingNothing(bundle.db, found)).toHaveLength(1);
  });

  test("⛔ a second line alike left out later is not hidden by the first one's acknowledgement", async () => {
    await importStatementFiles(bundle.db, [TWINS]);
    await importStatementFiles(bundle.db, [TWINS_AGAIN]);
    profile.version = 2;
    atVersion2 = { twins: [{ accountHint: CHECKING, txns: [OPENING, COFFEE] }] };
    await importStatementFiles(bundle.db, [TWINS]);
    expect(linesLeftOut(bundle.db)).toHaveLength(1);
    acknowledgeAll();

    profile.version = 3;
    atVersion3 = { twins: [{ accountHint: CHECKING, txns: [COFFEE] }] };
    const [outcome] = await importStatementFiles(bundle.db, [TWINS]);

    const found = linesLeftOut(bundle.db);
    expect(found.map((l) => [l.printedOn, l.amountCents])).toEqual([
      [OPENING.postedOn, OPENING.amountCents],
      [OPENING.postedOn, OPENING.amountCents],
    ]);
    expect(found.map((l) => l.acknowledged?.on ?? "none").sort()).toEqual([ON, "none"]);
    // the upload's outcome names only the line its own retirement left out — the one nobody acknowledged — and says so,
    // as the whole ledger does: matched within its share alone, it took the first line's acknowledgement
    expect(outcome!.leftOut).toEqual([expect.objectContaining({ printedOn: OPENING.postedOn, acknowledged: null })]);
    expect(outcome!.leftOut[0]!.notice).not.toContain("Acknowledged");
  });

  test("a line acknowledged and a line not: only the one acknowledged says so", async () => {
    await exportAndRedownload();
    profile.version = 2;
    atVersion2 = { export: [{ accountHint: CHECKING, txns: [COFFEE] }] };
    await importStatementFiles(bundle.db, [EXPORT]);
    const [opening] = linesLeftOut(bundle.db).filter((l) => l.printedOn === OPENING.postedOn);

    const plan = planAcknowledging(linesLeftOut(bundle.db), [leftOutToken(opening!)], READ);
    writeLeftOutAcknowledgements(bundle.db, acknowledgementWrites(plan.open, READ));

    expect(linesLeftOut(bundle.db).map((l) => [l.printedOn, l.acknowledged])).toEqual([
      [OPENING.postedOn, READ],
      [GROCER.postedOn, null],
    ]);
  });
});
