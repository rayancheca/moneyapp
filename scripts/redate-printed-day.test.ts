import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { importFiles } from "@/db/schema/imports";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { rebuildAccount } from "@/services/derivation";
import { PROFILES } from "@/services/import/profiles";
import { chaseCardStatementPdf } from "@/services/import/profiles/chase-card-statement-profile";
import type { Line } from "@/services/import/profiles/pdf-profile";
import { asParsedFile, importStatementFiles, parseContextFor, resolveAccount, storedLines, unimportFile, type ImportInput } from "@/services/import/service";
import { sniffFile } from "@/services/import/sniff";
import { unimportCountsByFile } from "@/services/import/unimport-counts";
import { Refusal, applyRedate, classifyRedate, lineFor, type RedateSpec } from "./redate-printed-day";
import { captureLedger, compareLedger } from "./redate-printed-day-guards";

/*
 * Text extraction is the one thing faked, keyed by the fake file's bytes (the seam
 * robinhood-agentic-account.test.ts uses): routing, the Chase card parser, the importer and its re-parse
 * lifecycle all run for real.
 */
const { DOCUMENTS } = vi.hoisted(() => ({ DOCUMENTS: new Map<string, Line[]>() }));
vi.mock("@/services/import/profiles/pdf-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/import/profiles/pdf-profile")>()),
  extractLines: async (buffer: Buffer): Promise<Line[]> => {
    const lines = DOCUMENTS.get(buffer.toString("latin1"));
    if (!lines) throw new Error("no mocked document for these bytes");
    return lines;
  },
}));

const TODAY = "2026-09-15";
const NOTE = "reconstructed credit-card payment leg";
const CARD_PROFILE = "chase-card-statement-pdf";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-redate-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
  DOCUMENTS.clear();
});

/** 20260702-statements-9805-.pdf's shape: a purchase, a parsed $100.00 payment on 06/25, and the 06/30 one. */
function julyStatement(name: string, extra: readonly string[] = []): ImportInput {
  const buffer = Buffer.from(`%PDF-1.4\n${name}`, "latin1");
  const texts = [
    "Account Number: XXXX XXXX XXXX 9805",
    "Previous Balance $464.27",
    // card-side: +42.03 - 100.00 - 100.00 = -157.97
    "New Balance $306.30",
    "Opening/Closing Date 06/03/26 - 07/02/26",
    "Credit Access Line $12,100",
    "Merchant Name or Transaction Description $ Amount",
    "PAYMENTS AND OTHER CREDITS",
    "06/25 Payment Thank You-Mobile -100.00",
    "06/30 Payment Thank You-Mobile -100.00",
    "06/08 UBER *EATS 8005928996 CA 42.03",
    ...extra,
  ];
  DOCUMENTS.set(buffer.toString("latin1"), texts.map((text, i) => ({ y: i, text, tokens: [] })));
  return { name, buffer };
}

const JULY = "20260702-statements-9805-.pdf";

interface Fixture {
  spec: RedateSpec;
  cardId: string;
  checkingId: string;
  file: ImportInput;
}

/**
 * The real history of the row: reconstructed by hand posted 07-01 and transacted 06-30, the statement then
 * imported (its 06/30 line absorbed by the hand row's transaction day), and the row attached to that statement
 * with the marker the attach script writes (`file_link_source`, migration 0016).
 */
