import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache } from "@/db/schema/holdings";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { withheldSectionsOf } from "@/lib/import-file-label";
import { statementDayValuation } from "@/lib/ledger-integrity";
import { accountLiquidity, createAccount, updateAccount } from "@/services/accounts";
import { upsertHolding } from "@/services/holdings";
import { portfolioSeries } from "@/services/portfolio";
import { addManualAnchor } from "@/services/anchors";
import { refreshPrices, type PriceProvider } from "@/services/prices";
import { removeFileEvents, resolveBook, syncBookHoldings, writeStatementPositions } from "./brokerage-book";
import { PROFILES } from "./profiles";
import type { Line } from "./profiles/pdf-profile";
import { importStatementFiles, parseContextFor, resolveAccount, unimportFile, type ImportInput } from "./service";

/**
 * ⚖️ Owner, 2026-09-15: when Claude's agent buys a stock, show TWO accounts — "Robinhood Agentic" keeps the unspent
 * cash, and a brokerage account holds the positions, like Robinhood Cash + Robinhood Brokerage; every statement still
 * proves the cash to the cent.
 *
 * Through `importStatementFiles` on a real temp database; only text extraction is faked, keyed by the fake file's
 * bytes, exactly as robinhood-parse-context.test.ts does. #655929651's lines are its REAL 2026-06 and 2026-08
 * extractions with only what the constructed trades change — no statement for this account has printed a position.
 */

const { DOCUMENTS, WRITE_FAULT } = vi.hoisted(() => ({
  DOCUMENTS: new Map<string, Line[]>(),
  WRITE_FAULT: { message: null as string | null, through: null as string | null },
}));

// a fault in the positions write — every one, or only the one proving a book through `through` — for the tests that
// need a book statement's transaction to roll back
vi.mock("./brokerage-book", async (importOriginal) => {
  const original = await importOriginal<typeof import("./brokerage-book")>();
  return {
    ...original,
    writeStatementPositions: (...args: Parameters<typeof original.writeStatementPositions>) => {
      if (WRITE_FAULT.message !== null && (WRITE_FAULT.through === null || args[4] === WRITE_FAULT.through)) {
        throw new Error(WRITE_FAULT.message);
      }
      original.writeStatementPositions(...args);
    },
  };
});

vi.mock("./profiles/pdf-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./profiles/pdf-profile")>()),
  extractLines: async (buffer: Buffer): Promise<Line[]> => {
    const lines = DOCUMENTS.get(buffer.toString("latin1"));
    if (!lines) throw new Error("no mocked document for these bytes");
    return lines;
  },
}));

const line = (text: string, tokens: [string, number][] = []): Line => ({ y: 0, text, tokens: tokens.map(([str, x]) => ({ str, x })) });

function pdf(name: string, lines: Line[]): ImportInput {
  const buffer = Buffer.from(`%PDF-1.7\n% ${name}\n`, "latin1");
  DOCUMENTS.set(buffer.toString("latin1"), lines);
  return { name, buffer };
}

const header = (debitX: number, creditX: number): Line =>
  line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [
    ["Debit", debitX],
    ["Credit", creditX],
  ]);
const totalFunds = (debit: string, credit: string, debitX = 685.13, creditX = 743.4): Line =>
  line(`Total Funds Paid and Received ${debit} ${credit}`, [
    ["Total Funds Paid and Received", 36],
    [debit, debitX],
    [credit, creditX],
  ]);

/** #487513525, 2026-06 (747059b1…, lines 2–18 and 116–121). */
const JUNE_BROKERAGE = [
  line("06/01/2026 to 06/30/2026"),
  line("Individual Account #:487513525"),
  line("Account Summary"),
  line("Brokerage Cash Balance * $0.38 $192.22"),
  line("Deposit Sweep Balance $0.34 $0.07"),
  line("Total Securities ** $62,556.95 $59,329.88"),
  line("Portfolio Value $62,557.67 $59,522.17"),
];

/** #655929651, 2026-06 (747059b1…, lines 377–417) — its first statement: the opening prints N/A. */
const JUNE_SECOND = [
  line("06/01/2026 to 06/30/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance N/A $26.64"),
  line("Total Securities N/A $0.00"),
  line("Portfolio Value N/A $26.64"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $26.64 100.00%"),
  line("Account Activity"),
  header(695.33, 746.51),
  line("Transfer from Brokerage to Brokerage Cash ITRF 06/05/2026 $26.64", [
    ["Transfer from Brokerage to Brokerage", 36],
    ["Cash", 347.25],
    ["ITRF", 426.3],
    ["06/05/2026", 516.67],
    ["$26.64", 746.51],
  ]),
  totalFunds("$0.00", "$26.64", 695.33, 746.51),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/** #487513525, 2026-08 (48afc52f…, lines 160–176, 245–247, 272, 302, 304) — its two credits no other source carries. */
const AUGUST_BROKERAGE = [
  line("08/01/2026 to 08/31/2026"),
  line("Individual Account #:487513525"),
  line("Account Summary"),
  line("Brokerage Cash Balance * $1,679.93 $0.68"),
  line("Deposit Sweep Balance $0.45 $1,000.33"),
  line("Total Securities ** $67,859.26 $72,959.32"),
  line("Portfolio Value $69,539.64 $73,960.33"),
  line("Account Activity", [["Account Activity", 36]]),
  header(697.42, 751.73),
  line("Crypto Money Movement Margin COIN 08/24/2026 $1,499.99", [
    ["Crypto Money Movement", 36],
    ["Margin", 400.35],
    ["COIN", 455.06],
    ["08/24/2026", 517.58],
    ["$1,499.99", 751.73],
  ]),
  line("Crypto Money Movement Margin COIN 08/31/2026 $1,000.11", [
    ["Crypto Money Movement", 36],
    ["Margin", 400.35],
    ["COIN", 455.06],
    ["08/31/2026", 517.58],
    ["$1,000.11", 751.73],
  ]),
  totalFunds("$5,732.94", "$5,053.57", 697.42, 751.73),
];

/** #655929651, 2026-08 (48afc52f…, lines 2–45) — the real, quiet month: $26.64 → $26.64. */
const AUGUST_QUIET = [
  line("08/01/2026 to 08/31/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $26.64 $26.64"),
  line("Total Securities $0.00 $0.00"),
  line("Portfolio Value $26.64 $26.64"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $26.64 100.00%"),
  line("Account Activity"),
  header(685.13, 743.4),
  totalFunds("$0.00", "$0.00"),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/** CONSTRUCTED on the real August: the agent buys 0.25 WMT for $25.00 on 08/20 (the design's rehearsal month). */
const AGENT_BUYS = [
  line("08/01/2026 to 08/31/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $26.64 $1.64"),
  line("Total Securities $0.00 $26.22"),
  line("Portfolio Value $26.64 $27.86"),
  line("Portfolio Summary"),
  line("Walmart"),
  line("WMT Cash 0.25 $104.87000 $26.22 $0.24 94.11%"),
  line("Estimated Yield: 0.94%"),
  line("Total Securities $26.22 $0.24 94.11%"),
  line("Brokerage Cash Balance $1.64 5.89%"),
  line("Account Activity"),
  header(685.13, 743.4),
  line("Walmart"),
  line("WMT Cash Buy 08/20/2026 0.25 $100.00000 $25.00", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Buy", 431.63],
    ["08/20/2026", 534.56],
    ["0.25", 586.28],
    ["$100.00000", 630.19],
    ["$25.00", 685.13],
  ]),
  line("CUSIP: 931142103"),
  totalFunds("$25.00", "$0.00"),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/** CONSTRUCTED: #487513525 opening September where its real August closed, nothing moving. */
const SEPTEMBER_BROKERAGE = [
  "09/01/2026 to 09/30/2026",
  "Individual Account #:487513525",
  "Account Summary",
  "Brokerage Cash Balance * $0.68 $0.68",
  "Deposit Sweep Balance $1,000.33 $1,000.33",
  "Total Securities ** $72,959.32 $72,959.32",
  "Portfolio Value $73,960.33 $73,960.33",
].map((t) => line(t));

const pendingTable = (rows: Line[], total: string): Line[] => [
  line("Executed Trades Pending Settlement"),
  line("These transactions may not be reflected in the other summaries"),
  line("Description Acct Type Transaction Trade Date Settle Date Qty Price Debit Credit", [
    ["Debit", 691.65],
    ["Credit", 745.05],
  ]),
  ...rows,
  line(`Total Executed Trades Pending Settlement ${total} $0.00`, [
    ["Total Executed Trades Pending Settlement", 36],
    [total, 691.65],
    ["$0.00", 745.05],
  ]),
];

/**
 * CONSTRUCTED: September sells 0.1 WMT at $110.00 on 09/15 and collects a $0.06 dividend on 09/08 — cash $1.64 → $12.70,
 * 0.15 WMT at $110.90 = $16.64 — and, with `pending`, buys 0.05 more on Wed 09/30, settling 10/01.
 */
const agentSells = (pending: boolean): Line[] => [
  line("09/01/2026 to 09/30/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $1.64 $12.70"),
  line("Total Securities $26.22 $16.64"),
  line("Portfolio Value $27.86 $29.34"),
  line("Portfolio Summary"),
  line("Walmart"),
  line("WMT Cash 0.15 $110.90000 $16.64 $0.14 56.71%"),
  line("Total Securities $16.64 $0.14 56.71%"),
  line("Brokerage Cash Balance $12.70 43.29%"),
  line("Account Activity"),
  header(685.13, 743.4),
  line("Cash Div: R/D 2026-08-21 P/D 2026-09-08 - 0.25 shares at 0.2475 WMT Cash CDIV 09/08/2026 $0.06", [
    ["Cash Div: R/D 2026-08-21 P/D 2026-09-08 - 0.25 shares at 0.2475", 36],
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["CDIV", 431.63],
    ["09/08/2026", 534.56],
    ["$0.06", 743.4],
  ]),
  line("Walmart"),
  line("WMT Cash Sell 09/15/2026 0.1 $110.00000 $11.00", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Sell", 431.63],
    ["09/15/2026", 534.56],
    ["0.1", 586.28],
    ["$110.00000", 630.19],
    ["$11.00", 743.4],
  ]),
  line("CUSIP: 931142103"),
  totalFunds("$0.00", "$11.06"),
  ...(pending
    ? pendingTable(
        [
          line("Walmart"),
          line("Cash Buy 09/30/2026 10/01/2026 0.05 $111.00000 $5.55", [
            ["Cash", 190.65],
            ["Buy", 329.1],
            ["09/30/2026", 423.38],
            ["10/01/2026", 511.28],
            ["0.05", 601.09],
            ["$111.00000", 641.33],
            ["$5.55", 691.65],
          ]),
          line("CUSIP: 931142103"),
        ],
        "$5.55",
      )
    : [line("Executed Trades Pending Settlement"), line("Total Executed Trades Pending Settlement $0.00 $0.00")]),
];

const JUNE_FILE = "747059b1-3904-3242-af2e-de66f2c94f5e.pdf";
const AUGUST_FILE = "48afc52f-8955-351d-bdad-7248305c5a2b.pdf";
const AGENT_BUYS_FILE = "d41f0c83-5a7e-4b2c-9e61-3f8a2b7c9d10.pdf";
const SEPTEMBER_FILE = "b7d4e2f1-3c8a-4d59-9e06-2a1f7c5b8e34.pdf";

let dir: string;
let bundle: DbBundle;
let fakeToday: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-agentic-book-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  fakeToday = process.env.MONEYAPP_FAKE_TODAY;
  process.env.MONEYAPP_FAKE_TODAY = "2026-10-05";
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
  if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
  else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
});

/**
 * The owner's Robinhood today — the brokerage ····3525 holding WMT (as it does: 0.413621 on Aug 31), the cash ledger
 * with no number, and Robinhood Agentic created the way the guarded script created it. WMT's closes are cached.
 */
function ownersRobinhood(db: AppDatabase, withWmt = true): string {
  const brokerage = resolveAccount(db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage", last4: "3525" });
  resolveAccount(db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });
  const robinhood = db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  const agentic = createAccount(db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
  for (const [day, close] of [
    ["2026-07-01", 111.2],
    ["2026-08-19", 103.84],
    ["2026-08-20", 103.84],
    ["2026-08-31", 104.87],
    ["2026-09-15", 110],
    ["2026-09-30", 110.9],
  ] as const) {
    db.insert(priceCache).values({ symbol: "WMT", assetType: "stock", quotedOn: day, close, source: "yahoo", fetchedAt: `${day}T21:00:00.000Z` }).run();
  }
  if (withWmt) knowWmt(db, brokerage);
  return agentic;
}

function knowWmt(db: AppDatabase, brokerage?: string): void {
  const id = brokerage ?? db.select().from(accounts).where(eq(accounts.name, "Robinhood Brokerage")).get()!.id;
  upsertHolding(db, { accountId: id, symbol: "WMT", assetType: "stock", quantityE8: 41_266_400, avgCostCents: 10_600, occurredOn: "2026-07-01" });
}

const bookOf = (db: AppDatabase, cashAccountId: string) => db.select().from(accounts).where(eq(accounts.cashAccountId, cashAccountId)).get();

/** One account's statement evidence and curve, without row ids or timestamps — what "exactly as" is measured on. */
function stateOf(db: AppDatabase, accountId: string) {
  return {
    periods: db
      .select({ start: statementPeriods.periodStart, end: statementPeriods.periodEnd, begin: statementPeriods.beginningBalanceCents, endCents: statementPeriods.endingBalanceCents, reconciliation: statementPeriods.reconciliation })
      .from(statementPeriods)
      .where(eq(statementPeriods.accountId, accountId))
      .orderBy(asc(statementPeriods.periodStart))
      .all(),
    anchors: db
      .select({ on: balanceAnchors.anchoredOn, cents: balanceAnchors.balanceCents, source: balanceAnchors.source })
      .from(balanceAnchors)
      .where(eq(balanceAnchors.accountId, accountId))
      .orderBy(asc(balanceAnchors.anchoredOn), asc(balanceAnchors.source))
      .all(),
    rows: db
      .select({ on: transactions.postedOn, cents: transactions.amountCents, description: transactions.rawDescription, status: transactions.status, category: categories.name })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(and(eq(transactions.accountId, accountId), ne(transactions.status, "superseded")))
      .orderBy(asc(transactions.postedOn), asc(transactions.amountCents))
      .all(),
    days: db
      .select({ day: dailyBalances.day, cents: dailyBalances.balanceCents, basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, accountId))
      .orderBy(asc(dailyBalances.day))
      .all(),
    events: db
      .select({ symbol: holdingEvents.symbol, assetType: holdingEvents.assetType, on: holdingEvents.occurredOn, delta: holdingEvents.quantityDeltaE8, cost: holdingEvents.costCents, kind: holdingEvents.eventKind })
      .from(holdingEvents)
      .where(eq(holdingEvents.accountId, accountId))
      .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.quantityDeltaE8))
      .all(),
    holdings: db
      .select({ symbol: holdings.symbol, assetType: holdings.assetType, quantityE8: holdings.quantityE8, avgCostCents: holdings.avgCostCents, isActive: holdings.isActive })
      .from(holdings)
      .where(eq(holdings.accountId, accountId))
      .orderBy(asc(holdings.symbol))
      .all(),
  };
}

