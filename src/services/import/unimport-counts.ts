import { and, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts as accountsTable } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { derivesFromHoldings } from "@/services/derivation";
import { attachedRow, parsedRow } from "./attached-rows";
import { followingOpeningsByFile, keptOpeningPlans, type KeptOpeningPlan } from "./kept-openings";
import { balancesRemovedByFileAndAccount } from "./printed-anchors";
import { printerHandOvers, printerRowIds, type PrinterHandOver } from "./printed-lines";
import { copyHandOvers, handedRowIds, type CopyHandOver } from "./statement-copies";

/**
 * What un-importing a file does to its rows, counted on the rows `unimportFile`
 * deletes (what the file parsed) and keeps (what was attached to it) — the
 * /imports confirmation's numbers, with the same predicates the delete uses.
 */
export interface UnimportCounts {
  /** rows the file parsed that no other download of its statement prints — every one is deleted */
  deleted: number;
  /**
   * rows the file parsed that another download of the same statement, still imported, also prints: they stay, with
   * everything on them, filed under that download (`statement-copies`). 🔴 Until 2026-09-16 the un-import deleted
   * them — 85 rows of 20230810-statements-3522-.pdf that two other downloads print.
   */
  handedOver: number;
  /**
   * rows the file parsed that another imported file prints — not a download of the same statement: they stay, with
   * everything on them, filed under that file (`printed-lines`). 🔴 Until 2026-09-16 the un-import deleted them —
   * Spending Report PDF (1).pdf's rows that 8 Chase Sapphire statements print, and 75 rows of 3ab6c2a8-….csv that
   * rh-redownload.csv prints.
   */
  keptByPrinters: number;
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
  /** of `kept`, the rows the other download's period takes: filed under that download rather than detached */
  keptRefiled: number;
  /**
   * deleted rows the owner categorized BY HAND — kept, and given back when an import writes the same line again
   * (`unimported-attributes`; before the owner's decision of 2026-09-16 the work that could not come back)
   */
  userCategorizedDeleted: number;
  /**
   * deleted rows whose category no engine of an import derives again: Claude's (an import never asks Claude), and one
   * with no recorded source. 🔴 The confirmation named the hand-set categories as the only ones lost; on a copy of the
   * real ledger, 2026-09-16, 13 files hold 586 such rows (Statement_082026_4208.pdf: 24), and a round trip of
   * Discover-AllAvailable-20260710.csv rewrote 442 of Claude's categories and left 2 of its rows with none. Kept, and
   * given back with the line, as a hand-set one is.
   */
  notRederivedDeleted: number;
  /** deleted rows carrying a note — no import reads a note, so the un-import keeps it for the line's return */
  notesDeleted: number;
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
  handedOver: 0,
  keptByPrinters: 0,
  kept: 0,
  keptRefiled: 0,
  userCategorizedDeleted: 0,
  notRederivedDeleted: 0,
  notesDeleted: 0,
  inflowCents: 0,
  outflowCents: 0,
  duplicateSurvivors: 0,
  transferLegsDeleted: 0,
  transferLegsKept: 0,
  transferLegsKeptLinked: 0,
};

/**
 * Every import file's counts, in ONE grouped query; a file with no rows counts zero throughout. `plans` is what each
 * un-import hands to another download of its statement (`copyHandOvers`), and `printers` what it hands to the other
 * files that print its rows (`printerHandOvers`) — the plans `unimportFile` carries out.
 */
