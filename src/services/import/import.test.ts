import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "@/services/accounts";
import { recurringSeries } from "@/db/schema/recurring";
import { statementCopies, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { unimportedRowAttributes } from "@/db/schema/unimported-row-attributes";
import { unimportedTransferLegs } from "@/db/schema/unimported-transfer-legs";
import { latestBalances, netWorthSeries, rebuildAccount } from "@/services/derivation";
import { listSplits, setSplits } from "@/services/transaction-splits";
import { asParsedFile, fidelityOf, importStatementFiles, migrateStorageLayout, unimportFile, acceptGap, parseContextFor, reconcileAccounts, resolveAccount, type ImportInput } from "./service";
import { merchants } from "@/db/schema/merchants";
import { PROFILES } from "./profiles";
import { parseChaseCardLines } from "./profiles/chase-card-statement-profile";
import { ParseError, type AccountHint, type CanonicalTxn, type ParsedFile, type ParsedStatement, type ParserProfile } from "./types";
import { provenanceFor } from "@/services/provenance";
import { importFiles as importFilesTable } from "@/db/schema/imports";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { attachTransactions } from "@/services/recurring-links";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");

interface Manifest {
  endBalances: Record<string, number>;
  txnCounts: Record<string, number>;
  corruptedGapCents: number;
  robinhoodLastStatementValueCents: number;
}

let manifest: Manifest;

beforeAll(() => {
  const manifestPath = path.join(FIXTURES, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Synthetic fixtures missing — run `pnpm fixtures` first");
  }
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
});

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-import-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

function load(...relative: string[]): ImportInput {
  const p = path.join(FIXTURES, ...relative);
  return { name: path.basename(p), buffer: fs.readFileSync(p) };
}

function loadDir(...relative: string[]): ImportInput[] {
  const dirPath = path.join(FIXTURES, ...relative);
  return fs
    .readdirSync(dirPath)
    .filter((f) => !f.startsWith("."))
    .filter((f) => fs.statSync(path.join(dirPath, f)).isFile())
    .map((f) => ({ name: f, buffer: fs.readFileSync(path.join(dirPath, f)) }));
}

/**
 * Pre-mutation snapshots land beside the database they protect. `.db` only —
 * reading a snapshot back leaves -wal/-shm siblings behind.
 */
function preMutationSnapshots(): string[] {
  const backups = path.join(dir, "backups");
  if (!fs.existsSync(backups)) return [];
  return fs.readdirSync(backups).filter((f) => f.startsWith("pre-") && f.endsWith(".db"));
}

function activeTxnStats(accountName: string): { count: number; sumCents: number } {
  const account = bundle.db.select().from(accounts).all().find((a) => a.name.includes(accountName));
  if (!account) return { count: 0, sumCents: 0 };
  const rows = bundle.db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.accountId, account.id), eq(transactions.status, "active")))
    .all();
  return { count: rows.length, sumCents: rows.reduce((s, r) => s + r.amountCents, 0) };
}

describe("structured imports", () => {
  test("a Chase QFX chunk imports, reconciles its running ledger, and creates the account", async () => {
    const [outcome] = await importStatementFiles(bundle.db, [
      load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX"),
    ]);
    expect(outcome!.status).toBe("parsed");
    expect(outcome!.inserted).toBeGreaterThan(30);
    const account = bundle.db.select().from(accounts).all().find((a) => a.last4 === "4321");
    expect(account?.type).toBe("checking");
  });

  test("file-level idempotency: byte-identical re-import is a skipped duplicate", async () => {
    const file = load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX");
    await importStatementFiles(bundle.db, [file]);
    const before = activeTxnStats("4321");
    const [second] = await importStatementFiles(bundle.db, [file]);
    expect(second!.status).toBe("skipped_duplicate");
    expect(activeTxnStats("4321")).toEqual(before);
  });

  test("ownership: a CSV overlapping a QFX-owned range contributes zero transactions", async () => {
    await importStatementFiles(bundle.db, [load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX")]);
    const before = activeTxnStats("4321");
    const [csv] = await importStatementFiles(bundle.db, [
      load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.CSV"),
    ]);
    expect(csv!.status).toBe("parsed");
    expect(csv!.inserted).toBe(0);
    expect(activeTxnStats("4321")).toEqual(before);
  });

  test("import-order independence: CSV-then-QFX converges to the QFX-owned state", async () => {
    // order A: QFX only
    await importStatementFiles(bundle.db, [load("chase", "Chase1111_Activity_2024-07-01_2024-09-30.QFX")]);
    const stateA = activeTxnStats("1111");

    // order B on a fresh DB: CSV first, then QFX takes over
    bundle.sqlite.close();
    bundle = createDatabase(path.join(dir, "t2.db"));
    seedDatabase(bundle.db);
    await importStatementFiles(bundle.db, [load("chase", "Chase1111_Activity_2024-07-01_2024-09-30.CSV")]);
    const [takeover] = await importStatementFiles(bundle.db, [
      load("chase", "Chase1111_Activity_2024-07-01_2024-09-30.QFX"),
    ]);
    expect(takeover!.supersededTakeover).toBeGreaterThan(0);
    const stateB = activeTxnStats("1111");
    expect(stateB).toEqual(stateA);
  });

  /**
   * ⚠️ The one thing two read orders do NOT agree about, pinned so it cannot widen unnoticed.
   *
   * Two sources of ONE charge that date it differently — a Chase card statement, which prints the day the charge was
   * MADE and posts the row on it, beside the Spending Report, which prints both and posts one to three days later.
   * Same format and same profile, so neither owns the other's days (`fidelityOf`) and neither takes over: the row that
   * records the money is whichever file was read first, and the day the ledger says the money left the card is that
   * file's. Measured on a copy of the real ledger, 2026-09-22 (scripts/probe-identity-transaction-day.ts --mode=orders):
   * 14 Chase Sapphire charges and 4 daily balances, the largest 2026-07-05 at +$65.90 read report-first against
   * −$8.52 read statement-first.
   *
   * What holds in either order — the money — is asserted first, and is what docs/schema.md now calls equivalent.
   * Making the posted day agree too is an OWNER decision, not a tidy-up, and the reason is in this file's own
   * machinery: `reconcileAccounts` counts a period's rows by `posted_on`, so moving a charge onto the later day its
   * better-dated source gives it can move it OUT of a period that reconciles today (89 live rows sit within three days
   * of a reconciled period's end carrying posted == transacted). Guarding the move at the period edge would put the
   * order-dependence back for exactly those rows. See docs/schema.md, "the day a charge posts".
   */
  test("two sources that date ONE charge differently: same money in either order, the posted day of the first read", async () => {
    const CARD = "8888";
    const HEADER = "Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo";
    // the shape of a Chase card statement: it prints the day the charge was MADE and posts the row on it
    const collapsed: ImportInput = {
      name: "Chase8888_Activity_collapsed.CSV",
      buffer: Buffer.from([HEADER, `${CARD},06/10/2026,06/10/2026,LA BOMBONIERA NEW YORK,Food & Drink,Sale,-15.24,`].join("\n")),
    };
    // …and of the Spending Report beside it: the same charge, made that day and POSTED two days later
    const dated: ImportInput = {
      name: "Chase8888_Activity_dated.CSV",
      buffer: Buffer.from([HEADER, `${CARD},06/10/2026,06/12/2026,LA BOMBONIERA,Food & Drink,Sale,-15.24,`].join("\n")),
    };

    let nth = 0;
    const readInOrder = async (files: readonly ImportInput[]): Promise<{ postedOn: string; transactedOn: string | null; amountCents: number }[]> => {
      nth += 1;
      bundle.sqlite.close();
      process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, `originals-${nth}`);
      bundle = createDatabase(path.join(dir, `order-${nth}.db`));
      seedDatabase(bundle.db);
      for (const file of files) await importStatementFiles(bundle.db, [file]);
      const account = bundle.db.select().from(accounts).all().find((a) => a.last4 === CARD)!;
      return bundle.db
        .select({ postedOn: transactions.postedOn, transactedOn: transactions.transactedOn, amountCents: transactions.amountCents })
        .from(transactions)
        .where(and(eq(transactions.accountId, account.id), ne(transactions.status, "superseded")))
        .all();
    };

    const collapsedFirst = await readInOrder([collapsed, dated]);
    const datedFirst = await readInOrder([dated, collapsed]);

    // the money is one charge either way — neither read counts it twice, and both agree about the day it was MADE
    expect(collapsedFirst).toHaveLength(1);
    expect(datedFirst).toHaveLength(1);
    expect(collapsedFirst[0]!.amountCents).toBe(-1524);
    expect(datedFirst[0]!.amountCents).toBe(-1524);
    expect(collapsedFirst[0]!.transactedOn).toBe("2026-06-10");
    expect(datedFirst[0]!.transactedOn).toBe("2026-06-10");
    // …and the day it POSTED is the one the first file read gave it — the known limit above, not a rule worth having
    expect(collapsedFirst[0]!.postedOn).toBe("2026-06-10");
    expect(datedFirst[0]!.postedOn).toBe("2026-06-12");
  });

  test("takeover picks the description-matching victim among same-day equal amounts", async () => {
    // lower-fidelity CSV: two identical-amount charges on the same day
    const csv = [
      "Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
      '9999,06/10/2026,06/10/2026,SHELL OIL 111 QUEENS NY,Gas,Sale,-50.00,',
      '9999,06/10/2026,06/10/2026,STARBUCKS STORE 22 NEW YORK NY,Food & Drink,Sale,-50.00,',
    ].join("\n");
    await importStatementFiles(bundle.db, [{ name: "Chase9999_Activity_x.CSV", buffer: Buffer.from(csv) }]);

    // higher-fidelity QFX carries ONLY the Starbucks row
    const qfx = `OFXHEADER:100

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0
<SEVERITY>INFO
</STATUS>
<FI><ORG>B1
</FI>
<INTU.BID>10898
</SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>00009999
</CCACCTFROM>
<BANKTRANLIST>
<DTSTART>20260610
<DTEND>20260610
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260610
<TRNAMT>-50.00
<FITID>1
<NAME>STARBUCKS STORE 22
<MEMO>STARBUCKS STORE 22 NEW YORK NY
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>100.00
<DTASOF>20260610
</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>
`;
    const [outcome] = await importStatementFiles(bundle.db, [
      { name: "Chase9999_Activity_x.QFX", buffer: Buffer.from(qfx) },
    ]);
    expect(outcome!.supersededTakeover).toBe(1);

    const account = bundle.db.select().from(accounts).all().find((a) => a.last4 === "9999")!;
    const rows = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .all();
    // the SHELL row must survive active — the takeover replaced STARBUCKS only
    const shell = rows.filter((r) => r.rawDescription.includes("SHELL"));
    const starbucks = rows.filter((r) => r.rawDescription.includes("STARBUCKS"));
    expect(shell).toHaveLength(1);
    expect(shell[0]!.status).toBe("active");
    expect(starbucks.map((r) => r.status).sort()).toEqual(["active", "superseded"]);
  });

  /**
   * ⛔ A line and a row that BOTH say which day the charge was made and disagree are two charges, not one
   * (`identityWeight`): every source that fills `transacted_on` fills it with the real transaction day. The takeover
   * asked only the posted day and then the words, so where a day prints two charges of one amount the words decided —
   * and two visits to one vending machine are worded by how each file spells the machine, not by which visit it was.
   *
   * 🔴 Chase Sapphire prints CPI*CANTEEN VENDING −$1.25 made 07-08 and −$1.25 made 07-09, both posted 07-09. The
   * activity file printing only the 07-09 charge took the 07-08 row, whose words its own read the closer, so the
   * charge the owner made on the 8th left the ledger and the 9th was recorded twice — for the same money, so the
   * period still reconciled and nothing said so.
   */
  test("the takeover retires the row made on the line's transaction day, not the other charge that posted with it", async () => {
    const HINT: AccountHint = { institution: "Chase", type: "checking", last4: "4207" };
    const VENDING = { amountCents: -125, postedOn: "2026-07-09" };
    const STATEMENT: ImportInput = { name: "takeover-transaction-day.csv", buffer: Buffer.from("statement") };
    const ACTIVITY: ImportInput = { name: "takeover-transaction-day.ofx", buffer: Buffer.from("<OFX> activity") };
    const vendingProfile: ParserProfile = {
      id: "test-takeover-transaction-day",
      version: 1,
      matches: (f) => f.name === STATEMENT.name || f.name === ACTIVITY.name,
      parse: (f) =>
        f.name === STATEMENT.name
          ? [
              {
                accountHint: HINT,
                // two visits to one machine, posted together; the statement spells the 9th's terminal the longer way
                txns: [
                  { ...VENDING, transactedOn: "2026-07-08", rawDescription: "CPI*CANTEEN VENDING" },
                  { ...VENDING, transactedOn: "2026-07-09", rawDescription: "CPI*CANTEEN VENDING SVC" },
                ],
              },
            ]
          : [
              {
                accountHint: HINT,
                // the activity file prints the 9th's charge, in its own words: closer to the 8th's line than to the 9th's
                txns: [{ ...VENDING, transactedOn: "2026-07-09", rawDescription: "CPI*CANTEEN VENDING MIAMI FL" }],
              },
            ],
    };
    PROFILES.unshift(vendingProfile);
    try {
      await importStatementFiles(bundle.db, [STATEMENT]);
      const [taken] = await importStatementFiles(bundle.db, [ACTIVITY]);
      expect(taken).toMatchObject({ status: "parsed", supersededTakeover: 1 });
    } finally {
      PROFILES.splice(PROFILES.indexOf(vendingProfile), 1);
    }

    const account = bundle.db.select().from(accounts).all().find((a) => a.last4 === "4207")!;
    const live = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, account.id), ne(transactions.status, "superseded")))
      .all();
    // both charges are still here, each on the day it was made — the activity file took over the 9th's row only
    expect(live.map((r) => r.transactedOn).sort()).toEqual(["2026-07-08", "2026-07-09"]);
    // …and the day still holds both: equal money is what hides a wrong victim, never what catches one
    expect(live.reduce((sum, r) => sum + r.amountCents, 0)).toBe(-250);
    const retired = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, account.id), eq(transactions.status, "superseded")))
      .all();
    expect(retired.map((r) => r.transactedOn)).toEqual(["2026-07-09"]);
  });

  test("an unrecognised file fails with a reason, and a scanned PDF says so specifically", async () => {
    // a real PDF header, but no extractable text and no known layout
    const scanned: ImportInput = { name: "scan.pdf", buffer: Buffer.from("%PDF-1.4\nnot really a pdf") };
    const unknown: ImportInput = { name: "mystery.csv", buffer: Buffer.from("Col A,Col B\n1,2") };
    await importStatementFiles(bundle.db, [scanned, unknown]);

    const rows = bundle.db.select().from(importFilesTable).all();
    const scannedRow = rows.find((r) => r.fileName === "scan.pdf")!;
    const unknownRow = rows.find((r) => r.fileName === "mystery.csv")!;
    expect(scannedRow.status).toBe("failed");
    expect(scannedRow.error).toMatch(/scanned or image-only PDF/);
    expect(unknownRow.status).toBe("failed");
    expect(unknownRow.error).toBe("No parser profile matched this file");
    // one bad file must never abort the batch
    expect(rows).toHaveLength(2);
  });

  test("a single-account file is archived under its per-account folder", async () => {
    await importStatementFiles(bundle.db, [load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX")]);
    const file = bundle.db.select().from(importFilesTable).all()[0]!;
    const rel = path.relative(path.join(dir, "originals"), file.storagePath);
    expect(rel.startsWith("chase-checking-4321" + path.sep)).toBe(true);
    expect(fs.existsSync(file.storagePath)).toBe(true);
  });

  test("a multi-account combined file is archived under the institution-combined bucket", async () => {
    const combined = loadDir("sofi", "statements").slice(0, 1);
    await importStatementFiles(bundle.db, combined);
    const file = bundle.db.select().from(importFilesTable).all().find((f) => f.format === "pdf")!;
    const rel = path.relative(path.join(dir, "originals"), file.storagePath);
    expect(rel.startsWith("sofi-combined" + path.sep)).toBe(true);
    expect(fs.existsSync(file.storagePath)).toBe(true);
  });

  test("migrateStorageLayout relocates a legacy flat archive into the per-account folder", async () => {
    await importStatementFiles(bundle.db, [load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX")]);
    const root = path.join(dir, "originals");
    // simulate a pre-migration flat archive: move the file to the root and point
    // the row at it (as legacy data/originals/<sha>-<name> rows do)
    const file = bundle.db.select().from(importFilesTable).all()[0]!;
    const legacyPath = path.join(root, path.basename(file.storagePath));
    fs.renameSync(file.storagePath, legacyPath);
    bundle.db
      .update(importFilesTable)
      .set({ storagePath: legacyPath })
      .where(eq(importFilesTable.id, file.id))
      .run();

    const migrations = migrateStorageLayout(bundle.db, { move: true });
    expect(migrations).toHaveLength(1);
    const after = bundle.db.select().from(importFilesTable).all()[0]!;
    expect(path.relative(root, after.storagePath).startsWith("chase-checking-4321" + path.sep)).toBe(true);
    expect(fs.existsSync(after.storagePath)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false); // physically moved

    // idempotent: a second run finds nothing to relocate
    expect(migrateStorageLayout(bundle.db, { move: true })).toHaveLength(0);
  });

  test("un-import removes a file's transactions and anchors atomically", async () => {
    await importStatementFiles(bundle.db, [load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX")]);
    expect(activeTxnStats("4321").count).toBeGreaterThan(0);
    const file = bundle.db.select().from(importFilesTable).all()[0]!;
    unimportFile(bundle.db, file.id);
    expect(activeTxnStats("4321").count).toBe(0);
    expect(bundle.db.select().from(importFilesTable).all()).toHaveLength(0);
  });

  /**
   * 🔴 Un-importing rebuilt only the accounts the file had ROWS on. A statement
   * that gave an account a period and a balance anchor and nothing else took
   * both away and never rebuilt the account, so daily_balances stayed
   * `anchored` on a day no anchor names and provenance kept saying "checked
   * through" it. Measured on a copy of the real ledger, 2026-09-15:
   * un-importing the August 2026 Robinhood brokerage PDF left Robinhood Agentic
   * anchored on 2026-08-31 with anchors only on Jun 30 and Jul 31.
   */
  test("un-import rebuilds an account the file gave only a period and an anchor", async () => {
    const next = load("chase", "Chase4321_Activity_2024-10-01_2024-12-31.QFX");
    const noRows: ImportInput = {
      name: next.name,
      buffer: Buffer.from(next.buffer.toString("utf8").replaceAll(/<STMTTRN>[\s\S]*?<\/STMTTRN>\s*/g, "")),
    };
    await importStatementFiles(bundle.db, [load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX")]);
    await importStatementFiles(bundle.db, [noRows]);
    const file = bundle.db.select().from(importFilesTable).all().find((f) => f.fileName === noRows.name)!;
    const [anchor] = bundle.db.select().from(balanceAnchors).where(eq(balanceAnchors.importFileId, file.id)).all();
    const dayRows = (accountId: string) =>
      bundle.db
        .select({ day: dailyBalances.day, balanceCents: dailyBalances.balanceCents, basis: dailyBalances.basis })
        .from(dailyBalances)
        .where(eq(dailyBalances.accountId, accountId))
        .orderBy(dailyBalances.day)
        .all();
    const basisOn = (accountId: string, day: string) => dayRows(accountId).find((r) => r.day === day)?.basis;
    // the premise: the file holds a period and an anchor, no rows, and its anchor day reads checked
    expect(anchor).toBeDefined();
    expect(bundle.db.select().from(transactions).where(eq(transactions.importFileId, file.id)).all()).toEqual([]);
    expect(bundle.db.select().from(statementPeriods).where(eq(statementPeriods.importFileId, file.id)).all()).toHaveLength(1);
    expect(basisOn(anchor!.accountId, anchor!.anchoredOn)).toBe("anchored");

    unimportFile(bundle.db, file.id);

    expect(bundle.db.select().from(balanceAnchors).where(eq(balanceAnchors.anchoredOn, anchor!.anchoredOn)).all()).toEqual([]);
    expect(basisOn(anchor!.accountId, anchor!.anchoredOn)).not.toBe("anchored");
    // …and the cache is exactly what a rebuild from what is left would write
    const left = dayRows(anchor!.accountId);
    rebuildAccount(bundle.db, anchor!.accountId);
    expect(left).toEqual(dayRows(anchor!.accountId));
  });

  /**
   * 🔴 Un-importing deleted a file's rows and left their transfer partners
   * pointing at a group with no second leg. `detectTransfers` pairs only rows
   * whose group IS NULL, so a re-import never paired them again. Measured on a
   * copy of the real ledger, 2026-09-15: un-importing and re-importing
   * 20260702 + 20260302 took Chase's single-leg groups 23 → 34, eight of them
   * Chase Checking card payments whose Sapphire leg had been deleted.
   */
  test("un-import releases a transfer partner its deleted rows would leave alone in a group", async () => {
    await importStatementFiles(bundle.db, [load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX")]);
    const file = bundle.db.select().from(importFilesTable).all()[0]!;
    const leg = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.importFileId, file.id))
      .all()
      .find((t) => t.amountCents < 0 && t.transferGroupId === null)!;
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Hand card", type: "credit" });
    const savings = createAccount(bundle.db, { institutionId: chase.id, name: "Hand savings", type: "checking" });
    let seq = 0;
    const hand = (accountId: string, postedOn: string, amountCents: number, raw: string): string => {
      seq += 1;
      return bundle.db
        .insert(transactions)
        .values({
          accountId,
          postedOn,
          amountCents,
          rawDescription: raw,
          normalizedDescription: normalizeDescription(raw),
          dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: seq }),
        })
        .returning({ id: transactions.id })
        .get().id;
    };
    const group = (ids: readonly string[], groupId: string) =>
      bundle.db.update(transactions).set({ transferGroupId: groupId }).where(inArray(transactions.id, [...ids])).run();

    // the file's outflow keys a group with a hand-entered card payment
    const partner = hand(card, leg.postedOn, -leg.amountCents, "PAYMENT THANK YOU");
    group([leg.id, partner], leg.id);
    // the control: a pair the file holds no leg of
    const out = hand(savings, "2024-08-01", -5000, "TRANSFER TO CARD");
    const into = hand(card, "2024-08-01", 5000, "TRANSFER FROM SAVINGS");
    group([out, into], out);

    unimportFile(bundle.db, file.id);

    const groupOf = (id: string) =>
      bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.transferGroupId;
    expect(groupOf(partner)).toBeNull();
    expect(groupOf(out)).toBe(out);
    expect(groupOf(into)).toBe(out);
  });

  test("un-import snapshots the file's rows first — an unknown id spends nothing", async () => {
    await importStatementFiles(bundle.db, [load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX")]);
    const before = activeTxnStats("4321").count;
    unimportFile(bundle.db, "no-such-file");
    expect(preMutationSnapshots()).toEqual([]);

    const file = bundle.db.select().from(importFilesTable).all()[0]!;
    unimportFile(bundle.db, file.id);

    const name = preMutationSnapshots()[0]!;
    expect(name).toMatch(/-unimport-file\.db$/);
    const restore = createDatabase(path.join(dir, "backups", name));
    expect(restore.db.select().from(transactions).all()).toHaveLength(before);
    expect(restore.db.select().from(importFilesTable).all()).toHaveLength(1);
    restore.sqlite.close();
  });
});

/**
 * 🔴 Un-importing a statement unlinked the partner of every transfer leg it deleted, and nothing linked the pair again
 * when the same line came back: detection pairs only what it can prove, and these pairs were linked by hand because it
 * could not. The returning leg also came back without its "Credit Card Payment" category, so the card payment counted
 * as spending. Measured on a copy of the real ledger, 2026-09-16: a round trip of 20260812-statements-3522-.pdf lost 7
 * pairs and put $12,975.87 of July card payments into "Uncategorized" spending.
 */
describe("a transfer pair an un-import takes apart", () => {
  const QFX = () => load("chase", "Chase4321_Activity_2024-07-01_2024-09-30.QFX");
  let seq = 0;

  function hand(accountId: string, postedOn: string, amountCents: number, raw: string): string {
    seq += 1;
    return bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 1000 + seq }),
      })
      .returning({ id: transactions.id })
      .get().id;
  }

  const row = (id: string) => bundle.db.select().from(transactions).where(eq(transactions.id, id)).get();
  const liveTwin = (of: typeof transactions.$inferSelect) =>
    bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, of.accountId), eq(transactions.dedupeHash, of.dedupeHash), ne(transactions.status, "superseded")))
      .get();
  const groupOf = (groupId: string | null) =>
    groupId === null ? [] : bundle.db.select().from(transactions).where(eq(transactions.transferGroupId, groupId)).all().map((t) => t.id).sort();

  /** The QFX's first ungrouped outflow, linked by hand to a card payment entered without a file. */
  async function linkedByHand(): Promise<{ fileId: string; leg: typeof transactions.$inferSelect; partner: string }> {
    const { linkTransferPair } = await import("@/services/transfer-links");
    await importStatementFiles(bundle.db, [QFX()]);
    const fileId = bundle.db.select().from(importFilesTable).all()[0]!.id;
    const leg = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.importFileId, fileId))
      .all()
      .find((t) => t.amountCents < 0 && t.transferGroupId === null && t.status === "active")!;
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Hand card", type: "credit" });
    const partner = hand(card, leg.postedOn, -leg.amountCents + 150, "PAYMENT THANK YOU");
    linkTransferPair(bundle.db, leg.id, partner);
    return { fileId, leg: row(leg.id)!, partner };
  }

  test("importing the same line again links it to its partner again, with the category the pair had", async () => {
    const { fileId, leg, partner } = await linkedByHand();
    expect(leg).toMatchObject({ transferGroupId: leg.id, categorizationSource: "user" });

    unimportFile(bundle.db, fileId);
    expect(row(partner)!.transferGroupId).toBeNull();
    await importStatementFiles(bundle.db, [QFX()]);

    const back = liveTwin(leg)!;
    expect(back.id).not.toBe(leg.id);
    expect(back).toMatchObject({ transferGroupId: back.id, categoryId: leg.categoryId, categorizationSource: "user", needsReview: false });
    expect(row(partner)!.transferGroupId).toBe(back.id);
    expect(groupOf(back.id)).toEqual([back.id, partner].sort());
  });

  test("a partner linked again by hand in the meantime is left as the owner linked it", async () => {
    const { linkTransferPair } = await import("@/services/transfer-links");
    const { fileId, leg, partner } = await linkedByHand();
    unimportFile(bundle.db, fileId);
    // not the same money: the returning line must not dedupe against it
    const other = hand(leg.accountId, leg.postedOn, leg.amountCents - 1, "SOMETHING ELSE");
    linkTransferPair(bundle.db, other, partner);

    await importStatementFiles(bundle.db, [QFX()]);

    expect(row(partner)!.transferGroupId).toBe(other);
    expect(groupOf(other)).toEqual([other, partner].sort());
    expect(liveTwin(leg)!.transferGroupId).not.toBe(other);
  });

  /** The leg's line as another export of the same account prints it — the Chase deposit CSV — at `amountCents`. */
  function exportOf(leg: typeof transactions.$inferSelect, amountCents: number): ImportInput {
    const [y, m, d] = leg.postedOn.split("-");
    const amount = (amountCents / 100).toFixed(2);
    return {
      name: `Chase4321_Activity_${amountCents}.CSV`,
      buffer: Buffer.from(
        ["Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #", `DEBIT,${m}/${d}/${y},${leg.rawDescription},${amount},ACH_DEBIT,,`].join("\n"),
      ),
    };
  }

  test("the same money printed by another export links the pair too; a line of other money does not", async () => {
    const { fileId, leg, partner } = await linkedByHand();
    unimportFile(bundle.db, fileId);

    await importStatementFiles(bundle.db, [exportOf(leg, leg.amountCents - 1)]);
    expect(row(partner)!.transferGroupId).toBeNull();

    await importStatementFiles(bundle.db, [exportOf(leg, leg.amountCents)]);
    const back = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, leg.accountId), eq(transactions.amountCents, leg.amountCents), eq(transactions.postedOn, leg.postedOn)))
      .all();
    expect(back).toHaveLength(1);
    expect(row(partner)!.transferGroupId).toBe(back[0]!.id);
    expect(back[0]).toMatchObject({ transferGroupId: back[0]!.id, categoryId: leg.categoryId, categorizationSource: "user" });
  });

  /*
   * 🔴 The first un-import kept the partner by its row id and unlinked it. Un-importing the partner's own file then
   * skipped it — it was in no transfer any more — so nothing kept its line, and the import that brought both lines
   * back found the kept partner gone and dropped the record. Measured on a copy of the real ledger, 2026-09-16:
   * un-importing 20260812-statements-3522-.pdf and Statement_082026_4208.pdf, then importing both again, took two-leg
   * groups 757 -> 755 and left the $11,476.31 and $115.17 Venture X payments uncategorized on Chase Checking.
   */
  const CHECKING = { name: "Chase4321_Activity_hand-pair.CSV", buffer: Buffer.from(["Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #", "DEBIT,03/02/2026,ONLINE PAYMENT TO CARD,-500.00,ACH_DEBIT,,"].join("\n")) };
  // not the same money: detection cannot pair it, which is why the owner linked it by hand
  const CARD = { name: "Chase1111_Activity_hand-pair.CSV", buffer: Buffer.from(["Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo", "1111,03/03/2026,03/03/2026,Payment Thank You-Mobile,,Payment,498.50,"].join("\n")) };
  const fileNamed = (name: string) =>
    bundle.db.select().from(importFilesTable).where(and(eq(importFilesTable.fileName, name), ne(importFilesTable.status, "superseded"))).get()!.id;
  const rowsOf = (name: string) => bundle.db.select().from(transactions).where(eq(transactions.importFileId, fileNamed(name))).all();

  async function pairAcrossTwoFiles() {
    const { linkTransferPair } = await import("@/services/transfer-links");
    await importStatementFiles(bundle.db, [CHECKING, CARD]);
    const [out] = rowsOf(CHECKING.name);
    const [inn] = rowsOf(CARD.name);
    expect([out!.transferGroupId, inn!.transferGroupId]).toEqual([null, null]);
    linkTransferPair(bundle.db, out!.id, inn!.id);
    return { out: row(out!.id)!, inn: row(inn!.id)! };
  }

  function expectLinkedAgain(was: { out: typeof transactions.$inferSelect; inn: typeof transactions.$inferSelect }) {
    const [out] = rowsOf(CHECKING.name);
    const [inn] = rowsOf(CARD.name);
    expect(out!.id).not.toBe(was.out.id);
    expect(inn!.id).not.toBe(was.inn.id);
    expect(out).toMatchObject({ transferGroupId: out!.id, categoryId: was.out.categoryId, categorizationSource: "user", needsReview: false });
    expect(inn).toMatchObject({ transferGroupId: out!.id, categoryId: was.inn.categoryId, categorizationSource: "user", needsReview: false });
    expect(groupOf(out!.id)).toEqual([out!.id, inn!.id].sort());
  }

  test("both files of a pair un-imported, then imported again in one upload, link the pair again", async () => {
    const was = await pairAcrossTwoFiles();
    expect(was.out.categoryId).not.toBeNull();
    unimportFile(bundle.db, fileNamed(CHECKING.name));
    unimportFile(bundle.db, fileNamed(CARD.name));

    await importStatementFiles(bundle.db, [CHECKING, CARD]);
    expectLinkedAgain(was);
  });

  test.each([
    ["the card first", [CARD, CHECKING]],
    ["the checking first", [CHECKING, CARD]],
  ])("…and imported again one file at a time, %s", async (_, order) => {
    const was = await pairAcrossTwoFiles();
    unimportFile(bundle.db, fileNamed(CARD.name));
    unimportFile(bundle.db, fileNamed(CHECKING.name));

    await importStatementFiles(bundle.db, [order[0]!]);
    // the first line back takes back its category at once, and waits unlinked for its partner
    const [first] = rowsOf(order[0]!.name);
    const firstWas = order[0] === CARD ? was.inn : was.out;
    expect(first).toMatchObject({ transferGroupId: null, categoryId: firstWas.categoryId, categorizationSource: "user" });
    await importStatementFiles(bundle.db, [order[1]!]);
    expectLinkedAgain(was);
  });

  test("a leg back before its partner, un-imported again, is still kept by its line", async () => {
    const was = await pairAcrossTwoFiles();
    unimportFile(bundle.db, fileNamed(CARD.name));
    unimportFile(bundle.db, fileNamed(CHECKING.name));
    await importStatementFiles(bundle.db, [CHECKING]);
    unimportFile(bundle.db, fileNamed(CHECKING.name));

    await importStatementFiles(bundle.db, [CARD, CHECKING]);
    expectLinkedAgain(was);
  });

  test("a partner whose statement is read again at a new parser version is kept by its line", async () => {
    const was = await pairAcrossTwoFiles();
    unimportFile(bundle.db, fileNamed(CHECKING.name));
    await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [CARD]));
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, was.inn.id)).get()!.status).toBe("superseded");

    await importStatementFiles(bundle.db, [CHECKING]);
    expectLinkedAgain(was);
  });

  /*
   * 🔴 The takeover moved the waiting partner's note, category and links onto the row that took it over, and left the
   * kept transfer naming the retired row: importing the checking statement again then forgot the transfer, and the
   * owner's hand-linked pair stayed apart (the review of uc/final-integrate, 2026-09-16).
   */
  test("a partner taken over by a more trusted file while it waits keeps the transfer", async () => {
    const was = await pairAcrossTwoFiles();
    unimportFile(bundle.db, fileNamed(CHECKING.name));
    const OFX = { name: "hand-pair-card.ofx", buffer: Buffer.from("<OFX> hand-pair-card") };
    const cardOfx: ParserProfile = {
      id: "test-hand-pair-card-ofx",
      version: 1,
      matches: (f) => f.name === OFX.name,
      parse: () => [
        {
          accountHint: { institution: "Chase", last4: "1111", type: "credit" },
          txns: [{ postedOn: "2026-03-03", transactedOn: "2026-03-03", amountCents: 49_850, rawDescription: "Payment Thank You-Mobile" }],
        },
      ],
    };
    PROFILES.unshift(cardOfx);
    try {
      const [taken] = await importStatementFiles(bundle.db, [OFX]);
      expect(taken).toMatchObject({ status: "parsed", supersededTakeover: 1 });
    } finally {
      PROFILES.splice(PROFILES.indexOf(cardOfx), 1);
    }
    expect(row(was.inn.id)!.status).toBe("superseded");

    await importStatementFiles(bundle.db, [CHECKING]);
    const [out] = rowsOf(CHECKING.name);
    const [inn] = rowsOf(OFX.name);
    expect(out).toMatchObject({ transferGroupId: out!.id, categoryId: was.out.categoryId, categorizationSource: "user" });
    expect(inn).toMatchObject({ transferGroupId: out!.id, categoryId: was.inn.categoryId, categorizationSource: "user" });
    expect(groupOf(out!.id)).toEqual([out!.id, inn!.id].sort());
    expect(bundle.db.select().from(unimportedTransferLegs).all()).toEqual([]);
  });

  test("a partner linked elsewhere before its own file is un-imported is not kept for the old transfer", async () => {
    const { linkTransferPair } = await import("@/services/transfer-links");
    const was = await pairAcrossTwoFiles();
    unimportFile(bundle.db, fileNamed(CHECKING.name));
    const other = hand(was.out.accountId, "2026-03-04", -49_850, "SOMETHING ELSE");
    linkTransferPair(bundle.db, other, was.inn.id);
    unimportFile(bundle.db, fileNamed(CARD.name));

    await importStatementFiles(bundle.db, [CHECKING, CARD]);
    const [out] = rowsOf(CHECKING.name);
    expect(out!.transferGroupId).toBeNull();
    expect(bundle.db.select().from(unimportedTransferLegs).all()).toEqual([]);
    // 🔴 …nor its category, which the pair gave it: it came back as "Credit Card Payment", by hand, out of every total
    // and out of review, on a payment in no transfer (the review of uc/final-integrate, 2026-09-16). A bare import
    // leaves this line uncategorized.
    expect(out).toMatchObject({ categoryId: null, categorizationSource: null });
    expect(bundle.db.select().from(unimportedRowAttributes).all()).toEqual([]);
  });
});

