import { and, asc, count, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings } from "@/db/schema/holdings";
import { statementPeriods } from "@/db/schema/imports";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { transferAmbiguities } from "@/db/schema/transfer-ambiguities";
import { averageCostCents, nextCostBasis } from "@/lib/robinhood-holdings";
import type { BookEvent, EquityAssetType, StatementPositions } from "./types";

/**
 * A cash account's BROKERAGE BOOK — the investment account that holds the positions its statement section proves.
 *
 * ⚖️ Owner, 2026-09-15: when Claude's agent buys a stock, show TWO accounts. "Robinhood Agentic" (checking ····9651)
 * keeps the unspent cash; a brokerage account holds the positions, as Robinhood Cash + Robinhood Brokerage split
 * #487513525. The pair is a stored link — `accounts.cash_account_id` on the book — and never a name.
 *
 * ⛔ THE IMPORT CREATES THE BOOK, the first time a tracked cash account's section PROVES positions (`resolveBook`), and
 * no script does it beforehand. Measured, the ordering trap a creation step would carry: a statement imported before
 * the step has its section withheld and is recorded `parsed`, and the same bytes at the same parser version are then
 * skipped as a duplicate (`ux_import_files_sha_parser`) — the month would stay unread until a version bump, and the
 * owner, who does nothing by hand, would have to know to run the step before every upload. It cannot duplicate: the
 * book is found by its link to an account the ledger already tracks BY NUMBER, the unique index on `cash_account_id`
 * admits one book per cash account, and a section withheld for any reason creates nothing.
 */

/** The book paired with the cash account ····`cashLast4` at this institution — created on first use. */
export function resolveBook(db: AppDatabase, institutionId: string, cashLast4: string): string {
  const cash = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.institutionId, institutionId), eq(accounts.last4, cashLast4)))
    .all();
  const [account] = cash;
  if (cash.length !== 1 || account === undefined || account.type !== "checking") {
    throw new Error(`a brokerage book needs exactly one checking account ····${cashLast4} to pair with — found ${cash.length}`);
  }
  const existing = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.cashAccountId, account.id)).get();
  if (existing) return existing.id;
  return db
    .insert(accounts)
    .values({
      institutionId,
      // "Robinhood Agentic" → "Robinhood Agentic Brokerage", as Robinhood Cash's sibling is Robinhood Brokerage
      name: `${account.name} Brokerage`,
      type: "investment",
      subtype: "brokerage",
      last4: null,
      cashAccountId: account.id,
    })
    .returning({ id: accounts.id })
    .get().id;
}

/**
 * Store a statement's trades in its book: one `trade` event per printed Buy or Sell, filed under the statement so it
 * leaves with it, then the book's holdings restated from its events.
 *
 * ⛔ And checked again, against the database it is written into: the book's positions through `asOf` must be the
 * printed ones. The parser proved them against the events the import offered it a moment before; this is the same
 * identity asked of the rows actually committed, inside the same transaction, so a divergence rolls back.
 */
export function writeStatementPositions(
  tx: AppDatabase,
  accountId: string,
  importFileId: string,
  positions: StatementPositions,
  asOf: string,
): void {
  const account = tx.select({ type: accounts.type, cashAccountId: accounts.cashAccountId }).from(accounts).where(eq(accounts.id, accountId)).get();
  if (account?.type !== "investment" || account.cashAccountId === null) {
    throw new Error(`positions go to a brokerage book paired with a cash account, and ${accountId} is not one`);
  }
  for (const t of positions.trades) {
    tx.insert(holdingEvents)
      .values({
        accountId,
        symbol: t.symbol,
        assetType: t.assetType,
        occurredOn: t.occurredOn,
        quantityDeltaE8: t.quantityDeltaE8,
        costCents: t.costCents,
        eventKind: "trade",
        note: `statement: ${t.printed}`,
        importFileId,
      })
      .run();
  }
  syncBookHoldings(tx, accountId);

  const through = new Map<string, number>();
  for (const e of eventsOf(tx, accountId)) {
    if (e.occurredOn <= asOf) through.set(e.symbol, (through.get(e.symbol) ?? 0) + e.quantityDeltaE8);
  }
  const printed = new Map(positions.held.map((h) => [h.symbol, h.quantityE8]));
  const miss = [...new Set([...through.keys(), ...printed.keys()])].find((s) => (through.get(s) ?? 0) !== (printed.get(s) ?? 0));
  if (miss !== undefined) {
    throw new Error(`the book's ${miss} through ${asOf} is ${through.get(miss) ?? 0}e-8 after writing, the statement prints ${printed.get(miss) ?? 0}e-8`);
  }
}

