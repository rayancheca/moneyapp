/**
 * Flow-adjusted portfolio return math (ux-overhaul-plan §6.2). Pure — no db,
 * no React — so it is exhaustively unit-tested (100% lib coverage) against the
 * fixtures the plan names: a mid-period deposit is not a gain, a phantom
 * seed-day opening is not a gain, a carried close is a flat day, and a
 * stock+crypto weekend moves only by what actually moved.
 *
 * The engine consumes a portfolio-level daily series where each day carries the
 * positions value (NAV), the net capital that FLOWED into positions that day,
 * and whether that flow is cent-verified. The service layer builds this array
 * per account (equity flows come from the signed CUSIP trade transactions,
 * cent-exact; an account's first covered day and every crypto quantity change
 * are neutralized at market value so a position merely *appearing* under
 * coverage never reads as a gain) — never from holdingEvents.costCents, which
 * is running-average basis, not cash (schema.md).
 *
 *   returnCents(t) = NAV(t) − NAV(t−1) − flow(t)          // market P/L in $
 *   factor(t)      = (NAV(t) − flow(t)) / NAV(t−1)         // = 1 + returnCents/prevNav
 *   TWR            = Π factor − 1                          // time-weighted
 *
 * The factor measures the day's market P/L against the capital invested at the
 * START of the day (NAV(t−1)) — the standard daily time-weighted return, which
 * treats same-day buys/sells as end-of-day flows. (A start-of-day convention,
 * NAV(t)/(NAV(t−1)+flow), over-penalizes sell days and over-credits buy days —
 * it read a real −2.1% sell day as −3.0% on live data.)
 */

export interface PortfolioDay {
  /** "YYYY-MM-DD" */
  day: string;
  /** positions market value that day, in cents */
  navCents: number;
  /** net flow INTO positions (buys + appearances positive, sells negative), cents */
  flowCents: number;
  /** false when a flow that day is not cent-known (a crypto trade whose cash
   *  lives only in statements) — the day's return is then approximate, not wrong */
  exact: boolean;
}

export interface DailyReturn {
  day: string;
  navCents: number;
  prevNavCents: number;
  flowCents: number;
  /** market P/L that day = nav − prevNav − flow, in cents */
  returnCents: number;
  /** growth factor nav / (prevNav + flow); 1 when the invested base ≤ 0 */
  factor: number;
  exact: boolean;
}

export interface WindowReturn {
  /** time-weighted return over the window, as a percentage (compounded) */
  twrPct: number;
  /** flow-adjusted dollar P/L over the window, in cents */
  gainCents: number;
  /** net capital that flowed in across the window, in cents */
  netFlowCents: number;
  /** NAV at the window's opening baseline (the first day's prior NAV) */
  startNavCents: number;
  /** NAV at the window's end */
  endNavCents: number;
  /** true only when every day in the window had a cent-verified flow */
  exact: boolean;
}

/**
 * Per-day flow-adjusted returns across a NAV series. The first point is the
 * anchor baseline and yields no return (there is no prior day). Days must be
 * ascending; the service passes a dense daily series.
 */
export function dailyReturns(days: readonly PortfolioDay[]): DailyReturn[] {
  const out: DailyReturn[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const cur = days[i]!;
    const prev = days[i - 1]!;
    const returnCents = cur.navCents - prev.navCents - cur.flowCents;
    // prevNav ≤ 0 means the position was empty entering the day (it first
    // appeared today, or was fully sold) — there is no capital to earn a return
    // on, so the factor is flat and the day's flow (the opening) is not a gain
    const factor = prev.navCents > 0 ? (cur.navCents - cur.flowCents) / prev.navCents : 1;
    out.push({
      day: cur.day,
      navCents: cur.navCents,
      prevNavCents: prev.navCents,
      flowCents: cur.flowCents,
      returnCents,
      factor,
      exact: cur.exact,
    });
  }
  return out;
}

/**
 * Aggregate a (pre-sliced) run of daily returns into one window figure: TWR by
 * chaining the daily factors, dollar gain by summing the daily market P/L. An
 * empty window is a flat, exact zero.
 */
export function aggregateReturn(returns: readonly DailyReturn[]): WindowReturn {
  if (returns.length === 0) {
    return {
      twrPct: 0,
      gainCents: 0,
      netFlowCents: 0,
      startNavCents: 0,
      endNavCents: 0,
      exact: true,
    };
  }
  let product = 1;
  let gainCents = 0;
  let netFlowCents = 0;
  let exact = true;
  for (const r of returns) {
    product *= r.factor;
    gainCents += r.returnCents;
    netFlowCents += r.flowCents;
    if (!r.exact) exact = false;
  }
  return {
    twrPct: (product - 1) * 100,
    gainCents,
    netFlowCents,
    startNavCents: returns[0]!.prevNavCents,
    endNavCents: returns[returns.length - 1]!.navCents,
    exact,
  };
}

/**
 * Simple (money-weighted-ish) return: the window's dollar gain over the capital
 * invested at its start. Null when there was no opening capital to measure
 * against (a brand-new position) — the caller shows TWR alone.
 */
export function simpleReturnPct(startNavCents: number, gainCents: number): number | null {
  if (startNavCents <= 0) return null;
  return (gainCents / startNavCents) * 100;
}

/** Convenience: the whole series' return in one call. */
export function totalReturn(days: readonly PortfolioDay[]): WindowReturn {
  return aggregateReturn(dailyReturns(days));
}
