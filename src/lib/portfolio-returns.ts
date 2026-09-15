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

import { windowPoints } from "./chart-window";
import type { ChartRange } from "./chart-range";

import { xirr, type CashFlow } from "./xirr";

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

/** One day of a benchmark's close (null when it had no price on/before that day). */
export interface BenchmarkDay {
  day: string;
  close: number | null;
}

/**
 * A buy-and-hold benchmark's cumulative % return, rebased to its first available
 * close and aligned 1:1 with the given days — the "you vs the market" overlay for
 * the return line. Each point is (close(t) / firstClose − 1) × 100; points before
 * the benchmark has any close (or with a non-positive close) are null so the line
 * simply starts where the data does.
 */
export function benchmarkReturns(days: readonly BenchmarkDay[]): (number | null)[] {
  let base: number | null = null;
  return days.map((d) => {
    if (d.close === null || d.close <= 0) return null;
    if (base === null) {
      base = d.close;
      return 0;
    }
    return (d.close / base - 1) * 100;
  });
}

/** A single standout day on the return line. */
export interface ReturnDayStat {
  day: string;
  /** flow-adjusted market P/L that day, in cents */
  returnCents: number;
  /** that day's return as a percentage of the prior NAV, or null on an empty base */
  pct: number | null;
}

/** Headline stats for the return view: the best/worst day and the worst drawdown. */
export interface ReturnStats {
  /** the biggest/smallest flow-adjusted move in DOLLARS */
  bestDay: ReturnDayStat | null;
  worstDay: ReturnDayStat | null;
  /**
   * The same two extremes ranked by PERCENTAGE of the prior NAV — a different
   * day whenever the position's size changed over the window.
   *
   * 🔴 The strip printed one day's DATE and the other framing's FIGURE. The
   * extremes were ranked by dollars only, and `ReturnStatsList` then rendered
   * `pct` whenever the unit selector said "%" — so "Best day" named the biggest
   * dollar day while showing its percentage, which is not the best percentage
   * day at all. Measured on the real ledger, 2026-09-11:
   *
   *     /investments?view=returns&unit=percent
   *       printed  +5.27% · Wed, Aug 19, 2026   ($5,151.50 on a $97,817.62 base)
   *       real     +9.99% · Wed, Apr  9, 2025   ($356.99 on a $3,574.82 base)
   *       printed  −3.96% · Fri, Jun  5, 2026
   *       real     −5.67% · Fri, Apr  4, 2025
   *
   *     /investments/crypto/ETH?view=returns&unit=percent — his largest position
   *       printed  −10.50%   real worst −14.95% (2026-02-05)
   *
   *   …wrong on 11 of 32 holding pages. A big position's calm day outranks a
   *   small position's violent one in dollars, and only in dollars.
   *
   * Null when no day has a positive prior NAV to be a percentage of.
   */
  bestDayPct: ReturnDayStat | null;
  worstDayPct: ReturnDayStat | null;
  /**
   * The deepest peak-to-trough decline of the cumulative TWR index over the
   * series, as a NEGATIVE percentage (0 when the line only ever rose). This is
   * "max drawdown" — how far the portfolio fell from a high-water mark.
   */
  maxDrawdownPct: number;
}

/**
 * Best day, worst day, and max drawdown across a NAV series — the "cool stats"
 * under the return line. Days are flow-adjusted (a deposit day is a 0 return, not
 * a record high), so the best/worst days reflect real market moves. Max drawdown
 * tracks a running peak of the cumulative TWR index and the deepest dip below it.
 */
