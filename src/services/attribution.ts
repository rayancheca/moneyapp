import { and, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { transactions } from "@/db/schema/transactions";
import { attribute, type Attribution, type Restatement } from "@/lib/attribution";
import { compareDates } from "@/lib/dates";
import { loadCategoryIndex } from "./analytics";
import { REPLAY_STATUSES } from "./derivation";
import { inTransitAt } from "./in-flight";
import { marketChangeBetween } from "./portfolio";

/**
 * The measurements behind "net worth moved from X to Y, and here is why".
 *
 * `lib/attribution` owns the arithmetic and the honesty rules; this owns the
 * queries, and every one of them is chosen so the identity CLOSES rather than
 * nearly closes. Three of those choices were found by measuring, not by reading:
 *
 * 1. **Half-open windows, `(from, to]`.** Balance replay and `ledger-check`
 *    treat `from` as a baseline day whose transactions are already inside the
 *    opening balance; `periodTotals` and `activeTxnsInRange` treat it as counted.
 *    Measured, the 2026-07-01 boundary day alone carries $1,454.90 — a bridge
 *    mixing the two conventions misstates July by that much while proudly
 *    reporting `unexplained = $0.00`.
 *
 * 2. **`REPLAY_STATUSES`, not `status = 'active'`.** The balance side reads
 *    active AND excluded rows (an excluded row is hidden from analytics and
 *    still moves money — that is where pass 59 found a fabricated plug hiding).
 *    Reading a narrower set here would open a hole the size of the excluded rows.
 *
 * 3. **Investment accounts contribute NO transactions.** Their daily balance is
 *    never rebuilt from replay — with holding events it is quantity × cached
 *    close, without them it is value anchors held flat — so their rows moved no
 *    balance, and counting them double-counts the market term. Measured cost of
 *    getting it wrong: $35,938.24 over four years. ⛔ The divider is the account
 *    TYPE, not `investmentSideAccountIds()`, which includes the settlement-cash
 *    sibling and IS replayed.
 */

/**
 * Accounts whose daily balance is NOT rebuilt from their transactions.
 *
 * Every `investment` account, and only those. Two different code paths get an
 * investment account to the same place — with holding events it is
 * quantity × cached close (`rebuildInvestmentHistory`), and without them it is
 * value anchors held flat (`deriveDailyRows`, whose own comment reads *"value
 * anchors + step-hold; replay never applies"*) — so in neither case did a
 * transaction on the account move its balance.
 *
 * ⚠️ I first wrote this as "investment AND has holding events", which is the
 * same set on today's ledger (both investment accounts have events) and would
 * have shipped green. A test on a bare value-anchored investment account caught
 * it: that account does not replay either, and counting its rows would have
 * opened a hole the moment one existed.
 *
 * ⛔ NOT `investmentSideAccountIds()`. That includes Robinhood Cash — the
 * settlement-cash sibling, typed `checking`, which very much does replay and
 * carries 1,989 rows worth −$55,659.37. Using it as the divider would delete
 * them from the bridge.
 */
export function nonReplayingAccountIds(db: AppDatabase): Set<string> {
  const rows = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.type, "investment"))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** An account's balance as of `day`: its latest non-gap row on or before it. */
function balanceAsOf(db: AppDatabase, accountId: string, day: string): number {
  const row = db
    .select({ cents: dailyBalances.balanceCents })
    .from(dailyBalances)
    .where(
      and(
        eq(dailyBalances.accountId, accountId),
        lte(dailyBalances.day, day),
        ne(dailyBalances.basis, "gap"),
      ),
    )
    .orderBy(sql`${dailyBalances.day} desc`)
    .limit(1)
    .get();
  return row?.cents ?? 0;
}

interface KindTotals {
  earnedCents: number;
  refundsCents: number;
  spentCents: number;
  movedCents: number;
}

/**
 * Every replayed row in the window, summed by what its category KIND does to net
 * worth.
 *
 * ⚠️ Exhaustive by construction: every row lands in exactly one of the four
 * buckets, and `moved` is the catch-all rather than a `continue`. `periodTotals`
 * drops what it cannot classify — correct for a spending tab, fatal here, where
 * a dropped row becomes phantom `unexplained`. Measured over July–August it
 * discards +$18,870.53 of transfer- and investment-kind rows, which is seven
 * times the window's entire net movement.
 */
