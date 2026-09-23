import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions } from "@/db/schema/transactions";
import { unimportedRowAttributes } from "@/db/schema/unimported-row-attributes";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "@/services/accounts";
import { setSplits } from "@/services/transaction-splits";
import { PROFILES } from "./profiles";
import { importStatementFiles, unimportFile, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";

/**
 * ⚖️ Owner, 2026-09-16 (decision 18): an un-import → re-import round trip gives back what he had set on the rows it
 * removed — the hand categories, the notes, the recurring links — and whatever else the re-parse carry-forward moves:
 * Claude's categories and those with no recorded source (no import sets them again), a "not this one", an exclusion,
 * splits. As it already does for a hand-linked transfer (`unimported-transfers`).
 *
 * 🔴 Measured on a copy of the real ledger, 2026-09-16, before the statement-copies backfill: a round trip of
 * sofi-statement-2025-03.pdf moved 27 rows (−$4,355.96) to Uncategorized — 10 categorized by hand, 17 with no recorded
 * source.
 */

let dir: string;
let bundle: DbBundle;

const PREFIX = "round-trip-attributes-";
const CARD: AccountHint = { institution: "Chase", type: "checking", last4: "4311" };

const LINES = {
  groceries: { postedOn: "2026-05-03", amountCents: -2500, rawDescription: "ZQX HOLLOW MARKET 12" },
  claude: { postedOn: "2026-05-04", amountCents: -900, rawDescription: "ZQX LANTERN KIOSK" },
  noSource: { postedOn: "2026-05-05", amountCents: -1200, rawDescription: "ZQX BRIDGE STALL" },
  linked: { postedOn: "2026-05-06", amountCents: -3000, rawDescription: "ZQX FERN GYM MONTHLY" },
  detached: { postedOn: "2026-05-07", amountCents: -400, rawDescription: "ZQX FERN GYM TOWEL" },
  split: { postedOn: "2026-05-08", amountCents: -5000, rawDescription: "ZQX WAREHOUSE CLUB" },
  excluded: { postedOn: "2026-05-09", amountCents: -700, rawDescription: "ZQX REFUNDABLE DEPOSIT" },
  bare: { postedOn: "2026-05-10", amountCents: -100, rawDescription: "ZQX PLAIN THING" },
  cleared: { postedOn: "2026-05-11", amountCents: -600, rawDescription: "ZQX GIFT WRAP COUNTER" },
  detachOnly: { postedOn: "2026-05-12", amountCents: -3000, rawDescription: "ZQX FERN GYM GUEST PASS" },
} as const;
const LINE_CENTS = Object.values(LINES).reduce((n, l) => n + l.amountCents, 0);

const SECTIONS: Record<string, ParsedStatement[]> = {
  statement: [
    {
      accountHint: CARD,
      txns: Object.values(LINES).map((l) => ({ ...l })),
      period: { start: "2026-05-01", end: "2026-05-31", beginCents: 100_000, endCents: 100_000 + LINE_CENTS },
    },
  ],
  // another file of the same account: a charge of the same money on the same day as the hand-categorized one, in
  // words that describe something else
  stranger: [{ accountHint: CARD, txns: [{ postedOn: "2026-05-03", amountCents: -2500, rawDescription: "UNRELATED PHARMACY 7" }] }],
  // an export of the account, less trusted than the statement's OFX, printing the groceries charge in its own words
  export: [{ accountHint: CARD, txns: [{ postedOn: "2026-05-03", amountCents: -2500, rawDescription: "HOLLOW MKT" }] }],
  // a statement printing two charges of the same money on one day
  twin: [
    {
      accountHint: CARD,
      txns: [
        { postedOn: "2026-05-03", amountCents: -2500, rawDescription: "ZQX HOLLOW MARKET 12" },
        { postedOn: "2026-05-03", amountCents: -2500, rawDescription: "ZQX SECOND COUNTER" },
      ],
    },
  ],
  // two charges of the same money on one day, the first printed with no transaction day…
  pair: [
    {
      accountHint: CARD,
      txns: [
        { postedOn: "2026-05-20", amountCents: -4200, rawDescription: "ZQX KIOSK NORTH" },
        { postedOn: "2026-05-20", transactedOn: "2026-05-20", amountCents: -4200, rawDescription: "ALPHA BAKERY 3" },
      ],
    },
  ],
  // …and another file printing the first in its own words, with no transaction day either
  partner: [{ accountHint: CARD, txns: [{ postedOn: "2026-05-20", amountCents: -4200, rawDescription: "KIOSK N" }] }],
  // the same, the other way round: the charge with the row of its own printed first, and the other file printing the
  // second charge with its transaction day
  pairReversed: [
    {
      accountHint: CARD,
      txns: [
        { postedOn: "2026-05-25", transactedOn: "2026-05-24", amountCents: -5100, rawDescription: "ALPHA BAKERY 3" },
        { postedOn: "2026-05-25", transactedOn: "2026-05-25", amountCents: -5100, rawDescription: "ZQX KIOSK NORTH" },
      ],
    },
  ],
  partnerReversed: [{ accountHint: CARD, txns: [{ postedOn: "2026-05-25", transactedOn: "2026-05-25", amountCents: -5100, rawDescription: "KIOSK N" }] }],
  // one charge, made 06-08 and posted 06-12…
  crossed: [{ accountHint: CARD, txns: [{ postedOn: "2026-06-12", transactedOn: "2026-06-08", amountCents: -4200, rawDescription: "ZQX ORCHARD CAFE" }] }],
  // …and an export that posts it 06-14, beside a NEIGHBOURING charge of the same money made 06-11 and posted on the
  // statement's posted day. Only the transaction day tells the two apart: the words share a prefix either way
  crossedReport: [
    {
      accountHint: CARD,
      txns: [
        { postedOn: "2026-06-14", transactedOn: "2026-06-08", amountCents: -4200, rawDescription: "ZQX ORCHARD CAFE" },
        { postedOn: "2026-06-12", transactedOn: "2026-06-11", amountCents: -4200, rawDescription: "ZQX ORCHARD CART" },
      ],
    },
  ],
  // the same, with the neighbour printed on its posted day alone: nothing contradicts the record, so only the order
  // of the two lenses keeps the record on the charge it was made on
  crossedUndated: [
    {
      accountHint: CARD,
      txns: [
        { postedOn: "2026-06-14", transactedOn: "2026-06-08", amountCents: -4200, rawDescription: "ZQX ORCHARD CAFE" },
        { postedOn: "2026-06-12", amountCents: -4200, rawDescription: "ZQX ORCHARD CART" },
      ],
    },
  ],
  // the neighbour alone, on the record's posted day: the charge the record belongs to is in no file yet
  crossedAlone: [{ accountHint: CARD, txns: [{ postedOn: "2026-06-12", transactedOn: "2026-06-11", amountCents: -4200, rawDescription: "ZQX ORCHARD CART" }] }],
};
SECTIONS["<OFX> statement"] = SECTIONS.statement!;

const profile: ParserProfile = {
  id: "test-round-trip-attributes",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => SECTIONS[f.text.trim()]!,
};

const file = (name: string): ImportInput => ({ name: `${PREFIX}${name}.csv`, buffer: Buffer.from(name) });
const STATEMENT = file("statement");
const STRANGER = file("stranger");
const EXPORT = file("export");
const TWIN = file("twin");
const PAIR = file("pair");
const PARTNER = file("partner");
const PAIR_REVERSED = file("pairReversed");
const PARTNER_REVERSED = file("partnerReversed");
const CROSSED = file("crossed");
const CROSSED_REPORT = file("crossedReport");
const CROSSED_UNDATED = file("crossedUndated");
const CROSSED_ALONE = file("crossedAlone");
/** the statement in a format more trusted than any CSV (`FORMAT_PRIORITY`) */
const OFX_STATEMENT: ImportInput = { name: `${PREFIX}statement.ofx`, buffer: Buffer.from("<OFX> statement") };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-round-trip-attributes-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

type Row = typeof transactions.$inferSelect;
const accountId = () => bundle.db.select().from(accounts).where(eq(accounts.last4, CARD.last4!)).get()!.id;
const fileId = (input: ImportInput) => bundle.db.select().from(importFiles).where(eq(importFiles.fileName, input.name)).get()!.id;
const live = (): Row[] =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId()), ne(transactions.status, "superseded")))
    .orderBy(transactions.postedOn)
    .all();