export function returnStats(days: readonly PortfolioDay[]): ReturnStats {
  const rs = dailyReturns(days);
  if (rs.length === 0)
    return { bestDay: null, worstDay: null, bestDayPct: null, worstDayPct: null, maxDrawdownPct: 0 };
  const pctOf = (r: DailyReturn): number | null =>
    r.prevNavCents > 0 ? (r.returnCents / r.prevNavCents) * 100 : null;
  let best = rs[0]!;
  let worst = rs[0]!;
  // ranked by percentage instead — a different day the moment the base changes.
  // A day with no prior NAV has no percentage and cannot win either race.
  let bestPct: DailyReturn | null = null;
  let worstPct: DailyReturn | null = null;
  let index = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of rs) {
    if (r.returnCents > best.returnCents) best = r;
    if (r.returnCents < worst.returnCents) worst = r;
    const pct = pctOf(r);
    if (pct !== null) {
      if (bestPct === null || pct > pctOf(bestPct)!) bestPct = r;
      if (worstPct === null || pct < pctOf(worstPct)!) worstPct = r;
    }
    index *= r.factor;
    if (index > peak) peak = index;
    // peak starts at 1 and only ever grows, so it is always ≥ 1 (> 0 safe)
    const drawdown = index / peak - 1;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }
  const stat = (r: DailyReturn): ReturnDayStat => ({
    day: r.day,
    returnCents: r.returnCents,
    pct: pctOf(r),
  });
  return {
    bestDay: stat(best),
    worstDay: stat(worst),
    bestDayPct: bestPct === null ? null : stat(bestPct),
    worstDayPct: worstPct === null ? null : stat(worstPct),
    maxDrawdownPct: maxDrawdown * 100,
  };
}

/**
 * The same stats over the days a RANGE actually draws.
 *
 * 🔴 The return view measured them over the WHOLE series while its header three
 * lines above named a range, so the strip reported a best day, a worst day and
 * a max drawdown from outside the window it sat in. Measured 2026-09-10
 * against the app's own payload — 35 of the 66 (page × non-ALL range)
 * combinations were wrong, max drawdown in 27 of them:
 *
 *     /investments?view=returns&range=1M   worst Jun 5, 2026 −$3,394.03 and
 *       mdd −23.91%, under a header reading "(+10.18%) · return · 1M".
 *       In window: Sep 2, 2026 −$845.53 and −2.02%. Jun 5 is 67 days before
 *       the window opens.
 *     ETH 1M   shown −$2,571.39 / −59.93%; in window −$888.40 / −4.71%
 *     UNH 1M   shown Jan 27, 2026; in window Aug 27, 2026
 *
 * ⛔ `windowPoints` is the app's own slice — "the visible rows alone — the
 * chart's slice, for callers that don't caption", which is exactly this. One
 * rule now decides what is drawn and what is measured over it. Slicing the NAV
 * series makes the window's first day its baseline, which is the convention
 * `aggregateReturn` already uses for the window figure printed beside these.
 */
export function returnStatsInWindow(
  days: readonly PortfolioDay[],
  today: string,
  range: ChartRange,
): ReturnStats {
  return returnStats(windowPoints(days, today, range));
}

/**
 * The honest "where did this value come from" split behind the decomposition
 * bar. `netContributed + gains == value` exactly. Gross vs net matters once
 * sells exist: sale proceeds leave `netContributed` (they were valued at the
 * same closes as the NAV), so a heavily-trimmed winner can hold NEGATIVE net
 * contributed capital — the position is running entirely on market gains. The
 * gross figure is what was actually put in; `withdrawnCents` is what sells
 * took back out. A UI must never label the net figure "contributed".
 */
export interface ValueDecomposition {
  /**
   * The series' first day — the basis every figure below is counted from. It
   * travels WITH the figures so no surface can print them under a window they
   * were not measured over: the bar sat unlabelled beneath a "1M" header while
   * reading the whole series' +$23,561.70 (real ledger, 2026-09-15).
   */
  sinceDay: string;
  /** capital put in: the baseline NAV + every later positive flow, in cents */
  grossContributedCents: number;
  /** capital taken back out by sells: −Σ negative flows after the baseline (≥ 0) */
  withdrawnCents: number;
  /** net capital currently in = gross − withdrawn; negative once sells exceed buys */
  netContributedCents: number;
  /** cumulative flow-adjusted market P/L, in cents */
  gainsCents: number;
  /** the final day's NAV, in cents — always exactly netContributed + gains */
  valueCents: number;
}

