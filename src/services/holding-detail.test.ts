import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, gt } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { parseFilters } from "@/components/transactions/query";
import { decomposeValue } from "@/lib/portfolio-returns";
import { createAccount } from "./accounts";
import { holdingDetail, UnknownHoldingError } from "./holding-detail";
import { upsertHolding } from "./holdings";
import { portfolioRealizedPl, realizedLegKey } from "./portfolio";
import { provenanceFor } from "./provenance";
import { matchingTransactionIds } from "./transactions-query";

process.env.MONEYAPP_FAKE_PRICES = "1";

let dir: string;
let bundle: DbBundle;
let brokerage: string;
let cash: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-holding-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  brokerage = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Robinhood Brokerage",
    type: "investment",
    subtype: "brokerage",
  });

  for (const [day, close] of [["2026-03-02", 100], ["2026-03-03", 110], ["2026-03-04", 120]] as const) {
    bundle.db
      .insert(priceCache)
      .values({ symbol: "AAPL", assetType: "stock", quotedOn: day, close, source: "yahoo", fetchedAt: `${day}T20:00:00.000Z` })
      .run();
  }
  upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 10_000, occurredOn: "2026-03-02" });
  upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 200_000_000, avgCostCents: 11_000, occurredOn: "2026-03-04" });
  /*
   * ⛔ THE CASH LEG IS A DIFFERENT ACCOUNT, and the fixture must say so or it
   * cannot express the defect it is here to catch. On the real ledger every
   * holding sits in Robinhood Brokerage — which holds ZERO transactions of any
   * status — while every trade row posts to Robinhood Cash. The old fixture put
   * the row in the brokerage, so `?account=<brokerage>` found it and blessed a
   * link that opened an empty ledger on all 351 of them.
   */
  // the real one is a CHECKING account, not an investment account
  cash = createAccount(bundle.db, {
    institutionId: robinhood.id,
    name: "Robinhood Cash",
    type: "checking",
  });
  bundle.db
    .insert(transactions)
    .values({
      accountId: cash,
      postedOn: "2026-03-04",
      amountCents: -12_000,
      rawDescription: "Apple Inc CUSIP: 037833100 (AAPL)",
      normalizedDescription: "apple inc cusip 037833100 aapl",
      dedupeHash: "aapl-buy-2",
    })
    .run();
  // a dividend: an AAPL row the ledger holds that is NOT a trade
  bundle.db
    .insert(transactions)
    .values({
      accountId: cash,
      postedOn: "2026-03-03",
      amountCents: 411,
      rawDescription: "Cash Div: 2 shares at 2.055 (AAPL)",
      normalizedDescription: "cash div 2 shares at 2 055 aapl",
      dedupeHash: "aapl-div-1",
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("holdingDetail", () => {
  test("aggregates the position across accounts with price, P/L, and diversity", () => {
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    expect(d.symbol).toBe("AAPL");
    expect(d.name).toBe("Apple Inc"); // parsed from the trade description
    expect(d.quantityE8).toBe(200_000_000);
    expect(d.valueCents).toBe(24_000); // 2 × $120
    expect(d.avgCostCents).toBe(11_000);
    // flow-adjusted: only the 1 share held ENTERING the latest quoted day earns
    // the close-to-close move — the share bought that day is a flow, not a gain
    expect(d.todayReturnCents).toBe(1_000); // 1 × ($120 − $110)
    expect(d.todayReturnPct).toBeCloseTo((1_000 / 11_000) * 100, 8);
    expect(d.legs).toHaveLength(1);
    expect(d.diversityPct).toBeCloseTo(100, 5); // the only holding
    expect(d.diversityDisplay).toBe("100.0%");
  });

  /**
   * 🔴 A HELD, PRICED POSITION RENDERED AS A MEASURED ZERO.
   *
   * `PositionCard` formatted `diversityPct.toFixed(1)` itself, so on the real
   * ledger 2026-09-11 `/investments/stock/WMT` read "Portfolio diversity 0.0%"
   * three lines under the "Market value $43.70" it had just printed — $43.70 of
   * $109,204.16 is 0.040%. Six sibling surfaces had been converted to
   * `sharePercent`, which floors a nonzero share at "<0.1%", the day before.
   *
   * ⛔ The standing fixture holds AAPL alone, so diversity is always exactly
   * 100% and a sub-0.05% share cannot occur in it at all. The whale goes here.
   */
  test("a sliver of the portfolio reads <0.1%, never a measured zero", () => {
    bundle.db
      .insert(priceCache)
      .values({
        symbol: "MSFT",
        assetType: "stock",
        quotedOn: "2026-03-04",
        close: 1_000_000,
        source: "yahoo",
        fetchedAt: "2026-03-04T20:00:00.000Z",
      })
      .run();
    upsertHolding(bundle.db, {
      accountId: brokerage,
      symbol: "MSFT",
      assetType: "stock",
      quantityE8: 100_000_000,
      avgCostCents: 100_000_000,
      occurredOn: "2026-03-04",
    });

    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    // $240 of $1,000,240 — real money, and toFixed(1) prints it as "0.0%"
    expect(d.diversityPct).toBeGreaterThan(0);
    expect(d.diversityPct!).toBeLessThan(0.05);
    expect(d.diversityPct!.toFixed(1)).toBe("0.0"); // what the card used to show
    expect(d.diversityDisplay).toBe("<0.1%");
  });

  test("returns the rebuilt trade timeline as marks + events, newest event first", () => {
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    expect(d.marks).toHaveLength(2);
    expect(d.priceSeries).toHaveLength(3);
    expect(d.priceSeries.every((p) => p.complete)).toBe(true); // no carried tail at today = last close
    expect(d.events.map((e) => e.kind)).toEqual(["buy", "buy"]);
    expect(d.events[0]!.day).toBe("2026-03-04"); // newest first
    expect(d.events[0]!.ledgerHref).toContain("q=%28AAPL%29");
    expect(d.events[0]!.ledgerHref).toContain("from=2026-03-04");
    expect(d.eventsTotal).toBe(2);
    expect(d.allTradesHref).toContain("q=%28AAPL%29"); // equity links out to the ledger
  });

  /*
   * 🔴 THE LINK MATCHED THE TICKER'S LETTERS, NOT THE HOLDING'S ROWS. `q` is a
   * literal, case-insensitive LIKE over the bank's text, so "PM" found "Zelle
   * payment to Philipe JPM99…" and "CAPITAL ONE MOBILE PMT". Measured
   * 2026-09-14: /investments/stock/PM read "View all 592 PM rows in the ledger"
   * over 189 real ones (AMZN 283 of 242, GOOG 118 of 92, SPY 292 of 285). The
   * importer stamps every instrument row "(SYM)", the scope `displayName`
   * already reads. ⛔ This fixture's AAPL rows are all tagged and no bank text
   * contains "AAPL", so it could not express the defect — PM's real collisions
   * go here.
   */
  test("the ledger links and their count open the holding's TAGGED rows, not every row with the ticker's letters", () => {
    bundle.db
      .insert(priceCache)
      .values({ symbol: "PM", assetType: "stock", quotedOn: "2026-03-04", close: 100, source: "yahoo", fetchedAt: "2026-03-04T20:00:00.000Z" })
      .run();
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "PM", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 10_000, occurredOn: "2026-03-04" });
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const checking = createAccount(bundle.db, { institutionId: chase.id, name: "Chase Checking", type: "checking" });
    for (const r of [
      { accountId: cash, rawDescription: "Philip Morris CUSIP: 718172109 Recurring (PM)", normalizedDescription: "philip morris cusip 718172109 recurring pm", dedupeHash: "pm-buy" },
      // the SAME day, so the per-event link can over-match too
      { accountId: checking, rawDescription: "Zelle payment to Philipe JPM99cmn8d70", normalizedDescription: "zelle payment to philipe jpm99cmn8d70", dedupeHash: "zelle" },
      { accountId: checking, rawDescription: "CAPITAL ONE MOBILE PMT CA056B58995B534 WEB ID: 92797443", normalizedDescription: "capital one mobile pmt ca056b58995b534 web id 92797443", dedupeHash: "cap1" },
    ]) {
      bundle.db.insert(transactions).values({ ...r, postedOn: "2026-03-04", amountCents: -10_000 }).run();
    }
    const tagged = bundle.db.select({ id: transactions.id }).from(transactions).where(eq(transactions.dedupeHash, "pm-buy")).get()!.id;
    const opened = (href: string): string[] => {
      const filters = parseFilters(Object.fromEntries(new URL(href, "http://localhost").searchParams));
      return matchingTransactionIds(bundle.db, filters, filters.view);
    };

    const d = holdingDetail(bundle.db, "stock", "PM", "2026-03-04");
    expect(d.ledgerRowCount).toBe(1);
    expect(opened(d.allTradesHref!)).toEqual([tagged]);
    expect(opened(d.events[0]!.ledgerHref!)).toEqual([tagged]);
  });

  /*
   * 🔴 THE LINK FILTERED ON THE ACCOUNT THE SHARES SIT IN, AND EXCLUDED EVERY
   * ROW. `holdingLegs` are POSITIONS — all in Robinhood Brokerage, which holds
   * zero transactions — while the trades post to Robinhood Cash. Measured on
   * the real ledger 2026-09-11: `?account=<brokerage>&q=AAPL` → 0 rows,
   * `?q=AAPL` → 253. All 351 ledger links across the nine equity holding pages
   * opened "No matching transactions" under a page saying there were 244
   * trades. A position's account says where the shares are held, never where
   * the money moved.
   */
  test("the ledger links are scoped by SYMBOL, never by the account the shares sit in", () => {
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    for (const href of [d.allTradesHref, d.events[0]!.ledgerHref]) {
      expect(href).not.toContain("account=");
      expect(href).not.toContain(brokerage);
    }
  });

  /*
   * ⛔ And the sentence over the link names the DESTINATION's population, not
   * this card's. The link searches the ledger for the symbol, which finds
   * dividends too — on the real ledger AAPL has 244 holding events and 253
   * matching rows (241 buys + 2 sells + 10 dividends).
   */
  test("ledgerRowCount is what the link opens, which is not the trade count", () => {
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    expect(d.eventsTotal).toBe(2); // two holding events
    expect(d.ledgerRowCount).toBe(2); // the buy row AND the dividend row
    // a row in another account still counts: the link is not account-scoped
    expect(d.ledgerRowCount).toBeGreaterThan(0);
  });

  test("carries the last close forward to today as a dashed (estimated) tail", () => {
    // today is 3 days past the last quoted close (2026-03-04 @ $120)
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-07");
    expect(d.priceSeries).toHaveLength(6); // 3 real + 3 carried
    expect(d.priceSeries.slice(0, 3).every((p) => p.complete)).toBe(true);
    expect(d.priceSeries.slice(3)).toEqual([
      { day: "2026-03-05", closeCents: 12_000, complete: false },
      { day: "2026-03-06", closeCents: 12_000, complete: false },
      { day: "2026-03-07", closeCents: 12_000, complete: false },
    ]);
    // header stats stay on the REAL latest close, not the carried tail
    expect(d.latestClose).toBe(120);
    expect(d.quotedOn).toBe("2026-03-04");
    expect(d.valueCents).toBe(24_000); // 2 × $120, unchanged by the carry-forward
  });

  test("no sells → an empty realized book (the drill-down card stays hidden)", () => {
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    expect(d.realized.sellCount).toBe(0);
    expect(d.realizedSales).toEqual([]);
  });

  test("a sell realizes proceeds − avg-cost basis at the day's close, with a drill-down row", () => {
    // sell 1 of the 2 shares on 2026-03-04 (close $120); basis = ($100+$120)/2
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 11_000, occurredOn: "2026-03-04" });
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    expect(d.realized.realizedCents).toBe(1_000);
    expect(d.realized.sellCount).toBe(1);
    expect(d.realized.exact).toBe(true);
    expect(d.realizedSales).toEqual([
      {
        day: "2026-03-04",
        qtyE8: 100_000_000,
        proceedsCents: 12_000,
        basisCents: 11_000,
        gainCents: 1_000,
        exact: true,
        clamped: false,
      },
    ]);
  });

  test("a symbol held in TWO accounts keeps a basis book per account (never blended)", () => {
    // second brokerage: buy 1 AAPL on 03-02 (close $100), sell it on 03-04 ($120)
    const second = createAccount(bundle.db, {
      institutionId: bundle.db.select().from(institutions).get()!.id,
      name: "Second Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    upsertHolding(bundle.db, { accountId: second, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 10_000, occurredOn: "2026-03-02" });
    upsertHolding(bundle.db, { accountId: second, symbol: "AAPL", assetType: "stock", quantityE8: 0, avgCostCents: 10_000, occurredOn: "2026-03-04" });
    // first account: sell 1 of its 2 on 03-04 (avg basis (100+120)/2 = $110)
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 11_000, occurredOn: "2026-03-04" });

    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    // account A: $120 − $110 avg = +$10; account B: $120 − ITS OWN $100 basis =
    // +$20 → +$30 total. A blended single book (basis (100+100+120)/3 ≈ $106.67
    // per sale) would report ≈$26.67 — this pins the per-account invariant.
    expect(d.realized.sellCount).toBe(2);
    expect(d.realized.realizedCents).toBe(3_000);
    expect(d.realizedSales.map((s) => s.day)).toEqual(["2026-03-04", "2026-03-04"]);
    expect(d.realizedSales.map((s) => s.basisCents).sort((a, b) => a - b)).toEqual([10_000, 11_000]);
  });

  test("throws on an unknown symbol or asset type (→ notFound)", () => {
    expect(() => holdingDetail(bundle.db, "stock", "ZZZZ")).toThrow(UnknownHoldingError);
    expect(() => holdingDetail(bundle.db, "bogus", "AAPL")).toThrow(UnknownHoldingError);
  });
});