const byWords = (raw: string): Row => live().find((r) => r.rawDescription === raw)!;
const categoryNamed = (name: string) => bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
/** A category of the owner's own, which nothing else in the seed names — so it can be deleted. */
const ownCategory = (name: string): string =>
  bundle.db.insert(categories).values({ name, kind: "expense" }).returning({ id: categories.id }).get().id;
const set = (raw: string, values: Partial<Row>) =>
  bundle.db.update(transactions).set(values).where(eq(transactions.id, byWords(raw).id)).run();

/** Everything the owner can see of a row but its id and its timestamps. */
function seen(r: Row) {
  const splits = bundle.db
    .select({ categoryId: transactionSplits.categoryId, amountCents: transactionSplits.amountCents, note: transactionSplits.note, sortOrder: transactionSplits.sortOrder })
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, r.id))
    .orderBy(transactionSplits.sortOrder)
    .all();
  const { id: _id, createdAt: _c, updatedAt: _u, importFileId: _f, statementPeriodId: _p, ...rest } = r;
  return { ...rest, splits };
}

/** The owner's work on every line but the bare one, as he leaves it. */
async function statementWithWork(): Promise<{ series: string; snacks: string; bulk: string }> {
  await importStatementFiles(bundle.db, [STATEMENT]);
  const snacks = ownCategory("Snacks");
  const bulk = ownCategory("Bulk buys");
  const series = bundle.db
    .insert(recurringSeries)
    .values({ name: "Fern gym", kind: "subscription", cadence: "monthly", status: "confirmed" })
    .returning({ id: recurringSeries.id })
    .get().id;
  // the merchant and the confidence a category came with are part of it
  const starbucks = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Starbucks")).get()!.id;
  set(LINES.groceries.rawDescription, {
    categoryId: categoryNamed("Groceries"),
    categorizationSource: "user",
    categorizationConfidence: 0.9,
    merchantId: starbucks,
    notes: "for the party",
  });
  set(LINES.claude.rawDescription, {
    categoryId: categoryNamed("Dining"),
    categorizationSource: "claude",
    categorizationConfidence: 0.62,
    merchantId: starbucks,
    needsReview: true,
  });
  set(LINES.noSource.rawDescription, { categoryId: snacks, categorizationSource: null, categorizationConfidence: null });
  set(LINES.linked.rawDescription, { recurringSeriesId: series, seriesLinkSource: "user" });
  set(LINES.detached.rawDescription, { recurringSeriesId: null, seriesLinkSource: "user", notes: "not the membership" });
  setSplits(bundle.db, byWords(LINES.split.rawDescription).id, [
    { categoryId: categoryNamed("Groceries"), amountCents: -3500, note: "food" },
    { categoryId: bulk, amountCents: -1500 },
  ]);
  set(LINES.excluded.rawDescription, { status: "excluded" });
  // "Uncategorized" picked by hand (`applyCorrection`): no category, and the owner's word that it has none
  set(LINES.cleared.rawDescription, { categoryId: null, categorizationSource: "user", categorizationConfidence: 1, needsReview: false });
  // "not this one", and nothing else on the row
  set(LINES.detachOnly.rawDescription, { recurringSeriesId: null, seriesLinkSource: "user" });
  return { series, snacks, bulk };
}

