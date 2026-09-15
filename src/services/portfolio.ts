import { cache } from "react";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, type AssetType } from "@/db/schema/holdings";
import { transactions } from "@/db/schema/transactions";
import { benchmarkAssetType } from "@/lib/benchmark-symbol";
import { rangeStartDay, type ChartRange } from "@/lib/chart-range";
import { windowedPoints } from "@/lib/chart-window";
import { addDays, compareDates, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { newestCloses, type ClosePair } from "@/lib/day-change-label";
import { carryForwardTo } from "@/lib/price-series";
import {
  aggregateReturn,
  dailyReturns,
  moneyWeightedReturn,
  totalReturn,
  type BenchmarkDay,
  type PortfolioDay,
  type WindowReturn,
} from "@/lib/portfolio-returns";
import {
  realizedPnl,
  realizedSales,
  sumRealized,
  type RealizedPnl,
  type RealizedSale,
  type ValuedTrade,
} from "@/lib/realized-pnl";
import { investmentSideAccountIds, ownPortfolioAccountIds } from "./accounts";
import { accountSeries } from "./derivation";
import { adjustedHoldingEvents } from "./holding-timeline";
import { valueCentsOf } from "./holdings";

/**
 * Portfolio series + return math (ux-overhaul-plan §6.2). Two honest scopes:
 *
 * - VALUE (portfolio value chart, holdings, allocation, day change): the whole
 *   portfolio — both investment accounts — summed from the reconciled daily
 *   balances the crypto-history engine already computed.
 * - RETURN (TWR): each day's net flow into positions is every quantity change
 *   that day valued at the SAME daily close the NAV uses — Σ(Δqty × close) from
 *   the reconciled holding_events timeline. That makes a buy, sell, split, or
 *   opening exactly return-neutral (the NAV is the same cumsum × the same
 *   closes), so no trade ever reads as a gain and no small early base amplifies
 *   an execution-vs-close basis into a phantom return. This is valuation-
 *   consistent with the NAV and needs no cash — equally exact for equities and
 *   crypto (crypto's cash lives in statements, but its *position* return does
 *   not). It is NOT holdingEvents.costCents (running-average basis, display-only
 *   per schema.md). The headline TWR is the whole portfolio, labeled with its
 *   anchor (the first covered day).
 */

export interface InvestmentAccountInfo {
  id: string;
  name: string;
  subtype: string | null;
  isCrypto: boolean;
}

/**
 * Active investment accounts in HIS portfolio, crypto flagged (subtype 'crypto') — every scope below that reports
 * his value, returns or holdings reads this.
 *
 * ⚖️ Not the brokerage book paired with Robinhood Agentic: the owner kept that account out of his own brokerage
 * returns (2026-09-14). See `ownPortfolioAccountIds`.
 */
export function investmentAccounts(db: AppDatabase): InvestmentAccountInfo[] {
  const own = ownPortfolioAccountIds(db);
  return valuedInvestmentAccounts(db).filter((a) => own.has(a.id));
}

/**
 * EVERY active investment account the engine can value, his or not — what a caller asking for a book BY ID reads:
 * `pnpm ledger-check`'s value-anchor witness checks the agent's book against its statements like any other.
 */
export function valuedInvestmentAccounts(db: AppDatabase): InvestmentAccountInfo[] {
  return db
    .select({ id: accounts.id, name: accounts.name, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.type, "investment"), eq(accounts.isActive, true)))
    .orderBy(asc(accounts.name))
    .all()
    .map((a) => ({ ...a, isCrypto: a.subtype === "crypto" }));
}

/**
 * Net flow into positions per day = every quantity change valued at that day's
 * close, Σ valueCentsOf(Δqty, closeOnOrBefore(symbol, day)). Valuation-consistent
 * with the NAV, so a trade contributes nothing to return. The account's opening
 * is handled by the caller (first day = full NAV), so this covers day > firstDay.
 */
function flowsByDay(db: AppDatabase, accountId: string): Map<string, number> {
  /*
   * ⛔ Split-adjusted, so a split contributes NO flow. Valued as stored, COKE's
   * 2025-05-27 delta of +9.013095 read as a $1,017.85 contribution on a day
   * nothing was bought: the real trades came to $1,109.89 and this reported
   * $2,127.74.
   *
   * ⚠️ And it had to move WITH the NAV, not after it. `return = ΔNAV − flow`,
   * so the fake $1,017.42 step in the level and the fake $1,017.85 of flow very
   * nearly annihilated — fixing the NAV alone would have turned a cancelled
   * pair of errors into a $1,017.85 loss on a day the market did nothing.
   */
  const events = adjustedHoldingEvents(db, accountId).map((e) => ({
    day: e.occurredOn,
    symbol: e.symbol,
    assetType: e.assetType,
    deltaE8: e.quantityDeltaE8,
  }));
  const map = new Map<string, number>();
  const earliestCloseCache = new Map<string, string | null>();
  for (const e of events) {
    let day = e.day;
    let close = closeOn(db, e.symbol, e.assetType, e.day);
    if (close === null) {
      // the symbol was acquired before its price history begins (a newly-listed
      // token, a partial backfill, or a provider gap): rebuildInvestmentHistory
      // omits it from the NAV until its first close, so the position ENTERS the
      // NAV on that first priceable day. Roll the flow forward to that day valued
      // at its close, so the appearance is neutralized (returnCents = 0) — never
      // a fabricated one-day gain equal to the whole position.
      const key = `${e.assetType}|${e.symbol}`;
      let first = earliestCloseCache.get(key);
      if (first === undefined) {
        first = earliestCloseDay(db, e.symbol, e.assetType);
        earliestCloseCache.set(key, first);
      }
      if (first === null) continue; // no close ever → not in the NAV either
      day = first;
      close = closeOn(db, e.symbol, e.assetType, first);
      if (close === null) continue;
    }
    map.set(day, (map.get(day) ?? 0) + valueCentsOf(e.deltaE8, close));
  }
  return map;
}

interface AccountBook {
  firstDay: string;
  lastDay: string;
  /** dense day → nav cents, carried forward across missing interior days */
  navByDay: Map<string, number>;
  /** dense day → { flow into positions, whether cent-exact } */
  flowByDay: Map<string, { flowCents: number; exact: boolean }>;
  /** dense day → true when the equity close was carried (markets closed) */
  carriedByDay: Map<string, boolean>;
}

