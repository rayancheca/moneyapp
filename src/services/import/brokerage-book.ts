import { and, asc, count, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings } from "@/db/schema/holdings";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { transferAmbiguities } from "@/db/schema/transfer-ambiguities";
import { dayWindowLabel } from "@/lib/period";
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

/** A book's events walk a position below zero: a later statement sells shares that are no longer there. */
export class NegativePositionError extends Error {}

/**
 * A book's `holdings` rows, restated from its events: the quantity their sum, the average cost walked by the one rule
 * the Robinhood rebuild uses (`nextCostBasis`), inactive at zero, and no row for a symbol with no event left.
 *
 * ⛔ Never below zero, on any day. No statement prints a short position, so a walk that goes negative is a later
 * statement's sale standing without the shares an earlier statement bought — what taking a month off from under a
 * later one leaves. It throws, and the transaction that asked rolls back. The callers refuse first
 * (`laterBookStatements`); this is the rule that holds if they did not.
 */
export function syncBookHoldings(tx: AppDatabase, accountId: string): void {
  const walked = new Map<string, { assetType: (typeof holdingEvents.$inferSelect)["assetType"]; quantityE8: bigint; costCents: number }>();
  for (const e of eventsOf(tx, accountId)) {
    const current = walked.get(e.symbol) ?? { assetType: e.assetType, quantityE8: 0n, costCents: 0 };
    const delta = BigInt(e.quantityDeltaE8);
    const quantityE8 = current.quantityE8 + delta;
    if (quantityE8 < 0n) {
      throw new NegativePositionError(
        `the book's ${e.symbol} would stand at ${quantityE8}e-8 on ${e.occurredOn} — a sale of shares it does not hold; its later statements come off first`,
      );
    }
    const step = nextCostBasis(current.quantityE8, current.costCents, delta, delta > 0n ? e.costCents : null);
    walked.set(e.symbol, { assetType: e.assetType, quantityE8, costCents: step.costCents });
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

/** Another file's statement on a book, reaching past a given file's — one that may stand on that file's shares. */
export interface LaterBookStatement {
  readonly importFileId: string;
  readonly fileName: string;
  readonly parserVersion: number;
  readonly bookName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/**
 * The statements on the books an import file wrote to that come AFTER it — a period on the book ending past the
 * file's reach there — newest first.
 *
 * ⛔ A book's months come off newest first. Each month's positions were proven by the shares the book held before it
 * (`provePositions`), so a later month stands on an earlier month's buy: take the buy away and a later sale is left
 * alone, a short position no statement printed, valued into net worth (measured on the branch: WMT −0.1, −$11.09 a day
 * after un-importing August under September), and a later month that only holds prints shares the book no longer
 * has. An un-import or a re-read of a month with a later statement refuses and names these.
 *
 * ⚠️ Periods find both ends. Every book statement the import writes has a period row on its book — an account's first
 * statement, whose opening prints N/A, one with no balances (its declared range) — except a second copy of a month,
 * which adopts the first copy's row; and a second copy whose trades the book already holds is withheld
 * (`provePositions`). Only two copies of one month that disagree about its trades could leave shares under a file
 * with no period of its own, and `syncBookHoldings` still refuses the short position that removing them would leave.
 */
export function laterBookStatements(db: AppDatabase, importFileId: string): LaterBookStatement[] {
  const reach = db
    .select({ bookId: statementPeriods.accountId, day: statementPeriods.periodEnd })
    .from(statementPeriods)
    .innerJoin(accounts, eq(accounts.id, statementPeriods.accountId))
    .where(and(eq(statementPeriods.importFileId, importFileId), isNotNull(accounts.cashAccountId)))
    .all();

  const later = reach.flatMap(({ bookId, day }) =>
    db
      .select({
        importFileId: importFiles.id,
        fileName: importFiles.fileName,
        parserVersion: importFiles.parserVersion,
        bookName: accounts.name,
        periodStart: statementPeriods.periodStart,
        periodEnd: statementPeriods.periodEnd,
      })
      .from(statementPeriods)
      .innerJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
      .innerJoin(accounts, eq(accounts.id, statementPeriods.accountId))
      .where(and(eq(statementPeriods.accountId, bookId), gt(statementPeriods.periodEnd, day), ne(statementPeriods.importFileId, importFileId)))
      .all(),
  );
  // one period per file and account (`ux_statement_periods_file_account`); a file on two books is named once
  const unique = [...new Map(later.map((l) => [l.importFileId, l])).values()];
  return unique.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.fileName.localeCompare(b.fileName));
}

/**
 * Why a book's month cannot come off yet, naming the later statements newest first — an un-import says to take them
 * off first; a re-read at `rereadAt` says to upload them with it when every one of them is read by an older version,
 * so the same upload reads them all again, and to un-import them first otherwise.
 */
export function laterStatementsRefusal(later: readonly LaterBookStatement[], rereadAt?: number): string {
  const books = [...new Set(later.map((l) => l.bookName))].join(" and ");
  const statements = later.length === 1 ? "a later statement" : "later statements";
  const named = later.map((l) => `${l.fileName} (${dayWindowLabel(l.periodStart, l.periodEnd)})`);
  const holds = `${books} still holds this statement's shares under ${statements}`;
  if (rereadAt === undefined) return `${holds} — un-import ${named.join(", then ")} before it`;
  const why = `${holds}, and reading it again would take them away first`;
  if (later.every((l) => l.parserVersion < rereadAt)) return `${why} — upload ${named.join(" and ")} with it to read them together`;
  return `${why} — un-import ${named.join(", then ")} before reading it again`;
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