/*
 * 🔴 THE SPLIT FIX NEVER REACHED THIS PAGE. `holdingDetail` read `holding_events`
 * raw, so COKE's 10-for-1 (stored as `event_kind = 'split'`, +9.013095 shares)
 * entered its cost walk as a PURCHASE at the split day's close, and its return
 * series valued as-traded pre-split shares against split-ADJUSTED closes — the
 * two defects `lib/split-adjust.ts` documents, still uncancelled here.
 *
 * Measured on the real ledger 2026-09-15, /investments/stock/COKE against the
 * /investments holdings table for the same single sale (3 sh, 2026-02-09):
 *
 *     holding page   Realized +$112.54  ($462.27 − $349.73 basis)  XIRR 56.11%
 *     table          Realized +$102.32  ($462.27 − $359.95 basis)
 *     NAV 2025-05-23 $113.52 (a tenth) · a $1,018.83 "flow" on the split day
 *
 * ⚠️ The price MOVES between the buy and the split here on purpose. With a flat
 * close the phantom purchase costs exactly what scaling the earlier buy costs,
 * and the raw walk reaches the right basis by accident — a fixture that cannot
 * tell the two walks apart cannot test which one the page uses.
 */
describe("a stock split on the holding page", () => {
  const SPLIT_DAY = "2025-05-27";

  beforeEach(() => {
    for (const [day, close] of [
      ["2025-05-23", 100], // adjusted: a real pre-split share cost $1,000
      [SPLIT_DAY, 150],
      ["2025-05-28", 150],
      ["2026-02-09", 120],
    ] as const) {
      bundle.db
        .insert(priceCache)
        .values({ symbol: "COKE", assetType: "stock", quotedOn: day, close, source: "yahoo", fetchedAt: `${day}T20:00:00.000Z` })
        .run();
    }
    const event = (occurredOn: string, quantityDeltaE8: number, eventKind: "trade" | "split", costCents: number | null) =>
      bundle.db
        .insert(holdingEvents)
        .values({ accountId: brokerage, symbol: "COKE", assetType: "stock", occurredOn, quantityDeltaE8, eventKind, costCents })
        .run();
    event("2025-05-23", 1e8, "trade", 100_000); // 1 share as traded
    event(SPLIT_DAY, 9e8, "split", null); // the 10-for-1, as the ledger stores it
    event("2026-02-09", -3e8, "trade", -36_000); // 3 post-split shares
    bundle.db
      .insert(holdings)
      .values({ accountId: brokerage, symbol: "COKE", assetType: "stock", quantityE8: 7e8, avgCostCents: 10_000 })
      .run();
  });

  test("realized P/L is the /investments table's figure for the same sale", () => {
    const d = holdingDetail(bundle.db, "stock", "COKE", "2026-02-09");
    const table = portfolioRealizedPl(bundle.db).byLeg.get(realizedLegKey(brokerage, "stock", "COKE"))!;

    // 10 shares at $100 adjusted = $1,000 of basis; 3 sold at $120 → $360 − $300
    expect(d.realized.realizedCents).toBe(6_000);
    expect(d.realized).toEqual({
      realizedCents: table.realizedCents,
      proceedsCents: table.proceedsCents,
      basisCents: table.basisCents,
      sellCount: table.sellCount,
      exact: table.exact,
    });
    expect(d.realizedSales.map((s) => [s.proceedsCents, s.basisCents, s.gainCents])).toEqual([[36_000, 30_000, 6_000]]);
  });

  /*
   * ⛔ The page's realized walk is the portfolio's, SCOPED — and the scope is the
   * one new thing in it that can be wrong: another symbol's sale, or a coin that
   * shares this ticker's symbol (schema.md's ETH), must never land on this page.
   * Not RED at the base, which scoped by its own query; mutation-tested instead.
   */
  test("the walk is scoped to this holding: another symbol's sale and a same-named coin's are not its own", () => {
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 11_000, occurredOn: "2026-03-04" });
    const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const crypto = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Crypto", type: "investment", subtype: "crypto" });
    for (const [day, close] of [["2026-02-02", 5], ["2026-02-09", 9]] as const) {
      bundle.db
        .insert(priceCache)
        .values({ symbol: "COKE", assetType: "crypto", quotedOn: day, close, source: "coinbase", fetchedAt: `${day}T20:00:00.000Z` })
        .run();
    }
    bundle.db
      .insert(holdingEvents)
      .values([
        { accountId: crypto, symbol: "COKE", assetType: "crypto", occurredOn: "2026-02-02", quantityDeltaE8: 100e8 },
        { accountId: crypto, symbol: "COKE", assetType: "crypto", occurredOn: "2026-02-09", quantityDeltaE8: -100e8 },
      ])
      .run();

    const d = holdingDetail(bundle.db, "stock", "COKE", "2026-03-04");
    expect(d.realized.sellCount).toBe(1);
    expect(d.realized.realizedCents).toBe(6_000);
    expect(d.realizedSales.map((s) => s.day)).toEqual(["2026-02-09"]);
  });

  test("the return series counts pre-split shares in today's terms and books no flow for the split", () => {
    const d = holdingDetail(bundle.db, "stock", "COKE", "2026-02-09");
    const on = (day: string) => d.returnDays.find((r) => r.day === day)!;

    expect(on("2025-05-23").navCents).toBe(100_000); // 10 adjusted shares × $100, not 1 × $100
    expect(on(SPLIT_DAY).flowCents).toBe(0); // a split moves no money
    expect(on(SPLIT_DAY).navCents).toBe(150_000);
    // contributions are what was put in: the opening $1,000, nothing on the split day
    expect(decomposeValue(d.returnDays)!.grossContributedCents).toBe(100_000);
  });

  test("a split is neither a trade mark on the chart nor a row in the trade history", () => {
    const d = holdingDetail(bundle.db, "stock", "COKE", "2026-02-09");

    expect(d.marks.map((m) => [m.day, m.kind])).toEqual([
      ["2025-05-23", "buy"],
      ["2026-02-09", "sell"],
    ]);
    expect(d.events.map((e) => [e.day, e.kind])).toEqual([
      ["2026-02-09", "sell"],
      ["2025-05-23", "buy"],
    ]);
    expect(d.eventsTotal).toBe(2); // "2 trades" — the split is not one
  });

  test("a split on the newest quoted day is not a flow that shrinks the shares entering it", () => {
    // stop the book on the split day: its close is the newest, and nothing was sold yet
    bundle.db.delete(priceCache).where(and(eq(priceCache.symbol, "COKE"), gt(priceCache.quotedOn, SPLIT_DAY))).run();
    bundle.db.delete(holdingEvents).where(eq(holdingEvents.occurredOn, "2026-02-09")).run();
    bundle.db.update(holdings).set({ quantityE8: 10e8 }).where(eq(holdings.symbol, "COKE")).run();

    const d = holdingDetail(bundle.db, "stock", "COKE", SPLIT_DAY);
    expect(d.quotedOn).toBe(SPLIT_DAY);
    // all 10 shares held entering the day earn ($150 − $100); the raw walk
    // subtracted the split's 9 "bought" shares first and credited 1 × $50
    expect(d.todayReturnCents).toBe(50_000);
  });
});