/**
 * One account's dense daily NAV + per-day flows. Every quantity change is valued
 * at that day's close (Σ Δqty × close) so trades are return-neutral; the first
 * covered day is neutralized by its full NAV so the opening position is not a
 * gain (the "phantom seed-day" case). All exact — the valuation is consistent
 * with the NAV and needs no cash.
 */
function buildAccountBook(db: AppDatabase, account: InvestmentAccountInfo): AccountBook | null {
  const series = accountSeries(db, account.id);
  if (series.length === 0) return null;

  const firstDay = series[0]!.day;
  const lastDay = series[series.length - 1]!.day;
  const rawNav = new Map(series.map((r) => [r.day, r.balanceCents]));
  const carriedSource = new Map(series.map((r) => [r.day, r.basis === "carried"]));

  // densify with carry-forward so a missing interior day is a flat day, never a gap
  const navByDay = new Map<string, number>();
  const carriedByDay = new Map<string, boolean>();
  let carry = series[0]!.balanceCents;
  let carriedFlag = carriedSource.get(firstDay) ?? false;
  for (let day = firstDay; compareDates(day, lastDay) <= 0; day = addDays(day, 1)) {
    if (rawNav.has(day)) {
      carry = rawNav.get(day)!;
      carriedFlag = carriedSource.get(day)!;
    } else {
      carriedFlag = true; // no row today → the level is carried
    }
    navByDay.set(day, carry);
    carriedByDay.set(day, carriedFlag);
  }

  const dayFlows = flowsByDay(db, account.id);
  const flowByDay = new Map<string, { flowCents: number; exact: boolean }>();
  for (let day = firstDay; compareDates(day, lastDay) <= 0; day = addDays(day, 1)) {
    // first covered day: neutralize the entire opening (which folds in any events
    // that predate the priceable window). Later days: this day's Δqty × close.
    const flowCents = day === firstDay ? navByDay.get(day)! : dayFlows.get(day) ?? 0;
    flowByDay.set(day, { flowCents, exact: true });
  }

  return { firstDay, lastDay, navByDay, flowByDay, carriedByDay };
}

/** navAt/flowAt with carry-forward past an account's last computed day. */
function navAt(book: AccountBook, day: string): number {
  if (compareDates(day, book.firstDay) < 0) return 0;
  if (compareDates(day, book.lastDay) >= 0) return book.navByDay.get(book.lastDay)!;
  return book.navByDay.get(day) ?? 0;
}

export interface PortfolioSeriesPoint {
  day: string;
  valueCents: number;
  coveredAccounts: number;
  totalAccounts: number;
  complete: boolean;
}

interface BuiltPortfolio {
  days: PortfolioDay[];
  /** parallel to days: coverage + markets-closed metadata for value/calendar UIs */
  meta: { coveredAccounts: number; totalAccounts: number; equityCarried: boolean }[];
  totalAccounts: number;
}

/**
 * The whole portfolio as flow-adjusted daily points plus per-day coverage/markets
 * metadata. Scoped to `accountIds` when given (the equity-only TWR uses that).
 */
/**
 * ⚡ MEMOIZED FOR THE LIFE OF ONE SERVER RENDER, and for no longer than that.
 *
 * Measured on the owner's ledger: this walk costs **57ms**, and the dashboard
 * ran it TWICE — `investmentsTeaser` asks `portfolioOverview` and
 * `portfolioSeries` for two views of the same build. That was 114ms of a 293ms
 * render, 39% of it, spent computing an identical answer a second time. The
 * `/investments` page ran it three times.
 *
 * ⛔ `react`'s `cache`, deliberately, and NOT a module-level Map. A cached
 * portfolio that outlives the request is a WRONG NUMBER the moment an import
 * lands, and this codebase has no invalidation signal it could trust —
 * SQLite's `data_version` does not move for writes on our own connection, which
 * is every write the app makes. `cache()` is scoped to one React request and
 * MEASURABLY does not memoize outside one (verified: two calls, two runs), so
 * tests, scripts and `pnpm ledger-check` behave exactly as before.
 *
 * ⚠️ It keys on argument identity, so the scoped `accountIds` overloads still
 * rebuild. Every hot caller passes nothing, which is the case worth having.
 */
const buildPortfolioFor = cache(function buildPortfolioFor(
  db: AppDatabase,
  scopeKey: string,
): BuiltPortfolio {
  const accountIds = scopeKey === "" ? undefined : scopeKey.split(",");
  // no scope is HIS portfolio; a scope names its books, whosever they are
  const scoped = accountIds
    ? valuedInvestmentAccounts(db).filter((a) => accountIds.includes(a.id))
    : investmentAccounts(db);
  const books = scoped
    .map((a) => ({ account: a, book: buildAccountBook(db, a) }))
    .filter((b): b is { account: InvestmentAccountInfo; book: AccountBook } => b.book !== null);

  if (books.length === 0) {
    return { days: [], meta: [], totalAccounts: scoped.length };
  }

  const globalFirst = books.reduce(
    (min, b) => (compareDates(b.book.firstDay, min) < 0 ? b.book.firstDay : min),
    books[0]!.book.firstDay,
  );
  const globalLast = books.reduce(
    (max, b) => (compareDates(b.book.lastDay, max) > 0 ? b.book.lastDay : max),
    books[0]!.book.lastDay,
  );

  const days: PortfolioDay[] = [];
  const meta: BuiltPortfolio["meta"] = [];
  for (let day = globalFirst; compareDates(day, globalLast) <= 0; day = addDays(day, 1)) {
    let navCents = 0;
    let flowCents = 0;
    let exact = true;
    let covered = 0;
    let equityCarried = false;
    for (const { account, book } of books) {
      if (compareDates(day, book.firstDay) < 0) continue;
      covered += 1;
      navCents += navAt(book, day);
      // flows/exactness only apply within an account's own computed window; once
      // carried past lastDay the position is flat (no flow, still exact)
      const flow = book.flowByDay.get(day);
      if (flow) {
        flowCents += flow.flowCents;
        if (!flow.exact) exact = false;
      }
      if (!account.isCrypto && (book.carriedByDay.get(day) ?? true)) equityCarried = true;
    }
    days.push({ day, navCents, flowCents, exact });
    meta.push({ coveredAccounts: covered, totalAccounts: books.length, equityCarried });
  }

  return { days, meta, totalAccounts: books.length };
});

