import { integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { institutions } from "./institutions";

export const ACCOUNT_TYPES = ["checking", "savings", "credit", "investment"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = ["brokerage", "crypto"] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

/**
 * Debit cards are intentionally NOT accounts — they spend from checking.
 * Liability status is derived from type === 'credit', never stored.
 */
export const accounts = sqliteTable("accounts", {
  id: id(),
  institutionId: text("institution_id")
    .notNull()
    .references(() => institutions.id),
  name: text("name").notNull(),
  type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
  subtype: text("subtype", { enum: ACCOUNT_SUBTYPES }),
  last4: text("last4"),
  currency: text("currency").notNull().default("USD"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  /**
   * S6: a credit card's funding account (checking/savings). Lets transfer
   * detection pair card payments between the linked accounts without a
   * descriptor hint. Service-validated (credit accounts only, never self).
   */
  paymentSourceAccountId: text("payment_source_account_id"),
  /**
   * On an INVESTMENT account: the cash account whose statement section it holds the positions of — the pair the
   * owner decided on 2026-09-15 for Robinhood #655929651, where "Robinhood Agentic" keeps the unspent cash and its
   * brokerage book holds what the agent bought (as Robinhood Cash and Robinhood Brokerage split #487513525).
   *
   * ⛔ A stored LINK, never a name match. The import routes a section's positions through it
   * (`AccountHint.bookOf`), and the portfolio decides whose returns a book belongs to through it
   * (`lib/account-side` `isOwnPortfolioBook`). At most one book per cash account: the unique index is what makes
   * the import's creation of a book idempotent (SQLite unique indexes admit any number of NULLs).
   */
  cashAccountId: text("cash_account_id").references((): AnySQLiteColumn => accounts.id),
  ...timestamps(),
}, (table) => [uniqueIndex("ux_accounts_cash_account").on(table.cashAccountId)]);

export const isLiability = (type: AccountType): boolean => type === "credit";