/** Every table an import or an un-import writes, row by row, ids and timestamps aside. */
function wholeLedger(db: AppDatabase) {
  const strip = (rows: Record<string, unknown>[]) =>
    rows.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    accounts: strip(db.select().from(accounts).all()),
    importFiles: strip(db.select().from(importFiles).all().map(({ importedAt: _i, storagePath: _s, ...r }) => r)),
    periods: strip(db.select().from(statementPeriods).all()),
    anchors: strip(db.select().from(balanceAnchors).all()),
    transactions: strip(db.select().from(transactions).all()),
    days: strip(db.select().from(dailyBalances).all()),
    events: strip(db.select().from(holdingEvents).all()),
    holdings: strip(db.select().from(holdings).all()),
  };
}

describe("⚖️ Robinhood Agentic's positions are read into a brokerage book paired with it", () => {
  test("⛔ the rehearsal's month: Agentic's August closes $26.64 → $1.64, the import creates its book by the link, and the book holds exactly the printed 0.25 WMT at $26.22", async () => {
    // the same ledger given the real, quiet August — what Robinhood Cash and Brokerage must be identical to
    const normal = createDatabase(path.join(dir, "normal.db"));
    try {
      seedDatabase(normal.db);
      ownersRobinhood(normal.db);
      await importStatementFiles(normal.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
      await importStatementFiles(normal.db, [pdf(AUGUST_FILE, [...AUGUST_QUIET, ...AUGUST_BROKERAGE])]);

      const agenticId = ownersRobinhood(bundle.db);
      await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
      const hisPortfolio = portfolioSeries(bundle.db);
      expect(bookOf(bundle.db, agenticId)).toBeUndefined(); // nothing is created before a section proves positions

      const [outcome] = await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);

      expect([outcome!.status, outcome!.error, outcome!.withheld]).toEqual(["parsed", undefined, []]);
      const book = bookOf(bundle.db, agenticId)!;
      expect(book).toMatchObject({ name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage", last4: null, isActive: true });

      // Robinhood Agentic keeps the cash, proven to the cent
      const agentic = stateOf(bundle.db, agenticId);
      expect(agentic.periods).toEqual([
        { start: "2026-06-01", end: "2026-06-30", begin: null, endCents: null, reconciliation: "not_applicable" },
        { start: "2026-08-01", end: "2026-08-31", begin: 2664, endCents: 164, reconciliation: "reconciled" },
      ]);
      expect(agentic.rows.map(({ category: _category, ...row }) => row)).toEqual([
        { on: "2026-06-05", cents: 2664, description: "Transfer from Brokerage to Brokerage", status: "active" },
        { on: "2026-08-20", cents: -2500, description: "Walmart", status: "active" },
      ]);
      // filed as the activity CSV files a Buy — an investment, never spending
      expect(agentic.rows[1]!.category).toBe("Buys");
      expect(agentic.days.find((d) => d.day === "2026-08-31")).toEqual({ day: "2026-08-31", cents: 164, basis: "anchored" });
      expect(agentic.events).toEqual([]);

      // the book holds the positions — from the statement's lines, valued the way every position is
      const held = stateOf(bundle.db, book.id);
      expect(held.periods).toEqual([{ start: "2026-08-01", end: "2026-08-31", begin: 0, endCents: 2622, reconciliation: "value_anchor" }]);
      expect(held.rows).toEqual([]);
      expect(held.events).toEqual([{ symbol: "WMT", assetType: "stock", on: "2026-08-20", delta: 25_000_000, cost: 2500, kind: "trade" }]);
      expect(held.holdings).toEqual([{ symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, avgCostCents: 10_000, isActive: true }]);
      const file = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, AGENT_BUYS_FILE)).get()!;
      expect(bundle.db.select({ fileId: holdingEvents.importFileId }).from(holdingEvents).where(eq(holdingEvents.accountId, book.id)).all()).toEqual([{ fileId: file.id }]);
      // 0.25 × $103.84 on the 20th, 0.25 × $104.87 = $26.2175 on the 31st — the printed $26.22, to the cent
      expect(held.days.filter((d) => ["2026-08-19", "2026-08-20", "2026-08-31"].includes(d.day)).map((d) => [d.day, d.cents])).toEqual([
        ["2026-08-20", 2596],
        ["2026-08-31", 2622],
      ]);
      // `pnpm ledger-check`'s witness: the app's own valuation of the book on the statement's day
      expect(statementDayValuation(portfolioSeries(bundle.db, [book.id]))("2026-08-31")).toBe(2622);

      // Robinhood Cash and Brokerage: exactly what the quiet August gave — each Crypto Money Movement once
      for (const name of ["Robinhood Cash", "Robinhood Brokerage"]) {
        const id = (db: AppDatabase) => db.select().from(accounts).where(eq(accounts.name, name)).get()!.id;
        expect(stateOf(bundle.db, id(bundle.db))).toEqual(stateOf(normal.db, id(normal.db)));
      }

      // his portfolio does not move; neither Agentic account is cash he can spend
      expect(portfolioSeries(bundle.db)).toEqual(hisPortfolio);
      const liquidity = accountLiquidity(bundle.db);
      expect([liquidity.get(agenticId), liquidity.get(book.id)]).toEqual(["investable", "investable"]);
    } finally {
      normal.sqlite.close();
    }
  });

  test("the context offers the book's events and the ledger's asset types — the two facts the section is proven with", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const book = bookOf(bundle.db, agenticId)!;

    const context = parseContextFor(bundle.db);
    expect(context.equityAssetTypes).toEqual({ WMT: "stock" });
    expect(context.knownAccounts.Robinhood?.find((a) => a.last4 === "9651")).toEqual({
      last4: "9651",
      type: "checking",
      subtype: null,
      book: { events: [{ symbol: "WMT", occurredOn: "2026-08-20", quantityDeltaE8: 25_000_000 }] },
    });
    // the brokerage has no book; the book itself has no number, so it is not offered as an account to match
    expect(context.knownAccounts.Robinhood?.find((a) => a.last4 === "3525")).toEqual({ last4: "3525", type: "investment", subtype: "brokerage" });
    expect(book.last4).toBeNull();
  });

  test("a symbol the ledger records as both a stock and an ETF has no asset type to offer — that is a question, not an answer", () => {
    ownersRobinhood(bundle.db);
    const brokerage = bundle.db.select().from(accounts).where(eq(accounts.name, "Robinhood Brokerage")).get()!;
    const crypto = resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "crypto", name: "Robinhood Crypto" });
    upsertHolding(bundle.db, { accountId: brokerage.id, symbol: "SPY", assetType: "etf", quantityE8: 100_000_000, occurredOn: "2026-07-01" });
    upsertHolding(bundle.db, { accountId: crypto, symbol: "SPY", assetType: "stock", quantityE8: 100_000_000, occurredOn: "2026-07-01" });
    upsertHolding(bundle.db, { accountId: crypto, symbol: "ETH", assetType: "crypto", quantityE8: 100_000_000, occurredOn: "2026-07-01" });

    // WMT is a stock; SPY is two things; ETH is a coin, which no brokerage section holds
    expect(parseContextFor(bundle.db).equityAssetTypes).toEqual({ WMT: "stock" });
  });

  test("⛔ importing the same bytes again is nothing to do", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const file = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    await importStatementFiles(bundle.db, [file]);
    const before = wholeLedger(bundle.db);

    const [again] = await importStatementFiles(bundle.db, [file]);

    expect(again!.status).toBe("skipped_duplicate");
    expect(wholeLedger(bundle.db)).toEqual(before);
    expect(stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id).events).toHaveLength(1);
  });

  test("⛔ un-importing the month restores the ledger it found — the book, its shares and Agentic's August all leave", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
    const prior = wholeLedger(bundle.db);

    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const file = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, AGENT_BUYS_FILE)).get()!;
    expect(bookOf(bundle.db, agenticId)).toBeDefined();

    unimportFile(bundle.db, file.id);

    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(wholeLedger(bundle.db)).toEqual(prior);
  });

  test("⛔ September on top: the ledger's 0.25, a sale of 0.1 and a dividend — the book holds 0.15, Agentic's cash closes at $12.70, and a pending buy is not posted", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);

    const [september] = await importStatementFiles(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(true)])]);

    expect([september!.status, september!.withheld]).toEqual(["parsed", []]);
    const book = bookOf(bundle.db, agenticId)!;
    const held = stateOf(bundle.db, book.id);
    expect(held.events).toEqual([
      { symbol: "WMT", assetType: "stock", on: "2026-08-20", delta: 25_000_000, cost: 2500, kind: "trade" },
      { symbol: "WMT", assetType: "stock", on: "2026-09-15", delta: -10_000_000, cost: null, kind: "trade" },
    ]);
    // average cost: $25.00 for 0.25, the sale releases its share of it — $100.00 a share either way
    expect(held.holdings).toEqual([{ symbol: "WMT", assetType: "stock", quantityE8: 15_000_000, avgCostCents: 10_000, isActive: true }]);
    expect(held.periods.at(-1)).toEqual({ start: "2026-09-01", end: "2026-09-30", begin: 2622, endCents: 1664, reconciliation: "value_anchor" });
    // 0.15 × $110.90 = $16.635 → the printed $16.64
    expect(statementDayValuation(portfolioSeries(bundle.db, [book.id]))("2026-09-30")).toBe(1664);

    const agentic = stateOf(bundle.db, agenticId);
    expect(agentic.periods.at(-1)).toEqual({ start: "2026-09-01", end: "2026-09-30", begin: 164, endCents: 1270, reconciliation: "reconciled" });
    expect(agentic.rows.filter((r) => r.on >= "2026-09-01")).toEqual([
      { on: "2026-09-08", cents: 6, description: "Cash Div: R/D 2026-08-21 P/D 2026-09-08 - 0.25 shares at 0.2475", status: "active", category: "Dividends" },
      { on: "2026-09-15", cents: 1100, description: "Walmart", status: "active", category: "Sells" },
    ]);
  });

  test("⛔ a parser-version re-read of both months re-reads them into what they already hold — no share counted twice", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const august = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    const september = pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]);
    await importStatementFiles(bundle.db, [august]);
    await importStatementFiles(bundle.db, [september]);
    const bookId = bookOf(bundle.db, agenticId)!.id;
    const before = { book: stateOf(bundle.db, bookId), agentic: stateOf(bundle.db, agenticId) };
    // his note on September's sale — September is retired at AUGUST's turn, so what it carries is captured there
    const sale = and(eq(transactions.accountId, agenticId), eq(transactions.postedOn, "2026-09-15"), eq(transactions.status, "active"));
    bundle.db.update(transactions).set({ notes: "the agent's first sale" }).where(sale).run();

    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const { version } = profile;
    profile.version = version + 1;
    let outcomes;
    try {
      outcomes = await importStatementFiles(bundle.db, [august, september]);
    } finally {
      profile.version = version;
    }

    expect(outcomes.map((o) => [o.status, o.withheld, o.carriedForward])).toEqual([
      ["parsed", [], 0],
      ["parsed", [], 1],
    ]);
    expect(bundle.db.select({ notes: transactions.notes }).from(transactions).where(sale).all()).toEqual([{ notes: "the agent's first sale" }]);
    expect(bookOf(bundle.db, agenticId)!.id).toBe(bookId); // the same book, found by its link
    expect(stateOf(bundle.db, bookId)).toEqual(before.book);
    expect(stateOf(bundle.db, agenticId)).toEqual(before.agentic);
    // the retired rows' shares left with them
    const superseded = bundle.db.select({ id: importFiles.id }).from(importFiles).where(eq(importFiles.status, "superseded")).all();
    expect(superseded).toHaveLength(2);
    for (const { id } of superseded) {
      expect(bundle.db.select().from(holdingEvents).where(eq(holdingEvents.importFileId, id)).all()).toEqual([]);
    }
  });

  test("⛔ a section withheld because WMT's asset type was not on record is read by the next version once it is — and only by a version bump", async () => {
    const agenticId = ownersRobinhood(bundle.db, false);
    const file = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    const [first] = await importStatementFiles(bundle.db, [file]);
    expect(first!.withheld.map((w) => w.reason)).toEqual(["it holds WMT, and no position in this ledger records whether WMT is a stock or an ETF"]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined(); // a withheld section creates nothing

    knowWmt(bundle.db);
    const [same] = await importStatementFiles(bundle.db, [file]);
    expect(same!.status).toBe("skipped_duplicate");
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();

    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const { version } = profile;
    profile.version = version + 1;
    let bumped;
    try {
      [bumped] = await importStatementFiles(bundle.db, [file]);
    } finally {
      profile.version = version;
    }

    expect([bumped!.status, bumped!.withheld]).toEqual(["parsed", []]);
    expect(stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id).holdings).toEqual([
      { symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, avgCostCents: 10_000, isActive: true },
    ]);
    const files = bundle.db.select().from(importFiles).orderBy(asc(importFiles.parserVersion)).all();
    expect(files.map((f) => [f.status, withheldSectionsOf(f).length])).toEqual([
      ["superseded", 0],
      ["parsed", 0],
    ]);
  });

  /**
   * Robinhood names its statements with opaque UUIDs, and files import in name order: b7d4e2f1… (September) before
   * d41f0c83… (August). September's positions are proven by what the book held before September 1 — August's buy —
   * so read first, its section had nothing to be proven by and would be withheld; and a withheld month is read again
   * only by a version bump. Statements of a profile that proves positions month over month import OLDEST first.
   */
  test("⛔ two months uploaded together import oldest first, whatever their names — one book, both months read", async () => {
    const agenticId = ownersRobinhood(bundle.db);

    const outcomes = await importStatementFiles(bundle.db, [
      pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
      pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
    ]);

    expect(outcomes.map((o) => [o.fileName, o.status, o.withheld])).toEqual([
      [AGENT_BUYS_FILE, "parsed", []],
      [SEPTEMBER_FILE, "parsed", []],
    ]);
    expect(bundle.db.select().from(accounts).where(eq(accounts.cashAccountId, agenticId)).all()).toHaveLength(1);
    expect(stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id).holdings.map((h) => h.quantityE8)).toEqual([15_000_000]);
  });
});

