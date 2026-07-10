import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { holdings, priceCache, type AssetType, type PriceSource } from "@/db/schema/holdings";
import { appSettings } from "@/db/schema/settings";
import { addDays, compareDates, fromEpochDay, toEpochDay, todayIso } from "@/lib/dates";
import { fakeDailyClose } from "@/lib/fake-prices";
import { rebuildAccount } from "./derivation";
import { rebuildCryptoHistory } from "./crypto-history";
import { valueCentsOf } from "./holdings";

/**
 * Price providers behind one interface (master-plan Phase 7). Lookups are
 * ALWAYS keyed by (symbol, asset_type) — bare "ETH" is both Ethereum and a
 * NYSE ticker (schema.md price_cache rationale). Crypto routes to Coinbase,
 * equities to Yahoo; MONEYAPP_FAKE_PRICES=1 swaps in a deterministic
 * synthetic provider so tests and demos never touch the network.
 */

export interface DailyClose {
  day: string;
  close: number;
}

export interface QuoteItem {
  symbol: string;
  assetType: AssetType;
}

export interface Quote extends QuoteItem {
  price: number;
  asOfDay: string;
}

export interface PriceProvider {
  readonly source: PriceSource;
  getDailyCloses(
    symbol: string,
    assetType: AssetType,
    fromDay: string,
    toDay: string,
  ): Promise<DailyClose[]>;
  getQuotes(items: readonly QuoteItem[]): Promise<Quote[]>;
}

const BACKFILL_DAYS = 730; // 2 years of daily closes

/* ── Yahoo (stocks / ETFs only) ─────────────────────────────────────── */

const yahooChartSchema = z.object({
  quotes: z.array(
    z.object({ date: z.date(), close: z.number().nullable() }).loose(),
  ),
});

const yahooQuoteSchema = z.array(
  z.object({ symbol: z.string(), regularMarketPrice: z.number().optional() }).loose(),
);

type YahooFinanceInstance = InstanceType<(typeof import("yahoo-finance2"))["default"]>;

let yahooSingleton: Promise<YahooFinanceInstance> | undefined;

/**
 * yahoo-finance2 v3 exports a class, not a ready instance (v2 did). One
 * shared instance keeps the cookie/crumb handshake to a single round-trip
 * across a multi-symbol backfill. Lazy so fake mode never loads the module;
 * promise-memoized so concurrent refreshes share one instance; reset on
 * failure so one bad load never poisons later refreshes.
 */
async function loadYahoo(): Promise<YahooFinanceInstance> {
  yahooSingleton ??= import("yahoo-finance2").then(
    ({ default: YahooFinance }) => new YahooFinance({ suppressNotices: ["yahooSurvey"] }),
  );
  try {
    return await yahooSingleton;
  } catch (error: unknown) {
    yahooSingleton = undefined;
    throw error;
  }
}

export const yahooProvider: PriceProvider = {
  source: "yahoo",

  async getDailyCloses(symbol, assetType, fromDay, toDay) {
    assertEquity(assetType, symbol);
    const yahooFinance = await loadYahoo();
    const result: unknown = await yahooFinance.chart(symbol, {
      period1: fromDay,
      // chart period2 is exclusive — include toDay itself
      period2: addDays(toDay, 1),
      interval: "1d",
    });
    const parsed = yahooChartSchema.parse(result);
    return parsed.quotes
      .filter((q): q is { date: Date; close: number } => q.close !== null)
      .map((q) => ({ day: q.date.toISOString().slice(0, 10), close: q.close }))
      .filter((q) => compareDates(q.day, fromDay) >= 0 && compareDates(q.day, toDay) <= 0);
  },

  async getQuotes(items) {
    for (const i of items) assertEquity(i.assetType, i.symbol);
    if (items.length === 0) return [];
    const yahooFinance = await loadYahoo();
    const result: unknown = await yahooFinance.quote(items.map((i) => i.symbol));
    const parsed = yahooQuoteSchema.parse(result);
    const bySymbol = new Map(parsed.map((q) => [q.symbol, q.regularMarketPrice]));
    const day = todayIso();
    return items.flatMap((i) => {
      const price = bySymbol.get(i.symbol);
      return price === undefined ? [] : [{ ...i, price, asOfDay: day }];
    });
  },
};

function assertEquity(assetType: AssetType, symbol: string): void {
  if (assetType === "crypto") {
    throw new Error(`yahooProvider cannot price crypto symbol ${symbol}`);
  }
}

/* ── Coinbase Exchange (crypto only) ────────────────────────────────── */

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const CANDLES_PER_CALL = 300; // documented Coinbase page size

// candle = [time, low, high, open, close, volume]
const coinbaseCandlesSchema = z.array(z.tuple([z.number()]).rest(z.number()));
const coinbaseTickerSchema = z.object({ price: z.string() }).loose();

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "MoneyApp/0.1 (local-first)" } });
  if (!res.ok) throw new Error(`Coinbase ${res.status} for ${url}`);
  return res.json() as Promise<unknown>;
}

