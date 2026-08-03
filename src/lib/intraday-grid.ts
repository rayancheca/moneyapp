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
 * the day it is valued at `priorClose` — the previous daily close — so a symbol
 * that has not opened yet still contributes its real weight instead of zero.
 *
 * WHAT THIS DELIBERATELY DOES **NOT** DO: it does not make the first grid point
 * equal yesterday's closing valuation. The time axis is the union of instants
 * that actually TICKED, so the earliest instant is by definition one where some
 * symbol has just printed — and that symbol is valued at its print, not at its
 * prior close. For an equities-only book the first point is therefore the
 * OPENING valuation and the overnight gap is not drawn at all. (Measured: prior
 * close $200, open $210 → first point $210.) The docstring here claimed the
 * opposite for two passes; 100% coverage proved these functions COMPUTE, not
 * that they answered the question anyone was asking.
 *
 * A book holding crypto hides this, because crypto ticks at 00:00Z and the
 * equities are then carried at `priorClose` at that first instant — so the bug
 * only appears for the portfolios least likely to be noticed.
 *
 * The previous-close anchor is added one layer up, by `sessionView` in
 * lib/intraday-axis, which owns the display question of what the day's move is
 * measured FROM and can say so in the caption when no prior close exists.
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