/*
 * ⛔ THE FIFTH SURFACE TO SAY "TODAY" over a figure that has nothing to do with
 * the calendar. `todayReturnCents` is the move between the last two rows in
 * `price_cache`; the card labelled it "Today" whatever day it was.
 *
 * 🔴 Measured on the real ledger at today = 2026-09-01: **23 of 33 holding
 * pages** named a move that did not happen today. `ADBE` read "Today −$37.44"
 * for 2026-05-11 — 113 days earlier — and the worst, `VEU`, was priced
 * 2025-04-03, 516 days before. These are mostly closed positions whose last
 * price is frozen where the position ended.
 *
 * `9017021` fixed three surfaces, `fcf0192` a fourth. This is the fifth, and
 * the reason the grep missed it again: the word is a component PROP.
 */
describe("the day-change figure names its own two days", () => {
  test("a holding priced through today says Today, with no interval", () => {
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04")!;
    expect(d.quotedOn).toBe("2026-03-04");
    expect(d.todayReturnLabel).toBe("Today");
    expect(d.todayReturnInterval).toBeNull();
  });

  test("a holding whose newest close is older names the two days it spans", () => {
    // the price is four months stale — the FIGURE is unchanged, the word is not
    const fresh = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04")!;
    const stale = holdingDetail(bundle.db, "stock", "AAPL", "2026-07-01")!;
    expect(stale.todayReturnCents).toBe(fresh.todayReturnCents);
    expect(stale.todayReturnLabel).not.toBe("Today");
    expect(stale.todayReturnInterval).toBe("Mar 4 vs Mar 3");
  });

  test("one close is no interval at all rather than a wrong one", () => {
    bundle.db.delete(priceCache).where(eq(priceCache.quotedOn, "2026-03-04")).run();
    bundle.db.delete(priceCache).where(eq(priceCache.quotedOn, "2026-03-03")).run();
    const d = holdingDetail(bundle.db, "stock", "AAPL", "2026-07-01")!;
    expect(d.todayReturnCents).toBeNull();
    expect(d.todayReturnInterval).toBeNull();
  });
});

