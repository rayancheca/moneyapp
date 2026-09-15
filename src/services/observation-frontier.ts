import { cache } from "react";
import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
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

/**
 * ⚡ MEMOISED FOR ONE SERVER RENDER — see `buildPortfolio` in
 * `services/portfolio` for why `react`'s `cache` and not a module-level Map.
 * Measured four calls at 1.1ms per dashboard render on the owner's ledger.
 */
export const observationFrontier = cache(function observationFrontier(db: AppDatabase): ObservationFrontier {
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
});

/**
 * The day an account's BALANCE was last observed: the latest of its newest
 * active row and newest statement end (`observationFrontier`) and its newest
 * recorded balance. Keyed by every non-investment account with any of the three.
 *
 * 🔴 S24: EVERY SURFACE THAT DATED A BALANCE NAMED THE DAY THE CACHE WAS
 * REBUILT. `daily_balances` walks forward to whatever `today` stood at the last
 * rebuild, so the newest row is the IMPORT day. Measured 2026-09-14:
 * /?cards=grid read "Discover · 1 account · as of Sep 14, 2026" beside
 * "Discover adds up through Sep 8, 2026" (newest charge Sep 1, statement
 * closing Sep 8), and `/accounts/<Chase Checking>` read "as of Aug 14, 2026 ·
 * carried" of an account whose newest row and statement both end Aug 12. All
 * 9 non-investment accounts with a balance read a cached day later than this
 * one; on all 9 the balance on this day equals the newest. `cardsOwed` had
 * already refused the rebuild day for the same balances.
 *
 * ⛔ One rule, owner's decision 2026-09-14 (S24 option a): the institution
 * cards (dashboard and both /accounts lenses), the /accounts/[id] header and
 * the account insights window all read it through `cutToObserved`.
 *
 * ⚠️ ABSENT — and so never cut — for two kinds of account:
 *
 *  - **investment**: marked to market and priced through today; "observed" is
 *    not a fact about it, exactly as above.
 *  - **nothing at all**: no row, no statement, no recorded balance (Capital One
 *    360 Checking on 2026-09-15). It has no series to cut.
 *
 * 🔴 AN ACCOUNT WITH ONLY RECORDED BALANCES WAS LEFT OUT. This read only the
 * accounts `observationFrontier` holds, so a balance recorded on Sep 10 with no
 * row beside it stayed dated by the rebuild — "as of Tue, Sep 15, 2026 ·
 * carried" on the header, "today" on its card (review of 540c338, 2026-09-15).
 * The owner's rule names the recorded balance with no carve-out, and a count of
 * cash in a safe is exactly the kind of observation it means. Not live that
 * day; Cash on Hand was in this state from its Aug 3, 2026 opening balance until
 * its Aug 11 row.
 *
 * ⚠️ The anchor term decides only when a balance was recorded AFTER the newest
 * row and statement — a count of cash newer than the last import is itself an
 * observation. On 2026-09-14 no account's newest anchor is later than its
 * frontier (Cash on Hand's 08-03 predates its 08-11 row).
 */
export const observedThrough = cache(function observedThrough(db: AppDatabase): ReadonlyMap<string, string> {
  const newestAnchor = new Map(
    db
      .select({ accountId: balanceAnchors.accountId, day: sql<string>`max(${balanceAnchors.anchoredOn})` })
      .from(balanceAnchors)
      .innerJoin(accounts, eq(accounts.id, balanceAnchors.accountId))
      .where(ne(accounts.type, "investment"))
      .groupBy(balanceAnchors.accountId)
      .all()
      .map((r) => [r.accountId, r.day] as const),
  );
  const out = new Map<string, string>();
  for (const [accountId, through] of observationFrontier(db).byAccount) {
    out.set(accountId, latest(through, newestAnchor.get(accountId) ?? null) ?? through);
  }
  // observed by a recorded balance alone — no row, no statement
  for (const [accountId, day] of newestAnchor) {
    if (!out.has(accountId)) out.set(accountId, day);
  }
  return out;
});

/**
 * A covered balance series cut at the day it was observed: every point on or
 * before `through`, none after.
 *
 * ⛔ The ONE cut for every surface that dates a balance, so a card and the page
 * it links to cannot name two days for one balance. Callers cut the series
 * FIRST and read the as-of day, the balance, the day change and the spark off
 * the result.
 *
 * ⚠️ `through` undefined — an account `observedThrough` does not hold — leaves
 * the series whole. So does a cut that would leave nothing: a card is never
 * nulled by its own date.
 */
export function cutToObserved<T extends { day: string }>(series: readonly T[], through: string | undefined): readonly T[] {
  if (through === undefined) return series;
  // ordered oldest first, so only the tail past `through` needs comparing
  let end = series.length;
  while (end > 0 && compareDates(series[end - 1]!.day, through) > 0) end -= 1;
  return end === 0 || end === series.length ? series : series.slice(0, end);
}

