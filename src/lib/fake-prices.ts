import { toEpochDay } from "./dates";
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