async function attachedPayment(): Promise<Fixture> {
  const { db } = bundle;
  const cardId = resolveAccount(db, { institution: "Chase", type: "credit", last4: "9805" });
  const checkingAccountId = resolveAccount(db, { institution: "Chase", type: "checking", last4: "3522" });
  const cardPayment = db.select().from(categories).where(eq(categories.name, "Credit Card Payment")).get()!.id;

  const handRow = (accountId: string, postedOn: string, transactedOn: string | null, cents: number, raw: string) => ({
    accountId,
    postedOn,
    transactedOn,
    amountCents: cents,
    rawDescription: raw,
    normalizedDescription: normalizeDescription(raw),
    categoryId: cardPayment,
    dedupeHash: dedupeHash({ accountId, postedOn, amountCents: cents, rawDescription: raw, occurrenceIndex: 0 }),
  });
  // the ledger opens on a month's first day, so the cards' window (`baselineWindow`) holds June and both legs
  db.insert(transactions).values(handRow(checkingAccountId, "2026-06-01", null, 500000, "OPENING DEPOSIT")).run();
  const checkingId = db
    .insert(transactions)
    .values({ ...handRow(checkingAccountId, "2026-07-01", null, -10000, "Payment to Chase card ending in 9805 07/01"), categorizationSource: "claude" })
    .returning({ id: transactions.id })
    .get().id;
  db.update(transactions).set({ transferGroupId: checkingId }).where(eq(transactions.id, checkingId)).run();
  const rowId = db
    .insert(transactions)
    .values({
      ...handRow(cardId, "2026-07-01", "2026-06-30", 10000, "PAYMENT — Chase ····3522 · Payment to Chase card ending in 9805 07/01"),
      categorizationSource: "transfer_detect",
      categorizationConfidence: 1,
      notes: NOTE,
      transferGroupId: checkingId,
    })
    .returning({ id: transactions.id })
    .get().id;

  const file = julyStatement(JULY);
  const [outcome] = await importStatementFiles(db, [file]);
  expect(outcome).toMatchObject({ status: "parsed", inserted: 2, dedupedCrossFormat: 1 });
  const importFileId = db.select().from(importFiles).where(eq(importFiles.fileName, JULY)).get()!.id;
  db.update(transactions).set({ importFileId, fileLinkSource: "attached" }).where(eq(transactions.id, rowId)).run();
  rebuildAccount(db, cardId, TODAY);
  rebuildAccount(db, checkingAccountId, TODAY);

  return {
    cardId,
    checkingId,
    file,
    spec: {
      rowId,
      accountId: cardId,
      importFileId,
      postedOn: "2026-07-01",
      printedOn: "2026-06-30",
      amountCents: 10000,
      transferGroupId: checkingId,
      notes: NOTE,
      retireNote: (successorId) => `re-dated onto its printed day, successor ${successorId}`,
    },
  };
}

async function julyLines(f: Fixture) {
  const [statement] = asParsedFile(await chaseCardStatementPdf.parse(sniffFile(f.file.name, f.file.buffer), parseContextFor(bundle.db))).statements;
  return storedLines(f.cardId, { type: "credit" }, statement!);
}

type Row = Record<string, unknown>;
const rowById = (id: string): Row => bundle.sqlite.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Row;
const liveGroup = (groupId: string): string[] =>
  (
    bundle.sqlite
      .prepare("SELECT id FROM transactions WHERE transfer_group_id = ? AND status != 'superseded' ORDER BY id")
      .all(groupId) as { id: string }[]
  ).map((r) => r.id);
const balanceOn = (accountId: string, day: string): number =>
  (bundle.sqlite.prepare("SELECT balance_cents b FROM daily_balances WHERE account_id = ? AND day = ?").get(accountId, day) as { b: number }).b;
const livePaymentsOf = (accountId: string) =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.amountCents, 10000), ne(transactions.status, "superseded")))
    .all()
    .sort((a, b) => a.postedOn.localeCompare(b.postedOn));

async function redated(f: Fixture): Promise<string> {
  const line = lineFor(await julyLines(f), f.spec);
  expect(classifyRedate(bundle, f.spec, line)).toEqual({ kind: "pending" });
  const successorId = applyRedate(bundle, f.spec, line);
  rebuildAccount(bundle.db, f.cardId, TODAY);
  return successorId;
}

