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
