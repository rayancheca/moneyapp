import { addDays, compareDates } from "./dates";

/**
 * Carry-forward for the investment price + value charts (pass 13). A holding's
 * price is only quoted on trading days and the price cache is only as fresh as
 * the last fetch, so a chart built straight from the cache STOPS at the last
 * quoted day — "the ETH price graph ends July 10". This extends an ascending
 * series flat to `today`: the last known value repeats for each later day,
 * tagged `complete: false` so the chart draws the tail dashed ("estimated — no
 * fresher price"). Fetching a live quote is a separate concern (the Refresh
 * button); carrying the last close forward is the honest default when no newer
 * price exists, exactly like the derivation engine's `carried` basis
 * (crypto-history.ts) — never an invented level, just a stated hold.
 *
 * Pure (no DB, no clock) so the carry-forward is unit-tested to 100%. The value
 * math (qty × close → cents) lives in `valueCentsOf` (holdings.ts) and the
 * price-on-day lookup in `closeOn` (portfolio.ts); this owns only the extension.
 */

export interface Carried {
  /** false ONLY on a carried tail day (drawn dashed); true on every real point */
  complete: boolean;
}

/**
 * Extend an ascending series flat to `today`. Every real point passes through
 * tagged `complete: true`; each calendar day AFTER the last real day gets a
 * carried copy of it (same value, new day) tagged `complete: false`. A `today`
 * at or before the last real day is a no-op (the input, tagged complete:true) —
 * so under a pinned test/e2e clock where the series already reaches today,
 * nothing changes. Empty input returns empty. Generic over the point shape, so
 * a `{ day, closeCents }` price series and a `{ day, valueCents }` value series
 * both carry forward with their extra fields intact.
 */
export function carryForwardTo<T extends { day: string }>(
  points: readonly T[],
  today: string,
): (T & Carried)[] {
  if (points.length === 0) return [];
  const out: (T & Carried)[] = points.map((p) => ({ ...p, complete: true }));
  const last = points[points.length - 1]!;
  if (compareDates(today, last.day) <= 0) return out;
  for (let day = addDays(last.day, 1); compareDates(day, today) <= 0; day = addDays(day, 1)) {
    out.push({ ...last, day, complete: false });
  }
  return out;
}

/**
 * The day a carried point is HOLDING — the last real day before it, or null when
 * the day named is a measurement rather than a hold.
 *
 * 🔴 The carry-forward is disclosed everywhere a sighted reader looks and
 * nowhere a screen reader does. Measured on /investments at 2026-09-02: the
 * value line is drawn dashed past the last close, the hover chip reads
 * "● Partial", the page banner says "Every position on this page still carries
 * its close from Tue, Sep 1, 2026" — and the chart's own `<figcaption
 * className="sr-only">` said "Wed, Sep 2, 2026: $107,097.05, up 30.0%", dating
 * the figure to a day the series never measured, with nothing to mark it as
 * held. `NetWorthChartPanel`'s spoken readout already names its incomplete
 * days; the two investment charts did not.
 *
 * Returns the ANCHOR rather than a sentence, so the two panels that need it
 * share the decision and each keeps its own wording.
 */
export function carriedFromDay<T extends { day: string; complete?: boolean }>(
  points: readonly T[],
  day: string,
): string | null {
  const idx = points.findIndex((p) => p.day === day);
  // a day that is not in this series, or one that was really measured, is not
  // being held — and neither is a carried FIRST point, which has nothing behind
  // it to hold (an impossible input today, answered rather than assumed)
  if (idx < 0 || points[idx]!.complete !== false) return null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (points[i]!.complete !== false) return points[i]!.day;
  }
  return null;
}