/**
 * ⛔ THE SCOPE IS A STRING, and that is the whole reason the memo works.
 *
 * `cache()` keys on the arguments as passed, so `buildPortfolio(db)` and
 * `buildPortfolio(db, undefined)` are two different calls and miss each other —
 * measured, 2 builds per dashboard request with the memo already in place. An
 * array key would miss too: a fresh `[...]` is a fresh identity every call.
 * Normalising to a sorted string makes every caller that means "all accounts"
 * agree, and makes two callers asking for the same subset agree as well.
 */
function buildPortfolio(db: AppDatabase, accountIds?: readonly string[]): BuiltPortfolio {
  return buildPortfolioFor(db, accountIds ? [...accountIds].sort().join(",") : "");
}
/** Whole-portfolio positions value per day (the value chart's series). */
export function portfolioSeries(db: AppDatabase, accountIds?: readonly string[]): PortfolioSeriesPoint[] {
  const { days, meta } = buildPortfolio(db, accountIds);
  return days.map((d, i) => ({
    day: d.day,
    valueCents: d.navCents,
    coveredAccounts: meta[i]!.coveredAccounts,
    totalAccounts: meta[i]!.totalAccounts,
    complete: meta[i]!.coveredAccounts === meta[i]!.totalAccounts,
  }));
}

/** Flow-adjusted daily points for the whole portfolio (return math + calendar). */
export function portfolioReturnDays(db: AppDatabase, accountIds?: readonly string[]): PortfolioDay[] {
  return buildPortfolio(db, accountIds).days;
}

/**
 * How much of a window's holdings movement was the MARKET, and how much was
 * money going in or out.
 *
 * The plan for the net-worth bridge assumed this already existed as
 * `statement_periods.market_change_cents`. It does not: measured on the live
 * ledger that column is populated on 16 of 219 rows, every one of them Robinhood
 * Crypto, the newest period ends 2026-06-30, and Robinhood Brokerage — the
 * larger account — has no statement periods at all. So it can answer "how much
 * of THIS STATEMENT was the market" and never "how much of this month".
 *
 * The engine to answer it was already here and only ever sliced inside a client
 * hook (`ReturnViewParts`). This is that slice, lifted so the server can ask.
 *
 * ⚠️ `from` behaves as a BASELINE, not as a counted day: `dailyReturns` starts at
 * index 1, so the window is half-open `(from, to]`. That is the same convention
 * balance replay uses, and it is why a bridge built on this closes against a
 * net-worth delta rather than double-counting the opening day.
 */
export interface WindowMarketChange extends WindowReturn {
  /**
   * The portfolio's value on the first day it existed, when that day falls
   * INSIDE this window.
   *
   * `dailyReturns` starts at index 1, so the first day of any slice is a
   * baseline and contributes nothing. That is right for a window that opens
   * mid-history and wrong for one that opens before the portfolio did: there the
   * dropped day is the portfolio's own first, and its value entered net worth
   * from nowhere — no gain, no flow, just an account beginning to be covered.
   * Measured on the live ledger it is exactly $20.19, Robinhood Brokerage on
   * 2024-07-10, and it is the entire residual on an all-time bridge.
   *
   * Zero on every window that starts on or after the portfolio's first day,
   * which is every window a reader is likely to ask for.
   */
  openedInWindowCents: number;
}

export function marketChangeBetween(
  db: AppDatabase,
  from: string,
  to: string,
  accountIds?: readonly string[],
): WindowMarketChange {
  const all = portfolioReturnDays(db, accountIds);
  const days = all.filter((d) => compareDates(d.day, from) >= 0 && compareDates(d.day, to) <= 0);
  const window = aggregateReturn(dailyReturns(days));
  // `days[0]` is the slice's baseline. It is an OPENING only when the portfolio
  // had no value before it — i.e. when the slice begins after `from` because
  // there was nothing earlier to begin at.
  const first = days[0];
  const openedInWindowCents =
    first !== undefined && compareDates(first.day, from) > 0 ? first.navCents : 0;
  return { ...window, openedInWindowCents };
}

/**
 * The benchmark's daily closes aligned 1:1 with `days` (latest close on/before
 * each day — carry-forward across weekends; null before its history begins).
 * One series feeds BOTH the "you vs the market" % overlay (benchmarkReturns)
 * and the "what if I'd just bought SPY" flow replay (replayFlows).
 */
export function portfolioBenchmarkDays(
  db: AppDatabase,
  days: readonly string[],
  symbol = "SPY",
): BenchmarkDay[] {
  // The price cache is keyed by (symbol, asset_type) — resolve the asset type the
  // SAME way the write path does (setBenchmarkAction/refreshPrices route backfill
  // + quotes through benchmarkAssetType), so a custom ticker that collides with a
  // held symbol under a different asset type (e.g. custom "ETH" as an etf vs the
  // user's crypto ETH) never reads the wrong asset's closes.
  const assetType = benchmarkAssetType(symbol);
  return days.map((day) => ({ day, close: benchmarkCloseOn(db, symbol, assetType, day) }));
}

/** The latest cached close on/before `day` for a benchmark (symbol, asset_type). */
function benchmarkCloseOn(
  db: AppDatabase,
  symbol: string,
  assetType: AssetType,
  day: string,
): number | null {
  const row = db
    .select({ close: priceCache.close })
    .from(priceCache)
    .where(
      and(
        eq(priceCache.symbol, symbol),
        eq(priceCache.assetType, assetType),
        sql`${priceCache.quotedOn} <= ${day}`,
      ),
    )
    .orderBy(desc(priceCache.quotedOn))
    .limit(1)
    .get();
  return row?.close ?? null;
}

/**
 * Is a benchmark symbol priced at all? (gate the overlay when the data is absent).
 * Keyed by (symbol, asset_type) via benchmarkAssetType — so it agrees with the
 * backfill gate in setBenchmarkAction: a custom "ETH" (etf) reads false even when
 * the user holds ETH as crypto, so its etf history is actually fetched.
 */
export function hasBenchmark(db: AppDatabase, symbol = "SPY"): boolean {
  const row = db
    .select({ close: priceCache.close })
    .from(priceCache)
    .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, benchmarkAssetType(symbol))))
    .limit(1)
    .get();
  return row !== undefined;
}