describe("resolveAccount preferName (P0.1 settlement-cash routing)", () => {
  const hint = {
    institution: "Robinhood",
    type: "investment",
    subtype: "brokerage",
    name: "Robinhood Brokerage",
    preferName: "Robinhood Cash",
  } as const;

  test("falls back to the type match while no settlement-cash account exists", () => {
    const brokerage = resolveAccount(bundle.db, { ...hint, preferName: undefined });
    expect(resolveAccount(bundle.db, hint)).toBe(brokerage);
  });

  test("routes to the existing settlement-cash account once it exists", () => {
    resolveAccount(bundle.db, { ...hint, preferName: undefined }); // brokerage exists
    const cash = resolveAccount(bundle.db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });
    expect(resolveAccount(bundle.db, hint)).toBe(cash);
  });
});

describe("parseContextFor — the accounts a multi-account file may parse", () => {
  test("offers the last4 of every tracked account by institution, and leaves out an account with none", () => {
    resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage", last4: "3525" });
    resolveAccount(bundle.db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });
    resolveAccount(bundle.db, { institution: "Chase", type: "checking", name: "Chase Checking", last4: "3522" });

    const { knownAccounts } = parseContextFor(bundle.db);
    // the TYPE travels with the number: a two-account Robinhood statement routes
    // each section by what the ledger tracks that account as
    expect(knownAccounts.Robinhood).toEqual([{ last4: "3525", type: "investment", subtype: "brokerage" }]);
    expect(knownAccounts.Chase).toEqual([{ last4: "3522", type: "checking", subtype: null }]);
    expect(knownAccounts.Discover).toBeUndefined();
  });
});

/**
 * 🔴 Venture X is one card under three numbers: its statements through January 2026 print 9082, then 4147, and the
 * account is 4208 (merged by hand, pass 12). The import matched a statement to an account by `accounts.last4` alone, so
 * un-importing capitalone-venturex-statement-2026-03.pdf and importing the same bytes again created a second "Venture
 * X" (····9082) with the statement's 195 rows and its period (a copy of the real ledger, 2026-09-16: net worth
 * −$149.15).
 */
describe("a card reissued under a new number", () => {
  const PREFIX = "reissued-card-statement-";
  const statement = (last4: string, month: string, amountCents: number): ParsedStatement => ({
    accountHint: { institution: "Capital One", type: "credit", last4, name: "Venture X" },
    txns: [{ postedOn: `2026-${month}-10`, amountCents, rawDescription: `CARD PURCHASE ${month}` }],
    period: { start: `2026-${month}-01`, end: `2026-${month}-28`, beginCents: 0, endCents: amountCents },
  });
  const profile: ParserProfile = {
    id: "test-reissued-card-statement",
    version: 1,
    matches: (f) => f.name.startsWith(PREFIX),
    parse: (f) => {
      const [last4, month] = f.text.trim().split(" ") as [string, string];
      return [statement(last4, month, month === "02" ? -1000 : -2000)];
    },
  };
  const file = (last4: string, month: string): ImportInput => ({ name: `${PREFIX}${month}.txt`, buffer: Buffer.from(`${last4} ${month}`) });
  const OLD_NUMBER = file("9082", "02");
  const NEW_NUMBER = file("4208", "03");

  beforeEach(() => {
    PROFILES.unshift(profile);
  });
  afterEach(() => {
    PROFILES.splice(PROFILES.indexOf(profile), 1);
  });

  /** The owner's merge: the account takes the new number, and keeps the one its earlier statement printed. */
  async function reissued(): Promise<string> {
    const { recordFormerNumber } = await import("./account-numbers");
    await importStatementFiles(bundle.db, [OLD_NUMBER]);
    const card = bundle.db.select().from(accounts).where(eq(accounts.last4, "9082")).get()!;
    bundle.db.update(accounts).set({ last4: "4208" }).where(eq(accounts.id, card.id)).run();
    expect(recordFormerNumber(bundle.db, card.id, "9082")).toBe(true);
    await importStatementFiles(bundle.db, [NEW_NUMBER]);
    return card.id;
  }

  test("a statement printed under an earlier number is filed under the card again after an un-import", async () => {
    const card = await reissued();
    const oldFile = bundle.db.select().from(importFilesTable).where(eq(importFilesTable.fileName, OLD_NUMBER.name)).get()!;

    unimportFile(bundle.db, oldFile.id);
    const [outcome] = await importStatementFiles(bundle.db, [OLD_NUMBER]);

    expect(outcome!.status).toBe("parsed");
    expect(bundle.db.select().from(accounts).all().filter((a) => a.name === "Venture X").map((a) => a.id)).toEqual([card]);
    expect(bundle.db.select().from(statementPeriods).all().map((p) => [p.accountId, p.periodStart])).toEqual([
      [card, "2026-03-01"],
      [card, "2026-02-01"],
    ]);
    expect(bundle.db.select().from(transactions).all().every((t) => t.accountId === card)).toBe(true);
  });

  test("a multi-account profile is offered the earlier number, and a section withheld under it names the card", async () => {
    const card = await reissued();
    expect(parseContextFor(bundle.db).knownAccounts["Capital One"]).toEqual([
      { last4: "4208", type: "credit", subtype: null },
      { last4: "9082", type: "credit", subtype: null },
    ]);
    const WITHHOLDS = { name: `${PREFIX}withheld.txt`, buffer: Buffer.from("withheld") };
    const withholding: ParserProfile = {
      id: "test-reissued-card-withheld",
      version: 1,
      matches: (f) => f.name === WITHHOLDS.name,
      parse: () => ({
        statements: [],
        withheld: [{ accountHint: { institution: "Capital One", type: "credit", last4: "9082" }, accountNumber: "XXXX9082", period: { start: "2026-04-01", end: "2026-04-28" }, reason: "cannot prove it" }],
      }),
    };
    PROFILES.unshift(withholding);
    try {
      const [outcome] = await importStatementFiles(bundle.db, [WITHHOLDS]);
      expect(outcome!.withheld.map((w) => w.accountId)).toEqual([card]);
    } finally {
      PROFILES.splice(PROFILES.indexOf(withholding), 1);
    }
  });

  test("a number two accounts once printed names neither, and the current number always wins", async () => {
    const { recordFormerNumber } = await import("./account-numbers");
    const card = await reissued();
    const other = resolveAccount(bundle.db, { institution: "Capital One", type: "credit", last4: "5555", name: "Quicksilver" });
    expect(recordFormerNumber(bundle.db, other, "9082")).toBe(true);
    // its own current number is never an earlier one
    expect(recordFormerNumber(bundle.db, other, "5555")).toBe(false);
    // another account's earlier number never takes a statement from the account that carries it now
    expect(recordFormerNumber(bundle.db, other, "4208")).toBe(true);
    expect(resolveAccount(bundle.db, { institution: "Capital One", type: "credit", last4: "4208" })).toBe(card);
    const ambiguous = resolveAccount(bundle.db, { institution: "Capital One", type: "credit", last4: "9082" });
    expect([card, other]).not.toContain(ambiguous);
  });
});

describe("cross-format reconciliation dedupe (the DB is master)", () => {
  const cardCsv = (rows: string[]): string =>
    ["Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo", ...rows].join("\n");

  test("an overlapping alt-export with different raw text dedupes against the DB instead of double-counting", async () => {
    // primary export: two real charges
    const primary = cardCsv([
      "6001,06/01/2026,06/01/2026,STARBUCKS STORE 00123 SEATTLE WA,Food & Drink,Sale,-5.75,",
      "6001,06/02/2026,06/02/2026,AMAZON MKTPL*AB1CD23,Shopping,Sale,-25.00,",
    ]);
    await importStatementFiles(bundle.db, [{ name: "Chase6001_Activity_a.CSV", buffer: Buffer.from(primary) }]);
    const before = activeTxnStats("6001");
    expect(before.count).toBe(2);

    // alt export of the SAME period: same money, reformatted descriptions →
    // the exact dedupe hash misses, but the DB already records this money
    const alt = cardCsv([
      "6001,06/01/2026,06/01/2026,STARBUCKS #123,Food & Drink,Sale,-5.75,",
      "6001,06/02/2026,06/02/2026,AMZN Mktp US,Shopping,Sale,-25.00,",
    ]);
    const [outcome] = await importStatementFiles(bundle.db, [
      { name: "Chase6001_Activity_b.CSV", buffer: Buffer.from(alt) },
    ]);
    expect(outcome!.status).toBe("parsed");
    expect(outcome!.inserted).toBe(0);
    expect(outcome!.dedupedCrossFormat).toBe(2);
    expect(activeTxnStats("6001")).toEqual(before); // count AND sum unchanged
  });

  /**
   * 🔴 A card statement prints each charge's TRANSACTION day; the Spending Report export posts it 2–3 days later and
   * carries both days. A line was matched to the first unused record on its posted day, then on its transaction day,
   * one line at a time — so the export's 05-11 post (a charge made 05-08) took the statement's 05-11 charge, and the
   * export's 05-13 post (the 05-11 charge) found nothing left and was stored a second time. Measured on a copy of the
   * real ledger, 2026-09-16: un-importing 20260602-statements-9805-.pdf and Spending Report PDF (1).pdf, then importing
   * the statement and then the report, left RAM`S VILLAGE −$10.40 counted twice and all 86 of the statement's rows
   * quarantined behind a $10.40 gap.
   */
  describe("three same-amount charges an export posts days after the statement's transaction days", () => {
    const PREFIX = "ram-village-";
    const RAM = "RAM`S VILLAGE";
    const statementLines: CanonicalTxn[] = ["2026-05-05", "2026-05-08", "2026-05-11"].map((day) => ({ postedOn: day, transactedOn: day, amountCents: -1040, rawDescription: `${RAM} BRONX NY` }));
    const exportLines = [
      ["2026-05-07", "2026-05-05"],
      ["2026-05-11", "2026-05-08"],
      ["2026-05-13", "2026-05-11"],
    ].map(([postedOn, transactedOn]) => ({ postedOn: postedOn!, transactedOn, amountCents: -1040, rawDescription: RAM }));
    const savedStatement = [...statementLines];
    const savedExport = [...exportLines];
    const hint: AccountHint = { institution: "Chase", type: "credit", last4: "7805", name: "Sapphire test" };
    const profile: ParserProfile = {
      id: "test-ram-village",
      version: 1,
      matches: (f) => f.name.startsWith(PREFIX),
      parse: (f): ParsedStatement[] => {
        if (f.text.trim() === "statement") {
          return [{ accountHint: hint, txns: statementLines, period: { start: "2026-05-03", end: "2026-06-02", beginCents: 0, endCents: statementLines.reduce((n, l) => n + l.amountCents, 0) } }];
        }
        // a lower-fidelity export's one row, and a higher-fidelity file's two charges of that amount that day
        if (f.text.trim() === "lower") return [{ accountHint: hint, txns: [{ postedOn: "2026-05-25", amountCents: -900, rawDescription: "GAS STATION" }] }];
        if (f.text.includes("higher")) {
          return [
            {
              accountHint: hint,
              txns: [
                { postedOn: "2026-05-25", amountCents: -900, rawDescription: "GAS STATION 1" },
                { postedOn: "2026-05-25", amountCents: -900, rawDescription: "PHARMACY" },
              ],
            },
          ];
        }
        return [{ accountHint: hint, txns: exportLines }];
      },
    };
    const STATEMENT: ImportInput = { name: `${PREFIX}statement.txt`, buffer: Buffer.from("statement") };
    const EXPORT: ImportInput = { name: `${PREFIX}export.txt`, buffer: Buffer.from("export") };

    beforeEach(() => {
      PROFILES.unshift(profile);
    });
    afterEach(() => {
      PROFILES.splice(PROFILES.indexOf(profile), 1);
    });

    const liveMoney = () => {
      const card = bundle.db.select().from(accounts).where(eq(accounts.last4, "7805")).get()!;
      const rows = bundle.db.select().from(transactions).where(eq(transactions.accountId, card.id)).all();
      return {
        active: rows.filter((r) => r.status === "active").reduce((n, r) => n + r.amountCents, 0),
        quarantined: rows.filter((r) => r.status === "quarantined").length,
        period: bundle.db.select().from(statementPeriods).where(eq(statementPeriods.accountId, card.id)).get()!.reconciliation,
      };
    };

    test("the statement first, then the export: every export line is the statement's own charge", async () => {
      await importStatementFiles(bundle.db, [STATEMENT]);
      const [exported] = await importStatementFiles(bundle.db, [EXPORT]);

      expect(exported).toMatchObject({ inserted: 0, dedupedCrossFormat: 3 });
      expect(liveMoney()).toEqual({ active: -3120, quarantined: 0, period: "reconciled" });
    });

    test("a line whose surest record another line needs more moves to its next record, rather than leave a line stored twice", async () => {
      // the statement: one charge it dates 05-20, and one of the same amount that day it can only post
      //
      // ⚖️ The second row carries no transaction day on purpose. A source that HAS one and disagrees about it is
      // recording another charge (`identityWeight`), so a fixture that gave this row 05-18 would be asserting that
      // two charges are one — the displacement this test is about needs a row the second line may fall back to, not a
      // contradiction.
      statementLines.splice(0, statementLines.length, ...[
        { postedOn: "2026-05-20", transactedOn: "2026-05-20", amountCents: -500, rawDescription: "DELI" },
        { postedOn: "2026-05-20", amountCents: -500, rawDescription: "DELI" },
      ]);
      // the export: the 05-20 charge, and one made on 05-20 that it posts on 05-22
      exportLines.splice(0, exportLines.length, ...[
        { postedOn: "2026-05-20", transactedOn: "2026-05-20", amountCents: -500, rawDescription: "DELI BRONX NY" },
        { postedOn: "2026-05-22", transactedOn: "2026-05-20", amountCents: -500, rawDescription: "DELI BRONX NY" },
      ]);
      try {
        await importStatementFiles(bundle.db, [STATEMENT]);
        const [exported] = await importStatementFiles(bundle.db, [EXPORT]);
        expect(exported).toMatchObject({ inserted: 0, dedupedCrossFormat: 2 });
      } finally {
        statementLines.splice(0, statementLines.length, ...savedStatement);
        exportLines.splice(0, exportLines.length, ...savedExport);
      }
    });

    test("when two lines claim one record, the one made that day is it, and the one only posted that day is stored", async () => {
      statementLines.splice(0, statementLines.length, { postedOn: "2026-05-15", transactedOn: "2026-05-15", amountCents: -700, rawDescription: "CAFE" });
      exportLines.splice(0, exportLines.length, ...[
        // another charge, made on 05-13, that the export posts on the statement's day
        { postedOn: "2026-05-15", transactedOn: "2026-05-13", amountCents: -700, rawDescription: "CAFE NY" },
        // the statement's charge, posted two days later
        { postedOn: "2026-05-17", transactedOn: "2026-05-15", amountCents: -700, rawDescription: "CAFE NY" },
      ]);
      try {
        await importStatementFiles(bundle.db, [STATEMENT]);
        const [exported] = await importStatementFiles(bundle.db, [EXPORT]);
        expect(exported).toMatchObject({ inserted: 1, dedupedCrossFormat: 1 });
        const stored = bundle.db.select().from(transactions).where(eq(transactions.rawDescription, "CAFE NY")).all();
        expect(stored.map((r) => [r.postedOn, r.transactedOn])).toEqual([["2026-05-15", "2026-05-13"]]);
      } finally {
        statementLines.splice(0, statementLines.length, ...savedStatement);
        exportLines.splice(0, exportLines.length, ...savedExport);
      }
    });

    test("a row one line takes over records no other line of the file", async () => {
      await importStatementFiles(bundle.db, [{ name: `${PREFIX}lower.txt`, buffer: Buffer.from("lower") }]);
      // OFX-headed bytes: a file the import trusts more than the export
      const [higher] = await importStatementFiles(bundle.db, [{ name: `${PREFIX}higher.ofx`, buffer: Buffer.from("OFXHEADER higher") }]);

      expect(higher).toMatchObject({ supersededTakeover: 1, inserted: 2, dedupedCrossFormat: 0 });
      const live = bundle.db.select().from(transactions).where(and(eq(transactions.postedOn, "2026-05-25"), ne(transactions.status, "superseded"))).all();
      expect(live.map((r) => r.rawDescription).sort()).toEqual(["GAS STATION 1", "PHARMACY"]);
    });

    test("the export first, then the statement: the same ledger", async () => {
      await importStatementFiles(bundle.db, [EXPORT]);
      const [statement] = await importStatementFiles(bundle.db, [STATEMENT]);

      expect(statement).toMatchObject({ inserted: 0, dedupedCrossFormat: 3 });
      expect(liveMoney()).toEqual({ active: -3120, quarantined: 0, period: "reconciled" });
    });
  });

  /**
   * 🔴 Two vending charges of $1.25 each, one made on the 08th and one on the 09th, that two files date differently:
   * the export posts the 08th charge on the 09th, and the card statement prints the 09th charge on the day it was
   * made. The identity match scored a shared POSTED day 1 whatever the two rows said about the day the charge was
   * made, so the export's 08th charge was absorbed by the statement's 09th charge and never stored.
   *
   * Reported by the review of 2026-09-17, re-measured on a copy of the real ledger 2026-09-22: a version bump of `chase-spending-report-pdf` re-read
   * "Spending Report PDF (1).pdf" while 20260802-statements-9805-.pdf held the same July days, and Chase Sapphire
   * 2026-07-03 → 2026-08-02 went from `reconciled` to a −$1.25 gap with all 72 of the statement's rows quarantined
   * and one CPI*CANTEEN VENDING charge gone. Reading the two files the other way round recorded both charges, which
   * is what said the rule was wrong rather than merely unlucky.
   */
  describe("two sources that disagree about the day a charge was made", () => {
    const PREFIX = "canteen-";
    const VENDING = "CPI*CANTEEN VENDING";
    const hint: AccountHint = { institution: "Chase", type: "credit", last4: "7806", name: "Vending test" };
    /** a card statement's line: it prints ONE date and it is the day the charge was made */
    const made = (day: string, amountCents = -125, rawDescription = `${VENDING} MIAMI FL`): CanonicalTxn => ({
      postedOn: day,
      transactedOn: day,
      amountCents,
      rawDescription,
    });
    /** an export's line: the day it posted, and the day the charge was made */
    const posted = (postedOn: string, transactedOn: string, amountCents = -125, rawDescription = VENDING): CanonicalTxn => ({
      postedOn,
      transactedOn,
      amountCents,
      rawDescription,
    });
    const STATEMENT_LINES = [made("2026-07-08"), made("2026-07-09")];
    /**
     * The export runs out on the 09th, so of the two it prints only the 08th charge — posted a day later, with the day
     * it was made. That is the real shape: the report's last July $1.25 is posted 07-09 and made 07-08, and the
     * statement's own 07-08 line was absorbed by it when the statement landed second.
     *
     * The June line is load-bearing: it is the export's own row on a day no statement covers, so a re-read of the
     * export still reads this account and answers for its own days. Without it the re-read reads nothing here, and a
     * row it loses inside the statement's month is handed back by `settleHeldRows` — which is not what happens to the
     * owner, whose report writes 355 rows.
     */
    const EXPORT_LINES = [posted("2026-06-20", "2026-06-19", -300, "GAS STATION"), posted("2026-07-09", "2026-07-08")];
    let statementLines: CanonicalTxn[] = [...STATEMENT_LINES];
    let exportLines: CanonicalTxn[] = [...EXPORT_LINES];
    const statementProfile: ParserProfile = {
      id: "test-canteen-statement",
      version: 1,
      matches: (f) => f.name.startsWith(`${PREFIX}statement`),
      parse: (): ParsedStatement[] => [
        {
          accountHint: hint,
          txns: statementLines,
          // the period closes on what the statement itself prints, so a lost charge shows up as a gap
          period: { start: "2026-07-03", end: "2026-08-02", beginCents: 0, endCents: statementLines.reduce((n, l) => n + l.amountCents, 0) },
        },
      ],
    };
    const exportProfile: ParserProfile = {
      id: "test-canteen-export",
      version: 1,
      matches: (f) => f.name.startsWith(`${PREFIX}export`),
      parse: (): ParsedStatement[] => [{ accountHint: hint, txns: exportLines }],
    };
    const STATEMENT: ImportInput = { name: `${PREFIX}statement.txt`, buffer: Buffer.from("statement") };
    const EXPORT: ImportInput = { name: `${PREFIX}export.txt`, buffer: Buffer.from("export") };

    beforeEach(() => {
      PROFILES.unshift(statementProfile, exportProfile);
    });
    afterEach(() => {
      for (const profile of [statementProfile, exportProfile]) PROFILES.splice(PROFILES.indexOf(profile), 1);
      exportProfile.version = 1;
      statementLines = [...STATEMENT_LINES];
      exportLines = [...EXPORT_LINES];
    });

    /** Every live row of the test card, and what the statement's own period makes of them. */
    const ledger = () => {
      const card = bundle.db.select().from(accounts).where(eq(accounts.last4, "7806")).get()!;
      const rows = bundle.db.select().from(transactions).where(eq(transactions.accountId, card.id)).all();
      const live = rows.filter((r) => r.status === "active" || r.status === "excluded");
      const period = bundle.db
        .select()
        .from(statementPeriods)
        .where(and(eq(statementPeriods.accountId, card.id), eq(statementPeriods.periodStart, "2026-07-03")))
        .get();
      return {
        // by the day each charge was MADE — the one thing the two files agree on, so it does not depend on which of
        // them was read first
        charges: live.map((r) => `${r.transactedOn ?? r.postedOn}:${r.amountCents}`).sort(),
        activeCents: live.reduce((n, r) => n + r.amountCents, 0),
        quarantined: rows.filter((r) => r.status === "quarantined").length,
        period: period?.reconciliation,
        gapCents: period?.gapCents ?? 0,
      };
    };

    /** Both charges recorded once each, beside the export's own June row — whichever file was read first, and however many times. */
    const BOTH_CHARGES = {
      charges: ["2026-06-19:-300", "2026-07-08:-125", "2026-07-09:-125"],
      activeCents: -550,
      quarantined: 0,
      period: "reconciled",
      gapCents: 0,
    };

    /** The ledger the owner has: the export's row records the 08th charge, and the statement's 08th line is that row. */
    async function exportThenStatement(): Promise<void> {
      await importStatementFiles(bundle.db, [EXPORT]);
      const [statement] = await importStatementFiles(bundle.db, [STATEMENT]);
      expect(statement).toMatchObject({ inserted: 1, dedupedCrossFormat: 1 });
      expect(ledger()).toEqual(BOTH_CHARGES);
    }

    test("the export first, then the statement: the 08th charge is the export's row, the 09th is stored", async () => {
      await exportThenStatement();
    });

    test("the statement first, then the export: the same two charges", async () => {
      await importStatementFiles(bundle.db, [STATEMENT]);
      const [exported] = await importStatementFiles(bundle.db, [EXPORT]);

      expect(exported).toMatchObject({ inserted: 1, dedupedCrossFormat: 1 });
      expect(ledger()).toEqual(BOTH_CHARGES);
    });

    /**
     * The owner's real scenario: the export's profile ships a new version, so the next drop of that same file is read
     * again — and the only row left standing on the 08th charge's posted day is the statement's 09th charge.
     */
    test("a parser-version re-read of the export beside the statement keeps both charges", async () => {
      await exportThenStatement();

      exportProfile.version = 2;
      const [reread] = await importStatementFiles(bundle.db, [EXPORT]);

      expect(ledger()).toEqual(BOTH_CHARGES);
      // both of the export's own lines written again, neither taken by the statement's row and neither handed back
      expect(reread).toMatchObject({ status: "parsed", inserted: 2, dedupedCrossFormat: 0, keptByPrinters: 0 });
    });

    /**
     * The same line re-dated by a better source is still one charge: the export prints only a post date, the
     * statement knows the day the charge was made, and the posted lens is all there is to match on.
     */
    test("a source that does not know the day a charge was made still dedupes on the posted day", async () => {
      statementLines = [made("2026-07-09")];
      exportLines = [{ postedOn: "2026-07-09", amountCents: -125, rawDescription: VENDING }];
      await importStatementFiles(bundle.db, [STATEMENT]);
      const [exported] = await importStatementFiles(bundle.db, [EXPORT]);

      expect(exported).toMatchObject({ inserted: 0, dedupedCrossFormat: 1 });
      expect(ledger()).toMatchObject({ charges: ["2026-07-09:-125"], activeCents: -125, period: "reconciled" });
    });

    /**
     * ⛔ Chase Checking printed two identical −$115.00 lines on 2026-03-02 and both are real. A second source
     * printing the same pair records two charges, not one — the days they were made agree, so nothing about the rule
     * above may collapse them into one.
     */
    test("two genuinely identical charges on one day stay two charges", async () => {
      statementLines = [made("2026-07-15", -11500, "ONLINE TRANSFER"), made("2026-07-15", -11500, "ONLINE TRANSFER")];
      exportLines = [
        posted("2026-07-15", "2026-07-15", -11500, "ONLINE TRANSFER TO 1234"),
        posted("2026-07-15", "2026-07-15", -11500, "ONLINE TRANSFER TO 1234"),
      ];
      await importStatementFiles(bundle.db, [STATEMENT]);
      const [exported] = await importStatementFiles(bundle.db, [EXPORT]);

      expect(exported).toMatchObject({ inserted: 0, dedupedCrossFormat: 2 });
      expect(ledger()).toMatchObject({ charges: ["2026-07-15:-11500", "2026-07-15:-11500"], activeCents: -23000, period: "reconciled" });
    });
  });

  test("multiset matching: a second same-day equal-amount row that is genuinely new still imports", async () => {
    const primary = cardCsv([
      "6002,06/01/2026,06/01/2026,STARBUCKS STORE 00123 SEATTLE WA,Food & Drink,Sale,-5.75,",
    ]);
    await importStatementFiles(bundle.db, [{ name: "Chase6002_Activity_a.CSV", buffer: Buffer.from(primary) }]);

    // alt export knows about TWO -5.75 charges that day: one is the known
    // Starbucks charge (reformatted), the other is a real second purchase
    const alt = cardCsv([
      "6002,06/01/2026,06/01/2026,STARBUCKS #123,Food & Drink,Sale,-5.75,",
      "6002,06/01/2026,06/01/2026,PETES COFFEE 42,Food & Drink,Sale,-5.75,",
    ]);
    const [outcome] = await importStatementFiles(bundle.db, [
      { name: "Chase6002_Activity_b.CSV", buffer: Buffer.from(alt) },
    ]);
    expect(outcome!.inserted).toBe(1);
    expect(outcome!.dedupedCrossFormat).toBe(1);
    expect(activeTxnStats("6002").count).toBe(2);
    expect(activeTxnStats("6002").sumCents).toBe(-1150);
  });

  test("byte-identical rows across different files stay plain hash dedupes, not cross-format", async () => {
    const rows = ["6003,06/01/2026,06/01/2026,SHELL OIL 111,Gas,Sale,-40.00,"];
    await importStatementFiles(bundle.db, [
      { name: "Chase6003_Activity_a.CSV", buffer: Buffer.from(cardCsv(rows)) },
    ]);
    // same row text, different file bytes (extra memo on a second, distinct row)
    const second = cardCsv([...rows, "6003,06/03/2026,06/03/2026,COSTCO GAS,Gas,Sale,-30.00,"]);
    const [outcome] = await importStatementFiles(bundle.db, [
      { name: "Chase6003_Activity_b.CSV", buffer: Buffer.from(second) },
    ]);
    expect(outcome!.deduped).toBe(1); // exact hash match — the honest classification
    expect(outcome!.dedupedCrossFormat).toBe(0);
    expect(outcome!.inserted).toBe(1); // the genuinely new Costco row
    expect(activeTxnStats("6003").count).toBe(2);
  });

  test("rows without an import file (legacy rebuild scripts) also dedupe overlapping uploads", async () => {
    // create the account via a first import, then plant a legacy row by hand
    await importStatementFiles(bundle.db, [
      {
        name: "Chase6004_Activity_a.CSV",
        buffer: Buffer.from(cardCsv(["6004,05/01/2026,05/01/2026,SEED ROW,Misc,Sale,-1.00,"])),
      },
    ]);
    const account = bundle.db.select().from(accounts).all().find((a) => a.last4 === "6004")!;
    bundle.db
      .insert(transactions)
      .values({
        accountId: account.id,
        importFileId: null, // rebuild-script provenance
        postedOn: "2026-06-05",
        amountCents: -1234,
        rawDescription: "LEGACY VENDOR PAYMENT",
        normalizedDescription: "legacy vendor payment",
        occurrenceIndex: 0,
        dedupeHash: dedupeHash({
          accountId: account.id,
          postedOn: "2026-06-05",
          amountCents: -1234,
          rawDescription: "LEGACY VENDOR PAYMENT",
          occurrenceIndex: 0,
        }),
      })
      .run();

    const [outcome] = await importStatementFiles(bundle.db, [
      {
        name: "Chase6004_Activity_b.CSV",
        buffer: Buffer.from(cardCsv(["6004,06/05/2026,06/05/2026,Legacy Vendor Pmt Alt Text,Misc,Sale,-12.34,"])),
      },
    ]);
    expect(outcome!.inserted).toBe(0);
    expect(outcome!.dedupedCrossFormat).toBe(1);
  });
});