export const coinbaseProvider: PriceProvider = {
  source: "coinbase",

  async getDailyCloses(symbol, assetType, fromDay, toDay) {
    assertCrypto(assetType, symbol);
    const closes = new Map<string, number>();
    // paginate in ≤300-candle windows, oldest first
    let windowStart = toEpochDay(fromDay);
    const endDay = toEpochDay(toDay);
    while (windowStart <= endDay) {
      const windowEnd = Math.min(windowStart + CANDLES_PER_CALL - 1, endDay);
      const url =
        `${COINBASE_BASE}/products/${symbol}-USD/candles?granularity=86400` +
        `&start=${fromEpochDay(windowStart)}T00:00:00Z&end=${fromEpochDay(windowEnd)}T00:00:00Z`;
      const candles = coinbaseCandlesSchema.parse(await fetchJson(url));
      for (const candle of candles) {
        const [time, , , , close] = candle;
        if (close === undefined) continue;
        const day = new Date(time * 1000).toISOString().slice(0, 10);
        if (compareDates(day, fromDay) >= 0 && compareDates(day, toDay) <= 0) {
          closes.set(day, close);
        }
      }
      windowStart = windowEnd + 1;
    }
    return [...closes.entries()]
      .map(([day, close]) => ({ day, close }))
      .sort((a, b) => compareDates(a.day, b.day));
  },

  async getQuotes(items) {
    const day = todayIso();
    const quotes: Quote[] = [];
    for (const item of items) {
      assertCrypto(item.assetType, item.symbol);
      const raw = await fetchJson(`${COINBASE_BASE}/products/${item.symbol}-USD/ticker`);
      const parsed = coinbaseTickerSchema.parse(raw);
      const price = Number(parsed.price);
      if (!Number.isFinite(price)) throw new Error(`Bad Coinbase price for ${item.symbol}`);
      quotes.push({ ...item, price, asOfDay: day });
    }
    return quotes;
  },
};

function assertCrypto(assetType: AssetType, symbol: string): void {
  if (assetType !== "crypto") {
    throw new Error(`coinbaseProvider only prices crypto (got ${assetType} ${symbol})`);
  }
}

/* ── Fake provider (MONEYAPP_FAKE_PRICES=1) ─────────────────────────── */

/**
 * Deterministic synthetic close — delegates to the SINGLE shared walk in
 * src/lib/fake-prices.ts, the same one the fixture simulator used to print
 * brokerage statement values. Demo price history and statement anchors must
 * tell one coherent story.
 */
export function fakeCloseFor(symbol: string, day: string): number {
  return fakeDailyClose(symbol, day);
}

function fakeWalk(symbol: string, fromDay: string, toDay: string): DailyClose[] {
  const out: DailyClose[] = [];
  for (let d = toEpochDay(fromDay); d <= toEpochDay(toDay); d++) {
    const day = fromEpochDay(d);
    out.push({ day, close: fakeDailyClose(symbol, day) });
  }
  return out;
}

export const fakeProvider: PriceProvider = {
  source: "manual",

  getDailyCloses(symbol, _assetType, fromDay, toDay) {
    return Promise.resolve(fakeWalk(symbol, fromDay, toDay));
  },

  getQuotes(items) {
    const day = todayIso();
    return Promise.resolve(
      items.map((i) => ({ ...i, price: fakeCloseFor(i.symbol, day), asOfDay: day })),
    );
  },
};

/* ── Routing ────────────────────────────────────────────────────────── */

export type ProviderLookup = (assetType: AssetType) => PriceProvider;

export const getProvider: ProviderLookup = (assetType) => {
  if (process.env.MONEYAPP_FAKE_PRICES === "1") return fakeProvider;
  return assetType === "crypto" ? coinbaseProvider : yahooProvider;
};

/* ── Refresh: backfill + quotes + live anchors ──────────────────────── */

export interface RefreshOptions {
  now?: Date;
  /** dependency injection for tests (call counting, fault injection) */
  providers?: ProviderLookup;
}

export interface RefreshResult {
  backfilledRows: number;
  quotedSymbols: number;
  skippedFresh: number;
  anchoredAccounts: number;
  /** provider failures degrade to cached prices — never an error page */
  errors: string[];
}

const MS_PER_HOUR = 3_600_000;

function stalenessHours(db: AppDatabase): number {
  const row = db.select().from(appSettings).where(eq(appSettings.key, "priceStalenessHours")).get();
  if (!row) return 4;
  const parsed: unknown = JSON.parse(row.value);
  return typeof parsed === "number" && parsed >= 0 ? parsed : 4;
}

function latestCacheRow(db: AppDatabase, symbol: string, assetType: AssetType) {
  return db
    .select()
    .from(priceCache)
    .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, assetType)))
    .orderBy(desc(priceCache.quotedOn))
    .limit(1)
    .get();
}