export interface PortfolioOverview {
  valueCents: number;
  /**
   * The series' newest covered day. ⛔ Carried to today whatever the newest
   * close, so never the day a day change is measured into or named by — see
   * `portfolioDayChange`.
   */
  asOf: string | null;
  /** whole-portfolio time-weighted return since its anchor (first covered day) */
  twrPct: number | null;
  twrGainCents: number;
  twrAnchor: string | null;
  /** money-weighted (XIRR) return — the growth rate of YOUR dollars; null when
   *  undefined (too few flows / no sign change). Sits ALONGSIDE twr, never replaces it */
  xirrPct: number | null;
  /** false when a flow feeding XIRR is inexact (crypto) — carries the ≈ */
  xirrExact: boolean;
  /** cost-basis P/L across priced holdings (display; avg cost) — the UNREALIZED leg */
  costBasisPlCents: number | null;
  costBasisPlPct: number | null;
  /** realized P/L locked in by sells (avg-cost walk at daily closes); null when no sells */
  realizedPlCents: number | null;
  realizedPlExact: boolean;
  realizedSellCount: number;
  hasCrypto: boolean;
}

/**
 * The portfolio header bundle: value + whole-portfolio TWR. The day change is
 * `portfolioDayChange`, measured into the newest close rather than into `asOf`.
 */
export function portfolioOverview(db: AppDatabase): PortfolioOverview {
  const infos = investmentAccounts(db);
  const days = buildPortfolio(db).days;
  const last = days.at(-1) ?? null;

  // Whole-portfolio TWR, anchored at the first covered day.
  const twr = totalReturn(days);
  // Money-weighted (XIRR) return — the complement to TWR (flow-timing sensitive).
  const mwr = moneyWeightedReturn(days);

  const cost = costBasisPl(db);
  const realized = portfolioRealizedPl(db);

  return {
    valueCents: last?.navCents ?? 0,
    asOf: last?.day ?? null,
    twrPct: days.length >= 2 ? twr.twrPct : null,
    twrGainCents: twr.gainCents,
    twrAnchor: days[0]?.day ?? null,
    xirrPct: mwr.pct,
    xirrExact: mwr.exact,
    costBasisPlCents: cost?.plCents ?? null,
    costBasisPlPct: cost?.plPct ?? null,
    realizedPlCents: realized.sellCount > 0 ? realized.realizedCents : null,
    realizedPlExact: realized.exact,
    realizedSellCount: realized.sellCount,
    hasCrypto: infos.some((a) => a.isCrypto),
  };
}

export interface PortfolioDayChange {
  /**
   * Flow-adjusted move INTO `on` from the covered day before it, and NULL when
   * there is nothing to measure — no holding with two closes, a newest close
   * with no covered day before it, or one the series does not reach.
   *
   * Nullable rather than 0 because 0 is a measurement: it says the portfolio
   * moved nowhere. Reachable, not theoretical — /investments guards its empty
   * state on `investmentAccounts.length`, never on the number of covered days,
   * so the first render after adding a brokerage account showed `$0.00` and a
   * flat tone over a portfolio no day had ever been measured for. The sibling
   * stats on that same header (`costBasisPlCents`, `realizedPlCents`) and every
   * per-holding row (`HoldingRow.dayChangeCents`) were already nullable for
   * exactly this reason.
   */
  cents: number | null;
  pct: number | null;
  /** false when a flow into `on` is not separable to the cent — carries the ≈ */
  exact: boolean;
  /** the newest close a held position moved into (`newestCloses`) — never a day the series carried past it */
  on: string | null;
  /** the covered day before `on` */
  vsDay: string | null;
  /** each moved holding's two closes, for `closesDayChange` to name the move by */
  closes: ClosePair[];
}

/**
 * The portfolio's day change: the flow-adjusted move INTO its newest close.
 *
 * 🔴 It was the move into the SERIES' newest day, and `rebuildInvestmentHistory`
 * carries the series to today whatever the newest close. Measured on the real
 * ledger, Tue 2026-09-15: every held close is Mon Sep 14, so Tuesday and Monday
 * were valued at the same closes and the /investments header read "Today $0.00
 * +0.00%" — the dashboard teaser "$0.00 (+0.00%) today" — while the ten rows
 * beneath it had moved +$1,904.99 between their last two closes. Measured into
 * Monday, the figure IS that sum: nine stocks from Friday's close and the coin
 * from Sunday's, both already inside Sunday's carried value.
 *
 * `legs` are the rows the page prints (`holdingRows`). Their closes decide where
 * the move ends, and the closes it is made of come back for a caller to name it
 * by (`closesDayChange`), so the figure and its name come from one read. A leg
 * sold to nothing is not in the NAV, so its closes are not either.
 *
 * ⛔ No figure over OTHER days: when the series does not reach the newest close
 * — prices stored and history not yet rebuilt — this reports nothing rather
 * than a move those closes cannot name.
 */
export function portfolioDayChange(
  db: AppDatabase,
  legs: readonly (ClosePair & { quantityE8: number })[],
  /**
   * Scope the series to these accounts — one account's move, or one
   * institution's (`accountDayChange`). ⛔ `legs` must then be exactly those
   * accounts' holdings: the legs decide the day the move ends, and another
   * account's newer close would end it on a day this scope did not move.
   */
  accountIds?: readonly string[],
): PortfolioDayChange {
  const { on, closes } = newestCloses(legs.filter((l) => l.quantityE8 > 0));
  const days = buildPortfolio(db, accountIds).days;
  const at = on === null ? -1 : days.findIndex((d) => d.day === on);
  if (at < 1) return { cents: null, pct: null, exact: true, on: null, vsDay: null, closes: [] };
  const day = days[at]!;
  const prev = days[at - 1]!;
  const cents = day.navCents - prev.navCents - day.flowCents;
  return {
    cents,
    pct: prev.navCents > 0 ? (cents / prev.navCents) * 100 : null,
    exact: day.exact,
    on,
    vsDay: prev.day,
    closes: closes.map((c) => ({ quotedOn: c.quotedOn, previousQuotedOn: c.previousQuotedOn })),
  };
}