describe("PDF statements + reconciliation", () => {
  test("a statement PDF parses, reconciles to the cent, and anchors both period ends", async () => {
    const pdfs = loadDir("capital-one", "statements").slice(0, 3);
    const outcomes = await importStatementFiles(bundle.db, pdfs);
    for (const o of outcomes) {
      expect(o.status).toBe("parsed");
    }
    const periods = bundle.db.select().from(statementPeriods).all();
    expect(periods.length).toBeGreaterThanOrEqual(3);
    for (const p of periods) {
      expect(p.reconciliation).toBe("reconciled");
      expect(p.gapCents).toBeNull();
    }
  });

  test("the corrupted statement quarantines with the exact expected gap", async () => {
    const [outcome] = await importStatementFiles(bundle.db, [
      loadDir("discover", "corrupted")[0]!,
    ]);
    expect(outcome!.status).toBe("parsed");
    const period = bundle.db.select().from(statementPeriods).all()[0]!;
    expect(period.reconciliation).toBe("gap");
    expect(period.gapCents).toBe(manifest.corruptedGapCents);

    const quarantined = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.status, "quarantined"))
      .all();
    expect(quarantined.length).toBeGreaterThan(0);

    // accepting the gap releases the rows back to analytics
    acceptGap(bundle.db, period.id);
    expect(
      bundle.db.select().from(transactions).where(eq(transactions.status, "quarantined")).all(),
    ).toHaveLength(0);
    expect(
      bundle.db.select().from(statementPeriods).all()[0]!.reconciliation,
    ).toBe("accepted");

    // the overwritten reconciliation verdict survives in a restore point
    const name = preMutationSnapshots()[0]!;
    expect(name).toMatch(/-accept-gap\.db$/);
    const restore = createDatabase(path.join(dir, "backups", name));
    expect(restore.db.select().from(statementPeriods).all()[0]!.reconciliation).toBe("gap");
    expect(
      restore.db.select().from(transactions).where(eq(transactions.status, "quarantined")).all()
        .length,
    ).toBe(quarantined.length);
    restore.sqlite.close();
  });

  test("accepting a gap surfaces money another file already recorded — and deletes nothing", async () => {
    // The quarantine dedupe gap: quarantined rows are deliberately kept OUT of
    // the import-time identity pool (service.ts existingIdentityPool), so an
    // overlapping export landing DURING a quarantine cannot dedupe against
    // them. Accepting the gap then returns a second copy of the same charges.
    await importStatementFiles(bundle.db, [loadDir("discover", "corrupted")[0]!]);
    const period = bundle.db.select().from(statementPeriods).all()[0]!;
    expect(period.reconciliation).toBe("gap");
    const quarantined = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.status, "quarantined"))
      .all();
    expect(quarantined.length).toBeGreaterThanOrEqual(2);

    // a SECOND pdf source records the same two charges in its own words — the
    // real pairing is a card statement and a Spending Report, which agree on
    // the money and disagree on the text
    const other = bundle.db
      .insert(importFilesTable)
      .values({
        fileName: "spending-report.pdf",
        fileSha256: "second-source-sha",
        format: "pdf",
        institutionId: bundle.db.select().from(importFilesTable).all()[0]!.institutionId,
        parserProfile: "chase-spending-report-pdf",
        parserVersion: 1,
        status: "parsed",
        storagePath: path.join(dir, "originals", "spending-report.pdf"),
        importedAt: new Date().toISOString(),
      })
      .returning()
      .get();
    const twins = quarantined.slice(0, 2);
    for (const d of twins) {
      // contains the quarantined row's text, so descriptionScore is 2 — the
      // same "describes one purchase" test that vetoes a takeover supersede
      const raw = `${d.normalizedDescription} REF 8841`;
      bundle.db
        .insert(transactions)
        .values({
          accountId: d.accountId,
          importFileId: other.id,
          postedOn: d.postedOn,
          amountCents: d.amountCents,
          rawDescription: raw,
          normalizedDescription: raw,
          status: "active",
          dedupeHash: dedupeHash({
            accountId: d.accountId,
            postedOn: d.postedOn,
            amountCents: d.amountCents,
            rawDescription: raw,
            occurrenceIndex: 0,
          }),
        })
        .run();
    }
    const before = bundle.db.select().from(transactions).all();

    acceptGap(bundle.db, period.id);

    const after = bundle.db.select().from(transactions).all();
    // NOTHING is destroyed. An earlier revision superseded the losers here on
    // (day, amount) alone and silently deleted real charges (reverted 3e5a7fc);
    // a double count is visible and reversible, a deleted charge is neither.
    expect(after).toHaveLength(before.length);
    expect(after.filter((t) => t.status === "superseded")).toHaveLength(0);
    expect(after.filter((t) => t.status === "quarantined")).toHaveLength(0);
    const sumOf = (rows: readonly { amountCents: number }[]) =>
      rows.reduce((s, t) => s + t.amountCents, 0);
    expect(sumOf(after)).toBe(sumOf(before));

    // instead both copies of each duplicated charge are put to the owner
    const flagged = after.filter((t) => t.needsReview);
    const twinDays = new Set(twins.map((t) => `${t.postedOn}${t.amountCents}`));
    const flaggedTwins = flagged.filter((t) => twinDays.has(`${t.postedOn}${t.amountCents}`));
    expect(flaggedTwins.length).toBe(2 * twins.length);
    // one of each pair is the statement's row, the other the second source's
    expect(flaggedTwins.filter((t) => t.importFileId === other.id)).toHaveLength(twins.length);

    // and a row the second source never claimed is left alone
    const untouched = quarantined.slice(2);
    for (const q of untouched) {
      expect(after.find((t) => t.id === q.id)!.status).toBe("active");
    }
  });

  test("Robinhood statements become value anchors with computed market change", async () => {
    const pdfs = loadDir("robinhood", "statements").slice(0, 4);
    await importStatementFiles(bundle.db, pdfs);
    const periods = bundle.db.select().from(statementPeriods).all();
    expect(periods.length).toBeGreaterThanOrEqual(4);
    for (const p of periods) {
      expect(p.reconciliation).toBe("value_anchor");
      expect(p.marketChangeCents).not.toBeNull();
    }
  });
});

describe("an import links what it brought in to the series that already carry it — and nothing else", () => {
  /*
   * 🔴 Nothing on the import path wrote a series link (service.ts settled with
   * categorizeAll + detectTransfers only), and every surface decides "paid" from
   * links. On the real ledger, 2026-09-14, the Breezeline charge imported that
   * afternoon sat unlinked under a series carrying its exact descriptor, and
   * /recurring said it "came due Sep 8 and has not posted".
   *
   * Scope is the owner's decision (2026-09-14): only rows the upload inserted or
   * promoted. The fixture's Chase1111 card carries NETFLIX.COM NETFLIX.COM CA
   * on 04/03, 05/03 and 06/03 (Q2 file) and 07/03 (July file), all -$15.49.
   */
  const Q2 = "Chase1111_Activity_2026-04-01_2026-06-30.CSV";
  const JULY = "Chase1111_Activity_2026-07-01_2026-07-05.CSV";

  function rowOn(day: string, rawPrefix: string) {
    const rows = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.postedOn, day), eq(transactions.status, "active")))
      .all()
      .filter((t) => t.rawDescription.startsWith(rawPrefix));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  function registerSeries(name: string, status: "confirmed" | "dismissed" | "ended" = "confirmed"): string {
    return bundle.db
      .insert(recurringSeries)
      .values({ name, kind: "subscription", cadence: "monthly", status, intervalDaysAvg: 30 })
      .returning({ id: recurringSeries.id })
      .get().id;
  }

  function setLink(txnId: string, seriesId: string | null, source: "user" | "detected"): void {
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: seriesId, seriesLinkSource: source })
      .where(eq(transactions.id, txnId))
      .run();
  }

  /**
   * A live series owning the July file's Starbucks descriptor through a row
   * entered by hand — the control that proves an upload in the same test DID
   * link, so a negative assertion beside it is not passing for free.
   */
  function controlSeries(): string {
    const accountId = rowOn("2026-06-03", "NETFLIX").accountId;
    const raw = "STARBUCKS STORE 10502 NEW YORK NY";
    const id = registerSeries("Starbucks (control)");
    const hand = bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn: "2026-06-02",
        amountCents: -765,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId, postedOn: "2026-06-02", amountCents: -765, rawDescription: raw, occurrenceIndex: 0 }),
      })
      .returning({ id: transactions.id })
      .get().id;
    setLink(hand, id, "user");
    return id;
  }

  test("the July charge joins the series; the user's detach and the older untouched row stay as they were", async () => {
    await importStatementFiles(bundle.db, [load("chase", Q2)]);
    const netflix = registerSeries("Netflix");
    setLink(rowOn("2026-06-03", "NETFLIX").id, netflix, "user");
    setLink(rowOn("2026-05-03", "NETFLIX").id, null, "user"); // the owner said "not this one"

    await importStatementFiles(bundle.db, [load("chase", JULY)]);

    const july = rowOn("2026-07-03", "NETFLIX");
    expect(july.recurringSeriesId).toBe(netflix);
    expect(july.seriesLinkSource).toBe("detected");
    expect(bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, netflix)).get()!.lastMatchedOn).toBe(
      "2026-07-03",
    );
    // a user detach survives the upload
    expect(rowOn("2026-05-03", "NETFLIX").recurringSeriesId).toBeNull();
    // April was already in the ledger: history the upload did not bring in
    expect(rowOn("2026-04-03", "NETFLIX").recurringSeriesId).toBeNull();
  });

  test.each([["dismissed"], ["ended"]] as const)("a %s series takes nothing from an upload", async (status) => {
    await importStatementFiles(bundle.db, [load("chase", Q2)]);
    const parked = registerSeries("Netflix", status);
    setLink(rowOn("2026-06-03", "NETFLIX").id, parked, "user");
    const control = controlSeries();

    await importStatementFiles(bundle.db, [load("chase", JULY)]);

    expect(rowOn("2026-07-03", "NETFLIX").recurringSeriesId).toBeNull();
    expect(rowOn("2026-07-02", "STARBUCKS").recurringSeriesId).toBe(control);
  });

  test("a description two live series both carry is linked to neither", async () => {
    await importStatementFiles(bundle.db, [load("chase", Q2)]);
    const one = registerSeries("Netflix");
    const two = registerSeries("Netflix (second)");
    setLink(rowOn("2026-06-03", "NETFLIX").id, one, "user");
    setLink(rowOn("2026-05-03", "NETFLIX").id, two, "user");
    const control = controlSeries();

    await importStatementFiles(bundle.db, [load("chase", JULY)]);

    expect(rowOn("2026-07-03", "NETFLIX").recurringSeriesId).toBeNull();
    expect(rowOn("2026-07-02", "STARBUCKS").recurringSeriesId).toBe(control);
  });

  test("accepting a gap links the rows it promotes", async () => {
    // The corrupted Discover statement (2024-11-15 → 2024-12-14) quarantines its
    // own rows; the clean statement before it carries the same Spotify charge a
    // month earlier, active. Measured on this fixture before writing the test.
    await importStatementFiles(bundle.db, [
      loadDir("discover", "corrupted")[0]!,
      load("discover", "statements", "discover-card-2024-10-15_2024-11-14.pdf"),
    ]);
    const gap = bundle.db.select().from(statementPeriods).all().find((p) => p.reconciliation === "gap")!;
    expect(gap.periodStart).toBe("2024-11-15");
    const spotifyOn = (day: string) =>
      bundle.db
        .select()
        .from(transactions)
        .all()
        .filter((t) => t.postedOn === day && t.rawDescription.startsWith("SPOTIFY"));
    const [november] = spotifyOn("2024-11-07");
    const [december] = spotifyOn("2024-12-07");
    expect(november!.status).toBe("active");
    expect(december!.status).toBe("quarantined");
    expect(december!.normalizedDescription).toBe(november!.normalizedDescription);
    const spotify = registerSeries("Spotify");
    setLink(november!.id, spotify, "user");

    acceptGap(bundle.db, gap.id);

    const promoted = bundle.db.select().from(transactions).where(eq(transactions.id, december!.id)).get()!;
    expect(promoted.status).toBe("active");
    expect(promoted.recurringSeriesId).toBe(spotify);
    expect(bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, spotify)).get()!.lastMatchedOn).toBe(
      "2024-12-07",
    );
  });

  test("accepting a gap settles a promoted row that already carried its link", async () => {
    // Linking claims UNLINKED rows only, so a row that was attached before the
    // reconcile quarantined it is promoted carrying its series — and nothing
    // would tell that series it counts the charge again.
    await importStatementFiles(bundle.db, [
      loadDir("discover", "corrupted")[0]!,
      load("discover", "statements", "discover-card-2024-10-15_2024-11-14.pdf"),
    ]);
    const gap = bundle.db.select().from(statementPeriods).all().find((p) => p.reconciliation === "gap")!;
    const [december] = bundle.db
      .select()
      .from(transactions)
      .all()
      .filter((t) => t.postedOn === "2024-12-07" && t.rawDescription.startsWith("SPOTIFY"));
    expect(december!.status).toBe("quarantined");
    const spotify = registerSeries("Spotify");
    setLink(december!.id, spotify, "user");

    acceptGap(bundle.db, gap.id);

    expect(bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, spotify)).get()!.lastMatchedOn).toBe(
      "2024-12-07",
    );
  });

  test("un-importing a file resettles every series it takes rows from", async () => {
    // 🔴 `last_matched_on` is written only by recomputeSeriesStats, and a hard
    // delete never called it: the series went on naming a charge that was gone.
    await importStatementFiles(bundle.db, [load("chase", Q2), load("chase", JULY)]);
    const netflix = registerSeries("Netflix");
    attachTransactions(bundle.db, netflix, [rowOn("2026-06-03", "NETFLIX").id, rowOn("2026-07-03", "NETFLIX").id]);
    const lastMatched = () =>
      bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, netflix)).get()!.lastMatchedOn;
    expect(lastMatched()).toBe("2026-07-03");

    const julyFile = bundle.db.select().from(importFilesTable).all().find((f) => f.fileName === JULY)!;
    unimportFile(bundle.db, julyFile.id);

    expect(lastMatched()).toBe("2026-06-03");
  });
});

/**
 * The owner improves a parser and re-drops the same statements: the profile's
 * `version` is what drives the re-parse lifecycle, so bumping it is the whole
 * simulation. Restored afterwards — PROFILES is module-level state.
 */
async function withBumpedParserVersion<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
  const profile = PROFILES.find((p) => p.id === profileId)!;
  const original = profile.version;
  profile.version = original + 1;
  try {
    return await fn();
  } finally {
    profile.version = original;
  }
}

