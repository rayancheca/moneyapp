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
 * A row still in the ledger: every status but `superseded`, a read a newer one retired. A quarantined row waits on its
 * statement's gap and an excluded one is out of analytics only; both are still the ledger's.
 *
 * ⛔ ONE HOME. This list was spelled out eleven times — its own `LIVE_ROW` in printed-lines, statement-copies and
 * kept-openings, and eight inline lists — all agreeing, so no behavioural test could tell a copy from the rule. A query
 * asks `inArray(transactions.status, [...LIVE_ROW])`; transactions.test.ts fails on a list of the three anywhere else
 * but `RECONCILE_STATUSES`, the rows a statement's arithmetic counts — its own rule, the same three today.
 *
 * `!= 'superseded'` is this rule's other spelling: the partial index below reads a live row so, and a lookup by dedupe
 * hash must say it the same way for SQLite to use that index. The test pins that the two agree, so a status added to
 * the type and not to this list fails there, not in a ledger.
 */
export const LIVE_ROW = ["active", "quarantined", "excluded"] as const satisfies readonly TransactionStatus[];

/**
 * Who owns a row's recurring-series link (ux-overhaul-plan §4.3). null =
 * detection owns it (may re-tag/untag freely). 'user' = the user attached or
 * unlinked this row by hand, and detection must never touch its
 * recurring_series_id again — the guard that stops merge/unlink/attach from
 * being silently reverted on the next detection run.
 */
export const SERIES_LINK_SOURCES = ["detected", "user"] as const;
export type SeriesLinkSource = (typeof SERIES_LINK_SOURCES)[number];

/**
 * How a row came to be filed under its `import_file_id`. null = the importer
 * parsed it out of that document — the only value the importer ever writes, by
 * writing nothing. 'attached' = the row was recorded without the document (by
 * hand, or reconstructed) and later filed under the statement that prints it.
 * The importer never produced it, so a re-import cannot recreate it.
 *
 * Like `series_link_source`, it stays meaningful when the link it describes is
 * gone. Un-importing the file deletes what the file parsed and DETACHES an
 * attached row — `import_file_id` NULL, this marker kept — and importing a
 * statement whose printed-balance period holds the row files it there again
 * (owner, 2026-09-15; `services/import/attached-rows`).
 */
export const FILE_LINK_SOURCES = ["attached"] as const;
export type FileLinkSource = (typeof FILE_LINK_SOURCES)[number];

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
    fileLinkSource: text("file_link_source", { enum: FILE_LINK_SOURCES }),
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
    seriesLinkSource: text("series_link_source", { enum: SERIES_LINK_SOURCES }),
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
