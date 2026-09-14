import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { latestBalances, netWorthSeries } from "@/services/derivation";
import { listSplits, setSplits } from "@/services/transaction-splits";
import { fidelityOf, importStatementFiles, migrateStorageLayout, unimportFile, acceptGap, parseContextFor, resolveAccount, type ImportInput } from "./service";
import { PROFILES } from "./profiles";
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

    const { knownLast4s } = parseContextFor(bundle.db);
    expect(knownLast4s.Robinhood).toEqual(["3525"]);
    expect(knownLast4s.Chase).toEqual(["3522"]);
    expect(knownLast4s.Discover).toBeUndefined();
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
   * ⚠️ The end-to-end takeover cannot be exercised yet: no Wells Fargo parser
   * profile exists, and `ofxProfile` only ever hints Chase or Capital One, so
   * there is no way to route a higher-fidelity file to that account in a test.
   * What IS asserted here is the decision itself, which is the whole mechanism —
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