function upsertClose(
  db: AppDatabase,
  row: { symbol: string; assetType: AssetType; quotedOn: string; close: number },
  source: PriceSource,
  fetchedAt: string,
): void {
  db.insert(priceCache)
    .values({ ...row, source, fetchedAt })
    .onConflictDoUpdate({
      target: [priceCache.symbol, priceCache.assetType, priceCache.quotedOn],
      set: { close: row.close, source, fetchedAt },
    })
    .run();
}

/**
 * The live-value flow (master-plan Phase 7): backfill missing daily closes
 * (2y once, then only the gap since the last cached day), refresh quotes
 * unless fresh per priceStalenessHours, upsert a source='live' anchor dated
 * today on every investment account, rebuild derived balances, and rebuild
 * the crypto quantity-timeline curve for crypto-subtype accounts.
 */
export async function refreshPrices(
  db: AppDatabase,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const now = options.now ?? new Date();
  const providers = options.providers ?? getProvider;
  const today = todayIso(now);
  const fetchedAt = now.toISOString();
  const freshWindowMs = stalenessHours(db) * MS_PER_HOUR;

  const result: RefreshResult = {
    backfilledRows: 0,
    quotedSymbols: 0,
    skippedFresh: 0,
    anchoredAccounts: 0,
    errors: [],
  };

  const activeHoldings = db.select().from(holdings).where(eq(holdings.isActive, true)).all();
  const distinct = new Map<string, QuoteItem>();
  for (const h of activeHoldings) {
    distinct.set(`${h.symbol} ${h.assetType}`, { symbol: h.symbol, assetType: h.assetType });
  }

  const toQuote: QuoteItem[] = [];
  for (const item of distinct.values()) {
    const latest = latestCacheRow(db, item.symbol, item.assetType);
    const isFresh =
      latest !== undefined && now.getTime() - Date.parse(latest.fetchedAt) < freshWindowMs;
    if (isFresh) {
      result.skippedFresh += 1;
      continue;
    }

    // backfill the gap: from the day after the last cached close (2y back if empty)
    const from = latest ? addDays(latest.quotedOn, 1) : addDays(today, -BACKFILL_DAYS);
    if (compareDates(from, today) <= 0) {
      try {
        const provider = providers(item.assetType);
        const closes = await provider.getDailyCloses(item.symbol, item.assetType, from, today);
        db.transaction((tx) => {
          for (const c of closes) {
            upsertClose(
              tx as unknown as AppDatabase,
              { symbol: item.symbol, assetType: item.assetType, quotedOn: c.day, close: c.close },
              provider.source,
              fetchedAt,
            );
          }
        });
        result.backfilledRows += closes.length;
      } catch (error: unknown) {
        result.errors.push(`backfill ${item.symbol}/${item.assetType}: ${messageOf(error)}`);
      }
    }
    toQuote.push(item);
  }

  // quotes are batched per provider; today's quote becomes today's close
  const byProvider = new Map<PriceProvider, QuoteItem[]>();
  for (const item of toQuote) {
    const provider = providers(item.assetType);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), item]);
  }
  for (const [provider, items] of byProvider) {
    try {
      const quotes = await provider.getQuotes(items);
      db.transaction((tx) => {
        for (const q of quotes) {
          upsertClose(
            tx as unknown as AppDatabase,
            { symbol: q.symbol, assetType: q.assetType, quotedOn: today, close: q.price },
            provider.source,
            fetchedAt,
          );
        }
      });
      result.quotedSymbols += quotes.length;
    } catch (error: unknown) {
      result.errors.push(`quotes ${provider.source}: ${messageOf(error)}`);
    }
  }

  // live anchors: net worth reflects market value by construction
  const investmentAccounts = db
    .select()
    .from(accounts)
    .where(eq(accounts.type, "investment"))
    .all();
  for (const account of investmentAccounts) {
    const accountHoldings = activeHoldings.filter((h) => h.accountId === account.id);
    if (accountHoldings.length === 0) continue;

    let valueCents = 0;
    let priced = 0;
    for (const h of accountHoldings) {
      const latest = latestCacheRow(db, h.symbol, h.assetType);
      if (!latest) continue;
      valueCents += valueCentsOf(h.quantityE8, latest.close);
      priced += 1;
    }
    if (priced === 0) continue; // no cached price at all — never invent a level

    db.insert(balanceAnchors)
      .values({
        accountId: account.id,
        anchoredOn: today,
        balanceCents: valueCents,
        source: "live",
      })
      .onConflictDoUpdate({
        target: [balanceAnchors.accountId, balanceAnchors.anchoredOn, balanceAnchors.source],
        set: { balanceCents: valueCents },
      })
      .run();

    rebuildAccount(db, account.id, today);
    if (account.subtype === "crypto") {
      rebuildCryptoHistory(db, account.id, today);
    }
    result.anchoredAccounts += 1;
  }

  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
