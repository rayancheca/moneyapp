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
    const d = holdingDetail(bundle.db, "stock", "AAPL");
    expect(d.symbol).toBe("AAPL");
    expect(d.name).toBe("Apple Inc"); // parsed from the trade description
    expect(d.quantityE8).toBe(200_000_000);
    expect(d.valueCents).toBe(24_000); // 2 × $120
    expect(d.avgCostCents).toBe(11_000);
    expect(d.todayReturnCents).toBe(2_000); // 2 × ($120 − $110)
    expect(d.legs).toHaveLength(1);
    expect(d.diversityPct).toBeCloseTo(100, 5); // the only holding
  });

  test("returns the rebuilt trade timeline as marks + events, newest event first", () => {
    const d = holdingDetail(bundle.db, "stock", "AAPL");
    expect(d.marks).toHaveLength(2);
    expect(d.priceSeries).toHaveLength(3);
    expect(d.events.map((e) => e.kind)).toEqual(["buy", "buy"]);
    expect(d.events[0]!.day).toBe("2026-03-04"); // newest first
    expect(d.events[0]!.ledgerHref).toContain("q=AAPL");
    expect(d.events[0]!.ledgerHref).toContain("from=2026-03-04");
    expect(d.eventsTotal).toBe(2);
    expect(d.allTradesHref).toContain("q=AAPL"); // equity links out to the ledger
  });

  test("throws on an unknown symbol or asset type (→ notFound)", () => {
    expect(() => holdingDetail(bundle.db, "stock", "ZZZZ")).toThrow(UnknownHoldingError);
    expect(() => holdingDetail(bundle.db, "bogus", "AAPL")).toThrow(UnknownHoldingError);
  });
});
