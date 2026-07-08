import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { statementPeriods } from "./imports";

export const ANCHOR_SOURCES = ["statement", "ofx_ledger", "manual", "live"] as const;
export type AnchorSource = (typeof ANCHOR_SOURCES)[number];

/**
 * Ground-truth balances at known dates (net-worth-signed). Same-date
 * precedence: statement > ofx_ledger > manual > live — enforced in the
 * derivation service; ofx_ledger/live are moments, excluded from exact
 * chain-closure checks; 'live' is only ever written for today.
 */
export const balanceAnchors = sqliteTable(
  "balance_anchors",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    anchoredOn: text("anchored_on").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    source: text("source", { enum: ANCHOR_SOURCES }).notNull(),
    statementPeriodId: text("statement_period_id").references(() => statementPeriods.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_balance_anchors_account_date_source").on(
      table.accountId,
      table.anchoredOn,
      table.source,
    ),
  ],
);

export const BALANCE_BASES = [
  "anchored",
  "derived",
  "derived_unverified",
  "carried",
  "gap",
] as const;
export type BalanceBasis = (typeof BALANCE_BASES)[number];

/**
 * Derived cache, rebuildable at any time — levels are never invented; days
 * without coverage are basis='gap' and the net-worth total marks them partial.
 */
export const dailyBalances = sqliteTable(
  "daily_balances",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    day: text("day").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    basis: text("basis", { enum: BALANCE_BASES }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.day] })],
);
