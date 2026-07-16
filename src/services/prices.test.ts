import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { priceCache } from "@/db/schema/holdings";
import { appSettings } from "@/db/schema/settings";
import { addDays, todayIso } from "@/lib/dates";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { netWorthSeries } from "./derivation";
import { upsertHolding } from "./holdings";
import {
  coinbaseProvider,
  fakeCloseFor,
  fakeProvider,
  getProvider,
  refreshPrices,
  yahooProvider,
  type PriceProvider,
  type Quote,
} from "./prices";

// NO network in tests — the fake provider is active for any routed lookup
process.env.MONEYAPP_FAKE_PRICES = "1";

// yahoo-finance2 v3 exports a CLASS — methods only exist on instances. A v2
// regression (calling .chart/.quote on the default export itself) fails here.
const { yahooChartMock, yahooQuoteMock } = vi.hoisted(() => ({
  yahooChartMock: vi.fn(),
  yahooQuoteMock: vi.fn(),
}));
vi.mock("yahoo-finance2", () => ({
  default: class {
    chart = yahooChartMock;
    quote = yahooQuoteMock;
  },
}));

const NOW = new Date("2026-07-08T12:00:00");
const TODAY = todayIso(NOW);
// Pin the no-arg clock to NOW: upsertHolding stamps holding_events with
// todayIso() by default, and investment balances now derive from the
// events x closes timeline (rebuildAccount delegates), so the event date must
// land inside the refresh window rather than the real wall clock.
process.env.MONEYAPP_FAKE_TODAY = TODAY;

describe("fake provider — deterministic synthetic prices", () => {
  test("same (symbol, day) yields the same close across calls", () => {
    expect(fakeCloseFor("VOO", "2026-01-15")).toBe(fakeCloseFor("VOO", "2026-01-15"));
    expect(fakeCloseFor("ETH", "2025-03-02")).toBe(fakeCloseFor("ETH", "2025-03-02"));
  });

  test("overlapping ranges agree day-for-day (walk is range-independent)", async () => {
    const a = await fakeProvider.getDailyCloses("AAPL", "stock", "2026-01-01", "2026-01-20");
    const b = await fakeProvider.getDailyCloses("AAPL", "stock", "2026-01-10", "2026-02-05");
    const byDayA = new Map(a.map((c) => [c.day, c.close]));
    for (const c of b.filter((x) => byDayA.has(x.day))) {
      expect(c.close).toBe(byDayA.get(c.day));
    }
    expect(a).toHaveLength(20);
  });

  test("stays inside the per-symbol plausibility band", async () => {
    // plausibility only — the shared walk (src/lib/fake-prices) drifts within
    // these levels plus ±5% noise/wave headroom
    const bands: Array<[string, number, number]> = [
      ["VOO", 475, 620],
      ["AAPL", 190, 262],
      ["MSFT", 395, 535],
      ["ETH", 2280, 4060],
      ["ZZZT", 45, 158], // everything else
    ];
    for (const [symbol, lo, hi] of bands) {
      const series = await fakeProvider.getDailyCloses(symbol, "stock", "2024-07-08", "2026-07-08");
      expect(series.length).toBe(731);
      for (const c of series) {
        expect(c.close).toBeGreaterThanOrEqual(lo);
        expect(c.close).toBeLessThanOrEqual(hi);
      }
    }
  });

  test("different symbols walk differently", () => {
    expect(fakeCloseFor("AAPL", "2026-01-15")).not.toBe(fakeCloseFor("MSFT", "2026-01-15"));
  });
});