/** The per-leg key of a realized walk — matches a holdingRows row exactly. */
export function realizedLegKey(accountId: string, assetType: string, symbol: string): string {
  return `${accountId}|${assetType}|${symbol}`;
}

export interface PortfolioRealizedPl extends RealizedPnl {
  /** each (account, assetType, symbol) leg's own walk, keyed by realizedLegKey */
  byLeg: Map<string, RealizedPnl>;
}

/**
 * Realized P/L across the whole portfolio: an average-cost walk per
 * (account, symbol) over every holding event, valued at daily closes (the same
 * valuation the NAV/flow engine uses). Estimated — execution prices are not
 * recorded — and flagged inexact when any trade had no close at all. The
 * summed shape is unchanged for existing callers; `byLeg` carries each leg's
 * own figure for the holdings table.
 */
interface LegTrades {
  symbol: string;
  assetType: AssetType;
  trades: ValuedTrade[];
}

/**
 * Every (account, assetType, symbol) leg's close-valued trades, ready for the
 * avg-cost walk. (createdAt, id) is the deterministic same-day tiebreak — the
 * walk is intra-day order-sensitive (a same-day buy+sell realizes differently
 * depending on which runs first), and every realized surface must provably
 * walk the SAME sequence so the header, table, calendar, and holding page
 * reconcile. One ascending close series per symbol (not one query per event);
 * each trade is valued at the latest close on/before its day, close × 100
 * UNROUNDED so the walk's product-rounding matches valueCentsOf to the cent.
 */
export function realizedTradesByLeg(
  db: AppDatabase,
  /**
   * One holding's legs only, for its own page. ⛔ A SCOPE, never a second walk:
   * the holding page kept its own copy of this function, and the split fix
   * below never reached it — COKE's page read "Realized +$112.54" for the same
   * sale the holdings table read as +$102.32 (measured 2026-09-15).
   */
  holding?: { assetType: AssetType; symbol: string },
): Map<string, LegTrades> {
  /*
   * ⛔ Split-adjusted, and splits DROPPED rather than zeroed. A split is not a
   * trade: fed to the cost walk as stored it was a purchase of 9.013095 COKE
   * shares at the day's close, $1,017.85 of basis for money that never moved.
   * Adjusting alone would leave a zero-quantity trade in the walk — a row that
   * means nothing and that every future reader would have to reason about.
   */
  const own = ownPortfolioAccountIds(db);
  const events = adjustedHoldingEvents(db)
    .filter((e) => own.has(e.accountId))
    .filter((e) => e.eventKind !== "split")
    .filter((e) => holding === undefined || (e.assetType === holding.assetType && e.symbol === holding.symbol))
    .map((e) => ({
      accountId: e.accountId,
      symbol: e.symbol,
      assetType: e.assetType,
      day: e.occurredOn,
      deltaE8: e.quantityDeltaE8,
    }));
  const closesFor = new Map<string, { day: string; close: number }[]>();
  const seriesOf = (assetType: AssetType, symbol: string): { day: string; close: number }[] => {
    const key = `${assetType}|${symbol}`;
    let series = closesFor.get(key);
    if (!series) {
      series = db
        .select({ day: priceCache.quotedOn, close: priceCache.close })
        .from(priceCache)
        .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, assetType)))
        .orderBy(asc(priceCache.quotedOn))
        .all();
      closesFor.set(key, series);
    }
    return series;
  };
  const byHolding = new Map<string, LegTrades>();
  for (const e of events) {
    const key = realizedLegKey(e.accountId, e.assetType, e.symbol);
    const leg = byHolding.get(key) ?? { symbol: e.symbol, assetType: e.assetType, trades: [] };
    const close = latestCloseOnOrBefore(seriesOf(e.assetType, e.symbol), e.day);
    leg.trades.push({ day: e.day, qtyE8: e.deltaE8, closeCents: close === null ? null : close * 100 });
    byHolding.set(key, leg);
  }
  return byHolding;
}

export function portfolioRealizedPl(db: AppDatabase): PortfolioRealizedPl {
  const byLeg = new Map<string, RealizedPnl>();
  for (const [key, leg] of realizedTradesByLeg(db)) byLeg.set(key, realizedPnl(leg.trades));
  return { ...sumRealized([...byLeg.values()]), byLeg };
}

/** One sale attributed to its symbol — the calendar/day-sheet realized rows. */
export interface RealizedDaySale {
  symbol: string;
  assetType: AssetType;
  qtyE8: number;
  gainCents: number;
  exact: boolean;
  clamped: boolean;
}

/**
 * Every realized sale across the portfolio, grouped by day.
 *
 * Exported so the year summary can total a CALENDAR YEAR from the same walk the
 * holdings table, the calendar and the day sheet already read. A second
 * average-cost walk would be a second answer to "what did this sale realize?",
 * and the walk is intra-day order-sensitive — two implementations would diverge
 * on any day holding both a buy and a sell.
 */
export function realizedSalesByDay(db: AppDatabase): Map<string, RealizedDaySale[]> {
  const byDay = new Map<string, RealizedDaySale[]>();
  for (const leg of realizedTradesByLeg(db).values()) {
    for (const s of realizedSales(leg.trades)) {
      const list = byDay.get(s.day) ?? [];
      list.push({
        symbol: leg.symbol,
        assetType: leg.assetType,
        qtyE8: s.qtyE8,
        gainCents: s.gainCents,
        exact: s.exact,
        clamped: s.clamped,
      });
      byDay.set(s.day, list);
    }
  }
  return byDay;
}

/** Binary search: the latest close (dollars) quoted on/before `day`, or null. */
function latestCloseOnOrBefore(
  series: readonly { day: string; close: number }[],
  day: string,
): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.day <= day) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? series[found]!.close : null;
}

/** Cost-basis (avg-cost) P/L across all priced active holdings — display only. */
function costBasisPl(db: AppDatabase): { plCents: number; plPct: number } | null {
  const rows = holdingRows(db);
  const priced = rows.filter((r) => r.valueCents !== null && r.costCents !== null);
  if (priced.length === 0) return null;
  const value = priced.reduce((s, r) => s + r.valueCents!, 0);
  const cost = priced.reduce((s, r) => s + r.costCents!, 0);
  const plCents = value - cost;
  return { plCents, plPct: cost > 0 ? (plCents / cost) * 100 : 0 };
}