describe("re-parse lifecycle: a parser-version bump preserves user work", () => {
  const cardCsv = (rows: string[]): string =>
    ["Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo", ...rows].join("\n");

  // one file, four rows, each carrying a different kind of user work
  const FILE: ImportInput = {
    name: "Chase7777_Activity_2026.CSV",
    buffer: Buffer.from(
      cardCsv([
        "7777,03/02/2026,03/02/2026,SHELL OIL 555 MIAMI FL,Gas,Sale,-40.00,",
        "7777,03/03/2026,03/03/2026,STARBUCKS STORE 77 MIAMI FL,Food & Drink,Sale,-25.00,",
        "7777,03/04/2026,03/04/2026,AMZN MKTP US*4H2 MIAMI FL,Shopping,Sale,-60.00,",
        "7777,03/05/2026,03/05/2026,NETFLIX.COM LOS GATOS CA,Entertainment,Sale,-15.99,",
      ]),
    ),
  };

  function liveRow(fragment: string): typeof transactions.$inferSelect {
    const row = bundle.db
      .select()
      .from(transactions)
      .where(ne(transactions.status, "superseded"))
      .all()
      .find((r) => r.rawDescription.includes(fragment));
    if (!row) throw new Error(`No live row matching ${fragment}`);
    return row;
  }

  function expenseCategoryIds(count: number): string[] {
    const ids = bundle.db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.kind, "expense"))
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => c.id);
    if (ids.length < count) throw new Error("Seed taxonomy is missing expense categories");
    return ids.slice(0, count);
  }

  /** Import once, then hand-edit each row the way the owner would in the UI. */
  async function seedUserWork(): Promise<{ categoryId: string; splitCategoryIds: string[]; seriesId: string }> {
    await importStatementFiles(bundle.db, [FILE]);
    const [categoryId, splitA, splitB] = expenseCategoryIds(3) as [string, string, string];

    const seriesId = bundle.db
      .insert(recurringSeries)
      .values({ name: "Shell fill-ups", kind: "bill", cadence: "monthly" })
      .returning({ id: recurringSeries.id })
      .get().id;

    // hand-categorized + noted + a user-owned recurring link
    bundle.db
      .update(transactions)
      .set({
        categoryId,
        categorizationSource: "user",
        categorizationConfidence: 1,
        notes: "family car",
        recurringSeriesId: seriesId,
        seriesLinkSource: "user",
      })
      .where(eq(transactions.id, liveRow("SHELL OIL").id))
      .run();

    // split (setSplits stamps the parent user-categorized, as the UI does)
    setSplits(bundle.db, liveRow("STARBUCKS").id, [
      { categoryId: splitA, amountCents: -1500 },
      { categoryId: splitB, amountCents: -1000 },
    ]);

    // transfer-linked (a user-marked self-group keys on the row's own id)
    const amazon = liveRow("AMZN MKTP");
    bundle.db
      .update(transactions)
      .set({ transferGroupId: amazon.id, notes: "paid Carson back" })
      .where(eq(transactions.id, amazon.id))
      .run();

    // user-excluded from analytics
    bundle.db
      .update(transactions)
      .set({ status: "excluded" })
      .where(eq(transactions.id, liveRow("NETFLIX").id))
      .run();

    return { categoryId, splitCategoryIds: [splitA, splitB], seriesId };
  }

  test("category, source, notes, transfer link, recurring link, exclusion and splits all survive", async () => {
    const { categoryId, splitCategoryIds, seriesId } = await seedUserWork();
    const before = {
      shell: liveRow("SHELL OIL"),
      starbucks: liveRow("STARBUCKS"),
      amazon: liveRow("AMZN MKTP"),
      netflix: liveRow("NETFLIX"),
    };

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [FILE]),
    );

    expect(outcome!.status).toBe("parsed");
    expect(outcome!.inserted).toBe(4); // a fresh parse, not a duplicate skip
    expect(outcome!.carriedForward).toBe(4);

    // the old rows are retired, not deleted — the re-parse replaced them
    for (const old of Object.values(before)) {
      const row = bundle.db.select().from(transactions).where(eq(transactions.id, old.id)).get()!;
      expect(row.status).toBe("superseded");
    }

    const shell = liveRow("SHELL OIL");
    expect(shell.id).not.toBe(before.shell.id);
    expect(shell.categoryId).toBe(categoryId);
    expect(shell.categorizationSource).toBe("user");
    expect(shell.notes).toBe("family car");
    expect(shell.recurringSeriesId).toBe(seriesId);
    expect(shell.seriesLinkSource).toBe("user"); // detection must not re-own it

    const amazon = liveRow("AMZN MKTP");
    expect(amazon.transferGroupId).toBe(before.amazon.id);
    expect(amazon.notes).toBe("paid Carson back");

    // a user exclusion is a decision, not a parse artifact — it must not resurrect
    expect(liveRow("NETFLIX").status).toBe("excluded");

    // splits moved wholesale, and the invariant still holds on the new parent
    const starbucks = liveRow("STARBUCKS");
    const parts = listSplits(bundle.db, starbucks.id);
    expect(parts.map((p) => p.categoryId)).toEqual(splitCategoryIds);
    expect(parts.reduce((s, p) => s + p.amountCents, 0)).toBe(starbucks.amountCents);
    expect(starbucks.amountCents).toBe(before.starbucks.amountCents); // parent immutable
    expect(listSplits(bundle.db, before.starbucks.id)).toEqual([]); // and only once
  });

  /*
   * "Uncategorized" picked by hand is written as no category with source `user` (`applyCorrection`), and every engine
   * leaves such a row alone. 🔴 Only a hand category with an id travelled: the fresh row came back NULL/NULL and the bank's
   * "Gas" bucket filled it (the review of uc/final-integrate, 2026-09-16, found the un-import's side of it).
   */
  test("an Uncategorized picked by hand survives, and no engine fills the row", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    bundle.db
      .update(transactions)
      .set({ categoryId: null, categorizationSource: "user", categorizationConfidence: 1, needsReview: false })
      .where(eq(transactions.id, liveRow("SHELL OIL").id))
      .run();

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [FILE]));

    expect(outcome).toMatchObject({ status: "parsed", carriedForward: 1 });
    expect(liveRow("SHELL OIL")).toMatchObject({ categoryId: null, categorizationSource: "user", categorizationConfidence: 1, needsReview: false });
  });

  /*
   * A line the new read prints can be absorbed by a row the owner entered by hand on its day (the same money, other
   * words). That row is the live record of the money now: the note he left on the retired row fills it — only what the
   * row leaves empty, never over his category there.
   * 🔴 The carry retired with its superseded row, and the note was gone (2026-09-17).
   */
  test("a line a hand-entered row absorbs gives that row the retired row's note, and nothing over what it holds", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    const shell = liveRow("SHELL OIL");
    bundle.db.update(transactions).set({ notes: "family car" }).where(eq(transactions.id, shell.id)).run();
    const [categoryId] = expenseCategoryIds(1) as [string];
    const raw = "GAS PAID BY HAND";
    const byHand = bundle.db
      .insert(transactions)
      .values({
        accountId: shell.accountId,
        postedOn: shell.postedOn,
        amountCents: shell.amountCents,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId: shell.accountId, postedOn: shell.postedOn, amountCents: shell.amountCents, rawDescription: raw, occurrenceIndex: 0 }),
        categoryId,
        categorizationSource: "user",
        categorizationConfidence: 1,
      })
      .returning({ id: transactions.id })
      .get().id;

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [FILE]));

    expect(outcome).toMatchObject({ status: "parsed", dedupedCrossFormat: 1, carriedForward: 1 });
    expect(liveRow("GAS PAID BY HAND")).toMatchObject({ id: byHand, notes: "family car", categoryId, categorizationSource: "user" });
    expect(() => liveRow("SHELL OIL")).toThrow();
  });

  test("idempotency: re-importing the identical file at the new version does not double-count", async () => {
    await seedUserWork();
    await withBumpedParserVersion("chase-card-csv", async () => {
      const [first] = await importStatementFiles(bundle.db, [FILE]);
      expect(first!.status).toBe("parsed");
      const after = activeTxnStats("7777");

      const [second] = await importStatementFiles(bundle.db, [FILE]);
      expect(second!.status).toBe("skipped_duplicate");
      expect(second!.carriedForward).toBe(0);
      expect(activeTxnStats("7777")).toEqual(after);
    });

    // three active rows (the fourth stays user-excluded), each exactly once
    const live = bundle.db
      .select()
      .from(transactions)
      .where(ne(transactions.status, "superseded"))
      .all();
    expect(live).toHaveLength(4);
    expect(listSplits(bundle.db, liveRow("STARBUCKS").id)).toHaveLength(2);
  });

  test("a detected category is NOT carried — only a user one is (no frozen stale guess)", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    const shell = liveRow("SHELL OIL");
    const [detectedCategory] = expenseCategoryIds(1) as [string];
    bundle.db
      .update(transactions)
      .set({ categoryId: detectedCategory, categorizationSource: "bank_category", notes: "keep me" })
      .where(eq(transactions.id, shell.id))
      .run();
    // …and detection's category on a row it no longer groups: detection reads that row again
    const starbucks = liveRow("STARBUCKS");
    bundle.db
      .update(transactions)
      .set({ categoryId: detectedCategory, categorizationSource: "transfer_detect" })
      .where(eq(transactions.id, starbucks.id))
      .run();

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [FILE]),
    );
    expect(outcome!.carriedForward).toBe(1); // the note alone is worth carrying

    const fresh = liveRow("SHELL OIL");
    expect(fresh.notes).toBe("keep me");
    expect(fresh.categorizationSource).not.toBe("user"); // re-derived, never upgraded
    // re-derived from what the engines say today, not the stale label
    for (const row of [fresh, liveRow("STARBUCKS")]) {
      expect(row.categorizationSource).not.toBe("bank_category");
      expect(row.categorizationSource).not.toBe("transfer_detect");
      expect(row.categoryId).not.toBe(detectedCategory);
    }
  });

  /**
   * 🔴 Only a hand-set category travelled, and everything else was left to the import's engines to derive again. Two of
   * them never read the row again: Claude (an import never calls it, and it fills only rows no engine categorized) and
   * transfer detection (it pairs only rows with no group, and the group travels). Measured on a copy of the real
   * ledger, 2026-09-16: re-reading the Discover CSV (v1 → v2, the money identical) moved 7 rows' categories — two to
   * none — and re-labelled 485, uncategorized 38 → 40.
   */
  test("a category no import engine derives again — Claude's, or transfer detection's with its pair — is kept", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    const [claudeCategory, transferCategory] = expenseCategoryIds(2) as [string, string];
    const merchantId = bundle.db.insert(merchants).values({ canonicalName: "Claude named this one" }).returning({ id: merchants.id }).get().id;
    const shell = liveRow("SHELL OIL");
    bundle.db
      .update(transactions)
      .set({ categoryId: claudeCategory, categorizationSource: "claude", categorizationConfidence: 0.62, needsReview: true, merchantId })
      .where(eq(transactions.id, shell.id))
      .run();
    const amazon = liveRow("AMZN MKTP");
    const checking = resolveAccount(bundle.db, { institution: "Chase", type: "checking", last4: "9990" });
    const raw = "PAYMENT TO CHASE CARD ENDING IN 7777";
    const partner = bundle.db
      .insert(transactions)
      .values({
        accountId: checking,
        postedOn: amazon.postedOn,
        amountCents: 6000,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId: checking, postedOn: amazon.postedOn, amountCents: 6000, rawDescription: raw, occurrenceIndex: 0 }),
      })
      .returning({ id: transactions.id })
      .get().id;
    bundle.db
      .update(transactions)
      .set({ transferGroupId: amazon.id, categoryId: transferCategory, categorizationSource: "transfer_detect", categorizationConfidence: 0.95 })
      .where(inArray(transactions.id, [amazon.id, partner]))
      .run();

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [FILE]));

    expect(outcome!.inserted).toBe(4);
    expect(liveRow("SHELL OIL")).toMatchObject({
      categoryId: claudeCategory,
      categorizationSource: "claude",
      categorizationConfidence: 0.62,
      needsReview: true,
      merchantId,
    });
    const fresh = liveRow("AMZN MKTP");
    expect(fresh).toMatchObject({ transferGroupId: amazon.id, categoryId: transferCategory, categorizationSource: "transfer_detect" });
    expect(fresh.id).not.toBe(amazon.id);
  });

  test("an engine's category fills the other record of the money a re-read's line dedupes against — only where it is empty", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    const [claudeCategory, transferCategory, handCategory] = expenseCategoryIds(3) as [string, string, string];
    const shell = liveRow("SHELL OIL");
    const amazon = liveRow("AMZN MKTP");
    const starbucks = liveRow("STARBUCKS");
    bundle.db
      .update(transactions)
      .set({ categoryId: claudeCategory, categorizationSource: "claude", categorizationConfidence: 0.4, needsReview: true })
      .where(inArray(transactions.id, [shell.id, starbucks.id]))
      .run();
    bundle.db
      .update(transactions)
      .set({ transferGroupId: amazon.id, categoryId: transferCategory, categorizationSource: "transfer_detect" })
      .where(eq(transactions.id, amazon.id))
      .run();
    // the new version reads both lines' words differently; each is already recorded by a row entered without a file,
    // under the words the new version reads — the SHELL one uncategorized, the AMZN one categorized by an engine
    const reworded = (raw: string) => `${raw} (v2)`;
    const recordedBy = (row: typeof shell, categoryId: string | null) => {
      const raw = reworded(row.rawDescription);
      return bundle.db
        .insert(transactions)
        .values({
          accountId: row.accountId,
          postedOn: row.postedOn,
          transactedOn: row.transactedOn,
          amountCents: row.amountCents,
          rawDescription: raw,
          normalizedDescription: normalizeDescription(raw),
          dedupeHash: dedupeHash({ accountId: row.accountId, postedOn: row.postedOn, amountCents: row.amountCents, rawDescription: raw, occurrenceIndex: 0 }),
          categoryId,
          categorizationSource: categoryId === null ? null : "rule",
        })
        .returning({ id: transactions.id })
        .get().id;
    };
    const shellRecord = recordedBy(shell, null);
    const amazonRecord = recordedBy(amazon, handCategory);
    const starbucksRecord = recordedBy(starbucks, handCategory);
    const csv = PROFILES.find((p) => p.id === "chase-card-csv")!;
    const parse = csv.parse;
    csv.parse = async (file, context) =>
      asParsedFile(await parse(file, context)).statements.map((s) => ({
        ...s,
        txns: s.txns.map((t) => (/SHELL OIL|AMZN MKTP|STARBUCKS/.test(t.rawDescription) ? { ...t, rawDescription: reworded(t.rawDescription) } : t)),
      }));
    try {
      await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [FILE]));
    } finally {
      csv.parse = parse;
    }

    const row = (id: string) => bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect(row(shellRecord)).toMatchObject({ categoryId: claudeCategory, categorizationSource: "claude", needsReview: true, status: "active" });
    // detection's category comes with the group it fills
    expect(row(amazonRecord)).toMatchObject({ transferGroupId: amazon.id, categoryId: transferCategory, categorizationSource: "transfer_detect" });
    // Claude's never replaces a category the other record already has
    expect(row(starbucksRecord)).toMatchObject({ categoryId: handCategory, categorizationSource: "rule", needsReview: false });
  });

  test("a Claude category never outranks one the new parser reads from the file", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    const [categoryId] = expenseCategoryIds(1) as [string];
    const parserPath = "Fees > Bank Fees";
    bundle.db
      .update(transactions)
      .set({ categoryId, categorizationSource: "claude", categorizationConfidence: 0.5 })
      .where(eq(transactions.id, liveRow("SHELL OIL").id))
      .run();
    const csv = PROFILES.find((p) => p.id === "chase-card-csv")!;
    const parse = csv.parse;
    csv.parse = async (file, context) =>
      asParsedFile(await parse(file, context)).statements.map((s) => ({
        ...s,
        txns: s.txns.map((t) => (t.rawDescription.includes("SHELL OIL") ? { ...t, categoryPath: parserPath } : t)),
      }));
    try {
      await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [FILE]));
    } finally {
      csv.parse = parse;
    }
    const fresh = liveRow("SHELL OIL");
    expect(fresh.categorizationSource).toBe("rule");
    expect(fresh.categoryId).not.toBe(categoryId);
  });

  test("two same-day equal-amount rows keep their OWN work — carries never swap", async () => {
    const twins: ImportInput = {
      name: "Chase7788_Activity_2026.CSV",
      buffer: Buffer.from(
        cardCsv([
          "7788,04/01/2026,04/01/2026,SHELL OIL 555 MIAMI FL,Gas,Sale,-30.00,",
          "7788,04/01/2026,04/01/2026,STARBUCKS STORE 77 MIAMI FL,Food & Drink,Sale,-30.00,",
        ]),
      ),
    };
    await importStatementFiles(bundle.db, [twins]);
    for (const [fragment, note] of [
      ["SHELL OIL", "gas note"],
      ["STARBUCKS", "coffee note"],
    ] as const) {
      bundle.db
        .update(transactions)
        .set({ notes: note })
        .where(eq(transactions.id, liveRow(fragment).id))
        .run();
    }

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [twins]),
    );
    expect(outcome!.carriedForward).toBe(2);
    expect(liveRow("SHELL OIL").notes).toBe("gas note");
    expect(liveRow("STARBUCKS").notes).toBe("coffee note");
  });

  test("the money is content-matched even when the fixed parser reads the description differently", async () => {
    const { categoryId } = await seedUserWork();
    // same file bytes are required for the sha-keyed re-parse, so simulate the
    // parser change on the DB side: the old row's raw text no longer matches
    bundle.db
      .update(transactions)
      .set({ rawDescription: "SHELL OIL 555 MIAMI FL ***RAW", normalizedDescription: "SHELL OIL RAW" })
      .where(eq(transactions.id, liveRow("SHELL OIL").id))
      .run();

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [FILE]),
    );
    expect(outcome!.carriedForward).toBe(4);
    // matched on (account, day, amount) — the money, not the text
    const fresh = liveRow("SHELL OIL");
    expect(fresh.rawDescription).toBe("SHELL OIL 555 MIAMI FL");
    expect(fresh.categoryId).toBe(categoryId);
    expect(fresh.notes).toBe("family car");
  });

  /*
   * 🔴 A detach — the owner's "not this one" — is stored as NO series with
   * series_link_source 'user', and the carry travelled only with a series id.
   * On uc/linking (2026-09-14) the fresh row came back NULL/NULL under the new
   * import file, which is the upload's own linking scope, and absorption
   * re-linked it to the very series he had unlinked it from, in that upload.
   * Each test holds a control: the March row's hand link travels, and it is
   * what makes the April description absorbable at all.
   */
  const NETFLIX_CSV: ImportInput = {
    name: "Chase7799_Activity_2026.CSV",
    buffer: Buffer.from(
      cardCsv([
        "7799,03/05/2026,03/05/2026,NETFLIX.COM LOS GATOS CA,Entertainment,Sale,-15.99,",
        "7799,04/05/2026,04/05/2026,NETFLIX.COM LOS GATOS CA,Entertainment,Sale,-15.99,",
      ]),
    ),
  };

  function liveNetflixOn(day: string): typeof transactions.$inferSelect {
    const rows = bundle.db
      .select()
      .from(transactions)
      .where(and(ne(transactions.status, "superseded"), eq(transactions.postedOn, day)))
      .all()
      .filter((r) => r.rawDescription.startsWith("NETFLIX"));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /** March linked to Netflix by hand; April detached by hand. */
  function linkMarchDetachApril(): string {
    const seriesId = bundle.db
      .insert(recurringSeries)
      .values({ name: "Netflix", kind: "subscription", cadence: "monthly", status: "confirmed", intervalDaysAvg: 30 })
      .returning({ id: recurringSeries.id })
      .get().id;
    const set = (day: string, link: string | null) =>
      bundle.db
        .update(transactions)
        .set({ recurringSeriesId: link, seriesLinkSource: "user" })
        .where(eq(transactions.id, liveNetflixOn(day).id))
        .run();
    set("2026-03-05", seriesId);
    set("2026-04-05", null);
    return seriesId;
  }

  test("a detach survives a re-parse — the upload does not re-link what the owner unlinked", async () => {
    await importStatementFiles(bundle.db, [NETFLIX_CSV]);
    const seriesId = linkMarchDetachApril();
    const aprilBefore = liveNetflixOn("2026-04-05");

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [NETFLIX_CSV]),
    );

    expect(outcome!.status).toBe("parsed");
    expect(outcome!.carriedForward).toBe(2); // the link AND the detach
    const april = liveNetflixOn("2026-04-05");
    expect(april.id).not.toBe(aprilBefore.id); // a fresh row, under the new file
    expect(april).toMatchObject({ recurringSeriesId: null, seriesLinkSource: "user" });
    expect(liveNetflixOn("2026-03-05")).toMatchObject({ recurringSeriesId: seriesId, seriesLinkSource: "user" });
  });

  test("a detach survives a takeover — the higher-fidelity successor stays unlinked", async () => {
    await importStatementFiles(bundle.db, [NETFLIX_CSV]);
    const seriesId = linkMarchDetachApril();
    const aprilBefore = liveNetflixOn("2026-04-05");
    // a QFX (higher fidelity) for the same card, covering April 5 only
    const qfx = `OFXHEADER:100

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0
<SEVERITY>INFO
</STATUS>
<FI><ORG>B1
</FI>
<INTU.BID>10898
</SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>00007799
</CCACCTFROM>
<BANKTRANLIST>
<DTSTART>20260405
<DTEND>20260405
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260405
<TRNAMT>-15.99
<FITID>1
<NAME>NETFLIX.COM
<MEMO>NETFLIX.COM LOS GATOS CA
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>100.00
<DTASOF>20260405
</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>
`;

    const [outcome] = await importStatementFiles(bundle.db, [{ name: "Chase7799_Activity_x.QFX", buffer: Buffer.from(qfx) }]);

    expect(outcome!.supersededTakeover).toBe(1);
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, aprilBefore.id)).get()!.status).toBe("superseded");
    const april = liveNetflixOn("2026-04-05");
    expect(april.id).not.toBe(aprilBefore.id);
    // the successor carries the same description the March hand link owns
    expect(april.normalizedDescription).toBe(liveNetflixOn("2026-03-05").normalizedDescription);
    expect(april).toMatchObject({ recurringSeriesId: null, seriesLinkSource: "user" });
    expect(liveNetflixOn("2026-03-05")).toMatchObject({ recurringSeriesId: seriesId, seriesLinkSource: "user" });
  });

  /**
   * 🔴 The carry was keyed on (account, POSTED day, amount) alone. A card
   * statement prints the TRANSACTION day, so a row the ledger held under a
   * later posted day missed its successor. Chase Sapphire's +$100.00 payment
   * (posted 2026-07-01, transacted and printed 06/30, attached to
   * 20260702-statements-9805-.pdf on 2026-09-15) came back from a version bump
   * as a fresh 06/30 row with no transfer link and no note, and Chase Checking's
   * −$100.00 was left grouped with a superseded row — while `ledger-check` stayed
   * green. Measured on a copy of the real ledger, 2026-09-15. The identity match
   * (`identityWeight`) already reads the transaction day for this reason; the carry did not.
   */
  test("a re-parse carries onto the row the file dates by its transaction day, when the old row was posted later", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    // the attached hand row's shape: posted a day after the day the file prints
    const shell = liveRow("SHELL OIL");
    bundle.db
      .update(transactions)
      .set({ postedOn: "2026-03-03", transactedOn: "2026-03-02", notes: "reconstructed leg", transferGroupId: shell.id })
      .where(eq(transactions.id, shell.id))
      .run();
    // the control: a noted row whose posted day the file still prints
    const starbucks = liveRow("STARBUCKS");
    bundle.db.update(transactions).set({ notes: "coffee with Carson" }).where(eq(transactions.id, starbucks.id)).run();

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [FILE]),
    );

    expect(outcome!.status).toBe("parsed");
    expect(outcome!.carriedForward).toBe(2);
    const fresh = liveRow("SHELL OIL");
    expect(fresh.id).not.toBe(shell.id);
    expect(fresh).toMatchObject({ postedOn: "2026-03-02", notes: "reconstructed leg", transferGroupId: shell.id });
    expect(liveRow("STARBUCKS").notes).toBe("coffee with Carson");
  });

  test("the transaction-day carry still needs the same amount on the same transaction day", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    const shell = liveRow("SHELL OIL");
    // SHELL now claims STARBUCKS' transaction day at its own −$40.00: neither
    // STARBUCKS (−$25.00 that day) nor SHELL's successor (a different day) may take it
    bundle.db
      .update(transactions)
      .set({ postedOn: "2026-03-06", transactedOn: "2026-03-03", notes: "wrong day, wrong amount" })
      .where(eq(transactions.id, shell.id))
      .run();

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [FILE]),
    );

    // STARBUCKS is transacted 03/03 at −$25.00; the old SHELL row is 03/03 at −$40.00
    expect(outcome!.carriedForward).toBe(0);
    expect(liveRow("STARBUCKS").notes).toBeNull();
    expect(liveRow("SHELL OIL").notes).toBeNull();
  });

  /**
   * 🔴 A day that prints the SAME amount twice crossed the owner's work. The carry pool held only the rows he had put
   * something on, so a bucket of two charges could hold one row — the OTHER charge's — and the first line printed
   * claimed it on nothing more than a shared prefix (`descriptionScore` 1: "ZELLE PAYMENT FROM ", "CARD PURCHASE ").
   * His category landed on the wrong charge and the right one came back blank. Measured on a copy of the real ledger
   * (2026-09-22): re-reading the archive at the bumped Chase-checking version crossed four pairs, among them the
   * 2023-10-18 +$20.00 Zelle from Adam Godina (Reimbursements, hand-set), which came back on the +$20.00 from Lukas M
   * Iera printed above it.
   */
  test("two charges of one amount on one day keep their own category and note through a re-read", async () => {
    const TWINS: ImportInput = {
      name: "Chase7778_Activity_2026.CSV",
      buffer: Buffer.from(
        cardCsv([
          "7778,03/09/2026,03/09/2026,ZELLE PAYMENT FROM LUKAS M IERA 18760352890,Shopping,Sale,-20.00,",
          "7778,03/09/2026,03/09/2026,ZELLE PAYMENT FROM ADAM GODINA BACLGIXKTRYL,Shopping,Sale,-20.00,",
        ]),
      ),
    };
    await importStatementFiles(bundle.db, [TWINS]);
    const [categoryId] = expenseCategoryIds(1) as [string];
    bundle.db
      .update(transactions)
      .set({ categoryId, categorizationSource: "user", categorizationConfidence: 1, needsReview: false, notes: "Adam paid me back" })
      .where(eq(transactions.id, liveRow("ADAM GODINA").id))
      .run();

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [TWINS]));

    expect(outcome).toMatchObject({ status: "parsed", carriedForward: 1 });
    expect(liveRow("ADAM GODINA")).toMatchObject({ categoryId, categorizationSource: "user", notes: "Adam paid me back" });
    const lukas = liveRow("LUKAS M IERA");
    expect(lukas.notes).toBeNull();
    expect(lukas.categorizationSource).not.toBe("user");
    expect(lukas.categoryId).not.toBe(categoryId);
  });

  /**
   * …and the same day when the new parser rewrites BOTH descriptions past recognition, so neither hash nor words can
   * tell the two charges apart (`descriptionScore` 1 both ways, on the shared "ZELLE PAYMENT " alone). What is left
   * is the seat each charge held in its bucket, in print order — which only exists because a row the owner put
   * nothing on stays in the pool, blank. Drop the blank seats and the first line printed takes the only row left,
   * which is its neighbour's.
   */
  test("…even when neither the hash nor the words can tell the two charges apart", async () => {
    const TWINS: ImportInput = {
      name: "Chase7779_Activity_2026.CSV",
      buffer: Buffer.from(
        cardCsv([
          "7779,03/09/2026,03/09/2026,ZELLE PAYMENT FROM LUKAS M IERA 18760352890,Shopping,Sale,-20.00,",
          "7779,03/09/2026,03/09/2026,ZELLE PAYMENT FROM ADAM GODINA BACLGIXKTRYL,Shopping,Sale,-20.00,",
        ]),
      ),
    };
    await importStatementFiles(bundle.db, [TWINS]);
    const [categoryId] = expenseCategoryIds(1) as [string];
    bundle.db
      .update(transactions)
      .set({ categoryId, categorizationSource: "user", categorizationConfidence: 1, needsReview: false, notes: "Adam paid me back" })
      .where(eq(transactions.id, liveRow("ADAM GODINA").id))
      .run();
    // the words the OLD read gave the two rows, and a hash that no longer matches: the parser change, on the DB side
    for (const [fragment, words] of [["LUKAS M IERA", "ZELLE PAYMENT RECEIVED LUKAS"], ["ADAM GODINA", "ZELLE PAYMENT RECEIVED ADAM"]] as const) {
      const row = liveRow(fragment);
      bundle.db
        .update(transactions)
        .set({ normalizedDescription: words, dedupeHash: `the-old-read-${fragment}` })
        .where(eq(transactions.id, row.id))
        .run();
    }

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [TWINS]));

    expect(outcome).toMatchObject({ status: "parsed", carriedForward: 1 });
    expect(liveRow("ADAM GODINA")).toMatchObject({ categoryId, categorizationSource: "user", notes: "Adam paid me back" });
    const lukas = liveRow("LUKAS M IERA");
    expect(lukas.notes).toBeNull();
    expect(lukas.categorizationSource).not.toBe("user");
    expect(lukas.categoryId).not.toBe(categoryId);
  });

  /**
   * What a version bump does NOT do, as a guard rather than a claim in a commit message. `retiredReadsOf` is keyed on
   * the file's sha256, so a bump re-reads exactly the bytes dropped. Chase regenerates a statement's bytes on every
   * download (scripts/trial-import.ts), so a statement downloaded fresh arrives under a NEW sha: a new import at the
   * new version, never a re-read. Its corrected words are absorbed by the row already stored, which keeps the words
   * the old read gave it. The rows already in the ledger are corrected by re-dropping the ARCHIVED bytes, and by
   * nothing else — a step of the owner's own, never a side effect of an upload.
   */
  test("the same statement downloaded again, under new bytes, is a new import: the stored row keeps the old read's words", async () => {
    await importStatementFiles(bundle.db, [FILE]);
    const stored = liveRow("SHELL OIL");

    // the same month, downloaded again and read by the fixed parser: same money, the description no longer polluted
    const reDownloaded: ImportInput = {
      name: "Chase7777_Activity_2026 (1).CSV",
      buffer: Buffer.from(
        cardCsv([
          "7777,03/02/2026,03/02/2026,SHELL OIL 555 MIAMI FL,Gas,Sale,-40.00,",
          "7777,03/03/2026,03/03/2026,STARBUCKS STORE 77 MIAMI FL,Food & Drink,Sale,-25.00,",
          "7777,03/04/2026,03/04/2026,AMZN MKTP US*4H2 MIAMI FL,Shopping,Sale,-60.00,",
          "7777,03/05/2026,03/05/2026,NETFLIX.COM LOS GATOS CA,Entertainment,Sale,-15.99,",
          "7777,03/06/2026,03/06/2026,MTA*NYCT PAYGO NEW YORK NY,Travel,Sale,-2.90,",
        ]),
      ),
    };
    const [outcome] = await withBumpedParserVersion("chase-card-csv", () => importStatementFiles(bundle.db, [reDownloaded]));

    // read in full at the new version — and NOT as a re-read: the first file's read is still in place, with its rows
    expect(outcome!.status).toBe("parsed");
    expect(outcome!.inserted).toBe(1); // only the line the first download did not print
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, stored.id)).get()!.status).toBe("active");
    expect(liveRow("SHELL OIL").id).toBe(stored.id);
    expect(liveRow("SHELL OIL").rawDescription).toBe(stored.rawDescription);
  });
});

/*
 * 🔴 A parser-version re-read supersedes everything the old version wrote — its
 * rows, its periods, its anchors — and then rebuilt only the accounts the NEW
 * version read. An account the old version wrote and the new one does not (a
 * section it now withholds, as the Robinhood reader withholds #655929651's when
 * it cannot prove it; or one it no longer reads) kept its daily_balances:
 * `anchored` on a day no anchor names, provenance "checked through" a period
 * that no longer exists, and a balance still counting rows that are
 * superseded. The sibling of un-import's `accountsWrittenBy` (9cd7acb), which
 * read the scope before the delete.
 */