export function unimportCountsByFile(
  db: AppDatabase,
  plans: ReadonlyMap<string, readonly CopyHandOver[]> = copyHandOvers(db),
  printers: ReadonlyMap<string, readonly PrinterHandOver[]> = printerHandOvers(db, plans),
): Map<string, UnimportCounts> {
  const copyIds = JSON.stringify([...handedRowIds(plans.values())]);
  const printerIds = JSON.stringify([...printerRowIds(printers.values())]);
  // every parsed row the un-import keeps under another file
  const handedIds = JSON.stringify([...handedRowIds(plans.values()), ...printerRowIds(printers.values())]);
  const refiledIds = JSON.stringify([...plans.values()].flatMap((list) => list.flatMap((p) => p.attachedRowIds)));
  const handed = sql`${transactions.id} IN (SELECT value FROM json_each(${handedIds}))`;
  // a left join's empty side has a NULL marker too, so a parsed row needs a row
  const deleted = sql`(${transactions.id} IS NOT NULL AND ${parsedRow()} AND NOT ${handed})`;
  const kept = sql`(${attachedRow()} AND ${transactions.status} <> 'superseded')`;
  const tally = (when: ReturnType<typeof sql>) => sql<number>`coalesce(sum(case when ${when} then 1 else 0 end), 0)`;
  const rows = db
    .select({
      fileId: importFiles.id,
      deleted: tally(deleted),
      handedOver: tally(sql`${transactions.id} IS NOT NULL AND ${parsedRow()} AND ${transactions.id} IN (SELECT value FROM json_each(${copyIds}))`),
      keptByPrinters: tally(sql`${transactions.id} IS NOT NULL AND ${parsedRow()} AND ${transactions.id} IN (SELECT value FROM json_each(${printerIds}))`),
      kept: tally(kept),
      keptRefiled: tally(sql`${kept} AND ${transactions.id} IN (SELECT value FROM json_each(${refiledIds}))`),
      userCategorizedDeleted: tally(sql`${deleted} AND ${transactions.categorizationSource} = 'user'`),
      notRederivedDeleted: tally(
        sql`${deleted} AND ${transactions.categoryId} IS NOT NULL AND (${transactions.categorizationSource} IS NULL OR ${transactions.categorizationSource} = 'claude')`,
      ),
      notesDeleted: tally(sql`${deleted} AND ${transactions.notes} IS NOT NULL`),
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
       * is the surviving half of a confirmed duplicate hands its money (and a
       * transfer link the twin lacks) to the retired twin instead of taking it
       * out of the ledger, and re-importing the file retires the twin again for
       * the line that brings it back. All 12 rows of
       * `20250302-statements-9805-.pdf` were survivors when this was written,
       * and their twins summed to the same $4,619.92 the confirmation called
       * money leaving.
       *
       * Counted, never re-derived: the restore has slot conflicts and status
       * floors this page must not reimplement, so the confirmation names how
       * many rows are in that shape and lets the reader weigh it. A superseded
       * kept row is not in it: it records no money, and the restore skips it.
       */
      duplicateSurvivors: tally(sql`${deleted} AND ${transactions.status} <> 'superseded' AND exists (
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
          and not (o.import_file_id IS ${importFiles.id} and o.file_link_source IS NULL
            and o.id NOT IN (SELECT value FROM json_each(${handedIds})))
      )`),
    })
    .from(importFiles)
    .leftJoin(transactions, eq(transactions.importFileId, importFiles.id))
    .groupBy(importFiles.id)
    .all();
  return new Map(rows.map(({ fileId, ...counts }) => [fileId, counts]));
}

/** An account an un-import leaves with transactions and no recorded balance: its balance leaves net worth. */
export interface AccountLeavingNetWorth {
  accountId: string;
  name: string;
  /** its latest balance now — what net worth loses */
  balanceCents: number;
  /** the live transactions it keeps, which no balance counts any more */
  keptRows: number;
}

/** An account an un-import leaves with transactions and no recorded balance of its own, but the opening it keeps. */
export interface KeptOpening {
  accountId: string;
  name: string;
  /** the day before the statement's period opens, and the opening it printed for it (`kept-openings`) */
  day: string;
  balanceCents: number;
  /** the live transactions it keeps, which replay from that opening, unchecked */
  keptRows: number;
  /** the still-imported file that keeps the rows and the opening */
  heirFileName: string;
}

