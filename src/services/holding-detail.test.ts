import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { createAccount } from "./accounts";
import { holdingDetail, UnknownHoldingError } from "./holding-detail";
import { upsertHolding } from "./holdings";

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
    expect(d.events[0]!.ledgerHref).toContain("q=AAPL");
    expect(d.events[0]!.ledgerHref).toContain("from=2026-03-04");
    expect(d.eventsTotal).toBe(2);
    expect(d.allTradesHref).toContain("q=AAPL"); // equity links out to the ledger
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