/**
 * The day the ledger begins: the earliest ACTIVE transaction, or null when
 * there is none.
 *
 * ⛔ Anything that averages "the last N months" has to compare its window
 * against this, or its early months are averaging imports that were never made.
 * A month with no spending is a real zero; a month before the ledger began is
 * not a measurement at all — and the difference is the whole reason this is a
 * function rather than a comment. `moversCard` stated the rule and applied it;
 * `spendBaseline` did not, and published a runway roughly twice as long on a
 * ledger younger than its own six-month window.
 *
 * ⚠️ Earliest ACTIVE TRANSACTION, not earliest month with spending: two quiet
 * months at the front of a long ledger are not the same thing as a ledger that
 * had not started, and the second reading would blank a card over an ordinary
 * quiet January.
 */
export function ledgerOpens(db: AppDatabase): string | null {
  return (
    db
      .select({ postedOn: transactions.postedOn })
      .from(transactions)
      .where(eq(transactions.status, "active"))
      .orderBy(asc(transactions.postedOn))
      .limit(1)
      .get()?.postedOn ?? null
  );
}

/**
 * The newest day the ledger has been imported THROUGH — the later of the newest
 * ACTIVE transaction on any account and the newest statement end on a
 * non-investment account. Null when the ledger holds neither.
 *
 * ⛔ The sibling of `ledgerOpens`, and the same warning applies at the other
 * end: days after this are days nobody has looked at, not days on which
 * nothing happened. A surface that averages, projects or grades across them is
 * publishing a lower bound as a measurement.
 *
 * 🔴 S32: THIS COUNTED TRANSACTIONS ONLY, and so called the quiet tail of a
 * statement unobserved — the exact misreading `observationFrontier`'s own
 * docstring above rules out. Measured 2026-09-14: the newest active row is Sep
 * 12 and Venture X's statement closes Sep 13. The dashboard's pace tile read "2
 * days of September 2026 not imported yet", the heatmap called Sep 13 "not
 * imported yet" while calling Sep 9 — covered by the same statement — "nothing
 * spent or earned", and `/spending?period=2026-09-13` said "the ledger stops on
 * Sat, Sep 12, 2026", all beside MoversCard's "Venture X imported through Sep
 * 13". Every caller inherits this: the dashboard's pace tile, /spending's
 * readout, heatmap and cash-flow buckets (`spending.ts`), `emptyPeriodReason`'s
 * pages, `summedRowsProvenance`'s empty branch, the category trend (on
 * /categories/[id] and in `spending-insights`), and merchants' year marks and
 * note (`merchants.ts` → `merchantProfile`).
 *
 * ⚠️ Two asymmetries, both deliberate:
 *
 *  - **rows on EVERY account, investment included.** A ledger whose only rows
 *    are brokerage rows has still been imported to them. That is why this is
 *    NOT `max(observationFrontier.byAccount)`, which drops investment accounts
 *    and would read null there.
 *  - **statement ends on non-investment accounts only**, exactly as
 *    `observationFrontier`. A brokerage statement records a value; it does not
 *    show a day of spending. Robinhood's closes 2026-07-31 and must not vouch
 *    for anything.
 *
 * ⚠️ Whole-ledger, unlike `observationFrontier`, which is per-account: the
 * question here is whether ANY account has been imported for this day.
 * `ledgerOpens` stays transactions-only — a statement's START is not proof the
 * import walked that far back, and the before-records split depends on it.
 */
export function ledgerReaches(db: AppDatabase): string | null {
  const newestRow =
    db
      .select({ postedOn: transactions.postedOn })
      .from(transactions)
      .where(eq(transactions.status, "active"))
      .orderBy(desc(transactions.postedOn))
      .limit(1)
      .get()?.postedOn ?? null;
  const newestStatementEnd =
    db
      .select({ day: sql<string | null>`max(${statementPeriods.periodEnd})` })
      .from(statementPeriods)
      .innerJoin(accounts, eq(accounts.id, statementPeriods.accountId))
      .where(ne(accounts.type, "investment"))
      .get()?.day ?? null;
  return latest(newestRow, newestStatementEnd);
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
 * only members of this population are commitments registered by hand that have
 * never charged (the car lease, the gym, parking): a past occurrence of one reads
 * "not imported yet", never "missed".
 *
 * ⚠️ A posting names the account a charge was PAID from, which need not be the
 * account the next one bills on. 🔴 This docstring used to count the car
 * insurance among the never-charged. Measured 2026-09-14: its one linked charge
 * is on Venture X, imported through 09-13, while it was registered as "#1 paid on
 * Venture X, #2-6 Wells Fargo" (scripts/register-car-commitments.ts), Wells Fargo
 * imported through 08-25, with `account_id` left NULL. So this frontier vouched
 * for its Sep 11 on an account that does not pay it, and only `ScheduleProven`
 * (one posting is too few) kept that day off "missed". The owner chose the same
 * day not to record an account the ledger holds no payment from.
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