describe("provider routing", () => {
  test("MONEYAPP_FAKE_PRICES=1 routes every asset type to the fake provider", () => {
    expect(getProvider("stock")).toBe(fakeProvider);
    expect(getProvider("etf")).toBe(fakeProvider);
    expect(getProvider("crypto")).toBe(fakeProvider);
  });

  test("yahooProvider drives the v3 instance API (chart + quote)", async () => {
    yahooChartMock.mockResolvedValueOnce({
      quotes: [{ date: new Date("2026-07-08T00:00:00Z"), close: 123.45 }],
    });
    const closes = await yahooProvider.getDailyCloses("AAPL", "stock", "2026-07-08", "2026-07-08");
    expect(closes).toEqual([{ day: "2026-07-08", close: 123.45 }]);
    expect(yahooChartMock).toHaveBeenCalledWith("AAPL", {
      period1: "2026-07-08",
      period2: "2026-07-09", // chart period2 is exclusive
      interval: "1d",
    });

    yahooQuoteMock.mockResolvedValueOnce([{ symbol: "AAPL", regularMarketPrice: 111.5 }]);
    const quotes = await yahooProvider.getQuotes([{ symbol: "AAPL", assetType: "stock" }]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.price).toBe(111.5);
  });

  test("yahoo refuses crypto; coinbase refuses equities (keyed lookups)", async () => {
    await expect(yahooProvider.getDailyCloses("ETH", "crypto", TODAY, TODAY)).rejects.toThrow(
      /cannot price crypto/,
    );
    await expect(coinbaseProvider.getDailyCloses("VOO", "etf", TODAY, TODAY)).rejects.toThrow(
      /only prices crypto/,
    );
    await expect(coinbaseProvider.getQuotes([{ symbol: "VOO", assetType: "etf" }])).rejects.toThrow(
      /only prices crypto/,
    );
  });
});