/**
 * ⛔ The pair is a stored LINK (`accounts.cash_account_id`), never a name. Every test above pairs "Robinhood Agentic"
 * with the "Robinhood Agentic Brokerage" the import named, so a book found by that name passed them all (measured
 * 2026-09-16 at c2c8df3: 167/167 green across the four import suites with `resolveBook` looking up `${name} Brokerage`,
 * and again with the parse context's book events keyed that way). Here he has renamed the book through the account
 * edit form, and another investment account carries the very name the import gives a book.
 */
describe("⛔ the import finds the agent's book by its link — never by a name", () => {
  const robinhoodId = (db: AppDatabase) => db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!.id;
  const allAccountIds = (db: AppDatabase) => db.select({ id: accounts.id }).from(accounts).orderBy(asc(accounts.id)).all();

  test.each([
    ["with no other account", "none"],
    ["beside an unlinked account", "unlinked"],
    ["beside a book linked to Robinhood Cash", "linked"],
  ] as const)(
    "renamed after August %s named as the import names a book, September is proven by and written to the linked book — and no account is added",
    async (_how, lookAlikeKind) => {
      const agenticId = ownersRobinhood(bundle.db);
      await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
      await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
      const book = bookOf(bundle.db, agenticId)!;
      updateAccount(bundle.db, book.id, { name: "Agent Picks" });
      const lookAlike =
        lookAlikeKind === "none"
          ? null
          : createAccount(bundle.db, { institutionId: robinhoodId(bundle.db), name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
      if (lookAlike !== null && lookAlikeKind === "linked") {
        const cash = bundle.db.select().from(accounts).where(eq(accounts.name, "Robinhood Cash")).get()!;
        bundle.db.update(accounts).set({ cashAccountId: cash.id }).where(eq(accounts.id, lookAlike)).run();
      }
      const accountsBefore = allAccountIds(bundle.db);
      const lookAlikeBefore = lookAlike === null ? null : stateOf(bundle.db, lookAlike);

      // what September's sale is proven against: the linked book's August buy, whatever either account is called
      expect(parseContextFor(bundle.db).knownAccounts.Robinhood?.find((a) => a.last4 === "9651")?.book).toEqual({
        events: [{ symbol: "WMT", occurredOn: "2026-08-20", quantityDeltaE8: 25_000_000 }],
      });

      const [september] = await importStatementFiles(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)])]);

      expect([september!.status, september!.error, september!.withheld]).toEqual(["parsed", undefined, []]);
      // the same book, under the name he gave it, holding the printed 0.15 WMT — $26.22 → $16.64
      expect(bookOf(bundle.db, agenticId)).toMatchObject({ id: book.id, name: "Agent Picks" });
      const held = stateOf(bundle.db, book.id);
      expect(held.events.map((e) => [e.on, e.delta])).toEqual([
        ["2026-08-20", 25_000_000],
        ["2026-09-15", -10_000_000],
      ]);
      expect(held.holdings.map((h) => [h.symbol, h.quantityE8])).toEqual([["WMT", 15_000_000]]);
      expect(held.periods.at(-1)).toEqual({ start: "2026-09-01", end: "2026-09-30", begin: 2622, endCents: 1664, reconciliation: "value_anchor" });
      // the look-alike is exactly as it was, and no account was created or removed
      expect(lookAlike === null ? null : stateOf(bundle.db, lookAlike)).toEqual(lookAlikeBefore);
      expect(allAccountIds(bundle.db)).toEqual(accountsBefore);
      // and Robinhood Agentic keeps September's cash beside it, proven to the cent: $1.64 → $12.70
      expect(stateOf(bundle.db, agenticId).periods.at(-1)).toEqual({ start: "2026-09-01", end: "2026-09-30", begin: 164, endCents: 1270, reconciliation: "reconciled" });
    },
  );

  test("one book per cash account: a later month adds no account, and the database refuses a second book", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const afterAugust = allAccountIds(bundle.db);

    const [september] = await importStatementFiles(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)])]);

    expect(september!.status).toBe("parsed");
    expect(allAccountIds(bundle.db)).toEqual(afterAugust);
    expect(bundle.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.cashAccountId, agenticId)).all()).toHaveLength(1);
    expect(() =>
      bundle.db
        .insert(accounts)
        .values({ institutionId: robinhoodId(bundle.db), name: "Agent Picks", type: "investment", subtype: "brokerage", cashAccountId: agenticId })
        .run(),
    ).toThrow(/UNIQUE constraint failed: accounts\.cash_account_id/);
  });
});

/**
 * What the /investments Refresh button and the runbook's step 3 do after an import, without the network: WMT quoted at
 * $109.46 on the suite's today, no closes to backfill. `refreshPrices` then writes a `live` anchor on every investment
 * account holding something — the book included.
 */
const QUOTES: PriceProvider = {
  source: "yahoo",
  getDailyCloses: async () => [],
  getIntradayTicks: async () => [],
  getQuotes: async (items) => items.map((item) => ({ ...item, price: 109.46, asOfDay: "2026-10-05" })),
};
const refresh = (db: AppDatabase) => refreshPrices(db, { now: new Date(2026, 9, 5, 12), providers: () => QUOTES, force: true });

