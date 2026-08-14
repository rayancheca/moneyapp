/**
 * The SHAPE contract for the seeded e2e price series — the rule, with no I/O.
 *
 * Pass 53 shipped a fixture whose closes were a linear ramp, and the cost was
 * not the fixture: it was that ~40 pixel baselines drawn over it went BLIND. A
 * ruler-straight sparkline is indistinguishable from a collapsed-series
 * rendering bug, so every baseline photographing one silently stopped being
 * evidence. Two properties keep them evidence:
 *
 *   1. every seeded close series actually BENDS;
 *   2. each series' last-day move is EXACTLY its contract delta, because the
 *      movers direction and the dashboard headline move are computed from it.
 *
 * ── Why this file lives in scripts/ and not src/lib/ ────────────────────────
 * src/lib would put it under the 100% coverage threshold, which is tempting.
 * It would also break the e2e harness: `assertBundleIsFresh` (e2e/global-setup
 * .ts) walks ONLY the src tree and throws when anything there is newer than
 * .next/BUILD_ID. A harness-only checker in src/lib would therefore make
 * `pnpm e2e` refuse to run after every edit to it until a full `next build` —
 * for a file that is never in the bundle. scripts/**\/*.test.ts is already a
 * collected vitest glob (vitest.config.ts), so the rules below still get unit
 * tests; they just do not carry a coverage threshold.
 *
 * ── Why the contract is RESTATED here rather than imported ──────────────────
 * `SEEDED_SERIES` deliberately duplicates what e2e/seed-helpers.ts seeds. That
 * is the entire point: importing SEED_SECURITIES would mean deleting a symbol
 * from the seeder ALSO deletes the expectation, and the check would pass by
 * agreeing with the mistake. An expectation that moves with the thing it
 * measures is not an expectation. If these two lists drift, this file is
 * supposed to fail.
 */

/** One seeded series, named independently of the seeder (see the header). */
export interface SeededSeries {
  symbol: string;
  /** part of the identity: price_cache is unique on (symbol, asset_type, quoted_on) */
  assetType: string;
  /** the pinned final-day move, in cents */
  lastDayDeltaCents: number;
}

/**
 * Mirrors SEED_SECURITIES in e2e/seed-helpers.ts. Note WMT is an **etf**, not a
 * stock — the asset type is load-bearing, because reading closes by symbol
 * alone would interleave two independent series for a symbol held under two
 * asset types, and the app explicitly supports that.
 */
export const SEEDED_SERIES: readonly SeededSeries[] = [
  { symbol: "AAPL", assetType: "stock", lastDayDeltaCents: 340 },
  { symbol: "MSFT", assetType: "stock", lastDayDeltaCents: -520 },
  { symbol: "WMT", assetType: "etf", lastDayDeltaCents: 0 },
  { symbol: "ETH", assetType: "crypto", lastDayDeltaCents: 0 },
];

/** Below this the series is too short to say anything about its shape. */
export const MIN_CLOSES = 60;

/**
 * The share of NON-FLAT day-over-day deltas that must reverse direction. Any
 * monotone series — a smooth ramp or a staircase — scores 0; the real seeded
 * wobble measures around 0.66. 0.2 is far enough below the real value to never
 * flake and far enough above 0 to catch a ruler.
 */
export const MIN_TURN_RATE = 0.2;

/** How a series is addressed in the map handed to `checkFixtureShape`. */
export function seriesKey(symbol: string, assetType: string): string {
  return `${symbol}:${assetType}`;
}

/** What one series measured — reported so callers can print it without redoing the math. */
export interface SeriesShape {
  symbol: string;
  closeCount: number;
  turns: number;
  turnRate: number;
  lastDayDeltaCents: number;
}

export interface FixtureShapeReport {
  /** empty means the fixture still holds its shape */
  failures: readonly string[];
  /** one entry per series that was complete enough to measure */
  shapes: readonly SeriesShape[];
}

/**
 * Check every series the contract names.
 *
 * `series` maps `seriesKey(symbol, assetType)` to that series' closes **in
 * ascending quoted_on order** — ordering is the caller's job (an `order by
 * quoted_on` in SQL), because this function is deliberately pure and has no way
 * to verify it.
 *
 * Iteration is driven by SEEDED_SERIES, never by the map's own keys. Driving it
 * from the data is how the original script could exit 0 after a symbol vanished
 * from the seeder entirely: it looped over what the query returned, so a
 * missing symbol was simply never visited.
 */
