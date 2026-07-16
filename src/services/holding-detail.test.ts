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
  bundle.db
    .insert(transactions)
    .values({
      accountId: brokerage,
      postedOn: "2026-03-04",
      amountCents: -12_000,
      rawDescription: "Apple Inc CUSIP: 037833100 (AAPL)",
      normalizedDescription: "apple inc cusip 037833100 aapl",
      dedupeHash: "aapl-buy-2",
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