describe("a parser-version re-read that no longer writes an account", () => {
  const PREFIX = "three-section-statement-";
  const KEPT = "4101";
  const ANCHOR_ONLY = "4102";
  const WITH_ROWS = "4103";
  const checking = (last4: string): AccountHint => ({ institution: "Chase", type: "checking", last4 });

  /** Each month's three sections, as version 1 reads them. January and March share no anchor day. */
  const SECTIONS: Record<string, ParsedStatement[]> = {
    "2026-01": [
      {
        accountHint: checking(KEPT),
        txns: [{ postedOn: "2026-01-10", amountCents: 1000, rawDescription: "PAYROLL DEPOSIT JAN" }],
        period: { start: "2026-01-01", end: "2026-01-31", beginCents: 0, endCents: 1000 },
      },
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-01-01", end: "2026-01-31", beginCents: 50000, endCents: 50000 } },
      { accountHint: checking(WITH_ROWS), txns: [], period: { start: "2026-01-01", end: "2026-01-31", beginCents: 10000, endCents: 10000 } },
    ],
    "2026-03": [
      {
        accountHint: checking(KEPT),
        txns: [{ postedOn: "2026-03-10", amountCents: 1000, rawDescription: "PAYROLL DEPOSIT MAR" }],
        period: { start: "2026-03-01", end: "2026-03-31", beginCents: 1000, endCents: 2000 },
      },
      // a period and two anchors, and not one row
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-03-01", end: "2026-03-31", beginCents: 50000, endCents: 50000 } },
      {
        accountHint: checking(WITH_ROWS),
        txns: [{ postedOn: "2026-03-12", amountCents: -4000, rawDescription: "SHELL OIL 555 MIAMI FL" }],
        period: { start: "2026-03-01", end: "2026-03-31", beginCents: 10000, endCents: 6000 },
      },
    ],
    // a declared range and no balance, as an OFX's DTSTART/DTEND: it ends on January's closing day and prints nothing
    "2026-01 declared": [{ accountHint: checking(KEPT), txns: [], declaredRange: { start: "2026-01-01", end: "2026-01-31" } }],
    // a statement of part of March, on one account
    "2026-03 rival": [
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-03-10", end: "2026-03-20", beginCents: 50000, endCents: 50000 } },
    ],
    // one file, one account, two statements: a May of its own, then March's window again
    "2026-05 and 2026-03": [
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-05-01", end: "2026-05-31", beginCents: 50000, endCents: 50000 } },
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-03-01", end: "2026-03-31", beginCents: 50000, endCents: 50000 } },
    ],
    // …and the same on the account with a row
    "2026-03 then 2026-05, with a row": [
      {
        accountHint: checking(WITH_ROWS),
        txns: [{ postedOn: "2026-03-12", amountCents: -4000, rawDescription: "SHELL OIL 555 MIAMI FL" }],
        period: { start: "2026-03-01", end: "2026-03-31", beginCents: 10000, endCents: 6000 },
      },
      { accountHint: checking(WITH_ROWS), txns: [], period: { start: "2026-05-01", end: "2026-05-31", beginCents: 6000, endCents: 6000 } },
    ],
    // one file, one account, two statements: March's window, then a May — read in the other order by `readsInReverse`
    "2026-03 then 2026-05": [
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-03-01", end: "2026-03-31", beginCents: 50000, endCents: 50000 } },
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-05-01", end: "2026-05-31", beginCents: 50000, endCents: 50000 } },
    ],
    // imported only where a test says so: it opens the day after March closes, on one account
    "2026-04": [
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-04-01", end: "2026-04-30", beginCents: 50000, endCents: 50000 } },
    ],
    // March reissued: the same periods and balances, and no payroll line
    "2026-03 reissue": [
      { accountHint: checking(KEPT), txns: [], period: { start: "2026-03-01", end: "2026-03-31", beginCents: 1000, endCents: 2000 } },
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-03-01", end: "2026-03-31", beginCents: 50000, endCents: 50000 } },
      {
        accountHint: checking(WITH_ROWS),
        txns: [{ postedOn: "2026-03-12", amountCents: -4000, rawDescription: "SHELL OIL 555 MIAMI FL" }],
        period: { start: "2026-03-01", end: "2026-03-31", beginCents: 10000, endCents: 6000 },
      },
    ],
    // imported only where a test says so: March of one account, as a statement of that account alone
    "2026-03 kept only": [
      {
        accountHint: checking(KEPT),
        txns: [{ postedOn: "2026-03-10", amountCents: 1000, rawDescription: "PAYROLL DEPOSIT MAR" }],
        period: { start: "2026-03-01", end: "2026-03-31", beginCents: 1000, endCents: 2000 },
      },
    ],
    "2026-03 anchor only": [
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-03-01", end: "2026-03-31", beginCents: 50000, endCents: 50000 } },
    ],
    // imported only where a test says so: it shares January's closing day and March's opening day
    "2026-02": [
      { accountHint: checking(KEPT), txns: [], period: { start: "2026-02-01", end: "2026-02-28", beginCents: 1000, endCents: 1000 } },
      { accountHint: checking(ANCHOR_ONLY), txns: [], period: { start: "2026-02-01", end: "2026-02-28", beginCents: 50000, endCents: 50000 } },
      { accountHint: checking(WITH_ROWS), txns: [], period: { start: "2026-02-01", end: "2026-02-28", beginCents: 10000, endCents: 10000 } },
    ],
  };

  /** A section of a new account, and after it one the import cannot store: its institution is not one the app knows. */
  const BREAKS_MID_FILE: ParsedStatement[] = [
    { accountHint: checking("4104"), txns: [{ postedOn: "2026-03-15", amountCents: -700, rawDescription: "NEW ACCOUNT CHARGE" }] },
    { accountHint: { institution: "Nowhere Bank" as AccountHint["institution"], type: "checking", last4: "4199" }, txns: [] },
  ];

  let unreadable = false;
  /** a later version that reads every section again */
  let readsEverySection = false;
  /** a later version that reads the first section and then fails part-way through the file */
  let breaksMidFile = false;
  /** a later version that reads every section again, the last first */
  let readsInReverse = false;
  /** a later version that reads the first section and leaves the others out without a word */
  let stopsReadingOthers = false;

  /** Version 1 reads all three sections; a later version reads the first and withholds the other two. */
  const threeSectionProfile: ParserProfile = {
    id: "test-three-section-statement",
    version: 1,
    matches: (f) => f.name.startsWith(PREFIX),
    parse: (f): ParsedStatement[] | ParsedFile => {
      if (unreadable) throw new ParseError("test-three-section-statement", "this version cannot read the file");
      // trimmed: a second copy of a month is the same text with different bytes
      const [kept, ...rest] = SECTIONS[f.text.trim()]!;
      if (threeSectionProfile.version > 1 && readsInReverse) return [kept!, ...rest].reverse();
      if (threeSectionProfile.version === 1 || readsEverySection) return [kept!, ...rest];
      if (breaksMidFile) return [kept!, ...BREAKS_MID_FILE];
      if (stopsReadingOthers) return [kept!];
      return {
        statements: [kept!],
        withheld: rest.map((s) => ({
          accountHint: s.accountHint,
          accountNumber: `XXXXXX${s.accountHint.last4}`,
          period: { start: s.period!.start, end: s.period!.end },
          reason: "this version cannot prove the section",
        })),
      };
    },
  };

  beforeEach(() => {
    unreadable = false;
    readsEverySection = false;
    breaksMidFile = false;
    readsInReverse = false;
    stopsReadingOthers = false;
    threeSectionProfile.version = 1;
    PROFILES.unshift(threeSectionProfile);
  });

  afterEach(() => {
    PROFILES.splice(PROFILES.indexOf(threeSectionProfile), 1);
  });

  const statementFor = (month: string): ImportInput => ({ name: `${PREFIX}${month}.txt`, buffer: Buffer.from(month) });
  const JANUARY = statementFor("2026-01");
  const MARCH = statementFor("2026-03");

  function accountIdOf(last4: string): string {
    return bundle.db.select().from(accounts).where(eq(accounts.last4, last4)).get()!.id;
  }

  function dayRows(accountId: string) {
    return bundle.db
      .select({ day: dailyBalances.day, balanceCents: dailyBalances.balanceCents, basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, accountId))
      .orderBy(dailyBalances.day)
      .all();
  }

  const dayRow = (accountId: string, day: string) => dayRows(accountId).find((r) => r.day === day);

  /** The cache is exactly what a rebuild from what is left would write. */
  function expectRebuilt(accountId: string): void {
    const left = dayRows(accountId);
    rebuildAccount(bundle.db, accountId);
    expect(left).toEqual(dayRows(accountId));
  }

  test("an account the new version withholds is rebuilt: no anchored day it no longer has, no row it superseded", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    const anchorOnly = accountIdOf(ANCHOR_ONLY);
    const withRows = accountIdOf(WITH_ROWS);
    // the premise: March gave one account only a period and anchors, the other a row as well, and both read checked
    expect(bundle.db.select().from(transactions).where(eq(transactions.accountId, anchorOnly)).all()).toEqual([]);
    expect(dayRow(anchorOnly, "2026-03-31")).toMatchObject({ basis: "anchored", balanceCents: 50000 });
    expect(dayRow(withRows, "2026-03-31")).toMatchObject({ basis: "anchored", balanceCents: 6000 });
    expect(provenanceFor(bundle.db, { kind: "accountBalance", accountId: anchorOnly })!.checkedThrough).toBe("2026-03-31");

    threeSectionProfile.version = 2;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    // the premise: a fresh read that left the two sections out, not a duplicate skip…
    expect(outcome!.status).toBe("parsed");
    expect(outcome!.withheld.map((w) => w.accountId)).toEqual([anchorOnly, withRows]);
    // …so March's anchors on both accounts are gone, and January's stay
    const anchorDays = (accountId: string) =>
      bundle.db
        .select({ day: balanceAnchors.anchoredOn })
        .from(balanceAnchors)
        .where(eq(balanceAnchors.accountId, accountId))
        .all()
        .map((a) => a.day)
        .sort();
    expect(anchorDays(anchorOnly)).toEqual(["2025-12-31", "2026-01-31"]);
    expect(anchorDays(withRows)).toEqual(["2025-12-31", "2026-01-31"]);

    // no day is still `anchored` on March's anchors…
    expect(dayRow(anchorOnly, "2026-02-28")?.basis).not.toBe("anchored");
    expect(dayRow(anchorOnly, "2026-03-31")?.basis).not.toBe("anchored");
    expect(dayRow(withRows, "2026-03-31")?.basis).not.toBe("anchored");
    // …the −$40.00 the re-read superseded is out of the balance…
    expect(dayRow(withRows, "2026-03-31")?.balanceCents).toBe(10000);
    // …and the chain is checked through January, the last statement the account still has
    expect(provenanceFor(bundle.db, { kind: "accountBalance", accountId: anchorOnly })!.checkedThrough).toBe("2026-01-31");
    expectRebuilt(anchorOnly);
    expectRebuilt(withRows);
    expectRebuilt(accountIdOf(KEPT));
  });

  const FEBRUARY = statementFor("2026-02");
  /** March downloaded a second time: the same statement in different bytes */
  const MARCH_COPY: ImportInput = { name: `${PREFIX}2026-03 (1).txt`, buffer: Buffer.from("2026-03\n") };

  const row = (id: string) => bundle.db.select().from(transactions).where(eq(transactions.id, id)).get();

  /** The one read of a file in place — neither superseded nor failed. */
  function liveFile(input: ImportInput): typeof importFilesTable.$inferSelect {
    const live = bundle.db
      .select()
      .from(importFilesTable)
      .where(and(eq(importFilesTable.fileName, input.name), eq(importFilesTable.status, "parsed")))
      .all();
    expect(live).toHaveLength(1);
    return live[0]!;
  }

  /** Everything one read of a file wrote: its rows, its periods, its anchors. */
  function contributionOf(fileId: string) {
    return {
      rows: bundle.db.select().from(transactions).where(eq(transactions.importFileId, fileId)).orderBy(transactions.id).all(),
      periods: bundle.db.select().from(statementPeriods).where(eq(statementPeriods.importFileId, fileId)).orderBy(statementPeriods.id).all(),
      anchors: bundle.db.select().from(balanceAnchors).where(eq(balanceAnchors.importFileId, fileId)).orderBy(balanceAnchors.id).all(),
    };
  }

  const periodOf = (fileId: string, accountId: string) =>
    bundle.db
      .select()
      .from(statementPeriods)
      .where(and(eq(statementPeriods.importFileId, fileId), eq(statementPeriods.accountId, accountId)))
      .get();

  const statementAnchorOn = (accountId: string, day: string) =>
    bundle.db
      .select()
      .from(balanceAnchors)
      .where(and(eq(balanceAnchors.accountId, accountId), eq(balanceAnchors.anchoredOn, day), eq(balanceAnchors.source, "statement")))
      .get();

  const HAND_NOTE = "the car, paid at the pump";

  /**
   * The owner's shape (scripts/attach-sapphire-payment-rows-2026-09-14.ts): a payment recorded by hand absorbs March's
   * line for the same money, and is then filed under March.
   */
  async function marchWithARowFiledByHand(): Promise<{ march: string; withRows: string; handRow: string }> {
    await importStatementFiles(bundle.db, [JANUARY]);
    const withRows = accountIdOf(WITH_ROWS);
    const raw = "FUEL — recorded by hand";
    const handRow = bundle.db
      .insert(transactions)
      .values({
        accountId: withRows,
        postedOn: "2026-03-12",
        amountCents: -4000,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId: withRows, postedOn: "2026-03-12", amountCents: -4000, rawDescription: raw, occurrenceIndex: 0 }),
        notes: HAND_NOTE,
      })
      .returning({ id: transactions.id })
      .get().id;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);
    expect(outcome!.dedupedCrossFormat).toBe(1);
    const march = liveFile(MARCH).id;
    bundle.db.update(transactions).set({ importFileId: march, fileLinkSource: "attached" }).where(eq(transactions.id, handRow)).run();
    expect(periodOf(march, withRows)!.reconciliation).toBe("reconciled");
    expect(dayRow(withRows, "2026-03-31")).toMatchObject({ basis: "anchored", balanceCents: 6000 });
    return { march, withRows, handRow };
  }

  /**
   * 🔴 The retired read was superseded BEFORE the new version parsed, so a version that cannot read the file had
   * already taken the file's rows, periods and anchors away — the rows the owner filed under it by hand with them,
   * against his 2026-09-15 rule. Uploading the bytes again failed again, and un-importing the failed row brought
   * nothing back. Measured on a copy of the real ledger, 2026-09-16 (the review of uc/reparse-rebuild-scope): a
   * throwing re-read of the January 2026 Sapphire statement superseded its 4 attached payments ($1,223.54).
   */
  test("a re-read the new version cannot parse changes nothing: the read it would replace stays, with the row filed under it by hand", async () => {
    const { march, withRows, handRow } = await marchWithARowFiledByHand();
    const before = contributionOf(march);
    expect(before.rows.map((r) => r.id)).toContain(handRow);

    threeSectionProfile.version = 2;
    unreadable = true;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("failed");
    expect(liveFile(MARCH).id).toBe(march);
    expect(contributionOf(march)).toEqual(before);
    expect(row(handRow)).toMatchObject({ status: "active", importFileId: march, fileLinkSource: "attached", notes: HAND_NOTE });
    expect(dayRow(withRows, "2026-03-31")).toMatchObject({ basis: "anchored", balanceCents: 6000 });
    for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) expectRebuilt(accountIdOf(last4));
    // …and the failure says so, beside the read still in place
    expect(outcome!.error).toContain("the earlier read of this file is still in place");

    // the failed attempt is no obstacle: once the version reads the file, the same bytes replace the read
    unreadable = false;
    readsEverySection = true;
    const [again] = await importStatementFiles(bundle.db, [MARCH]);

    expect(again!.status).toBe("parsed");
    expect(liveFile(MARCH).id).not.toBe(march);
    const recording = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, withRows), ne(transactions.status, "superseded")))
      .all();
    expect(recording).toHaveLength(1);
    expect(recording[0]).toMatchObject({ amountCents: -4000, fileLinkSource: "attached", notes: HAND_NOTE, status: "active" });
    for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) expectRebuilt(accountIdOf(last4));
  });

  /**
   * 🔴 A row filed under a statement by hand survived a re-read only through the carry, which lands on a row the new
   * read inserts — so a read that withholds the section superseded it with no successor. Measured on a copy of the
   * real ledger, 2026-09-16: the January 2026 Sapphire statement re-read with Sapphire's section withheld reported
   * `parsed` and superseded the same 4 payments.
   */
  test("a re-read that withholds a section keeps the row filed under it by hand, detached, and a read of the section files it there again", async () => {
    const { withRows, handRow } = await marchWithARowFiledByHand();

    threeSectionProfile.version = 2;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("parsed");
    expect(outcome!.withheld.map((w) => w.accountId)).toContain(withRows);
    // kept as an un-import keeps it: no statement in place holds March 12 on this account now
    expect(row(handRow)).toMatchObject({ status: "active", importFileId: null, fileLinkSource: "attached", notes: HAND_NOTE });
    // …and its money is still in the balance
    expect(dayRow(withRows, "2026-03-31")?.balanceCents).toBe(6000);
    expectRebuilt(withRows);

    threeSectionProfile.version = 3;
    readsEverySection = true;
    const [again] = await importStatementFiles(bundle.db, [MARCH]);

    expect(again!.status).toBe("parsed");
    const reread = liveFile(MARCH).id;
    // the section's line is absorbed by the kept row, which is filed under the section again — once
    expect(row(handRow)).toMatchObject({ status: "active", importFileId: reread, fileLinkSource: "attached", notes: HAND_NOTE });
    const recording = bundle.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.accountId, withRows), ne(transactions.status, "superseded")))
      .all();
    expect(recording.map((t) => t.id)).toEqual([handRow]);
    expect(periodOf(reread, withRows)!.reconciliation).toBe("reconciled");
    expect(dayRow(withRows, "2026-03-31")).toMatchObject({ basis: "anchored", balanceCents: 6000 });
    expectRebuilt(withRows);
  });

  /**
   * ⚖️ Owner, 2026-09-16 (decision 16): when a newer parser version stops reading an account a statement used to give
   * it, the rows filed under the statement by hand on that account are detached and kept — money, transfer, recurring
   * link, category and note — as an un-import keeps them; they are not retired with the old read. Here the new
   * version says nothing about the two sections it leaves out (no withheld notice), unlike the test above.
   */
  test("a re-read that stops reading an account, without a word, keeps the row filed under it by hand with everything on it", async () => {
    const { withRows, handRow } = await marchWithARowFiledByHand();
    const { id: chase } = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const other = createAccount(bundle.db, { institutionId: chase, name: "Hand savings", type: "savings" });
    const raw = "FROM CHECKING — recorded by hand";
    const partner = bundle.db
      .insert(transactions)
      .values({
        accountId: other,
        postedOn: "2026-03-12",
        amountCents: 4000,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId: other, postedOn: "2026-03-12", amountCents: 4000, rawDescription: raw, occurrenceIndex: 0 }),
        transferGroupId: handRow,
      })
      .returning({ id: transactions.id })
      .get().id;
    const series = bundle.db
      .insert(recurringSeries)
      .values({ name: "Fuel", kind: "bill", cadence: "monthly", status: "confirmed" })
      .returning({ id: recurringSeries.id })
      .get().id;
    const groceries = bundle.db.select().from(categories).where(eq(categories.name, "Groceries")).get()!.id;
    bundle.db
      .update(transactions)
      .set({ transferGroupId: handRow, recurringSeriesId: series, seriesLinkSource: "user", categoryId: groceries, categorizationSource: "user" })
      .where(eq(transactions.id, handRow))
      .run();
    const kept = row(handRow)!;

    threeSectionProfile.version = 2;
    stopsReadingOthers = true;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    // the premise: the new read left the section out and said nothing about it
    expect(outcome).toMatchObject({ status: "parsed", withheld: [] });
    expect(periodOf(liveFile(MARCH).id, withRows)).toBeUndefined();
    // kept as an un-import keeps it: detached, and nothing else on it moved
    expect(row(handRow)).toEqual({ ...kept, importFileId: null, updatedAt: row(handRow)!.updatedAt });
    expect(row(partner)).toMatchObject({ status: "active", transferGroupId: handRow });
    expect(dayRow(withRows, "2026-03-31")?.balanceCents).toBe(6000);
    expectRebuilt(withRows);
  });

  /** A statement of another account printing the other leg of the hand row's transfer. */
  const PARTNER_PREFIX = "transfer-partner-";
  const partnerProfile: ParserProfile = {
    id: "test-transfer-partner",
    version: 1,
    matches: (f) => f.name.startsWith(PARTNER_PREFIX),
    parse: () => [
      {
        accountHint: checking("4106"),
        txns: [{ postedOn: "2026-03-12", amountCents: 4000, rawDescription: "TRANSFER FROM 4103" }],
        period: { start: "2026-03-01", end: "2026-03-31", beginCents: 0, endCents: 4000 },
      },
    ],
  };
  const PARTNER: ImportInput = { name: `${PARTNER_PREFIX}2026-03.txt`, buffer: Buffer.from("partner") };

  /**
   * The row filed by hand is one leg of a transfer whose other leg's statement was un-imported: the transfer waits for
   * that line, by the hand row's id (`unimported-transfers`). A re-read of March then writes the hand row's line again
   * (the carry moves the marker onto the row it writes) or stops reading its account (the row is kept); either way the
   * other statement's return links the transfer again.
   */
  test.each([
    ["stops reading the account", true],
    ["reads the account again", false],
  ])("a transfer waiting on the row filed by hand is linked again after a re-read that %s", async (_, stops) => {
    PROFILES.unshift(partnerProfile);
    try {
      const { withRows, handRow } = await marchWithARowFiledByHand();
      await importStatementFiles(bundle.db, [PARTNER]);
      const leg = bundle.db.select().from(transactions).where(eq(transactions.accountId, accountIdOf("4106"))).get()!;
      for (const id of [handRow, leg.id]) {
        bundle.db.update(transactions).set({ transferGroupId: handRow }).where(eq(transactions.id, id)).run();
      }
      unimportFile(bundle.db, liveFile(PARTNER).id);
      // the premise: the hand row is alone, and the transfer waits for the other leg's line
      expect(row(handRow)!.transferGroupId).toBeNull();
      expect(bundle.db.select().from(unimportedTransferLegs).all().map((k) => k.transactionId).sort()).toEqual([handRow, null].sort());

      threeSectionProfile.version = 2;
      stopsReadingOthers = stops;
      readsEverySection = !stops;
      await importStatementFiles(bundle.db, [MARCH]);
      // the row that records the hand payment now, filed by hand: the kept row, or the row the re-read wrote for it
      const [hand, ...more] = bundle.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.accountId, withRows), ne(transactions.status, "superseded")))
        .all();
      expect(more).toEqual([]);
      expect(hand).toMatchObject({ amountCents: -4000, fileLinkSource: "attached", notes: HAND_NOTE, status: "active" });

      await importStatementFiles(bundle.db, [PARTNER]);

      const back = bundle.db.select().from(transactions).where(eq(transactions.accountId, accountIdOf("4106"))).get()!;
      expect(back.transferGroupId).not.toBeNull();
      expect(row(hand!.id)!.transferGroupId).toBe(back.transferGroupId);
      expect(bundle.db.select().from(unimportedTransferLegs).all()).toEqual([]);
    } finally {
      PROFILES.splice(PROFILES.indexOf(partnerProfile), 1);
    }
  });

  test("a transfer waiting on a row a re-read hands to a second download is linked again when the other leg returns", async () => {
    PROFILES.unshift(partnerProfile);
    try {
      await importStatementFiles(bundle.db, [JANUARY, MARCH, PARTNER]);
      const withRows = accountIdOf(WITH_ROWS);
      const shell = contributionOf(liveFile(MARCH).id).rows.find((r) => r.accountId === withRows)!;
      const leg = bundle.db.select().from(transactions).where(eq(transactions.accountId, accountIdOf("4106"))).get()!;
      const { linkTransferPair } = await import("@/services/transfer-links");
      linkTransferPair(bundle.db, shell.id, leg.id);
      unimportFile(bundle.db, liveFile(PARTNER).id);
      await importStatementFiles(bundle.db, [MARCH_COPY]);
      // the premise: the transfer waits by the statement's row
      expect(bundle.db.select().from(unimportedTransferLegs).all().map((k) => k.transactionId).sort()).toEqual([shell.id, null].sort());

      threeSectionProfile.version = 2;
      stopsReadingOthers = true;
      await importStatementFiles(bundle.db, [MARCH]);
      expect(row(shell.id)).toMatchObject({ status: "active", importFileId: liveFile(MARCH_COPY).id });
      expect(bundle.db.select().from(unimportedTransferLegs).all().map((k) => k.transactionId).sort()).toEqual([shell.id, null].sort());

      await importStatementFiles(bundle.db, [PARTNER]);

      const back = bundle.db.select().from(transactions).where(eq(transactions.accountId, accountIdOf("4106"))).get()!;
      expect(row(shell.id)!.transferGroupId).toBe(shell.id);
      expect(back.transferGroupId).toBe(shell.id);
      expect(bundle.db.select().from(unimportedTransferLegs).all()).toEqual([]);
    } finally {
      PROFILES.splice(PROFILES.indexOf(partnerProfile), 1);
    }
  });

  test("a row filed by hand that the retired read's gap held comes back active, and one the owner excluded stays excluded", async () => {
    const { march, withRows, handRow } = await marchWithARowFiledByHand();
    // the retired period's verdict on a hand row, as `reconcileAccounts` leaves it after a gap
    bundle.db.update(transactions).set({ status: "quarantined" }).where(eq(transactions.id, handRow)).run();
    const raw = "PARKING — recorded by hand";
    const excluded = bundle.db
      .insert(transactions)
      .values({
        accountId: withRows,
        postedOn: "2026-03-20",
        amountCents: -900,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId: withRows, postedOn: "2026-03-20", amountCents: -900, rawDescription: raw, occurrenceIndex: 0 }),
        status: "excluded",
        importFileId: march,
        fileLinkSource: "attached",
      })
      .returning({ id: transactions.id })
      .get().id;

    threeSectionProfile.version = 2;
    await importStatementFiles(bundle.db, [MARCH]);

    expect(row(handRow)).toMatchObject({ status: "active", importFileId: null, fileLinkSource: "attached" });
    expect(row(excluded)).toMatchObject({ status: "excluded", importFileId: null, fileLinkSource: "attached" });
    expectRebuilt(withRows);
  });

  /**
   * A re-read that fails part-way through the file wrote its earlier sections and had already retired the read they
   * replace, and "un-import to clean up" removed the partial read without bringing the retired one back.
   */
  test("a re-read that fails part-way through the file keeps none of it, and the read it would replace stays in place", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    const march = liveFile(MARCH).id;
    const before = contributionOf(march);

    threeSectionProfile.version = 2;
    breaksMidFile = true;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("failed");
    expect(outcome!.error).toContain("Unknown institution Nowhere Bank");
    const [failed, ...more] = bundle.db
      .select()
      .from(importFilesTable)
      .where(and(eq(importFilesTable.fileName, MARCH.name), eq(importFilesTable.status, "failed")))
      .all();
    expect(more).toEqual([]);
    expect(contributionOf(failed!.id)).toEqual({ rows: [], periods: [], anchors: [] });
    expect(liveFile(MARCH).id).toBe(march);
    expect(contributionOf(march)).toEqual(before);
    // the section of a new account was written inside the same failed read: its account is not left behind either
    expect(bundle.db.select().from(accounts).where(eq(accounts.last4, "4104")).get()).toBeUndefined();
    for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) expectRebuilt(accountIdOf(last4));
    // "un-import to clean up" would be wrong: there is nothing to clean, and the read in place is the earlier one
    expect(failed!.error).toContain("the earlier read of this file is still in place");
  });

  /**
   * 🔴 The rebuild scope reads three legs, and the tests above give every account the retired read wrote a period and
   * anchors, so a scope that left out the rows leg — or read anchors alone — passed them all (the review, 2026-09-16).
   * A read that gives an account only rows is an export, whose balance another file's statements anchor (on the real
   * ledger: the Discover CSV and 4 Robinhood activity CSVs); one that gives it only a balance is an OFX ledger.
   */
  test("an account the retired read gave only rows, or only a ledger balance, is rebuilt when the new read stops reading it", async () => {
    const EXPORT: ImportInput = { name: "three-section-activity.csv", buffer: Buffer.from("April activity") };
    const LEDGER_ONLY = "4105";
    const exportProfile: ParserProfile = {
      id: "test-three-section-activity",
      version: 1,
      matches: (f) => f.name === EXPORT.name,
      parse: (): ParsedStatement[] => {
        const kept: ParsedStatement = {
          accountHint: checking(KEPT),
          txns: [{ postedOn: "2026-04-06", amountCents: 500, rawDescription: "INTEREST APR" }],
        };
        if (exportProfile.version > 1) return [kept];
        return [
          kept,
          { accountHint: checking(WITH_ROWS), txns: [{ postedOn: "2026-04-05", amountCents: -1500, rawDescription: "COFFEE APR" }] },
          // an account no statement anchors: a ledger balance carries the curve only where nothing chain-grade does
          { accountHint: checking(LEDGER_ONLY), txns: [], ledger: { asOf: "2026-04-15", cents: 49000 } },
        ];
      },
    };
    PROFILES.unshift(exportProfile);
    try {
      await importStatementFiles(bundle.db, [JANUARY, MARCH, EXPORT]);
      const withRows = accountIdOf(WITH_ROWS);
      const ledgerOnly = accountIdOf(LEDGER_ONLY);
      const exported = contributionOf(liveFile(EXPORT).id);
      // the premise: the export gave one account a row and nothing else, the other a balance and nothing else
      expect(exported.periods).toEqual([]);
      expect(exported.rows.filter((t) => t.accountId === ledgerOnly)).toEqual([]);
      expect(exported.anchors.map((a) => [a.accountId, a.source])).toEqual([[ledgerOnly, "ofx_ledger"]]);
      expect(dayRow(withRows, "2026-04-05")?.balanceCents).toBe(4500);
      expect(dayRow(ledgerOnly, "2026-04-15")).toMatchObject({ basis: "anchored", balanceCents: 49000 });

      exportProfile.version = 2;
      const [outcome] = await importStatementFiles(bundle.db, [EXPORT]);

      expect(outcome!.status).toBe("parsed");
      expect(dayRow(withRows, "2026-04-05")?.balanceCents).toBe(6000);
      // no balance was ever recorded for it but the one the retired read took away
      expect(dayRows(ledgerOnly)).toEqual([]);
      expectRebuilt(withRows);
      expectRebuilt(ledgerOnly);
    } finally {
      PROFILES.splice(PROFILES.indexOf(exportProfile), 1);
    }
  });

  /**
   * The third leg. A retired read can name an account by its period alone: it gave the account no row, and its two
   * anchors belong to the statements on either side of it, imported after it (the day before it opens is February's
   * closing day, the day it closes is the day before April opens). The account's balances do not move, but a row
   * filed by hand that the retired period and another statement both held — ambiguous, so left detached — is held by
   * one statement now, and the import files it again only on an account in its scope.
   *
   * (A second download imported after it would own those anchors too — and it prints the month, so the period goes to
   * it: `lendToCopies`, the test after this one.)
   */
  test("an account the retired read gave only a period is in the scope too: a row filed by hand that two statements held is filed under the one left", async () => {
    const RIVAL = statementFor("2026-03 rival");
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [FEBRUARY]);
    await importStatementFiles(bundle.db, [statementFor("2026-04")]);
    await importStatementFiles(bundle.db, [RIVAL]);
    const anchorOnly = accountIdOf(ANCHOR_ONLY);
    const march = liveFile(MARCH).id;
    // the premise: March names this account through its period and nothing else
    expect(contributionOf(march).rows.filter((t) => t.accountId === anchorOnly)).toEqual([]);
    expect(contributionOf(march).anchors.filter((a) => a.accountId === anchorOnly)).toEqual([]);
    expect(periodOf(march, anchorOnly)).toBeDefined();
    const raw = "CASH DEPOSIT — recorded by hand";
    const handRow = bundle.db
      .insert(transactions)
      .values({
        accountId: anchorOnly,
        postedOn: "2026-03-15",
        amountCents: 2500,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId: anchorOnly, postedOn: "2026-03-15", amountCents: 2500, rawDescription: raw, occurrenceIndex: 0 }),
        fileLinkSource: "attached",
      })
      .returning({ id: transactions.id })
      .get().id;

    threeSectionProfile.version = 2;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("parsed");
    // (its status is now the rival statement's verdict, which this fixture's balances do not close)
    expect(row(handRow)).toMatchObject({ importFileId: liveFile(RIVAL).id, fileLinkSource: "attached" });
    expectRebuilt(anchorOnly);
  });

  /**
   * 🔴 A second download adopts the first download's period and takes over every balance it prints. Retiring or
   * un-importing the first took the period away while the copy, still imported, printed the month — its balances left
   * standing with nothing to reconcile them, and a brokerage book's month no longer standing on the months before it
   * (agentic-book.test.ts).
   */
  test("a re-read that no longer writes an account hands the period to a second download that prints it", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const anchorOnly = accountIdOf(ANCHOR_ONLY);
    const copy = liveFile(MARCH_COPY).id;
    // the premise: the copy owns March's balances on the account and no period
    expect(statementAnchorOn(anchorOnly, "2026-03-31")!.importFileId).toBe(copy);
    expect(periodOf(copy, anchorOnly)).toBeUndefined();
    const period = periodOf(liveFile(MARCH).id, anchorOnly)!;

    threeSectionProfile.version = 2;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.withheld.map((w) => w.accountId)).toContain(anchorOnly);
    // the same period, the copy's now — with the balances it owned
    expect(periodOf(copy, anchorOnly)).toMatchObject({ id: period.id, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    expect(statementAnchorOn(anchorOnly, "2026-03-31")).toMatchObject({ importFileId: copy, statementPeriodId: period.id });
    expect(provenanceFor(bundle.db, { kind: "accountBalance", accountId: anchorOnly })!.checkedThrough).toBe("2026-03-31");
    expectRebuilt(anchorOnly);

    // …and the /imports confirmation of the copy counts the periods its un-import now removes: both withheld accounts'
    const { unimportPeriodsByFile } = await import("./unimport-counts");
    expect(unimportPeriodsByFile(bundle.db).get(copy)).toEqual({ removed: 2, handedOver: 0 });
    unimportFile(bundle.db, copy);
    expect(bundle.db.select().from(statementPeriods).where(eq(statementPeriods.id, period.id)).get()).toBeUndefined();
  });

  /**
   * ⚖️ Owner, 2026-09-16 (decision 16): the rows filed under the statement by hand on an account the new version no
   * longer reads are detached and kept, exactly as un-import keeps them — and un-importing a statement a second download
   * prints hands that download the period, the rows it prints and the rows filed by hand on its days.
   *
   * 🔴 The re-read lent the second download the period alone, on the premise that the new read writes the rows again.
   * It did not write them: the period went to gap under the copy with its rows superseded, and the payments filed by
   * hand were filed under the copy and quarantined. Measured on a copy of the real ledger, 2026-09-16 (the review of
   * uc/final-integrate): 20260702-statements-9805-.pdf re-read at a version that stops reading Chase Sapphire left
   * June–July at gap $51.02 under "20260702-statements-9805- (1).pdf" and 4 hand-filed payments ($2,134.27) quarantined.
   */
  test.each([
    ["withholds the section", false],
    ["stops reading it without a word", true],
  ])("a re-read that %s hands a second download the rows it prints, and the rows filed by hand stay active", async (_, silent) => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    const march = liveFile(MARCH).id;
    const withRows = accountIdOf(WITH_ROWS);
    const shell = contributionOf(march).rows.find((r) => r.accountId === withRows)!;
    bundle.db.update(transactions).set({ notes: "fuel for the trip", status: "excluded" }).where(eq(transactions.id, shell.id)).run();
    // money in and out on one day, filed under March by hand: the period still closes
    const byHand = [900, -900].map((amountCents, i) => {
      const raw = `CASH ${i === 0 ? "IN" : "OUT"} — recorded by hand`;
      return bundle.db
        .insert(transactions)
        .values({
          accountId: withRows,
          importFileId: march,
          fileLinkSource: "attached",
          postedOn: "2026-03-20",
          amountCents,
          rawDescription: raw,
          normalizedDescription: normalizeDescription(raw),
          dedupeHash: dedupeHash({ accountId: withRows, postedOn: "2026-03-20", amountCents, rawDescription: raw, occurrenceIndex: 0 }),
          notes: HAND_NOTE,
        })
        .returning({ id: transactions.id })
        .get().id;
    });
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const copy = liveFile(MARCH_COPY).id;
    reconcileAccounts(bundle.db, [withRows]);
    rebuildAccount(bundle.db, withRows);
    expect(periodOf(march, withRows)).toMatchObject({ reconciliation: "reconciled" });
    const days = dayRows(withRows);

    threeSectionProfile.version = 2;
    stopsReadingOthers = silent;
    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("parsed");
    expect(outcome!.withheld.map((w) => w.accountId).includes(withRows)).toBe(!silent);
    // as un-importing March leaves it: the copy holds the period, the row it prints and the rows filed by hand on its days
    expect(periodOf(copy, withRows)).toMatchObject({ periodStart: "2026-03-01", reconciliation: "reconciled" });
    expect(row(shell.id)).toMatchObject({ status: "excluded", importFileId: copy, notes: "fuel for the trip", fileLinkSource: null });
    for (const id of byHand) expect(row(id)).toMatchObject({ status: "active", importFileId: copy, fileLinkSource: "attached", notes: HAND_NOTE });
    expect(dayRows(withRows)).toEqual(days);
    // …and the copy owns the period now: it is no longer recorded as a copy of it
    expect(bundle.db.select().from(statementCopies).where(eq(statementCopies.accountId, withRows)).all()).toEqual([]);
    expectRebuilt(withRows);

    // a later version that reads the account again takes nothing twice: the copy's rows record its lines
    stopsReadingOthers = false;
    readsEverySection = true;
    threeSectionProfile.version = 3;
    await importStatementFiles(bundle.db, [MARCH]);
    const live = bundle.db
      .select({ amountCents: transactions.amountCents, status: transactions.status })
      .from(transactions)
      .where(and(eq(transactions.accountId, withRows), ne(transactions.status, "superseded")))
      .orderBy(transactions.amountCents)
      .all();
    expect(live).toEqual([
      { amountCents: -4000, status: "excluded" },
      { amountCents: -900, status: "active" },
      { amountCents: 900, status: "active" },
    ]);
    expect(dayRows(withRows)).toEqual(days);
  });

  test("a file that adopted a period while holding one of its own on the account does not take it — one period per file and account", async () => {
    const { unimportPeriodsByFile } = await import("./unimport-counts");
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    const TWO = statementFor("2026-05 and 2026-03");
    await importStatementFiles(bundle.db, [TWO]);
    const anchorOnly = accountIdOf(ANCHOR_ONLY);
    const [march, two] = [MARCH, TWO].map((f) => liveFile(f).id) as [string, string];
    // the premise: it owns May, and March's closing balance is its
    expect(periodOf(two, anchorOnly)).toMatchObject({ periodStart: "2026-05-01" });
    expect(statementAnchorOn(anchorOnly, "2026-03-31")).toMatchObject({ importFileId: two, statementPeriodId: periodOf(march, anchorOnly)!.id });
    expect(unimportPeriodsByFile(bundle.db).get(march)).toEqual({ removed: 3, handedOver: 0 });

    unimportFile(bundle.db, march);

    const starts = bundle.db
      .select({ start: statementPeriods.periodStart, file: statementPeriods.importFileId })
      .from(statementPeriods)
      .where(eq(statementPeriods.accountId, anchorOnly))
      .orderBy(statementPeriods.periodStart)
      .all();
    expect(starts).toEqual([
      { start: "2026-01-01", file: liveFile(JANUARY).id },
      { start: "2026-05-01", file: two },
    ]);
  });

  test("the un-import confirmation counts a period another download adopted as staying", async () => {
    const { unimportPeriodsByFile } = await import("./unimport-counts");
    const removedBy = (id: string) => unimportPeriodsByFile(bundle.db).get(id)?.removed ?? 0;
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const [january, march, copy] = [JANUARY, MARCH, MARCH_COPY].map((f) => liveFile(f).id) as [string, string, string];
    const periods = () => bundle.db.select().from(statementPeriods).all().length;

    // January's three go; March's three stay with the copy; the copy owns none
    expect([january, march, copy].map(removedBy)).toEqual([3, 0, 0]);
    const before = periods();
    unimportFile(bundle.db, march);
    expect(periods()).toBe(before);
    expect(removedBy(copy)).toBe(3);
  });

  /**
   * 🔴 A day two statements print — one's closing balance, the next one's opening — holds ONE anchor, owned by
   * whichever statement was imported last. Taking that file's contribution away deleted the anchor while the other
   * statement, still imported, prints the day. Measured on a copy of the real ledger, 2026-09-16: un-importing the July
   * 2026 Robinhood PDF left Robinhood Agentic's Jun 30 and Jul 31 `derived_unverified` with June and August in place.
   */
  test("un-importing the statement that wrote a shared day last leaves the days its neighbours print anchored", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [FEBRUARY]);
    // imported after both, and closing on Jan 31 too — but it prints no balance to hand the day to
    await importStatementFiles(bundle.db, [statementFor("2026-01 declared")]);
    const kept = accountIdOf(KEPT);
    const [january, february, march] = [JANUARY, FEBRUARY, MARCH].map((f) => liveFile(f).id) as [string, string, string];
    // the premise: February, imported last, owns both days it shares
    expect(statementAnchorOn(kept, "2026-01-31")!.importFileId).toBe(february);
    expect(statementAnchorOn(kept, "2026-02-28")!.importFileId).toBe(february);

    unimportFile(bundle.db, february);

    // January still prints its closing balance, and March its opening one
    expect(statementAnchorOn(kept, "2026-01-31")).toMatchObject({
      balanceCents: 1000,
      importFileId: january,
      statementPeriodId: periodOf(january, kept)!.id,
    });
    expect(statementAnchorOn(kept, "2026-02-28")).toMatchObject({
      balanceCents: 1000,
      importFileId: march,
      statementPeriodId: periodOf(march, kept)!.id,
    });
    for (const day of ["2026-01-31", "2026-02-28"]) expect(dayRow(kept, day)?.basis).toBe("anchored");
    expectRebuilt(kept);
  });

  test("a re-read that withholds a section leaves the days the neighbouring statements print anchored", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [FEBRUARY]);
    const anchorOnly = accountIdOf(ANCHOR_ONLY);
    expect(statementAnchorOn(anchorOnly, "2026-02-28")!.importFileId).toBe(liveFile(FEBRUARY).id);

    threeSectionProfile.version = 2;
    const [outcome] = await importStatementFiles(bundle.db, [FEBRUARY]);

    expect(outcome!.status).toBe("parsed");
    expect(outcome!.withheld.map((w) => w.accountId)).toContain(anchorOnly);
    const [january, march] = [JANUARY, MARCH].map((f) => liveFile(f).id);
    expect(statementAnchorOn(anchorOnly, "2026-01-31")).toMatchObject({ balanceCents: 50000, importFileId: january });
    expect(statementAnchorOn(anchorOnly, "2026-02-28")).toMatchObject({ balanceCents: 50000, importFileId: march });
    for (const day of ["2026-01-31", "2026-02-28"]) expect(dayRow(anchorOnly, day)?.basis).toBe("anchored");
    expectRebuilt(anchorOnly);
  });

  /**
   * The /imports confirmation says how many recorded balances an un-import removes. It counted every anchor the file
   * owned, and a second download of a statement owns only balances its first download still prints.
   */
  test("the un-import confirmation counts the balances the un-import removes, not the ones another statement still prints", async () => {
    const { balancesRemovedByFile } = await import("./printed-anchors");
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [FEBRUARY]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const recorded = () =>
      new Set(bundle.db.select().from(balanceAnchors).all().map((a) => `${a.accountId}|${a.anchoredOn}|${a.source}`));
    const removedBy = (fileId: string): { predicted: number; removed: number } => {
      const predicted = balancesRemovedByFile(bundle.db).get(fileId) ?? 0;
      const owned = bundle.db
        .select()
        .from(balanceAnchors)
        .where(eq(balanceAnchors.importFileId, fileId))
        .all()
        .map((a) => `${a.accountId}|${a.anchoredOn}|${a.source}`);
      unimportFile(bundle.db, fileId);
      const left = recorded();
      return { predicted, removed: owned.filter((key) => !left.has(key)).length };
    };
    const ids = [MARCH_COPY, FEBRUARY, JANUARY, MARCH].map((f) => liveFile(f).id);
    // one at a time, each against the ledger the one before it left: [copy, February, January, March]
    const steps = [removedBy(ids[0]!)];
    // a day one statement closes on and the next opens after goes to the one that closes on it
    expect(statementAnchorOn(accountIdOf(KEPT), "2026-02-28")!.importFileId).toBe(ids[1]);
    steps.push(...ids.slice(1).map((id) => removedBy(id)));

    for (const step of steps) expect(step.predicted).toBe(step.removed);
    // not vacuous: the copy and February hand every day over; January, then March, are the last to print theirs
    expect(steps.map((s) => s.removed)).toEqual([0, 0, 6, 6]);
  });

  /**
   * The real ledger's shape, 2026-09-16: 59 statements imported twice in different bytes. Every row of the second
   * copy deduped and it adopted the first copy's periods, so it owns nothing but anchors on days the first prints.
   */
  test("un-importing a second copy of a statement hands the days it printed back to the first copy", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const march = liveFile(MARCH).id;
    const copy = liveFile(MARCH_COPY).id;
    // the premise: the copy wrote no row and no period, and took every day March prints
    const copied = contributionOf(copy);
    expect({ rows: copied.rows, periods: copied.periods }).toEqual({ rows: [], periods: [] });
    expect(copied.anchors).toHaveLength(6);

    unimportFile(bundle.db, copy);

    for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) {
      const accountId = accountIdOf(last4);
      const period = periodOf(march, accountId)!;
      expect(statementAnchorOn(accountId, "2026-02-28")).toMatchObject({
        balanceCents: period.beginningBalanceCents,
        importFileId: march,
        statementPeriodId: period.id,
      });
      expect(statementAnchorOn(accountId, "2026-03-31")).toMatchObject({
        balanceCents: period.endingBalanceCents,
        importFileId: march,
        statementPeriodId: period.id,
      });
      expect(dayRow(accountId, "2026-03-31")?.basis).toBe("anchored");
      expectRebuilt(accountId);
    }
  });

  /** Every period, row and balance day of the three accounts, by content — the file that owns each left out. */
  function ledgerOf(): { periods: unknown[]; anchors: unknown[]; rows: unknown[]; days: unknown[] } {
    const ids = [KEPT, ANCHOR_ONLY, WITH_ROWS].map(accountIdOf);
    return {
      periods: bundle.db
        .select({
          accountId: statementPeriods.accountId,
          periodStart: statementPeriods.periodStart,
          periodEnd: statementPeriods.periodEnd,
          begin: statementPeriods.beginningBalanceCents,
          end: statementPeriods.endingBalanceCents,
          reconciliation: statementPeriods.reconciliation,
          gapCents: statementPeriods.gapCents,
        })
        .from(statementPeriods)
        .orderBy(statementPeriods.accountId, statementPeriods.periodStart)
        .all(),
      anchors: bundle.db
        .select({ accountId: balanceAnchors.accountId, day: balanceAnchors.anchoredOn, source: balanceAnchors.source, balanceCents: balanceAnchors.balanceCents })
        .from(balanceAnchors)
        .orderBy(balanceAnchors.accountId, balanceAnchors.anchoredOn, balanceAnchors.source)
        .all(),
      rows: bundle.db
        .select({
          id: transactions.id,
          status: transactions.status,
          amountCents: transactions.amountCents,
          postedOn: transactions.postedOn,
          notes: transactions.notes,
          categoryId: transactions.categoryId,
          categorizationSource: transactions.categorizationSource,
          fileLinkSource: transactions.fileLinkSource,
          attachedToAFile: transactions.importFileId,
        })
        .from(transactions)
        .orderBy(transactions.id)
        .all()
        .map((r) => ({ ...r, attachedToAFile: r.attachedToAFile !== null })),
      days: ids.flatMap((id) => dayRows(id).map((d) => ({ id, ...d }))),
    };
  }

  /**
   * 🔴 A second download owns nothing: it adopted the first download's periods and each of its lines deduped against
   * the first download's rows. Un-importing the FIRST download deleted the periods and the rows a still-imported file
   * prints. Measured on a copy of the real ledger, 2026-09-16: un-importing one of the three downloads of
   * 20230810-statements-3522-.pdf removed Chase Checking's reconciled period, 85 rows (−$1,636.84) and anchored days.
   */
  test("un-importing the first download of a statement downloaded twice keeps its periods and rows: the second still prints them", async () => {
    const { march, withRows, handRow } = await marchWithARowFiledByHand();
    const kept = accountIdOf(KEPT);
    const payroll = contributionOf(march).rows.find((r) => r.fileLinkSource === null)!;
    const userCategory = bundle.db.select().from(categories).all()[0]!.id;
    bundle.db
      .update(transactions)
      .set({ notes: "march payroll", categoryId: userCategory, categorizationSource: "user" })
      .where(eq(transactions.id, payroll.id))
      .run();
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const copy = liveFile(MARCH_COPY).id;
    // the premise: the copy wrote no row and no period
    expect(contributionOf(copy)).toMatchObject({ rows: [], periods: [] });
    const before = ledgerOf();

    unimportFile(bundle.db, march);

    // nothing about the ledger moved but which file holds it
    expect(ledgerOf()).toEqual(before);
    for (const accountId of [kept, accountIdOf(ANCHOR_ONLY), withRows]) {
      expect(periodOf(copy, accountId)).toMatchObject({ periodStart: "2026-03-01", periodEnd: "2026-03-31" });
      expect(statementAnchorOn(accountId, "2026-03-31")!.importFileId).toBe(copy);
      expectRebuilt(accountId);
    }
    expect(row(payroll.id)).toMatchObject({ importFileId: copy, notes: "march payroll", categorizationSource: "user", fileLinkSource: null });
    // the row filed by hand is filed under the statement that holds its day, as before
    expect(row(handRow)).toMatchObject({ importFileId: copy, fileLinkSource: "attached", notes: HAND_NOTE });

    // …and un-importing the last download removes them, as un-importing a statement always did
    unimportFile(bundle.db, copy);
    expect(row(payroll.id)).toBeUndefined();
    expect(row(handRow)).toMatchObject({ importFileId: null, fileLinkSource: "attached", status: "active" });
    for (const accountId of [kept, accountIdOf(ANCHOR_ONLY), withRows]) {
      expect(bundle.db.select().from(statementPeriods).where(eq(statementPeriods.accountId, accountId)).all().map((p) => p.periodStart)).toEqual(["2026-01-01"]);
      expectRebuilt(accountId);
    }
  });

  /**
   * The heir owns the periods it takes, so it is no longer a copy of them; the first download imported again adopts them
   * and is the copy. 🔴 Nothing failed if the heir stayed recorded as a copy: the first download's next import then took
   * the periods back (`reclaimFromCopy`) and left the rows under the heir (the review of uc/final-integrate, 2026-09-16:
   * the SoFi 2025-03 round trip on a copy of the real ledger).
   */
  test("the download that takes the periods is no longer a copy of them, and the first download imported again is", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const copy = liveFile(MARCH_COPY).id;
    const copiesBy = () => bundle.db.select({ fileId: statementCopies.importFileId }).from(statementCopies).all().map((c) => c.fileId);
    expect(copiesBy()).toEqual([copy, copy, copy]);

    unimportFile(bundle.db, liveFile(MARCH).id);
    expect(copiesBy()).toEqual([]);

    await importStatementFiles(bundle.db, [MARCH]);
    const march = liveFile(MARCH).id;
    expect(copiesBy()).toEqual([march, march, march]);
    expect(contributionOf(copy).periods).toHaveLength(3);
    expect(contributionOf(copy).rows).toHaveLength(2);
    expect(contributionOf(march)).toMatchObject({ rows: [], periods: [] });
  });

  /**
   * A download can be a copy of one file's month on one account and of another file's month on another. Un-importing
   * the first hands it the month on that account only: on the other it is still the second file's copy. 🔴 Nothing
   * failed if the hand-over forgot the download's copy records on every account: un-importing the second file then
   * deleted that account's March statement period, which the download still prints (a mutation check of
   * `handOverToCopies`, 2026-09-17).
   */
  test("a download printing two files' months takes one of them and stays a copy of the other", async () => {
    const KEPT_MARCH = statementFor("2026-03 kept only");
    const ANCHOR_MARCH = statementFor("2026-03 anchor only");
    await importStatementFiles(bundle.db, [JANUARY, KEPT_MARCH, ANCHOR_MARCH]);
    await importStatementFiles(bundle.db, [MARCH]);
    const march = liveFile(MARCH).id;
    const kept = accountIdOf(KEPT);
    const anchorOnly = accountIdOf(ANCHOR_ONLY);
    const copies = () =>
      bundle.db
        .select({ fileId: statementCopies.importFileId, accountId: statementCopies.accountId })
        .from(statementCopies)
        .orderBy(statementCopies.accountId)
        .all();
    const copyOn = (...accountIds: string[]) => [...accountIds].sort().map((accountId) => ({ fileId: march, accountId }));
    // the premise: March owns only the month no other file prints, and is a copy of each of the other two
    expect(contributionOf(march).periods.map((p) => p.accountId)).toEqual([accountIdOf(WITH_ROWS)]);
    expect(copies()).toEqual(copyOn(kept, anchorOnly));

    unimportFile(bundle.db, liveFile(KEPT_MARCH).id);

    expect(periodOf(march, kept)).toMatchObject({ periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    expect(copies()).toEqual(copyOn(anchorOnly));

    unimportFile(bundle.db, liveFile(ANCHOR_MARCH).id);

    expect(periodOf(march, anchorOnly)).toMatchObject({ periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    expect(statementAnchorOn(anchorOnly, "2026-03-31")?.importFileId).toBe(march);
    expect(dayRow(anchorOnly, "2026-03-31")).toMatchObject({ basis: "anchored", balanceCents: 50000 });
    expect(copies()).toEqual([]);
    expectRebuilt(kept);
    expectRebuilt(anchorOnly);
  });

  test("the second download takes only the rows it prints: a line only the first download prints goes with it", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    const REISSUE = statementFor("2026-03 reissue");
    await importStatementFiles(bundle.db, [REISSUE]);
    const march = liveFile(MARCH).id;
    const reissue = liveFile(REISSUE).id;
    const kept = accountIdOf(KEPT);
    const withRows = accountIdOf(WITH_ROWS);
    const marchRows = contributionOf(march).rows;
    const payroll = marchRows.find((r) => r.accountId === kept)!;
    const fuel = marchRows.find((r) => r.accountId === withRows)!;

    unimportFile(bundle.db, march);

    expect(row(payroll.id)).toBeUndefined();
    expect(row(fuel.id)).toMatchObject({ importFileId: reissue, status: "active" });
    // the reissue prints March's balances without the payroll deposit: its period on that account no longer closes
    expect(periodOf(reissue, kept)).toMatchObject({ reconciliation: "gap", gapCents: expect.any(Number) });
    expect(periodOf(reissue, withRows)).toMatchObject({ reconciliation: "reconciled" });
  });

  test("a parser-version re-read of the first download writes its period again, and the second download still inherits it", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    threeSectionProfile.version = 2;
    readsEverySection = true;
    const [reread] = await importStatementFiles(bundle.db, [MARCH]);
    expect(reread!.status).toBe("parsed");
    const march = liveFile(MARCH).id;
    const copy = liveFile(MARCH_COPY).id;
    // the premise: the re-read owns the periods and the rows again — nothing was handed to the copy…
    expect(contributionOf(march).periods).toHaveLength(3);
    expect(contributionOf(copy)).toMatchObject({ rows: [], periods: [] });
    // …and the six days the copy wrote last still cite it: a re-read keeps each citation where it was, a second
    // download's too (`keepCitations`; 🔴 it took them, the review of uc/reread-34-runbook, 2026-09-29)
    expect(contributionOf(march).anchors).toEqual([]);
    expect(contributionOf(copy).anchors).toHaveLength(6);
    const { balancesRemovedByFile } = await import("./printed-anchors");
    const { copyHandOvers } = await import("./statement-copies");
    expect(balancesRemovedByFile(bundle.db, copyHandOvers(bundle.db)).get(march) ?? 0).toBe(0);
    const before = ledgerOf();

    unimportFile(bundle.db, march);

    expect(ledgerOf()).toEqual(before);
    expect(contributionOf(copy).anchors).toHaveLength(6);
    expect(contributionOf(copy).periods).toHaveLength(3);
    expect(contributionOf(copy).rows).toHaveLength(2);
  });

  test("a parser-version re-read of the second download records again what it prints, under its new read only", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const retired = liveFile(MARCH_COPY).id;
    threeSectionProfile.version = 2;
    readsEverySection = true;
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const copy = liveFile(MARCH_COPY).id;
    expect(copy).not.toBe(retired);
    const recorded = bundle.db.select().from(statementCopies).all();
    expect(recorded.map((c) => c.importFileId)).toEqual([copy, copy, copy]);
    expect(new Set(recorded.map((c) => c.accountId))).toEqual(new Set([KEPT, ANCHOR_ONLY, WITH_ROWS].map(accountIdOf)));

    const before = ledgerOf();
    unimportFile(bundle.db, liveFile(MARCH).id);
    expect(ledgerOf()).toEqual(before);
    expect(contributionOf(copy).periods).toHaveLength(3);
  });

  /**
   * A re-read lends a month a copy prints to the copy (`lendToCopies`) and takes it back where it writes the month again
   * (`reclaimFromCopy`) — unless the re-read already holds a period of its own on the account: a file holds one period
   * per account (`ux_statement_periods_file_account`), so the month stays with the copy and the re-read becomes a copy
   * of it. Taking it anyway broke the unique index and failed the whole re-read.
   */
  test("a re-read that writes another month of the account first leaves the lent month with the copy — one period per file and account", async () => {
    const TWO = statementFor("2026-03 then 2026-05");
    await importStatementFiles(bundle.db, [TWO]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const anchorOnly = accountIdOf(ANCHOR_ONLY);
    const copy = liveFile(MARCH_COPY).id;
    // the premise: the file holds March on the account, and the copy prints it
    expect(periodOf(liveFile(TWO).id, anchorOnly)).toMatchObject({ periodStart: "2026-03-01" });
    expect(periodOf(copy, anchorOnly)).toBeUndefined();
    const march = periodOf(liveFile(TWO).id, anchorOnly)!;

    threeSectionProfile.version = 2;
    readsInReverse = true;
    const [reread] = await importStatementFiles(bundle.db, [TWO]);

    expect([reread!.status, reread!.error]).toEqual(["parsed", undefined]);
    const two = liveFile(TWO).id;
    expect(periodOf(two, anchorOnly)).toMatchObject({ periodStart: "2026-05-01" });
    expect(periodOf(copy, anchorOnly)).toMatchObject({ id: march.id, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    const recorded = bundle.db.select().from(statementCopies).where(eq(statementCopies.accountId, anchorOnly)).all();
    expect(recorded.map((c) => [c.importFileId, c.periodStart]).sort()).toEqual([[copy, "2026-03-01"], [two, "2026-03-01"]].sort());
    expectRebuilt(anchorOnly);
  });

  /**
   * The month stays lent where the re-read cannot take it back, and the re-read writes its line itself: the copy is
   * handed no retired row for a line a live row records, or the charge would be counted twice.
   */
  test("a re-read that writes a lent month's line but cannot take the month back leaves the retired row retired", async () => {
    const TWO = statementFor("2026-03 then 2026-05, with a row");
    await importStatementFiles(bundle.db, [TWO]);
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const withRows = accountIdOf(WITH_ROWS);
    const copy = liveFile(MARCH_COPY).id;
    const [retired] = contributionOf(liveFile(TWO).id).rows;
    const days = dayRows(withRows);

    threeSectionProfile.version = 2;
    readsInReverse = true;
    const [reread] = await importStatementFiles(bundle.db, [TWO]);

    expect(reread!.status).toBe("parsed");
    const two = liveFile(TWO).id;
    expect(periodOf(copy, withRows)).toMatchObject({ periodStart: "2026-03-01", reconciliation: "reconciled" });
    expect(periodOf(two, withRows)).toMatchObject({ periodStart: "2026-05-01" });
    expect(row(retired!.id)).toMatchObject({ status: "superseded" });
    const live = bundle.db
      .select({ amountCents: transactions.amountCents, importFileId: transactions.importFileId })
      .from(transactions)
      .where(and(eq(transactions.accountId, withRows), ne(transactions.status, "superseded")))
      .all();
    expect(live).toEqual([{ amountCents: -4000, importFileId: two }]);
    expect(dayRows(withRows)).toEqual(days);
  });

  test("a second download whose read failed part-way inherits nothing", async () => {
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    threeSectionProfile.version = 2;
    breaksMidFile = true;
    const [failed] = await importStatementFiles(bundle.db, [MARCH_COPY]);
    // the premise: the copy's first section was written, and recorded, before the read failed
    expect(failed!.status).toBe("failed");
    expect(bundle.db.select().from(statementCopies).all()).toHaveLength(1);
    const kept = accountIdOf(KEPT);

    unimportFile(bundle.db, liveFile(MARCH).id);

    expect(bundle.db.select().from(statementPeriods).where(eq(statementPeriods.accountId, kept)).all().map((p) => p.periodStart)).toEqual(["2026-01-01"]);
    expect(bundle.db.select().from(transactions).where(eq(transactions.accountId, kept)).all().map((t) => t.postedOn)).toEqual(["2026-01-10"]);
  });

  test("a transfer pair whose two legs one statement printed comes back together when the statement does", async () => {
    const { linkTransferPair } = await import("@/services/transfer-links");
    await importStatementFiles(bundle.db, [JANUARY, MARCH]);
    const march = liveFile(MARCH).id;
    const [payroll, fuel] = [KEPT, WITH_ROWS].map((last4) => contributionOf(march).rows.find((r) => r.accountId === accountIdOf(last4))!);
    linkTransferPair(bundle.db, fuel!.id, payroll!.id);
    const linkedCategory = row(fuel!.id)!.categoryId;
    expect(row(payroll!.id)!.categoryId).toBe(linkedCategory);

    unimportFile(bundle.db, march);
    await importStatementFiles(bundle.db, [MARCH]);

    const [payrollBack, fuelBack] = [KEPT, WITH_ROWS].map((last4) => contributionOf(liveFile(MARCH).id).rows.find((r) => r.accountId === accountIdOf(last4))!);
    expect(fuelBack).toMatchObject({ transferGroupId: fuelBack!.id, categorizationSource: "user", categoryId: linkedCategory });
    expect(payrollBack).toMatchObject({ transferGroupId: fuelBack!.id, categorizationSource: "user", categoryId: linkedCategory });
  });

  test("the un-import confirmation counts what the second download keeps as kept, and the last download's as removed", async () => {
    const { unimportCountsByFile, unimportPeriodsByFile } = await import("./unimport-counts");
    const { balancesRemovedByFile } = await import("./printed-anchors");
    const { copyHandOvers } = await import("./statement-copies");
    const { march } = await marchWithARowFiledByHand();
    await importStatementFiles(bundle.db, [MARCH_COPY]);
    const copy = liveFile(MARCH_COPY).id;
    const plans = copyHandOvers(bundle.db);
    const periods = unimportPeriodsByFile(bundle.db, plans);
    expect(unimportCountsByFile(bundle.db, plans).get(march)).toMatchObject({ deleted: 0, handedOver: 1, keptByPrinters: 0, kept: 1, keptRefiled: 1 });
    expect(periods.get(march)).toEqual({ removed: 0, handedOver: 3 });
    expect(balancesRemovedByFile(bundle.db, plans).get(march) ?? 0).toBe(0);

    unimportFile(bundle.db, march);

    const after = copyHandOvers(bundle.db);
    expect(unimportCountsByFile(bundle.db, after).get(copy)).toMatchObject({ deleted: 1, handedOver: 0, keptByPrinters: 0, kept: 1, keptRefiled: 0 });
    expect(unimportPeriodsByFile(bundle.db, after).get(copy)).toEqual({ removed: 3, handedOver: 0 });
    expect(balancesRemovedByFile(bundle.db, after).get(copy)).toBe(6);
  });

  /** An archive root whose per-account folder cannot be written — the move into it fails with EACCES. */
  function lockedArchive(folder: string): () => void {
    const root = path.join(dir, "locked-archive");
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.chmodSync(path.join(root, folder), 0o555);
    process.env.MONEYAPP_ORIGINALS_DIR = root;
    return () => fs.chmodSync(path.join(root, folder), 0o755);
  }

  /**
   * 🔴 The re-read committed, then moved the original into its account's folder, then marked its file `parsed`. A move
   * that threw (EACCES) left the retired read superseded and the new read's rows, periods and anchors live under a file
   * still marked `failed` with no error — and the throw left the upload: nothing after it was read, nothing before it
   * was categorized, reconciled or rebuilt. Measured on a copy of the real ledger, 2026-09-16 (the Feb 2026 Robinhood
   * PDF, v3 → v4): a "Failed" file holding 25 live rows, `[stale-verdict]` on both Robinhood accounts.
   */
  test("a re-read whose original cannot be moved into its account folder is still parsed, and the original stays where it was archived", async () => {
    await importStatementFiles(bundle.db, [JANUARY]);
    const retired = liveFile(JANUARY).id;
    const unlock = lockedArchive("chase-combined");
    try {
      threeSectionProfile.version = 2;
      readsEverySection = true;
      const [outcome] = await importStatementFiles(bundle.db, [JANUARY]);

      expect(outcome!.status).toBe("parsed");
      const reread = liveFile(JANUARY);
      expect(reread.id).not.toBe(retired);
      expect(reread).toMatchObject({ error: null, parserVersion: 2 });
      expect(fs.readFileSync(reread.storagePath)).toEqual(JANUARY.buffer);
      expect(bundle.db.select().from(importFilesTable).where(eq(importFilesTable.id, retired)).get()!.status).toBe("superseded");
      expect(contributionOf(reread.id).periods).toHaveLength(3);
      for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) expectRebuilt(accountIdOf(last4));
    } finally {
      unlock();
    }
  });

  test("an upload goes on past a file whose original cannot be moved, and settles every file in it", async () => {
    await importStatementFiles(bundle.db, [JANUARY]);
    const unlock = lockedArchive("chase-combined");
    try {
      threeSectionProfile.version = 2;
      readsEverySection = true;
      const outcomes = await importStatementFiles(bundle.db, [JANUARY, MARCH]);

      expect(outcomes.map((o) => o.status)).toEqual(["parsed", "parsed"]);
      for (const input of [JANUARY, MARCH]) expect(fs.existsSync(liveFile(input).storagePath)).toBe(true);
      // the settle step ran: March's periods are graded and every account rebuilt from what is there
      expect(periodOf(liveFile(MARCH).id, accountIdOf(KEPT))!.reconciliation).toBe("reconciled");
      for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) expectRebuilt(accountIdOf(last4));
    } finally {
      unlock();
    }
  });

  test("a fault in one file of an upload fails that file, with its cause, and the rest of the upload is read and settled", async () => {
    // named to sort before January: the fault comes first, and what follows it must still be read
    const BROKEN: ImportInput = { name: `${PREFIX}0-broken.txt`, buffer: Buffer.from("broken") };
    const brokenProfile: ParserProfile = {
      id: "test-broken-statement",
      version: 1,
      matches: (f) => f.name === BROKEN.name,
      // a parse that returns, and then faults when the importer reads what it withheld
      parse: (): ParsedFile => ({
        statements: [],
        withheld: new Proxy([], {
          get: () => {
            throw new Error("disk I/O error");
          },
        }),
      }),
    };
    PROFILES.unshift(brokenProfile);
    try {
      const outcomes = await importStatementFiles(bundle.db, [BROKEN, JANUARY]);

      expect(outcomes.map((o) => [o.fileName, o.status])).toEqual([
        [BROKEN.name, "failed"],
        [JANUARY.name, "parsed"],
      ]);
      expect(outcomes[0]!.error).toContain("disk I/O error");
      const broken = bundle.db.select().from(importFilesTable).where(eq(importFilesTable.fileName, BROKEN.name)).get()!;
      expect(broken).toMatchObject({ status: "failed" });
      expect(broken.error).toContain("disk I/O error");
      expect(periodOf(liveFile(JANUARY).id, accountIdOf(KEPT))!.reconciliation).toBe("reconciled");
      for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) expectRebuilt(accountIdOf(last4));
    } finally {
      PROFILES.splice(PROFILES.indexOf(brokenProfile), 1);
    }
  });

  /**
   * A read turn (`importTurn`) archives each file's original before it parses it. 🔴 Outside the steps that report their
   * own failure, a fault there — an institution folder the archive cannot write — left the upload: the files after it
   * were never read and the ones before it never settled, as the review measured for a file's archive move.
   */
  test("a file whose original cannot be archived fails with its cause, and the rest of the upload is read and settled", async () => {
    // named to sort before January, and for an institution whose archive folder cannot be written
    const UNARCHIVABLE: ImportInput = { name: `${PREFIX}0-discover.txt`, buffer: Buffer.from("2026-01 discover") };
    const unlock = lockedArchive("discover");
    try {
      const outcomes = await importStatementFiles(bundle.db, [UNARCHIVABLE, JANUARY]);

      expect(outcomes.map((o) => [o.fileName, o.status])).toEqual([
        [UNARCHIVABLE.name, "failed"],
        [JANUARY.name, "parsed"],
      ]);
      expect(outcomes[0]!.error).toMatch(/^Unexpected: EACCES/);
      // nothing was recorded for it: no row, so uploading it again reads it
      expect(bundle.db.select().from(importFilesTable).where(eq(importFilesTable.fileName, UNARCHIVABLE.name)).all()).toEqual([]);
      expect(periodOf(liveFile(JANUARY).id, accountIdOf(KEPT))!.reconciliation).toBe("reconciled");
      for (const last4 of [KEPT, ANCHOR_ONLY, WITH_ROWS]) expectRebuilt(accountIdOf(last4));
    } finally {
      unlock();
    }
  });
});

