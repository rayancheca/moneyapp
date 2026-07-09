import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "./accounts";
import {
  formatQuantityE8,
  listPortfolio,
  parseQuantityToE8,
  upsertHolding,
  valueCentsOf,
} from "./holdings";

process.env.MONEYAPP_FAKE_PRICES = "1";

describe("parseQuantityToE8 — string math, never floats", () => {
  test("parses decimals exactly", () => {
    expect(parseQuantityToE8("0.5")).toBe(50_000_000);
    expect(parseQuantityToE8("12")).toBe(1_200_000_000);
    expect(parseQuantityToE8("0.00000001")).toBe(1);
    expect(parseQuantityToE8(".5")).toBe(50_000_000);
    expect(parseQuantityToE8("1,234.00000001")).toBe(123_400_000_001);
    // the classic float trap: 0.1 + 0.2 territory
    expect(parseQuantityToE8("0.30000003")).toBe(30_000_003);
  });

  test("rejects garbage, negatives, and precision loss", () => {
    expect(() => parseQuantityToE8("")).toThrow(/empty/);
    expect(() => parseQuantityToE8("abc")).toThrow(/not a decimal/);
    expect(() => parseQuantityToE8("-1")).toThrow(/not a decimal/);
    expect(() => parseQuantityToE8("1.123456789")).toThrow(/8 decimal/);
    expect(() => parseQuantityToE8(".")).toThrow();
  });

  test("round-trips through formatQuantityE8", () => {
    expect(formatQuantityE8(50_000_000)).toBe("0.5");
    expect(formatQuantityE8(1_200_000_000)).toBe("12");
    expect(formatQuantityE8(123_400_000_001)).toBe("1,234.00000001");
    expect(formatQuantityE8(0)).toBe("0");
  });
});

describe("valueCentsOf — rounded to cents at the edge", () => {
  test("10 shares × $123.456 = $1,234.56", () => {
    expect(valueCentsOf(10 * 1e8, 123.456)).toBe(123_456);
  });
  test("0.8 ETH × $3,050 = $2,440.00", () => {
    expect(valueCentsOf(80_000_000, 3050)).toBe(244_000);
  });
});

