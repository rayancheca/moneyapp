import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { dailyBalances } from "@/db/schema/balances";
import { holdings, priceCache, type AssetType } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { subtotalHoldings } from "@/lib/holding-subtotal";
import { createAccount } from "./accounts";
import { concentrationCard, type ConcentrationCard } from "./concentration-card";
import { holdingRows, type HoldingRow } from "./portfolio";
import { rebuildInvestmentHistory } from "./crypto-history";
import { upsertHolding } from "./holdings";

process.env.MONEYAPP_FAKE_PRICES = "1";

/**
 * The card exists to answer one question — how much of everything he owns rides
 * on one thing — so the tests that matter are the ones about which positions
 * are allowed to BE that thing, and about every denominator that could be zero.
 *
 * The fixture's quantities and prices are deliberately not round multiples of
 * each other: a mutation that reads a quantity where it should read a value, or
 * a price where it should read a share, has to change a number rather than land
 * on the same one by symmetry.
 */

const TODAY = "2026-08-26";
/** the day the positions open — history is rebuilt from here to TODAY */
const OPENED = "2026-08-20";

let dir: string;
let bundle: DbBundle;
let brokerage: string;
let crypto: string;
let checking: string;
let card: string;

/**
 * ETH $5,000.00 · SPY $2,000.00 · AAPL $1,234.50 · MSFT $900.00 = $9,134.50.
 *
 * 🔴 SPY is the SECOND biggest position and the largest thing that is not one
 * company — which is the whole point of the fixture. Ranked by value alone the
 * runner-up is SPY; ranked as a risk it is AAPL.
 */
const ETH_CENTS = 500_000;
const SPY_CENTS = 200_000;
const AAPL_CENTS = 123_450;
const MSFT_CENTS = 90_000;
const PORTFOLIO_CENTS = ETH_CENTS + SPY_CENTS + AAPL_CENTS + MSFT_CENTS;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-concentration-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  brokerage = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Robinhood Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  crypto = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Robinhood Crypto",
    type: "investment",
    subtype: "crypto",
  });
  checking = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Robinhood Cash",
    type: "checking",
  });
  card = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "A Credit Card",
    type: "credit",
  });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function cache(symbol: string, assetType: AssetType, close: number, day: string = TODAY): void {
  bundle.db
    .insert(priceCache)
    .values({
      symbol,
      assetType,
      quotedOn: day,
      close,
      source: assetType === "crypto" ? "coinbase" : "yahoo",
      fetchedAt: `${day}T20:00:00.000Z`,
    })
    .run();
}

function hold(accountId: string, symbol: string, assetType: AssetType, quantityE8: number): void {
  upsertHolding(bundle.db, { accountId, symbol, assetType, quantityE8, occurredOn: OPENED });
}

/** A plain balance on a non-investment account, so net worth has a cash side. */
function balance(accountId: string, balanceCents: number, day: string = TODAY): void {
  bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents, basis: "carried" }).run();
}

/** The four positions above, priced as of `priceDay`, with history rebuilt. */
function seedBook(priceDay: string = TODAY): void {
  cache("ETH", "crypto", 2_000, priceDay);
  cache("SPY", "etf", 500, priceDay);
  cache("AAPL", "stock", 123.45, priceDay);
  cache("MSFT", "stock", 300, priceDay);

  hold(crypto, "ETH", "crypto", 250_000_000); // 2.5 × $2,000
  hold(brokerage, "SPY", "etf", 400_000_000); // 4 × $500
  hold(brokerage, "AAPL", "stock", 1_000_000_000); // 10 × $123.45
  hold(brokerage, "MSFT", "stock", 300_000_000); // 3 × $300

  rebuildInvestmentHistory(bundle.db, brokerage, TODAY);
  rebuildInvestmentHistory(bundle.db, crypto, TODAY);
}