/** Decompose a NAV series' final value into contributed capital vs market P/L. */
export function decomposeValue(days: readonly PortfolioDay[]): ValueDecomposition | null {
  if (days.length === 0) return null;
  let inflowCents = 0;
  let outflowCents = 0;
  for (let i = 1; i < days.length; i += 1) {
    const flow = days[i]!.flowCents;
    if (flow > 0) inflowCents += flow;
    else outflowCents -= flow;
  }
  const grossContributedCents = days[0]!.navCents + inflowCents;
  const withdrawnCents = outflowCents;
  return {
    sinceDay: days[0]!.day,
    grossContributedCents,
    withdrawnCents,
    netContributedCents: grossContributedCents - withdrawnCents,
    gainsCents: totalReturn(days).gainCents,
    valueCents: days[days.length - 1]!.navCents,
  };
}

/** One point on the cumulative-return line (the Robinhood-style "returns" graph). */
export interface CumulativeReturnPoint {
  day: string;
  /** cumulative flow-adjusted $ P/L since the series baseline, in cents (0 at the baseline) */
  cumGainCents: number;
  /** cumulative time-weighted return since the baseline, as a percentage (0 at the baseline) */
  cumTwrPct: number;
  /** the day's NAV (positions value), in cents — for tooltips / the value overlay */
  navCents: number;
  /** cumulative net capital that flowed in since the baseline, in cents */
  cumNetFlowCents: number;
  /** true only when every day up to AND including this one had a cent-verified flow */
  exact: boolean;
}

/**
 * The cumulative-return SERIES for a Robinhood-style performance line: one point
 * per input day, aligned 1:1 with the value series. The first day is the
 * baseline (0 gain, 0%); each later day chains the same flow-adjusted daily
 * factor as {@link aggregateReturn}, so deposits never step the line up and the
 * final point reconciles exactly to {@link totalReturn} (cumGainCents ==
 * gainCents, cumTwrPct == twrPct). `exact` latches false from the first
 * approximate day onward, so the tail can be drawn as "estimated".
 */
export function cumulativeReturns(days: readonly PortfolioDay[]): CumulativeReturnPoint[] {
  if (days.length === 0) return [];
  const out: CumulativeReturnPoint[] = [
    { day: days[0]!.day, cumGainCents: 0, cumTwrPct: 0, navCents: days[0]!.navCents, cumNetFlowCents: 0, exact: true },
  ];
  let product = 1;
  let gainCents = 0;
  let netFlowCents = 0;
  let exact = true;
  for (const r of dailyReturns(days)) {
    product *= r.factor;
    gainCents += r.returnCents;
    netFlowCents += r.flowCents;
    if (!r.exact) exact = false;
    out.push({
      day: r.day,
      cumGainCents: gainCents,
      cumTwrPct: (product - 1) * 100,
      navCents: r.navCents,
      cumNetFlowCents: netFlowCents,
      exact,
    });
  }
  return out;
}

// ── Money-weighted (XIRR) return ─────────────────────────────────────

export interface MoneyWeightedReturn {
  /** annualized money-weighted (XIRR) return, as a percentage; null when undefined */
  pct: number | null;
  /** false when any flow day (or the terminal value) is inexact — carries the ≈ */
  exact: boolean;
}

/**
 * The investor cash flows implied by a NAV+flow series: each day's flow INTO
 * positions is money the investor put IN (negative), and the final day's NAV is
 * the "if liquidated today" value (positive). Zero-flow days carry no cash, so
 * only genuine contributions/withdrawals plus the terminal value feed XIRR.
 */
export function cashFlowsFromDays(days: readonly PortfolioDay[]): CashFlow[] {
  const flows: CashFlow[] = [];
  for (const d of days) {
    if (d.flowCents !== 0) flows.push({ day: d.day, amountCents: -d.flowCents });
  }
  const last = days.at(-1);
  if (last) flows.push({ day: last.day, amountCents: last.navCents });
  return flows;
}

/**
 * Money-weighted (XIRR) return for a NAV+flow series — the growth rate of the
 * investor's OWN dollars, weighting each dollar by how long it was in the market.
 * It sits ALONGSIDE the time-weighted return (which strips flow timing out); the
 * two answer different questions and should both be shown, never conflated.
 */
export function moneyWeightedReturn(days: readonly PortfolioDay[]): MoneyWeightedReturn {
  const rate = xirr(cashFlowsFromDays(days));
  const exact = days.every((d) => d.flowCents === 0 || d.exact) && (days.at(-1)?.exact ?? true);
  return { pct: rate === null ? null : rate * 100, exact };
}