/*
 * 🔴 A card statement prints ONE date per row — the day of the transaction — and
 * lists the rows that POSTED in its period. A charge made on the last day of a
 * cycle posts after that cycle closes, so the NEXT statement prints it, dated
 * before that statement opens. The importer stored the printed day as
 * posted_on, and reconciliation counts a row in whichever period its posted_on
 * falls, so the row landed in the previous period and broke both.
 *
 * Pass 38 (2026-08-05) moved Chase Sapphire's four such rows onto their period's
 * opening day as DATA and left the importer as it was, so every re-read brought
 * them back. Forcing a parser-version re-parse of the 19 Sapphire statements on
 * a copy of the real ledger (2026-09-15) put 5 periods into `gap`, moved 149
 * balance days and quarantined 47 rows — identically in file-name order and in
 * reverse, one file per upload. The order was never the defect; the date was.
 */
describe("a statement row printed before its period opens", () => {
  const LINE_STATEMENT = "card-statement-lines-";

  /**
   * The Chase card statement's own reader over plain text lines, so a test can
   * hand the importer a real statement's shape without a PDF. File-name flags
   * route an `-investment-` statement to a Robinhood investment account, send a
   * `-wellsfargo-` one to Wells Fargo checking, and strip the transaction day
   * from a `-postedonly-` one.
   */
  const lineStatementProfile: ParserProfile = {
    id: "test-card-statement-lines",
    version: 1,
    matches: (f) => f.name.startsWith(LINE_STATEMENT),
    parse: async (f) => {
      const parsed = parseChaseCardLines(f.text.split("\n"));
      const investment = f.name.includes("-investment-");
      const wellsFargo = f.name.includes("-wellsfargo-");
      return [
        {
          accountHint: {
            institution: investment ? "Robinhood" : wellsFargo ? "Wells Fargo" : "Chase",
            type: investment ? "investment" : wellsFargo ? "checking" : "credit",
            ...(parsed.last4 ? { last4: parsed.last4 } : {}),
          },
          txns: f.name.includes("-postedonly-")
            ? parsed.txns.map(({ transactedOn: _printed, ...rest }) => rest)
            : parsed.txns,
          period: {
            start: parsed.periodStart,
            end: parsed.periodEnd,
            beginCents: parsed.beginningBalanceCents,
            endCents: parsed.endingBalanceCents,
          },
        },
      ];
    },
  };

  beforeEach(() => {
    lineStatementProfile.version = 1;
    PROFILES.unshift(lineStatementProfile);
  });

  afterEach(() => {
    PROFILES.splice(PROFILES.indexOf(lineStatementProfile), 1);
  });

  function statement(
    name: string,
    s: { last4: string; period: string; previous: string; next: string; rows: string[] },
  ): ImportInput {
    const site = name.includes("-investment-") ? "robinhood.com" : "www.chase.com/cardhelp";
    return {
      name: `${LINE_STATEMENT}${name}.txt`,
      buffer: Buffer.from(
        [
          site,
          `Account Number: XXXX XXXX XXXX ${s.last4}`,
          `Previous Balance ${s.previous}`,
          `New Balance ${s.next}`,
          `Opening/Closing Date ${s.period}`,
          "PAYMENTS AND OTHER CREDITS",
          ...s.rows,
        ].join("\n"),
      ),
    };
  }

  const AUGUST = statement("2025-09", {
    last4: "5150",
    period: "08/03/25 - 09/02/25",
    previous: "$0.00",
    next: "$40.00",
    rows: ["08/10 SHELL OIL 555 MIAMI FL 40.00"],
  });
  // Sapphire's own straddler: a $92.53 Best Buy credit printed 09/02 by the
  // statement that opens 09/03 (20251002-statements-9805-.pdf)
  const SEPTEMBER = statement("2025-10", {
    last4: "5150",
    period: "09/03/25 - 10/02/25",
    previous: "$40.00",
    next: "-$27.53",
    rows: ["09/02 BEST BUY CO 00012617 BRONX NY -92.53", "09/15 STARBUCKS STORE 77 MIAMI FL 25.00"],
  });

  function accountIdOf(last4: string): string {
    return bundle.db.select().from(accounts).where(eq(accounts.last4, last4)).get()!.id;
  }

  function liveRowsOf(accountId: string): (typeof transactions.$inferSelect)[] {
    return bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), ne(transactions.status, "superseded")))
      .all();
  }

  function liveRow(accountId: string, prefix: string): typeof transactions.$inferSelect {
    const rows = liveRowsOf(accountId).filter((r) => r.rawDescription.startsWith(prefix));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /** What a re-parse must not move: verdicts, every replayed day, every live row. */
  function ledgerState(accountId: string) {
    return {
      periods: bundle.db
        .select({
          start: statementPeriods.periodStart,
          end: statementPeriods.periodEnd,
          reconciliation: statementPeriods.reconciliation,
          gapCents: statementPeriods.gapCents,
        })
        .from(statementPeriods)
        .where(eq(statementPeriods.accountId, accountId))
        .all()
        .sort((a, b) => a.start.localeCompare(b.start)),
      balances: bundle.db
        .select({ day: dailyBalances.day, balanceCents: dailyBalances.balanceCents, basis: dailyBalances.basis })
        .from(dailyBalances)
        .where(eq(dailyBalances.accountId, accountId))
        .all()
        .sort((a, b) => a.day.localeCompare(b.day)),
      rows: liveRowsOf(accountId)
        .map((r) => `${r.postedOn} ${r.transactedOn} ${r.amountCents} ${r.status} ${r.rawDescription}`)
        .sort(),
    };
  }

  test("it is posted on the opening day of the statement that prints it, and both periods close", async () => {
    const outcomes = await importStatementFiles(bundle.db, [AUGUST, SEPTEMBER]);

    expect(outcomes.map((o) => o.status)).toEqual(["parsed", "parsed"]);
    const card = accountIdOf("5150");
    // the posting day is not printed; the statement whose arithmetic counts the
    // row proves it lies inside 09-03..10-02, and the printed day stays the
    // transaction day
    const bestBuy = liveRow(card, "BEST BUY");
    expect(bestBuy).toMatchObject({
      postedOn: "2025-09-03",
      transactedOn: "2025-09-02",
      amountCents: 9253,
      status: "active",
    });
    // dedupe_hash covers posted_on, so it names the day the row is stored under
    // — the hash pass 38 recomputed when it moved Sapphire's four rows by hand
    expect(bestBuy.dedupeHash).toBe(
      dedupeHash({
        accountId: card,
        postedOn: "2025-09-03",
        amountCents: 9253,
        rawDescription: bestBuy.rawDescription,
        occurrenceIndex: bestBuy.occurrenceIndex,
      }),
    );
    expect(ledgerState(card).periods).toEqual([
      { start: "2025-08-03", end: "2025-09-02", reconciliation: "reconciled", gapCents: null },
      { start: "2025-09-03", end: "2025-10-02", reconciliation: "reconciled", gapCents: null },
    ]);
  });

  test("a parser-version re-parse leaves every period verdict, every balance day and every row where it was", async () => {
    await importStatementFiles(bundle.db, [AUGUST, SEPTEMBER]);
    const card = accountIdOf("5150");
    // the real ledger's shape: pass 38 moved the straddler onto its opening day
    // as data, hash recomputed (a no-op once the import places it itself)
    const bestBuy = liveRow(card, "BEST BUY");
    bundle.db
      .update(transactions)
      .set({
        postedOn: "2025-09-03",
        dedupeHash: dedupeHash({
          accountId: card,
          postedOn: "2025-09-03",
          amountCents: bestBuy.amountCents,
          rawDescription: bestBuy.rawDescription,
          occurrenceIndex: bestBuy.occurrenceIndex,
        }),
      })
      .where(eq(transactions.id, bestBuy.id))
      .run();
    reconcileAccounts(bundle.db, [card]);
    rebuildAccount(bundle.db, card);
    const before = ledgerState(card);
    expect(before.periods.map((p) => p.reconciliation)).toEqual(["reconciled", "reconciled"]);

    lineStatementProfile.version += 1;
    const outcomes = await importStatementFiles(bundle.db, [AUGUST, SEPTEMBER]);

    // a fresh parse of both files, not a duplicate skip
    expect(outcomes.map((o) => [o.status, o.inserted])).toEqual([
      ["parsed", 1],
      ["parsed", 2],
    ]);
    expect(ledgerState(card)).toEqual(before);
    expect(bundle.db.select().from(transactions).where(eq(transactions.status, "quarantined")).all()).toEqual([]);
  });

  test("it is still matched on the day it prints — it never claims another charge made on the opening day", async () => {
    await importStatementFiles(bundle.db, [AUGUST]);
    const card = accountIdOf("5150");
    // pass 38's measured hazard: LA GAVIOTA DELI GROCERY, printed before the
    // period, would claim NEW BEST GOURMET DELI if matched on the opening day
    const handDescription = "NEW BEST GOURMET DELI";
    bundle.db
      .insert(transactions)
      .values({
        accountId: card,
        postedOn: "2025-09-03",
        transactedOn: "2025-09-03",
        amountCents: -312,
        rawDescription: handDescription,
        normalizedDescription: normalizeDescription(handDescription),
        dedupeHash: dedupeHash({
          accountId: card,
          postedOn: "2025-09-03",
          amountCents: -312,
          rawDescription: handDescription,
          occurrenceIndex: 0,
        }),
      })
      .run();
    const deli = statement("2025-10-deli", {
      last4: "5150",
      period: "09/03/25 - 10/02/25",
      previous: "$40.00",
      next: "$46.24",
      rows: ["09/01 LA GAVIOTA DELI GROCERY 3.12", "09/03 NEW BEST GOURMET DELI 3.12"],
    });

    await importStatementFiles(bundle.db, [deli]);

    const september = liveRowsOf(card)
      .filter((r) => r.postedOn >= "2025-09-03")
      .map((r) => ({
        description: r.rawDescription,
        postedOn: r.postedOn,
        transactedOn: r.transactedOn,
        handEntered: r.importFileId === null,
      }))
      .sort((a, b) => a.description.localeCompare(b.description));
    expect(september).toEqual([
      { description: "LA GAVIOTA DELI GROCERY", postedOn: "2025-09-03", transactedOn: "2025-09-01", handEntered: false },
      { description: handDescription, postedOn: "2025-09-03", transactedOn: "2025-09-03", handEntered: true },
    ]);
    expect(ledgerState(card).periods.map((p) => p.reconciliation)).toEqual(["reconciled", "reconciled"]);
  });

  test("a statement that prints no transaction day keeps the day it printed as the transaction day", async () => {
    const postedOnly = statement("postedonly-2025-10", {
      last4: "6160",
      period: "09/03/25 - 10/02/25",
      previous: "$0.00",
      next: "$12.00",
      rows: ["09/01 UBER TRIP HELP.UBER.COM CA 12.00"],
    });

    await importStatementFiles(bundle.db, [postedOnly]);

    expect(liveRow(accountIdOf("6160"), "UBER TRIP")).toMatchObject({
      postedOn: "2025-09-03",
      transactedOn: "2025-09-01",
    });
  });

  test("an investment statement's dates stay as printed — its period is a value anchor, not a closing balance", async () => {
    const brokerage = statement("investment-2025-10", {
      last4: "7070",
      period: "09/03/25 - 10/02/25",
      previous: "$0.00",
      next: "$10.00",
      rows: ["09/02 ACME CORP BUY 10.00"],
    });

    await importStatementFiles(bundle.db, [brokerage]);

    const account = bundle.db.select().from(accounts).where(eq(accounts.last4, "7070")).get()!;
    expect(account.type).toBe("investment");
    expect(liveRow(account.id, "ACME CORP")).toMatchObject({ postedOn: "2025-09-02", transactedOn: "2025-09-02" });
  });

  /** A Chase card QFX for ····5150: a higher-fidelity source than any statement. */
  function cardQfx(s: { start: string; end: string; owedCents: number; rows: { day: string; cents: number; name: string }[] }): ImportInput {
    const rows = s.rows.map(
      (r, i) =>
        `<STMTTRN>\n<TRNTYPE>${r.cents < 0 ? "DEBIT" : "CREDIT"}\n<DTPOSTED>${r.day.replaceAll("-", "")}\n<TRNAMT>${(r.cents / 100).toFixed(2)}\n<FITID>${i + 1}\n<NAME>${r.name}\n</STMTTRN>`,
    );
    const body = [
      "OFXHEADER:100",
      "",
      "<OFX>",
      "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0\n<SEVERITY>INFO\n</STATUS>\n<FI><ORG>B1\n</FI>\n<INTU.BID>10898\n</SONRS></SIGNONMSGSRSV1>",
      "<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>",
      "<CCACCTFROM><ACCTID>00005150\n</CCACCTFROM>",
      `<BANKTRANLIST>\n<DTSTART>${s.start.replaceAll("-", "")}\n<DTEND>${s.end.replaceAll("-", "")}`,
      ...rows,
      "</BANKTRANLIST>",
      // a card's LEDGERBAL is the positive amount owed
      `<LEDGERBAL><BALAMT>${(s.owedCents / 100).toFixed(2)}\n<DTASOF>${s.end.replaceAll("-", "")}\n</LEDGERBAL>`,
      "</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>",
      "</OFX>",
      "",
    ].join("\n");
    return { name: `Chase5150_Activity_${s.start}.QFX`, buffer: Buffer.from(body) };
  }

  test("an export whose coverage ENDS on the day it prints does not own it — the charge posted after that export closed", async () => {
    // the export closes on the August statement's close day, so it holds
    // August's rows and cannot hold a charge that posted in September
    const exportThroughAugust = cardQfx({
      start: "2025-08-03",
      end: "2025-09-02",
      owedCents: 4_500,
      rows: [
        { day: "2025-08-10", cents: -4_000, name: "SHELL OIL 555 MIAMI FL" },
        { day: "2025-09-02", cents: -500, name: "CITY PARKING MIAMI FL" },
      ],
    });
    const august = statement("2025-09-own", {
      last4: "5150",
      period: "08/03/25 - 09/02/25",
      previous: "$0.00",
      next: "$45.00",
      rows: ["08/10 SHELL OIL 555 MIAMI FL 40.00", "09/02 CITY PARKING MIAMI FL 5.00"],
    });
    const september = statement("2025-10-own", {
      last4: "5150",
      period: "09/03/25 - 10/02/25",
      previous: "$45.00",
      next: "-$22.53",
      rows: ["09/02 BEST BUY CO 00012617 BRONX NY -92.53", "09/15 STARBUCKS STORE 77 MIAMI FL 25.00"],
    });

    const [, augustOutcome, septemberOutcome] = await importStatementFiles(bundle.db, [exportThroughAugust, august, september]);

    const card = accountIdOf("5150");
    // August's two rows ARE the export's, and stay owned by it
    expect([augustOutcome!.inserted, augustOutcome!.skippedOwned]).toEqual([0, 2]);
    expect([septemberOutcome!.inserted, septemberOutcome!.skippedOwned]).toEqual([2, 0]);
    expect(liveRow(card, "BEST BUY")).toMatchObject({ postedOn: "2025-09-03", transactedOn: "2025-09-02", status: "active" });
    expect(liveRow(card, "STARBUCKS")).toMatchObject({ status: "active" });
    expect(ledgerState(card).periods.map((p) => [p.start, p.reconciliation, p.gapCents])).toEqual([
      ["2025-08-03", "reconciled", null],
      ["2025-09-03", "reconciled", null],
    ]);
  });

  test("an export whose coverage STARTS on the day it posted owns it — the statement does not record the charge a second time", async () => {
    // the export opens on September's opening day and already holds the
    // charge on the day it posted, which the statement does not print. Its
    // NAME is the bank's short text, so no hash can tie the two records.
    const exportFromSeptember = cardQfx({
      start: "2025-09-03",
      end: "2025-10-02",
      owedCents: -2_753,
      rows: [
        { day: "2025-09-03", cents: 9_253, name: "BEST BUY 00012617" },
        { day: "2025-09-15", cents: -2_500, name: "STARBUCKS STORE 77" },
      ],
    });

    const [, , septemberOutcome] = await importStatementFiles(bundle.db, [AUGUST, exportFromSeptember, SEPTEMBER]);

    const card = accountIdOf("5150");
    expect([septemberOutcome!.inserted, septemberOutcome!.skippedOwned]).toEqual([0, 2]);
    // one row for one charge: the export's, on its posting day
    expect(liveRow(card, "BEST BUY")).toMatchObject({ postedOn: "2025-09-03", amountCents: 9_253, status: "active" });
    expect(ledgerState(card).periods.map((p) => [p.start, p.reconciliation, p.gapCents])).toEqual([
      ["2025-08-03", "reconciled", null],
      ["2025-09-03", "reconciled", null],
    ]);
  });

  test("a lower-fidelity export's row on the day it prints is taken over, and its replacement is written on the day it posted", async () => {
    // Rocket Money is the one source ranked below a statement, and its
    // allowlist admits only Wells Fargo ····5481 — so the card statement's
    // rows are routed there; a checking period must close to the cent too
    bundle.db.insert(institutions).values({ name: "Wells Fargo" }).run();
    const rocketMoney: ImportInput = {
      name: "2025-09-20T12_00_00.000Z-transactions.csv",
      buffer: Buffer.from(
        [
          "Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags",
          // their Amount is positive for money OUT: this is a $92.53 credit
          '2025-09-02,2025-09-02,Cash,ACCOUNT,5481,Wells Fargo,"Best Buy",,-92.53,"BEST BUY CO 00012617 BRONX NY",Shopping,,,,',
        ].join("\n"),
      ),
    };
    const august = statement("wellsfargo-2025-09", {
      last4: "5481",
      period: "08/03/25 - 09/02/25",
      previous: "$0.00",
      next: "$40.00",
      rows: ["08/10 SHELL OIL 555 MIAMI FL 40.00"],
    });
    const september = statement("wellsfargo-2025-10", {
      last4: "5481",
      period: "09/03/25 - 10/02/25",
      previous: "$40.00",
      next: "-$27.53",
      rows: ["09/02 BEST BUY CO 00012617 BRONX NY -92.53", "09/15 STARBUCKS STORE 77 MIAMI FL 25.00"],
    });

    const [rocketOutcome, , septemberOutcome] = await importStatementFiles(bundle.db, [rocketMoney, august, september]);

    expect(rocketOutcome).toMatchObject({ status: "parsed", inserted: 1 });
    expect([septemberOutcome!.supersededTakeover, septemberOutcome!.inserted]).toEqual([1, 2]);
    const rocketFileId = bundle.db
      .select()
      .from(importFilesTable)
      .where(eq(importFilesTable.fileName, rocketMoney.name))
      .get()!.id;
    const account = accountIdOf("5481");
    const rows = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, account), eq(transactions.amountCents, 9_253)))
      .all()
      .map((r) => ({
        status: r.status,
        postedOn: r.postedOn,
        transactedOn: r.transactedOn,
        fromStatement: r.importFileId !== rocketFileId,
      }))
      .sort((a, b) => a.status.localeCompare(b.status));
    expect(rows).toEqual([
      { status: "active", postedOn: "2025-09-03", transactedOn: "2025-09-02", fromStatement: true },
      { status: "superseded", postedOn: "2025-09-02", transactedOn: null, fromStatement: false },
    ]);
    expect(ledgerState(account).periods.filter((p) => p.reconciliation !== "not_applicable").map((p) => [p.start, p.reconciliation])).toEqual([
      ["2025-08-03", "reconciled"],
      ["2025-09-03", "reconciled"],
    ]);
  });
});

