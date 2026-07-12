import { and, asc, desc, eq, like } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, ASSET_TYPES, type AssetType } from "@/db/schema/holdings";
import { transactions } from "@/db/schema/transactions";
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
  totalPlCents: number | null;
  totalPlPct: number | null;
  diversityPct: number | null;
  legs: HoldingAccountLeg[];
  // chart
  priceSeries: { day: string; closeCents: number }[];
  avgCostLineCents: number | null;
  marks: HoldingEventMark[];
  /** most recent trades (capped); `eventsTotal` is the full count */
  events: HoldingEventRow[];
  eventsTotal: number;
  /** deep link to every trade for this holding in the ledger (equity only) */
  allTradesHref: string | null;
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

export function holdingDetail(db: AppDatabase, assetTypeInput: string, symbol: string): HoldingDetail {
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

  const events = db
    .select()
    .from(holdingEvents)
    .where(and(eq(holdingEvents.symbol, symbol), eq(holdingEvents.assetType, assetType)))
    .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.createdAt))
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
  const prevValueCents = previous ? valueCentsOf(quantityE8, previous.close) : null;
  const todayReturnCents =
    valueCents !== null && prevValueCents !== null ? valueCents - prevValueCents : null;
  const todayReturnPct =
    todayReturnCents !== null && prevValueCents !== null && prevValueCents !== 0
      ? (todayReturnCents / prevValueCents) * 100
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

  const priceDayChangeCents =
    latest && previous ? Math.round((latest.close - previous.close) * 100) : null;
  const priceDayChangePct =
    latest && previous && previous.close !== 0
      ? ((latest.close - previous.close) / previous.close) * 100
      : null;

  const marks: HoldingEventMark[] = events.map((e) => ({
    day: e.occurredOn,
    kind: e.quantityDeltaE8 >= 0 ? "buy" : "sell",
    quantityE8: e.quantityDeltaE8,
    closeCents: closeByDay.has(e.occurredOn) ? Math.round(closeByDay.get(e.occurredOn)! * 100) : null,
  }));

  const accountIds = [...new Set(holdingLegs.map((l) => l.accountId))];
  const singleAccount = accountIds.length === 1 ? accountIds[0]! : undefined;
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
        ? ledgerHref({ account: singleAccount, q: symbol, from: e.occurredOn, to: e.occurredOn })
        : null,
    }));

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
    totalPlCents,
    totalPlPct,
    diversityPct,
    legs: holdingLegs
      .filter((l) => l.isActive)
      .map((l) => ({
        accountId: l.accountId,
        accountName: l.accountName,
        quantityE8: l.quantityE8,
        avgCostCents: l.avgCostCents,
        valueCents: latest ? valueCentsOf(l.quantityE8, latest.close) : null,
      })),
    priceSeries: closes.map((c) => ({ day: c.quotedOn, closeCents: Math.round(c.close * 100) })),
    avgCostLineCents: avgCostCents,
    marks,
    events: eventRows,
    eventsTotal: events.length,
    allTradesHref: linkEvents ? ledgerHref({ account: singleAccount, q: symbol }) : null,
  };
}
