import { and, eq, max, ne, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "@/db/client";
import { KEPT_OPENING_SOURCE, balanceAnchors } from "@/db/schema/balances";

/**
 * The newest balance an imported file recorded for an account, as the ledger keeps it: a `balance_anchors` row the
 * file owns on that account — a statement's close or opening, an OFX download's LEDGERBAL, a bank CSV's running
 * balance — or null when it owns none.
 *
 * ⛔ ONE rule for every reader that says whether a file carries balances: a row's headline (provenance.ts
 * `rowHeadline`, S31), the period line on a row's and a day's sheet and the period's own sheet (`periodDetail`,
 * `statementPeriodProvenance`, through `balanceLessKind`), and /imports' footer (`statementEvidence`).
 *
 * 🔴 The period line read the state alone. The review of 601f155, on a copy of data/e2e.db (2026-10-12): Chase Freedom
 * Unlimited's balance on Sep 30, 2024 listed "Chase1111_Activity_2024-07-01_2024-09-30.QFX — balance recorded on Sep
 * 30, 2024" over that file's period line "coverage declared, but this file carries no balances to check against", and
 * /imports' footer called all 27 of the fixture's balance-less downloads "an export without a closing figure" — 18 own
 * the balance they recorded on the account they declare. The row's headline had read the anchors since S31.
 *
 * ⛔ Never an opening the file keeps for a statement he un-imported (`kept-openings`): it never printed that balance.
 *
 * ⚠️ What the ledger KEEPS, which is not always what the file printed: one `ofx_ledger` balance per account and day,
 * owned by the file that wrote it last (`upsertAnchor`), and nothing else records an OFX ledger balance
 * (import/printed-anchors.ts). A download whose day another file re-recorded reads as recording none — on the e2e copy,
 * 9 of the 27 QFX downloads, each re-recorded by its quarter's CSV.
 */
export function fileRecordedBalanceOn(db: AppDatabase, importFileId: string, accountId: string): string | null {
  return recordedOn(db, importFileId, accountId).get()?.on ?? null;
}

/**
 * `fileRecordedBalanceOn` as a column of a query over `statement_periods` (or any row naming a file and an account):
 * the same rule, correlated on the row's own `importFileId` and `accountId`.
 */
export function fileRecordedBalanceOnSql(
  db: AppDatabase,
  row: { importFileId: SQLWrapper; accountId: SQLWrapper },
): SQL<string | null> {
  return sql<string | null>`(${recordedOn(db, row.importFileId, row.accountId)})`;
}

function recordedOn(db: AppDatabase, importFileId: SQLWrapper | string, accountId: SQLWrapper | string) {
  // aliased, so a caller's query over `balance_anchors` is never correlated with this one by accident
  const own = alias(balanceAnchors, "own_balance");
  return db
    .select({ on: max(own.anchoredOn) })
    .from(own)
    .where(and(eq(own.importFileId, importFileId), eq(own.accountId, accountId), ne(own.source, KEPT_OPENING_SOURCE)));
}