export interface HoldingRow {
  accountId: string;
  accountName: string;
  symbol: string;
  assetType: AssetType;
  quantityE8: number;
  latestClose: number | null;
  quotedOn: string | null;
  /**
   * The close `dayChangeCents` is measured FROM; null with fewer than two. The
   * move's two days are this row's own, never the portfolio series' — which is
   * carried past the newest close — so they travel with the figure
   * (`closesDayChange` dates a set of rows by them).
   */
  previousQuotedOn: string | null;
  valueCents: number | null;
  costCents: number | null;
  avgCostCents: number | null;
  dayChangeCents: number | null;
  dayChangePct: number | null;
  plCents: number | null;
  plPct: number | null;
  /** realized P/L locked in by this leg's sells (avg-cost at daily closes); null when no sells */
  realizedCents: number | null;
  realizedSellCount: number;
  realizedExact: boolean;
  allocationPct: number | null;
  /**
   * Per-day market values (qty × close) over the trailing 1M window — the points
   * the holding page's own 1M chart draws: [today − 30, today], a carried tail
   * through today. Empty when the window holds fewer than two points, never the
   * months before it.
   */
  sparkline: number[];
}

/**
 * 🔴 The column is headed "30d" and it drew the last 30 CLOSES. Stocks are
 * quoted on trading days only, so 30 closes span about six weeks while crypto's
 * span 30 days: measured 2026-09-14, 9 of 10 holdings on /investments drew 43–44
 * days under that header, and the line's green/red tone was a verdict about
 * them. The window is now a calendar range, through the same rule as the chart.
 */
const SPARK_RANGE: ChartRange = "1M";

/** Active holdings across HIS whole portfolio (`investmentAccounts`), with day change, P/L, allocation, sparkline. */
export function holdingRows(db: AppDatabase, today: string = todayIso()): HoldingRow[] {
  const sparkFrom = rangeStartDay(SPARK_RANGE, today) as string;
  const realizedByLeg = portfolioRealizedPl(db).byLeg;
  const own = ownPortfolioAccountIds(db);
  const rows = db
    .select({
      accountId: holdings.accountId,
      accountName: accounts.name,
      symbol: holdings.symbol,
      assetType: holdings.assetType,
      quantityE8: holdings.quantityE8,
      avgCostCents: holdings.avgCostCents,
    })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(eq(holdings.isActive, true))
    .orderBy(asc(accounts.name), asc(holdings.symbol))
    .all()
    .filter((r) => own.has(r.accountId));

  const priced = rows.map((r) => {
    const ofSymbol = and(eq(priceCache.symbol, r.symbol), eq(priceCache.assetType, r.assetType));
    // ⛔ price, value, day change and P/L read the NEWEST two closes, whatever the
    // sparkline's window — a holding with no close in 30 days still has a price
    const [latest = null, previous = null] = db
      .select({ quotedOn: priceCache.quotedOn, close: priceCache.close })
      .from(priceCache)
      .where(ofSymbol)
      .orderBy(desc(priceCache.quotedOn))
      .limit(2)
      .all();
    const valueCents = latest ? valueCentsOf(r.quantityE8, latest.close) : null;
    const prevValueCents = previous ? valueCentsOf(r.quantityE8, previous.close) : null;
    const dayChangeCents =
      valueCents !== null && prevValueCents !== null ? valueCents - prevValueCents : null;
    const dayChangePct =
      dayChangeCents !== null && prevValueCents !== null && prevValueCents !== 0
        ? (dayChangeCents / prevValueCents) * 100
        : null;
    const costCents =
      r.avgCostCents != null ? Math.round((r.avgCostCents * r.quantityE8) / 1e8) : null;
    const plCents = valueCents !== null && costCents !== null ? valueCents - costCents : null;
    const plPct =
      plCents !== null && costCents !== null && costCents !== 0 ? (plCents / costCents) * 100 : null;
    const realized = realizedByLeg.get(realizedLegKey(r.accountId, r.assetType, r.symbol));
    /*
     * The window's closes plus the one just before it, so carrying forward and
     * the <2-point fallback see what they would over the whole series without
     * loading it (this runs ~6 times per /investments render). ⛔ A fallback is
     * drawn as NOTHING: it would be the full series under a "30d" header.
     */
    const baseline = db
      .select({ day: priceCache.quotedOn, close: priceCache.close })
      .from(priceCache)
      .where(and(ofSymbol, lt(priceCache.quotedOn, sparkFrom)))
      .orderBy(desc(priceCache.quotedOn))
      .limit(1)
      .all();
    const inWindow = db
      .select({ day: priceCache.quotedOn, close: priceCache.close })
      .from(priceCache)
      .where(and(ofSymbol, gte(priceCache.quotedOn, sparkFrom), lte(priceCache.quotedOn, today)))
      .orderBy(asc(priceCache.quotedOn))
      .all();
    const drawn = windowedPoints(carryForwardTo([...baseline, ...inWindow], today), today, SPARK_RANGE);
    const sparkline = drawn.fellBack ? [] : drawn.points.map((p) => valueCentsOf(r.quantityE8, p.close));
    return {
      accountId: r.accountId,
      accountName: r.accountName,
      symbol: r.symbol,
      assetType: r.assetType,
      quantityE8: r.quantityE8,
      latestClose: latest?.close ?? null,
      quotedOn: latest?.quotedOn ?? null,
      previousQuotedOn: previous?.quotedOn ?? null,
      valueCents,
      costCents,
      avgCostCents: r.avgCostCents,
      dayChangeCents,
      dayChangePct,
      plCents,
      plPct,
      realizedCents: realized && realized.sellCount > 0 ? realized.realizedCents : null,
      realizedSellCount: realized?.sellCount ?? 0,
      realizedExact: realized?.exact ?? true,
      sparkline,
    };
  });

  const totalValue = priced.reduce((s, r) => s + (r.valueCents ?? 0), 0);
  return priced.map((r) => ({
    ...r,
    allocationPct: r.valueCents !== null && totalValue > 0 ? (r.valueCents / totalValue) * 100 : null,
  }));
}

export interface Mover {
  symbol: string;
  assetType: AssetType;
  dayChangeCents: number;
  dayChangePct: number;
  valueCents: number;
  /**
   * The two closes the move was measured between. Every leg of a symbol reads
   * the same price series, so one pair is true of the aggregated mover.
   */
  quotedOn: string;
  previousQuotedOn: string;
}

