import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { CATEGORIZATION_SOURCES, SERIES_LINK_SOURCES } from "./transactions";

/**
 * What the owner had set on a row an un-import deleted, kept until an import writes the same line again
 * (`services/import/unimported-attributes`). One row per deleted row that carried anything no import derives again:
 * the columns an import matches a line by (the money's identity and its words, and the row's `dedupe_hash`, which an
 * unchanged read of the same line reproduces), and the attributes the re-parse carry-forward moves — a category no
 * engine of an import sets again (a hand-set one, Claude's, or one with no recorded source), the note, the recurring
 * link or the owner's "not this one", the exclusion, and the split parts (JSON, as `transaction_splits` holds them).
 *
 * No foreign keys: a category, merchant, series or account may be deleted while the record waits, and the record must
 * not stop that; an import gives back only what still exists.
 *
 * ⚖️ Owner, 2026-09-16 (decision 18): an un-import → re-import round trip gives back the hand categories, notes and
 * recurring links on the rows it removed, as it does for hand-linked transfers (`unimported_transfer_legs`).
 * 🔴 Measured on a copy of the real ledger, 2026-09-16, before the statement-copies backfill: a round trip of
 * sofi-statement-2025-03.pdf moved 27 rows (−$4,355.96) to Uncategorized — 10 categorized by hand, 17 with no
 * recorded source.
 */
export const unimportedRowAttributes = sqliteTable(
  "unimported_row_attributes",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    postedOn: text("posted_on").notNull(),
    transactedOn: text("transacted_on"),
    amountCents: integer("amount_cents").notNull(),
    normalizedDescription: text("normalized_description").notNull(),
    dedupeHash: text("dedupe_hash").notNull(),
    categoryId: text("category_id"),
    categorizationSource: text("categorization_source", { enum: CATEGORIZATION_SOURCES }),
    categorizationConfidence: real("categorization_confidence"),
    merchantId: text("merchant_id"),
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    recurringSeriesId: text("recurring_series_id"),
    seriesLinkSource: text("series_link_source", { enum: SERIES_LINK_SOURCES }),
    excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
    /** the split parts, `[{ categoryId, amountCents, note, sortOrder }]`, or null */
    splits: text("splits"),
    ...timestamps(),
  },
  (table) => [index("ix_unimported_row_attributes_account").on(table.accountId, table.postedOn)],
);
