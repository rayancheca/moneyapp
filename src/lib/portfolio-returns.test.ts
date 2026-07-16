import { describe, expect, test } from "vitest";
import {
  aggregateReturn,
  benchmarkReturns,
  cumulativeReturns,
  dailyReturns,
  returnStats,
  simpleReturnPct,
  totalReturn,
  type PortfolioDay,
} from "./portfolio-returns";

/** Terse builder: a day with an exact flow by default. */
function d(day: string, navCents: number, flowCents = 0, exact = true): PortfolioDay {
  return { day, navCents, flowCents, exact };
}

describe("dailyReturns", () => {
  test("the first point is the anchor and yields no return", () => {
    const returns = dailyReturns([d("2026-01-01", 10_000)]);
    expect(returns).toEqual([]);
  });

  test("a pure market move: return is the whole NAV delta, factor is the ratio", () => {
    const returns = dailyReturns([d("2026-01-01", 10_000), d("2026-01-02", 10_500)]);
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({
      day: "2026-01-02",
      returnCents: 500,
      prevNavCents: 10_000,
      flowCents: 0,
    });
    expect(returns[0]!.factor).toBeCloseTo(1.05, 10);
  });

  test("a mid-period deposit is NOT a gain (deposit ≠ gain)", () => {
    // NAV jumps 100 → 200 but 100 of it was bought, not earned
    const returns = dailyReturns([
      d("2026-01-01", 10_000),
      d("2026-01-02", 10_000), // flat market
      d("2026-01-03", 20_000, 10_000), // +$100 of new stock bought
    ]);
    expect(returns[1]!.returnCents).toBe(0);
    expect(returns[1]!.factor).toBeCloseTo(1, 10); // 20000 / (10000 + 10000)
    // whole-window TWR is flat despite NAV doubling
    expect(aggregateReturn(returns).twrPct).toBeCloseTo(0, 10);
  });

  test("phantom seed-day opening: a position appearing mid-series is not a gain", () => {
    // an existing $1,000 book, then a $5,000 position appears (neutralized by an
    // equal opening flow) → 0 return that day, then a real +$100 market gain chains
    const returns = dailyReturns([
      d("2026-01-01", 100_000, 0), // existing book
      d("2026-01-02", 600_000, 500_000), // a $5,000 position appears, flow == its value
      d("2026-01-03", 610_000, 0), // real +$100 market gain
    ]);
    expect(returns[0]!.returnCents).toBe(0); // the appearance is not a gain
    expect(returns[0]!.factor).toBeCloseTo(1, 10); // 600000 / (100000 + 500000)
    expect(returns[1]!.returnCents).toBe(10_000);
    // TWR reflects only the real move, never the ~+510% the raw NAV jump implies
    expect(aggregateReturn(returns).twrPct).toBeCloseTo((610_000 / 600_000 - 1) * 100, 8);
  });

  test("a carried close is a flat day (missing-close carry-forward)", () => {
    const returns = dailyReturns([
      d("2026-01-01", 10_000),
      d("2026-01-02", 10_000), // close carried forward → NAV unchanged
      d("2026-01-03", 10_300),
    ]);
    expect(returns[0]!.returnCents).toBe(0);
    expect(returns[0]!.factor).toBe(1);
    expect(returns[1]!.returnCents).toBe(300);
  });

  test("mixed stock+crypto weekend: only what moved contributes", () => {
    // Sat/Sun the equity book is flat (carried), only crypto ticks up — the
    // portfolio NAV moves by exactly the crypto move, flow 0
    const returns = dailyReturns([
      d("2026-01-02", 100_000), // Fri
      d("2026-01-03", 100_250), // Sat: only crypto up $2.50
      d("2026-01-04", 100_100), // Sun: crypto down
    ]);
    expect(returns[0]!.returnCents).toBe(250);
    expect(returns[1]!.returnCents).toBe(-150);
  });

  test("a net sell (negative flow) does not read as a loss", () => {
    // sold $3,000 of stock; NAV falls 10,000 → 7,050 but $50 of that is a gain
    const returns = dailyReturns([d("2026-01-01", 10_000), d("2026-01-02", 7_050, -3_000)]);
    expect(returns[0]!.returnCents).toBe(50); // 7050 - 10000 - (-3000)
    // +$0.50 gain on the $100 that stayed invested → +0.5%, measured on prevNav
    expect(returns[0]!.factor).toBeCloseTo(1.005, 10); // (7050 - (-3000)) / 10000
  });

  test("an empty invested base (prevNav 0, no flow) yields a flat factor, not a divide-by-zero", () => {
    const flat = dailyReturns([d("2026-01-01", 0), d("2026-01-02", 0, 0)]);
    expect(flat[0]!.factor).toBe(1);
    expect(flat[0]!.returnCents).toBe(0);
  });

  test("carries the per-day exact flag through", () => {
    const returns = dailyReturns([
      d("2026-01-01", 10_000),
      d("2026-01-02", 10_500, 0, false), // approximate day
    ]);
    expect(returns[0]!.exact).toBe(false);
  });
});

