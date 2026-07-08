import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  ...timestamps(),
});

export const isLiability = (type: AccountType): boolean => type === "credit";
