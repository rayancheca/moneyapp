import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances, type AnchorSource, type BalanceBasis } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates, todayIso } from "@/lib/dates";
import { rebuildInvestmentHistory } from "./crypto-history";

/**
 * The balance-derivation engine (schema.md daily_balances):
 * ground-truth anchors + transaction replay → an honest daily curve.
 * Levels are never invented — spans that cannot be verified are marked
 * `gap`, `carried`, or `derived_unverified`, never silently smoothed.
 *
 * Anchor roles:
 * - chain-grade (statement, manual): end-of-day claims — replay endpoints,
 *   closure is checked between consecutive ones.
 * - moment (ofx_ledger, live): point-in-time observations — never chain
 *   endpoints, exempt from exact closure (schema.md anchor precedence).
 */

const ANCHOR_PRECEDENCE: Record<AnchorSource, number> = {
  statement: 0,
  ofx_ledger: 1,
  manual: 2,
  live: 3,
};

const CHAIN_GRADE: ReadonlySet<AnchorSource> = new Set(["statement", "manual"]);

interface Anchor {
  anchoredOn: string;
  balanceCents: number;
  source: AnchorSource;
}

interface DayRow {
  day: string;
  balanceCents: number;
  basis: BalanceBasis;
}

/** Highest-precedence anchor per date. */
export function pickWinners(anchors: readonly Anchor[]): Anchor[] {
  const byDate = new Map<string, Anchor>();
  for (const a of anchors) {
    const current = byDate.get(a.anchoredOn);
    if (!current || ANCHOR_PRECEDENCE[a.source] < ANCHOR_PRECEDENCE[current.source]) {
      byDate.set(a.anchoredOn, a);
    }
  }
  return [...byDate.values()].sort((x, y) => compareDates(x.anchoredOn, y.anchoredOn));
}

/**
 * Pure derivation: winners + per-day transaction sums → daily rows.
 * Exported for exhaustive unit testing; rebuildAccount wires it to the DB.
 */
export function deriveDailyRows(
  winners: readonly Anchor[],
  txnSumByDay: ReadonlyMap<string, number>,
  options: { isInvestment: boolean; today: string },
): DayRow[] {
  const { isInvestment, today } = options;
  if (winners.length === 0) return [];

  const chain = winners.filter((w) => CHAIN_GRADE.has(w.source));
  const moments = winners.filter((w) => !CHAIN_GRADE.has(w.source));
  // moment anchors only carry the curve when nothing chain-grade exists
  const endpoints = chain.length > 0 ? chain : moments;

  const rows = new Map<string, DayRow>();
  const put = (day: string, balanceCents: number, basis: BalanceBasis) => {
    rows.set(day, { day, balanceCents, basis });
  };

  for (const e of endpoints) put(e.anchoredOn, e.balanceCents, "anchored");

  const txnDays = [...txnSumByDay.keys()].sort(compareDates);
  const firstTxnDay = txnDays[0];
  const lastEndpoint = endpoints.at(-1);
  const firstEndpoint = endpoints[0];
  if (!lastEndpoint || !firstEndpoint) return [];

  if (isInvestment) {
    // value anchors + step-hold; replay never applies (buys/sells are
    // net-worth-neutral inside the account; market movement isn't a txn)
    fillBetweenCarried(endpoints, put);
    carryForward(lastEndpoint, today, put);
  } else {
    deriveCashSpans(endpoints, txnSumByDay, put);
    deriveBackward(firstEndpoint, txnSumByDay, firstTxnDay, put);
    deriveForward(lastEndpoint, txnSumByDay, today, put);
  }

  // a same-day 'live' moment observation wins the display for today only
  const liveToday = moments.find((m) => m.source === "live" && m.anchoredOn === today);
  if (liveToday) put(today, liveToday.balanceCents, "anchored");

  return [...rows.values()].sort((a, b) => compareDates(a.day, b.day));
}

function fillBetweenCarried(
  endpoints: readonly Anchor[],
  put: (day: string, cents: number, basis: BalanceBasis) => void,
) {
  for (let i = 0; i < endpoints.length - 1; i++) {
    const a = endpoints[i]!;
    const b = endpoints[i + 1]!;
    for (let d = addDays(a.anchoredOn, 1); compareDates(d, b.anchoredOn) < 0; d = addDays(d, 1)) {
      put(d, a.balanceCents, "carried");
    }
  }
}

