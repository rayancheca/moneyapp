import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { priceCache } from "@/db/schema/holdings";
import { addDays, compareDates, todayIso } from "@/lib/dates";
import { adjustedHoldingEvents } from "./holding-timeline";
import { valueCentsOf } from "./holdings";

/**
 * Investment daily_balances from the quantity timeline (Stage 4a, generalizing
 * the Phase-7 crypto path to equities): cumulative-sum(holding_events) × cached
 * daily closes, per held symbol, keyed by each symbol's OWN asset_type
 * (stock/etf/crypto — "ETH" the coin vs a ticker never collide). Basis is
 * 'derived' on days where every held symbol has a real close, 'carried' where
 * the last known close is stepped forward. Days before any close exists are
 * skipped — levels are never invented (schema.md daily_balances). Works for any
 * investment account with holding_events (crypto OR brokerage).
 */
export function rebuildInvestmentHistory(
  db: AppDatabase,
  accountId: string,
  today: string = todayIso(),
): void {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`rebuildInvestmentHistory: unknown account ${accountId}`);
  if (account.type !== "investment") {
    throw new Error(`rebuildInvestmentHistory: ${accountId} is not an investment account`);
  }

  /*
   * ⛔ Split-adjusted before a single quantity is summed. The closes in
   * `price_cache` are split-adjusted all the way back — Yahoo returns them that
   * way, and COKE proves it: $114.36 on 2025-05-23 and $112.93 on 2025-05-27,
   * continuous across a 10-for-1. The stored quantities are as-traded, so
   * multiplying the two published a TENTH of the truth for the 60 trading days
   * before that split. Today's position is untouched; only the path to it.
   *
   * `adjustedHoldingEvents` is the one loader for this, shared with the flow,
   * the realized walk and the P&L calendar — see its docstring for why all four
   * had to move together.
   */
  const events = adjustedHoldingEvents(db, accountId);

  db.transaction((tx) => {
    tx.delete(dailyBalances).where(eq(dailyBalances.accountId, accountId)).run();
    if (events.length === 0) return;

    const firstDay = events[0]!.occurredOn;
    const symbols = [...new Set(events.map((e) => e.symbol))];
    // each symbol resolves prices under its own asset_type
    const assetOf = new Map<string, (typeof events)[number]["assetType"]>();
    for (const e of events) assetOf.set(e.symbol, e.assetType);

    // daily closes per symbol across the window, one query; filter to the
    // matching asset_type so a ticker never picks up a same-named coin's close
    const closes = tx
      .select({
        symbol: priceCache.symbol,
        assetType: priceCache.assetType,
        quotedOn: priceCache.quotedOn,
        close: priceCache.close,
      })
      .from(priceCache)
      .where(
        and(
          inArray(priceCache.symbol, symbols),
          gte(priceCache.quotedOn, firstDay),
          lte(priceCache.quotedOn, today),
        ),
      )
      .all();
    const closeBySymbolDay = new Map<string, number>();
    for (const c of closes) {
      if (c.assetType !== assetOf.get(c.symbol)) continue;
      closeBySymbolDay.set(`${c.symbol}|${c.quotedOn}`, c.close);
    }

    // seed carry-forward with the last close at or before the first event day
    const lastClose = new Map<string, number>();
    for (const symbol of symbols) {
      const prior = tx
        .select({ close: priceCache.close })
        .from(priceCache)
        .where(
          and(
            eq(priceCache.symbol, symbol),
            eq(priceCache.assetType, assetOf.get(symbol)!),
            lte(priceCache.quotedOn, firstDay),
          ),
        )
        .orderBy(asc(priceCache.quotedOn))
        .all()
        .at(-1);
      if (prior) lastClose.set(symbol, prior.close);
    }

    const quantityE8 = new Map<string, number>(symbols.map((s) => [s, 0]));
    let eventIndex = 0;

    for (let day = firstDay; compareDates(day, today) <= 0; day = addDays(day, 1)) {
      while (eventIndex < events.length && events[eventIndex]!.occurredOn === day) {
        const e = events[eventIndex]!;
        quantityE8.set(e.symbol, (quantityE8.get(e.symbol) ?? 0) + e.quantityDeltaE8);
        eventIndex += 1;
      }

      let valueCents = 0;
      let priceable = true;
      let allReal = true;
      for (const symbol of symbols) {
        const qty = quantityE8.get(symbol) ?? 0;
        const realClose = closeBySymbolDay.get(`${symbol}|${day}`);
        if (realClose !== undefined) lastClose.set(symbol, realClose);
        if (qty === 0) continue;
        const close = realClose ?? lastClose.get(symbol);
        if (close === undefined) {
          priceable = false; // no close at or before this day — nothing to carry
          break;
        }
        if (realClose === undefined) allReal = false;
        valueCents += valueCentsOf(qty, close);
      }
      if (!priceable) continue;

      tx.insert(dailyBalances)
        .values({
          accountId,
          day,
          balanceCents: valueCents,
          basis: allReal ? "derived" : "carried",
        })
        .run();
    }
  });
}
