import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";

/**
 * 🔴 WHY THIS IS ITS OWN MODULE. The wallet rule lived in manual-transactions.ts,
 * which imports `withPreMutationSnapshot` from `@/db/backup` — and that module
 * loads better-sqlite3 as a runtime value. When budgets.ts started asking
 * `cashWalletIds` (the budgets frontier leaving wallets out), the chain
 * SpendHeatmap.tsx ("use client") → services/spending → movers-card → committed
 * → budgets → manual-transactions → db/backup put native SQLite into a browser
 * bundle, and `next build` failed with "Module not found: Can't resolve 'fs'"
 * (2026-09-15, main 0b8d2af). tsc and vitest were green: only a build sees it.
 *
 * ⛔ Keep this file to database READS through drizzle + schema. Anything that
 * snapshots, writes files or opens a connection belongs elsewhere.
 */

/** The institution every intentional cash wallet lives under. */
export const CASH_INSTITUTION_NAME = "Cash";

/** The "Cash" institution's id, or null if none exists yet. */
export function cashWalletInstitutionId(db: AppDatabase): string | null {
  return (
    db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.name, CASH_INSTITUTION_NAME))
      .get()?.id ?? null
  );
}

/**
 * A cash wallet is an INTENTIONAL manual wallet — one created under the "Cash"
 * institution — that also has NO external ground truth: no statement periods,
 * no import anchors (statement/ofx_ledger/live), and no imported transactions.
 * The institution marker is load-bearing: a structural-only check would
 * misclassify any freshly-created, not-yet-imported REGULAR bank account as a
 * cash wallet and let a manual row land on it, which would later break that
 * account's to-the-cent statement reconciliation. The structural checks then
 * stay as defense-in-depth (a "Cash" account never legitimately has imports).
 *
 * ⛔ The rule lives in `cashWalletIds`; this asks it about one account.
 */
export function isCashWallet(db: AppDatabase, accountId: string): boolean {
  return cashWalletIds(db).has(accountId);
}

/**
 * Every cash wallet in the ledger, by the rule `isCashWallet` states: under the
 * "Cash" institution, with no statement period, no import anchor and no
 * imported row.
 *
 * ⛔ ONE rule for both spellings. `/budgets` asks "which of the accounts this
 * category was spent from are wallets" on every row of the page, and a second,
 * batch copy of these checks beside `isCashWallet` would be two definitions of a
 * wallet that can drift — the write guard in `addManualTransaction` and a page
 * that leaves wallets out would then disagree about the same account.
 *
 * ⚠️ Archived wallets are included: archiving an account does not let an import
 * reach it, and a category spent from one inside a window is still spent from a
 * wallet.
 */
export function cashWalletIds(db: AppDatabase): ReadonlySet<string> {
  const cashInstId = cashWalletInstitutionId(db);
  if (cashInstId === null) return new Set();
  const underCash = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.institutionId, cashInstId))
    .all();
  return new Set(underCash.map((a) => a.id).filter((id) => !hasImportGroundTruth(db, id)));
}

/** A statement period, an import anchor (statement/ofx_ledger/live) or an imported row on the account. */
function hasImportGroundTruth(db: AppDatabase, accountId: string): boolean {
  const period = db
    .select({ id: statementPeriods.id })
    .from(statementPeriods)
    .where(eq(statementPeriods.accountId, accountId))
    .get();
  if (period) return true;

  const importAnchor = db
    .select({ id: balanceAnchors.id })
    .from(balanceAnchors)
    .where(
      and(
        eq(balanceAnchors.accountId, accountId),
        inArray(balanceAnchors.source, ["statement", "ofx_ledger", "live"]),
      ),
    )
    .get();
  if (importAnchor) return true;

  const importedTxn = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), isNotNull(transactions.importFileId)))
    .get();
  return importedTxn !== undefined;
}
