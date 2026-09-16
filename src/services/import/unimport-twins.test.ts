import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { duplicateCandidates, type DuplicateReason } from "@/db/schema/duplicate-candidates";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash, duplicatePairKey, type DuplicatePairSide } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "@/services/accounts";
import { importStatementFiles, unimportFile, type ImportInput } from "./service";

/**
 * 🔴 Un-importing a statement and importing the same bytes again did not end
 * where it started. Measured 2026-09-16 on a copy of the real ledger, through
 * `unimportFile` and `importStatementFiles`: 20260302-statements-9805-.pdf came
 * back with its period at `gap` −$798.48, 9 rows quarantined, and
 * `pnpm ledger-check` exit 1 (a new break 2026-02-02 → 2026-03-02 off $697.00,
 * $798.48 of money in the chain with no source document).
 *
 * Its four parsed payments are each the kept side of a confirmed duplicate
 * whose retired side is a hand-entered mirror dated a day later with no
 * transaction day. The un-import rightly restores the four mirrors — their
 * money would otherwise be recorded by no row — but the re-import's identity
 * rule matches only an exact day, so it inserted the four printed lines beside
 * them, and nothing retired the mirrors again.
 *
 * Every row here is synthetic: the Venture X fixture statement, and rows
 * written by hand in the shape the real ledger holds.
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");
const VENTURE = "capone-venturex-2024-09-20_2024-10-19.pdf";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-twins-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

function venture(): ImportInput {
  const p = path.join(FIXTURES, "capital-one", "statements", VENTURE);
  return { name: VENTURE, buffer: fs.readFileSync(p) };
}

type Row = typeof transactions.$inferSelect;
const row = (id: string): Row | undefined => bundle.db.select().from(transactions).where(eq(transactions.id, id)).get();
const fileNamed = (name: string) => bundle.db.select().from(importFiles).where(eq(importFiles.fileName, name)).get();
const rowsOfFile = (fileId: string): Row[] =>
  bundle.db.select().from(transactions).where(eq(transactions.importFileId, fileId)).all();
const candidate = (id: string) => bundle.db.select().from(duplicateCandidates).where(eq(duplicateCandidates.id, id)).get()!;

const sideOf = (t: Pick<Row, "postedOn" | "transactedOn" | "amountCents" | "normalizedDescription">): DuplicatePairSide => ({
  postedOn: t.postedOn,
  transactedOn: t.transactedOn,
  amountCents: t.amountCents,
  normalizedDescription: t.normalizedDescription,
});

let seq = 0;
function hand(input: {
  accountId: string;
  postedOn: string;
  amountCents: number;
  raw: string;
  status?: Row["status"];
  transactedOn?: string | null;
}): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: input.accountId,
      postedOn: input.postedOn,
      transactedOn: input.transactedOn ?? null,
      amountCents: input.amountCents,
      rawDescription: input.raw,
      normalizedDescription: normalizeDescription(input.raw),
      status: input.status ?? "active",
      dedupeHash: dedupeHash({
        accountId: input.accountId,
        postedOn: input.postedOn,
        amountCents: input.amountCents,
        rawDescription: input.raw,
        occurrenceIndex: 1000 + seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/**
 * A retirement as the owner's verdict records it: the retired side superseded,
 * the pair confirmed and naming it — the shape `resolveDuplicate` and
 * scripts/fix-card-payment-mirrors.ts both write. `keyedAs` overrides the kept
 * side's content in the key, for a pair recorded before a later write moved it.
 */
function confirmPair(
  kept: string,
  retired: string,
  reason: DuplicateReason,
  keyedAs: Partial<DuplicatePairSide> = {},
): string {
  const k = row(kept)!;
  const r = row(retired)!;
  bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, retired)).run();
  const [a, b] = [kept, retired].sort() as [string, string];
  return bundle.db
    .insert(duplicateCandidates)
    .values({
      accountId: k.accountId,
      transactionIdA: a,
      transactionIdB: b,
      pairKey: duplicatePairKey(k.accountId, { ...sideOf(k), ...keyedAs }, sideOf(r)),
      reason,
      reasonDetail: "synthetic",
      resolution: "confirmed_duplicate",
      resolvedAt: "2026-08-01",
      retiredTransactionId: retired,
      retiredFromStatus: r.status,
    })
    .returning({ id: duplicateCandidates.id })
    .get().id;
}

