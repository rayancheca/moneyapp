import { cache } from "react";
import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts, type AccountType } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances, type BalanceBasis } from "@/db/schema/balances";
import { statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { diffDays, todayIso } from "@/lib/dates";
import { ACCOUNT_ORDER } from "./account-order";

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

/**
 * Whether a day's balance is CHECKED — the one place that decides, because two
 * surfaces already answered it differently.
 *
 * ⛔ `carried` is checked. `deriveForward` writes `sawTxn ? "derived_unverified"
 * : "carried"`, so a carried day means nothing posted since the last recorded
 * balance and the number is exactly as proven as the anchor it came from;
 * between two anchors it is written only when the two AGREE.
 * `provenance.ts::BASIS_VERDICT` grades it `derived` for that reason and its
 * docstring says reading it as weak is "the first thing this service got
 * wrong". The dashboard says the same in words: "786 days had no activity to
 * replay, so the balance before them was carried forward — as proven as that
 * balance, and not a gap."
 *
 * 🔴 `/accounts/[id]` kept its own copy as `{anchored, derived}` and dropped
 * `carried` with it. The confirmation for removing a recorded balance —
 * destructive, with no undo — then offered "Days that stop being verified: 1
 * day" for Cash on Hand's 2026-08-03 anchor, whose span is 1 anchored day, 7
 * carried and 1 unverified: the answer is 8, and /imports says so on the same
 * ledger ("closes to the cent through Aug 3, 2026, then carries that balance
 * forward for 7 days"). Measured 2026-09-08: 24 of the 220 recorded balances on
 * cash accounts understated their own blast radius, the worst by 61 days.
 */
export function basisIsChecked(basis: BalanceBasis): boolean {
  return basis === "anchored" || basis === "derived" || basis === "carried";
}

/**
 * Whether a chart may draw one account's day as an exact figure — solid, not
 * broken or dashed. `basisIsChecked`, behind the type branch `accountCoverage`
 * takes first.
 *
 * ⛔ An investment account's `carried` is not a cash account's. There it is a
 * CARRIED PRICE: `rebuildInvestmentHistory` writes it when a held symbol had no
 * close that day, and value-anchor step-hold writes it for a recorded value held
 * flat across a market that moved. Only `anchored` and `derived` (every close
 * real) are exact figures there, and even those are market value rather than
 * arithmetic, which is `accountCoverage`'s question, not this one.
 *
 * 🔴 The dashboard's chart modes kept a third local `{anchored, derived}` set,
 * and /accounts/[id]'s balance chart a fourth. Measured 2026-09-15 on the
 * owner's ledger: the terrain announced "118 spans are drawn broken, because the
 * ledger cannot verify them" at 104 columns, Chase Sapphire's rail read "+$82.72
 * since Feb 2025 · 1 unverified" and its Sep 15 slug "this day is estimated",
 * and the Owed line went dashed Sep 3 – 15 — all over 13 stored `carried` days
 * resting on the Sep 2 statement with nothing posted since. The trust card on
 * the same page calls those days "as proven as that balance, and not a gap",
 * and the hero's own net-worth series already drew them solid.
 */
export function balanceDayIsExact(accountType: AccountType, basis: BalanceBasis): boolean {
  if (accountType === "investment") return basis === "anchored" || basis === "derived";
  return basisIsChecked(basis);
}

export interface AccountCoverage {
  accountId: string;
  accountName: string;
  accountType: string;
  grade: CoverageGrade;
  /** last day whose balance rests on a closed arithmetic chain */
  verifiedThrough: string | null;
  /**
   * The day the checked chain opens on: the account's first trusted day, which
   * is its first recorded balance. Null when nothing is checked at all.
   *
   * 🔴 Days BEFORE it are prehistory, replayed backwards from that balance with
   * nothing earlier to check them against — and `verifiedThrough` below
   * deliberately does not call them a break, so a row there sat "on or before
   * verifiedThrough" and a total counted it checked. Measured 2026-09-15:
   * Robinhood Cash opens 2023-12-05, its first recorded balance is 2023-12-31,
   * and `/accounts/<Robinhood Cash>` read "2,387 of 2,392 checked" while the Dec
   * 6 and Dec 7, 2023 rows each read "nothing checks the total it sits in" on
   * their own sheet. `provenance.rowGrade` reads this so the two agree.
   *
   * ⚠️ Inclusive, like `verifiedThrough`: a row ON the opening day counts as
   * checked. No such row exists on the real ledger or the e2e fixture
   * (2026-09-15), so the stricter reading has nothing to decide yet.
   */
  chainOpensOn: string | null;
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
  /**
   * First day of the CURRENT run of unchecked days — the one that reaches the
   * newest day the account has a balance for. Null when the newest day is
   * checked.
   *
   * 🔴 The same trap `brokenSince` was written for, one field over and still
   * live. `unverifiedSince` is the FIRST unchecked day the account ever had, and
   * the coverage row pairs it with a count of every unchecked day:
   *
   *     Robinhood Cash — nothing checks it since Dec 5, 2023 · 52 days unchecked
   *
   * read on 2026-09-04 of an account with 32 statement anchors, the newest
   * closing 2026-07-31 — 35 days earlier. Its 52 unchecked days fall in two
   * runs with 946 checked days between them: 2023-12-05→2023-12-30, which is
   * prehistory before its very first anchor, and 2026-08-03→2026-08-28. The
   * sentence claimed a 1,004-day blackout, and its own neighbour on the card
   * ("Cash on Hand — nothing checks it since Aug 11, 2026 · 1 day unchecked")
   * was coherent, so the two rows were built from dates that meant different
   * things.
   */
  uncheckedSince: string | null;
  /** length of that run — what "since" is actually about */
  uncheckedRunDays: number;
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
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.isActive, true))
    // THE order: the net-worth popover and ConcentrationCard print these as they come
    .orderBy(...ACCOUNT_ORDER)
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
        chainOpensOn: null,
        unverifiedSince: null,
        brokenSince: null,
        uncheckedSince: null,
        uncheckedRunDays: 0,
        daysSinceVerified: null,
      };
    }

    if (balances.length === 0) {
      return {
        ...base,
        grade: "unknown" as const,
        verifiedThrough: null,
        chainOpensOn: null,
        unverifiedSince: null,
        brokenSince: null,
        uncheckedSince: null,
        uncheckedRunDays: 0,
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

    const isUnchecked = (basis: BalanceBasis): boolean => !basisIsChecked(basis);
    const firstUntrusted = balances.find((b) => isUnchecked(b.basis));
    const firstGap = balances.find((b) => b.basis === "gap");

    // walk back from the newest day for as long as it is unchecked: the run
    // that is still open, which is what a sentence beginning "since" is about
    let runStart = balances.length;
    while (runStart > 0 && isUnchecked(balances[runStart - 1]!.basis)) runStart -= 1;
    const uncheckedRunDays = balances.length - runStart;
    const uncheckedSince = uncheckedRunDays > 0 ? balances[runStart]!.day : null;

    /*
     * `verifiedThrough` must not run past the point the chain BROKE: a later
     * `anchored` day is a fresh starting point, not proof of the span before it.
     *
     * 🔴 …but a run of untrusted days BEFORE the account's first trusted day is
     * not a break. Nothing broke; the chain simply starts later. Robinhood Cash
     * opens on 2023-12-05 with 26 days of prehistory before its very first
     * anchor, so `firstUntrusted` was its opening day, every trusted day failed
     * `b.day < firstUntrusted.day`, and `verifiedThrough` came back null — of an
     * account with 32 statement anchors and 32 reconciled periods, the newest
     * closing 2026-07-31. `/imports` then printed, on ONE row:
     *
     *     Robinhood Cash · Unverified · statements → 2026-07-31
     *     nothing closes to the cent from its first day; …
     *
     * The break test is measured from the first TRUSTED day, so a mid-chain gap
     * still stops the walk exactly where it did.
     */
    const firstTrusted = balances.find((b) => TRUSTED.has(b.basis));
    const firstBreak = firstTrusted
      ? balances.find(
          (b) =>
            b.day > firstTrusted.day &&
            (b.basis === "derived_unverified" || b.basis === "gap"),
        )
      : firstUntrusted;
    const verifiedThrough =
      balances
        .filter((b) => TRUSTED.has(b.basis) && (!firstBreak || b.day < firstBreak.day))
        .at(-1)?.day ?? null;

    if (!hasTxn) {
      return {
        ...base,
        grade: "manual" as const,
        verifiedThrough: null,
        chainOpensOn: null,
        unverifiedSince: null,
        brokenSince: null,
        uncheckedSince: null,
        uncheckedRunDays: 0,
        daysSinceVerified: null,
      };
    }

    const grade: CoverageGrade = days.gap > 0 ? "broken" : days.derived_unverified > 0 ? "unverified" : "verified";

    return {
      ...base,
      grade,
      verifiedThrough,
      chainOpensOn: firstTrusted?.day ?? null,
      unverifiedSince: firstUntrusted?.day ?? null,
      brokenSince: firstGap?.day ?? null,
      uncheckedSince,
      uncheckedRunDays,
      daysSinceVerified: verifiedThrough ? diffDays(verifiedThrough, today) : null,
    };
  });
});

/** ⛔ A COPY, so one caller sorting the shared array cannot rewrite another's. */
export function accountCoverage(db: AppDatabase, today: string = todayIso()): AccountCoverage[] {
  return accountCoverageCached(db, today).slice();
}
