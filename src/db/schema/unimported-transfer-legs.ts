import { index, real, sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { CATEGORIZATION_SOURCES } from "./transactions";

/**
 * The legs of a transfer an un-import took apart, kept until the same lines are imported again
 * (`services/import/unimported-transfers`). One row per leg, grouped by the transfer's old `transfer_group_id`: a leg
 * the un-import deleted is kept by its content — the columns an import matches a line by — and a leg that stayed is
 * kept by its row id (`transaction_id`, no foreign key: the row may be deleted later, and the record is then dropped).
 *
 * 🔴 Un-importing a statement unlinked the partner of every leg it deleted, and nothing linked the pair again when the
 * same line came back — detection pairs only what it can prove, and a pair linked by hand is one it could not.
 * Measured on a copy of the real ledger, 2026-09-16: a round trip of 20260812-statements-3522-.pdf lost 7 pairs and put
 * $12,975.87 of July card payments into "Uncategorized" spending.
 */
export const unimportedTransferLegs = sqliteTable(
  "unimported_transfer_legs",
  {
    id: id(),
    transferGroupId: text("transfer_group_id").notNull(),
    /** the leg that stayed; null for a leg the un-import deleted */
    transactionId: text("transaction_id"),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    postedOn: text("posted_on").notNull(),
    transactedOn: text("transacted_on"),
    amountCents: integer("amount_cents").notNull(),
    normalizedDescription: text("normalized_description").notNull(),
    /** the deleted leg's category, given back with the link when it is the pair's (a hand-set or a detected one) */
    categoryId: text("category_id"),
    categorizationSource: text("categorization_source", { enum: CATEGORIZATION_SOURCES }),
    categorizationConfidence: real("categorization_confidence"),
    ...timestamps(),
  },
  (table) => [
    index("ix_unimported_transfer_legs_group").on(table.transferGroupId),
    index("ix_unimported_transfer_legs_account").on(table.accountId, table.postedOn),
  ],
);