/** AGENT_BUYS as a later parser version might read it: WMT's value no longer adds up to the printed Total Securities, so the section is withheld. */
const AGENT_BUYS_UNPROVEN = AGENT_BUYS.map((l) => (l.text.startsWith("WMT Cash 0.25") ? line("WMT Cash 0.25 $104.87000 $26.21 $0.24 94.11%") : l));

const liveAnchors = (db: AppDatabase, accountId: string) =>
  db.select({ on: balanceAnchors.anchoredOn, cents: balanceAnchors.balanceCents }).from(balanceAnchors).where(and(eq(balanceAnchors.accountId, accountId), eq(balanceAnchors.source, "live"))).all();

/** Re-read `files` as the next parser version would. */
async function reReadAtNextVersion(db: AppDatabase, files: ImportInput[]) {
  const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
  const { version } = profile;
  profile.version = version + 1;
  try {
    return await importStatementFiles(db, files);
  } finally {
    profile.version = version;
  }
}

/** Run `act` with the brokerage parser throwing `message` for the file named `fileName` — every other file reads as always. */
async function withParseFailing<T>(fileName: string, message: string, act: () => Promise<T>): Promise<T> {
  const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
  const parse = profile.parse.bind(profile);
  const failing = vi.spyOn(profile, "parse").mockImplementation(async (file, context) => {
    if (file.name === fileName) throw new Error(message);
    return parse(file, context);
  });
  try {
    return await act();
  } finally {
    failing.mockRestore();
  }
}

/** The ids of the import files in place — read and not retired — sorted. */
const filesInPlace = (db: AppDatabase) =>
  db
    .select({ id: importFiles.id })
    .from(importFiles)
    .where(eq(importFiles.status, "parsed"))
    .all()
    .map((f) => f.id)
    .sort();

/** Every row of the ledger but the import files' own, whose failed re-reads are rows too. */
function ledgerBesideFiles(db: AppDatabase) {
  const { importFiles: _files, ...rest } = wholeLedger(db);
  return rest;
}

const EARLIER_READ_KEPT = "nothing was changed; the earlier read of this file is still in place";

describe("⛔ the book leaves with the last statement that proved it — a price refresh does not keep it", () => {
  test("un-importing the month after a price refresh restores the ledger it found — the book and its live value leave", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
    await refresh(bundle.db);
    const prior = wholeLedger(bundle.db);

    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    await refresh(bundle.db);
    const book = bookOf(bundle.db, agenticId)!;
    // 0.25 × $109.46 = $27.365 — the refresh priced the book like every investment account holding something
    expect(liveAnchors(bundle.db, book.id)).toEqual([{ on: "2026-10-05", cents: 2737 }]);

    unimportFile(bundle.db, bundle.db.select().from(importFiles).where(eq(importFiles.fileName, AGENT_BUYS_FILE)).get()!.id);

    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(liveAnchors(bundle.db, book.id)).toEqual([]);
    expect(wholeLedger(bundle.db)).toEqual(prior);
  });

  test("a re-read that no longer proves the month, after a price refresh, takes the book and its live value away — as a first read that withheld it would never have made one", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    await refresh(bundle.db);
    const book = bookOf(bundle.db, agenticId)!;
    expect(liveAnchors(bundle.db, book.id)).toEqual([{ on: "2026-10-05", cents: 2737 }]);
    const accountsBefore = bundle.db.select().from(accounts).all().length;

    const [reread] = await reReadAtNextVersion(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS_UNPROVEN, ...AUGUST_BROKERAGE])]);

    expect([reread!.status, reread!.withheld.map((w) => w.reason)]).toEqual([
      "parsed",
      ["its positions add up to $26.21, but it prints $26.22 of securities — a position this reader cannot see is there"],
    ]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(bundle.db.select().from(accounts).all()).toHaveLength(accountsBefore - 1);
    expect(liveAnchors(bundle.db, book.id)).toEqual([]);
    expect(bundle.db.select().from(dailyBalances).where(eq(dailyBalances.accountId, book.id)).all()).toEqual([]);
  });

  test("a statement that fails after its book was made leaves no empty book behind", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const prior = bundle.db.select().from(accounts).all().length;
    // the book is resolved before the statement's transaction, and a positions write that throws rolls that transaction back
    WRITE_FAULT.message = "the book's WMT through 2026-08-31 is 0e-8 after writing, the statement prints 25000000e-8";
    try {
      const [outcome] = await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
      expect([outcome!.status, outcome!.error]).toEqual(["failed", WRITE_FAULT.message]);
    } finally {
      WRITE_FAULT.message = null;
    }

    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(bundle.db.select().from(accounts).all()).toHaveLength(prior);
  });
});

/** CONSTRUCTED: #487513525 in October, nothing moving, as SEPTEMBER_BROKERAGE. */
const OCTOBER_BROKERAGE = SEPTEMBER_BROKERAGE.map((l) => (l.text.startsWith("09/01/2026") ? line("10/01/2026 to 10/31/2026") : l));

/** CONSTRUCTED: October, nothing traded — the 0.15 WMT held at $111.00 = $16.65, the cash still $12.70. */
const AGENT_HOLDS_OCTOBER = [
  line("10/01/2026 to 10/31/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $12.70 $12.70"),
  line("Total Securities $16.64 $16.65"),
  line("Portfolio Value $29.34 $29.35"),
  line("Portfolio Summary"),
  line("Walmart"),
  line("WMT Cash 0.15 $111.00000 $16.65 $0.14 56.73%"),
  line("Total Securities $16.65 $0.14 56.73%"),
  line("Brokerage Cash Balance $12.70 43.27%"),
  line("Account Activity"),
  header(685.13, 743.4),
  totalFunds("$0.00", "$0.00"),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];
const OCTOBER_FILE = "0c6a9e57-1d2b-4f83-a7c4-5e9b0d1f2a63.pdf";

/**
 * CONSTRUCTED on the real June: the agent's FIRST statement buys 0.25 WMT for $25.00 on 06/10 — its opening prints
 * N/A, so the book's period carries no balances — only its window, the trade and a closing value (0.25 × $104.00 = $26.00).
 */
const AGENT_FIRST_BUYS = [
  line("06/01/2026 to 06/30/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance N/A $1.64"),
  line("Total Securities N/A $26.00"),
  line("Portfolio Value N/A $27.64"),
  line("Portfolio Summary"),
  line("Walmart"),
  line("WMT Cash 0.25 $104.00000 $26.00 $0.24 94.07%"),
  line("Total Securities $26.00 $0.24 94.07%"),
  line("Brokerage Cash Balance $1.64 5.93%"),
  line("Account Activity"),
  header(695.33, 746.51),
  line("Transfer from Brokerage to Brokerage Cash ITRF 06/05/2026 $26.64", [
    ["Transfer from Brokerage to Brokerage", 36],
    ["Cash", 347.25],
    ["ITRF", 426.3],
    ["06/05/2026", 516.67],
    ["$26.64", 746.51],
  ]),
  line("Walmart"),
  line("WMT Cash Buy 06/10/2026 0.25 $100.00000 $25.00", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Buy", 431.63],
    ["06/10/2026", 534.56],
    ["0.25", 586.28],
    ["$100.00000", 630.19],
    ["$25.00", 695.33],
  ]),
  line("CUSIP: 931142103"),
  totalFunds("$25.00", "$26.64", 695.33, 746.51),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/**
 * CONSTRUCTED on the real June: the agent's first statement buys 0.1 WMT on 06/10 and sells it on 06/20, $10.00 each
 * way — the book's June holds trades and ends with nothing, so August's buy opens on an empty book.
 */
const AGENT_ROUND_TRIP = [
  line("06/01/2026 to 06/30/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance N/A $26.64"),
  line("Total Securities N/A $0.00"),
  line("Portfolio Value N/A $26.64"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $26.64 100.00%"),
  line("Account Activity"),
  header(695.33, 746.51),
  line("Transfer from Brokerage to Brokerage Cash ITRF 06/05/2026 $26.64", [
    ["Transfer from Brokerage to Brokerage", 36],
    ["Cash", 347.25],
    ["ITRF", 426.3],
    ["06/05/2026", 516.67],
    ["$26.64", 746.51],
  ]),
  line("Walmart"),
  line("WMT Cash Buy 06/10/2026 0.1 $100.00000 $10.00", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Buy", 431.63],
    ["06/10/2026", 534.56],
    ["0.1", 586.28],
    ["$100.00000", 630.19],
    ["$10.00", 695.33],
  ]),
  line("CUSIP: 931142103"),
  line("Walmart"),
  line("WMT Cash Sell 06/20/2026 0.1 $100.00000 $10.00", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Sell", 431.63],
    ["06/20/2026", 534.56],
    ["0.1", 586.28],
    ["$100.00000", 630.19],
    ["$10.00", 746.51],
  ]),
  line("CUSIP: 931142103"),
  totalFunds("$10.00", "$36.64", 695.33, 746.51),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/** CONSTRUCTED: August holding June's 0.25 WMT, nothing traded — $26.00 → $26.22, the cash still $1.64. */
