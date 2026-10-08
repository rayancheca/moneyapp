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

/**
 * Every account a statement is still COMING for: not archived (`isActive`) and not a cash wallet (`cashWalletIds`).
 * An archived account is never imported again, and a wallet holds what he typed into it — for neither will a
 * statement ever cover another day.
 *
 * ⛔ ONE rule, made of the two that already exist — never a third spelling of either. /imports asks these accounts
 * for their statements (`statementPulls`, `statementGaps`); only these hold a silence back to the day their
 * statements have covered, once anything has been read on them — a series' lapse and running late, a past bill
 * missed, an arrears payment never posted (`silenceReadThrough`, §6A 57); and only these date spending while one of
 * them was spent from — a /budgets row, /spending's cut, "What changed" (`accountsThatDate`). `lib/budget-verdict`'s
 * "Cash only", which forbids an "Awaiting statements" that never arrives, stands on the wallet half.
 */
export function accountsAwaitingStatements(db: AppDatabase): ReadonlySet<string> {
  const wallets = cashWalletIds(db);
  return new Set(
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.isActive, true))
      .all()
      .map((a) => a.id)
      .filter((id) => !wallets.has(id)),
  );
}

/**
 * How far an account counts as read when a SILENCE on it is graded — a series running late or lapsed, a past bill
 * missed, an arrears payment that never posted: as far as its statements have reached (`readThrough`) while one is
 * still coming for it (`accountsAwaitingStatements`), and through TODAY when none ever will — archived, or a wallet —
 * or when nothing on it has been read at all (`readThrough` null: no checked record for the lapse, no import for the
 * calendar).
 *
 * ⚖️ 2026-10-08 (review of 98acbeb): his rule is that an upload arriving late can never make a bill vanish, and for an
 * archived account or a wallet none is coming — so its quiet is measured as if read through the day of the question.
 *
 * ⚖️ …and an account with nothing read on it holds nothing back either (review of 6eee6ea): there is no read day to
 * hold a series to, and held to none it was forecast for good. 🔴 On a copy of his ledger with Amazon Prime's account
 * set to Capital One 360 Checking (live, nothing imported — /imports never asks it for a statement, `statementPulls`),
 * at 2026-12-07 and again at 2027-10-08 it read "Awaiting statements" with a next date of Nov 5, 2027 and stayed live
 * on the subscriptions card; archived, the same series read lapsed on both days. Only the SILENCE moves: what the
 * ledger has read of it stays nothing (`checkedThroughBySeries`), and /imports' rule is unchanged.
 *
 * ⚠️ An investment account has no checked record however many statements it has — priced, not walked
 * (`accountCoverage`) — so a series on one is measured to today, as every series was before §6A 57. None lands on one
 * on his ledger (2026-10-08); in the e2e fixture four detected Robinhood Brokerage series do, all inside their lines.
 *
 * ⛔ ONE rule for every surface that grades a silence: the day a series' silence is measured to
 * (`silenceMeasuredThroughBySeries`, over each account's checked record) and the day the calendar and the runway's
 * arrears grade a past bill against (`silenceObservedThrough`, over each account's newest import). 🔴 Only the first
 * asked it (review of e00e6b8): with Venture X archived, at 2026-11-20, Breezeline's chip read "running late" beside
 * a calendar that filed its Nov 8 "not yet known" and a runway that said "no import has covered it yet".
 */
export function silenceReadThrough(
  awaiting: ReadonlySet<string>,
  accountId: string,
  readThrough: string | null,
  today: string,
): string {
  return awaiting.has(accountId) && readThrough !== null ? readThrough : today;
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
