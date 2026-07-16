import { addDays, compareDates } from "./dates";
import type { PortfolioDay } from "./portfolio-returns";

/**
 * A single holding's flow-adjusted daily series (Robinhood-parity item 1) —
 * the per-holding counterpart of the service layer's buildAccountBook. Pure: it
 * consumes the (assetType, symbol)-aggregated holding_events trades and the
 * symbol's cached closes, and emits the same PortfolioDay shape the portfolio
 * return engine consumes, so cumulativeReturns/returnStats/aggregateReturn work
 * per holding unchanged.
 *
 * Valuation-consistency is the whole trick: each day's NAV is qty × the latest
 * close on/before that day, and each day's flow is the CHANGE in that same
 * rounded valuation caused by the day's trades — flow(t) = value(qty(t), close(t))
 * − value(qty(t−1), close(t)). Buys, sells, and the position's first priceable
 * day are then exactly return-neutral (no execution price is ever guessed), and
 * a trade-only day's return telescopes to qty(t−1) × (close(t) − close(t−1))
 * with zero rounding drift. Consequently the per-holding TWR% is the stitched
 * price return over the periods actually held, while the $ line weights each
 * day's move by the quantity you actually owned — the honest DCA read.
 */

export interface HoldingTrade {
  /** "YYYY-MM-DD" the quantity change occurred (holding_events.occurredOn) */
  day: string;
  /** signed quantity delta ×1e8 (buys positive, sells negative) */
  deltaE8: number;
}

export interface HoldingClose {
  /** "YYYY-MM-DD" the close was quoted */
  day: string;
  /** close in DOLLARS (priceCache semantics) */
  close: number;
}

/** A quantity (×1e8) valued at a dollar close, in cents. */
export function valueCentsOf(quantityE8: number, close: number): number {
  return Math.round(quantityE8 * close * 1e-6);
}

/**
 * The dense daily PortfolioDay series for one holding: from its first priceable
 * held day (trades that predate the price history roll into a neutralized
 * opening) to its last close — or, when the position is fully closed, its final
 * trade day (no trailing flat-zero tail). Missing interior closes carry forward
 * (a markets-closed day is a flat day, never a gap); an over-sold quantity
 * floors the NAV at zero rather than going negative. Empty when the holding was
 * never simultaneously held and priced.
 */
export function holdingReturnDays(
  trades: readonly HoldingTrade[],
  closes: readonly HoldingClose[],
): PortfolioDay[] {
  const sortedTrades = [...trades].sort((a, b) => compareDates(a.day, b.day));
  const sortedCloses = closes
    .filter((c) => c.close > 0)
    .sort((a, b) => compareDates(a.day, b.day));
  if (sortedTrades.length === 0 || sortedCloses.length === 0) return [];

  // the series starts on the first day the position is BOTH held and priceable:
  // walk the trades accumulating quantity — either the position is already held
  // entering the price window (start = first close day), or it first turns
  // positive on some in-window trade day (start = that day). This kills the
  // fabricated flat-zero head a pre-window round trip would otherwise produce
  // (which would also rebase the benchmark before the user held anything).
  const firstCloseDay = sortedCloses[0]!.day;
  let startDay: string | null = null;
  let walkQtyE8 = 0;
  for (const t of sortedTrades) {
    if (compareDates(t.day, firstCloseDay) >= 0 && walkQtyE8 > 0) {
      startDay = firstCloseDay; // held entering the price window
      break;
    }
    walkQtyE8 += t.deltaE8;
    if (walkQtyE8 > 0 && compareDates(t.day, firstCloseDay) >= 0) {
      startDay = t.day; // the position first opens inside the window
      break;
    }
  }
  if (startDay === null && walkQtyE8 > 0) startDay = firstCloseDay; // all trades pre-window, still held
  if (startDay === null) return []; // never held while priceable

  // still open → run to the last close (or a later trade); fully closed → stop
  // at the final trade so the chart never drags a dead flat-zero tail
  const lastTradeDay = sortedTrades[sortedTrades.length - 1]!.day;
  const lastCloseDay = sortedCloses[sortedCloses.length - 1]!.day;
  const finalQtyE8 = sortedTrades.reduce((sum, t) => sum + t.deltaE8, 0);
  const endDay =
    finalQtyE8 > 0
      ? compareDates(lastTradeDay, lastCloseDay) > 0
        ? lastTradeDay
        : lastCloseDay
      : lastTradeDay;

  const deltaByDay = new Map<string, number>();
  let openingQtyE8 = 0;
  for (const t of sortedTrades) {
    if (compareDates(t.day, startDay) < 0) openingQtyE8 += t.deltaE8;
    else deltaByDay.set(t.day, (deltaByDay.get(t.day) ?? 0) + t.deltaE8);
  }

  const out: PortfolioDay[] = [];
  let qtyE8 = openingQtyE8;
  let close = 0;
  let closeIdx = 0;
  for (let day = startDay; compareDates(day, endDay) <= 0; day = addDays(day, 1)) {
    while (closeIdx < sortedCloses.length && compareDates(sortedCloses[closeIdx]!.day, day) <= 0) {
      close = sortedCloses[closeIdx]!.close;
      closeIdx += 1;
    }
    const qtyBeforeE8 = qtyE8;
    qtyE8 += deltaByDay.get(day) ?? 0;
    const navCents = qtyE8 > 0 ? valueCentsOf(qtyE8, close) : 0;
    const navAtPriorQty = qtyBeforeE8 > 0 ? valueCentsOf(qtyBeforeE8, close) : 0;
    const flowCents = out.length === 0 ? navCents : navCents - navAtPriorQty;
    out.push({ day, navCents, flowCents, exact: true });
  }
  return out;
}
