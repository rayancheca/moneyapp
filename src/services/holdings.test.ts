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
  listAccountHoldings,
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

  test("listAccountHoldings: day change from the two latest closes, allocation within the account", () => {
    // Arrange: 10 AAPL @ $100 avg; closed $110 yesterday, $121 today
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "AAPL",
      assetType: "stock",
      quantityE8: 10 * 1e8,
      avgCostCents: 100_00,
    });
    cachePrice("AAPL", "stock", "2026-07-09", 110);
    cachePrice("AAPL", "stock", "2026-07-10", 121);

    // Act
    const [row] = listAccountHoldings(bundle.db, brokerageId);

    // Assert
    expect(row!.latestClose).toBe(121);
    expect(row!.quotedOn).toBe("2026-07-10");
    expect(row!.valueCents).toBe(121_000); // 10 × $121
    expect(row!.dayChangeCents).toBe(11_000); // 10 × ($121 − $110)
    expect(row!.dayChangePct).toBeCloseTo(10, 5);
    expect(row!.plCents).toBe(21_000); // vs $1,000 cost basis
    expect(row!.allocationPct).toBe(100);
  });

  test("listAccountHoldings: single cached day yields null day change; other accounts excluded", () => {
    const robinhood = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Robinhood"))
      .get()!;
    const cryptoId = createAccount(bundle.db, {
      institutionId: robinhood.id,
      name: "Robinhood Crypto",
      type: "investment",
      subtype: "crypto",
    });
    upsertHolding(bundle.db, {
      accountId: cryptoId,
      symbol: "ETH",
      assetType: "crypto",
      quantityE8: parseQuantityToE8("2"),
    });
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "MSFT",
      assetType: "stock",
      quantityE8: 1e8,
    });
    cachePrice("ETH", "crypto", "2026-07-10", 1800);

    const rows = listAccountHoldings(bundle.db, cryptoId);
    expect(rows).toHaveLength(1); // MSFT belongs to the other account
    expect(rows[0]!.symbol).toBe("ETH");
    expect(rows[0]!.valueCents).toBe(360_000);
    expect(rows[0]!.dayChangeCents).toBeNull();
    expect(rows[0]!.plCents).toBeNull(); // no avg cost recorded
  });
});