function eventsOf(db: AppDatabase, accountId: string) {
  return db
    .select()
    .from(holdingEvents)
    .where(eq(holdingEvents.accountId, accountId))
    .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.createdAt), asc(holdingEvents.id))
    .all();
}

/**
 * A book's `holdings` rows, restated from its events: the quantity their sum, the average cost walked by the one rule
 * the Robinhood rebuild uses (`nextCostBasis`), inactive at zero, and no row for a symbol with no event left.
 */
export function syncBookHoldings(tx: AppDatabase, accountId: string): void {
  const walked = new Map<string, { assetType: (typeof holdingEvents.$inferSelect)["assetType"]; quantityE8: bigint; costCents: number }>();
  for (const e of eventsOf(tx, accountId)) {
    const current = walked.get(e.symbol) ?? { assetType: e.assetType, quantityE8: 0n, costCents: 0 };
    const delta = BigInt(e.quantityDeltaE8);
    const step = nextCostBasis(current.quantityE8, current.costCents, delta, delta > 0n ? e.costCents : null);
    walked.set(e.symbol, { assetType: e.assetType, quantityE8: current.quantityE8 + delta, costCents: step.costCents });
  }
  const existing = tx.select().from(holdings).where(eq(holdings.accountId, accountId)).all();
  for (const row of existing) {
    if (!walked.has(row.symbol)) tx.delete(holdings).where(eq(holdings.id, row.id)).run();
  }
  for (const [symbol, w] of walked) {
    const values = {
      assetType: w.assetType,
      quantityE8: Number(w.quantityE8),
      avgCostCents: averageCostCents(w.costCents, w.quantityE8),
      isActive: w.quantityE8 > 0n,
    };
    const row = existing.find((h) => h.symbol === symbol);
    if (row) tx.update(holdings).set(values).where(eq(holdings.id, row.id)).run();
    else tx.insert(holdings).values({ accountId, symbol, ...values }).run();
  }
}

/** Delete the events an import file wrote and restate each book they came from; the books' ids. */
export function removeFileEvents(tx: AppDatabase, importFileId: string): string[] {
  const books = tx
    .selectDistinct({ accountId: holdingEvents.accountId })
    .from(holdingEvents)
    .where(eq(holdingEvents.importFileId, importFileId))
    .all()
    .map((r) => r.accountId);
  tx.delete(holdingEvents).where(eq(holdingEvents.importFileId, importFileId)).run();
  for (const accountId of books) syncBookHoldings(tx, accountId);
  return books;
}

/**
 * Delete the books among `accountIds` that hold nothing at all any more — no event, statement period, balance, row,
 * duplicate question, transfer question or series — with their derived cache, holding rows and live values; their ids.
 *
 * An un-import restores the ledger it found: a book exists only to hold what a statement proved, and the import that
 * created it is the one being removed. So does a re-read that no longer proves the month, and a statement that failed
 * after its book was made: a first read that withheld the section would never have made one. ⛔ Never a book that
 * still holds anything, and never an account that is not a book (no `cash_account_id`).
 *
 * 🔴 A `live` anchor is not something the book holds. `refreshPrices` writes one on every investment account holding
 * a position — the book included, the moment its first statement lands — and it prices what the book held, which
 * the statements proved. Counted as a balance, it kept a book whose every statement had been un-imported, carrying
 * its last live value into net worth (measured: $27.37 after un-importing the only month, 2026-09-16).
 */
