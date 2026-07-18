import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { categories } from "./categories";
import { transactions } from "./transactions";

/**
 * Category-allocation overlay for a single transaction (RocketMoney-style
 * splits). The parent ledger row's amount_cents stays the immutable source of
 * truth for balances/dedupe/recurring/transfer-pairing — splits ONLY
 * re-attribute that amount across categories for spend/income analytics, and
 * never touch the derived daily_balances cache.
 *
 * Invariant (enforced in the service layer — SQLite has no cross-table CHECK):
 * the parts of a transaction sum EXACTLY to the parent's amount_cents, there are
 * at least two of them, each is non-zero and shares the parent's sign, and every
 * part carries a category. Whether a transaction "has splits" is DERIVED
 * (EXISTS in this table), never a stored flag — matching the codebase's
 * derive-state-from-data preference (cf. manual = importFileId IS NULL).
 *
 * Rows cascade-delete with the parent transaction; a soft-superseded parent
 * keeps its splits but is excluded from analytics by the status='active' filter,
 * so stale splits on an inactive row are never read.
 */
export const transactionSplits = sqliteTable(
  "transaction_splits",
  {
    id: id(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    amountCents: integer("amount_cents").notNull(),
    note: text("note"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [index("ix_transaction_splits_txn").on(table.transactionId)],
);
