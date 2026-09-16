import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { ASSET_TYPES } from "./holdings";
import { importFiles } from "./imports";

/**
 * `trade` — a buy, a sell, or shares received (a dividend reinvestment is a
 * genuine acquisition and stays a trade). `split` — a corporate action that
 * restates the share count and moves no money.
 */
export const HOLDING_EVENT_KINDS = ["trade", "split"] as const;
export type HoldingEventKind = (typeof HOLDING_EVENT_KINDS)[number];

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
    /**
     * What KIND of quantity change this is.
     *
     * ⛔ A `split` is not a trade and must never be valued as one. The ledger
     * records Coca-Cola Consolidated's 10-for-1 (2025-05-27) as a delta of
     * `+9.013095`, and without this column the valuation had no way to tell that
     * from a purchase: it published a $1,017.85 contribution on a day nothing
     * was bought, and every day BEFORE it valued pre-split shares against
     * split-adjusted closes — a tenth of the truth for 60 trading days.
     *
     * ⚠️ The RATIO is deliberately not stored beside it. `Q → Q + delta` fixes
     * the ratio at `(Q + delta) / Q` and nothing else can be true; a stored copy
     * would be a second number that must agree with the delta about one event.
     * See lib/split-adjust.ts, which derives it.
     */
    eventKind: text("event_kind", { enum: HOLDING_EVENT_KINDS }).notNull().default("trade"),
    note: text("note"),
    /**
     * The statement file whose Account Activity printed this trade; null for every event a script or a hand edit
     * wrote (the activity-CSV rebuild, the crypto backfills, `upsertHolding`).
     *
     * ⛔ It is what lets a statement's positions leave with the statement. Un-importing the file deletes these
     * events, and a parser-version re-read supersedes them before reading the file again — without it, a re-read
     * would add the month's shares a second time on top of the first.
     */
    importFileId: text("import_file_id").references(() => importFiles.id),
    ...timestamps(),
  },
  (table) => [
    index("ix_holding_events_account_symbol_date").on(
      table.accountId,
      table.symbol,
      table.occurredOn,
    ),
    index("ix_holding_events_import_file").on(table.importFileId),
  ],
);
