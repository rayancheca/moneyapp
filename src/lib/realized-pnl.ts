/**
 * Realized P/L via an average-cost walk over one holding's trades, valued at
 * daily closes (the same valuation the NAV/flow engine uses — see
 * services/portfolio.ts). Pure — no db, no React.
 *
 * Robinhood splits P/L into REALIZED (locked in by sells) and UNREALIZED (open
 * positions vs their cost). Unrealized already exists as cost-basis P/L; this
 * module derives realized: each sell's proceeds minus the average-cost basis of
 * the sold units, with the basis maintained from the buys before it.
 *
 * HONESTY: trades are valued at their day's CLOSE, not the (unrecorded)
 * execution price, so the figure is an estimate — consistent with the NAV — and
 * is labeled `exact:false` the moment any trade lacked a close entirely.
 */

export interface ValuedTrade {
  /** "YYYY-MM-DD" (ascending order expected) */
  day: string;
  /** signed quantity change × 1e8 — buys positive, sells negative */
  qtyE8: number;
  /** the day's close in cents per whole unit, or null when unpriced. MAY carry
   *  fractional cents (close × 100 unrounded) — the walk rounds the qty × close
   *  PRODUCT once, exactly like the NAV's valueCentsOf, so the two conventions
   *  agree to the cent and a sub-$0.005 asset never fabricates a $0 "exact" walk */
  closeCents: number | null;
}

export interface RealizedPnl {
  /** realized gain/loss across all sells, in cents */
  realizedCents: number;
  /** sell proceeds at their day's close, in cents */
  proceedsCents: number;
  /** the average-cost basis attributed to the sold units, in cents */
  basisCents: number;
  sellCount: number;
  /** false when any trade had no close (skipped) — the figure is then partial */
  exact: boolean;
}

/** One realized sale from the average-cost walk — the drill-down row. */
export interface RealizedSale {
  day: string;
  /** quantity actually realized × 1e8 (positive; clamped to what was held) */
  qtyE8: number;
  /** proceeds at the sell day's close, in cents */
  proceedsCents: number;
  /** the average-cost basis attributed to the sold units, in cents */
  basisCents: number;
  /** proceeds − basis, in cents */
  gainCents: number;
  /** false when an earlier unpriced trade made the running basis partial */
  exact: boolean;
  /** true when the sell exceeded the held quantity (import gap) and was clamped */
  clamped: boolean;
}

const centsOf = (qtyE8: number, closeCents: number): number =>
  Math.round((qtyE8 * closeCents) / 1e8);

/**
 * The average-cost walk over ONE holding's chronological trades. Buys grow the
 * basis at their close; each sell realizes proceeds − avg basis of the sold
 * units. A sell of more than is held (import gap) is clamped to the held
 * quantity; zero-quantity and unpriced trades are skipped (unpriced ⇒ inexact
 * from that point on — the running basis is partial).
 */
function walkTrades(trades: readonly ValuedTrade[]): { sales: RealizedSale[]; exact: boolean } {
  let heldE8 = 0;
  let basisCents = 0;
  let exact = true;
  const sales: RealizedSale[] = [];

  for (const t of trades) {
    if (t.qtyE8 === 0) continue;
    if (t.closeCents === null) {
      exact = false;
      continue;
    }
    if (t.qtyE8 > 0) {
      basisCents += centsOf(t.qtyE8, t.closeCents);
      heldE8 += t.qtyE8;
      continue;
    }
    // sell: realize against the average cost of what is actually held
    const sellE8 = Math.min(-t.qtyE8, heldE8);
    if (sellE8 <= 0) {
      // selling from an empty book proves buy history is MISSING (an import
      // gap) — nothing to realize, and the figures are partial, never "exact"
      exact = false;
      continue;
    }
    const basisOut = Math.round((basisCents * sellE8) / heldE8);
    const proceeds = centsOf(sellE8, t.closeCents);
    sales.push({
      day: t.day,
      qtyE8: sellE8,
      proceedsCents: proceeds,
      basisCents: basisOut,
      gainCents: proceeds - basisOut,
      exact,
      clamped: sellE8 < -t.qtyE8,
    });
    basisCents -= basisOut;
    heldE8 -= sellE8;
  }

  return { sales, exact };
}

/** Aggregate realized P/L for one holding's trades (see {@link walkTrades}). */
export function realizedPnl(trades: readonly ValuedTrade[]): RealizedPnl {
  const { sales, exact } = walkTrades(trades);
  let realizedCents = 0;
  let proceedsCents = 0;
  let soldBasisCents = 0;
  for (const s of sales) {
    realizedCents += s.gainCents;
    proceedsCents += s.proceedsCents;
    soldBasisCents += s.basisCents;
  }
  return { realizedCents, proceedsCents, basisCents: soldBasisCents, sellCount: sales.length, exact };
}

/** Every realized sale, in trade order — the per-sale drill-down rows. */
export function realizedSales(trades: readonly ValuedTrade[]): RealizedSale[] {
  return walkTrades(trades).sales;
}

/** Sum several holdings' realized P/L into one portfolio figure. */
export function sumRealized(parts: readonly RealizedPnl[]): RealizedPnl {
  return parts.reduce<RealizedPnl>(
    (acc, p) => ({
      realizedCents: acc.realizedCents + p.realizedCents,
      proceedsCents: acc.proceedsCents + p.proceedsCents,
      basisCents: acc.basisCents + p.basisCents,
      sellCount: acc.sellCount + p.sellCount,
      exact: acc.exact && p.exact,
    }),
    { realizedCents: 0, proceedsCents: 0, basisCents: 0, sellCount: 0, exact: true },
  );
}
