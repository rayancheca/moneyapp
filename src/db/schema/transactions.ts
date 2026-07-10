import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { categories } from "./categories";
import { importFiles, statementPeriods } from "./imports";
import { merchants } from "./merchants";
import { recurringSeries } from "./recurring";

export const CATEGORIZATION_SOURCES = [
  "user",
  "rule",
  "merchant_map",
  "bank_category",
  "claude",
  "transfer_detect",
  "credit_match",
] as const;
export type CategorizationSource = (typeof CATEGORIZATION_SOURCES)[number];

export const TRANSACTION_STATUSES = ["active", "quarantined", "excluded", "superseded"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * Immutable ledger rows (amount/date/description never edited in place —
 * corrections happen via re-parse or manual adjustment transactions).
 * amount_cents is net-worth-signed. dedupe_hash covers RAW description +
 * occurrence_index; unique among non-superseded rows per account.
 */
export const transactions = sqliteTable(
  "transactions",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    importFileId: text("import_file_id").references(() => importFiles.id),
    statementPeriodId: text("statement_period_id").references(() => statementPeriods.id),
    postedOn: text("posted_on").notNull(),
    transactedOn: text("transacted_on"),
    amountCents: integer("amount_cents").notNull(),
    rawDescription: text("raw_description").notNull(),
    normalizedDescription: text("normalized_description").notNull(),
    bankCategory: text("bank_category"),
    merchantId: text("merchant_id").references(() => merchants.id),
    categoryId: text("category_id").references(() => categories.id),
    categorizationSource: text("categorization_source", { enum: CATEGORIZATION_SOURCES }),
    categorizationConfidence: real("categorization_confidence"),
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: TRANSACTION_STATUSES }).notNull().default("active"),
    transferGroupId: text("transfer_group_id"),
    recurringSeriesId: text("recurring_series_id").references(() => recurringSeries.id),
    fitid: text("fitid"),
    occurrenceIndex: integer("occurrence_index").notNull().default(0),
    dedupeHash: text("dedupe_hash").notNull(),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_transactions_account_dedupe")
      .on(table.accountId, table.dedupeHash)
      .where(sql`status != 'superseded'`),
    index("ix_transactions_account_posted").on(table.accountId, table.postedOn),
    index("ix_transactions_category_posted").on(table.categoryId, table.postedOn),
    index("ix_transactions_merchant").on(table.merchantId),
    index("ix_transactions_transfer_group").on(table.transferGroupId),
  ],
);