function group(ids: readonly string[], groupId: string): void {
  for (const id of ids) {
    bundle.db.update(transactions).set({ transferGroupId: groupId }).where(eq(transactions.id, id)).run();
  }
}

function checkingAccount(): string {
  const { id } = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  return createAccount(bundle.db, { institutionId: id, name: "Hand checking", type: "checking" });
}

/**
 * Everything the owner can see of the ledger, with the ids taken out — a round
 * trip gives the rows it re-imports new ids, and nothing else may differ:
 * every row's money, day, words, file, status, category, note, review flag and
 * which rows it is linked with as a transfer; every period's verdict and gap;
 * every derived daily balance; and every duplicate verdict with the content of
 * the rows it names.
 */
function ledger(opts: { withPairKeys: boolean } = { withPairKeys: true }) {
  const names = new Map(bundle.db.select().from(importFiles).all().map((f) => [f.id, f.fileName]));
  const accountNames = new Map(bundle.db.select().from(accounts).all().map((a) => [a.id, a.name]));
  const all = bundle.db.select().from(transactions).all();
  const content = (t: Row): string =>
    JSON.stringify([
      accountNames.get(t.accountId),
      t.postedOn,
      t.transactedOn,
      t.amountCents,
      t.rawDescription,
      t.importFileId === null ? null : names.get(t.importFileId),
      t.fileLinkSource,
      t.status,
      t.needsReview,
      t.categoryId,
      t.categorizationSource,
      t.notes,
      t.recurringSeriesId,
      t.seriesLinkSource,
    ]);
  const partners = (t: Row): string[] =>
    t.transferGroupId === null
      ? []
      : all
          .filter((o) => o.id !== t.id && o.status !== "superseded" && o.transferGroupId === t.transferGroupId)
          .map(content)
          .sort();
  const byId = new Map(all.map((t) => [t.id, t]));
  const side = (id: string | null): string | null => (id === null ? null : content(byId.get(id)!));
  return {
    rows: all.map((t) => JSON.stringify([content(t), t.transferGroupId !== null, partners(t)])).sort(),
    periods: bundle.db
      .select()
      .from(statementPeriods)
      .all()
      .map((p) =>
        JSON.stringify([names.get(p.importFileId), p.periodStart, p.periodEnd, p.beginningBalanceCents, p.endingBalanceCents, p.reconciliation, p.gapCents]),
      )
      .sort(),
    balances: bundle.db
      .select()
      .from(dailyBalances)
      .all()
      .map((b) => JSON.stringify([accountNames.get(b.accountId), b.day, b.balanceCents, b.basis]))
      .sort(),
    pairs: bundle.db
      .select()
      .from(duplicateCandidates)
      .all()
      .map((c) =>
        JSON.stringify([
          c.reason,
          c.resolution,
          c.resolvedAt,
          c.retiredFromStatus,
          side(c.retiredTransactionId),
          [side(c.transactionIdA), side(c.transactionIdB)].sort(),
          opts.withPairKeys ? c.pairKey : null,
        ]),
      )
      .sort(),
  };
}

interface MirrorScene {
  fileId: string;
  cardId: string;
  payment: Row;
  mirror: string;
  partner: string;
  candidateId: string;
}

/**
 * The real shape: a statement's payment line, kept; its hand-entered mirror
 * dated the day after with no transaction day, retired; and the checking leg
 * of the payment, grouped with the kept line.
 */
async function mirrorScene(keyedAs: Partial<DuplicatePairSide> = {}): Promise<MirrorScene> {
  await importStatementFiles(bundle.db, [venture()]);
  const fileId = fileNamed(VENTURE)!.id;
  const payment = rowsOfFile(fileId).find((t) => t.amountCents > 0)!;
  expect(payment).toMatchObject({ postedOn: "2024-10-09", transactedOn: null, amountCents: 57212 });
  const cardId = payment.accountId;
  // inside the statement's period (2024-09-20 → 2024-10-19), so a second live copy breaks it
  const mirror = hand({ accountId: cardId, postedOn: "2024-10-10", amountCents: 57212, raw: "PAYMENT — Hand checking · CAPITAL ONE CRCARDPMT" });
  const partner = hand({ accountId: checkingAccount(), postedOn: "2024-10-09", amountCents: -57212, raw: "CAPITAL ONE CRCARDPMT" });
  const candidateId = confirmPair(payment.id, mirror, "card_payment_mirror", keyedAs);
  group([payment.id, partner], "group-payment");
  return { fileId, cardId, payment, mirror, partner, candidateId };
}