describe("the full 2-year backfill (golden acceptance)", () => {
  test(
    "every fixture imports; every period reconciles; balances match the simulation to the cent",
    { timeout: 300_000 },
    async () => {
      const all: ImportInput[] = [
        ...loadDir("chase"),
        ...loadDir("chase", "statements"),
        ...loadDir("discover"),
        ...loadDir("discover", "statements"),
        ...loadDir("capital-one"),
        ...loadDir("capital-one", "statements"),
        ...loadDir("sofi"),
        ...loadDir("sofi", "statements"),
        ...loadDir("robinhood"),
        ...loadDir("robinhood", "statements"),
      ];
      const outcomes = await importStatementFiles(bundle.db, all);

      const failed = outcomes.filter((o) => o.status === "failed");
      expect(failed.map((f) => `${f.fileName}: ${f.error}`)).toEqual([]);

      // zero unexplained gaps across ~217 statement periods
      const periods = bundle.db.select().from(statementPeriods).all();
      const gaps = periods.filter((p) => p.reconciliation === "gap");
      expect(gaps.map((g) => `${g.periodStart}..${g.periodEnd} gap=${g.gapCents}`)).toEqual([]);
      expect(periods.length).toBeGreaterThan(150);

      // per-account latest balances match the simulator's ground truth exactly
      const balances = latestBalances(bundle.db);
      const accountRows = bundle.db.select().from(accounts).all();
      const expectByLast4: Record<string, number> = {
        "4321": manifest.endBalances["chase-checking"]!,
        "8721": manifest.endBalances["chase-savings"]!,
        "1111": manifest.endBalances["chase-card"]!,
        "3333": manifest.endBalances["capone-checking"]!,
        "4444": manifest.endBalances["capone-venturex"]!,
      };
      for (const [last4, expected] of Object.entries(expectByLast4)) {
        const account = accountRows.find((a) => a.last4 === last4)!;
        expect(balances.get(account.id)?.balanceCents, `account ····${last4}`).toBe(expected);
      }

      // numberless files (SoFi/Discover/Robinhood CSVs) must NOT duplicate
      // accounts once PDFs arrive with last4 — exactly 9 accounts, ever
      expect(accountRows).toHaveLength(9);

      // total net worth equals the summed ground truth; the brokerage account
      // carries its last statement value (live prices are Phase 7's job)
      const series = netWorthSeries(bundle.db);
      const last = series.at(-1)!;
      const expectedTotal =
        Object.entries(manifest.endBalances)
          .filter(([k]) => k !== "robinhood-brokerage")
          .reduce((s, [, v]) => s + v, 0) + manifest.robinhoodLastStatementValueCents;
      expect(last.totalCents).toBe(expectedTotal);
      expect(last.complete).toBe(true);

      // ~2 years of history: the series reaches back to the simulation start
      expect(series[0]!.day <= "2024-07-05").toBe(true);

      // no active fuzzy-duplicate floods: dedupe + ownership held the line
      const active = bundle.db
        .select()
        .from(transactions)
        .where(inArray(transactions.status, ["active"]))
        .all();
      const expectedTxnTotal = Object.values(manifest.txnCounts).reduce((s, v) => s + v, 0);
      expect(active.length).toBe(expectedTxnTotal);
    },
  );
});