/**
 * Top winners and losers by day-change %, for the movers strip. `rows` lets a
 * caller that already read the holdings hand them over, so its movers and its
 * other figures come from ONE read rather than two.
 */
export function topMovers(
  db: AppDatabase,
  limit = 4,
  rows: readonly HoldingRow[] = holdingRows(db),
): { winners: Mover[]; losers: Mover[] } {
  // aggregate legs by (assetType, symbol) so a symbol held in two accounts is one
  // mover — matching the aggregated holding page (holding-detail)
  const byKey = new Map<
    string,
    { symbol: string; assetType: AssetType; quotedOn: string; previousQuotedOn: string; dayChangeCents: number; valueCents: number }
  >();
  for (const r of rows) {
    if (r.dayChangePct === null || r.dayChangeCents === null || r.valueCents === null) continue;
    // implied by a day change (it needs both closes); stated so the dates are typed
    if (r.quotedOn === null || r.previousQuotedOn === null) continue;
    const key = `${r.assetType}|${r.symbol}`;
    const cur = byKey.get(key) ?? {
      symbol: r.symbol,
      assetType: r.assetType,
      quotedOn: r.quotedOn,
      previousQuotedOn: r.previousQuotedOn,
      dayChangeCents: 0,
      valueCents: 0,
    };
    byKey.set(key, { ...cur, dayChangeCents: cur.dayChangeCents + r.dayChangeCents, valueCents: cur.valueCents + r.valueCents });
  }
  const movable: Mover[] = [...byKey.values()].map((m) => ({
    symbol: m.symbol,
    assetType: m.assetType,
    quotedOn: m.quotedOn,
    previousQuotedOn: m.previousQuotedOn,
    dayChangeCents: m.dayChangeCents,
    valueCents: m.valueCents,
    // prevValue = value − dayChange; pct is quantity-consistent across legs
    dayChangePct: m.valueCents - m.dayChangeCents !== 0 ? (m.dayChangeCents / (m.valueCents - m.dayChangeCents)) * 100 : 0,
  }));
  const winners = movable
    .filter((m) => m.dayChangePct > 0)
    .sort((a, b) => b.dayChangePct - a.dayChangePct)
    .slice(0, limit);
  const losers = movable
    .filter((m) => m.dayChangePct < 0)
    .sort((a, b) => a.dayChangePct - b.dayChangePct)
    .slice(0, limit);
  return { winners, losers };
}

// ── P/L calendar (ux-overhaul-plan §6.3) ─────────────────────────────────────

export interface PnlDayCell {
  pnlCents: number;
  pct: number | null;
  exact: boolean;
  /** the equity book's close was carried this day (weekend/holiday) */
  marketsClosed: boolean;
  /** P/L locked in by that day's sells (avg-cost at daily closes); 0 = no sells */
  realizedCents: number;
  realizedSellCount: number;
}

export interface PnlCalendarMonth {
  monthKey: string;
  today: string;
  cellsByDay: Record<string, PnlDayCell>;
  monthPnlCents: number;
  /** largest absolute daily move in the month — the saturation scale */
  scaleCents: number;
  upDays: number;
  downDays: number;
  /** P/L locked in by the month's sells — a separate fact from monthPnlCents
   *  (sells crystallize gains earned over many prior days), never an additive split */
  realizedMonthCents: number;
  realizedSellCount: number;
  realizedExact: boolean;
}

/** One month of whole-portfolio flow-adjusted daily P/L for the calendar. */
export function pnlCalendarMonth(
  db: AppDatabase,
  month: string = monthKey(todayIso()),
  today: string = todayIso(),
): PnlCalendarMonth {
  const { start, end } = periodBounds(`${month}-01`, "monthly");
  const built = buildPortfolio(db);
  const returns = dailyReturns(built.days);
  // map day → equityCarried from meta (aligned to built.days; returns skip index 0)
  const carriedByDay = new Map(built.days.map((d, i) => [d.day, built.meta[i]!.equityCarried]));
  const salesByDay = realizedSalesByDay(db);

  const cellsByDay: Record<string, PnlDayCell> = {};
  let monthPnlCents = 0;
  let scaleCents = 0;
  let upDays = 0;
  let downDays = 0;
  let realizedMonthCents = 0;
  let realizedSellCount = 0;
  let realizedExact = true;
  for (const r of returns) {
    if (compareDates(r.day, start) < 0 || compareDates(r.day, end) > 0) continue;
    if (compareDates(r.day, today) > 0) continue; // never show future days
    const sales = salesByDay.get(r.day) ?? [];
    const realizedCents = sales.reduce((s, x) => s + x.gainCents, 0);
    cellsByDay[r.day] = {
      pnlCents: r.returnCents,
      pct: r.prevNavCents > 0 ? (r.returnCents / r.prevNavCents) * 100 : null,
      exact: r.exact,
      marketsClosed: carriedByDay.get(r.day) ?? false,
      realizedCents,
      realizedSellCount: sales.length,
    };
    monthPnlCents += r.returnCents;
    scaleCents = Math.max(scaleCents, Math.abs(r.returnCents));
    if (r.returnCents > 0) upDays += 1;
    else if (r.returnCents < 0) downDays += 1;
    realizedMonthCents += realizedCents;
    realizedSellCount += sales.length;
    if (sales.some((s) => !s.exact)) realizedExact = false;
  }

  return {
    monthKey: month,
    today,
    cellsByDay,
    monthPnlCents,
    scaleCents,
    upDays,
    downDays,
    realizedMonthCents,
    realizedSellCount,
    realizedExact,
  };
}

export interface PnlHoldingDelta {
  symbol: string;
  assetType: AssetType;
  deltaCents: number;
}

export interface PnlDayDetail {
  day: string;
  pnlCents: number;
  exact: boolean;
  holdings: PnlHoldingDelta[];
  /** P/L locked in by that day's sells (avg-cost at daily closes) */
  realizedCents: number;
  realizedSales: RealizedDaySale[];
  /** that day's investment transactions, newest-value first */
  transactions: { id: string; accountId: string; description: string; amountCents: number }[];
}