describe("un-importing a statement and importing it again ends where it started", () => {
  test("a retired mirror of a kept payment is retired again, and the period still closes", async () => {
    const s = await mirrorScene();
    const before = ledger();
    expect(bundle.db.select().from(statementPeriods).get()!.reconciliation).toBe("reconciled");

    unimportFile(bundle.db, s.fileId);
    const whileOut = { mirror: row(s.mirror)!, partner: row(s.partner)! };

    const [outcome] = await importStatementFiles(bundle.db, [venture()]);
    expect(outcome!.status).toBe("parsed");

    const again = fileNamed(VENTURE)!;
    expect(bundle.db.select().from(statementPeriods).get()).toMatchObject({ reconciliation: "reconciled", gapCents: null });
    expect(bundle.db.select().from(transactions).where(eq(transactions.status, "quarantined")).all()).toEqual([]);
    // while the file was out, the mirror recorded the payment — and carried its transfer
    expect(whileOut.mirror).toMatchObject({ status: "active", transferGroupId: "group-payment" });
    expect(whileOut.partner.transferGroupId).toBe("group-payment");
    const kept = rowsOfFile(again.id).find((t) => t.amountCents > 0)!;
    expect(row(s.mirror)).toMatchObject({ status: "superseded", transferGroupId: null, needsReview: false });
    expect(kept.transferGroupId).toBe("group-payment");
    expect(candidate(s.candidateId)).toMatchObject({
      resolution: "confirmed_duplicate",
      retiredTransactionId: s.mirror,
      retiredFromStatus: "active",
      transactionIdA: [kept.id, s.mirror].sort()[0],
      transactionIdB: [kept.id, s.mirror].sort()[1],
    });
    expect(ledger()).toEqual(before);
  });

  /**
   * One of the 71 real pairs was recorded before a later write moved its kept
   * line (2025-07-03 now, transacted 2025-07-02): its key no longer names the
   * row. The re-import can only recognise the line it prints, so the un-import
   * records the pair as the ledger holds it at the moment the kept side leaves.
   */
  test("a pair recorded before its kept line was moved still comes back retired", async () => {
    const s = await mirrorScene({ postedOn: "2024-10-08" });
    const before = ledger({ withPairKeys: false });

    unimportFile(bundle.db, s.fileId);
    await importStatementFiles(bundle.db, [venture()]);

    expect(row(s.mirror)!.status).toBe("superseded");
    expect(bundle.db.select().from(statementPeriods).get()!.reconciliation).toBe("reconciled");
    expect(ledger({ withPairKeys: false })).toEqual(before);
    const kept = rowsOfFile(fileNamed(VENTURE)!.id).find((t) => t.amountCents > 0)!;
    expect(candidate(s.candidateId).pairKey).toBe(duplicatePairKey(s.cardId, sideOf(kept), sideOf(row(s.mirror)!)));
  });

  /**
   * A same-day copy from another source is matched by the importer's identity
   * rule, so the re-import would drop the statement's own line against the
   * restored copy and leave the copy standing in for it for good.
   */
  test("a retired same-day copy does not swallow the line it was retired for", async () => {
    await importStatementFiles(bundle.db, [venture()]);
    const fileId = fileNamed(VENTURE)!.id;
    const chevron = rowsOfFile(fileId).find((t) => t.rawDescription.startsWith("CHEVRON"))!;
    const copy = hand({ accountId: chevron.accountId, postedOn: chevron.postedOn, amountCents: chevron.amountCents, raw: "CHEVRON BROOKLYN NY" });
    const candidateId = confirmPair(chevron.id, copy, "cross_source_same_day");
    const before = ledger();
    const lines = rowsOfFile(fileId).length;

    unimportFile(bundle.db, fileId);
    expect(row(copy)!.status).toBe("active");
    const [outcome] = await importStatementFiles(bundle.db, [venture()]);

    expect(outcome!.dedupedCrossFormat).toBe(0);
    expect(rowsOfFile(fileNamed(VENTURE)!.id)).toHaveLength(lines);
    expect(row(copy)!.status).toBe("superseded");
    expect(candidate(candidateId).resolution).toBe("confirmed_duplicate");
    expect(ledger()).toEqual(before);
  });

  test("only a CONFIRMED verdict comes back — an open question is never answered by a re-import", async () => {
    await importStatementFiles(bundle.db, [venture()]);
    const fileId = fileNamed(VENTURE)!.id;
    const payment = rowsOfFile(fileId).find((t) => t.amountCents > 0)!;
    const mirror = hand({ accountId: payment.accountId, postedOn: "2024-10-10", amountCents: 57212, raw: "PAYMENT — Hand checking · CAPITAL ONE CRCARDPMT" });
    const [a, b] = [payment.id, mirror].sort() as [string, string];
    const open = bundle.db
      .insert(duplicateCandidates)
      .values({
        accountId: payment.accountId,
        transactionIdA: a,
        transactionIdB: b,
        pairKey: duplicatePairKey(payment.accountId, sideOf(payment), sideOf(row(mirror)!)),
        reason: "card_payment_mirror",
        reasonDetail: "synthetic",
      })
      .returning({ id: duplicateCandidates.id })
      .get().id;

    unimportFile(bundle.db, fileId);
    await importStatementFiles(bundle.db, [venture()]);

    expect(row(mirror)!.status).toBe("active");
    expect(candidate(open)).toMatchObject({ resolution: "unresolved", retiredTransactionId: null });
  });
});

