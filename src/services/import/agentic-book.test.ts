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
import { accountLiquidity, createAccount } from "@/services/accounts";
import { upsertHolding } from "@/services/holdings";
import { portfolioSeries } from "@/services/portfolio";
import { writeStatementPositions } from "./brokerage-book";
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

const { DOCUMENTS } = vi.hoisted(() => ({ DOCUMENTS: new Map<string, Line[]>() }));

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

    const profile = PROFILES.find((p) => p.id === "robinhood-brokerage-statement-pdf")!;
    const { version } = profile;
    profile.version = version + 1;
    let outcomes;
    try {
      outcomes = await importStatementFiles(bundle.db, [august, september]);
    } finally {
      profile.version = version;
    }

    expect(outcomes.map((o) => [o.status, o.withheld])).toEqual([
      ["parsed", []],
      ["parsed", []],
    ]);
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
