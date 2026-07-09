import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { priceCache } from "@/db/schema/holdings";
import { addDays, compareDates, todayIso } from "@/lib/dates";
import { valueCentsOf } from "./holdings";

/**
 * Crypto history v1 (master-plan Phase 7, closing the Phase 2b exemption):
 * the crypto account's daily_balances derive from the quantity timeline
 * (holding_events cumulative sum) × cached daily closes. Basis is 'derived'
 * on days where every held symbol has a real close, 'carried' where the
 * last known close is stepped forward. Days before any close exists are
 * skipped — levels are never invented (schema.md daily_balances).
 */
export function rebuildCryptoHistory(
  db: AppDatabase,
  accountId: string,
  today: string = todayIso(),
): void {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`rebuildCryptoHistory: unknown account ${accountId}`);
  if (account.type !== "investment" || account.subtype !== "crypto") {
    throw new Error(`rebuildCryptoHistory: ${accountId} is not a crypto investment account`);
  }

  const events = db
    .select()
    .from(holdingEvents)
    .where(eq(holdingEvents.accountId, accountId))
    .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.createdAt))
    .all();

  db.transaction((tx) => {
    tx.delete(dailyBalances).where(eq(dailyBalances.accountId, accountId)).run();
    if (events.length === 0) return;

    const firstDay = events[0]!.occurredOn;
    const symbols = [...new Set(events.map((e) => e.symbol))];

    // daily closes per symbol across the window, one query
    const closes = tx
      .select({
        symbol: priceCache.symbol,
        quotedOn: priceCache.quotedOn,
        close: priceCache.close,
      })
      .from(priceCache)
      .where(
        and(
          inArray(priceCache.symbol, symbols),
          eq(priceCache.assetType, "crypto"),
          gte(priceCache.quotedOn, firstDay),
          lte(priceCache.quotedOn, today),
        ),
      )
      .all();
    const closeBySymbolDay = new Map<string, number>();
    for (const c of closes) closeBySymbolDay.set(`${c.symbol}|${c.quotedOn}`, c.close);

    // seed carry-forward with the last close at or before the first event day
    const lastClose = new Map<string, number>();
    for (const symbol of symbols) {
      const prior = tx
        .select({ close: priceCache.close })
        .from(priceCache)
        .where(
          and(
            eq(priceCache.symbol, symbol),
            eq(priceCache.assetType, "crypto"),
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
