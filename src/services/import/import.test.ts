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
import { statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { latestBalances, netWorthSeries, rebuildAccount } from "@/services/derivation";
import { listSplits, setSplits } from "@/services/transaction-splits";
import { fidelityOf, importStatementFiles, migrateStorageLayout, unimportFile, acceptGap, parseContextFor, reconcileAccounts, resolveAccount, type ImportInput } from "./service";
import { PROFILES } from "./profiles";
import { parseChaseCardLines } from "./profiles/chase-card-statement-profile";
import type { ParserProfile } from "./types";
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

    const [outcome] = await withBumpedParserVersion("chase-card-csv", () =>
      importStatementFiles(bundle.db, [FILE]),
    );
    expect(outcome!.carriedForward).toBe(1); // the note alone is worth carrying

    const fresh = liveRow("SHELL OIL");
    expect(fresh.notes).toBe("keep me");
    expect(fresh.categorizationSource).not.toBe("user"); // re-derived, never upgraded
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
   * green. Measured on a copy of the real ledger, 2026-09-15. `consumeIdentity`
   * already falls back to the transaction day for this reason; the carry did not.
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

  test("the confirmation counts exactly the rows un-import deletes and keeps, transfer legs included", async () => {
    const { unimportCountsByFile } = await import("./unimport-counts");
    const s = await scene();
    // a second kept row, and this one is no transfer leg
    attach(s.unattached, s.fileId);
    const counts = unimportCountsByFile(bundle.db).get(s.fileId);
    const rows = rowsOf(s.fileId);

    unimportFile(bundle.db, s.fileId);

    const deleted = rows.filter((t) => row(t.id) === undefined);
    const kept = rows.filter((t) => row(t.id) !== undefined);
    expect(kept.map((t) => t.id).sort()).toEqual([s.attached, s.unattached].sort());
    const activeCents = (sign: 1 | -1) =>
      deleted.filter((t) => t.status === "active" && Math.sign(t.amountCents) === sign).reduce((n, t) => n + sign * t.amountCents, 0);
    expect(counts).toEqual({
      deleted: deleted.length,
      kept: 2,
      userCategorizedDeleted: deleted.filter((t) => t.categorizationSource === "user").length,
      inflowCents: activeCents(1),
      outflowCents: activeCents(-1),
      duplicateSurvivors: 0,
      transferLegsDeleted: deleted.filter((t) => t.transferGroupId !== null).length,
      transferLegsKept: 1,
    });
    // not vacuous: a leg does go, and the one kept row is the owner's own categorization
    expect(counts!.transferLegsDeleted).toBeGreaterThan(0);
    expect(row(s.attached)!.categorizationSource).toBe("user");
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
});