describe("a round trip gives back what the owner set on the rows it removed", () => {
  test("every category no import sets again, the note, the recurring link and the detach, the exclusion and the splits", async () => {
    const { series } = await statementWithWork();
    const before = live().map(seen);
    const period = () => {
      const { id: _id, importFileId: _f, createdAt: _c, updatedAt: _u, ...p } = bundle.db
        .select()
        .from(statementPeriods)
        .where(eq(statementPeriods.accountId, accountId()))
        .get()!;
      return p;
    };
    const verdict = period();
    expect(verdict.reconciliation).toBe("reconciled");

    unimportFile(bundle.db, fileId(STATEMENT));
    expect(live()).toEqual([]);
    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", inserted: 10, givenBack: 9 });
    expect(live().map(seen)).toEqual(before);
    expect(period()).toEqual(verdict);
    // the link counts the charge again
    expect(bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, series)).get()!.lastMatchedOn).toBe(LINES.linked.postedOn);
    // …and each record is spent
    expect(bundle.db.select().from(unimportedRowAttributes).all()).toEqual([]);
  });

  test("a record waits for its own line: a charge of the same money in other words takes nothing", async () => {
    await statementWithWork();
    unimportFile(bundle.db, fileId(STATEMENT));
    expect(bundle.db.select().from(unimportedRowAttributes).all()).toHaveLength(9);

    const [stranger] = await importStatementFiles(bundle.db, [STRANGER]);
    expect(stranger).toMatchObject({ status: "parsed", inserted: 1, givenBack: 0 });
    expect(byWords("UNRELATED PHARMACY 7")).toMatchObject({ categorizationSource: null, notes: null });
    expect(bundle.db.select().from(unimportedRowAttributes).all()).toHaveLength(9);

    // the statement's own line takes it, though the stranger's row now sits on its day
    unimportFile(bundle.db, fileId(STRANGER));
    await importStatementFiles(bundle.db, [STATEMENT]);
    expect(byWords(LINES.groceries.rawDescription)).toMatchObject({ categoryId: categoryNamed("Groceries"), categorizationSource: "user", notes: "for the party" });
  });

  /**
   * 🔴 The transfer came back with the category the pair gave its returning leg and without the merchant that category
   * came with: categorizeAll names a merchant only on a row with no category. Measured on a copy of the real ledger,
   * 2026-09-16 (backfills applied): a round trip of 20260812-statements-3522-.pdf left 3 card payments with no merchant.
   */
  test("a transfer's returning leg takes back the category and the merchant the pair gave it", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    const { id: chase } = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const savings = createAccount(bundle.db, { institutionId: chase, name: "Hand savings", type: "savings" });
    const raw = "FROM CHECKING 4311";
    const partner = bundle.db
      .insert(transactions)
      .values({
        accountId: savings,
        postedOn: LINES.bare.postedOn,
        amountCents: -LINES.bare.amountCents,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId: savings, postedOn: LINES.bare.postedOn, amountCents: 100, rawDescription: raw, occurrenceIndex: 0 }),
      })
      .returning({ id: transactions.id })
      .get().id;
    const leg = byWords(LINES.bare.rawDescription);
    const merchant = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Starbucks")).get()!.id;
    const internal = categoryNamed("Internal Transfer");
    set(LINES.bare.rawDescription, { transferGroupId: leg.id, categoryId: internal, categorizationSource: "transfer_detect", categorizationConfidence: 0.95, merchantId: merchant });
    bundle.db.update(transactions).set({ transferGroupId: leg.id, categoryId: internal, categorizationSource: "transfer_detect" }).where(eq(transactions.id, partner)).run();
    const before = seen(byWords(LINES.bare.rawDescription));

    unimportFile(bundle.db, fileId(STATEMENT));
    await importStatementFiles(bundle.db, [STATEMENT]);

    const back = byWords(LINES.bare.rawDescription);
    expect({ ...seen(back), transferGroupId: null }).toEqual({ ...before, transferGroupId: null });
    expect(back.transferGroupId).not.toBeNull();
    expect(bundle.db.select().from(transactions).where(eq(transactions.id, partner)).get()!.transferGroupId).toBe(back.transferGroupId);
  });

  const records = () => bundle.db.select({ notes: unimportedRowAttributes.notes }).from(unimportedRowAttributes).all();

  /**
   * A line that takes over another file's row inherits that row's attributes (`insertTxn`): it is the live record of the
   * money, and what the owner set on it since outranks what he had set before the un-import. The record only fills what
   * that row leaves empty, and is spent.
   *
   * 🔴 The record was left waiting beside the row that took its line. Un-importing that row's file then wrote a second
   * record of the same line, with the owner's newer work, and the next import gave back the OLDER one (the tie between
   * two records of one line goes to the lower id, and ids grow with time): the review of uc/final-integrate, 2026-09-16,
   * 12 runs of 12.
   */
  test("a line that takes over another file's row keeps that row's newer work, and spends the older record", async () => {
    await importStatementFiles(bundle.db, [OFX_STATEMENT]);
    set(LINES.groceries.rawDescription, { categoryId: categoryNamed("Groceries"), categorizationSource: "user", notes: "before" });
    unimportFile(bundle.db, fileId(OFX_STATEMENT));
    await importStatementFiles(bundle.db, [EXPORT]);
    set("HOLLOW MKT", { categoryId: categoryNamed("Dining"), categorizationSource: "user", notes: "since" });

    const [outcome] = await importStatementFiles(bundle.db, [OFX_STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", supersededTakeover: 1, givenBack: 1 });
    expect(byWords(LINES.groceries.rawDescription)).toMatchObject({ categoryId: categoryNamed("Dining"), notes: "since" });
    expect(records()).toEqual([]);

    // the export's row it took over is history, and leaves no record with its file
    unimportFile(bundle.db, fileId(EXPORT));
    expect(records()).toEqual([]);

    // the newer work is what the line's next round trip gives back
    unimportFile(bundle.db, fileId(OFX_STATEMENT));
    expect(records()).toEqual([{ notes: "since" }]);
    await importStatementFiles(bundle.db, [OFX_STATEMENT]);
    expect(byWords(LINES.groceries.rawDescription)).toMatchObject({ categoryId: categoryNamed("Dining"), categorizationSource: "user", notes: "since" });
    expect(records()).toEqual([]);
  });

  test("…and a row it takes over with nothing set takes the older record whole", async () => {
    await importStatementFiles(bundle.db, [OFX_STATEMENT]);
    set(LINES.groceries.rawDescription, { categoryId: categoryNamed("Groceries"), categorizationSource: "user", notes: "before" });
    unimportFile(bundle.db, fileId(OFX_STATEMENT));
    await importStatementFiles(bundle.db, [EXPORT]);

    const [outcome] = await importStatementFiles(bundle.db, [OFX_STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", supersededTakeover: 1, givenBack: 1 });
    expect(byWords(LINES.groceries.rawDescription)).toMatchObject({ categoryId: categoryNamed("Groceries"), categorizationSource: "user", notes: "before" });
    expect(records()).toEqual([]);
  });

  test("…and an Uncategorized picked by hand outranks the category an engine gave the row it takes over", async () => {
    await importStatementFiles(bundle.db, [OFX_STATEMENT]);
    set(LINES.groceries.rawDescription, { categoryId: null, categorizationSource: "user", categorizationConfidence: 1, needsReview: false });
    unimportFile(bundle.db, fileId(OFX_STATEMENT));
    await importStatementFiles(bundle.db, [EXPORT]);
    set("HOLLOW MKT", { categoryId: categoryNamed("Dining"), categorizationSource: "rule", categorizationConfidence: 0.8 });

    await importStatementFiles(bundle.db, [OFX_STATEMENT]);

    expect(byWords(LINES.groceries.rawDescription)).toMatchObject({ categoryId: null, categorizationSource: "user", categorizationConfidence: 1 });
    expect(records()).toEqual([]);
  });

  /*
   * A line another file's row ABSORBS (the same money, a file as trusted, other words) is the takeover's case without
   * the takeover: that row is the live record of the money. It takes the record — only what it leaves empty — and the
   * record is spent; and once that row is filed under the statement that prints the line, its record waits for that
   * line, in the line's words.
   *
   * 🔴 The record was left waiting beside the row that absorbed its line. Un-importing the export handed that row, with
   * the owner's newer work, to the statement; un-importing the statement wrote a second record of the line, in the
   * export's words; and the statement's next import gave back the OLDER record (hash match) and left the newer one
   * waiting for words no line prints (found while checking the review of uc/final-integrate, 2026-09-17).
   */
  test("a line another file's row absorbs keeps that row's newer work, spends the older record, and its next round trip gives back the newer", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    set(LINES.groceries.rawDescription, { categoryId: categoryNamed("Groceries"), categorizationSource: "user", notes: "before" });
    unimportFile(bundle.db, fileId(STATEMENT));
    await importStatementFiles(bundle.db, [EXPORT]);
    set("HOLLOW MKT", { categoryId: categoryNamed("Dining"), categorizationSource: "user", notes: "since" });

    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", dedupedCrossFormat: 1, givenBack: 1 });
    expect(byWords("HOLLOW MKT")).toMatchObject({ categoryId: categoryNamed("Dining"), notes: "since" });
    expect(records()).toEqual([]);

    // the export's row is the statement's now (it prints the line), and leaves no record with the export
    unimportFile(bundle.db, fileId(EXPORT));
    expect(byWords("HOLLOW MKT")).toMatchObject({ importFileId: fileId(STATEMENT), notes: "since" });
    expect(records()).toEqual([]);

    // the newer work is what the statement's line gets back on its next round trip
    unimportFile(bundle.db, fileId(STATEMENT));
    expect(records()).toEqual([{ notes: "since" }]);
    const [back] = await importStatementFiles(bundle.db, [STATEMENT]);
    expect(back).toMatchObject({ status: "parsed", givenBack: 1 });
    expect(byWords(LINES.groceries.rawDescription)).toMatchObject({ categoryId: categoryNamed("Dining"), categorizationSource: "user", notes: "since" });
    expect(records()).toEqual([]);
  });

  test("…and a row that absorbs it with nothing set takes the record whole", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    set(LINES.groceries.rawDescription, { categoryId: categoryNamed("Groceries"), categorizationSource: "user", notes: "before" });
    unimportFile(bundle.db, fileId(STATEMENT));
    await importStatementFiles(bundle.db, [EXPORT]);

    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome).toMatchObject({ status: "parsed", dedupedCrossFormat: 1, givenBack: 1 });
    expect(byWords("HOLLOW MKT")).toMatchObject({ categoryId: categoryNamed("Groceries"), categorizationSource: "user", notes: "before" });
    expect(records()).toEqual([]);
  });

  /*
   * A file's own row keeps its own words in the record, though another line of the same money and day has no row of
   * the file (another row absorbed it): the record of the second charge must not wait for the first charge's words.
   * 🔴 Matched line by line, the first charge took the only row of that money, and its next import filled the owner's
   * note onto the row that had absorbed the first charge (2026-09-17, while checking the absorbed-line record).
   */
  test("a file's own row is remembered in its own words beside a charge of the same money another row absorbs", async () => {
    await importStatementFiles(bundle.db, [STRANGER]);
    const [first] = await importStatementFiles(bundle.db, [TWIN]);
    expect(first).toMatchObject({ status: "parsed", inserted: 1, dedupedCrossFormat: 1 });
    set("ZQX SECOND COUNTER", { notes: "mine" });
    unimportFile(bundle.db, fileId(TWIN));
    expect(bundle.db.select({ notes: unimportedRowAttributes.notes, words: unimportedRowAttributes.normalizedDescription }).from(unimportedRowAttributes).all()).toEqual([
      { notes: "mine", words: normalizeDescription("ZQX SECOND COUNTER") },
    ]);

    const [back] = await importStatementFiles(bundle.db, [TWIN]);

    expect(back).toMatchObject({ status: "parsed", inserted: 1, dedupedCrossFormat: 1, givenBack: 1 });
    expect(byWords("ZQX SECOND COUNTER")).toMatchObject({ notes: "mine" });
    expect(byWords("UNRELATED PHARMACY 7")).toMatchObject({ notes: null });
    expect(records()).toEqual([]);
  });

  /*
   * The row a line wrote is never taken from it for another line of the same money and day, though that line would
   * record it more surely by its days: the other line has the row it was handed over for.
   * 🔴 Grown into one maximum matching, the second line took the first line's own row and handed the first line the
   * other file's row: each record waited for the other charge's words, and each charge came back with the other's note
   * (2026-09-17, while checking the absorbed-line record).
   */
  test.each([
    ["the charge another file wrote printed first", PAIR, PARTNER],
    ["the charge with a row of its own printed first", PAIR_REVERSED, PARTNER_REVERSED],
  ])("each of two charges of the same money gets back its own note, where one of them is a row another file wrote: %s", async (_, pair, partner) => {
    await importStatementFiles(bundle.db, [partner]);
    const [read] = await importStatementFiles(bundle.db, [pair]);
    expect(read).toMatchObject({ status: "parsed", inserted: 1, dedupedCrossFormat: 1 });
    unimportFile(bundle.db, fileId(partner));
    expect(byWords("KIOSK N")).toMatchObject({ importFileId: fileId(pair) });
    set("KIOSK N", { notes: "the kiosk" });
    set("ALPHA BAKERY 3", { notes: "the bakery" });

    unimportFile(bundle.db, fileId(pair));
    const [back] = await importStatementFiles(bundle.db, [pair]);

    expect(back).toMatchObject({ status: "parsed", inserted: 2, givenBack: 2 });
    expect(byWords("ZQX KIOSK NORTH")).toMatchObject({ notes: "the kiosk" });
    expect(byWords("ALPHA BAKERY 3")).toMatchObject({ notes: "the bakery" });
    expect(records()).toEqual([]);
  });

  /*
   * 🔴 The record was claimed on the posted day first, and no clause refused a line that disagrees about the day the
   * charge was MADE (`claimCarry`). A later file posts a charge on its own day, so the record's posted day is the
   * NEIGHBOURING charge's: the export's 06-12 cart charge outranked the 06-08 cafe charge it was made on, and the
   * owner's category and note came back on the cart while the cafe came back bare. `identityWeight` reads the two
   * days this way round already, and for the same reason: every source fills the transaction day with the real one,
   * so two records of ONE charge never disagree about it.
   */
  test.each([
    ["the neighbour prints its own transaction day", CROSSED_REPORT],
    ["the neighbour prints its posted day alone", CROSSED_UNDATED],
  ])("a record goes to the line made on its transaction day, not to the neighbouring charge that shares its posted day: %s", async (_, report) => {
    await importStatementFiles(bundle.db, [CROSSED]);
    const snacks = ownCategory("Snacks");
    set("ZQX ORCHARD CAFE", { categoryId: snacks, categorizationSource: "user", categorizationConfidence: 1, needsReview: false, notes: "lunch with Carson" });
    unimportFile(bundle.db, fileId(CROSSED));

    const [back] = await importStatementFiles(bundle.db, [report]);

    expect(back).toMatchObject({ status: "parsed", inserted: 2, givenBack: 1 });
    expect(byWords("ZQX ORCHARD CAFE")).toMatchObject({ categoryId: snacks, categorizationSource: "user", notes: "lunch with Carson" });
    const cart = byWords("ZQX ORCHARD CART");
    expect(cart.notes).toBeNull();
    expect(cart.categorizationSource).not.toBe("user");
    expect(cart.categoryId).not.toBe(snacks);
    expect(records()).toEqual([]);
  });

  test("…and where only the neighbour is printed, the record waits: a line made on another day is another charge", async () => {
    await importStatementFiles(bundle.db, [CROSSED]);
    const snacks = ownCategory("Snacks");
    set("ZQX ORCHARD CAFE", { categoryId: snacks, categorizationSource: "user", categorizationConfidence: 1, needsReview: false, notes: "lunch with Carson" });
    unimportFile(bundle.db, fileId(CROSSED));

    const [alone] = await importStatementFiles(bundle.db, [CROSSED_ALONE]);

    expect(alone).toMatchObject({ status: "parsed", inserted: 1, givenBack: 0 });
    expect(byWords("ZQX ORCHARD CART")).toMatchObject({ categoryId: null, categorizationSource: null, notes: null });
    expect(records()).toEqual([{ notes: "lunch with Carson" }]);
  });

  /*
   * 🔴 Nothing failed if a record gave back a merchant deleted while it waited (scripts/unlink-unknown-merchant.ts deletes
   * merchants): the row's merchant is a foreign key, so the statement's next import failed ("FOREIGN KEY constraint
   * failed") and wrote none of its 10 lines (a mutation check of `rememberedRows`, 2026-09-17).
   */
  test("what was deleted meanwhile is not given back: a category, a merchant, a series, a split's category", async () => {
    const { series, snacks, bulk } = await statementWithWork();
    const stall = bundle.db.insert(merchants).values({ canonicalName: "ZQX Bridge Stall" }).returning({ id: merchants.id }).get().id;
    set(LINES.groceries.rawDescription, { merchantId: stall });
    unimportFile(bundle.db, fileId(STATEMENT));
    bundle.db.delete(recurringSeries).where(eq(recurringSeries.id, series)).run();
    bundle.db.delete(categories).where(eq(categories.id, snacks)).run();
    bundle.db.delete(categories).where(eq(categories.id, bulk)).run();
    bundle.db.delete(merchants).where(eq(merchants.id, stall)).run();

    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome!.status).toBe("parsed");
    expect(byWords(LINES.linked.rawDescription)).toMatchObject({ recurringSeriesId: null });
    expect(byWords(LINES.noSource.rawDescription)).toMatchObject({ categoryId: null });
    expect(seen(byWords(LINES.split.rawDescription)).splits).toEqual([]);
    // what still exists comes back all the same, without the merchant that is gone
    expect(byWords(LINES.groceries.rawDescription)).toMatchObject({
      categoryId: categoryNamed("Groceries"),
      categorizationSource: "user",
      merchantId: null,
      notes: "for the party",
    });
    expect(byWords(LINES.split.rawDescription)).toMatchObject({ categoryId: categoryNamed("Groceries"), categorizationSource: "user" });
    expect(byWords(LINES.detached.rawDescription)).toMatchObject({ recurringSeriesId: null, seriesLinkSource: "user", notes: "not the membership" });
  });
});
