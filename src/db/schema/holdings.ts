import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";

export const ASSET_TYPES = ["stock", "etf", "crypto"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * quantity_e8: integer 1e-8 units — exact for fractional shares and ETH.
 * avg_cost feeds P/L display only; market value drives net worth.
 */
export const holdings = sqliteTable(
  "holdings",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    symbol: text("symbol").notNull(),
    assetType: text("asset_type", { enum: ASSET_TYPES }).notNull(),
    quantityE8: integer("quantity_e8").notNull(),
    avgCostCents: integer("avg_cost_cents"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps(),
  },
  (table) => [uniqueIndex("ux_holdings_account_symbol").on(table.accountId, table.symbol)],
);

export const PRICE_SOURCES = ["yahoo", "coinbase", "coingecko", "stooq", "manual"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/**
 * Market data is REAL (observations, not ledger). Uniqueness includes
 * asset_type: bare "ETH" is both Ethereum and a NYSE ticker — provider
 * lookups are always keyed by (symbol, asset_type).
 */
export const priceCache = sqliteTable(
  "price_cache",
  {
    id: id(),
    symbol: text("symbol").notNull(),
    assetType: text("asset_type", { enum: ASSET_TYPES }).notNull(),
    quotedOn: text("quoted_on").notNull(),
    close: real("close").notNull(),
    source: text("source", { enum: PRICE_SOURCES }).notNull(),
    fetchedAt: text("fetched_at").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_price_cache_symbol_type_date").on(
      table.symbol,
      table.assetType,
      table.quotedOn,
    ),
  ],
);

/**
 * Intraday ticks — a SEPARATE table, not a looser index on price_cache.
 *
 * price_cache is one row per (symbol, asset_type, DAY) and everything that reads
 * a "close" depends on that: the daily series, net worth, realized P/L, the
 * benchmark. Widening its unique index to admit a time would let a mid-session
 * tick satisfy a lookup that means "the close", and every one of those readers
 * would silently start answering with whatever was fetched last. Two tables
 * keeps "the close" a single row and makes the 1D view ask for something else
 * by name.
 *
 * `quoted_at` is a full ISO-8601 UTC instant (…Z), so it sorts lexically the way
 * quoted_on does and needs no parsing to range-scan.
 *
 * This table is DISPOSABLE and deliberately shallow: it backs the 1D view only,
 * so the refresh prunes anything older than a couple of sessions. 78 five-minute
 * ticks per symbol per day would otherwise reach seven figures inside two years
 * for a portfolio this size, to answer a question only ever asked about today.
 */
export const priceIntraday = sqliteTable(
  "price_intraday",
  {
    id: id(),
    symbol: text("symbol").notNull(),
    assetType: text("asset_type", { enum: ASSET_TYPES }).notNull(),
    quotedAt: text("quoted_at").notNull(),
    close: real("close").notNull(),
    source: text("source", { enum: PRICE_SOURCES }).notNull(),
    fetchedAt: text("fetched_at").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_price_intraday_symbol_type_at").on(
      table.symbol,
      table.assetType,
      table.quotedAt,
    ),
  ],
);
