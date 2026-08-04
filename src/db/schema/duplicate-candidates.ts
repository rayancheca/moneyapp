import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { TRANSACTION_STATUSES, transactions } from "./transactions";

/**
 * Cross-source duplicate money, recorded as a PAIR the owner can act on.
 *
 * `transactions.needs_review` is a bare boolean with no reason attached, and
 * fifteen code paths clear it — categorizing a row, marking a cluster reviewed,
 * linking a transfer, or the one-click "mark all reviewed" amnesty. So the
 * previous design could tell the owner a double count existed and then lose
 * that fact to an unrelated click, with nothing to re-derive it and no way to
 * say WHY the row was flagged. This table is the durable record: which two rows,
 * why, and what the owner decided.
 *
 * Resolution is always the owner's call and always reversible. A confirmed pair
 * retires ONE side (`transactions.status = 'superseded'`, out of balance replay
 * and out of every total) and remembers which — never a delete, and never an
 * automatic winner. An earlier revision picked winners itself on (day, amount)
 * alone and silently destroyed real charges (reverted in 3e5a7fc).
 */
export const DUPLICATE_REASONS = ["cross_source_same_day"] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

export const DUPLICATE_RESOLUTIONS = ["unresolved", "confirmed_duplicate", "dismissed"] as const;
export type DuplicateResolution = (typeof DUPLICATE_RESOLUTIONS)[number];

export const duplicateCandidates = sqliteTable(
  "duplicate_candidates",
  {
    id: id(),
    /**
     * Denormalized, and safe to denormalize: the detector requires
     * `t1.account_id = t2.account_id`, and ledger rows are immutable, so it
     * cannot drift from either side. It lets the duplicates surface filter by
     * account without two joins into a 9,827-row table.
     */
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /**
     * The pair, canonically ordered so `a < b` lexicographically — uuidv7 ids
     * are lowercase hex, so JS `<` and SQLite's BINARY collation agree.
     * Normalization happens in `recordDuplicateCandidate`, the single writer.
     *
     * NULLABLE with ON DELETE SET NULL, deliberately, and NOT cascade. Rows are
     * genuinely hard-deleted (unimportFile, deleteManualTransaction) under
     * `foreign_keys = ON`, so a plain reference would throw — but cascading
     * would silently delete the owner's OWN verdict along with the row, and
     * `unimportFile` re-runs the detector fifteen lines after its delete, so a
     * dismissed pair would come straight back as unresolved. Keeping the row
     * with a null side preserves the decision and the `pair_key` that carries
     * it forward.
     */
    transactionIdA: text("transaction_id_a").references(() => transactions.id, {
      onDelete: "set null",
    }),
    transactionIdB: text("transaction_id_b").references(() => transactions.id, {
      onDelete: "set null",
    }),
    /**
     * Content identity of the pair — see `duplicatePairKey`. Survives the ids
     * changing, which they do on any unimport→re-import: the same two charges
     * come back as brand-new rows. Without it, "not a duplicate" would have to
     * be answered again after every re-import, which is the same
     * import-order-dependence this table exists to end.
     */
    pairKey: text("pair_key").notNull(),
    reason: text("reason", { enum: DUPLICATE_REASONS }).notNull(),
    /** the sentence shown to the owner, with the real amount and date in it */
    reasonDetail: text("reason_detail").notNull(),
    resolution: text("resolution", { enum: DUPLICATE_RESOLUTIONS }).notNull().default("unresolved"),
    resolvedAt: text("resolved_at"),
    /**
     * Set only alongside `resolution = 'confirmed_duplicate'`, and always equal
     * to `transaction_id_a` or `transaction_id_b`. Storing the id rather than an
     * 'a' | 'b' flag means undo never has to re-derive which side lost.
     */
    retiredTransactionId: text("retired_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    /**
     * The status the retired row held before it was retired, so undo restores
     * what was there rather than assuming 'active'. A pair can legitimately
     * contain an `excluded` row — excluded hides a row from analytics but its
     * money still moves through balance replay, which is exactly why an excluded
     * twin double-counts net worth and why the detector admits one. Restoring it
     * as 'active' would silently undo a decision the owner made for his own
     * reasons.
     */
    retiredFromStatus: text("retired_from_status", { enum: TRANSACTION_STATUSES }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_duplicate_candidates_txn_a_b").on(table.transactionIdA, table.transactionIdB),
    index("ix_duplicate_candidates_txn_b").on(table.transactionIdB),
    index("ix_duplicate_candidates_pair_key").on(table.pairKey),
    index("ix_duplicate_candidates_resolution_account").on(table.resolution, table.accountId),
  ],
);