describe("aggregateReturn", () => {
  test("empty window is a flat, exact zero", () => {
    expect(aggregateReturn([])).toEqual({
      twrPct: 0,
      gainCents: 0,
      netFlowCents: 0,
      startNavCents: 0,
      endNavCents: 0,
      exact: true,
    });
  });

  test("chains factors and sums dollar gains + flows", () => {
    const returns = dailyReturns([
      d("2026-01-01", 10_000),
      d("2026-01-02", 11_000, 500), // +$5 market on a $5 buy
      d("2026-01-03", 12_100),
    ]);
    const agg = aggregateReturn(returns);
    expect(agg.startNavCents).toBe(10_000);
    expect(agg.endNavCents).toBe(12_100);
    expect(agg.netFlowCents).toBe(500);
    expect(agg.gainCents).toBe(returns[0]!.returnCents + returns[1]!.returnCents);
    expect(agg.twrPct).toBeCloseTo((returns[0]!.factor * returns[1]!.factor - 1) * 100, 10);
  });

  test("any inexact day makes the whole window inexact", () => {
    const returns = dailyReturns([
      d("2026-01-01", 10_000),
      d("2026-01-02", 10_500),
      d("2026-01-03", 11_000, 200, false),
    ]);
    expect(aggregateReturn(returns).exact).toBe(false);
  });

  test("an all-exact window stays exact", () => {
    const returns = dailyReturns([d("2026-01-01", 10_000), d("2026-01-02", 10_500)]);
    expect(aggregateReturn(returns).exact).toBe(true);
  });
});

describe("simpleReturnPct", () => {
  test("gain over opening capital", () => {
    expect(simpleReturnPct(10_000, 500)).toBeCloseTo(5, 10);
  });
  test("null when there is no opening capital", () => {
    expect(simpleReturnPct(0, 500)).toBeNull();
    expect(simpleReturnPct(-100, 500)).toBeNull();
  });
});

describe("totalReturn", () => {
  test("is aggregateReturn over the whole series", () => {
    const days = [d("2026-01-01", 10_000), d("2026-01-02", 10_200), d("2026-01-03", 10_400)];
    expect(totalReturn(days)).toEqual(aggregateReturn(dailyReturns(days)));
  });
});

describe("cumulativeReturns", () => {
  test("empty series → empty line", () => {
    expect(cumulativeReturns([])).toEqual([]);
  });

  test("a single day is the baseline: zero gain, zero %, aligned to the day", () => {
    expect(cumulativeReturns([d("2026-01-01", 10_000)])).toEqual([
      { day: "2026-01-01", cumGainCents: 0, cumTwrPct: 0, navCents: 10_000, cumNetFlowCents: 0, exact: true },
    ]);
  });

  test("one point per input day (1:1 with the value series)", () => {
    const days = [d("2026-01-01", 10_000), d("2026-01-02", 10_500), d("2026-01-03", 10_600)];
    expect(cumulativeReturns(days).map((p) => p.day)).toEqual(days.map((x) => x.day));
  });

  test("accumulates flow-adjusted $ gain across a pure market series", () => {
    const line = cumulativeReturns([d("2026-01-01", 10_000), d("2026-01-02", 10_500), d("2026-01-03", 10_600)]);
    expect(line.map((p) => p.cumGainCents)).toEqual([0, 500, 600]);
  });

  test("a mid-period deposit does not step the line up (deposit ≠ gain)", () => {
    // NAV doubles on a $100 buy — the returns line must stay flat that day
    const line = cumulativeReturns([
      d("2026-01-01", 10_000),
      d("2026-01-02", 10_000),
      d("2026-01-03", 20_000, 10_000),
    ]);
    expect(line.map((p) => p.cumGainCents)).toEqual([0, 0, 0]);
    expect(line.at(-1)!.cumTwrPct).toBeCloseTo(0, 10);
    expect(line.at(-1)!.cumNetFlowCents).toBe(10_000);
  });

  test("the final point reconciles exactly to totalReturn", () => {
    const days = [
      d("2026-01-01", 10_000),
      d("2026-01-02", 11_000, 500),
      d("2026-01-03", 12_100),
    ];
    const total = totalReturn(days);
    const last = cumulativeReturns(days).at(-1)!;
    expect(last.cumGainCents).toBe(total.gainCents);
    expect(last.cumTwrPct).toBeCloseTo(total.twrPct, 10);
  });

  test("cumulative TWR chains the daily factors", () => {
    const days = [d("2026-01-01", 10_000), d("2026-01-02", 11_000), d("2026-01-03", 12_100)];
    const line = cumulativeReturns(days);
    expect(line[1]!.cumTwrPct).toBeCloseTo(10, 10); // +10%
    expect(line[2]!.cumTwrPct).toBeCloseTo(21, 10); // 1.1 * 1.1 - 1 = 21%
  });

  test("`exact` latches false from the first approximate day onward", () => {
    const line = cumulativeReturns([
      d("2026-01-01", 10_000),
      d("2026-01-02", 10_500, 0, false), // approximate
      d("2026-01-03", 10_800),
    ]);
    expect(line.map((p) => p.exact)).toEqual([true, false, false]);
  });
});