interface LosingEveryBalance extends AccountLeavingNetWorth {
  opening: KeptOpeningPlan | null;
}

/**
 * Per file: the accounts whose every recorded balance the un-import removes (`balancesRemovedByFileAndAccount`) while
 * they keep live transactions — rows of other files, rows handed to a file that prints them, rows filed by hand. A
 * balance is derived only from a recorded one, so such an account drops out of net worth with its whole balance, though
 * no transaction leaves — unless it keeps the opening the statement printed (`keptOpeningPlans`, owner decision 20).
 * An account valued from its holdings is not balanced by its recorded balances, and is left out.
 *
 * ⛔ ONE walk for both halves the confirmation prints (`accountsLeftWithoutBalance`, `openingsKeptByFile`), with the
 * plan `unimportFile` keeps the opening by.
 */
function accountsLosingEveryBalance(
  db: AppDatabase,
  plans: ReadonlyMap<string, readonly CopyHandOver[]>,
  printers: ReadonlyMap<string, readonly PrinterHandOver[]>,
): Map<string, LosingEveryBalance[]> {
  const removed = balancesRemovedByFileAndAccount(db, plans);
  const recorded = new Map(
    db
      .select({ accountId: balanceAnchors.accountId, n: count() })
      .from(balanceAnchors)
      .groupBy(balanceAnchors.accountId)
      .all()
      .map((r) => [r.accountId, r.n] as const),
  );
  const handed = new Set([...handedRowIds(plans.values()), ...printerRowIds(printers.values())]);
  // an opening the file keeps for a statement he un-imported, and that follows its rows (`handOverKeptOpenings`)
  const following = followingOpeningsByFile(db, printers);
  const losing = new Map<string, LosingEveryBalance[]>();
  for (const [fileId, accounts] of removed) {
    // the opening that follows first: the un-import keeps no second one beside it (`keepOpenings`)
    const openings: KeptOpeningPlan[] = [
      ...(following.get(fileId) ?? []),
      ...keptOpeningPlans(
        db,
        fileId,
        printers.get(fileId) ?? [],
        new Set((plans.get(fileId) ?? []).map((p) => p.periodId)),
      ),
    ];
    for (const [accountId, n] of accounts) {
      if ((recorded.get(accountId) ?? 0) > n) continue;
      const account = db.select({ id: accountsTable.id, name: accountsTable.name, type: accountsTable.type }).from(accountsTable).where(eq(accountsTable.id, accountId)).get();
      if (account === undefined || derivesFromHoldings(db, account)) continue;
      const keptRows = db
        .select({ id: transactions.id, importFileId: transactions.importFileId, fileLinkSource: transactions.fileLinkSource })
        .from(transactions)
        .where(and(eq(transactions.accountId, accountId), inArray(transactions.status, ["active", "quarantined", "excluded"])))
        .all()
        .filter((r) => r.importFileId !== fileId || r.fileLinkSource !== null || handed.has(r.id)).length;
      if (keptRows === 0) continue;
      const latest = db
        .select({ balanceCents: dailyBalances.balanceCents })
        .from(dailyBalances)
        .where(and(eq(dailyBalances.accountId, accountId), ne(dailyBalances.basis, "gap")))
        .orderBy(desc(dailyBalances.day))
        .get();
      if (latest === undefined) continue;
      const opening = openings.find((o) => o.accountId === accountId) ?? null;
      losing.set(fileId, [...(losing.get(fileId) ?? []), { accountId, name: account.name, balanceCents: latest.balanceCents, keptRows, opening }]);
    }
  }
  return losing;
}

/** What an un-import does to the balances net worth counts, per file: the two halves the confirmation prints. */
export interface NetWorthEffects {
  /** accounts that keep no opening — their whole balance leaves net worth (`accountsLeftWithoutBalance`) */
  leaving: Map<string, AccountLeavingNetWorth[]>;
  /** accounts that keep the opening the statement printed — they stay, unchecked (`openingsKeptByFile`) */
  keeping: Map<string, KeptOpening[]>;
}