export function checkFixtureShape(
  series: ReadonlyMap<string, readonly number[]>,
): FixtureShapeReport {
  const failures: string[] = [];
  const shapes: SeriesShape[] = [];

  for (const want of SEEDED_SERIES) {
    const closes = series.get(seriesKey(want.symbol, want.assetType));

    if (closes === undefined || closes.length === 0) {
      failures.push(
        `${want.symbol} (${want.assetType}): no closes at all — did it leave SEED_SECURITIES, ` +
          `or change asset type?`,
      );
      continue;
    }

    if (closes.length < MIN_CLOSES) {
      failures.push(
        `${want.symbol} (${want.assetType}): only ${closes.length} closes, need ${MIN_CLOSES}`,
      );
      continue;
    }

    // (1) Does the line bend? Count REVERSALS among the day-over-day deltas,
    // EXCLUDING the pinned final day — that one is a fixed contract move, not
    // part of the wobble, and counting it would let one pinned step flatter a
    // straight series.
    //
    // ⚠️ Flat days are removed before the comparison, and that is load-bearing.
    // `Math.sign(0)` is 0 — a THIRD value, distinct from -1 and +1 — so
    // comparing raw deltas scores every entry into and exit from a flat day as
    // two "direction changes" on a series that never actually reverses. That is
    // not a nitpick: a mathematically perfect ramp whose daily step is smaller
    // than a cent rounds to a staircase of zeros and one-cent steps, and scored
    // 0.814 under the naive comparison — a ruler sailing through the one check
    // whose entire purpose is to catch rulers. Reversals are only meaningful
    // between days the price actually MOVED.
    const trend = closes.slice(0, -1);
    const deltas = trend.slice(1).map((v, i) => v - trend[i]!);
    const moves = deltas.filter((d) => d !== 0);

    // A series that barely moves at all cannot be shown to bend, and a flat
    // line is the most ruler-like series there is.
    if (moves.length < 2) {
      failures.push(
        `${want.symbol} (${want.assetType}): series never moves — ${moves.length} non-flat ` +
          `${moves.length === 1 ? "day" : "days"} in ${deltas.length}`,
      );
      continue;
    }

    let turns = 0;
    for (let i = 1; i < moves.length; i++) {
      if (Math.sign(moves[i]!) !== Math.sign(moves[i - 1]!)) turns += 1;
    }
    // denominator is the number of comparisons actually made, so the rate is a
    // true share of "chances to reverse" rather than of calendar days
    const turnRate = turns / (moves.length - 1);
    if (turnRate < MIN_TURN_RATE) {
      failures.push(
        `${want.symbol} (${want.assetType}): series is effectively straight — ${turns} direction ` +
          `changes over ${moves.length} moves (${(turnRate * 100).toFixed(1)}%)`,
      );
    }

    // (2) Is the final day still pinned to the contract delta? Rounded to cents
    // on each side before subtracting, so float drift in the seeded closes
    // cannot register as a contract break.
    const last = closes.at(-1)!;
    const prev = closes.at(-2)!;
    const gotCents = Math.round(last * 100) - Math.round(prev * 100);
    if (gotCents !== want.lastDayDeltaCents) {
      failures.push(
        `${want.symbol} (${want.assetType}): last-day delta is ${gotCents}c, contract says ` +
          `${want.lastDayDeltaCents}c`,
      );
    }

    shapes.push({
      symbol: want.symbol,
      closeCount: closes.length,
      turns,
      turnRate,
      lastDayDeltaCents: gotCents,
    });
  }

  return { failures, shapes };
}

/** The whole report as the lines a human reads; empty when the fixture holds. */
export function formatFixtureShapeFailures(report: FixtureShapeReport): string {
  if (report.failures.length === 0) return "";
  return (
    "the seeded price fixture lost its shape — every investment baseline drawn over it is\n" +
    "now blind to the bug it exists to catch:\n" +
    report.failures.map((f) => "  - " + f).join("\n")
  );
}
