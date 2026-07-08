import { integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { institutions } from "./institutions";

export const FILE_FORMATS = ["csv", "ofx", "qfx", "pdf"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export const IMPORT_STATUSES = [
  "parsed",
  "failed",
  "needs_claude",
  "parsed_with_claude",
  "superseded",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * One row per physical file ever ingested; originals live in data/originals/.
 * Idempotency is per (file_sha256, parser_version) so a fixed parser can
 * always re-parse the same file (schema.md lifecycle rules).
 */
export const importFiles = sqliteTable(
  "import_files",
  {
    id: id(),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    format: text("format", { enum: FILE_FORMATS }).notNull(),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id),
    parserProfile: text("parser_profile"),
    parserVersion: integer("parser_version").notNull().default(1),
    status: text("status", { enum: IMPORT_STATUSES }).notNull(),
    supersededBy: text("superseded_by").references((): AnySQLiteColumn => importFiles.id),
    error: text("error"),
    storagePath: text("storage_path").notNull(),
    importedAt: text("imported_at").notNull(),
    ...timestamps(),
  },
  (table) => [uniqueIndex("ux_import_files_sha_parser").on(table.fileSha256, table.parserVersion)],
);

export const RECONCILIATION_STATES = [
  "reconciled",
  "gap",
  "accepted",
  "value_anchor",
  "not_applicable",
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

/**
 * A file can cover multiple accounts (SoFi combined PDFs). Period membership
 * for reconciliation is BY DATE-RANGE over the account's active transactions;
 * transactions.statement_period_id is provenance-only (schema.md).
 * Investment periods use the value-anchor identity with market_change_cents.
 */
export const statementPeriods = sqliteTable(
  "statement_periods",
  {
    id: id(),
    importFileId: text("import_file_id")
      .notNull()
      .references(() => importFiles.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    beginningBalanceCents: integer("beginning_balance_cents"),
    endingBalanceCents: integer("ending_balance_cents"),
    marketChangeCents: integer("market_change_cents"),
    reconciliation: text("reconciliation", { enum: RECONCILIATION_STATES }).notNull(),
    gapCents: integer("gap_cents"),
    ...timestamps(),
  },
  (table) => [uniqueIndex("ux_statement_periods_file_account").on(table.importFileId, table.accountId)],
);
