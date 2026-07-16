import type { BenchmarkDay, PortfolioDay } from "./portfolio-returns";

/**
 * "What if I'd just bought SPY?" (Robinhood-parity item 3) — replay the
 * portfolio's EXACT flow series as benchmark buys/sells at daily closes. Pure.
 *
 * The counterfactual: every dollar that actually flowed into positions (the
 * first day's neutralized opening + every later day's flow, the same series
 * the TWR engine uses) instead buys the benchmark at THAT day's close; a
 * withdrawal sells at that day's close. This is a SIMULATION — labeled
 * "simulated at daily closes" in the UI — never a prediction: it prices only
 * recorded flows at recorded closes. Flows that predate the benchmark's price
 * history wait as cash and buy at its first close (the same roll-forward
 * doctrine as the return engine — an appearance is never a fabricated gain).
 *
 * The strategy is long-only, like a real "just bought SPY" investor: a
 * withdrawal the replay cannot fund (the actual position outperformed and was
 * sold down for more than the benchmark grew) liquidates the replay to ZERO
 * and the unfundable excess is carried as an explicit `shortfallCents` — the
 * position never goes short, and the UI names the shortfall instead of
 * printing an impossible negative "you'd have".
 */

export interface ReplayPoint {
  day: string;
  /** the counterfactual benchmark position's value, or null before it's priceable */
  valueCents: number | null;
  /** valueCents − investedCents (null while unpriceable) */
  gainCents: number | null;
  /** net capital the replay actually deployed (flows + unfunded withdrawals), cents */
  investedCents: number;
  /** cumulative withdrawals the benchmark strategy could NOT have funded, cents */
  shortfallCents: number;
}

/**
 * The counterfactual value/gain series, aligned 1:1 with `days`. `closes` must
 * be aligned 1:1 as well (the service builds both from the same day list).
 */
export function replayFlows(
  days: readonly PortfolioDay[],
  closes: readonly BenchmarkDay[],
): ReplayPoint[] {
  const out: ReplayPoint[] = [];
  let units = 0;
  let cashCents = 0; // flows waiting for the benchmark's first close
  let flowsSumCents = 0; // every flow ever committed to the strategy
  let shortfallCents = 0;
  for (let i = 0; i < days.length; i += 1) {
    const flowCents = i === 0 ? days[0]!.navCents : days[i]!.flowCents;
    flowsSumCents += flowCents;
    const close = closes[i]?.close ?? null;
    if (close === null || close <= 0) {
      cashCents += flowCents;
      out.push({
        day: days[i]!.day,
        valueCents: null,
        gainCents: null,
        investedCents: flowsSumCents + shortfallCents,
        shortfallCents,
      });
      continue;
    }
    // everything the strategy holds after today's flows, at today's close
    // (× 100 unrounded — one product rounding, valueCentsOf's convention)
    const closeCents = close * 100;
    let potCents = Math.round(units * closeCents) + cashCents + flowCents;
    if (potCents < 0) {
      // the withdrawal exceeds the replay's worth: liquidate, never go short
      shortfallCents += -potCents;
      potCents = 0;
    }
    units = potCents / closeCents;
    cashCents = 0;
    const investedCents = flowsSumCents + shortfallCents;
    out.push({
      day: days[i]!.day,
      valueCents: potCents,
      gainCents: potCents - investedCents,
      investedCents,
      shortfallCents,
    });
  }
  return out;
}

export interface ReplayEnd {
  /** what the benchmark strategy would hold today, cents (never negative) */
  valueCents: number;
  /** its cumulative gain over the capital it could deploy, cents */
  gainCents: number;
  /** replay value − the ACTUAL final NAV (positive: the benchmark would have won) */
  deltaVsActualCents: number;
  /** withdrawals the strategy could not have funded (0 = a clean replay) */
  shortfallCents: number;
}

/** The "you'd have $X, Δ $Y" summary — the last priced replay point vs the real NAV. */
export function replayEnd(
  points: readonly ReplayPoint[],
  days: readonly PortfolioDay[],
): ReplayEnd | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i]!;
    if (p.valueCents !== null && p.gainCents !== null) {
      return {
        valueCents: p.valueCents,
        gainCents: p.gainCents,
        deltaVsActualCents: p.valueCents - (days[days.length - 1]?.navCents ?? 0),
        shortfallCents: p.shortfallCents,
      };
    }
  }
  return null;
}
