import { and, asc, count, desc, eq, like, or, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, ASSET_TYPES, type AssetType } from "@/db/schema/holdings";
import { transactions } from "@/db/schema/transactions";
import { compareDates, todayIso } from "@/lib/dates";
import { dayChangeLabel } from "@/lib/day-change-label";
import { formatDayShort } from "@/lib/format-date";
import { holdingReturnDays } from "@/lib/holding-returns";
import { sharePercent } from "@/lib/insight-facts";
import { moneyWeightedReturn, type PortfolioDay } from "@/lib/portfolio-returns";
import { carryForwardTo } from "@/lib/price-series";
import {
  realizedPnl,
  realizedSales,
  sumRealized,
  type RealizedPnl,
  type RealizedSale,
  type ValuedTrade,
} from "@/lib/realized-pnl";
import { ledgerHref } from "./analytics";
import { holdingRows } from "./portfolio";
import { valueCentsOf } from "./holdings";

/**
 * One holding aggregated across accounts by (assetType, symbol) — the detail
 * route `/investments/[assetType]/[symbol]` (ux-overhaul-plan §6.4). The route
 * keys on BOTH assetType and symbol because bare "ETH" is a coin and a NYSE
 * ticker (schema.md). Throws on an unknown holding so the page can 404. Trade
 * marks and the events history come from the rebuilt holding_events timeline
 * (§6.0) — never synthetic — and each event links back to its source ledger rows.
 */

export class UnknownHoldingError extends Error {
  constructor(assetType: string, symbol: string) {
    super(`No holding ${symbol} (${assetType})`);
    this.name = "UnknownHoldingError";
  }
}

export interface HoldingAccountLeg {
  accountId: string;
  accountName: string;
  quantityE8: number;
  avgCostCents: number | null;
  valueCents: number | null;
}

export interface HoldingEventMark {
  day: string;
  kind: "buy" | "sell";
  quantityE8: number;
  /** that day's close in cents-per-share, for placing a chart mark */
  closeCents: number | null;
}

export interface HoldingEventRow {
  day: string;
  kind: "buy" | "sell";
  quantityE8: number;
  costCents: number | null;
  /** deep link to the source transactions for this symbol on this day */
  ledgerHref: string | null;
}

export interface HoldingDetail {
  assetType: AssetType;
  symbol: string;
  name: string | null;
  isCrypto: boolean;
  // header
  latestClose: number | null;
  quotedOn: string | null;
  priceDayChangeCents: number | null;
  priceDayChangePct: number | null;
  // position (aggregated across accounts)
  quantityE8: number;
  valueCents: number | null;
  avgCostCents: number | null;
  costCents: number | null;
  todayReturnCents: number | null;
  todayReturnPct: number | null;
  /**
   * What to CALL `todayReturnCents` — "Today" only when the newest close is
   * today's, otherwise the two dates it was measured between.
   *
   * 🔴 The card said "Today" unconditionally. Measured on the real ledger at
   * today = 2026-09-01: **23 of 33 holding pages** labelled a move that did not
   * happen today, the worst by 516 days (VEU, priced 2025-04-03). `ADBE` read
   * "Today −$37.44" for 2026-05-11. This figure does not depend on the calendar
   * at all — it is the move between the last two rows in `price_cache` — so the
   * word was never anything but an assumption.
   *
   * Resolved here rather than in the component, the way `dashboard.ts` resolves
   * the same phrase for the investments teaser: the naming rule needs `today`,
   * which this service already has and the card's props do not.
   */
  todayReturnLabel: string;
  /** the dated interval, or null when the figure really is today's */
  todayReturnInterval: string | null;
  totalPlCents: number | null;
  totalPlPct: number | null;
  diversityPct: number | null;
  /**
   * The same share as a DISPLAY, floored at "<0.1%" so a real sliver is never
   * printed as a measured zero. `lib/insight-facts` owns that rule.
   *
   * 🔴 The card formatted `diversityPct.toFixed(1)` itself, and on 2026-09-11
   * `/investments/stock/WMT` read "Portfolio diversity 0.0%" three lines under
   * the "Market value $43.70" it had just printed — $43.70 of $109,204.16 is
   * 0.040%. Six sibling surfaces were converted to `sharePercent` the day
   * before; this was the seventh caller re-deriving it.
   */
  diversityDisplay: string | null;
  legs: HoldingAccountLeg[];
  // chart — carried forward to `today`: real closes are `complete`, the flat
  // tail after the last quoted day is `complete: false` (drawn dashed)
  priceSeries: { day: string; closeCents: number; complete: boolean }[];
  avgCostLineCents: number | null;
  marks: HoldingEventMark[];
  /** flow-adjusted daily series for THIS holding (aggregated across accounts) —
   *  feeds the Return view exactly like portfolioReturnDays feeds the hero */
  returnDays: PortfolioDay[];
  /** money-weighted (XIRR) return for this holding; null when undefined */
  xirrPct: number | null;
  /** false when a flow feeding XIRR is inexact (crypto) — carries the ≈ */
  xirrExact: boolean;
  /** realized P/L locked in by sells — avg-cost walk PER ACCOUNT at daily closes */
  realized: RealizedPnl;
  /** every realized sale across accounts, ascending by day (the drill-down rows) */
  realizedSales: RealizedSale[];
  /** most recent trades (capped); `eventsTotal` is the full count */
  events: HoldingEventRow[];
  eventsTotal: number;
  /** deep link to every LEDGER ROW carrying this symbol (equity only) */
  allTradesHref: string | null;
  /**
   * How many rows that link actually opens — counted with the SAME predicate
   * `/transactions?q=` uses, so the sentence over the link can name the
   * destination rather than a different population.
   *
   * ⛔ NOT `eventsTotal`. AAPL has 244 holding events and 253 matching ledger
   * rows: 241 buys + 2 sells + 10 dividends, and one event the ledger has no
   * row for at all. "View all 244 trades" over a list of 253 rows is the
   * drill-down contract broken in the other direction.
   */
  ledgerRowCount: number;
}