function kindTotals(db: AppDatabase, from: string, to: string, skip: ReadonlySet<string>): KindTotals {
  const idx = loadCategoryIndex(db);
  const rows = db
    .select({
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        gt(transactions.postedOn, from),
        lte(transactions.postedOn, to),
        inArray(transactions.status, [...REPLAY_STATUSES]),
      ),
    )
    .all();

  const t: KindTotals = { earnedCents: 0, refundsCents: 0, spentCents: 0, movedCents: 0 };
  for (const r of rows) {
    if (skip.has(r.accountId)) continue;
    const kind = r.categoryId === null ? null : idx.topLevelOf(r.categoryId).kind;
    if (kind === "income" && r.amountCents > 0) {
      t.earnedCents += r.amountCents;
      continue;
    }
    if (kind === "expense") {
      if (r.amountCents < 0) t.spentCents += r.amountCents;
      else t.refundsCents += r.amountCents;
      continue;
    }
    /*
     * Everything else: transfers, investment contributions, rewards, system,
     * uncategorised, and an income-kind CLAWBACK (a credit that returns money
     * previously recorded as income — see docs/income-ground-truth.md, it is not
     * negative earnings). These move net worth or move money between accounts,
     * and the bridge's job is to show the net rather than to decide which.
     */
    t.movedCents += r.amountCents;
  }
  return t;
}

/**
 * Balance movement on a replaying account that its own transactions do not
 * explain — an anchor restating the balance, or the account entering coverage.
 *
 * Investment accounts are skipped here as well as in the transaction sum: their
 * whole movement is the portfolio engine's to explain, as market gain plus flow,
 * and reporting it here as well would name the same money twice.
 *
 * Measured across the whole 1,462-day axis, this is nonzero on exactly ONE day
 * in four years: 2026-08-03, +$5,000.00, the manual anchor opening `Cash on
 * Hand`. ⛔ That anchor is the owner's decision — the account is an untracked
 * cash float, not a ledger — so the bridge NAMES it rather than treating it as a
 * defect to be reconciled away.
 */
function restatementsIn(
  db: AppDatabase,
  from: string,
  to: string,
  skip: ReadonlySet<string>,
): Restatement[] {
  const all = db.select({ id: accounts.id, name: accounts.name }).from(accounts).all();
  const out: Restatement[] = [];
  for (const a of all) {
    if (skip.has(a.id)) continue;
    const delta = balanceAsOf(db, a.id, to) - balanceAsOf(db, a.id, from);
    const txn =
      db
        .select({ c: sql<number | null>`sum(${transactions.amountCents})` })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, a.id),
            gt(transactions.postedOn, from),
            lte(transactions.postedOn, to),
            inArray(transactions.status, [...REPLAY_STATUSES]),
          ),
        )
        .get()?.c ?? 0;
    const cents = delta - txn;
    if (cents === 0) continue;
    // An anchor dated inside the window is the evidence; without one the only
    // other way a replayed balance can move without a row is the account's own
    // first covered day, which is an opening.
    const anchored = db
      .select({ n: sql<number>`count(*)` })
      .from(balanceAnchors)
      .where(
        and(
          eq(balanceAnchors.accountId, a.id),
          gt(balanceAnchors.anchoredOn, from),
          lte(balanceAnchors.anchoredOn, to),
        ),
      )
      .get()?.n ?? 0;
    out.push({ accountName: a.name, cents, reason: anchored > 0 ? "anchor" : "opening" });
  }
  return out.sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents) || x.accountName.localeCompare(y.accountName));
}

export interface NetWorthAttribution extends Attribution {
  from: string;
  to: string;
  openingCents: number;
  closingCents: number;
}

/**
 * The bridge for one window, assembled and proven.
 *
 * `openingCents` / `closingCents` are supplied by the caller rather than
 * re-derived here, because the only correct source is the same bridged series
 * the dashboard prints — re-deriving it would be a second implementation of net
 * worth, and two of those is how a page ends up disagreeing with its own hero.
 */
export function netWorthAttribution(
  db: AppDatabase,
  from: string,
  to: string,
  openingCents: number,
  closingCents: number,
): NetWorthAttribution {
  if (compareDates(from, to) > 0) {
    throw new Error(`netWorthAttribution: window runs backwards (${from} → ${to})`);
  }
  const skip = nonReplayingAccountIds(db);
  const totals = kindTotals(db, from, to, skip);
  const market = marketChangeBetween(db, from, to);

  const restatements = restatementsIn(db, from, to, skip);
  /*
   * The holdings side has one opening the replay side cannot see: the portfolio
   * beginning to exist. It is named here rather than absorbed, because an
   * all-time bridge otherwise reports $20.19 of "unaccounted" and the only
   * honest reading of an unaccounted number is that something is wrong.
   */
  if (market.openedInWindowCents !== 0) {
    restatements.push({
      accountName: "Holdings",
      cents: market.openedInWindowCents,
      reason: "opening",
    });
  }

  return {
    from,
    to,
    openingCents,
    closingCents,
    ...attribute({
      openingCents,
      closingCents,
      ...totals,
      marketCents: market.gainCents,
      portfolioFlowCents: market.netFlowCents,
      inTransitDeltaCents: inTransitAt(db, to) - inTransitAt(db, from),
      restatements,
    }),
  };
}
