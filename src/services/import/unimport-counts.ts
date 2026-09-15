import { eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { importFiles } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { attachedRow, parsedRow } from "./attached-rows";

/**
 * What un-importing a file does to its rows, counted on the rows `unimportFile`
 * deletes (what the file parsed) and keeps (what was attached to it) — the
 * /imports confirmation's numbers, with the same predicates the delete uses.
 */
export interface UnimportCounts {
  /** rows the file parsed — every one is deleted */
  deleted: number;
  /**
   * live rows attached to the file — detached and kept, with their money.
   * 🔴 A superseded attached row is history: no money in the ledger and no
   * transfer. The un-import detaches it too (its file is deleted) and never
   * deletes it, but it is not a row the confirmation may say "keeps its money,
   * category, transfer and recurring links". A version bump leaves such rows
   * under the retired file, and `redate-sapphire-0630-payment-2026-09-15.ts`
   * leaves one under a LIVE statement beside its successor: counting it said
   * "5 rows" over 20260702-statements-9805-.pdf's 4 (review, 2026-09-15).
   */
  kept: number;
  /** deleted rows the owner categorized BY HAND: the work that cannot come back */
  userCategorizedDeleted: number;
  /** the deleted rows' money in the ledger — active rows only */
  inflowCents: number;
  outflowCents: number;
  /** deleted rows that are the surviving half of a confirmed duplicate */
  duplicateSurvivors: number;
  /** deleted rows that hold a transfer group */
  transferLegsDeleted: number;
  /** kept rows that hold a transfer group */
  transferLegsKept: number;
  /**
   * kept legs whose group holds another live row the un-import does not delete.
   * 🔴 The confirmation called every kept leg "still linked": on 2026-09-15 one of
   * 20260302-statements-9805-.pdf's five (+$115.00, 2026-03-02) and one of
   * 20250702's two (+$20.00, 2025-06-10) were alone in their groups (read-only,
   * real ledger), until `link-sapphire-one-leg-groups-2026-09-15.ts` linked both
   * the same day. A partner the file parsed is deleted, and the un-import then
   * unlinks the kept leg (`legsLeftAloneBy`); a superseded member is no transfer.
   * Read on the ledger as it stands: a retired twin the un-import restores is
   * not foreseen, as `duplicateSurvivors` explains.
   */
  transferLegsKeptLinked: number;
}

/** A file with no rows: nothing deleted, nothing kept. */
export const NO_UNIMPORT_ROWS: UnimportCounts = {
  deleted: 0,
  kept: 0,
  userCategorizedDeleted: 0,
  inflowCents: 0,
  outflowCents: 0,
  duplicateSurvivors: 0,
  transferLegsDeleted: 0,
  transferLegsKept: 0,
  transferLegsKeptLinked: 0,
};

/** Every import file's counts, in ONE grouped query; a file with no rows counts zero throughout. */
export function unimportCountsByFile(db: AppDatabase): Map<string, UnimportCounts> {
  // a left join's empty side has a NULL marker too, so a parsed row needs a row
  const deleted = sql`(${transactions.id} IS NOT NULL AND ${parsedRow()})`;
  const kept = sql`(${attachedRow()} AND ${transactions.status} <> 'superseded')`;
  const tally = (when: ReturnType<typeof sql>) => sql<number>`coalesce(sum(case when ${when} then 1 else 0 end), 0)`;
  const rows = db
    .select({
      fileId: importFiles.id,
      deleted: tally(deleted),
      kept: tally(kept),
      userCategorizedDeleted: tally(sql`${deleted} AND ${transactions.categorizationSource} = 'user'`),
      /*
       * 🔴 The MONEY line names the ledger, and a superseded row is not in it.
       * `rocket-money-export-2026-08-25.csv` holds 39 rows, every one of them
       * `superseded`, and the confirmation offered "Money leaving the ledger:
       * $6,447.92 in · $4,051.25 out" — of a file whose rows no total on this
       * app can see. Eleven files are in that state.
       *
       * The row COUNT stays whole: 39 rows really are deleted, and pairing that
       * with $0.00 is the honest reading of what un-importing one of these does.
       *
       * 🔴 …and an attached row's money does not leave at all (2026-09-15):
       * 20260302-statements-9805-.pdf holds $1,495.48 of payments, and $697.00
       * of it is five rows the un-import keeps.
       */
      inflowCents: sql<number>`coalesce(sum(case when ${deleted} and ${transactions.status} = 'active' and ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
      outflowCents: sql<number>`coalesce(sum(case when ${deleted} and ${transactions.status} = 'active' and ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
      /*
       * ⛔ …and some of what leaves comes straight back. `unimportFile` calls
       * `restoreDuplicatesLosingTheirSurvivor` BEFORE its delete, so a row that
       * is the surviving half of a confirmed duplicate hands its money to the
       * retired twin instead of taking it out of the ledger. All 12 rows of
       * `20250302-statements-9805-.pdf` were survivors when this was written,
       * and their twins summed to the same $4,619.92 the confirmation called
       * money leaving.
       *
       * Counted, never re-derived: the restore has slot conflicts and status
       * floors this page must not reimplement, so the confirmation names how
       * many rows are in that shape and lets the reader weigh it.
       */
      duplicateSurvivors: tally(sql`${deleted} AND exists (
        select 1 from duplicate_candidates d
        where d.resolution = 'confirmed_duplicate'
          and d.retired_transaction_id is not null
          and d.retired_transaction_id <> ${transactions.id}
          and (d.transaction_id_a = ${transactions.id} or d.transaction_id_b = ${transactions.id})
      )`),
      transferLegsDeleted: tally(sql`${deleted} AND ${transactions.transferGroupId} IS NOT NULL`),
      transferLegsKept: tally(sql`${kept} AND ${transactions.transferGroupId} IS NOT NULL`),
      // `IS`, not `=`: a partner with no file compares false, where `=` would be NULL and drop it
      transferLegsKeptLinked: tally(sql`${kept} AND ${transactions.transferGroupId} IS NOT NULL AND exists (
        select 1 from transactions o
        where o.transfer_group_id = ${transactions.transferGroupId}
          and o.id <> ${transactions.id}
          and o.status <> 'superseded'
          and not (o.import_file_id IS ${importFiles.id} and o.file_link_source IS NULL)
      )`),
    })
    .from(importFiles)
    .leftJoin(transactions, eq(transactions.importFileId, importFiles.id))
    .groupBy(importFiles.id)
    .all();
  return new Map(rows.map(({ fileId, ...counts }) => [fileId, counts]));
}