const AGENT_HOLDS_AUGUST = [
  line("08/01/2026 to 08/31/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $1.64 $1.64"),
  line("Total Securities $26.00 $26.22"),
  line("Portfolio Value $27.64 $27.86"),
  line("Portfolio Summary"),
  line("Walmart"),
  line("WMT Cash 0.25 $104.87000 $26.22 $0.24 94.11%"),
  line("Total Securities $26.22 $0.24 94.11%"),
  line("Brokerage Cash Balance $1.64 5.89%"),
  line("Account Activity"),
  header(685.13, 743.4),
  totalFunds("$0.00", "$0.00"),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

describe("⛔ a book's months come off newest first — shares a later statement stands on are never taken from under it", () => {
  const UNDER_SEPTEMBER = `Robinhood Agentic Brokerage still holds this statement's shares under a later statement`;
  const SEPTEMBER = `${SEPTEMBER_FILE} (Sep 1 – 30, 2026)`;

  async function augustAndSeptember(db: AppDatabase) {
    const agenticId = ownersRobinhood(db);
    await importStatementFiles(db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    await importStatementFiles(db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)])]);
    await refresh(db);
    const fileId = (name: string) => db.select().from(importFiles).where(eq(importFiles.fileName, name)).get()!.id;
    return { agenticId, bookId: bookOf(db, agenticId)!.id, august: fileId(AGENT_BUYS_FILE), september: fileId(SEPTEMBER_FILE) };
  }

  test("un-importing August while September stands on its 0.25 is refused, naming September — and nothing changes, no restore point either", async () => {
    const { agenticId, bookId, august, september } = await augustAndSeptember(bundle.db);
    const before = wholeLedger(bundle.db);
    // a restore point is a full copy of the ledger and prunes older ones — a refused click must not take one
    const restorePoints = () => (fs.existsSync(path.join(dir, "backups")) ? fs.readdirSync(path.join(dir, "backups")) : []);
    expect(restorePoints()).toEqual([]);

    expect(() => unimportFile(bundle.db, august)).toThrow(`${UNDER_SEPTEMBER} — un-import ${SEPTEMBER} before it`);

    expect(restorePoints()).toEqual([]);
    expect(wholeLedger(bundle.db)).toEqual(before);
    expect(stateOf(bundle.db, bookId).holdings).toEqual([{ symbol: "WMT", assetType: "stock", quantityE8: 15_000_000, avgCostCents: 10_000, isActive: true }]);

    // the way the refusal names: September first, then August — and the ledger is the one before either
    unimportFile(bundle.db, september);
    unimportFile(bundle.db, august);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(bundle.db.select().from(holdings).where(eq(holdings.accountId, bookId)).all()).toEqual([]);
  });

  test("a re-read of August alone that no longer proves it is refused while September stands on it — never a negative position", async () => {
    const { bookId } = await augustAndSeptember(bundle.db);
    const before = wholeLedger(bundle.db);

    const [reread] = await reReadAtNextVersion(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS_UNPROVEN, ...AUGUST_BROKERAGE])]);

    expect([reread!.status, reread!.error]).toEqual([
      "failed",
      `${UNDER_SEPTEMBER}, and reading it again would take them away first — upload ${SEPTEMBER} with it to read them together`,
    ]);
    expect(wholeLedger(bundle.db)).toEqual(before);
    expect(stateOf(bundle.db, bookId).holdings.map((h) => h.quantityE8)).toEqual([15_000_000]);
  });

  test("a re-read of both months where August no longer proves withholds September too — and the book leaves, never short", async () => {
    const { agenticId, bookId } = await augustAndSeptember(bundle.db);

    const outcomes = await reReadAtNextVersion(bundle.db, [
      pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
      pdf(AGENT_BUYS_FILE, [...AGENT_BUYS_UNPROVEN, ...AUGUST_BROKERAGE]),
    ]);

    expect(outcomes.map((o) => [o.fileName, o.status, o.withheld.length])).toEqual([
      [AGENT_BUYS_FILE, "parsed", 1],
      [SEPTEMBER_FILE, "parsed", 1],
    ]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(bundle.db.select().from(holdings).where(eq(holdings.accountId, bookId)).all()).toEqual([]);
    expect(liveAnchors(bundle.db, bookId)).toEqual([]);
  });

  test("three months: August names October, then September — each comes off only once nothing later stands on it", async () => {
    const { agenticId, august, september } = await augustAndSeptember(bundle.db);
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const [october] = await importStatementFiles(bundle.db, [pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_HOLDS_OCTOBER])]);
    expect([october!.status, october!.withheld]).toEqual(["parsed", []]);
    const octoberId = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, OCTOBER_FILE)).get()!.id;

    expect(() => unimportFile(bundle.db, august)).toThrow(
      `Robinhood Agentic Brokerage still holds this statement's shares under later statements — un-import ${OCTOBER_FILE} (Oct 1 – 31, 2026), then ${SEPTEMBER} before it`,
    );
    // October trades nothing, and its printed 0.15 still stands on September's sale
    expect(() => unimportFile(bundle.db, september)).toThrow(`un-import ${OCTOBER_FILE} (Oct 1 – 31, 2026) before it`);

    unimportFile(bundle.db, octoberId);
    unimportFile(bundle.db, september);
    unimportFile(bundle.db, august);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
  });

  test("the agent's first statement opens N/A, its book's period without balances — un-importing it under an August that only holds is still refused", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const [june] = await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...AGENT_FIRST_BUYS])]);
    const [august] = await importStatementFiles(bundle.db, [pdf(AUGUST_FILE, [...AGENT_HOLDS_AUGUST, ...AUGUST_BROKERAGE])]);
    expect([june!.withheld, august!.withheld]).toEqual([[], []]);
    const book = stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id);
    expect(book.periods).toEqual([
      { start: "2026-06-01", end: "2026-06-30", begin: null, endCents: null, reconciliation: "not_applicable" },
      { start: "2026-08-01", end: "2026-08-31", begin: 2600, endCents: 2622, reconciliation: "value_anchor" },
    ]);
    // August trades nothing: only its period says it stands on June's 0.25
    expect(book.events.map((e) => [e.on, e.delta])).toEqual([["2026-06-10", 25_000_000]]);
    const before = wholeLedger(bundle.db);

    const juneId = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, JUNE_FILE)).get()!.id;
    expect(() => unimportFile(bundle.db, juneId)).toThrow(
      `Robinhood Agentic Brokerage still holds this statement's shares under a later statement — un-import ${AUGUST_FILE} (Aug 1 – 31, 2026) before it`,
    );
    expect(wholeLedger(bundle.db)).toEqual(before);
  });

  test("a re-read of three months retires October and September before August — every month read again, the book as it was", async () => {
    const { agenticId, bookId } = await augustAndSeptember(bundle.db);
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const october = pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_HOLDS_OCTOBER]);
    await importStatementFiles(bundle.db, [october]);
    const before = stateOf(bundle.db, bookId);

    const outcomes = await reReadAtNextVersion(bundle.db, [
      october,
      pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
      pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
    ]);

    expect(outcomes.map((o) => [o.fileName, o.status, o.withheld])).toEqual([
      [AGENT_BUYS_FILE, "parsed", []],
      [SEPTEMBER_FILE, "parsed", []],
      [OCTOBER_FILE, "parsed", []],
    ]);
    expect(bookOf(bundle.db, agenticId)!.id).toBe(bookId);
    expect(stateOf(bundle.db, bookId)).toEqual(before);
    expect(bundle.db.select().from(importFiles).where(eq(importFiles.status, "superseded")).all()).toHaveLength(3);
  });

  test("a re-read of three months retires them newest first — August's buy never leaves before September's sale of it", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const files = [
      pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...AGENT_ROUND_TRIP]),
      pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
      pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
    ];
    for (const file of files) expect((await importStatementFiles(bundle.db, [file]))[0]!.withheld).toEqual([]);
    const bookId = bookOf(bundle.db, agenticId)!.id;
    const before = stateOf(bundle.db, bookId);
    expect(before.events.map((e) => [e.on, e.delta])).toEqual([
      ["2026-06-10", 10_000_000],
      ["2026-06-20", -10_000_000],
      ["2026-08-20", 25_000_000],
      ["2026-09-15", -10_000_000],
    ]);

    // June's turn retires September, then August, then June: August first would leave September's sale alone
    const outcomes = await reReadAtNextVersion(bundle.db, [...files].reverse());

    expect(outcomes.map((o) => [o.fileName, o.status, o.error, o.withheld])).toEqual([
      [JUNE_FILE, "parsed", undefined, []],
      [AGENT_BUYS_FILE, "parsed", undefined, []],
      [SEPTEMBER_FILE, "parsed", undefined, []],
    ]);
    expect(stateOf(bundle.db, bookId)).toEqual(before);
  });

  test("a re-read of August while September was already read by the newer version is refused — un-import September first", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const august = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    await importStatementFiles(bundle.db, [august]);
    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const { version } = profile;
    profile.version = version + 1;
    try {
      // September arrives after the bump, read by the newer version on top of August's older read
      await importStatementFiles(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)])]);
      const before = wholeLedger(bundle.db);

      const [reread] = await importStatementFiles(bundle.db, [august]);

      expect([reread!.status, reread!.error]).toEqual([
        "failed",
        `${UNDER_SEPTEMBER}, and reading it again would take them away first — un-import ${SEPTEMBER} before reading it again`,
      ]);
      expect(wholeLedger(bundle.db)).toEqual(before);
    } finally {
      profile.version = version;
    }
    expect(stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id).holdings.map((h) => h.quantityE8)).toEqual([15_000_000]);
  });

  /**
   * ⛔ A re-read parses BEFORE it retires anything (round 2, 8bf21ac), and a book month's retirement takes the later
   * months this upload also re-reads with it. Before the two met, August's turn retired September and August first and
   * then parsed: a version that could not read August left the book with neither month's shares, and September was then
   * read on an empty book.
   */
  test("a re-read of both months that cannot parse August retires nothing — September is read again on the August in place, the book as it was", async () => {
    const { agenticId, bookId, august } = await augustAndSeptember(bundle.db);
    const before = { book: stateOf(bundle.db, bookId), agentic: stateOf(bundle.db, agenticId) };
    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const parse = profile.parse.bind(profile);
    const cannotReadAugust = vi.spyOn(profile, "parse").mockImplementation(async (file, context) => {
      if (file.name === AGENT_BUYS_FILE) throw new Error("this version cannot read August");
      return parse(file, context);
    });
    let outcomes;
    try {
      outcomes = await reReadAtNextVersion(bundle.db, [
        pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
        pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
      ]);
    } finally {
      cannotReadAugust.mockRestore();
    }

    expect(outcomes.map((o) => [o.fileName, o.status, o.withheld])).toEqual([
      [AGENT_BUYS_FILE, "failed", []],
      [SEPTEMBER_FILE, "parsed", []],
    ]);
    expect(outcomes[0]!.error).toBe(
      "Unexpected: Error: this version cannot read August (nothing was changed; the earlier read of this file is still in place)",
    );
    // August's older read is the one in place; only September's was retired, by September's own re-read
    const live = bundle.db.select().from(importFiles).where(eq(importFiles.status, "parsed")).all();
    expect(live.find((f) => f.fileName === AGENT_BUYS_FILE)!.id).toBe(august);
    expect(bundle.db.select({ name: importFiles.fileName }).from(importFiles).where(eq(importFiles.status, "superseded")).all()).toEqual([
      { name: SEPTEMBER_FILE },
    ]);
    expect(stateOf(bundle.db, bookId)).toEqual(before.book);
    expect(stateOf(bundle.db, agenticId)).toEqual(before.agentic);
  });

  test("a re-read of both months whose August write fails retires nothing — September's read is not taken with it", async () => {
    const { august, september } = await augustAndSeptember(bundle.db);
    const { importFiles: filesBefore, ...before } = wholeLedger(bundle.db);

    const fault = "the positions write failed";
    WRITE_FAULT.message = fault;
    let outcomes;
    try {
      outcomes = await reReadAtNextVersion(bundle.db, [
        pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
        pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
      ]);
    } finally {
      WRITE_FAULT.message = null;
    }

    expect(outcomes.map((o) => [o.fileName, o.status])).toEqual([
      [AGENT_BUYS_FILE, "failed"],
      [SEPTEMBER_FILE, "failed"],
    ]);
    const { importFiles: filesAfter, ...after } = wholeLedger(bundle.db);
    expect(after).toEqual(before);
    // both older reads stay in place; each new read is a failed row that says so
    expect(bundle.db.select({ id: importFiles.id }).from(importFiles).where(eq(importFiles.status, "parsed")).all().map((f) => f.id).sort()).toEqual(
      [august, september].sort(),
    );
    const failed = bundle.db.select().from(importFiles).where(eq(importFiles.status, "failed")).all();
    expect(failed.map((f) => f.error)).toEqual([
      `Failed mid-import (nothing was changed; the earlier read of this file is still in place): ${fault}`,
      `Failed mid-import (nothing was changed; the earlier read of this file is still in place): ${fault}`,
    ]);
    expect(filesAfter).toHaveLength(filesBefore.length + 2);
  });

  /**
   * ⛔ A re-read of several book months is ONE read. August's write retires September with it, so a September the new
   * version cannot read must leave August's older read in place too. 🔴 Before, September's older read left with
   * August's write, and September's own turn had nothing left to keep: measured 2026-09-16 on the branch fixture,
   * Agentic's Sep 30 went from $12.70 anchored to $1.64 carried, the book from 0.15 to 0.25 WMT ($16.64 → $27.73), and
   * the owner's note and the row he filed under September were superseded — for good, a re-upload brought neither back.
   */
  async function withOwnersWorkOnSeptember(db: AppDatabase) {
    const books = await augustAndSeptember(db);
    const agenticRow = (on: string) =>
      db.select().from(transactions).where(and(eq(transactions.accountId, books.agenticId), eq(transactions.postedOn, on), eq(transactions.status, "active"))).get()!;
    const sale = agenticRow("2026-09-15").id;
    const dividend = agenticRow("2026-09-08").id;
    db.update(transactions).set({ notes: "the agent's first sale" }).where(eq(transactions.id, sale)).run();
    db.update(transactions).set({ fileLinkSource: "attached" }).where(eq(transactions.id, dividend)).run();
    const row = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    return { ...books, sale, dividend, row };
  }

  const SEPTEMBER_FAILED = `${SEPTEMBER_FILE} failed, and this statement is read again only together with it (${EARLIER_READ_KEPT})`;

  test("a re-read of both months that cannot parse September retires nothing — both older reads stay, with the owner's note and the row he filed", async () => {
    const { august, september, sale, dividend, row } = await withOwnersWorkOnSeptember(bundle.db);
    const before = ledgerBesideFiles(bundle.db);

    const outcomes = await withParseFailing(SEPTEMBER_FILE, "this version cannot read September", () =>
      reReadAtNextVersion(bundle.db, [
        pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
        pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
      ]),
    );

    expect(outcomes.map((o) => [o.fileName, o.status, o.error])).toEqual([
      [AGENT_BUYS_FILE, "failed", SEPTEMBER_FAILED],
      [SEPTEMBER_FILE, "failed", `Unexpected: Error: this version cannot read September (${EARLIER_READ_KEPT})`],
    ]);
    expect(ledgerBesideFiles(bundle.db)).toEqual(before);
    expect(filesInPlace(bundle.db)).toEqual([august, september].sort());
    expect(row(sale)).toMatchObject({ status: "active", importFileId: september, notes: "the agent's first sale" });
    expect(row(dividend)).toMatchObject({ status: "active", importFileId: september, fileLinkSource: "attached" });

    // …and once the version reads September, the upload reads both, the owner's work with them
    const again = await reReadAtNextVersion(bundle.db, [
      pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
      pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
    ]);
    expect(again.map((o) => [o.fileName, o.status, o.error])).toEqual([
      [AGENT_BUYS_FILE, "parsed", undefined],
      [SEPTEMBER_FILE, "parsed", undefined],
    ]);
    expect(ledgerBesideFiles(bundle.db).transactions.filter((t) => t.status !== "superseded").map((t) => [t.postedOn, t.amountCents, t.notes, t.fileLinkSource])).toContainEqual([
      "2026-09-15",
      1100,
      "the agent's first sale",
      null,
    ]);
  });

  test("September's turn before August's: its failed re-read keeps its older read, and August's re-read is refused rather than retire it", async () => {
    const { august, september } = await withOwnersWorkOnSeptember(bundle.db);
    const before = ledgerBesideFiles(bundle.db);
    // a September whose order the reader cannot key keeps its name's place — b7d4… before d41f…
    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const orderKey = profile.orderKey!.bind(profile);
    const unkeyed = vi.spyOn(profile, "orderKey").mockImplementation((content) => (content.includes("09/01/2026 to 09/30/2026") ? null : orderKey(content)));
    let outcomes;
    try {
      outcomes = await withParseFailing(SEPTEMBER_FILE, "this version cannot read September", () =>
        reReadAtNextVersion(bundle.db, [
          pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
          pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
        ]),
      );
    } finally {
      unkeyed.mockRestore();
    }

    expect(outcomes.map((o) => [o.fileName, o.status, o.error])).toEqual([
      [SEPTEMBER_FILE, "failed", `Unexpected: Error: this version cannot read September (${EARLIER_READ_KEPT})`],
      [AGENT_BUYS_FILE, "failed", `${UNDER_SEPTEMBER}, and reading it again would take them away first — ${SEPTEMBER} could not be read again in this upload`],
    ]);
    expect(ledgerBesideFiles(bundle.db)).toEqual(before);
    expect(filesInPlace(bundle.db)).toEqual([august, september].sort());
  });

  test("an earlier month read as cash, still waiting its turn, is not read with the book's months — its failure leaves them read", async () => {
    const { august, september } = await augustAndSeptember(bundle.db);
    // June read as cash, in a file whose name puts it after both — and whose order the reader cannot key
    const LATE_NAMED_JUNE = "f1e2d3c4-5b6a-4978-8a9b-0c1d2e3f4a5b.pdf";
    const june = pdf(LATE_NAMED_JUNE, [...JUNE_BROKERAGE, ...JUNE_SECOND]);
    await importStatementFiles(bundle.db, [june]);
    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const orderKey = profile.orderKey!.bind(profile);
    const unkeyed = vi.spyOn(profile, "orderKey").mockImplementation((content) => (content.includes("06/01/2026 to 06/30/2026") ? null : orderKey(content)));
    let outcomes;
    try {
      outcomes = await withParseFailing(LATE_NAMED_JUNE, "this version cannot read June", () =>
        reReadAtNextVersion(bundle.db, [
          june,
          pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
          pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
        ]),
      );
    } finally {
      unkeyed.mockRestore();
    }

    expect(outcomes.map((o) => [o.fileName, o.status])).toEqual([
      [AGENT_BUYS_FILE, "parsed"],
      [SEPTEMBER_FILE, "parsed"],
      [LATE_NAMED_JUNE, "failed"],
    ]);
    expect(filesInPlace(bundle.db)).not.toContain(august);
    expect(filesInPlace(bundle.db)).not.toContain(september);
  });

  test("a re-read of both months whose September write fails retires nothing — August's write is not kept without it", async () => {
    const { august, september, sale, row } = await withOwnersWorkOnSeptember(bundle.db);
    const before = ledgerBesideFiles(bundle.db);

    const fault = "the positions write failed";
    Object.assign(WRITE_FAULT, { message: fault, through: "2026-09-30" });
    let outcomes;
    try {
      outcomes = await reReadAtNextVersion(bundle.db, [
        pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)]),
        pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
      ]);
    } finally {
      Object.assign(WRITE_FAULT, { message: null, through: null });
    }

    expect(outcomes.map((o) => [o.fileName, o.status, o.error])).toEqual([
      [AGENT_BUYS_FILE, "failed", SEPTEMBER_FAILED],
      [SEPTEMBER_FILE, "failed", fault],
    ]);
    expect(ledgerBesideFiles(bundle.db)).toEqual(before);
    expect(filesInPlace(bundle.db)).toEqual([august, september].sort());
    expect(row(sale)).toMatchObject({ status: "active", importFileId: september, notes: "the agent's first sale" });
    expect(bundle.db.select({ error: importFiles.error }).from(importFiles).where(eq(importFiles.status, "failed")).all().map((f) => f.error).sort()).toEqual(
      [SEPTEMBER_FAILED, `Failed mid-import (${EARLIER_READ_KEPT}): ${fault}`].sort(),
    );
  });

  test("a re-read whose retirement would walk the book below zero is refused with the walk's own words — nothing retired", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const august = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    await importStatementFiles(bundle.db, [august]);
    const bookId = bookOf(bundle.db, agenticId)!.id;
    // a sale on the book that no statement printed — no later statement names it, so only the walk can refuse
    bundle.db
      .insert(holdingEvents)
      .values({ accountId: bookId, symbol: "WMT", assetType: "stock", occurredOn: "2026-09-02", quantityDeltaE8: -10_000_000, eventKind: "trade", note: "recorded by hand" })
      .run();
    const before = wholeLedger(bundle.db);

    const [reread] = await reReadAtNextVersion(bundle.db, [august]);

    expect([reread!.status, reread!.error]).toEqual([
      "failed",
      "the book's WMT would stand at -10000000e-8 on 2026-09-02 — a sale of shares it does not hold; its later statements come off first",
    ]);
    expect(wholeLedger(bundle.db)).toEqual(before);
  });

  test("the holdings restatement refuses a walk below zero — the transaction that asked rolls back", async () => {
    const { bookId, august } = await augustAndSeptember(bundle.db);
    const before = wholeLedger(bundle.db);

    // what an un-import or a supersede would do past its refusal: August's buy gone, September's sale of 0.1 alone
    expect(() => bundle.db.transaction((tx) => removeFileEvents(tx, august))).toThrow(/WMT.*-10000000e-8.*2026-09-15/);

    expect(wholeLedger(bundle.db)).toEqual(before);
    expect(stateOf(bundle.db, bookId).events).toHaveLength(2);
  });
});

