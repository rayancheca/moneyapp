import { describe, expect, test } from "vitest";
import {
  MIN_CLOSES,
  SEEDED_SERIES,
  checkFixtureShape,
  formatFixtureShapeFailures,
  seriesKey,
} from "./fixture-shape";

/**
 * A rising trend with an alternating ±2 wobble on top, then the pinned final
 * day. Nearly every day-over-day delta changes sign, so this is the SHAPE the
 * real seeder produces (measured ~0.66 turn rate) rather than a ruler.
 */
function wobbly(count: number, lastDeltaCents: number): number[] {
  const trend = Array.from({ length: count - 1 }, (_, i) =>
    Number((100 + i * 0.5 + (i % 2 === 0 ? 2 : -2)).toFixed(2)),
  );
  return [...trend, Number((trend.at(-1)! + lastDeltaCents / 100).toFixed(2))];
}

/** The defect this whole check exists to catch: closes drawn with a ruler. */
function straight(count: number, lastDeltaCents: number): number[] {
  const trend = Array.from({ length: count - 1 }, (_, i) => 100 + i);
  return [...trend, Number((trend.at(-1)! + lastDeltaCents / 100).toFixed(2))];
}

/** Every series the contract names, each holding its shape. */
function healthy(): Map<string, number[]> {
  return new Map(
    SEEDED_SERIES.map((s) => [seriesKey(s.symbol, s.assetType), wobbly(61, s.lastDayDeltaCents)]),
  );
}

describe("checkFixtureShape", () => {
  test("a fixture that bends and pins its last day reports no failures", () => {
    const report = checkFixtureShape(healthy());

    expect(report.failures).toEqual([]);
    expect(report.shapes).toHaveLength(SEEDED_SERIES.length);
  });

  test("reports what each series measured, so a caller need not redo the math", () => {
    const report = checkFixtureShape(healthy());
    const aapl = report.shapes.find((s) => s.symbol === "AAPL")!;

    expect(aapl.closeCount).toBe(61);
    expect(aapl.lastDayDeltaCents).toBe(340);
    // the wobble alternates on every step, so all but the first delta turn
    expect(aapl.turns).toBe(58);
    expect(aapl.turnRate).toBeGreaterThan(0.9);
  });

  test("catches a ruler-straight series — the pass-53 defect", () => {
    const series = healthy();
    series.set(seriesKey("MSFT", "stock"), straight(61, -520));

    const report = checkFixtureShape(series);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/MSFT \(stock\): series is effectively straight — 0 /);
  });

  test("the pinned last day cannot flatter an otherwise straight series", () => {
    // the final day is EXCLUDED from the turn count precisely so that one
    // contract-mandated step in the other direction does not read as a bend
    const series = healthy();
    series.set(seriesKey("AAPL", "stock"), straight(61, 340));

    const report = checkFixtureShape(series);

    expect(report.failures[0]).toMatch(/AAPL \(stock\): series is effectively straight/);
  });

  test("catches a last-day delta that drifted off its contract", () => {
    const series = healthy();
    series.set(seriesKey("AAPL", "stock"), wobbly(61, 341));

    const report = checkFixtureShape(series);

    expect(report.failures).toEqual(["AAPL (stock): last-day delta is 341c, contract says 340c"]);
  });

  test("catches a series too short to say anything about, and does not measure it", () => {
    const series = healthy();
    series.set(seriesKey("ETH", "crypto"), wobbly(MIN_CLOSES - 1, 0));

    const report = checkFixtureShape(series);

    expect(report.failures).toEqual([`ETH (crypto): only ${MIN_CLOSES - 1} closes, need ${MIN_CLOSES}`]);
    expect(report.shapes.map((s) => s.symbol)).not.toContain("ETH");
  });

  test("catches a symbol that VANISHED from the seeder — the hole in the old script", () => {
    // the original script looped over what the query returned, so a symbol that
    // stopped being seeded was never visited and the run exited 0
    const series = healthy();
    series.delete(seriesKey("AAPL", "stock"));

    const report = checkFixtureShape(series);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/AAPL \(stock\): no closes at all/);
  });

  test("catches a series whose ASSET TYPE changed, not just its symbol", () => {
    // price_cache is unique on (symbol, asset_type, quoted_on), and the app
    // supports one symbol under two asset types — so reading by symbol alone
    // would silently interleave two independent series
    const series = healthy();
    const closes = series.get(seriesKey("WMT", "etf"))!;
    series.delete(seriesKey("WMT", "etf"));
    series.set(seriesKey("WMT", "stock"), closes);

    const report = checkFixtureShape(series);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/WMT \(etf\): no closes at all/);
  });

  test("an empty series reads as missing, not as a zero-length pass", () => {
    const series = healthy();
    series.set(seriesKey("ETH", "crypto"), []);

    const report = checkFixtureShape(series);

    expect(report.failures[0]).toMatch(/ETH \(crypto\): no closes at all/);
  });

  test("reports every broken series, not just the first", () => {
    const series = healthy();
    series.set(seriesKey("AAPL", "stock"), straight(61, 340));
    series.delete(seriesKey("ETH", "crypto"));

    const report = checkFixtureShape(series);

    expect(report.failures).toHaveLength(2);
  });
});

describe("formatFixtureShapeFailures", () => {
  test("says nothing when the fixture holds its shape", () => {
    expect(formatFixtureShapeFailures(checkFixtureShape(healthy()))).toBe("");
  });

  test("names the stakes and lists every failure", () => {
    const series = healthy();
    series.delete(seriesKey("AAPL", "stock"));

    const text = formatFixtureShapeFailures(checkFixtureShape(series));

    expect(text).toMatch(/every investment baseline drawn over it is/);
    expect(text).toMatch(/ {2}- AAPL \(stock\): no closes at all/);
  });
});
