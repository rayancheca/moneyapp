/** The record backfills' shared pieces: the files read again (`import-records/reread`), and the tables they leave alone. */
export { rereadImported, type ReadAgain, type RereadResult } from "@/services/import/import-records/reread";

/** Every table a record-only write must leave alone, hashed row by row. */
export const LEDGER_TABLES = [
  "transactions",
  "statement_periods",
  "balance_anchors",
  "daily_balances",
  "import_files",
  "accounts",
  "transaction_splits",
  "duplicate_candidates",
  // what un-imports keep for a later import to give back — a backfill never touches it
  "unimported_transfer_legs",
  "unimported_row_attributes",
] as const;