/* ── per-profile fidelity ─────────────────────────────────────────────── */

describe("fidelityOf — a format can lie about how much a file can be trusted", () => {
  /**
   * The scenario this exists for, in full:
   *
   * `rocket-money-csv` is a third-party re-export covering Wells Fargo, the one
   * account with no bank feed. Ranked by FORMAT it is a `csv` at priority 1 —
   * more trustworthy than every PDF statement in the app. Ownership is decided
   * by `coveredBy.some((r) => r.priority < myPriority)`, so the days it covers
   * would be OWNED by it, and the real Wells Fargo statement — whenever it
   * arrives — would have every one of its rows counted as `skippedOwned` and
   * silently dropped. The export is already known to be incomplete: its 39 rows
   * sum to $2,396.67 and the owner's bank app disagrees.
   *
   * The end-to-end takeover is exercised in "a statement row printed before its
   * period opens", whose test statements can be routed to Wells Fargo ····5481
   * over a Rocket Money row. What is asserted here is the decision itself —
   * plus the property that no OTHER profile's behaviour moved.
   */
  test("the Rocket Money export ranks below every real statement format", () => {
    const rocket = fidelityOf("csv", "rocket-money-csv");
    expect(rocket).toBeGreaterThan(fidelityOf("pdf", "chase-card-statement-pdf"));
    expect(rocket).toBeGreaterThan(fidelityOf("csv", "chase-deposit-csv"));
    expect(rocket).toBeGreaterThan(fidelityOf("qfx", "ofx-generic"));
  });

  test("every other profile still ranks exactly by its format", () => {
    // the override map must be a scalpel, not a new ordering
    expect(fidelityOf("qfx", "ofx-generic")).toBe(fidelityOf("qfx", null));
    expect(fidelityOf("csv", "chase-deposit-csv")).toBe(fidelityOf("csv", null));
    expect(fidelityOf("pdf", "sofi-combined-statement-pdf")).toBe(fidelityOf("pdf", null));
    expect(fidelityOf("pdf", undefined)).toBe(fidelityOf("pdf", null));
  });

  test("ofx still outranks csv, and csv still outranks pdf, for unoverridden files", () => {
    expect(fidelityOf("ofx", null)).toBeLessThan(fidelityOf("csv", null));
    expect(fidelityOf("csv", null)).toBeLessThan(fidelityOf("pdf", null));
  });
});

/**
 * ⚖️ OWNER, 2026-09-15 (answer 4): un-importing a statement must not delete a
 * row the statement never produced. `scripts/attach-sapphire-payment-rows-2026-09-14.ts`
 * filed 34 hand-built Chase Sapphire card payments under the 12 statements that
 * print them. The card parser never inserted those lines — each was absorbed by
 * the hand row already recording it — so a re-import cannot recreate them, and
 * `unimportFile` hard-deleted them with the file's own rows: the money, the
 * category, the transfer link and the note. Read-only on the real ledger the
 * same day: 20260302-statements-9805-.pdf held 4 parsed rows and 5 attached,
 * 20260702-statements-9805-.pdf 2 and 4.
 *
 * The scene replays that history on the fixture: a statement imported, its rows
 * removed, two of its lines recorded by hand in other words, the statement
 * imported again (each hand row absorbs its line), and ONE of the two attached.
 */
describe("un-import keeps a row attached to its file, and a re-import files it there again", () => {
  const NAME = "capone-venturex-2024-09-20_2024-10-19.pdf";
  const statement = (): ImportInput => load("capital-one", "statements", NAME);
  const fileNamed = () => bundle.db.select().from(importFilesTable).where(eq(importFilesTable.fileName, NAME)).get();
  const row = (id: string) => bundle.db.select().from(transactions).where(eq(transactions.id, id)).get();
  const rowsOf = (fileId: string) =>
    bundle.db.select().from(transactions).where(eq(transactions.importFileId, fileId)).all();
  const periodOf = (fileId: string) =>
    bundle.db.select().from(statementPeriods).where(eq(statementPeriods.importFileId, fileId)).get();

  let seq = 0;
  function hand(accountId: string, postedOn: string, amountCents: number, raw: string): string {
    seq += 1;
    return bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: seq }),
      })
      .returning({ id: transactions.id })
      .get().id;
  }

  /** What the attach script writes: the file that prints the line, and the marker that says so. */
  function attach(id: string, fileId: string): void {
    const changes = bundle.db
      .update(transactions)
      .set({ importFileId: fileId, fileLinkSource: "attached" })
      .where(eq(transactions.id, id))
      .run().changes;
    expect(changes).toBe(1);
  }

  function group(ids: readonly string[], groupId: string): void {
    bundle.db.update(transactions).set({ transferGroupId: groupId }).where(inArray(transactions.id, [...ids])).run();
  }

  interface Scene {
    accountId: string;
    fileId: string;
    /** a hand row absorbed by a line, then attached to the file */
    attached: string;
    /** a hand row absorbed by a line and never attached */
    unattached: string;
    /** the attached row's transfer partner, on another account */
    partner: string;
    /** a parsed row of the file with a transfer partner of its own */
    parsedLeg: string;
    parsedPartner: string;
    seriesId: string;
  }

  async function scene(): Promise<Scene> {
    await importStatementFiles(bundle.db, [statement()]);
    const first = fileNamed()!;
    const parsed = rowsOf(first.id);
    // lines whose (day, amount) the file prints once, so each hand row absorbs exactly one
    const once = parsed.filter(
      (t) => parsed.filter((u) => u.postedOn === t.postedOn && u.amountCents === t.amountCents).length === 1,
    );
    expect(once.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = once as [(typeof once)[number], (typeof once)[number], (typeof once)[number]];
    unimportFile(bundle.db, first.id);

    const accountId = a.accountId;
    const attached = hand(accountId, a.postedOn, a.amountCents, "PAYMENT — reconstructed by hand");
    const unattached = hand(accountId, b.postedOn, b.amountCents, "TRANSFER — reconstructed by hand");
    const [outcome] = await importStatementFiles(bundle.db, [statement()]);
    expect(outcome!.status).toBe("parsed");
    expect(outcome!.dedupedCrossFormat).toBe(2);
    const fileId = fileNamed()!.id;
    expect(periodOf(fileId)!.reconciliation).toBe("reconciled");

    attach(attached, fileId);
    const { institutionId } = bundle.db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
    const other = createAccount(bundle.db, { institutionId, name: "Hand checking", type: "checking" });
    const partner = hand(other, a.postedOn, -a.amountCents, "PAYMENT TO VENTURE X");
    group([attached, partner], attached);
    const parsedLeg = rowsOf(fileId).find((t) => t.postedOn === c.postedOn && t.amountCents === c.amountCents)!.id;
    const parsedPartner = hand(other, c.postedOn, -c.amountCents, "PAYMENT TO VENTURE X");
    group([parsedLeg, parsedPartner], parsedLeg);

    const category = bundle.db.select().from(categories).get()!;
    bundle.db
      .update(transactions)
      .set({ categoryId: category.id, categorizationSource: "user", notes: "reconstructed credit-card payment leg" })
      .where(eq(transactions.id, attached))
      .run();
    const seriesId = bundle.db
      .insert(recurringSeries)
      .values({ name: "Card payment", kind: "subscription", cadence: "monthly", status: "confirmed", intervalDaysAvg: 30 })
      .returning({ id: recurringSeries.id })
      .get().id;
    attachTransactions(bundle.db, seriesId, [attached]);
    return { accountId, fileId, attached, unattached, partner, parsedLeg, parsedPartner, seriesId };
  }

  test("un-importing deletes what the file parsed and keeps the row attached to it — money, category, links, note", async () => {
    const s = await scene();
    const { importFileId: _file, updatedAt: _updated, ...carried } = row(s.attached)!;

    unimportFile(bundle.db, s.fileId);

    expect(row(s.attached)).toMatchObject({ ...carried, importFileId: null, status: "active", recurringSeriesId: s.seriesId });
    // its partner keeps the link, because the leg it pairs with is still here…
    expect(row(s.partner)!.transferGroupId).toBe(s.attached);
    // …and a partner the deleted rows leave alone is released, as before
    expect(row(s.parsedPartner)!.transferGroupId).toBeNull();
    const left = bundle.db.select().from(transactions).where(eq(transactions.accountId, s.accountId)).all();
    expect(left.map((t) => t.id).sort()).toEqual([s.attached, s.unattached].sort());
    expect(fileNamed()).toBeUndefined();
  });

  /**
   * ⚖️ Owner, 2026-09-15: a row filed under a statement by hand was never the file's to take. A more trusted file
   * printing its line is absorbed by it, as by any row entered by hand — it does not take it over.
   *
   * 🔴 The takeover read the row's file id as the statement's parse and retired the owner's row behind the new line;
   * un-importing the more trusted file then deleted the payment where the statement had no record of what it prints
   * (found while pinning `takenOverLines`, 2026-09-16: a $50.00 hand payment gone, the statement's period in gap).
   */
  test("a more trusted file's line is absorbed by a row filed by hand, and un-importing that file keeps it", async () => {
    const s = await scene();
    const kept = row(s.attached)!;
    const account = bundle.db.select().from(accounts).where(eq(accounts.id, s.accountId)).get()!;
    const institution = bundle.db.select().from(institutions).where(eq(institutions.id, account.institutionId)).get()!;
    const OFX: ImportInput = { name: "hand-row-takeover.ofx", buffer: Buffer.from("<OFX> hand row takeover") };
    const trusted: ParserProfile = {
      id: "test-hand-row-takeover",
      version: 1,
      matches: (f) => f.name === OFX.name,
      parse: () => [
        {
          accountHint: { institution: institution.name as AccountHint["institution"], type: account.type, last4: account.last4! },
          txns: [{ postedOn: kept.postedOn, amountCents: kept.amountCents, rawDescription: "CAPITAL ONE ONLINE PYMT" }],
        },
      ],
    };
    PROFILES.unshift(trusted);
    try {
      const [outcome] = await importStatementFiles(bundle.db, [OFX]);
      expect(outcome).toMatchObject({ status: "parsed", inserted: 0, supersededTakeover: 0, dedupedCrossFormat: 1 });
    } finally {
      PROFILES.splice(PROFILES.indexOf(trusted), 1);
    }
    const { importFileId: _f, updatedAt: _u, ...carried } = kept;
    expect(row(s.attached)).toMatchObject({ ...carried, importFileId: s.fileId });
    expect(periodOf(s.fileId)!.reconciliation).toBe("reconciled");

    // a statement imported before its lines were recorded
    const { printedLines } = await import("@/db/schema/imports");
    bundle.db.delete(printedLines).where(eq(printedLines.importFileId, s.fileId)).run();
    unimportFile(bundle.db, bundle.db.select().from(importFilesTable).where(eq(importFilesTable.fileName, OFX.name)).get()!.id);

    expect(row(s.attached)).toMatchObject({ ...carried, importFileId: s.fileId, status: "active" });
    expect(periodOf(s.fileId)!.reconciliation).toBe("reconciled");
  });

  test("a kept row its statement's gap had quarantined comes back active — the verdict left with the period", async () => {
    await importStatementFiles(bundle.db, [loadDir("discover", "corrupted")[0]!]);
    const period = bundle.db.select().from(statementPeriods).all()[0]!;
    expect(period.reconciliation).toBe("gap");
    const held = hand(period.accountId, period.periodStart, -1234, "HAND ENTRY");
    attach(held, period.importFileId);
    reconcileAccounts(bundle.db, [period.accountId]);
    expect(bundle.db.select().from(statementPeriods).all()[0]!.reconciliation).toBe("gap");
    expect(row(held)!.status).toBe("quarantined");

    unimportFile(bundle.db, period.importFileId);

    expect(row(held)).toMatchObject({ importFileId: null, fileLinkSource: "attached", status: "active" });
  });

  test("re-importing the same bytes brings the parsed rows back and files the kept row under the statement again — once", async () => {
    const s = await scene();
    const parsedBefore = rowsOf(s.fileId).filter((t) => t.id !== s.attached).length;
    const line = row(s.attached)!;
    // a kept row no period of this statement reaches: it waits for its own statement
    const elsewhere = hand(s.accountId, "2025-05-15", -4321, "HAND ENTRY OUTSIDE THE PERIOD");
    bundle.db
      .update(transactions)
      .set({ fileLinkSource: "attached", notes: "kept from an un-imported statement" })
      .where(eq(transactions.id, elsewhere))
      .run();

    unimportFile(bundle.db, s.fileId);
    const [outcome] = await importStatementFiles(bundle.db, [statement()]);

    expect(outcome!.status).toBe("parsed");
    const again = fileNamed()!;
    expect(again.id).not.toBe(s.fileId);
    expect(row(s.attached)).toMatchObject({
      importFileId: again.id,
      fileLinkSource: "attached",
      status: "active",
      transferGroupId: s.attached,
      recurringSeriesId: s.seriesId,
    });
    const recording = bundle.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, s.accountId),
          eq(transactions.postedOn, line.postedOn),
          eq(transactions.amountCents, line.amountCents),
          ne(transactions.status, "superseded"),
        ),
      )
      .all();
    expect(recording.map((t) => t.id)).toEqual([s.attached]);
    expect(rowsOf(again.id).filter((t) => t.id !== s.attached)).toHaveLength(parsedBefore);
    // absorbing a line is not an attachment: the hand row nobody attached stays the owner's
    expect(row(s.unattached)!.importFileId).toBeNull();
    expect(row(elsewhere)!.importFileId).toBeNull();
    expect(periodOf(again.id)!.reconciliation).toBe("reconciled");
  });

  /**
   * Linking at import claims only what the call inserted or promoted (owner,
   * 2026-09-14). Re-filing a kept row is neither: it was already in the ledger.
   */
  test("the import that files a kept row again does not claim it for a series", async () => {
    const s = await scene();
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: null, seriesLinkSource: null })
      .where(eq(transactions.id, s.attached))
      .run();
    const kept = row(s.attached)!;
    // a confirmed series that owns the kept row's description, through a row outside the statement
    const owner = bundle.db
      .insert(recurringSeries)
      .values({ name: "Hand payments", kind: "subscription", cadence: "monthly", status: "confirmed", intervalDaysAvg: 30 })
      .returning({ id: recurringSeries.id })
      .get().id;
    const sibling = hand(s.accountId, "2024-08-15", kept.amountCents, kept.rawDescription);
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: owner, seriesLinkSource: "detected" })
      .where(eq(transactions.id, sibling))
      .run();

    unimportFile(bundle.db, s.fileId);
    await importStatementFiles(bundle.db, [statement()]);

    expect(row(s.attached)).toMatchObject({ importFileId: fileNamed()!.id, recurringSeriesId: null, seriesLinkSource: null });
    expect(row(sibling)!.recurringSeriesId).toBe(owner);
  });

  /**
   * 🔴 "Transfer legs kept: 5 legs, still linked" over 20260302-statements-9805-.pdf,
   * where one of the five (+$115.00 on 2026-03-02) is alone in its group — as is
   * 20250702's +$20.00 of 2025-06-10 (read-only on the real ledger, 2026-09-15).
   * A kept leg is linked only if its group holds another live row the same
   * un-import does not delete: a partner the file parsed goes, and the un-import
   * then unlinks the kept leg; a superseded member is no transfer at all.
   */
  test("the confirmation counts exactly the rows un-import deletes and keeps, and which kept legs are still linked", async () => {
    const { unimportCountsByFile } = await import("./unimport-counts");
    const s = await scene();
    const other = row(s.partner)!.accountId;
    // a second kept row, and this one is no transfer leg
    attach(s.unattached, s.fileId);
    // a kept leg whose only partner is a row the file parsed
    const doomed = rowsOf(s.fileId).find((t) => t.fileLinkSource === null && t.transferGroupId === null)!;
    // a note on a row the un-import deletes goes with it
    bundle.db.update(transactions).set({ notes: "lost with the row" }).where(eq(transactions.id, doomed.id)).run();
    const orphaned = hand(s.accountId, "2024-10-01", -777, "HAND LEG OF A PARSED ROW");
    attach(orphaned, s.fileId);
    group([orphaned, doomed.id], orphaned);
    // a kept leg whose only other member is superseded
    const lone = hand(s.accountId, "2024-10-02", -888, "HAND LEG OF A RETIRED PAIR");
    attach(lone, s.fileId);
    const retired = hand(other, "2024-10-02", 888, "RETIRED LEG");
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, retired)).run();
    group([lone, retired], lone);
    const counts = unimportCountsByFile(bundle.db).get(s.fileId);
    const rows = rowsOf(s.fileId);

    unimportFile(bundle.db, s.fileId);

    const deleted = rows.filter((t) => row(t.id) === undefined);
    const kept = rows.filter((t) => row(t.id) !== undefined);
    expect(kept.map((t) => t.id).sort()).toEqual([s.attached, s.unattached, orphaned, lone].sort());
    const activeCents = (sign: 1 | -1) =>
      deleted.filter((t) => t.status === "active" && Math.sign(t.amountCents) === sign).reduce((n, t) => n + sign * t.amountCents, 0);
    // linked, read AFTER the un-import: a group that still holds another live row
    const linkedNow = kept.filter((t) => {
      const groupId = row(t.id)!.transferGroupId;
      if (groupId === null) return false;
      return bundle.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.transferGroupId, groupId), ne(transactions.id, t.id), ne(transactions.status, "superseded")))
        .all().length > 0;
    });
    expect(linkedNow.map((t) => t.id)).toEqual([s.attached]);
    expect(row(orphaned)!.transferGroupId).toBeNull();
    expect(counts).toEqual({
      deleted: deleted.length,
      handedOver: 0,
      keptByPrinters: 0,
      kept: 4,
      keptRefiled: 0,
      userCategorizedDeleted: deleted.filter((t) => t.categorizationSource === "user").length,
      notRederivedDeleted: deleted.filter((t) => t.categoryId !== null && (t.categorizationSource === null || t.categorizationSource === "claude")).length,
      notesDeleted: deleted.filter((t) => t.notes !== null).length,
      inflowCents: activeCents(1),
      outflowCents: activeCents(-1),
      duplicateSurvivors: 0,
      transferLegsDeleted: deleted.filter((t) => t.transferGroupId !== null).length,
      transferLegsKept: kept.filter((t) => t.transferGroupId !== null).length,
      transferLegsKeptLinked: linkedNow.length,
    });
    // not vacuous: a leg does go, three kept rows are legs, and the one kept row is the owner's own categorization
    expect(counts!.notesDeleted).toBeGreaterThan(0);
    expect(counts!.transferLegsDeleted).toBeGreaterThan(0);
    expect(counts!.transferLegsKept).toBe(3);
    expect(row(s.attached)!.categorizationSource).toBe("user");
  });

  /**
   * 🔴 A superseded row is history: it holds no money in the ledger and, like
   * every superseded row, no transfer. `redate-sapphire-0630-payment-2026-09-15.ts`
   * retires an attached row under a LIVE statement and files its successor there
   * too, and a version bump leaves superseded attached rows under the retired
   * file. The confirmation counted them with the rows it keeps — "5 rows filed
   * under it by hand keep their money, category, transfer and recurring links"
   * over 4 live ones (review, 2026-09-15, on a copy of the re-dated ledger).
   * The un-import still detaches such a row (its file is about to be deleted) and
   * never deletes it; a re-import files only its live successor again.
   */
  test("a superseded row attached to the file is neither kept money nor a kept leg, and the un-import detaches it without deleting it", async () => {
    const { unimportCountsByFile } = await import("./unimport-counts");
    const s = await scene();
    const retired = hand(s.accountId, "2024-10-03", -999, "PAYMENT — retired by a re-date");
    attach(retired, s.fileId);
    const retiredPartner = hand(row(s.partner)!.accountId, "2024-10-03", 999, "PAYMENT TO VENTURE X");
    group([retired, retiredPartner], retired);
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, retired)).run();

    const counts = unimportCountsByFile(bundle.db).get(s.fileId)!;

    expect({ kept: counts.kept, transferLegsKept: counts.transferLegsKept, transferLegsKeptLinked: counts.transferLegsKeptLinked }).toEqual({
      kept: 1,
      transferLegsKept: 1,
      transferLegsKeptLinked: 1,
    });
    const deletedBefore = counts.deleted;

    unimportFile(bundle.db, s.fileId);

    expect(row(retired)).toMatchObject({ importFileId: null, fileLinkSource: "attached", status: "superseded" });
    expect(row(s.attached)).toMatchObject({ importFileId: null, status: "active" });
    await importStatementFiles(bundle.db, [statement()]);
    const again = fileNamed()!;
    expect(row(s.attached)!.importFileId).toBe(again.id);
    expect(row(retired)!.importFileId).toBeNull();
    expect(rowsOf(again.id).filter((t) => t.fileLinkSource === null)).toHaveLength(deletedBefore);
  });

  /**
   * 🔴 A parser-version re-parse supersedes every row of the file, the attached
   * ones included, and the statement's line comes back as a FRESH row that the
   * carry hands the attached row's note, category and links — but not the
   * marker. The next un-import then deleted that row as parsed, note and links
   * with it, and owner answer (4) stopped protecting all 34 rows after any bump
   * (the review, 2026-09-15, on this fixture).
   */
  test("a parser-version re-parse keeps the marker on the rows that inherit the attached rows, and a later un-import keeps them", async () => {
    const s = await scene();
    // a second attached row with nothing else on it: the marker alone must travel too
    attach(s.unattached, s.fileId);
    const bare = row(s.unattached)!;
    const profileId = fileNamed()!.parserProfile!;

    const [outcome] = await withBumpedParserVersion(profileId, () => importStatementFiles(bundle.db, [statement()]));

    expect(outcome!.status).toBe("parsed");
    expect(row(s.attached)!.status).toBe("superseded");
    expect(row(s.unattached)!.status).toBe("superseded");
    const reparsed = bundle.db
      .select()
      .from(importFilesTable)
      .where(and(eq(importFilesTable.fileName, NAME), ne(importFilesTable.status, "superseded")))
      .get()!;
    const heirOf = (postedOn: string, amountCents: number) =>
      rowsOf(reparsed.id).filter((t) => t.postedOn === postedOn && t.amountCents === amountCents && t.status !== "superseded");
    const line = row(s.attached)!;
    const [heir, ...more] = heirOf(line.postedOn, line.amountCents);
    expect(more).toEqual([]);
    expect(heir).toMatchObject({
      fileLinkSource: "attached",
      status: "active",
      notes: "reconstructed credit-card payment leg",
      categorizationSource: "user",
      transferGroupId: s.attached,
      recurringSeriesId: s.seriesId,
    });
    const [bareHeir] = heirOf(bare.postedOn, bare.amountCents);
    expect(bareHeir).toMatchObject({ fileLinkSource: "attached", status: "active" });
    // …and no row the re-parse produced for any other line took the marker
    expect(rowsOf(reparsed.id).filter((t) => t.fileLinkSource !== null).map((t) => t.id).sort()).toEqual(
      [heir!.id, bareHeir!.id].sort(),
    );

    unimportFile(bundle.db, reparsed.id);

    expect(row(heir!.id)).toMatchObject({
      importFileId: null,
      fileLinkSource: "attached",
      status: "active",
      notes: "reconstructed credit-card payment leg",
      transferGroupId: s.attached,
      recurringSeriesId: s.seriesId,
    });
    expect(row(bareHeir!.id)).toMatchObject({ importFileId: null, fileLinkSource: "attached", status: "active" });
  });

  /** A statement-like file that declares a period over `accountId` and owns no row. */
  function declaredPeriod(accountId: string, name: string, start: string, end: string, printed: boolean): string {
    const { institutionId } = bundle.db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
    const fileId = bundle.db
      .insert(importFilesTable)
      .values({
        fileName: name,
        fileSha256: `declared-${name}`,
        format: "pdf",
        institutionId,
        status: "parsed",
        storagePath: path.join(dir, name),
        importedAt: new Date().toISOString(),
      })
      .returning({ id: importFilesTable.id })
      .get().id;
    bundle.db
      .insert(statementPeriods)
      .values({
        importFileId: fileId,
        accountId,
        periodStart: start,
        periodEnd: end,
        beginningBalanceCents: printed ? 0 : null,
        endingBalanceCents: printed ? 0 : null,
        reconciliation: "not_applicable",
      })
      .run();
    return fileId;
  }

  /**
   * On the real ledger two Chase Sapphire "Spending Report" PDFs declare periods
   * with no printed balance (2025-01-01..2025-12-31, 2026-01-01..2026-07-10), and
   * together they hold every day of the 34 attached rows. Counted as holders,
   * each re-file would find two and leave every one of the 34 detached.
   */
  test("an export's period with no printed balance over the kept row's day does not stop its statement filing it again", async () => {
    const s = await scene();
    declaredPeriod(s.accountId, "Spending Report PDF.pdf", "2024-01-01", "2024-12-31", false);

    unimportFile(bundle.db, s.fileId);
    await importStatementFiles(bundle.db, [statement()]);

    expect(row(s.attached)).toMatchObject({ importFileId: fileNamed()!.id, fileLinkSource: "attached" });
  });

  test("a day two printed periods hold is ambiguous, and the kept row stays detached rather than be guessed into one", async () => {
    const s = await scene();
    const rival = declaredPeriod(s.accountId, "overlapping statement.pdf", "2024-09-01", "2024-12-31", true);

    unimportFile(bundle.db, s.fileId);
    await importStatementFiles(bundle.db, [statement()]);

    const again = fileNamed()!;
    expect(again.id).not.toBe(s.fileId);
    expect(row(s.attached)).toMatchObject({ importFileId: null, fileLinkSource: "attached", status: "active" });
    expect(rowsOf(rival)).toEqual([]);
  });

  test("a superseded row carrying the marker is not filed again — it is not in the ledger", async () => {
    const s = await scene();
    const retired = hand(s.accountId, "2024-10-03", -999, "RETIRED HAND ROW");
    bundle.db
      .update(transactions)
      .set({ fileLinkSource: "attached", status: "superseded" })
      .where(eq(transactions.id, retired))
      .run();

    unimportFile(bundle.db, s.fileId);
    await importStatementFiles(bundle.db, [statement()]);

    expect(row(s.attached)!.importFileId).toBe(fileNamed()!.id);
    expect(row(retired)).toMatchObject({ importFileId: null, status: "superseded" });
  });
});