describe("applyRedate — the app's supersede-and-replace, for one row", () => {
  test("the successor is the row the statement prints on 06/30, and carries every other column", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    const before = rowById(f.spec.rowId);

    const successorId = await redated(f);

    const successor = rowById(successorId);
    expect(successor).toMatchObject({
      posted_on: "2026-06-30",
      transacted_on: "2026-06-30",
      raw_description: "Payment Thank You-Mobile",
      normalized_description: normalizeDescription("Payment Thank You-Mobile"),
      occurrence_index: 0,
      dedupe_hash: line.hash,
      status: "active",
      transfer_group_id: f.checkingId,
      notes: NOTE,
      import_file_id: f.spec.importFileId,
      categorization_source: "transfer_detect",
    });
    const identity = new Set(["id", "posted_on", "transacted_on", "raw_description", "normalized_description", "occurrence_index", "dedupe_hash", "updated_at"]);
    const carried = Object.keys(before).filter((c) => !identity.has(c));
    expect(carried).toContain("created_at");
    expect(Object.fromEntries(carried.map((c) => [c, successor[c]]))).toEqual(Object.fromEntries(carried.map((c) => [c, before[c]])));

    expect(rowById(f.spec.rowId)).toMatchObject({
      status: "superseded",
      transfer_group_id: null,
      posted_on: "2026-07-01",
      notes: `${NOTE} · re-dated onto its printed day, successor ${successorId}`,
    });
    expect(liveGroup(f.checkingId)).toEqual([f.checkingId, successorId].sort());
    expect(classifyRedate(bundle, f.spec, line)).toEqual({ kind: "applied", successorId });
  });

  test("every column the table holds travels — the attached marker, and one a later migration adds", async () => {
    const f = await attachedPayment();
    // a column no schema in this checkout knows: the carry reads the table, not the schema
    bundle.sqlite.exec("ALTER TABLE transactions ADD COLUMN later_migration_column TEXT");
    bundle.sqlite.prepare("UPDATE transactions SET later_migration_column = 'carried' WHERE id = ?").run(f.spec.rowId);

    const successorId = await redated(f);

    expect(rowById(successorId)).toMatchObject({ file_link_source: "attached", later_migration_column: "carried" });
  });

  test("only the card's balance on the printed day moves, by the payment", async () => {
    const f = await attachedPayment();
    expect([balanceOn(f.cardId, "2026-06-30"), balanceOn(f.cardId, "2026-07-01")]).toEqual([-46427 + 10000 - 4203, -46427 + 10000 - 4203 + 10000]);
    const before = captureLedger(bundle, TODAY);

    const successorId = await redated(f);

    const report = compareLedger(before, captureLedger(bundle, TODAY), f.spec, successorId);
    expect(report.failures).toEqual([]);
    expect([balanceOn(f.cardId, "2026-06-30"), balanceOn(f.cardId, "2026-07-01")]).toEqual([-46427 + 10000 - 4203 + 10000, -46427 + 10000 - 4203 + 10000]);
  });

  test("the guards fail when anything but that day and those two rows moves", async () => {
    const f = await attachedPayment();
    const before = captureLedger(bundle, TODAY);
    const successorId = await redated(f);
    // a day inside the card's period that the re-date does not move
    const bumped = bundle.sqlite
      .prepare("UPDATE daily_balances SET balance_cents = balance_cents + 1 WHERE account_id = ? AND day = '2026-06-20'")
      .run(f.cardId);
    expect(bumped.changes).toBe(1);
    const uber = bundle.db.select().from(transactions).where(eq(transactions.rawDescription, "UBER *EATS 8005928996 CA")).get()!;
    bundle.sqlite.prepare("UPDATE transactions SET notes = 'touched' WHERE id = ?").run(uber.id);

    const { failures } = compareLedger(before, captureLedger(bundle, TODAY), f.spec, successorId);
    expect(failures.join(" | ")).toMatch(/daily_balances/);
    expect(failures.join(" | ")).toMatch(/every other transaction row/);
  });

  /*
   * One tamper per guard, applied after a correct re-date: each guard must be able to fail on its own. The
   * review (2026-09-15) deleted eight of them with this file still green.
   */
  const touch = (query: string, ...params: unknown[]): void => {
    expect(bundle.sqlite.prepare(query).run(...params).changes).toBeGreaterThan(0);
  };
  const uberId = (): string =>
    bundle.db.select().from(transactions).where(eq(transactions.rawDescription, "UBER *EATS 8005928996 CA")).get()!.id;
  const june25Id = (cardId: string): string => livePaymentsOf(cardId).find((r) => r.postedOn === "2026-06-25")!.id;
  test.each<[string, RegExp, (f: Fixture) => void]>([
    [
      "daily_balances: only the re-dated account, on the moved days, by the amount",
      /2026-06-20 changed basis/,
      (f) =>
        touch(
          "UPDATE daily_balances SET basis = CASE basis WHEN 'derived' THEN 'anchored' ELSE 'derived' END WHERE account_id = ? AND day = '2026-06-20'",
          f.cardId,
        ),
    ],
    [
      "net worth: the moved days by the amount, every other day identical",
      /2026-06-20: -?\d+ → -?\d+/,
      (f) => touch("UPDATE daily_balances SET balance_cents = balance_cents + 1 WHERE account_id = ? AND day = '2026-06-20'", f.cardId),
    ],
    ["statement periods (every column)", /./, (f) => touch("UPDATE statement_periods SET reconciliation = 'accepted' WHERE import_file_id = ?", f.spec.importFileId)],
    ["statuses: superseded +1, every other status identical", /excluded \+1/, () => touch("UPDATE transactions SET status = 'excluded' WHERE id = ?", uberId())],
    ["active rows: count and sum identical", /→/, () => touch("UPDATE transactions SET status = 'excluded' WHERE id = ?", uberId())],
    ["transfer group sizes identical", /./, (f) => touch("UPDATE transactions SET transfer_group_id = NULL WHERE id = ?", f.checkingId)],
    ["no superseded row gains a link", /0 → 1/, (f) => touch("UPDATE transactions SET transfer_group_id = ? WHERE id = ?", f.checkingId, f.spec.rowId)],
    [
      "transfer groups inside one account unchanged",
      /0 → 1/,
      (f) => touch("UPDATE transactions SET transfer_group_id = ? WHERE id IN (?, ?)", uberId(), uberId(), june25Id(f.cardId)),
    ],
    ["the transfers card reads identically", /card\./, (f) => touch("UPDATE transactions SET transfer_group_id = NULL WHERE id = ?", f.checkingId)],
    ["un-importing any file deletes and keeps what it did", /"kept":2/, () => touch("UPDATE transactions SET file_link_source = 'attached' WHERE id = ?", uberId())],
  ])("the guard %s fails on its own tamper", async (name, detail, tamper) => {
    const f = await attachedPayment();
    const before = captureLedger(bundle, TODAY);
    const successorId = await redated(f);
    expect(compareLedger(before, captureLedger(bundle, TODAY), f.spec, successorId).failures).toEqual([]);

    tamper(f);

    const report = compareLedger(before, captureLedger(bundle, TODAY), f.spec, successorId);
    expect(report.failures).toContain(name);
    expect(report.lines.find((l) => l.startsWith(`FAIL  ${name} — `))).toMatch(detail);
  });

  test("the balance guard fails when the printed day did not move — a re-date whose balances were never rebuilt", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    const before = captureLedger(bundle, TODAY);

    const successorId = applyRedate(bundle, f.spec, line);

    const report = compareLedger(before, captureLedger(bundle, TODAY), f.spec, successorId);
    expect(report.failures).toContain("daily_balances: only the re-dated account, on the moved days, by the amount");
    expect(report.lines.join("\n")).toMatch(/2026-06-30 did not move/);
  });
});