function carryForward(
  last: Anchor,
  today: string,
  put: (day: string, cents: number, basis: BalanceBasis) => void,
) {
  for (let d = addDays(last.anchoredOn, 1); compareDates(d, today) <= 0; d = addDays(d, 1)) {
    put(d, last.balanceCents, "carried");
  }
}

function deriveCashSpans(
  endpoints: readonly Anchor[],
  txnSumByDay: ReadonlyMap<string, number>,
  put: (day: string, cents: number, basis: BalanceBasis) => void,
) {
  for (let i = 0; i < endpoints.length - 1; i++) {
    const a = endpoints[i]!;
    const b = endpoints[i + 1]!;
    let balance = a.balanceCents;
    let sawTxn = false;
    const spanRows: { day: string; cents: number }[] = [];
    for (let d = addDays(a.anchoredOn, 1); compareDates(d, b.anchoredOn) < 0; d = addDays(d, 1)) {
      const sum = txnSumByDay.get(d);
      if (sum !== undefined) sawTxn = true;
      balance += sum ?? 0;
      spanRows.push({ day: d, cents: balance });
    }
    const computedAtB = balance + (txnSumByDay.get(b.anchoredOn) ?? 0);
    if (txnSumByDay.get(b.anchoredOn) !== undefined) sawTxn = true;

    if (!sawTxn) {
      // no transaction data in the span: equal anchors step-hold; unequal
      // anchors mean missing data — an honest gap, never an invented slope
      const basis: BalanceBasis = a.balanceCents === b.balanceCents ? "carried" : "gap";
      for (const r of spanRows) put(r.day, a.balanceCents, basis);
    } else if (computedAtB === b.balanceCents) {
      for (const r of spanRows) put(r.day, r.cents, "derived");
    } else {
      // chain does not close — replayed values kept for inspection, marked gap
      for (const r of spanRows) put(r.day, r.cents, "gap");
    }
  }
}

function deriveBackward(
  first: Anchor,
  txnSumByDay: ReadonlyMap<string, number>,
  firstTxnDay: string | undefined,
  put: (day: string, cents: number, basis: BalanceBasis) => void,
) {
  if (!firstTxnDay || compareDates(firstTxnDay, first.anchoredOn) >= 0) return;
  let balance = first.balanceCents;
  // extends one day past the earliest transaction: the opening level is
  // arithmetically known; anything earlier would be invention
  for (let d = first.anchoredOn; compareDates(d, firstTxnDay) >= 0; ) {
    balance -= txnSumByDay.get(d) ?? 0;
    d = addDays(d, -1);
    put(d, balance, "derived_unverified");
  }
}

function deriveForward(
  last: Anchor,
  txnSumByDay: ReadonlyMap<string, number>,
  today: string,
  put: (day: string, cents: number, basis: BalanceBasis) => void,
) {
  let balance = last.balanceCents;
  let sawTxn = false;
  for (let d = addDays(last.anchoredOn, 1); compareDates(d, today) <= 0; d = addDays(d, 1)) {
    const sum = txnSumByDay.get(d);
    if (sum !== undefined) sawTxn = true;
    balance += sum ?? 0;
    put(d, balance, sawTxn ? "derived_unverified" : "carried");
  }
}

