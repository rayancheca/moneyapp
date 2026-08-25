import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { statementPeriods } from "@/db/schema/imports";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { compareDates } from "@/lib/dates";

/**
 * "Through which day has the ledger actually been SHOWN this account?"
 *
 * Not "through which day does it add up" — that is `accountCoverage`, and it
 * answers a stronger, different question. An account can be perfectly imported
 * and still unverified (Chase Checking has a 22-month stretch with no statement
 * whose every day is nonetheless derived from a closed CSV), and it can be
 * verified through a day on which nothing has been imported since. The calendar
 * needs the weaker fact, because the only thing it is entitled to say is whether
 * a silent day was ever looked at.
 *
 * ## Two arbiters, deliberately
 *
 * A day counts as shown if EITHER arbiter reaches it:
 *
 *  - **the newest active transaction** — proof the import walked this far;
 *  - **the newest statement period end** — proof a period was covered even
 *    where nothing was charged in it.
 *
 * Neither alone is enough. Transactions alone would call the tail of a quiet
 * statement unobserved (Chase Sapphire's newest charge is 2026-07-30 while its
 * statement closes 2026-08-02, so three genuinely-empty days would read as
 * unknown). Statements alone would blind the app to every CSV-only account —
 * Cash on Hand has never had a statement in its life and is imported through
 * 2026-08-11.
 *
 * ⚠️ `daily_balances.basis` is NOT used here, though it is tempting: after the
 * last anchor `deriveForward` writes `carried` until the first transaction and
 * `derived_unverified` after it, which does encode this exact frontier — but the
 * same word `carried` is also written BETWEEN anchors for days that were fully
 * covered and simply had no activity. One token meaning both "never looked at"
 * and "looked at, nothing there" cannot arbitrate this question.
 *
 * ⚠️ Investment accounts are excluded. Their basis and their balances are marked
 * to market rather than walked from transactions, so "imported through" is not a
 * fact about them. No recurring series bills on one.
 */
export interface ObservationFrontier {
  /** accountId → last day the ledger has been shown, for ledger-bearing accounts */
  byAccount: ReadonlyMap<string, string>;
}

/** The later of two frontier candidates; `null` means "this arbiter is silent". */
function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareDates(a, b) >= 0 ? a : b;
}

/** The earlier of two frontiers; `null` means "this side contributes nothing". */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareDates(a, b) <= 0 ? a : b;
}

export function observationFrontier(db: AppDatabase): ObservationFrontier {
  const ledgerAccounts = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(ne(accounts.type, "investment"))
    .all();

  const lastTxn = new Map(
    db
      .select({ accountId: transactions.accountId, day: sql<string>`max(${transactions.postedOn})` })
      .from(transactions)
      .where(eq(transactions.status, "active"))
      .groupBy(transactions.accountId)
      .all()
      .map((r) => [r.accountId, r.day] as const),
  );

  const lastStatement = new Map(
    db
      .select({
        accountId: statementPeriods.accountId,
        day: sql<string>`max(${statementPeriods.periodEnd})`,
      })
      .from(statementPeriods)
      .groupBy(statementPeriods.accountId)
      .all()
      .map((r) => [r.accountId, r.day] as const),
  );

  const byAccount = new Map<string, string>();
  for (const { id } of ledgerAccounts) {
    const through = latest(lastTxn.get(id) ?? null, lastStatement.get(id) ?? null);
    if (through === null) continue; // never imported at all — contributes nothing
    byAccount.set(id, through);
  }

  return { byAccount };
}

/**
 * Which accounts a series' charges land on — its own `account_id` if it has one,
 * plus every account its tagged postings have actually touched.
 *
 * Both, not either. Ten of the twenty-six live series carry no `account_id` at
 * all — including every commitment the owner registered by hand, which is to say
 * rent, the car lease, the car insurance, FPL, Breezeline and the cash job — so
 * the column alone answers nothing for exactly the series that matter most.
 * And the column alone is wrong even where it is set: Netflix names Chase
 * Sapphire while its history posted to Chase Sapphire AND Discover.
 */
export function seriesAccountIds(db: AppDatabase): Map<string, Set<string>> {
  const bySeries = new Map<string, Set<string>>();
  const add = (seriesId: string, accountId: string): void => {
    const set = bySeries.get(seriesId);
    if (set) set.add(accountId);
    else bySeries.set(seriesId, new Set([accountId]));
  };

  for (const s of db
    .select({ id: recurringSeries.id, accountId: recurringSeries.accountId })
    .from(recurringSeries)
    .where(isNotNull(recurringSeries.accountId))
    .all()) {
    if (s.accountId) add(s.id, s.accountId);
  }

  for (const r of db
    .select({ seriesId: transactions.recurringSeriesId, accountId: transactions.accountId })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), isNotNull(transactions.recurringSeriesId)))
    .all()) {
    if (r.seriesId) add(r.seriesId, r.accountId);
  }

  return bySeries;
}

/**
 * The frontier that governs one series: the EARLIEST among the accounts it bills
 * on, or `null` when it cannot be attributed to any imported account at all.
 *
 * Earliest, because the claim being guarded is a negative one. To say a charge
 * is missing from a series that bills sometimes on Chase and sometimes on
 * Venture X, both have to have been looked at; if either is unimported the
 * charge could be sitting in it. Taking the latest would let one fresh account
 * vouch for a stale one.
 *
 * ⚠️ There is deliberately NO ledger-wide fallback. The first version took the
 * earliest frontier in the whole ledger for an unattributable series, and it was
 * wrong in a way the real data hid and the fixture exposed immediately: one
 * dormant account is enough to drag that floor back months — Venture X had not
 * been touched since 2026-05-17 — after which nothing unattributable could ever
 * be graded again. That is pass 45's overdue-rent hazard rebuilt as a policy.
 *
 * `null` is the better answer, and not merely the safer one. A series with no
 * account and no postings has never been observed charging ANYWHERE; the app has
 * not once seen it happen, so it is in no position to report that it failed to.
 * Every series on the real ledger that carries no `account_id` — rent, the cash
 * job, FPL, Breezeline — has postings, and those postings name the accounts. The
 * only members of this population are commitments registered for a future date
 * (the car lease, the car insurance), which are never graded as past anyway.
 */
export function frontierForSeries(
  frontier: ObservationFrontier,
  accountIds: ReadonlySet<string> | undefined,
): string | null {
  let bound: string | null = null;
  for (const id of accountIds ?? []) {
    const through = frontier.byAccount.get(id);
    if (through === undefined) continue;
    bound = earliest(bound, through);
  }
  return bound;
}