describe("classifyRedate — the measured state, this write's state, or a refusal", () => {
  test("a re-run finds nothing to do, and a second write is refused by the row it would retire", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    const successorId = await redated(f);

    expect(classifyRedate(bundle, f.spec, line)).toEqual({ kind: "applied", successorId });
    expect(() => applyRedate(bundle, f.spec, line)).toThrow(/retire/);
    expect(livePaymentsOf(f.cardId).map((r) => r.postedOn)).toEqual(["2026-06-25", "2026-06-30"]);
  });

  test("a mix of the two states is refused", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    const successorId = await redated(f);
    bundle.sqlite.prepare("UPDATE transactions SET notes = 'edited since' WHERE id = ?").run(successorId);

    expect(() => classifyRedate(bundle, f.spec, line)).toThrow(Refusal);
  });

  test("a row that is not as measured is refused, and so is one with work a supersede would strand", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    bundle.sqlite.prepare("UPDATE transactions SET posted_on = '2026-07-02' WHERE id = ?").run(f.spec.rowId);
    expect(() => classifyRedate(bundle, f.spec, line)).toThrow(/posted_on/);

    bundle.sqlite.prepare("UPDATE transactions SET posted_on = '2026-07-01' WHERE id = ?").run(f.spec.rowId);
    const other = bundle.db.select().from(categories).where(eq(categories.kind, "expense")).get()!.id;
    bundle.db.insert(transactionSplits).values([
      { transactionId: f.spec.rowId, categoryId: other, amountCents: 4000 },
      { transactionId: f.spec.rowId, categoryId: other, amountCents: 6000 },
    ]).run();
    expect(() => classifyRedate(bundle, f.spec, line)).toThrow(/transaction_splits/);
  });

  test("a row whose file prints no one period holding both days is refused", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    bundle.sqlite.prepare("UPDATE statement_periods SET period_end = '2026-06-30' WHERE import_file_id = ?").run(f.spec.importFileId);

    expect(() => classifyRedate(bundle, f.spec, line)).toThrow(/not one period holding 2026-07-01 and 2026-06-30/);
  });

  test("a row whose group is not one opposite leg in another account is refused", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    bundle.sqlite.prepare("UPDATE transactions SET amount_cents = -9999 WHERE id = ?").run(f.checkingId);

    expect(() => classifyRedate(bundle, f.spec, line)).toThrow(/not one opposite leg in another account/);
  });

  test("a row whose printed line a live row already records under its hash is refused", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    const uber = bundle.db.select().from(transactions).where(eq(transactions.rawDescription, "UBER *EATS 8005928996 CA")).get()!;
    bundle.sqlite.prepare("UPDATE transactions SET dedupe_hash = ? WHERE id = ?").run(line.hash, uber.id);

    expect(() => classifyRedate(bundle, f.spec, line)).toThrow(/1 live row\(s\) already hold the line's dedupe_hash/);
    expect(() => applyRedate(bundle, f.spec, line)).toThrow(Refusal);
  });

  test("lineFor refuses a day the statement does not print once, and a line it stores on another day", async () => {
    const f = await attachedPayment();
    const lines = await julyLines(f);
    expect(() => lineFor(lines, { printedOn: "2026-06-29", amountCents: 10000 })).toThrow(/0 printed lines/);

    const straddler = julyStatement("straddler.pdf", []);
    DOCUMENTS.set(
      straddler.buffer.toString("latin1"),
      [...DOCUMENTS.get(straddler.buffer.toString("latin1"))!, { y: 99, text: "06/02 CITY OF MIAMI BEACH 305-673-7000 FL 17.13", tokens: [] }].map((l) =>
        l.text.startsWith("New Balance") ? { ...l, text: "New Balance $323.43" } : l,
      ),
    );
    const [statement] = asParsedFile(await chaseCardStatementPdf.parse(sniffFile(straddler.name, straddler.buffer), parseContextFor(bundle.db))).statements;
    const withStraddler = storedLines(f.cardId, { type: "credit" }, statement!);
    expect(() => lineFor(withStraddler, { printedOn: "2026-06-02", amountCents: -1713 })).toThrow(/stores it on 2026-06-03/);
  });
});