/** CONSTRUCTED: September sells all 0.25 WMT at $109.24 on 09/15 — cash $1.64 → $28.95, securities $26.22 → $0.00. */
const AGENT_SELLS_ALL = [
  line("09/01/2026 to 09/30/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $1.64 $28.95"),
  line("Total Securities $26.22 $0.00"),
  line("Portfolio Value $27.86 $28.95"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $28.95 100.00%"),
  line("Account Activity"),
  header(685.13, 743.4),
  line("Walmart"),
  line("WMT Cash Sell 09/15/2026 0.25 $109.24000 $27.31", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Sell", 431.63],
    ["09/15/2026", 534.56],
    ["0.25", 586.28],
    ["$109.24000", 630.19],
    ["$27.31", 743.4],
  ]),
  line("CUSIP: 931142103"),
  totalFunds("$0.00", "$27.31"),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/** AGENT_SELLS_ALL as a later parser version might read it: its Total Funds line off by a cent, so the section is withheld. */
const AGENT_SELLS_ALL_UNPROVEN = AGENT_SELLS_ALL.map((l) => (l.text.startsWith("Total Funds Paid and Received") ? totalFunds("$0.00", "$27.32") : l));

/** CONSTRUCTED: October after that sale — nothing held, nothing traded, the cash still $28.95. What a quiet month prints. */
const AGENT_CASH_OCTOBER = [
  line("10/01/2026 to 10/31/2026"),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $28.95 $28.95"),
  line("Total Securities $0.00 $0.00"),
  line("Portfolio Value $28.95 $28.95"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $28.95 100.00%"),
  line("Account Activity"),
  header(685.13, 743.4),
  totalFunds("$0.00", "$0.00"),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];

/**
 * ⛔ A month that follows the book's shares is a statement of the book, even when it holds nothing: its printed
 * $0.00 is what says the sold shares are gone. Read as cash only, nothing on the book stood after the sale — so
 * un-importing or re-reading the sale was never refused, and the sold 0.25 WMT came back into net worth while
 * October's cash already held the $27.31 they sold for (measured 2026-09-16 on a real-ledger copy: +$27.37).
 */
describe("⛔ a month after the agent's shares is its book's statement — even one that holds nothing", () => {
  const fileId = (db: AppDatabase, name: string) => db.select().from(importFiles).where(eq(importFiles.fileName, name)).get()!.id;
  const OCTOBER = `${OCTOBER_FILE} (Oct 1 – 31, 2026)`;
  const brokerageId = (db: AppDatabase) => db.select().from(accounts).where(eq(accounts.name, "Robinhood Brokerage")).get()!.id;

  async function boughtSoldAndQuiet(db: AppDatabase) {
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const agenticId = ownersRobinhood(db);
    const outcomes = await importStatementFiles(db, [
      pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_CASH_OCTOBER]),
      pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS_ALL]),
      pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
    ]);
    expect(outcomes.map((o) => [o.fileName, o.status, o.withheld])).toEqual([
      [AGENT_BUYS_FILE, "parsed", []],
      [SEPTEMBER_FILE, "parsed", []],
      [OCTOBER_FILE, "parsed", []],
    ]);
    return { agenticId, bookId: bookOf(db, agenticId)!.id };
  }

  test("October after the sale of every share writes its $0.00 on the book — and un-importing September under it is refused, nothing changing", async () => {
    const { agenticId, bookId } = await boughtSoldAndQuiet(bundle.db);
    const book = stateOf(bundle.db, bookId);
    expect(book.periods).toEqual([
      { start: "2026-08-01", end: "2026-08-31", begin: 0, endCents: 2622, reconciliation: "value_anchor" },
      { start: "2026-09-01", end: "2026-09-30", begin: 2622, endCents: 0, reconciliation: "value_anchor" },
      { start: "2026-10-01", end: "2026-10-31", begin: 0, endCents: 0, reconciliation: "value_anchor" },
    ]);
    expect(book.events.map((e) => [e.on, e.delta])).toEqual([
      ["2026-08-20", 25_000_000],
      ["2026-09-15", -25_000_000],
    ]);
    expect(book.holdings.map((h) => [h.symbol, h.quantityE8, h.isActive])).toEqual([["WMT", 0, false]]);
    // `pnpm ledger-check`'s witness now has October's printed $0.00 to check the book against
    expect(statementDayValuation(portfolioSeries(bundle.db, [bookId]))("2026-10-31")).toBe(0);
    expect(stateOf(bundle.db, agenticId).periods.at(-1)).toEqual({ start: "2026-10-01", end: "2026-10-31", begin: 2895, endCents: 2895, reconciliation: "reconciled" });
    const before = wholeLedger(bundle.db);

    expect(() => unimportFile(bundle.db, fileId(bundle.db, SEPTEMBER_FILE))).toThrow(
      `Robinhood Agentic Brokerage still holds this statement's shares under a later statement — un-import ${OCTOBER} before it`,
    );

    expect(wholeLedger(bundle.db)).toEqual(before);
    // the way the refusal names: October, then September, then August — and nothing is left
    unimportFile(bundle.db, fileId(bundle.db, OCTOBER_FILE));
    unimportFile(bundle.db, fileId(bundle.db, SEPTEMBER_FILE));
    unimportFile(bundle.db, fileId(bundle.db, AGENT_BUYS_FILE));
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
  });

  test("a re-read of September alone that no longer proves it is refused while October stands on its sale — the sold shares never come back", async () => {
    const { bookId } = await boughtSoldAndQuiet(bundle.db);
    const before = wholeLedger(bundle.db);

    const [reread] = await reReadAtNextVersion(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS_ALL_UNPROVEN])]);

    expect([reread!.status, reread!.error]).toEqual([
      "failed",
      `Robinhood Agentic Brokerage still holds this statement's shares under a later statement, and reading it again would take them away first — upload ${OCTOBER} with it to read them together`,
    ]);
    expect(wholeLedger(bundle.db)).toEqual(before);
    expect(stateOf(bundle.db, bookId).holdings.map((h) => h.quantityE8)).toEqual([0]);
  });

  test("October read as cash before August's buy was in the ledger: August's section is withheld, naming October — no share stands under a month that prints none", async () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const agenticId = ownersRobinhood(bundle.db);
    const [october] = await importStatementFiles(bundle.db, [pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_CASH_OCTOBER])]);
    expect([october!.status, october!.withheld]).toEqual(["parsed", []]);
    const brokerageBefore = stateOf(bundle.db, brokerageId(bundle.db)).periods;

    const [august] = await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);

    expect([august!.status, august!.withheld.map((w) => w.reason)]).toEqual([
      "parsed",
      [`the ledger read a later statement of this account, ${OCTOBER}, as cash only before these shares were in it, and they would stand under it unchecked`],
    ]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(stateOf(bundle.db, agenticId).periods.map((p) => p.start)).toEqual(["2026-10-01"]);
    // the rest of the file is read: Robinhood Brokerage's August lands beside the withheld section
    expect(stateOf(bundle.db, brokerageId(bundle.db)).periods.map((p) => p.start)).toEqual([...brokerageBefore.map((p) => p.start), "2026-08-01"].sort());
  });

  test("the context names the cash account's months that stand on no book — and leaves out one the same upload reads again", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND])]);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const agentic = (rereading?: Set<string>) =>
      parseContextFor(bundle.db, rereading).knownAccounts.Robinhood?.find((a) => a.last4 === "9651");

    // June was read before any share; August is the book's, so it is not cash only
    expect(agentic()?.cashOnlyStatements).toEqual([{ fileName: JUNE_FILE, start: "2026-06-01", end: "2026-06-30" }]);
    expect(agentic(new Set([fileId(bundle.db, JUNE_FILE)]))?.cashOnlyStatements).toBeUndefined();
    // never an investment account's months, and never the book's own
    expect(parseContextFor(bundle.db).knownAccounts.Robinhood?.find((a) => a.last4 === "3525")?.cashOnlyStatements).toBeUndefined();
    expect(bookOf(bundle.db, agenticId)!.last4).toBeNull();
  });

  test("a month read out of order BEFORE the book's statement is proven as always — a book month is not one read as cash", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);

    const [june] = await importStatementFiles(bundle.db, [pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...AGENT_ROUND_TRIP])]);

    expect([june!.status, june!.withheld]).toEqual(["parsed", []]);
    expect(stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id).events.map((e) => [e.on, e.delta])).toEqual([
      ["2026-06-10", 10_000_000],
      ["2026-06-20", -10_000_000],
      ["2026-08-20", 25_000_000],
    ]);
  });

  test("the next parser version reads the three months together, oldest first — each proven, the book at $0.00, nothing withheld", async () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const agenticId = ownersRobinhood(bundle.db);
    const october = pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_CASH_OCTOBER]);
    const august = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    const september = pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS_ALL]);
    for (const file of [october, august, september]) await importStatementFiles(bundle.db, [file]);
    // each later arrival is withheld against the October read as cash before it
    expect(
      bundle.db
        .select()
        .from(importFiles)
        .all()
        .map((f) => [f.fileName, withheldSectionsOf(f).length])
        .sort(),
    ).toEqual([
      [OCTOBER_FILE, 0],
      [SEPTEMBER_FILE, 1],
      [AGENT_BUYS_FILE, 1],
    ].sort());

    // October's older read is read again AFTER August in the same upload, so it does not hold August back
    const outcomes = await reReadAtNextVersion(bundle.db, [october, september, august]);

    expect(outcomes.map((o) => [o.fileName, o.status, o.error, o.withheld])).toEqual([
      [AGENT_BUYS_FILE, "parsed", undefined, []],
      [SEPTEMBER_FILE, "parsed", undefined, []],
      [OCTOBER_FILE, "parsed", undefined, []],
    ]);
    const book = stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id);
    expect(book.periods.map((p) => [p.start, p.begin, p.endCents])).toEqual([
      ["2026-08-01", 0, 2622],
      ["2026-09-01", 2622, 0],
      ["2026-10-01", 0, 0],
    ]);
    expect(book.holdings.map((h) => [h.symbol, h.quantityE8, h.isActive])).toEqual([["WMT", 0, false]]);
    expect(stateOf(bundle.db, agenticId).periods.map((p) => [p.start, p.begin, p.endCents, p.reconciliation])).toEqual([
      ["2026-08-01", 2664, 164, "reconciled"],
      ["2026-09-01", 164, 2895, "reconciled"],
      ["2026-10-01", 2895, 2895, "reconciled"],
    ]);
  });

  /**
   * ⛔ August is proven under October only because the same upload reads October again — so the two are one read.
   * 🔴 Before, a version that could not read October kept its cash-only read, and August's shares were already written
   * under it: measured 2026-09-16 on the branch fixture, the book at $27.73 beside Agentic's $28.95 — $56.68 where the
   * agent sold everything and holds $28.95.
   */
  test("a re-read of October and August that cannot parse October writes no August shares under October's cash-only read — nothing changes", async () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const agenticId = ownersRobinhood(bundle.db);
    const october = pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_CASH_OCTOBER]);
    const august = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    for (const file of [october, august, pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS_ALL])]) await importStatementFiles(bundle.db, [file]);
    const inPlace = filesInPlace(bundle.db);
    const before = ledgerBesideFiles(bundle.db);

    const outcomes = await withParseFailing(OCTOBER_FILE, "this version cannot read October", () => reReadAtNextVersion(bundle.db, [october, august]));

    expect(outcomes.map((o) => [o.fileName, o.status, o.error])).toEqual([
      [AGENT_BUYS_FILE, "failed", `${OCTOBER_FILE} failed, and this statement is read again only together with it (${EARLIER_READ_KEPT})`],
      [OCTOBER_FILE, "failed", `Unexpected: Error: this version cannot read October (${EARLIER_READ_KEPT})`],
    ]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(ledgerBesideFiles(bundle.db)).toEqual(before);
    expect(filesInPlace(bundle.db)).toEqual(inPlace);
  });

  test("a fresh August uploaded with an October re-read that cannot parse is not written under October's cash-only read — and can be uploaded again", async () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const agenticId = ownersRobinhood(bundle.db);
    const october = pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_CASH_OCTOBER]);
    const august = pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]);
    await importStatementFiles(bundle.db, [october]);
    const inPlace = filesInPlace(bundle.db);
    const before = ledgerBesideFiles(bundle.db);

    const outcomes = await withParseFailing(OCTOBER_FILE, "this version cannot read October", () => reReadAtNextVersion(bundle.db, [october, august]));

    expect(outcomes.map((o) => [o.fileName, o.status, o.error])).toEqual([
      [AGENT_BUYS_FILE, "failed", `${OCTOBER_FILE} failed, and this statement is read only together with it (nothing was written)`],
      [OCTOBER_FILE, "failed", `Unexpected: Error: this version cannot read October (${EARLIER_READ_KEPT})`],
    ]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(ledgerBesideFiles(bundle.db)).toEqual(before);
    expect(filesInPlace(bundle.db)).toEqual(inPlace);

    // a failed read is read again: August on its own is withheld under the October still read as cash
    const [alone] = await reReadAtNextVersion(bundle.db, [august]);
    expect([alone!.status, alone!.withheld.map((w) => w.periodStart)]).toEqual(["parsed", ["2026-08-01"]]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
  });

  test("fresh August and September uploaded with October's re-read are each proven — the upload reads October after them", async () => {
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const agenticId = ownersRobinhood(bundle.db);
    const october = pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_CASH_OCTOBER]);
    await importStatementFiles(bundle.db, [october]);

    const outcomes = await reReadAtNextVersion(bundle.db, [
      october,
      pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS_ALL]),
      pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE]),
    ]);

    expect(outcomes.map((o) => [o.fileName, o.status, o.error, o.withheld])).toEqual([
      [AGENT_BUYS_FILE, "parsed", undefined, []],
      [SEPTEMBER_FILE, "parsed", undefined, []],
      [OCTOBER_FILE, "parsed", undefined, []],
    ]);
    const book = stateOf(bundle.db, bookOf(bundle.db, agenticId)!.id);
    expect(book.periods.map((p) => [p.start, p.begin, p.endCents])).toEqual([
      ["2026-08-01", 0, 2622],
      ["2026-09-01", 2622, 0],
      ["2026-10-01", 0, 0],
    ]);
    expect(book.holdings.map((h) => [h.symbol, h.quantityE8])).toEqual([["WMT", 0]]);
  });
});

