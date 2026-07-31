import { valueCentsOf } from "./holding-returns";

/**
 * Portfolio-level intraday: many symbols on ONE time grid.
 *
 * The problem this solves is that symbols do not tick together. An equity ticks
 * across a 390-minute session; crypto ticks all day; a market holiday means one
 * of them does not tick at all. Summing "the latest tick of each" would produce
 * a line whose points are valued at different instants — the same class of error
 * as adding a realized figure to an unrealized one, and just as invisible once
 * it is drawn.
 *
 * So: the grid is the union of every instant any symbol reported, and at each
 * instant every symbol is valued at its own most recent tick AT OR BEFORE that
 * instant (last-observation-carried-forward). Before a symbol's first tick of
 * the day it is valued at `priorClose` — the previous daily close — which is
 * what makes the first grid point equal yesterday's closing valuation and the
 * whole line read as "the day's move".
 *
 * Pure: no clock, no DB, no fetch. `ticks` must be sorted ascending by `at`;
 * callers read them out of a `quoted_at` index that already guarantees it.
 */

export interface SymbolTicks {
  symbol: string;
  quantityE8: number;
  /** previous daily close; null when the symbol has no history to fall back on */
  priorClose: number | null;
  ticks: readonly { at: string; close: number }[];
}

export interface IntradayPoint {
  /** ISO-8601 UTC instant */
  at: string;
  valueCents: number;
}

/**
 * A symbol with neither ticks nor a prior close contributes 0 rather than
 * dropping the whole grid point. That is deliberate and it is the one lossy
 * choice here: a portfolio containing one unpriceable holding still draws, and
 * the alternative (refusing to draw) hides the other holdings' real movement.
 * `pricedSymbols` reports how many actually carried a price so a caller can say
 * so rather than quietly implying full coverage.
 */
export interface IntradayGrid {
  points: IntradayPoint[];
  pricedSymbols: number;
  totalSymbols: number;
}

export function intradayPortfolioGrid(symbols: readonly SymbolTicks[]): IntradayGrid {
  const instants = [...new Set(symbols.flatMap((s) => s.ticks.map((t) => t.at)))].sort();

  const priced = symbols.filter((s) => s.ticks.length > 0 || s.priorClose !== null).length;

  if (instants.length === 0) {
    return { points: [], pricedSymbols: priced, totalSymbols: symbols.length };
  }

  // one cursor per symbol, advanced in lockstep with the grid: the whole sweep
  // is O(instants + total ticks), not O(instants x ticks)
  const cursors = symbols.map(() => 0);
  const current = symbols.map((s) => s.priorClose);

  const points: IntradayPoint[] = [];
  for (const at of instants) {
    let valueCents = 0;
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i]!;
      let c = cursors[i]!;
      while (c < s.ticks.length && s.ticks[c]!.at <= at) {
        current[i] = s.ticks[c]!.close;
        c++;
      }
      cursors[i] = c;
      const close = current[i];
      if (close !== null && close !== undefined) {
        valueCents += valueCentsOf(s.quantityE8, close);
      }
    }
    points.push({ at, valueCents });
  }

  return { points, pricedSymbols: priced, totalSymbols: symbols.length };
}
