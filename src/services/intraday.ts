import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { holdings, priceCache, priceIntraday, type AssetType } from "@/db/schema/holdings";
import { addDays, todayIso } from "@/lib/dates";
import { intradayPortfolioGrid, type IntradayGrid, type SymbolTicks } from "@/lib/intraday-grid";
import { getProvider, type IntradayTick, type ProviderLookup } from "./prices";

/**
 * The 1D view's own data path (owner's ask: "obviously the day view needs time
 * on x axis").
 *
 * Kept OUT of refreshPrices deliberately. That flow backfills two years of daily
 * closes, quotes every symbol and writes live balance anchors — net worth
 * depends on it. Intraday depends on none of that and nothing depends on
 * intraday: it feeds one chart window on one surface. Folding it in would make
 * every net-worth refresh pay for a chart nobody may open, and would put a
 * five-minute tick on the same failure path as the number on the dashboard.
 *
 * Everything here is scoped to ONE day. See the `price_intraday` doc comment for
 * why the table is disposable.
 */

/** Sessions kept on disk. Two, not one: "yesterday" is still the answer between
 *  midnight and the first tick of a new session, and it is the baseline the
 *  first grid point is drawn from. */
const RETAIN_DAYS = 2;

export interface IntradayRefreshOptions {
  /** the session to fetch; defaults to today */
  day?: string;
  /** dependency injection for tests (call counting, fault injection) */
  providers?: ProviderLookup;
}

export interface IntradayRefreshResult {
  symbols: number;
  ticks: number;
  prunedRows: number;
  /** provider failures degrade to whatever is cached — never an error page */
  errors: string[];
}

interface HeldSymbol {
  symbol: string;
  assetType: AssetType;
  quantityE8: number;
}

/** Distinct held symbols with a positive quantity, summed across accounts —
 *  the same book the portfolio chart values, not a per-account list. */
function heldSymbols(db: AppDatabase): HeldSymbol[] {
  return db
    .select({
      symbol: holdings.symbol,
      assetType: holdings.assetType,
      quantityE8: sql<number>`sum(${holdings.quantityE8})`,
    })
    .from(holdings)
    .where(eq(holdings.isActive, true))
    .groupBy(holdings.symbol, holdings.assetType)
    .having(sql`sum(${holdings.quantityE8}) > 0`)
    .all();
}

/** The most recent daily close STRICTLY BEFORE `day` — the baseline a session
 *  opens from, and what a symbol is valued at before its first tick. */
function priorClose(db: AppDatabase, symbol: string, assetType: AssetType, day: string): number | null {
  const row = db
    .select({ close: priceCache.close })
    .from(priceCache)
    .where(
      and(
        eq(priceCache.symbol, symbol),
        eq(priceCache.assetType, assetType),
        lt(priceCache.quotedOn, day),
      ),
    )
    .orderBy(desc(priceCache.quotedOn))
    .limit(1)
    .get();
  return row?.close ?? null;
}

/** Cached ticks for one symbol on one day, oldest first. */
export function intradayTicks(
  db: AppDatabase,
  symbol: string,
  assetType: AssetType,
  day: string,
): IntradayTick[] {
  return db
    .select({ at: priceIntraday.quotedAt, close: priceIntraday.close })
    .from(priceIntraday)
    .where(
      and(
        eq(priceIntraday.symbol, symbol),
        eq(priceIntraday.assetType, assetType),
        // half-open range on the ISO string: index-friendly, and unlike LIKE it
        // cannot be defeated by a collation setting
        gte(priceIntraday.quotedAt, `${day}T00:00:00.000Z`),
        lt(priceIntraday.quotedAt, `${addDays(day, 1)}T00:00:00.000Z`),
      ),
    )
    .orderBy(priceIntraday.quotedAt)
    .all();
}

/**
 * The whole book on one time grid for `day`. Returns an empty grid when no
 * symbol ticked — the caller says "no session yet" rather than drawing a line
 * through invented points.
 */
export function portfolioIntradayGrid(db: AppDatabase, day: string): IntradayGrid {
  const held = heldSymbols(db);
  const symbols: SymbolTicks[] = held.map((h) => ({
    symbol: h.symbol,
    quantityE8: h.quantityE8,
    priorClose: priorClose(db, h.symbol, h.assetType, day),
    ticks: intradayTicks(db, h.symbol, h.assetType, day),
  }));
  return intradayPortfolioGrid(symbols);
}

/** One holding's own session, with the baseline it opened from. */
export function holdingIntradaySession(
  db: AppDatabase,
  symbol: string,
  assetType: AssetType,
  day: string,
): { ticks: IntradayTick[]; priorClose: number | null } {
  return {
    ticks: intradayTicks(db, symbol, assetType, day),
    priorClose: priorClose(db, symbol, assetType, day),
  };
}

function writeTick(
  db: AppDatabase,
  row: { symbol: string; assetType: AssetType; quotedAt: string; close: number },
  source: (typeof priceIntraday.source)["_"]["data"],
  fetchedAt: string,
): void {
  db.insert(priceIntraday)
    .values({ ...row, source, fetchedAt })
    .onConflictDoUpdate({
      target: [priceIntraday.symbol, priceIntraday.assetType, priceIntraday.quotedAt],
      set: { close: row.close, source, fetchedAt },
    })
    .run();
}

/**
 * Fetch and cache one session for every held symbol, then drop sessions older
 * than RETAIN_DAYS.
 *
 * A per-symbol failure is collected, not thrown: one delisted ticker must not
 * cost the other holdings their session. A symbol that returns no ticks (market
 * holiday, weekend, crypto outage) is not an error at all.
 */
export async function refreshIntraday(
  db: AppDatabase,
  options: IntradayRefreshOptions = {},
): Promise<IntradayRefreshResult> {
  const day = options.day ?? todayIso();
  const lookup = options.providers ?? getProvider;
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  let ticks = 0;

  const held = heldSymbols(db);
  for (const h of held) {
    const provider = lookup(h.assetType);
    try {
      const fetched = await provider.getIntradayTicks(h.symbol, h.assetType, day);
      for (const t of fetched) {
        writeTick(db, { symbol: h.symbol, assetType: h.assetType, quotedAt: t.at, close: t.close }, provider.source, fetchedAt);
        ticks += 1;
      }
    } catch (error: unknown) {
      errors.push(`${h.symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cutoff = `${addDays(day, -(RETAIN_DAYS - 1))}T00:00:00.000Z`;
  const pruned = db.delete(priceIntraday).where(lt(priceIntraday.quotedAt, cutoff)).run();

  return { symbols: held.length, ticks, prunedRows: pruned.changes, errors };
}