/** Both halves from one walk (`accountsLosingEveryBalance`) — /imports asks for both on every render. */
export function netWorthEffectsByFile(
  db: AppDatabase,
  plans: ReadonlyMap<string, readonly CopyHandOver[]> = copyHandOvers(db),
  printers: ReadonlyMap<string, readonly PrinterHandOver[]> = printerHandOvers(db, plans),
): NetWorthEffects {
  const leaving = new Map<string, AccountLeavingNetWorth[]>();
  const keeping = new Map<string, KeptOpening[]>();
  for (const [fileId, accounts] of accountsLosingEveryBalance(db, plans, printers)) {
    const gone = accounts.flatMap(({ opening, ...a }) => (opening === null ? [a] : []));
    if (gone.length > 0) leaving.set(fileId, gone);
    const kept = accounts.flatMap(({ accountId, name, keptRows, opening }) => {
      if (opening === null) return [];
      const heir = db.select({ fileName: importFiles.fileName }).from(importFiles).where(eq(importFiles.id, opening.heirFileId)).get();
      return [{ accountId, name, day: opening.day, balanceCents: opening.balanceCents, keptRows, heirFileName: heir?.fileName ?? "another file" }];
    });
    if (kept.length > 0) keeping.set(fileId, kept);
  }
  return { leaving, keeping };
}

/**
 * Per file: the accounts `accountsLosingEveryBalance` finds that keep no opening — their whole balance leaves net
 * worth.
 *
 * 🔴 The confirmation read "deletes no transactions" and "Money leaving the ledger: $0.00 in · $0.00 out" over
 * 2026-08-25-everyday-checking.pdf, whose un-import took Wells Fargo Everyday Checking's only two balances: the 39
 * Rocket Money rows stay (owner, 2026-09-16), and net worth fell 11,312,501 → 11,072,834 cents (the review of
 * uc/final-integrate, on a copy of the real ledger). That file now keeps its opening (`openingsKeptByFile`); an
 * account a file without a printed opening leaves (an export, a bank export) still goes.
 */
export function accountsLeftWithoutBalance(
  db: AppDatabase,
  plans: ReadonlyMap<string, readonly CopyHandOver[]> = copyHandOvers(db),
  printers: ReadonlyMap<string, readonly PrinterHandOver[]> = printerHandOvers(db, plans),
): Map<string, AccountLeavingNetWorth[]> {
  return netWorthEffectsByFile(db, plans, printers).leaving;
}

/**
 * Per file: the accounts `accountsLosingEveryBalance` finds that keep the opening the statement printed — they stay in
 * net worth on it, unchecked (owner decision 20, 2026-09-17).
 */
export function openingsKeptByFile(
  db: AppDatabase,
  plans: ReadonlyMap<string, readonly CopyHandOver[]> = copyHandOvers(db),
  printers: ReadonlyMap<string, readonly PrinterHandOver[]> = printerHandOvers(db, plans),
): Map<string, KeptOpening[]> {
  return netWorthEffectsByFile(db, plans, printers).keeping;
}

/** The statement periods un-importing a file removes, and the ones another download of the statement takes. */
export interface UnimportPeriods {
  removed: number;
  handedOver: number;
}

/** Per file that owns a period; `plans` as `unimportCountsByFile` takes them. */
export function unimportPeriodsByFile(
  db: AppDatabase,
  plans: ReadonlyMap<string, readonly CopyHandOver[]> = copyHandOvers(db),
): Map<string, UnimportPeriods> {
  return new Map(
    db
      .select({ importFileId: statementPeriods.importFileId, n: count() })
      .from(statementPeriods)
      .groupBy(statementPeriods.importFileId)
      .all()
      .map(({ importFileId, n }) => {
        const handedOver = plans.get(importFileId)?.length ?? 0;
        return [importFileId, { removed: n - handedOver, handedOver }] as const;
      }),
  );
}
