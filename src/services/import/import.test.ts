import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { latestBalances, netWorthSeries } from "@/services/derivation";
import { importStatementFiles, migrateStorageLayout, unimportFile, acceptGap, type ImportInput } from "./service";
import { importFiles as importFilesTable } from "@/db/schema/imports";

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
