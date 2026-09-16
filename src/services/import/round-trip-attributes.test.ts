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

  test("what was deleted meanwhile is not given back: a category, a series, a split's category", async () => {
    const { series, snacks, bulk } = await statementWithWork();
    unimportFile(bundle.db, fileId(STATEMENT));
    bundle.db.delete(recurringSeries).where(eq(recurringSeries.id, series)).run();
    bundle.db.delete(categories).where(eq(categories.id, snacks)).run();
    bundle.db.delete(categories).where(eq(categories.id, bulk)).run();

    const [outcome] = await importStatementFiles(bundle.db, [STATEMENT]);

    expect(outcome!.status).toBe("parsed");
    expect(byWords(LINES.linked.rawDescription)).toMatchObject({ recurringSeriesId: null });
    expect(byWords(LINES.noSource.rawDescription)).toMatchObject({ categoryId: null });
    expect(seen(byWords(LINES.split.rawDescription)).splits).toEqual([]);
    // what still exists comes back all the same
    expect(byWords(LINES.split.rawDescription)).toMatchObject({ categoryId: categoryNamed("Groceries"), categorizationSource: "user" });
    expect(byWords(LINES.detached.rawDescription)).toMatchObject({ recurringSeriesId: null, seriesLinkSource: "user", notes: "not the membership" });
  });
});