/**
 * ⚖️ Owner decisions 2026-09-14/15: the positions Claude's agent buys sit in a brokerage book paired with Robinhood
 * Agentic, and are kept out of his own brokerage returns. A holding page is his holding's returns.
 */
describe("⛔ the agent's book is not a leg of his holding page", () => {
  const aaplProvenance = () => provenanceFor(bundle.db, { kind: "holding", symbol: "AAPL", assetType: "stock", day: "2026-03-04" });

  test("the same symbol held in the book paired with Robinhood Agentic leaves his AAPL page exactly as it was", () => {
    const before = holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04");
    const explained = aaplProvenance();
    const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const agentic = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();

    upsertHolding(bundle.db, { accountId: book, symbol: "AAPL", assetType: "stock", quantityE8: 50_000_000, avgCostCents: 11_000, occurredOn: "2026-03-03" });

    expect(holdingDetail(bundle.db, "stock", "AAPL", "2026-03-04")).toEqual(before);
    /*
     * 🔴 …and the panel that explains the page's value says the same: it counted the book's shares and listed
     * "Robinhood Agentic Brokerage" as a leg of his position — 0.662664 shares against the page's 0.412664 on the
     * agent's constructed August (measured 2026-09-16).
     */
    expect(aaplProvenance()).toEqual(explained);
    expect(explained!.headline).toMatch(new RegExp(`^${before.quantityE8 / 1e8} shares × `));
    expect(explained!.inputs).toEqual([]); // one leg, his: legs are listed only when there are several
  });

  test("a symbol only the agent's book holds has no holding page, and no panel explaining one", () => {
    const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const agentic = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    upsertHolding(bundle.db, { accountId: book, symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, avgCostCents: 10_000, occurredOn: "2026-03-03" });

    expect(() => holdingDetail(bundle.db, "stock", "WMT", "2026-03-04")).toThrow(UnknownHoldingError);
    expect(provenanceFor(bundle.db, { kind: "holding", symbol: "WMT", assetType: "stock", day: "2026-03-04" })).toBeNull();
  });
});