/** Per-holding deltas + that day's investment txns for the P/L Day Sheet. */
export function pnlDayDetail(db: AppDatabase, day: string): PnlDayDetail {
  const built = buildPortfolio(db);
  const idx = built.days.findIndex((d) => d.day === day);
  const cur = idx >= 0 ? built.days[idx]! : null;
  const prev = idx >= 1 ? built.days[idx - 1]! : null;
  const pnlCents = cur && prev ? cur.navCents - prev.navCents - cur.flowCents : 0;
  const exact = cur?.exact ?? true;

  // per-holding value delta vs the prior day (qty held that day × close move)
  const prevDay = prev?.day ?? null;
  const perHolding = prevDay ? holdingDeltasBetween(db, prevDay, day) : [];

  // that day's realized sells, biggest locked-in gain/loss first
  const daySales = (realizedSalesByDay(db).get(day) ?? [])
    .slice()
    .sort((a, b) => Math.abs(b.gainCents) - Math.abs(a.gainCents));
  const realizedCents = daySales.reduce((s, x) => s + x.gainCents, 0);

  // the settlement-cash sibling holds the trades/dividends/deposits since P0.1,
  // so scope by investment SIDE (securities + settlement-cash accounts) — not by
  // category kind, which would pull in unrelated brokers' Buys from cash banks
  const sideAccounts = [...investmentSideAccountIds(db)];
  const txns =
    sideAccounts.length > 0
      ? db
          .select({
            id: transactions.id,
            accountId: transactions.accountId,
            description: transactions.rawDescription,
            amountCents: transactions.amountCents,
          })
          .from(transactions)
          .where(
            and(
              inArray(transactions.accountId, sideAccounts),
              eq(transactions.status, "active"),
              eq(transactions.postedOn, day),
            ),
          )
          .orderBy(desc(sql`abs(${transactions.amountCents})`))
          .all()
      : [];

  return {
    day,
    pnlCents,
    exact,
    holdings: perHolding,
    realizedCents,
    realizedSales: daySales,
    transactions: txns,
  };
}

/**
 * Each held symbol's market move between two days, valued at the quantity held
 * ENTERING the day (Σ Δqty on/before prevDay, end-of-day flow convention) — NOT
 * today's snapshot. Because flow(day)=Σ Δqty×close, Σ qtyEntering×(close−prevClose)
 * telescopes to exactly the day's flow-adjusted pnlCents, so the breakdown
 * reconciles to the header. Positions active that day but since sold still appear.
 */
function holdingDeltasBetween(db: AppDatabase, prevDay: string, day: string): PnlHoldingDelta[] {
  // split-adjusted: the quantity entering a day is in today's shares, matching
  // the adjusted closes it is about to be valued against on BOTH sides of the
  // difference — see services/holding-timeline.ts
  const own = ownPortfolioAccountIds(db);
  const events = adjustedHoldingEvents(db).filter((e) => own.has(e.accountId)).map((e) => ({
    symbol: e.symbol,
    assetType: e.assetType,
    deltaE8: e.quantityDeltaE8,
    occurredOn: e.occurredOn,
  }));
  const qtyByKey = new Map<string, { symbol: string; assetType: AssetType; qtyE8: number }>();
  for (const e of events) {
    if (compareDates(e.occurredOn, prevDay) > 0) continue; // qty entering `day`
    const key = `${e.assetType}|${e.symbol}`;
    const cur = qtyByKey.get(key) ?? { symbol: e.symbol, assetType: e.assetType, qtyE8: 0 };
    qtyByKey.set(key, { ...cur, qtyE8: cur.qtyE8 + e.deltaE8 });
  }
  const deltas: PnlHoldingDelta[] = [];
  for (const { symbol, assetType, qtyE8 } of qtyByKey.values()) {
    if (qtyE8 === 0) continue;
    const cur = closeOn(db, symbol, assetType, day);
    const before = closeOn(db, symbol, assetType, prevDay);
    if (cur === null || before === null) continue;
    const deltaCents = valueCentsOf(qtyE8, cur) - valueCentsOf(qtyE8, before);
    if (deltaCents !== 0) deltas.push({ symbol, assetType, deltaCents });
  }
  return deltas.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));
}

/** The latest close at or before `day` for a (symbol, assetType). */
function closeOn(db: AppDatabase, symbol: string, assetType: AssetType, day: string): number | null {
  const row = db
    .select({ close: priceCache.close })
    .from(priceCache)
    .where(
      and(
        eq(priceCache.symbol, symbol),
        eq(priceCache.assetType, assetType),
        sql`${priceCache.quotedOn} <= ${day}`,
      ),
    )
    .orderBy(desc(priceCache.quotedOn))
    .limit(1)
    .get();
  return row?.close ?? null;
}

/** The earliest cached close day for a (symbol, assetType), or null if never priced. */
function earliestCloseDay(db: AppDatabase, symbol: string, assetType: AssetType): string | null {
  const row = db
    .select({ quotedOn: priceCache.quotedOn })
    .from(priceCache)
    .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, assetType)))
    .orderBy(asc(priceCache.quotedOn))
    .limit(1)
    .get();
  return row?.quotedOn ?? null;
}

export interface AllocationSlice {
  symbol: string;
  assetType: AssetType;
  valueCents: number;
  allocationPct: number;
}

/** Priced holdings as donut slices (largest first), aggregated by (assetType, symbol). */
export function allocationSlices(db: AppDatabase): { slices: AllocationSlice[]; totalCents: number } {
  const rows = holdingRows(db).filter(
    (r): r is HoldingRow & { valueCents: number } => r.valueCents !== null,
  );
  const byKey = new Map<string, { symbol: string; assetType: AssetType; valueCents: number }>();
  for (const r of rows) {
    const key = `${r.assetType}|${r.symbol}`;
    const cur = byKey.get(key) ?? { symbol: r.symbol, assetType: r.assetType, valueCents: 0 };
    byKey.set(key, { ...cur, valueCents: cur.valueCents + r.valueCents });
  }
  const totalCents = [...byKey.values()].reduce((s, r) => s + r.valueCents, 0);
  const slices = [...byKey.values()]
    .map((r) => ({
      symbol: r.symbol,
      assetType: r.assetType,
      valueCents: r.valueCents,
      allocationPct: totalCents > 0 ? (r.valueCents / totalCents) * 100 : 0,
    }))
    .sort((a, b) => b.valueCents - a.valueCents);
  return { slices, totalCents };
}
