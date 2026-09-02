import { cache } from "react";
import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances, type BalanceBasis } from "@/db/schema/balances";
import { statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { diffDays, todayIso } from "@/lib/dates";

/**
 * Per-account answer to "is this account's money actually checked, and through
 * when?" — deliberately a DIFFERENT question from "does it have statements".
 *
 * The app already showed statement coverage and nothing else, which reads as a
 * hole wherever the owner uploads irregularly and reads as fine wherever an
 * account has no arbiter at all. Both readings are wrong, in opposite
 * directions:
 *
 *  - Chase Checking has a 22-month stretch with no statement, yet every one of
 *    its days is `derived` and none is `gap` — its CSV closes the anchor chain
 *    exactly (derivation.ts:209), so the money IS checked, just coarsely.
 *  - Robinhood Brokerage has no arbiter of any kind, yet every day reads
 *    `derived` — because for investment accounts that word is written by
 *    crypto-history.ts:124 and means "prices were fresh", nothing more.
 *
 * Hence the type branch below: `daily_balances.basis` is only evidence of
 * arithmetic for accounts whose basis comes from the transaction walk.
 */

export type CoverageGrade =
  /** the transaction walk closes on every anchor, right up to `verifiedThrough` */
  | "verified"
  /** replayed past the last anchor with nothing left to check against */
  | "unverified"
  /** the walk did NOT land on an anchor — money is provably missing or doubled */
  | "broken"
  /** investment: value is marked to market and reconciliation cannot fail */
  | "market_value"
  /** no transactions ever — the owner is the statement */
  | "manual"
  /** no derived cache yet (new or never imported) */
  | "unknown";

export interface AccountCoverage {
  accountId: string;
  accountName: string;
  accountType: string;
  grade: CoverageGrade;
  /** last day whose balance rests on a closed arithmetic chain */
  verifiedThrough: string | null;
  /** first day the chain stopped being checkable */
  unverifiedSince: string | null;
  /**
   * First day the walk actually MISSED an anchor — the start of `days.gap`,
   * which is a different population from `unverifiedSince`.
   *
   * `unverifiedSince` is the first day that is `derived_unverified` OR `gap`,
   * so on an account that was replayed past its earliest anchor before any
   * break, the two are years apart: Robinhood Cash reports `unverifiedSince`
   * 2023-12-05 (26 days of prehistory before its first anchor) while every one
   * of its 264 gap days is 2025-11 or later. Pairing the first date with the
   * second count — which is exactly what the coverage panel printed — names an
   * innocent date as the moment the money stopped adding up.
   */
  brokenSince: string | null;
  /** newest statement period end, or null if the account has never had one */
  statementsThrough: string | null;
  /** when the owner last typed a balance in by hand (manual accounts) */
  lastManualUpdate: string | null;
  /** days between `verifiedThrough` and today; null when nothing is verified */
  daysSinceVerified: number | null;
  days: Record<BalanceBasis, number>;
}

/** basis values that represent a checked arithmetic chain, for cash accounts */
const TRUSTED: ReadonlySet<BalanceBasis> = new Set<BalanceBasis>(["anchored", "derived"]);

function emptyDays(): Record<BalanceBasis, number> {
  return { anchored: 0, derived: 0, derived_unverified: 0, carried: 0, gap: 0 };
}

/**
 * ⚡ MEMOISED FOR ONE SERVER RENDER — see `buildPortfolio` in
 * `services/portfolio` for why `react`'s `cache` and not a module-level Map.
 * Measured seven calls at 2.8ms per dashboard render on the owner's ledger.
 */
const accountCoverageCached = cache(function accountCoverageCached(
  db: AppDatabase,
  today: string,
): AccountCoverage[] {
  const rows = db
    .select({ id: accounts.id, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.isActive, true))
    .orderBy(accounts.displayOrder, accounts.name)
    .all();

  return rows.map((account) => {
    // ordered in SQL rather than by compareDates: ISO dates sort lexicographically
    // the same way they sort chronologically, and compareDates was measured at
    // 92.7% of dashboard CPU in pass 31 — no reason to re-enter it here
    const balances = db
      .select({ day: dailyBalances.day, basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, account.id))
      .orderBy(dailyBalances.day)
      .all();

    const days = emptyDays();
    for (const b of balances) days[b.basis] += 1;

    const statementsThrough =
      db
        .select({ periodEnd: statementPeriods.periodEnd })
        .from(statementPeriods)
        .where(eq(statementPeriods.accountId, account.id))
        .orderBy(desc(statementPeriods.periodEnd))
        .limit(1)
        .get()?.periodEnd ?? null;

    const lastManualUpdate =
      db
        .select({ anchoredOn: balanceAnchors.anchoredOn })
        .from(balanceAnchors)
        .where(eq(balanceAnchors.accountId, account.id))
        .orderBy(desc(balanceAnchors.anchoredOn))
        .limit(1)
        .get()?.anchoredOn ?? null;

    const base = {
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      statementsThrough,
      lastManualUpdate,
      days,
    };

    /*
     * Investment first, and unconditionally. reconcileAccounts (service.ts:1190)
     * returns `value_anchor` for type='investment' without any pass/fail — a
     * discrepancy is absorbed into market_change_cents rather than reported —
     * so no arithmetic gate exists to be verified BY. Grading these off `basis`
     * would report the two least-checked accounts in the ledger as the
     * healthiest.
     */
    if (account.type === "investment") {
      return {
        ...base,
        grade: "market_value" as const,
        verifiedThrough: null,
        unverifiedSince: null,
        brokenSince: null,
        daysSinceVerified: null,
      };
    }

    if (balances.length === 0) {
      return {
        ...base,
        grade: "unknown" as const,
        verifiedThrough: null,
        unverifiedSince: null,
        brokenSince: null,
        daysSinceVerified: null,
      };
    }

    // an account that has never had a transaction is not "verified" by having
    // no contradictions — the owner is its only source, so say that instead
    const hasTxn =
      db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.accountId, account.id))
        .limit(1)
        .get() !== undefined;

    const firstUntrusted = balances.find((b) => b.basis === "derived_unverified" || b.basis === "gap");
    const firstGap = balances.find((b) => b.basis === "gap");

    // `verifiedThrough` must not run past the point the chain broke: a later
    // `anchored` day is a fresh starting point, not proof of the span before it
    const verifiedThrough =
      balances
        .filter((b) => TRUSTED.has(b.basis) && (!firstUntrusted || b.day < firstUntrusted.day))
        .at(-1)?.day ?? null;

    if (!hasTxn) {
      return {
        ...base,
        grade: "manual" as const,
        verifiedThrough: null,
        unverifiedSince: null,
        brokenSince: null,
        daysSinceVerified: null,
      };
    }

    const grade: CoverageGrade = days.gap > 0 ? "broken" : days.derived_unverified > 0 ? "unverified" : "verified";

    return {
      ...base,
      grade,
      verifiedThrough,
      unverifiedSince: firstUntrusted?.day ?? null,
      brokenSince: firstGap?.day ?? null,
      daysSinceVerified: verifiedThrough ? diffDays(verifiedThrough, today) : null,
    };
  });
});

/** ⛔ A COPY, so one caller sorting the shared array cannot rewrite another's. */
export function accountCoverage(db: AppDatabase, today: string = todayIso()): AccountCoverage[] {
  return accountCoverageCached(db, today).slice();
}
