import { addDays, toEpochDay } from "./dates";
import { hashString, mulberry32 } from "./prng";

/**
 * The single deterministic price walk shared by the fixture simulator and
 * the fake price provider (MONEYAPP_FAKE_PRICES=1) — synthetic brokerage
 * statement values and the price cache must tell the same story.
 * O(1) per (symbol, day); same inputs always produce the same close.
 */

const WALK_START = toEpochDay("2024-01-01");
const WALK_SPAN_DAYS = 1000;

const LEVELS: Record<string, { start: number; end: number }> = {
  VOO: { start: 505, end: 588 },
  AAPL: { start: 204, end: 247 },
  MSFT: { start: 421, end: 508 },
  ETH: { start: 2430, end: 3860 },
};

export function fakeDailyClose(symbol: string, day: string): number {
  const level = LEVELS[symbol.toUpperCase()] ?? { start: 60, end: 130 };
  const t = Math.max(0, toEpochDay(day) - WALK_START);
  const progress = Math.min(1, t / WALK_SPAN_DAYS);
  const drift = level.start + (level.end - level.start) * progress;

  const seed = hashString(symbol.toUpperCase()) ^ Math.imul(t, 2654435761);
  const noise = (mulberry32(seed)() - 0.5) * 0.032; // ±1.6%
  const wave = Math.sin(t / 9.3) * 0.011 + Math.sin(t / 41.7) * 0.019;

  return Math.round(drift * (1 + noise + wave) * 100) / 100;
}

/** Intraday wobble, peak-to-peak, as a fraction of price. Smaller than the
 *  daily ±1.6%: a session should look busier than the daily line but must not
 *  wander further than the move it is decomposing. */
const INTRADAY_NOISE = 0.006;

/**
 * One synthetic intraday tick, as a walk BETWEEN two daily closes.
 *
 * The invariant that matters: tick `tickCount` is EXACTLY
 * `fakeDailyClose(symbol, day)` and tick 0 is EXACTLY the previous day's close.
 * The noise term is scaled by `sin(pi * t)`, which is zero at both ends, so the
 * endpoints are pinned by construction rather than by a special case. Without
 * that, the 1D view and the daily series would be two numbers for one quantity —
 * the failure this codebase has paid for more than once (see the realized-vs-
 * unrealized note in 08-backlog.md, and pass 28's income double-count).
 *
 * Deterministic and O(1) per tick, like `fakeDailyClose`, so the fixture
 * simulator, the demo loader and the fake provider all tell the same story.
 * `tickIndex`/`tickCount` are integers rather than a timestamp because the
 * caller owns the session shape: equities emit 5-minute ticks across a 390-minute
 * session, crypto runs 24h, and neither belongs in this walk.
 */
export function fakeIntradayClose(
  symbol: string,
  day: string,
  tickIndex: number,
  tickCount: number,
): number {
  // clamped with arithmetic, not branches: src/lib is held at 100% coverage and
  // a guard clause here would be an untestable-in-practice branch
  const steps = Math.max(1, Math.trunc(tickCount));
  const i = Math.min(steps, Math.max(0, Math.trunc(tickIndex)));

  const open = fakeDailyClose(symbol, addDays(day, -1));
  const close = fakeDailyClose(symbol, day);

  const t = i / steps;
  const base = open + (close - open) * t;
  const amp = Math.sin(Math.PI * t);

  const seed = hashString(`${symbol.toUpperCase()}|${day}`) ^ Math.imul(i, 2654435761);
  const noise = (mulberry32(seed)() - 0.5) * INTRADAY_NOISE * amp;

  return Math.round(base * (1 + noise) * 100) / 100;
}
