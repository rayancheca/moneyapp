import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { transactions } from "./transactions";

/**
 * One PASS-2 transfer-ambiguity QUESTION, and the owner's answer to it.
 *
 * `detectTransfers` PASS 2 asks "this outflow has equal-cent counterparts —
 * which one is its partner?" by setting `transactions.needs_review`. That
 * boolean carries no reason and no memory: the answer the owner gives is a
 * categorization, which CLEARS needs_review, and the very next import re-runs
 * PASS 2, re-derives the same question and sets the flag straight back. The
 * queue therefore never drains, and an owner who learns a queue cannot be
 * emptied stops reading it.
 *
 * This is the durable half — which question, why, and what was decided —
 * mirroring `duplicate_candidates`, which solved the identical problem for
 * cross-source duplicates. Nothing here moves money or clears a flag: the row
 * is a verdict, and PASS 2 consults it before it flags.
 */
export const TRANSFER_AMBIGUITY_RESOLUTIONS = ["unresolved", "dismissed"] as const;
export type TransferAmbiguityResolution = (typeof TRANSFER_AMBIGUITY_RESOLUTIONS)[number];

export const transferAmbiguities = sqliteTable(
  "transfer_ambiguities",
  {
    id: id(),
    /**
     * The ANCHOR outflow's account. Denormalized, and safe: PASS 2 derives one
     * question per anchor and ledger rows are immutable, so it cannot drift.
     * It lets a review surface scope by account without a join.
     */
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /**
     * Content identity of the question — see `transferAmbiguityKey`. Survives
     * the ids changing, which they do on every unimport→re-import: the same
     * charges come back as brand-new rows. A key built from ids would forget
     * the answer exactly when the owner re-imports, which is the
     * import-order-dependence this table exists to end. It is the same
     * doctrine as `duplicate_candidates.pair_key`, and deliberate.
     */
    ambiguityKey: text("ambiguity_key").notNull(),
    /**
     * Provenance only — where the question was last seen, so a surface can
     * reach the live row. NULLABLE with ON DELETE SET NULL, deliberately, and
     * NOT cascade: rows are genuinely hard-deleted (unimportFile,
     * deleteManualTransaction) under `foreign_keys = ON`, and cascading would
     * delete the owner's own verdict along with the row it happened to be
     * pointing at. The key, not this column, is what carries the answer.
     */
    anchorTransactionId: text("anchor_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    /** how many equal-cent counterparts the question offered — part of the key */
    legCount: integer("leg_count").notNull(),
    /** the sentence shown to the owner, with the real amount and date in it */
    reasonDetail: text("reason_detail").notNull(),
    resolution: text("resolution", { enum: TRANSFER_AMBIGUITY_RESOLUTIONS })
      .notNull()
      .default("unresolved"),
    resolvedAt: text("resolved_at"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_transfer_ambiguities_key").on(table.ambiguityKey),
    index("ix_transfer_ambiguities_resolution_account").on(table.resolution, table.accountId),
    index("ix_transfer_ambiguities_anchor").on(table.anchorTransactionId),
  ],
);