describe("holdings service against a real database", () => {
  let dir: string;
  let bundle: DbBundle;
  let brokerageId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-hold-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const robinhood = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Robinhood"))
      .get()!;
    brokerageId = createAccount(bundle.db, {
      institutionId: robinhood.id,
      name: "Robinhood Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function eventsFor(symbol: string) {
    return bundle.db
      .select()
      .from(holdingEvents)
      .where(eq(holdingEvents.symbol, symbol))
      .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.createdAt))
      .all();
  }

  function cachePrice(symbol: string, assetType: "stock" | "etf" | "crypto", quotedOn: string, close: number) {
    bundle.db
      .insert(priceCache)
      .values({ symbol, assetType, quotedOn, close, source: "manual", fetchedAt: `${quotedOn}T16:00:00.000Z` })
      .run();
  }

  test("upsertHolding creates the holding and appends the opening delta event", () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "voo", // lowercased input — must normalize
      assetType: "etf",
      quantityE8: 50_000_000,
      avgCostCents: 52_000_00,
      occurredOn: "2026-06-01",
    });
    const row = bundle.db.select().from(holdings).where(eq(holdings.symbol, "VOO")).get();
    expect(row).toMatchObject({ symbol: "VOO", quantityE8: 50_000_000, isActive: true });

    const events = eventsFor("VOO");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      occurredOn: "2026-06-01",
      quantityDeltaE8: 50_000_000,
      costCents: 2_600_000, // $52,000 avg cost × 0.5 shares
    });
  });

  test("quantity change appends a signed delta; unchanged quantity appends nothing", () => {
    const base = {
      accountId: brokerageId,
      symbol: "ETH",
      assetType: "crypto" as const,
    };
    upsertHolding(bundle.db, { ...base, quantityE8: 50_000_000, occurredOn: "2026-06-01" });
    upsertHolding(bundle.db, { ...base, quantityE8: 80_000_000, occurredOn: "2026-06-10" });
    upsertHolding(bundle.db, { ...base, quantityE8: 80_000_000, occurredOn: "2026-06-15" }); // no-op
    upsertHolding(bundle.db, { ...base, quantityE8: 60_000_000, occurredOn: "2026-06-20" }); // sell

    expect(eventsFor("ETH").map((e) => e.quantityDeltaE8)).toEqual([
      50_000_000, 30_000_000, -20_000_000,
    ]);
    const row = bundle.db.select().from(holdings).where(eq(holdings.symbol, "ETH")).get();
    expect(row?.quantityE8).toBe(60_000_000);
  });

  test("zeroing a holding deactivates it and records the closing sell", () => {
    const base = { accountId: brokerageId, symbol: "AAPL", assetType: "stock" as const };
    upsertHolding(bundle.db, { ...base, quantityE8: 3 * 1e8, occurredOn: "2026-06-01" });
    upsertHolding(bundle.db, { ...base, quantityE8: 0, occurredOn: "2026-06-02" });
    const row = bundle.db.select().from(holdings).where(eq(holdings.symbol, "AAPL")).get();
    expect(row?.isActive).toBe(false);
    expect(eventsFor("AAPL").map((e) => e.quantityDeltaE8)).toEqual([300_000_000, -300_000_000]);
  });

  test("holdings are rejected on non-investment accounts", () => {
    const chase = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Chase"))
      .get()!;
    const checking = createAccount(bundle.db, {
      institutionId: chase.id,
      name: "Checking",
      type: "checking",
    });
    expect(() =>
      upsertHolding(bundle.db, {
        accountId: checking,
        symbol: "VOO",
        assetType: "etf",
        quantityE8: 1e8,
      }),
    ).toThrow(/investment accounts only/);
  });

  test("portfolio P/L: known avg cost vs latest close", () => {
    // 10 shares bought at $100 avg, latest close $120 → +$200 (+20%)
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
      avgCostCents: 10_000,
    });
    cachePrice("VOO", "etf", "2026-07-07", 118);
    cachePrice("VOO", "etf", "2026-07-08", 120); // latest wins

    const portfolio = listPortfolio(bundle.db);
    expect(portfolio.rows).toHaveLength(1);
    expect(portfolio.rows[0]).toMatchObject({
      symbol: "VOO",
      latestClose: 120,
      quotedOn: "2026-07-08",
      valueCents: 120_000,
      avgCostCents: 10_000,
      plCents: 20_000,
      allocationPct: 100,
    });
    expect(portfolio.rows[0]!.plPct).toBeCloseTo(20, 6);
    expect(portfolio.totals).toMatchObject({ valueCents: 120_000, plCents: 20_000 });
    expect(portfolio.totals.plPct).toBeCloseTo(20, 6);
    expect(portfolio.latestFetchedAt).toBe("2026-07-08T16:00:00.000Z");
  });

  test("a loss shows negative P/L", () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "AAPL",
      assetType: "stock",
      quantityE8: 4 * 1e8,
      avgCostCents: 25_000, // $250 avg
    });
    cachePrice("AAPL", "stock", "2026-07-08", 210);
    const row = listPortfolio(bundle.db).rows[0]!;
    expect(row.plCents).toBe(-16_000); // (210−250)×4
    expect(row.plPct).toBeCloseTo(-16, 6);
  });

  test("allocation percentages sum to 100 (±0.1) across uneven positions", () => {
    const positions: Array<[string, "stock" | "etf" | "crypto", number, number]> = [
      ["VOO", "etf", 7 * 1e8 + 33_333_333, 537.13],
      ["AAPL", "stock", 3 * 1e8, 229.77],
      ["MSFT", "stock", 1e8 + 1, 461.01],
      ["ETH", "crypto", 80_000_000, 3049.99],
    ];
    for (const [symbol, assetType, quantityE8, close] of positions) {
      upsertHolding(bundle.db, { accountId: brokerageId, symbol, assetType, quantityE8 });
      cachePrice(symbol, assetType, "2026-07-08", close);
    }
    const portfolio = listPortfolio(bundle.db);
    const sum = portfolio.rows.reduce((s, r) => s + (r.allocationPct ?? 0), 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.1);
    expect(portfolio.totals.valueCents).toBe(
      portfolio.rows.reduce((s, r) => s + (r.valueCents ?? 0), 0),
    );
  });

  test("unpriced holdings surface with null close and no allocation share", () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "NEWCO",
      assetType: "stock",
      quantityE8: 1e8,
    });
    const row = listPortfolio(bundle.db).rows[0]!;
    expect(row.latestClose).toBeNull();
    expect(row.valueCents).toBeNull();
    expect(row.plCents).toBeNull();
    expect(row.allocationPct).toBeNull();
  });
});