describe("concentrationCard — what the portfolio is riding on", () => {
  test("ranks by symbol, sums to the portfolio, and relates it to net worth", () => {
    seedBook();
    balance(checking, 86_550); // net worth lands on exactly $10,000.00

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.portfolioCents).toBe(PORTFOLIO_CENTS);
    expect(c.netWorthCents).toBe(1_000_000);
    expect(c.positions.map((p) => p.symbol)).toEqual(["ETH", "SPY", "AAPL", "MSFT"]);
    expect(c.positions.map((p) => p.valueCents)).toEqual([
      ETH_CENTS,
      SPY_CENTS,
      AAPL_CENTS,
      MSFT_CENTS,
    ]);
    // the shares are allocationSlices' own, so they must be the real ratios
    expect(c.positions[0]!.portfolioPct).toBeCloseTo((ETH_CENTS / PORTFOLIO_CENTS) * 100, 6);
    expect(c.positions[0]!.netWorthPct).toBeCloseTo(50, 6);
    expect(c.portfolioSharePct).toBeCloseTo(91.345, 6);
    expect(c.restOfNetWorthCents).toBe(86_550);
    expect(c.topOverRest).toBeCloseTo(ETH_CENTS / 86_550, 6);
    /*
     * The headline is the NET WORTH share, not the portfolio share, because the
     * question the card answers is about everything he owns. The two are 50.0%
     * and 54.7% here, so a headline that quietly used the wrong denominator
     * would still look plausible.
     *
     * ⛔ …and it NAMES that denominator. It said "of everything you own", which
     * is assets — this figure is struck against net worth, assets minus debts.
     * On the owner's ledger 2026-09-04 those are $114,498.97 and $113,656.08,
     * so the sentence claimed 32.2% of a number 0.7% larger than the one it had
     * divided by. The card's own rest-note already carried "debts already netted
     * off"; the two sentences above it did not.
     */
    expect(c.headline).toBe("50.0%");
    expect(c.headlineNoun).toBe("of your net worth is ETH");
    expect(c.summary).toContain("91.3% of your net worth");
    expect(c.summary).toContain("with your debts netted off");
    expect(c.headlineNoun).not.toContain("everything you own");
    expect(c.summary).not.toContain("everything you own");
    expect(c.restNote).not.toContain("Everything else you own");
  });

  /**
   * 🔴 THE judgement. SPY is worth more than AAPL and more than MSFT, so any
   * ranking by value alone makes it the runner-up. It is one ticker holding
   * hundreds of companies, and the only event that takes it down is the market
   * itself — which takes every other row down with it. Ranking it beside a
   * single stock would inflate the very figure this card publishes.
   */
  test("a fund is never the top position, and never the runner-up either", () => {
    seedBook();
    balance(checking, 86_550);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.top!.symbol).toBe("ETH");
    expect(c.top!.isSingleName).toBe(true);
    // AAPL, not SPY — even though SPY is the bigger holding
    expect(c.topTwo!.symbols).toEqual(["ETH", "AAPL"]);
    expect(c.topTwo!.valueCents).toBe(ETH_CENTS + AAPL_CENTS);
  });

  test("the fund is still counted, still shown, and says what it is", () => {
    seedBook();
    balance(checking, 86_550);

    const c = concentrationCard(bundle.db, TODAY)!;
    const spy = c.positions.find((p) => p.symbol === "SPY")!;
    expect(spy.isSingleName).toBe(false);
    expect(spy.spreadNote).not.toBeNull();
    // counted: the column still adds up to the portfolio printed beside it
    expect(c.positions.reduce((s, p) => s + p.valueCents, 0)).toBe(PORTFOLIO_CENTS);
    expect(c.fundNote).toContain("SPY");
    expect(c.fundNote).toContain("not a company");
  });

  test("a fund is the LARGEST position and still does not become the headline", () => {
    cache("SPY", "etf", 500);
    cache("AAPL", "stock", 100);
    hold(brokerage, "SPY", "etf", 2_000_000_000); // $10,000
    hold(brokerage, "AAPL", "stock", 100_000_000); // $100
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.positions[0]!.symbol).toBe("SPY"); // biggest holding, honestly listed first
    expect(c.top!.symbol).toBe("AAPL"); // …and not what the card says he rides on
    expect(c.headlineNoun).toContain("AAPL");
  });

  test("a portfolio of nothing but funds says so instead of naming a top position", () => {
    cache("SPY", "etf", 500);
    hold(brokerage, "SPY", "etf", 400_000_000);
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.top).toBeNull();
    expect(c.topTwo).toBeNull();
    expect(c.topOverRest).toBeNull();
    expect(c.headline).toBe("Nothing");
    expect(c.summary).toContain("fund");
  });

  test("crypto counts as one thing that can go wrong", () => {
    seedBook();
    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.positions.find((p) => p.symbol === "ETH")!.isSingleName).toBe(true);
  });

  test("groups by asset class, and the classes add back up to the portfolio", () => {
    seedBook();
    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.byKind.map((k) => [k.assetType, k.valueCents])).toEqual([
      ["crypto", ETH_CENTS],
      ["stock", AAPL_CENTS + MSFT_CENTS],
      ["etf", SPY_CENTS],
    ]);
    expect(c.byKind.find((k) => k.assetType === "etf")!.isSingleName).toBe(false);
    expect(c.byKind.reduce((s, k) => s + k.valueCents, 0)).toBe(PORTFOLIO_CENTS);
    expect(c.byKind.reduce((s, k) => s + k.portfolioPct, 0)).toBeCloseTo(100, 6);
  });

  /**
   * The subtotals a reader can check by adding the rows above them must equal
   * the sum of exactly those rows — not an independent division that lands a
   * tenth of a point away from it.
   */
  test("every subtotal is the sum of the shares printed above it", () => {
    seedBook();
    const c = concentrationCard(bundle.db, TODAY)!;
    const eth = c.positions.find((p) => p.symbol === "ETH")!;
    const aapl = c.positions.find((p) => p.symbol === "AAPL")!;
    expect(c.topTwo!.portfolioPct).toBe(eth.portfolioPct + aapl.portfolioPct);
    expect(c.byKind.find((k) => k.assetType === "stock")!.portfolioPct).toBe(
      aapl.portfolioPct + c.positions.find((p) => p.symbol === "MSFT")!.portfolioPct,
    );
  });

  /**
   * 🔴 S28. The test above compares FLOATS, and a float sum always equals the
   * same float sum — it cannot fail. What a reader adds is the tenths printed on
   * the rows, and the card printed round(Σ) beside Σ round. Measured on the
   * owner's ledger 2026-09-15: "Individual stocks 51.5%" under the stock rows
   * MSFT 18.2% · AMZN 8.2% · UNH 6.8% · 5 smaller positions 18.4%, which add to
   * 51.6. This fixture showed it all along: ETH 54.7% and AAPL 13.5% add to
   * 68.2, and the top-two sentence read 68.3%.
   *
   * ⚖️ Owner decision 2026-09-14 (F2): a subtotal is the SUM of the rounded
   * rows printed beside it — no apportionment, so no holding's share moves.
   */
  test("the top two's printed share is the sum of the two rows' printed shares", () => {
    seedBook();
    const c = concentrationCard(bundle.db, TODAY)!;
    const printed = (symbol: string): string => c.positions.find((p) => p.symbol === symbol)!.shareLabel;

    expect(printed("ETH")).toBe("54.7%");
    expect(printed("AAPL")).toBe("13.5%");
    expect(c.topTwo!.shareLabel).toBe("68.2%");
    expect(c.topTwoNote).toContain("together are 68.2% of the portfolio");
    // the sentence under the headline reads the row's own label, not a third rounding
    expect(c.summary).toContain("— 54.7% of it —");
  });

  test("an asset class's printed share is the sum of its printed rows", () => {
    // $4,992 · $3,004 · $2,004 = $10,000.00 — each share ends in .x2 or .x4, so every row rounds down
    cache("ETH", "crypto", 1_248);
    cache("MSFT", "stock", 751);
    cache("AAPL", "stock", 501);
    hold(crypto, "ETH", "crypto", 400_000_000);
    hold(brokerage, "MSFT", "stock", 400_000_000);
    hold(brokerage, "AAPL", "stock", 400_000_000);
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);
    rebuildInvestmentHistory(bundle.db, crypto, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.portfolioCents).toBe(1_000_000);
    expect(c.positions.map((p) => [p.symbol, p.shareLabel])).toEqual([
      ["ETH", "49.9%"],
      ["MSFT", "30.0%"],
      ["AAPL", "20.0%"],
    ]);
    const kind = (t: AssetType): string => c.byKind.find((k) => k.assetType === t)!.shareLabel;
    expect(kind("stock")).toBe("50.0%"); // round(50.08) printed 50.1% over rows adding to 50.0
    expect(kind("crypto")).toBe("49.9%"); // a class of one is its row
    expect(c.topTwo!.shareLabel).toBe("79.9%"); // round(79.96) printed 80.0%
    expect(c.topTwoNote).toContain("together are 79.9%");
  });

  /** ETH $4,000 · SPY $2,000 · AAPL $1,504 · MSFT $1,204 · NVDA $904 · GOOG $204 · a sixth at $184 */
  function seedTail(sixth: { symbol: string; assetType: AssetType }): void {
    const book: [string, AssetType, number, string][] = [
      ["ETH", "crypto", 4_000, crypto],
      ["SPY", "etf", 2_000, brokerage],
      ["AAPL", "stock", 1_504, brokerage],
      ["MSFT", "stock", 1_204, brokerage],
      ["NVDA", "stock", 904, brokerage],
      ["GOOG", "stock", 204, brokerage],
      [sixth.symbol, sixth.assetType, 184, brokerage],
    ];
    for (const [symbol, assetType, close, account] of book) {
      cache(symbol, assetType, close);
      hold(account, symbol, assetType, 100_000_000);
    }
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);
    rebuildInvestmentHistory(bundle.db, crypto, TODAY);
  }

  test("a remainder wholly of one class adds into that class as the line it prints", () => {
    seedTail({ symbol: "META", assetType: "stock" });

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.positions.map((p) => [p.symbol, p.shareLabel])).toEqual([
      ["ETH", "40.0%"],
      ["SPY", "20.0%"],
      ["AAPL", "15.0%"],
      ["MSFT", "12.0%"],
      ["NVDA", "9.0%"],
    ]);
    expect(c.remainder!.count).toBe(2);
    // GOOG 2.04% and META 1.84% print 2.0% and 1.8% on /investments — where round(3.88) printed 3.9%
    expect(c.remainder!.shareLabel).toBe("3.8%");
    const kind = (t: AssetType): string => c.byKind.find((k) => k.assetType === t)!.shareLabel;
    // 15.0 + 12.0 + 9.0 + 3.8, the lines above — where round(40.00) printed 40.0%
    expect(kind("stock")).toBe("39.8%");
    expect(kind("crypto")).toBe("40.0%");
    expect(kind("etf")).toBe("20.0%");
    // the fund sentence quotes the Funds line, not a fourth author
    expect(c.fundNote).toContain("$2,000.00, 20.0% of the portfolio");
  });

  test("a remainder that mixes classes still adds each class from its holdings as they print", () => {
    seedTail({ symbol: "VOO", assetType: "etf" });

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.remainder!.shareLabel).toBe("3.8%"); // GOOG 2.0 + VOO 1.8
    const kind = (t: AssetType): string => c.byKind.find((k) => k.assetType === t)!.shareLabel;
    // the card cannot split "2 smaller positions" by class, but /investments prints every
    // holding inside it — each class is the sum of its holdings' printed shares, never round(Σ)
    expect(kind("stock")).toBe("38.0%"); // 15.0 + 12.0 + 9.0 + 2.0, where round(38.16) printed 38.2%
    expect(kind("etf")).toBe("21.8%"); // 20.0 + 1.8
    expect(kind("crypto")).toBe("40.0%");
    expect(c.fundNote).toContain("$2,184.00, 21.8% of the portfolio");
  });

  /**
   * Every share on the card that stands for holdings, beside the Share
   * /investments prints for ticking exactly those holdings — compared as the
   * strings a reader sees.
   */
  function tickBarDisagreements(c: ConcentrationCard): { compared: number; mismatches: string[] } {
    const legs = holdingRows(bundle.db).filter((r) => r.allocationPct !== null);
    const tick = (keep: (r: HoldingRow) => boolean): string | null =>
      subtotalHoldings(legs.filter(keep)).allocationShare;
    const keyOf = (x: { assetType: AssetType; symbol: string }): string => `${x.assetType}|${x.symbol}`;
    const named = new Set(c.positions.map(keyOf));
    const figures: [string, string, string | null][] = [
      ...c.positions.map((p): [string, string, string | null] => [p.symbol, p.shareLabel, tick((r) => keyOf(r) === keyOf(p))]),
      ...c.byKind.map((k): [string, string, string | null] => [k.label, k.shareLabel, tick((r) => r.assetType === k.assetType)]),
    ];
    if (c.remainder) figures.push(["remainder", c.remainder.shareLabel, tick((r) => !named.has(keyOf(r)))]);
    if (c.topTwo) figures.push(["top two", c.topTwo.shareLabel, tick((r) => c.topTwo!.symbols.includes(r.symbol))]);
    return {
      compared: figures.length,
      mismatches: figures.filter(([, card, bar]) => card !== bar).map(([name, card, bar]) => `${name}: card ${card}, tick ${bar}`),
    };
  }

  /**
   * 🔴 One set of holdings, two pages, two shares. The remainder printed its own
   * sum rounded once, so on the owner's ledger 2026-09-15 the dashboard read
   * "5 smaller positions 18.4%" and "Individual stocks 51.6%" while ticking
   * exactly those holdings on /investments read "Share 18.3%" and "Share 51.5%"
   * (second reader on uc/shares-rounding). F2 keeps every holding's share
   * identical everywhere; a figure MADE of those shares has to be as well, or
   * the decision holds for the rows and breaks for their sums.
   */
  test.each([
    ["wholly of one class", { symbol: "META", assetType: "stock" as AssetType }],
    ["mixing classes", { symbol: "VOO", assetType: "etf" as AssetType }],
  ])("every share on the card is the Share /investments prints for the same holdings — a remainder %s", (_, sixth) => {
    seedTail(sixth);
    const { compared, mismatches } = tickBarDisagreements(concentrationCard(bundle.db, TODAY)!);
    expect(mismatches).toEqual([]);
    // five named rows, three classes, the remainder and the top two
    expect(compared).toBe(10);
  });

  test("a subtotal of slivers is a sliver, never a printed zero — and a near-whole never the whole", () => {
    cache("SPY", "etf", 9_996);
    cache("AAPL", "stock", 21);
    cache("MSFT", "stock", 19);
    hold(brokerage, "SPY", "etf", 1_000_000_000); // $99,960
    hold(brokerage, "AAPL", "stock", 100_000_000); // $21
    hold(brokerage, "MSFT", "stock", 100_000_000); // $19
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.positions.map((p) => [p.symbol, p.shareLabel])).toEqual([
      ["SPY", ">99.9%"],
      ["AAPL", "<0.1%"],
      ["MSFT", "<0.1%"],
    ]);
    expect(c.topTwo!.shareLabel).toBe("<0.1%");
    const kind = (t: AssetType): string => c.byKind.find((k) => k.assetType === t)!.shareLabel;
    expect(kind("stock")).toBe("<0.1%");
    expect(kind("etf")).toBe(">99.9%");
    // toFixed printed "100.0%" of a fund that is not the whole portfolio
    expect(c.fundNote).toContain(">99.9% of the portfolio");
    expect(c.summary).toContain("— <0.1% of it —");
  });

  /** Two accounts holding one ticker are one position — allocationSlices' rule. */
  test("a symbol held in two accounts is one position, not two rows", () => {
    cache("ETH", "crypto", 2_000);
    hold(crypto, "ETH", "crypto", 250_000_000);
    hold(brokerage, "ETH", "crypto", 50_000_000); // a second leg, same ticker
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);
    rebuildInvestmentHistory(bundle.db, crypto, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.positions.map((p) => p.symbol)).toEqual(["ETH"]);
    expect(c.positions[0]!.valueCents).toBe(600_000); // 3.0 ETH, not 2.5 and 0.5
  });

  /* ── the null paths ────────────────────────────────────────────────────── */

  test("no active holdings returns null rather than a card of zeroes", () => {
    balance(checking, 500_000);
    expect(concentrationCard(bundle.db, TODAY)).toBeNull();
  });

  test("a position with a quantity of zero is not a holding", () => {
    cache("AAPL", "stock", 100);
    hold(brokerage, "AAPL", "stock", 0);
    expect(concentrationCard(bundle.db, TODAY)).toBeNull();
  });

  /**
   * ⛔ Every percentage on this card divides by the portfolio total. Holdings
   * nothing can price make that total zero, and a card of `0.0%` rows beside a
   * holdings table showing real positions is worse than no card at all.
   */
  test("holdings with no price at all return null instead of dividing by zero", () => {
    hold(brokerage, "AAPL", "stock", 1_000_000_000); // never cached
    const c = concentrationCard(bundle.db, TODAY);
    expect(c).toBeNull();
  });

  /**
   * ⛔ The total can reach zero with priced rows still in it. `price_cache.close`
   * is a bare REAL with nothing forbidding a negative — the return engine
   * already filters `close > 0` for exactly this reason — so a bad backfill can
   * cancel a real position out and leave a denominator of zero underneath rows
   * that each have a value. `positions.length === 0` does not catch that one.
   */
  test("a total cancelled to zero by a bad close returns null, not Infinity shares", () => {
    cache("AAPL", "stock", 100);
    cache("BAD", "stock", -100);
    hold(brokerage, "AAPL", "stock", 1_000_000_000);
    hold(brokerage, "BAD", "stock", 1_000_000_000);

    expect(concentrationCard(bundle.db, TODAY)).toBeNull();
  });

  test("a total driven negative by a bad close returns null too", () => {
    cache("AAPL", "stock", 100);
    cache("BAD", "stock", -300);
    hold(brokerage, "AAPL", "stock", 1_000_000_000);
    hold(brokerage, "BAD", "stock", 1_000_000_000);

    expect(concentrationCard(bundle.db, TODAY)).toBeNull();
  });

  /**
   * Dust: a real, active, priced position worth less than half a cent. It
   * rounds to $0.00 through `valueCentsOf`, and a row reading "DUST $0.00 0.0%"
   * spends a line saying nothing is there — the rule `eatingOutCard` follows for
   * an empty child category.
   */
  test("a position that rounds to nothing is not printed as a zero row", () => {
    seedBook();
    cache("DUST", "crypto", 0.0001);
    hold(crypto, "DUST", "crypto", 100_000_000); // 1.0 unit × $0.0001 → $0.00

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.positions.map((p) => p.symbol)).toEqual(["ETH", "SPY", "AAPL", "MSFT"]);
    expect(c.remainder).toBeNull();
    expect(c.unpricedSymbols).toEqual([]); // it HAS a price — it is just tiny
  });

  /**
   * A closed position is not a missing price. `upsertHolding` clears `is_active`
   * when a quantity reaches zero, but nothing in the schema enforces that pair,
   * and the row below is written the way a rebuild script writes one. Counting
   * it would invent a problem: "TSLA has no stored price" about a position he
   * does not hold.
   */
  test("a flat position left marked active is not reported as unpriced", () => {
    seedBook();
    hold(brokerage, "TSLA", "stock", 100_000_000);
    bundle.db
      .update(holdings)
      .set({ quantityE8: 0, isActive: true })
      .where(eq(holdings.symbol, "TSLA"))
      .run();

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.unpricedSymbols).toEqual([]);
    expect(c.unpricedNote).toBeNull();
  });

  test("an unpriced holding beside priced ones is named, not silently dropped", () => {
    seedBook();
    hold(brokerage, "TSLA", "stock", 100_000_000); // no close for TSLA

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.unpricedSymbols).toEqual(["TSLA"]);
    expect(c.unpricedNote).toContain("TSLA");
    // …and it is genuinely outside the total every share is a share of
    expect(c.portfolioCents).toBe(PORTFOLIO_CENTS);
    expect(c.positions.some((p) => p.symbol === "TSLA")).toBe(false);
  });

  /* ── the division guards ───────────────────────────────────────────────── */

  /**
   * ⛔ `x / 0` is `Infinity` and renders "Infinity× everything else". A net
   * worth of exactly zero has no share to publish, so the headline falls back
   * to the portfolio share and says which one it is.
   */
  test("a net worth of zero yields nulls, not Infinity", () => {
    seedBook();
    balance(card, -PORTFOLIO_CENTS); // debts exactly cancel the portfolio

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.netWorthCents).toBe(0);
    expect(c.portfolioSharePct).toBeNull();
    expect(c.top!.netWorthPct).toBeNull();
    expect(c.topTwo!.netWorthPct).toBeNull();
    expect(c.positions.every((p) => p.netWorthPct === null)).toBe(true);
    expect(c.headline).not.toContain("Infinity");
    expect(c.summary).not.toContain("Infinity");
    // the headline is now a share of the PORTFOLIO and says so
    expect(c.headlineNoun).toContain("portfolio");
  });

  /** A share of a negative net worth prints a minus sign on a position that has lost nothing. */
  test("a negative net worth yields nulls too", () => {
    seedBook();
    balance(card, -PORTFOLIO_CENTS - 100_000);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.netWorthCents).toBeLessThan(0);
    expect(c.portfolioSharePct).toBeNull();
    expect(c.top!.netWorthPct).toBeNull();
    expect(c.headlineNoun).toContain("portfolio");
  });

  /**
   * ⛔ The second denominator. `top / rest` is `Infinity` when the portfolio IS
   * the whole of net worth, so the multiple is withheld and the sentence
   * changes instead of the number breaking.
   */
  test("nothing outside the portfolio withholds the multiple rather than printing Infinity", () => {
    seedBook(); // no cash, no card: net worth is exactly the portfolio

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.netWorthCents).toBe(PORTFOLIO_CENTS);
    expect(c.restOfNetWorthCents).toBe(0);
    expect(c.topOverRest).toBeNull();
    expect(c.restNote).not.toContain("Infinity");
    expect(c.restNote).toContain("entire net worth");
  });

  /**
   * 🔴 THE CLAUSE AFTER THE COMMA WAS FALSE FOR EVERY INPUT THAT REACHES THIS
   * BRANCH. It read "…so the portfolio is worth more than everything you own
   * put together." With A = assets, L = liabilities, P = the portfolio and
   * R = A − P, `restOfNetWorthCents` is R − L; the branch fires when R < L,
   * and the sentence concluded P > A, which means R < 0. R is a sum of asset
   * balances and never is. Here A = $10,134.50 and P = $9,134.50: the portfolio
   * is emphatically NOT worth more than everything owned.
   *
   * ⚠️ Not reachable on the real ledger today — $4,675.37 sits outside the
   * portfolio against $842.89 of debt — which is why no reading ever caught it.
   */
  test("a negative rest withholds the multiple and says which way round it is", () => {
    seedBook();
    balance(card, -200_000); // owes more outside the portfolio than he holds

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.restOfNetWorthCents).toBe(-200_000);
    expect(c.topOverRest).toBeNull();
    expect(c.restNote).toContain("$2,000.00");
    expect(c.restNote).not.toContain("-$");
    expect(c.restNote).toContain("your net worth rests entirely on the portfolio");
    expect(c.restNote).not.toContain("worth more than everything you own");
    // …and the claim it used to make is refuted by this very fixture
    expect(c.portfolioCents).toBeLessThan(1_013_450); // total assets
  });

  /* ── signs ─────────────────────────────────────────────────────────────── */

  /**
   * 🔴 `-0` formats as "-$0.00" and every total stays correct while it does,
   * because `-0 + 0 === 0`. Only looking at the page catches it, so this test
   * looks instead: no number this service publishes may be negative zero, and
   * the one that can legitimately BE zero is pinned with `Object.is`.
   */
  test("no figure is negative zero", () => {
    seedBook(); // rest lands on exactly zero — the one place -0 could appear

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(Object.is(c.restOfNetWorthCents, -0)).toBe(false);
    expect(Object.is(c.restOfNetWorthCents, 0)).toBe(true);
    expect(negativeZeroFields(c)).toEqual([]);
  });

  test("no figure is negative zero when the debts win either", () => {
    seedBook();
    balance(card, -PORTFOLIO_CENTS);
    expect(negativeZeroFields(concentrationCard(bundle.db, TODAY)!)).toEqual([]);
  });

  /* ── prices are stored closes, not live quotes ─────────────────────────── */

  /** `isStaleClose` owns the boundary: a close dated today is not stale. */
  test("closes quoted today say nothing about their age", () => {
    seedBook();
    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.priceAge).toBeNull();
    expect(c.stalePositions).toEqual([]);
    expect(c.priceNote).toBeNull();
  });

  test("one shared stale close is stated once, for every position at once", () => {
    seedBook("2026-08-19"); // every close a week old

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.priceAge).not.toBeNull();
    expect(c.priceAge!.text).toContain("Aug 19");
    // …and then the rows stay quiet, priceColumnAge's rule
    expect(c.stalePositions).toEqual([]);
    expect(c.priceNote).toContain("Aug 19");
  });

  /** One symbol, one close — two accounts holding it are not two stale dates. */
  test("a stale symbol held twice is named once", () => {
    cache("ETH", "crypto", 2_000, "2026-08-19");
    cache("AAPL", "stock", 100, TODAY);
    hold(crypto, "ETH", "crypto", 250_000_000);
    hold(brokerage, "ETH", "crypto", 50_000_000); // the same ticker, second leg
    hold(brokerage, "AAPL", "stock", 100_000_000);
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);
    rebuildInvestmentHistory(bundle.db, crypto, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.stalePositions.map((x) => x.symbol)).toEqual(["ETH"]);
  });

  test("when the closes disagree only the stale ones are named", () => {
    seedBook(); // everything priced today
    // roll ONE symbol's only close back a week, leaving the others on today
    bundle.db.delete(priceCache).where(eq(priceCache.symbol, "AAPL")).run();
    cache("AAPL", "stock", 123.45, "2026-08-19");

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.priceAge).toBeNull(); // no single date describes every row
    expect(c.stalePositions.map((s) => s.symbol)).toEqual(["AAPL"]);
    expect(c.priceNote).toContain("AAPL");
  });

  /* ── the tail ──────────────────────────────────────────────────────────── */

  test("positions past the named ones become one line that still adds up", () => {
    seedBook();
    for (const [sym, qty] of [
      ["NVDA", 100_000_000],
      ["GOOG", 100_000_000],
      ["META", 100_000_000],
    ] as const) {
      cache(sym, "stock", 10);
      hold(brokerage, sym, "stock", qty);
    }
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.positions).toHaveLength(5);
    expect(c.remainder!.count).toBe(2);
    const shown = c.positions.reduce((s, p) => s + p.valueCents, 0) + c.remainder!.valueCents;
    expect(shown).toBe(PORTFOLIO_CENTS + 3 * 1_000);
  });

  test("the headline's own positions are always among the rows it is about", () => {
    // five funds above two tiny single names: without the force-include the
    // headline would name a row the card never shows
    for (const sym of ["VOO", "VTI", "QQQ", "IWM", "DIA"]) {
      cache(sym, "etf", 1_000);
      hold(brokerage, sym, "etf", 100_000_000);
    }
    cache("AAPL", "stock", 1);
    cache("MSFT", "stock", 1);
    hold(brokerage, "AAPL", "stock", 200_000_000);
    hold(brokerage, "MSFT", "stock", 100_000_000);
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);

    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.top!.symbol).toBe("AAPL");
    const shown = c.positions.map((p) => p.symbol);
    expect(shown).toContain("AAPL");
    expect(shown).toContain("MSFT");
  });

  test("the net-worth total arrives with its footing attached", () => {
    seedBook();
    balance(checking, 86_550);
    const c = concentrationCard(bundle.db, TODAY)!;
    expect(c.netWorthProvenance).not.toBeNull();
    expect(c.netWorthProvenance!.verdict).toBeTruthy();
  });
});

/** Every numeric leaf that is `-0`, by path — empty is the passing answer. */
function negativeZeroFields(value: unknown, at = "card"): string[] {
  if (typeof value === "number") return Object.is(value, -0) ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => negativeZeroFields(v, `${at}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => negativeZeroFields(v, `${at}.${k}`));
  }
  return [];
}