describe("genuinely distinct charges of the same amount stay distinct", () => {
  const NAME = "Chase7777_Activity_20260301_20260305.CSV";
  const HEADER = "Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo";
  // the bank prints two identical $115.00 payments on one day
  const csv = (): ImportInput => ({
    name: NAME,
    buffer: Buffer.from(
      [
        HEADER,
        "7777,03/02/2026,03/02/2026,Payment Thank You-Mobile,,Payment,115.00,",
        "7777,03/02/2026,03/02/2026,Payment Thank You-Mobile,,Payment,115.00,",
        "7777,03/03/2026,03/03/2026,BLUE BOTTLE COFFEE,Food & Drink,Sale,-4.50,",
        "",
      ].join("\n"),
    ),
  });
  const PAYMENT = { postedOn: "2026-03-02", amountCents: 11500, rawDescription: "Payment Thank You-Mobile" };
  const livePayments = (accountId: string): Row[] =>
    bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .all()
      .filter((t) => t.status !== "superseded" && t.postedOn === PAYMENT.postedOn && t.amountCents === PAYMENT.amountCents);

  test("two identical lines with one retired mirror between them: both lines come back, the mirror is retired once", async () => {
    await importStatementFiles(bundle.db, [csv()]);
    const fileId = fileNamed(NAME)!.id;
    const [first, second] = rowsOfFile(fileId).filter((t) => t.rawDescription === PAYMENT.rawDescription) as [Row, Row];
    expect(second).toBeDefined();
    const mirror = hand({ accountId: first.accountId, postedOn: "2026-03-03", amountCents: 11500, raw: "PAYMENT — Hand checking · 03/02" });
    const candidateId = confirmPair(first.id, mirror, "card_payment_mirror");
    const before = ledger();

    unimportFile(bundle.db, fileId);
    expect(livePayments(first.accountId)).toHaveLength(0);
    expect(row(mirror)!.status).toBe("active");
    await importStatementFiles(bundle.db, [csv()]);

    expect(livePayments(first.accountId)).toHaveLength(2);
    expect(row(mirror)!.status).toBe("superseded");
    expect(candidate(candidateId).resolution).toBe("confirmed_duplicate");
    expect(ledger()).toEqual(before);
  });

  test("one line that comes back retires one copy, never two — the other charge's copy keeps its money", async () => {
    await importStatementFiles(bundle.db, [csv()]);
    const fileId = fileNamed(NAME)!.id;
    const [first, second] = rowsOfFile(fileId).filter((t) => t.rawDescription === PAYMENT.rawDescription) as [Row, Row];
    const card = first.accountId;
    const mirrors = [first, second].map((line) => {
      const mirror = hand({ accountId: card, postedOn: "2026-03-03", amountCents: 11500, raw: "PAYMENT — Hand checking · 03/02" });
      confirmPair(line.id, mirror, "card_payment_mirror");
      return { mirror };
    });
    // typed after the import: a $115.00 credit of its own, which the importer's
    // identity rule will match to one of the two lines when they come back
    hand({ accountId: card, postedOn: PAYMENT.postedOn, amountCents: 11500, raw: "VENMO CASHOUT" });
    const liveCents = () =>
      bundle.db
        .select()
        .from(transactions)
        .where(eq(transactions.accountId, card))
        .all()
        .filter((t) => t.status === "active")
        .reduce((sum, t) => sum + t.amountCents, 0);
    const before = liveCents();

    unimportFile(bundle.db, fileId);
    const [outcome] = await importStatementFiles(bundle.db, [csv()]);

    expect(outcome!.dedupedCrossFormat).toBe(1);
    expect(mirrors.map(({ mirror }) => row(mirror)!.status).sort()).toEqual(["active", "superseded"]);
    expect(liveCents()).toBe(before);
  });

  test("a copy standing in for one charge is not retired for another charge of the same amount and words", async () => {
    const statement = (name: string, day: string): ImportInput => ({
      name,
      buffer: Buffer.from([HEADER, `7777,${day},${day},Payment Thank You-Mobile,,Payment,115.00,`, ""].join("\n")),
    });
    const march1 = statement("Chase7777_Activity_20260301.CSV", "03/01/2026");
    await importStatementFiles(bundle.db, [march1]);
    const fileId = fileNamed(march1.name)!.id;
    const [line] = rowsOfFile(fileId) as [Row];
    // its mirror, two days on: no identity rule matches it to either line
    const mirror = hand({ accountId: line.accountId, postedOn: "2026-03-03", amountCents: 11500, raw: "PAYMENT — Hand checking · 03/01" });
    confirmPair(line.id, mirror, "card_payment_mirror");
    unimportFile(bundle.db, fileId);
    expect(row(mirror)!.status).toBe("active");

    // a different payment: the next day, the same $115.00 and the same words
    await importStatementFiles(bundle.db, [statement("Chase7777_Activity_20260302.CSV", "03/02/2026")]);

    // the copy still records March 1's payment, beside March 2's
    expect(row(mirror)!.status).toBe("active");
    const live = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, line.accountId))
      .all()
      .filter((t) => t.status === "active" && t.amountCents === 11500);
    expect(live.map((t) => t.postedOn).sort()).toEqual(["2026-03-02", "2026-03-03"]);
  });

  test("a hand row nobody paired still absorbs exactly one identical line, and is never retired", async () => {
    const card = (() => {
      const { id } = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
      return createAccount(bundle.db, { institutionId: id, name: "Card 7777", type: "credit", last4: "7777" });
    })();
    // a real $115.00 credit the owner typed in: the same day, the same amount, other words
    const typed = hand({ accountId: card, postedOn: PAYMENT.postedOn, amountCents: 11500, raw: "VENMO CASHOUT" });
    await importStatementFiles(bundle.db, [csv()]);
    const fileId = fileNamed(NAME)!.id;
    const [line] = rowsOfFile(fileId).filter((t) => t.rawDescription === PAYMENT.rawDescription) as [Row];
    expect(livePayments(card)).toHaveLength(2);
    const mirror = hand({ accountId: card, postedOn: "2026-03-03", amountCents: 11500, raw: "PAYMENT — Hand checking · 03/02" });
    confirmPair(line.id, mirror, "card_payment_mirror");
    const before = ledger();

    unimportFile(bundle.db, fileId);
    const [outcome] = await importStatementFiles(bundle.db, [csv()]);

    expect(outcome!.dedupedCrossFormat).toBe(1);
    expect(row(typed)!.status).toBe("active");
    expect(row(mirror)!.status).toBe("superseded");
    expect(livePayments(card)).toHaveLength(2);
    expect(ledger()).toEqual(before);
  });
});