/**
 * A statement downloaded twice is imported twice: the second copy adopts the first copy's period and takes over the
 * balances it prints (`upsertAnchor`), and a second copy of a month with trades is withheld (`provePositions`).
 */
describe("⛔ a book month downloaded twice — un-importing one copy leaves the month with the other", () => {
  const fileId = (db: AppDatabase, name: string) => db.select().from(importFiles).where(eq(importFiles.fileName, name)).get()!.id;

  /**
   * 🔴 The book's month was known only by its period, and the first copy owned it. Un-importing that copy took the
   * period away while the second copy stayed imported, printing the month: measured 2026-09-16 on a real-ledger copy,
   * un-importing October was then not refused, the sold shares came back ($27.37 on Oct 31 where $16.42 is true), and
   * `pnpm ledger-check` exited 1 on Agentic's Sep 30 → Oct 31.
   */
  test("October downloaded twice: un-importing the first copy hands the month to the second — and September under it is still refused", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    await importStatementFiles(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...agentSells(false)])]);
    process.env.MONEYAPP_FAKE_TODAY = "2026-11-05";
    const COPY = "0c6a9e57-1d2b-4f83-a7c4-5e9b0d1f2a63 (1).pdf";
    const [first] = await importStatementFiles(bundle.db, [pdf(OCTOBER_FILE, [...OCTOBER_BROKERAGE, ...AGENT_HOLDS_OCTOBER])]);
    const [second] = await importStatementFiles(bundle.db, [pdf(COPY, [...OCTOBER_BROKERAGE, ...AGENT_HOLDS_OCTOBER])]);
    expect([first!.withheld, second!.status, second!.withheld]).toEqual([[], "parsed", []]);
    const bookId = bookOf(bundle.db, agenticId)!.id;
    const before = { book: stateOf(bundle.db, bookId), agentic: stateOf(bundle.db, agenticId) };

    unimportFile(bundle.db, fileId(bundle.db, OCTOBER_FILE));

    // the copy prints October: the month is its now, on the book and on Agentic, and nothing else moved
    expect(stateOf(bundle.db, bookId)).toEqual(before.book);
    expect(stateOf(bundle.db, agenticId)).toEqual(before.agentic);
    const owners = bundle.db
      .select({ file: importFiles.fileName })
      .from(statementPeriods)
      .innerJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
      .where(eq(statementPeriods.periodStart, "2026-10-01"))
      .all();
    // Robinhood Brokerage's, Robinhood Cash's, Agentic's and the book's
    expect(owners.map((o) => o.file)).toEqual([COPY, COPY, COPY, COPY]);
    const ledger = wholeLedger(bundle.db);

    expect(() => unimportFile(bundle.db, fileId(bundle.db, SEPTEMBER_FILE))).toThrow(
      `Robinhood Agentic Brokerage still holds this statement's shares under a later statement — un-import ${COPY} (Oct 1 – 31, 2026) before it`,
    );
    expect(wholeLedger(bundle.db)).toEqual(ledger);
  });

  /**
   * 🔴 The second copy of a month with trades withholds the agent's section because the first copy holds its trades.
   * Un-importing the first copy was allowed, and the month was then read by neither: measured 2026-09-16, no book and no
   * August on Agentic, the copy still `parsed` with a reason that was no longer true, and uploading it again skipped as
   * a duplicate.
   */
  test("August downloaded twice: the copy is withheld, and un-importing the first copy is refused while the copy stands — nothing changes", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const COPY = "d41f0c83-5a7e-4b2c-9e61-3f8a2b7c9d10 (1).pdf";
    const [copy] = await importStatementFiles(bundle.db, [pdf(COPY, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    expect([copy!.status, copy!.withheld.map((w) => w.reason)]).toEqual([
      "parsed",
      ["the ledger already holds this account's trades for Aug 1 – 31, 2026 from another statement, and a second copy would count its shares twice"],
    ]);
    const before = wholeLedger(bundle.db);

    expect(() => unimportFile(bundle.db, fileId(bundle.db, AGENT_BUYS_FILE))).toThrow(
      `${COPY} (Aug 1 – 31, 2026) left out Robinhood Agentic's section of the month this statement reads — un-import ${COPY} before it, or neither reads the month`,
    );
    expect(wholeLedger(bundle.db)).toEqual(before);

    // the way the refusal names: the copy, then the month — and nothing is left
    unimportFile(bundle.db, fileId(bundle.db, COPY));
    unimportFile(bundle.db, fileId(bundle.db, AGENT_BUYS_FILE));
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
  });

  test("a later month of the account withheld for its own reason does not hold the month — only one of the same window does", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const unproven = agentSells(false).map((l) => (l.text.startsWith("Total Funds Paid and Received") ? totalFunds("$0.00", "$11.07") : l));
    const [september] = await importStatementFiles(bundle.db, [pdf(SEPTEMBER_FILE, [...SEPTEMBER_BROKERAGE, ...unproven])]);
    expect(september!.withheld.map((w) => [w.accountId, w.periodStart])).toEqual([[agenticId, "2026-09-01"]]);

    unimportFile(bundle.db, fileId(bundle.db, AGENT_BUYS_FILE));

    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
  });
});

