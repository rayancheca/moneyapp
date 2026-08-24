import { compareDates } from "./dates";

/**
 * 🕊️ The in-flight money adjustment (docs/inflight-dips.md, user-approved):
 * money moving between the user's OWN accounts is still the user's money, but
 * the two ledgers rarely restate it on the same day. Between the day one
 * account's curve drops and the day the other's rises, the visible total
 * counts the money either zero times (a false dip) or twice (a false spike).
 * These pure helpers apply evidenced corrections so the total counts every
 * dollar exactly once — display-only math; stored balances are never touched.
 *
 * Sign convention: `deltaCents > 0` = the money is visible in NEITHER account
 * (add it back — "in transit"); `deltaCents < 0` = visible in BOTH (remove the
 * double-count — the receiving side credited before the sender debited).
 *
 * Windows are half-open `[startDay, endDay)`: on `endDay` the ledgers agree
 * again. `endDay: null` = the correction never resolves inside the known
 * series (arrival evidenced by the pair but never restated by the receiving
 * account's coverage) and runs to the end of the axis.
 */

export interface InFlightAdjustment {
  /** first day (inclusive) the visible total misstates the money */
  startDay: string;
  /** first day (exclusive) the ledgers agree again; null = never inside the series */
  endDay: string | null;
  /** signed correction; positive lifts a false dip, negative removes a double-count */
  deltaCents: number;
}

/**
 * Sum of corrections per axis day. Range comparison, not day identity — the
 * net-worth axis can skip days, and a window boundary between two axis days
 * must still adjust the later one. Days that net to zero are omitted.
 */
export function inFlightDeltaByDay(
  days: readonly string[],
  adjustments: readonly InFlightAdjustment[],
): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const day of days) {
    const delta = inFlightDeltaOn(day, adjustments);
    if (delta !== 0) deltas.set(day, delta);
  }
  return deltas;
}

/**
 * The signed correction in force on ONE day — the half-open window test, in the
 * one place it is allowed to live.
 *
 * It was written twice: here, inside the per-day loop, and again inside
 * `latestBridgedNetWorthCents`, which needs the same answer for the final axis
 * day without building the whole series. Two hand-copied implementations of a
 * boundary test is the shape pass 54 recorded for dates — a float ending exactly
 * ON a day is already resolved, and the two copies disagreeing about that would
 * move net worth by a whole transfer while both looked right.
 *
 * ⚠️ Half-open by design: `startDay` inclusive, `endDay` EXCLUSIVE. The money is
 * in transit from the day it leaves until the day it lands, and on the day it
 * lands both legs are posted and the ledger no longer needs bridging.
 */
export function inFlightDeltaOn(
  day: string,
  adjustments: readonly InFlightAdjustment[],
): number {
  let delta = 0;
  for (const adj of adjustments) {
    if (adj.deltaCents === 0) continue;
    if (compareDates(day, adj.startDay) < 0) continue;
    if (adj.endDay !== null && compareDates(day, adj.endDay) >= 0) continue;
    delta += adj.deltaCents;
  }
  return delta;
}

/**
 * Apply the corrections to a series: `totalCents` becomes the bridged value and
 * `inTransitCents` carries the signed correction so the chart can mark bridged
 * days ("includes $X in transit") without hiding that an adjustment happened.
 * Returns new points; the input is never mutated.
 */
export function applyInFlight<T extends { day: string; totalCents: number }>(
  points: readonly T[],
  adjustments: readonly InFlightAdjustment[],
): (T & { inTransitCents: number })[] {
  const deltas = inFlightDeltaByDay(
    points.map((p) => p.day),
    adjustments,
  );
  return points.map((p) => {
    const delta = deltas.get(p.day) ?? 0;
    return { ...p, totalCents: p.totalCents + delta, inTransitCents: delta };
  });
}