describe("after the re-date, the card parser leaves it where the owner put it", () => {
  async function withBumpedCardParser<T>(fn: () => Promise<T>): Promise<T> {
    const profile = PROFILES.find((p) => p.id === CARD_PROFILE)!;
    const original = profile.version;
    profile.version = original + 1;
    try {
      return await fn();
    } finally {
      profile.version = original;
    }
  }

  test("a parser-version re-parse neither duplicates it nor moves it, and keeps its link and note", async () => {
    const f = await attachedPayment();
    const line = lineFor(await julyLines(f), f.spec);
    await redated(f);
    const balances = () =>
      bundle.sqlite.prepare("SELECT account_id, day, balance_cents, basis FROM daily_balances WHERE day <= ? ORDER BY account_id, day").all(TODAY);
    const before = balances();

    const [outcome] = await withBumpedCardParser(() => importStatementFiles(bundle.db, [f.file]));
    rebuildAccount(bundle.db, f.cardId, TODAY);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 3 });
    const [june25, june30] = livePaymentsOf(f.cardId);
    expect(livePaymentsOf(f.cardId)).toHaveLength(2);
    expect(june25!.postedOn).toBe("2026-06-25");
    expect(june30).toMatchObject({ postedOn: "2026-06-30", notes: NOTE, transferGroupId: f.checkingId, dedupeHash: line.hash, fileLinkSource: "attached" });
    expect(liveGroup(f.checkingId)).toEqual([f.checkingId, june30!.id].sort());
    expect(balances()).toEqual(before);
  });

  test("a re-downloaded copy of the statement finds every line under its own hash and records nothing twice", async () => {
    const f = await attachedPayment();
    await redated(f);

    const [outcome] = await importStatementFiles(bundle.db, [julyStatement("20260702-statements-9805- (1).pdf")]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 0, deduped: 3, dedupedCrossFormat: 0 });
    expect(livePaymentsOf(f.cardId).map((r) => r.postedOn)).toEqual(["2026-06-25", "2026-06-30"]);
  });

  test("un-importing the statement keeps the successor and its history, counts it once, and a re-import files the successor again", async () => {
    const f = await attachedPayment();
    const counted = unimportCountsByFile(bundle.db).get(f.spec.importFileId);
    expect(counted).toMatchObject({ deleted: 2, kept: 1, transferLegsKept: 1, transferLegsKeptLinked: 1 });
    const successorId = await redated(f);
    expect(unimportCountsByFile(bundle.db).get(f.spec.importFileId)).toEqual(counted);

    unimportFile(bundle.db, f.spec.importFileId);

    expect(rowById(successorId)).toMatchObject({ import_file_id: null, file_link_source: "attached", status: "active", transfer_group_id: f.checkingId, notes: NOTE });
    expect(rowById(f.spec.rowId)).toMatchObject({ import_file_id: null, status: "superseded", posted_on: "2026-07-01" });
    expect(livePaymentsOf(f.cardId).map((r) => r.postedOn)).toEqual(["2026-06-30"]);

    const [outcome] = await importStatementFiles(bundle.db, [julyStatement(JULY)]);

    const again = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, JULY)).get()!;
    expect(outcome).toMatchObject({ status: "parsed", inserted: 2 });
    expect(rowById(successorId)).toMatchObject({ import_file_id: again.id, file_link_source: "attached", status: "active" });
    expect(rowById(f.spec.rowId).import_file_id).toBeNull();
    expect(livePaymentsOf(f.cardId).map((r) => r.postedOn)).toEqual(["2026-06-25", "2026-06-30"]);
  });
});