describe("writeStatementPositions — the positions are asked of the rows actually committed", () => {
  test("⛔ a book whose committed events do not make the printed positions throws, and the transaction rolls back", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const book = bookOf(bundle.db, agenticId)!;
    const file = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, AGENT_BUYS_FILE)).get()!;
    const before = stateOf(bundle.db, book.id);

    // September's sale, against a printed position its events cannot make (0.2 where they make 0.15)
    const positions = {
      trades: [
        { symbol: "WMT", assetType: "stock" as const, occurredOn: "2026-09-15", tradedOn: "2026-09-15", quantityDeltaE8: -10_000_000, costCents: null, printed: "WMT Cash Sell" },
      ],
      held: [{ symbol: "WMT", assetType: "stock" as const, quantityE8: 20_000_000, marketValueCents: 2218 }],
    };
    expect(() => bundle.db.transaction((tx) => writeStatementPositions(tx, book.id, file.id, positions, "2026-09-30"))).toThrow(
      /the book's WMT through 2026-09-30 is 15000000e-8 after writing, the statement prints 20000000e-8/,
    );
    expect(stateOf(bundle.db, book.id)).toEqual(before);
    // …and positions never go to an account that is not a book
    expect(() => bundle.db.transaction((tx) => writeStatementPositions(tx, agenticId, file.id, positions, "2026-09-30"))).toThrow(/is not one/);
  });
});

describe("⛔ the agent's book holds only what its statements prove", () => {
  /**
   * 🔴 The Add-holding form refused the book, and the account page's "Record a balance" did not: the typed value had
   * no effect while statements valued the book, then kept the book alive after the last one was un-imported, with the
   * typed figure in net worth (measured 2026-09-16 on a real-ledger copy: +$500.00).
   */
  test("a hand-typed balance on the book is refused — his own investment account still takes one", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    await importStatementFiles(bundle.db, [pdf(AGENT_BUYS_FILE, [...AGENT_BUYS, ...AUGUST_BROKERAGE])]);
    const book = bookOf(bundle.db, agenticId)!;
    const before = wholeLedger(bundle.db);

    expect(() => addManualAnchor(bundle.db, { accountId: book.id, anchoredOn: "2026-09-14", enteredCents: 50_000 })).toThrow(
      "Robinhood Agentic Brokerage holds only what its statements prove — a balance typed here would outlive them",
    );
    expect(wholeLedger(bundle.db)).toEqual(before);

    const brokerage = bundle.db.select().from(accounts).where(eq(accounts.name, "Robinhood Brokerage")).get()!;
    addManualAnchor(bundle.db, { accountId: brokerage.id, anchoredOn: "2026-09-14", enteredCents: 50_000 });
    expect(
      bundle.db.select().from(balanceAnchors).where(and(eq(balanceAnchors.accountId, brokerage.id), eq(balanceAnchors.source, "manual"))).all(),
    ).toHaveLength(1);
  });

  /**
   * ⚠️ A backstop no statement reaches today: a book's events filed under a file with no period and no balance on the
   * book. Retiring or un-importing that file still restates the book and takes it away once it holds nothing.
   */
  async function bookEventUnderJune(db: AppDatabase) {
    const agenticId = ownersRobinhood(db);
    const june = pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND]);
    await importStatementFiles(db, [june]);
    const juneId = db.select().from(importFiles).where(eq(importFiles.fileName, JUNE_FILE)).get()!.id;
    const robinhood = db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const bookId = resolveBook(db, robinhood.id, "9651");
    db.insert(holdingEvents)
      .values({ accountId: bookId, symbol: "WMT", assetType: "stock", occurredOn: "2026-06-10", quantityDeltaE8: 10_000_000, costCents: 1000, eventKind: "trade", importFileId: juneId })
      .run();
    syncBookHoldings(db, bookId);
    await refresh(db);
    expect(liveAnchors(db, bookId)).toHaveLength(1);
    return { agenticId, bookId, june, juneId };
  }

  test("un-importing a file whose only mark on the book is its events takes the book away", async () => {
    const { agenticId, bookId, juneId } = await bookEventUnderJune(bundle.db);

    unimportFile(bundle.db, juneId);

    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(bundle.db.select().from(holdings).where(eq(holdings.accountId, bookId)).all()).toEqual([]);
    expect(bundle.db.select().from(dailyBalances).where(eq(dailyBalances.accountId, bookId)).all()).toEqual([]);
  });

  test("a re-read of a file whose only mark on the book is its events takes the book away", async () => {
    const { agenticId, bookId, june } = await bookEventUnderJune(bundle.db);

    const [reread] = await reReadAtNextVersion(bundle.db, [june]);

    expect([reread!.status, reread!.withheld]).toEqual(["parsed", []]);
    expect(bookOf(bundle.db, agenticId)).toBeUndefined();
    expect(bundle.db.select().from(dailyBalances).where(eq(dailyBalances.accountId, bookId)).all()).toEqual([]);
  });
});

/**
 * ⚖️ Money moving to Robinhood Agentic is an external flow out of his investments (lib/account-side), so the detector
 * files the pair as an Investment Contribution. 🔴 A parser-version re-read carried the link onto the fresh row and not
 * the category the detector gave with it, and the detector never looks at a linked row again: the merchant map filed
 * the fresh leg as an Internal Transfer, and /summary's 2026 money-weighted return dropped the $26.64 flow (measured
 * 2026-09-16 on a real-ledger copy re-read at v5: 33.87% → 33.81%).
 */
describe("⛔ a re-read keeps an auto-detected transfer's category with its link", () => {
  test("the $26.64 to Agentic stays an Investment Contribution on both legs after a version bump", async () => {
    const agenticId = ownersRobinhood(bundle.db);
    const cash = bundle.db.select().from(accounts).where(eq(accounts.name, "Robinhood Cash")).get()!;
    bundle.db
      .insert(transactions)
      .values({
        accountId: cash.id,
        postedOn: "2026-06-05",
        amountCents: -2664,
        rawDescription: "Transfer to Brokerage",
        normalizedDescription: "transfer to brokerage",
        dedupeHash: "hand:robinhood-cash:2026-06-05:-2664",
      })
      .run();
    const june = pdf(JUNE_FILE, [...JUNE_BROKERAGE, ...JUNE_SECOND]);
    await importStatementFiles(bundle.db, [june]);
    const legs = () =>
      bundle.db
        .select({
          account: transactions.accountId,
          cents: transactions.amountCents,
          group: transactions.transferGroupId,
          category: categories.name,
          source: transactions.categorizationSource,
        })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(and(eq(transactions.postedOn, "2026-06-05"), ne(transactions.status, "superseded")))
        .orderBy(asc(transactions.amountCents))
        .all();
    const detected = legs();
    expect(detected.map((l) => [l.account, l.cents, l.category, l.source])).toEqual([
      [cash.id, -2664, "Investment Contribution", "transfer_detect"],
      [agenticId, 2664, "Investment Contribution", "transfer_detect"],
    ]);
    expect(detected[0]!.group).not.toBeNull();
    expect(detected[1]!.group).toBe(detected[0]!.group);

    await reReadAtNextVersion(bundle.db, [june]);

    expect(legs()).toEqual(detected);
  });
});