export function removeEmptyBooks(db: AppDatabase, accountIds: readonly string[]): string[] {
  if (accountIds.length === 0) return [];
  const books = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(inArray(accounts.id, [...accountIds]), isNotNull(accounts.cashAccountId)))
    .all()
    .map((r) => r.id);
  const holdsAnything = (id: string): boolean =>
    [
      db.select({ n: count() }).from(holdingEvents).where(eq(holdingEvents.accountId, id)).get(),
      db.select({ n: count() }).from(statementPeriods).where(eq(statementPeriods.accountId, id)).get(),
      db.select({ n: count() }).from(balanceAnchors).where(and(eq(balanceAnchors.accountId, id), ne(balanceAnchors.source, "live"))).get(),
      db.select({ n: count() }).from(transactions).where(eq(transactions.accountId, id)).get(),
      db.select({ n: count() }).from(duplicateCandidates).where(eq(duplicateCandidates.accountId, id)).get(),
      db.select({ n: count() }).from(transferAmbiguities).where(eq(transferAmbiguities.accountId, id)).get(),
      db.select({ n: count() }).from(recurringSeries).where(eq(recurringSeries.accountId, id)).get(),
    ].some((r) => (r?.n ?? 0) > 0);
  const empty = books.filter((id) => !holdsAnything(id));
  if (empty.length === 0) return [];
  db.transaction((tx) => {
    tx.delete(holdings).where(inArray(holdings.accountId, empty)).run();
    tx.delete(dailyBalances).where(inArray(dailyBalances.accountId, empty)).run();
    tx.delete(balanceAnchors).where(and(inArray(balanceAnchors.accountId, empty), eq(balanceAnchors.source, "live"))).run();
    tx.delete(accounts).where(inArray(accounts.id, empty)).run();
  });
  return empty;
}

/** Every book's events, keyed by the cash account it is paired with — what the parser proves a section's positions by. */
export function bookEventsByCashAccount(db: AppDatabase): Map<string, BookEvent[]> {
  const rows = db
    .select({
      cashAccountId: accounts.cashAccountId,
      symbol: holdingEvents.symbol,
      occurredOn: holdingEvents.occurredOn,
      quantityDeltaE8: holdingEvents.quantityDeltaE8,
    })
    .from(accounts)
    .leftJoin(holdingEvents, eq(holdingEvents.accountId, accounts.id))
    .where(isNotNull(accounts.cashAccountId))
    .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.createdAt), asc(holdingEvents.id))
    .all();
  const byCash = new Map<string, BookEvent[]>();
  for (const r of rows) {
    const list = byCash.get(r.cashAccountId as string) ?? [];
    if (r.symbol !== null && r.occurredOn !== null && r.quantityDeltaE8 !== null) {
      list.push({ symbol: r.symbol, occurredOn: r.occurredOn, quantityDeltaE8: r.quantityDeltaE8 });
    }
    byCash.set(r.cashAccountId as string, list);
  }
  return byCash;
}

/**
 * The asset type each stock or fund symbol already has in this ledger — from every holding and holding event, crypto
 * aside. A symbol recorded as BOTH a stock and an ETF is left out: that is a question, not an answer.
 */
export function equityAssetTypesOf(db: AppDatabase): Record<string, EquityAssetType> {
  const seen = [
    ...db.selectDistinct({ symbol: holdingEvents.symbol, assetType: holdingEvents.assetType }).from(holdingEvents).all(),
    ...db.selectDistinct({ symbol: holdings.symbol, assetType: holdings.assetType }).from(holdings).all(),
  ];
  const types = new Map<string, Set<EquityAssetType>>();
  for (const { symbol, assetType } of seen) {
    if (assetType === "crypto") continue;
    types.set(symbol, (types.get(symbol) ?? new Set()).add(assetType));
  }
  return Object.fromEntries([...types].flatMap(([symbol, set]) => (set.size === 1 ? [[symbol, [...set][0] as EquityAssetType]] : [])));
}
