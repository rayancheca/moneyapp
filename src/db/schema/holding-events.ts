import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { ASSET_TYPES } from "./holdings";

/**
 * The crypto quantity timeline (master-plan Phase 7 "crypto history v1"):
 * signed quantity deltas per (account, symbol) — cumulative sum × cached
 * daily closes derives the account's daily_balances curve. Also appended
 * by upsertHolding for every quantity change, so any holding's history
 * stays reconstructible.
 */
export const holdingEvents = sqliteTable(
  "holding_events",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    symbol: text("symbol").notNull(),
    assetType: text("asset_type", { enum: ASSET_TYPES }).notNull(),
    occurredOn: text("occurred_on").notNull(),
    /** signed 1e-8 units — buys positive, sells negative */
    quantityDeltaE8: integer("quantity_delta_e8").notNull(),
    /** optional cost of this event in cents (display/P-L only, never net worth) */
    costCents: integer("cost_cents"),
    note: text("note"),
    ...timestamps(),
  },
  (table) => [
    index("ix_holding_events_account_symbol_date").on(
      table.accountId,
      table.symbol,
      table.occurredOn,
    ),
  ],
);