describe("refreshPrices against a real database", () => {
  let dir: string;
  let bundle: DbBundle;
  let brokerageId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-prices-"));
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

  interface Counting {
    provider: PriceProvider;
    counts: { closes: number; quotes: number };
    ranges: Array<{ from: string; to: string }>;
  }

  /** wraps the fake walk for history; quotes at a fixed $100 for exact math */
  function countingProvider(quotePrice = 100): Counting {
    const counts = { closes: 0, quotes: 0 };
    const ranges: Array<{ from: string; to: string }> = [];
    const provider: PriceProvider = {
      source: "manual",
      getDailyCloses(symbol, assetType, fromDay, toDay) {
        counts.closes += 1;
        ranges.push({ from: fromDay, to: toDay });
        return fakeProvider.getDailyCloses(symbol, assetType, fromDay, toDay);
      },
      getQuotes(items) {
        counts.quotes += 1;
        const quotes: Quote[] = items.map((i) => ({ ...i, price: quotePrice, asOfDay: TODAY }));
        return Promise.resolve(quotes);
      },
    };
    return { provider, counts, ranges };
  }

  function setStaleness(hours: number): void {
    bundle.db
      .update(appSettings)
      .set({ value: JSON.stringify(hours) })
      .where(eq(appSettings.key, "priceStalenessHours"))
      .run();
  }

  function cachedRows(symbol: string) {
    return bundle.db
      .select()
      .from(priceCache)
      .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, "etf")))
      .all();
  }

  test("2-year backfill is fetched once, then served from cache", async () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
    });
    const { provider, counts, ranges } = countingProvider();

    const first = await refreshPrices(bundle.db, { now: NOW, providers: () => provider });
    expect(first.errors).toEqual([]);
    expect(counts.closes).toBe(1);
    expect(counts.quotes).toBe(1);
    expect(ranges[0]).toEqual({ from: addDays(TODAY, -730), to: TODAY });
    expect(cachedRows("VOO").length).toBe(731); // 730 back-days + today

    // staleness 0 forces a quote refresh — history must STILL come from cache
    setStaleness(0);
    const second = await refreshPrices(bundle.db, { now: NOW, providers: () => provider });
    expect(second.errors).toEqual([]);
    expect(counts.closes).toBe(1); // ← the backfill never re-fetches
    expect(counts.quotes).toBe(2);
    expect(cachedRows("VOO").length).toBe(731);
  });

  test("fresh cache within priceStalenessHours skips providers entirely", async () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
    });
    const { provider, counts } = countingProvider();
    await refreshPrices(bundle.db, { now: NOW, providers: () => provider });

    const later = new Date(NOW.getTime() + 3_600_000); // +1h < 4h default
    const result = await refreshPrices(bundle.db, { now: later, providers: () => provider });
    expect(result.skippedFresh).toBe(1);
    expect(counts.closes).toBe(1);
    expect(counts.quotes).toBe(1);
  });

  test("force bypasses the freshness skip so a manual press quotes live now", async () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
    });
    const { provider, counts } = countingProvider();
    const first = await refreshPrices(bundle.db, { now: NOW, providers: () => provider });
    expect(counts.quotes).toBe(1);
    expect(first.asOf).toBe(NOW.toISOString()); // "prices as of …" stamp = the fetch time

    // +1h is well inside the 4h default window → the implicit path would skip,
    // but force re-quotes anyway (a manual press must pull the live price NOW)
    const later = new Date(NOW.getTime() + 3_600_000);
    const forced = await refreshPrices(bundle.db, {
      now: later,
      providers: () => provider,
      force: true,
    });
    expect(forced.skippedFresh).toBe(0);
    expect(forced.quotedSymbols).toBe(1);
    expect(counts.quotes).toBe(2); // re-fetched despite the fresh cache
    expect(counts.closes).toBe(1); // history still served from cache (only the gap)
    expect(forced.asOf).toBe(later.toISOString());
  });

  test("next-day refresh fetches only the missing gap", async () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
    });
    const { provider, ranges } = countingProvider();
    await refreshPrices(bundle.db, { now: NOW, providers: () => provider });

    const nextDay = new Date(NOW.getTime() + 24 * 3_600_000);
    await refreshPrices(bundle.db, { now: nextDay, providers: () => provider });
    expect(ranges[1]).toEqual({ from: addDays(TODAY, 1), to: addDays(TODAY, 1) });
  });

  test("live anchor: net worth total = cash + holdings × latest cached prices", async () => {
    const chase = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Chase"))
      .get()!;
    const checkingId = createAccount(bundle.db, {
      institutionId: chase.id,
      name: "Checking",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: checkingId, anchoredOn: TODAY, enteredCents: 500_000 });

    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8, // 10 shares
    });
    const { provider } = countingProvider(100); // $100 quote → $1,000 position

    await refreshPrices(bundle.db, { now: NOW, providers: () => provider });

    const anchor = bundle.db
      .select()
      .from(balanceAnchors)
      .where(and(eq(balanceAnchors.accountId, brokerageId), eq(balanceAnchors.source, "live")))
      .get();
    expect(anchor).toMatchObject({ anchoredOn: TODAY, balanceCents: 100_000 });

    const today = netWorthSeries(bundle.db).find((p) => p.day === TODAY);
    expect(today?.totalCents).toBe(600_000); // 5,000 cash + 1,000 market value
    expect(today?.complete).toBe(true);
  });

  test("re-running the refresh updates the live anchor in place (no duplicates)", async () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
    });
    await refreshPrices(bundle.db, { now: NOW, providers: () => countingProvider(100).provider });
    setStaleness(0);
    await refreshPrices(bundle.db, { now: NOW, providers: () => countingProvider(110).provider });

    const anchors = bundle.db
      .select()
      .from(balanceAnchors)
      .where(and(eq(balanceAnchors.accountId, brokerageId), eq(balanceAnchors.source, "live")))
      .all();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.balanceCents).toBe(110_000);
  });

  test("provider outage degrades to cached prices — errors reported, anchor still written", async () => {
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
    });
    await refreshPrices(bundle.db, { now: NOW, providers: () => countingProvider(100).provider });

    const failing: PriceProvider = {
      source: "yahoo",
      getDailyCloses: () => Promise.reject(new Error("yahoo outage")),
      getQuotes: () => Promise.reject(new Error("yahoo outage")),
    };
    setStaleness(0);
    const result = await refreshPrices(bundle.db, { now: NOW, providers: () => failing });

    expect(result.errors.some((e) => e.includes("yahoo outage"))).toBe(true);
    expect(result.anchoredAccounts).toBe(1); // valued from the cached close
    const today = netWorthSeries(bundle.db).find((p) => p.day === TODAY);
    expect(today?.totalCents).toBe(100_000); // last cached $100 quote, "as of" stamped
  });

  test("account with no priced holdings never gets an invented anchor", async () => {
    // holding exists but every provider call fails and the cache is empty
    upsertHolding(bundle.db, {
      accountId: brokerageId,
      symbol: "VOO",
      assetType: "etf",
      quantityE8: 10 * 1e8,
    });
    const failing: PriceProvider = {
      source: "yahoo",
      getDailyCloses: () => Promise.reject(new Error("down")),
      getQuotes: () => Promise.reject(new Error("down")),
    };
    const result = await refreshPrices(bundle.db, { now: NOW, providers: () => failing });
    expect(result.anchoredAccounts).toBe(0);
    expect(
      bundle.db
        .select()
        .from(balanceAnchors)
        .where(eq(balanceAnchors.accountId, brokerageId))
        .all(),
    ).toEqual([]);
  });
});