/** A heavily DCA'd holding has hundreds of trades — show the recent ones. */
const EVENTS_SHOWN = 40;

function isAssetType(value: string): value is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(value);
}

/** Security display name from the latest trade description ("Apple CUSIP: … (AAPL)"). */
function displayName(db: AppDatabase, symbol: string): string | null {
  const row = db
    .select({ raw: transactions.rawDescription })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), like(transactions.rawDescription, `%(${symbol})%`)))
    .orderBy(desc(transactions.postedOn))
    .limit(1)
    .get();
  if (!row) return null;
  const marker = row.raw.indexOf(" CUSIP:");
  const name = marker > 0 ? row.raw.slice(0, marker).trim() : null;
  return name && name !== symbol ? name : null;
}

export function holdingDetail(
  db: AppDatabase,
  assetTypeInput: string,
  symbol: string,
  today: string = todayIso(),
): HoldingDetail {
  if (!isAssetType(assetTypeInput)) throw new UnknownHoldingError(assetTypeInput, symbol);
  const assetType = assetTypeInput;

  const holdingLegs = db
    .select({
      accountId: holdings.accountId,
      accountName: accounts.name,
      accountSubtype: accounts.subtype,
      quantityE8: holdings.quantityE8,
      avgCostCents: holdings.avgCostCents,
      isActive: holdings.isActive,
    })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(and(eq(holdings.symbol, symbol), eq(holdings.assetType, assetType)))
    .all();

  // (createdAt, id) tiebreak matches portfolioRealizedPl exactly — the avg-cost
  // walk is same-day order-sensitive, and this page must reconcile with the header
  const events = db
    .select()
    .from(holdingEvents)
    .where(and(eq(holdingEvents.symbol, symbol), eq(holdingEvents.assetType, assetType)))
    .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.createdAt), asc(holdingEvents.id))
    .all();

  if (holdingLegs.length === 0 && events.length === 0) {
    throw new UnknownHoldingError(assetType, symbol);
  }

  const closes = db
    .select({ quotedOn: priceCache.quotedOn, close: priceCache.close })
    .from(priceCache)
    .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, assetType)))
    .orderBy(asc(priceCache.quotedOn))
    .all();
  const closeByDay = new Map(closes.map((c) => [c.quotedOn, c.close]));
  const latest = closes.at(-1) ?? null;
  const previous = closes.length >= 2 ? closes[closes.length - 2]! : null;

  const active = holdingLegs.filter((l) => l.isActive);
  const quantityE8 = active.reduce((s, l) => s + l.quantityE8, 0);
  const valueCents = latest ? valueCentsOf(quantityE8, latest.close) : null;
  // today's return credits only the shares held ENTERING the latest quoted day —
  // a buy that day is a flow, not a gain (the return engine's convention), so
  // this stat agrees with the Return view's flow-adjusted last day
  const qtyTradedOnOrAfterLatestE8 = latest
    ? events
        .filter((e) => compareDates(e.occurredOn, latest.quotedOn) >= 0)
        .reduce((s, e) => s + e.quantityDeltaE8, 0)
    : 0;
  const qtyEnteringE8 = Math.max(quantityE8 - qtyTradedOnOrAfterLatestE8, 0);
  const prevEnteringValueCents = previous ? valueCentsOf(qtyEnteringE8, previous.close) : null;
  const todayReturnCents =
    latest && prevEnteringValueCents !== null
      ? valueCentsOf(qtyEnteringE8, latest.close) - prevEnteringValueCents
      : null;
  const todayReturnPct =
    todayReturnCents !== null && prevEnteringValueCents !== null && prevEnteringValueCents !== 0
      ? (todayReturnCents / prevEnteringValueCents) * 100
      : null;

  // weighted average cost across the legs that carry one
  const costLegs = active.filter((l) => l.avgCostCents != null);
  const costQty = costLegs.reduce((s, l) => s + l.quantityE8, 0);
  const costCents =
    costLegs.length > 0
      ? costLegs.reduce((s, l) => s + Math.round((l.avgCostCents! * l.quantityE8) / 1e8), 0)
      : null;
  const avgCostCents =
    costCents !== null && costQty > 0 ? Math.round((costCents * 1e8) / costQty) : null;
  // P/L compares the value of ONLY the cost-bearing shares against their basis —
  // never the whole position's value minus a partial cost (which would fabricate
  // an inflated gain when some legs of a multi-account holding lack an avg cost).
  const costValueCents = latest !== null && costQty > 0 ? valueCentsOf(costQty, latest.close) : null;
  const totalPlCents =
    costValueCents !== null && costCents !== null ? costValueCents - costCents : null;
  const totalPlPct =
    totalPlCents !== null && costCents !== null && costCents !== 0
      ? (totalPlCents / costCents) * 100
      : null;

  // diversity: this holding's share of the whole portfolio's priced value
  const portfolioValue = holdingRows(db).reduce((s, r) => s + (r.valueCents ?? 0), 0);
  const diversityPct =
    valueCents !== null && portfolioValue > 0 ? (valueCents / portfolioValue) * 100 : null;
  const diversityDisplay = diversityPct === null ? null : sharePercent(diversityPct);

  const priceDayChangeCents =
    latest && previous ? Math.round((latest.close - previous.close) * 100) : null;
  const priceDayChangePct =
    latest && previous && previous.close !== 0
      ? ((latest.close - previous.close) / previous.close) * 100
      : null;

  // realized P/L: an avg-cost walk PER ACCOUNT (each account keeps its own basis
  // book, matching portfolioRealizedPl), every trade valued at the latest close
  // on/before its day — so this card reconciles with the portfolio header.
  const carriedCloseCents = (day: string): number | null => {
    let lo = 0;
    let hi = closes.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (closes[mid]!.quotedOn <= day) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // × 100 UNROUNDED — the walk rounds the qty × close product once (valueCentsOf)
    return found >= 0 ? closes[found]!.close * 100 : null;
  };
  const tradesByAccount = new Map<string, ValuedTrade[]>();
  for (const e of events) {
    const list = tradesByAccount.get(e.accountId) ?? [];
    list.push({ day: e.occurredOn, qtyE8: e.quantityDeltaE8, closeCents: carriedCloseCents(e.occurredOn) });
    tradesByAccount.set(e.accountId, list);
  }
  const accountWalks = [...tradesByAccount.values()];
  const realized = sumRealized(accountWalks.map((trades) => realizedPnl(trades)));
  const allSales = accountWalks
    .flatMap((trades) => realizedSales(trades))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const marks: HoldingEventMark[] = events.map((e) => ({
    day: e.occurredOn,
    kind: e.quantityDeltaE8 >= 0 ? "buy" : "sell",
    quantityE8: e.quantityDeltaE8,
    closeCents: closeByDay.has(e.occurredOn) ? Math.round(closeByDay.get(e.occurredOn)! * 100) : null,
  }));

  /*
   * 🔴 THE ACCOUNT SCOPE CAME FROM THE WRONG LEG, AND IT EXCLUDED EVERY ROW.
   * `holdingLegs` are the POSITIONS, which all sit in Robinhood Brokerage — an
   * account holding zero transactions of any status. The trades post to
   * Robinhood Cash. So `?account=<brokerage>&q=AAPL` asked for rows in an
   * account that has none, and all 351 ledger links across the nine equity
   * holding pages opened "No matching transactions" under a page that had just
   * said there were 244 trades. Measured 2026-09-11:
   *
   *     ?account=<brokerage>&q=AAPL     0 rows
   *     ?q=AAPL                       253 rows
   *     ?account=<cash>&q=AAPL        253 rows
   *
   * ⛔ The symbol is the scope. A position's account says where the SHARES are
   * held, never where the money moved, and there is no mapping from one to the
   * other in the schema — the cash leg is a different account by design.
   */
  const accountIds = [...new Set(holdingLegs.map((l) => l.accountId))];
  void accountIds;

  // the destination's own count, through the predicate `/transactions?q=` uses
  const symbolLike = `%${symbol.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const ledgerRowCount = db
    .select({ n: count() })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        or(
          sql`${transactions.rawDescription} LIKE ${symbolLike} ESCAPE '\\'`,
          sql`${transactions.normalizedDescription} LIKE ${symbolLike} ESCAPE '\\'`,
        ),
      ),
    )
    .get()?.n ?? 0;
  // crypto trades live only in monthly statements (no ledger transactions), so
  // their events do not link out — equity trades deep-link to their CUSIP rows
  const linkEvents = assetType !== "crypto";
  const eventRows: HoldingEventRow[] = events
    .slice()
    .reverse()
    .slice(0, EVENTS_SHOWN)
    .map((e) => ({
      day: e.occurredOn,
      kind: e.quantityDeltaE8 >= 0 ? "buy" : "sell",
      quantityE8: e.quantityDeltaE8,
      costCents: e.costCents,
      ledgerHref: linkEvents
        ? ledgerHref({ q: symbol, from: e.occurredOn, to: e.occurredOn })
        : null,
    }));

  const dayNaming = dayChangeLabel(latest?.quotedOn ?? null, previous?.quotedOn ?? null, today, formatDayShort);

  const returnDays = holdingReturnDays(
    events.map((e) => ({ day: e.occurredOn, deltaE8: e.quantityDeltaE8 })),
    closes.map((c) => ({ day: c.quotedOn, close: c.close })),
  );
  const holdingMwr = moneyWeightedReturn(returnDays);

  return {
    assetType,
    symbol,
    name: displayName(db, symbol),
    isCrypto: assetType === "crypto",
    latestClose: latest?.close ?? null,
    quotedOn: latest?.quotedOn ?? null,
    priceDayChangeCents,
    priceDayChangePct,
    quantityE8,
    valueCents,
    avgCostCents,
    costCents,
    todayReturnCents,
    todayReturnPct,
    todayReturnLabel: dayNaming.label,
    todayReturnInterval: dayNaming.interval,
    totalPlCents,
    totalPlPct,
    diversityPct,
    diversityDisplay,
    legs: holdingLegs
      .filter((l) => l.isActive)
      .map((l) => ({
        accountId: l.accountId,
        accountName: l.accountName,
        quantityE8: l.quantityE8,
        avgCostCents: l.avgCostCents,
        valueCents: latest ? valueCentsOf(l.quantityE8, latest.close) : null,
      })),
    // carry the last quoted close forward to today so the chart reaches the
    // present instead of freezing at the last fetch; the tail is marked
    // estimated (dashed). Header stats above stay on the real latest close.
    priceSeries: carryForwardTo(
      closes.map((c) => ({ day: c.quotedOn, closeCents: Math.round(c.close * 100) })),
      today,
    ),
    avgCostLineCents: avgCostCents,
    marks,
    returnDays,
    xirrPct: holdingMwr.pct,
    xirrExact: holdingMwr.exact,
    realized,
    realizedSales: allSales,
    events: eventRows,
    eventsTotal: events.length,
    allTradesHref: linkEvents ? ledgerHref({ q: symbol }) : null,
    ledgerRowCount,
  };
}