/** Rebuilds the derived cache for one account in a single sync transaction. */
export function rebuildAccount(db: AppDatabase, accountId: string, today: string = todayIso()): void {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`rebuildAccount: unknown account ${accountId}`);

  // Investment accounts with a quantity timeline derive value from
  // holding_events × daily closes (Stage 4a) — NOT value-anchor step-hold, which
  // only knows the seed day. Delegating here also stops an import/anchor rebuild
  // from wiping a computed crypto/equity curve. Accounts with no events (a bare
  // value-anchored holding) keep the anchor path below.
  if (account.type === "investment") {
    const hasEvents = db
      .select({ id: holdingEvents.id })
      .from(holdingEvents)
      .where(eq(holdingEvents.accountId, accountId))
      .limit(1)
      .get();
    if (hasEvents) {
      rebuildInvestmentHistory(db, accountId, today);
      return;
    }
  }

  const anchors = db
    .select({
      anchoredOn: balanceAnchors.anchoredOn,
      balanceCents: balanceAnchors.balanceCents,
      source: balanceAnchors.source,
    })
    .from(balanceAnchors)
    .where(eq(balanceAnchors.accountId, accountId))
    .all();

  const txns = db
    .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        // 'excluded' hides a txn from analytics only — the money still moved,
        // so balance replay must include it or chains break
        inArray(transactions.status, ["active", "excluded"]),
      ),
    )
    .all();

  const txnSumByDay = new Map<string, number>();
  for (const t of txns) {
    txnSumByDay.set(t.postedOn, (txnSumByDay.get(t.postedOn) ?? 0) + t.amountCents);
  }

  const rows = deriveDailyRows(pickWinners(anchors), txnSumByDay, {
    isInvestment: account.type === "investment",
    today,
  });

  db.transaction((tx) => {
    tx.delete(dailyBalances).where(eq(dailyBalances.accountId, accountId)).run();
    for (const r of rows) {
      tx.insert(dailyBalances)
        .values({ accountId, day: r.day, balanceCents: r.balanceCents, basis: r.basis })
        .run();
    }
  });
}

export function rebuildAllAccounts(db: AppDatabase, today: string = todayIso()): void {
  const ids = db.select({ id: accounts.id }).from(accounts).all();
  for (const { id } of ids) rebuildAccount(db, id, today);
}

export interface NetWorthPoint {
  day: string;
  totalCents: number;
  coveredAccounts: number;
  totalAccounts: number;
  complete: boolean;
}

/**
 * Net-worth series with honest completeness: a day is complete only when
 * every active account has non-gap coverage — partial days are annotated,
 * never silently understated (schema.md net worth series).
 */
export function netWorthSeries(db: AppDatabase): NetWorthPoint[] {
  const activeAccounts = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.isActive, true))
    .all();
  if (activeAccounts.length === 0) return [];
  const activeIds = activeAccounts.map((a) => a.id);

  const rows = db
    .select()
    .from(dailyBalances)
    .where(inArray(dailyBalances.accountId, activeIds))
    .orderBy(asc(dailyBalances.day))
    .all();

  const byDay = new Map<string, { total: number; covered: number }>();
  for (const r of rows) {
    if (r.basis === "gap") continue;
    const entry = byDay.get(r.day) ?? { total: 0, covered: 0 };
    byDay.set(r.day, { total: entry.total + r.balanceCents, covered: entry.covered + 1 });
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => compareDates(a, b))
    .map(([day, { total, covered }]) => ({
      day,
      totalCents: total,
      coveredAccounts: covered,
      totalAccounts: activeIds.length,
      complete: covered === activeIds.length,
    }));
}

export interface AccountSeriesPoint {
  day: string;
  balanceCents: number;
  basis: BalanceBasis;
}

/** One account's covered daily balances, oldest first (gap days excluded). */
export function accountSeries(db: AppDatabase, accountId: string): AccountSeriesPoint[] {
  return db
    .select()
    .from(dailyBalances)
    .where(eq(dailyBalances.accountId, accountId))
    .orderBy(asc(dailyBalances.day))
    .all()
    .filter((r) => r.basis !== "gap")
    .map((r) => ({ day: r.day, balanceCents: r.balanceCents, basis: r.basis }));
}

export interface AccountBalance {
  accountId: string;
  balanceCents: number | null;
  basis: BalanceBasis | null;
  asOf: string | null;
}

/** Latest known balance per account (today's row or the most recent one). */
export function latestBalances(db: AppDatabase): Map<string, AccountBalance> {
  const rows = db.select().from(dailyBalances).orderBy(asc(dailyBalances.day)).all();
  const result = new Map<string, AccountBalance>();
  for (const r of rows) {
    if (r.basis === "gap") continue;
    result.set(r.accountId, {
      accountId: r.accountId,
      balanceCents: r.balanceCents,
      basis: r.basis,
      asOf: r.day,
    });
  }
  return result;
}