describe("returnStats", () => {
  test("empty / single-day series has no stats and zero drawdown", () => {
    expect(returnStats([])).toEqual({ bestDay: null, worstDay: null, maxDrawdownPct: 0 });
    expect(returnStats([d("2026-01-01", 10_000)])).toEqual({ bestDay: null, worstDay: null, maxDrawdownPct: 0 });
  });

  test("finds the best and worst market days (flow-adjusted)", () => {
    const stats = returnStats([
      d("2026-01-01", 10_000),
      d("2026-01-02", 10_500), // +500 (best)
      d("2026-01-03", 10_200), // −300 (worst)
      d("2026-01-04", 10_300), // +100
    ]);
    expect(stats.bestDay).toEqual({ day: "2026-01-02", returnCents: 500, pct: 5 });
    expect(stats.worstDay?.day).toBe("2026-01-03");
    expect(stats.worstDay?.returnCents).toBe(-300);
  });

  test("a deposit day is never the best day (deposit ≠ gain)", () => {
    const stats = returnStats([
      d("2026-01-01", 10_000),
      d("2026-01-02", 20_000, 10_000), // +$100 of NAV, all bought → 0 return
      d("2026-01-03", 20_100), // +100 real
    ]);
    expect(stats.bestDay?.day).toBe("2026-01-03");
    expect(stats.bestDay?.returnCents).toBe(100);
  });

  test("max drawdown is the deepest peak-to-trough decline of the return index", () => {
    // rise to +10%, fall to −10% off the peak, recover a bit
    const stats = returnStats([
      d("2026-01-01", 10_000),
      d("2026-01-02", 11_000), // index 1.10 (peak)
      d("2026-01-03", 9_900), // index 0.99 → drawdown = 0.99/1.10 − 1 = −10%
      d("2026-01-04", 10_400),
    ]);
    expect(stats.maxDrawdownPct).toBeCloseTo(-10, 8);
  });

  test("a monotonically rising line has zero drawdown", () => {
    const stats = returnStats([d("2026-01-01", 10_000), d("2026-01-02", 10_500), d("2026-01-03", 11_000)]);
    expect(stats.maxDrawdownPct).toBe(0);
  });

  test("a day entering with no invested base has a null pct (no divide-by-zero)", () => {
    const stats = returnStats([d("2026-01-01", 0), d("2026-01-02", 0, 0)]);
    expect(stats.bestDay).toEqual({ day: "2026-01-02", returnCents: 0, pct: null });
    expect(stats.worstDay?.pct).toBeNull();
  });
});

describe("benchmarkReturns", () => {
  test("rebases to the first close: cumulative % from 0", () => {
    const pct = benchmarkReturns([
      { day: "2026-01-01", close: 10_000 },
      { day: "2026-01-02", close: 10_500 }, // +5%
      { day: "2026-01-03", close: 11_000 }, // +10%
    ]);
    expect(pct[0]).toBe(0);
    expect(pct[1]).toBeCloseTo(5, 10);
    expect(pct[2]).toBeCloseTo(10, 10);
  });

  test("days before the benchmark has a close are null, then it rebases to the first real close", () => {
    const pct = benchmarkReturns([
      { day: "2026-01-01", close: null },
      { day: "2026-01-02", close: null },
      { day: "2026-01-03", close: 200 }, // first available → base
      { day: "2026-01-04", close: 210 }, // +5%
    ]);
    expect(pct.slice(0, 2)).toEqual([null, null]);
    expect(pct[2]).toBe(0);
    expect(pct[3]).toBeCloseTo(5, 10);
  });

  test("a non-positive close is treated as no data (null)", () => {
    const pct = benchmarkReturns([
      { day: "2026-01-01", close: 0 },
      { day: "2026-01-02", close: 100 },
    ]);
    expect(pct).toEqual([null, 0]);
  });

  test("empty input → empty line", () => {
    expect(benchmarkReturns([])).toEqual([]);
  });
});
