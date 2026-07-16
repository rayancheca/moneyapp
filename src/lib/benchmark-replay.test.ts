import { describe, expect, test } from "vitest";
import { replayEnd, replayFlows } from "./benchmark-replay";
import type { BenchmarkDay, PortfolioDay } from "./portfolio-returns";

/** Terse builders: cents NAV/flow, dollar benchmark close. */
function d(day: string, navCents: number, flowCents = 0): PortfolioDay {
  return { day, navCents, flowCents, exact: true };
}
function c(day: string, close: number | null): BenchmarkDay {
  return { day, close };
}

describe("replayFlows", () => {
  test("empty inputs → empty", () => {
    expect(replayFlows([], [])).toEqual([]);
  });

  test("a flat benchmark price: value equals the invested capital, gain 0", () => {
    const points = replayFlows(
      [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 105_000, 0)],
      [c("2026-01-01", 500), c("2026-01-02", 500)],
    );
    expect(points).toEqual([
      { day: "2026-01-01", valueCents: 100_000, gainCents: 0, investedCents: 100_000, shortfallCents: 0 },
      { day: "2026-01-02", valueCents: 100_000, gainCents: 0, investedCents: 100_000, shortfallCents: 0 },
    ]);
  });

  test("the opening capital rides the benchmark: +10% close → +10% value", () => {
    const points = replayFlows(
      [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 130_000, 0)],
      [c("2026-01-01", 500), c("2026-01-02", 550)],
    );
    expect(points[1]).toEqual({
      day: "2026-01-02",
      valueCents: 110_000,
      gainCents: 10_000,
      investedCents: 100_000,
      shortfallCents: 0,
    });
  });

  test("a mid-window deposit buys at THAT day's close — never the baseline's", () => {
    // $1,000 at $500, then $550 doubles nothing: the new $1,100 buys at $550
    const points = replayFlows(
      [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 250_000, 110_000)],
      [c("2026-01-01", 500), c("2026-01-02", 550)],
    );
    // 200 sh… (units) worth: 100000/50000¢ = 2 units + 110000/55000¢ = 2 units
    // → 4 units × 55000¢ = 220,000¢; invested 210,000¢ → gain = the first
    // tranche's +10% only
    expect(points[1]).toEqual({
      day: "2026-01-02",
      valueCents: 220_000,
      gainCents: 10_000,
      investedCents: 210_000,
      shortfallCents: 0,
    });
  });

  test("a withdrawal (negative flow) sells units at that day's close", () => {
    const points = replayFlows(
      [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 0, -55_000)],
      [c("2026-01-01", 500), c("2026-01-02", 550)],
    );
    // 2 units → worth 110,000¢; withdraw 55,000¢ = 1 unit → 1 unit left = 55,000¢
    expect(points[1]).toEqual({
      day: "2026-01-02",
      valueCents: 55_000,
      gainCents: 10_000, // the +10% earned before the withdrawal stays realized
      investedCents: 45_000,
      shortfallCents: 0,
    });
  });

  test("flows before the benchmark has a close wait as cash and buy at the first close — never a fabricated gain", () => {
    const points = replayFlows(
      [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 101_000, 0), d("2026-01-03", 102_000, 0)],
      [c("2026-01-01", null), c("2026-01-02", 500), c("2026-01-03", 550)],
    );
    expect(points[0]).toEqual({ day: "2026-01-01", valueCents: null, gainCents: null, investedCents: 100_000, shortfallCents: 0 });
    expect(points[1]).toEqual({ day: "2026-01-02", valueCents: 100_000, gainCents: 0, investedCents: 100_000, shortfallCents: 0 });
    expect(points[2]!.valueCents).toBe(110_000); // then it rides the +10%
  });

  test("a withdrawal that exactly liquidates leaves zero units, never negative", () => {
    const points = replayFlows(
      [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 0, -110_000)],
      [c("2026-01-01", 500), c("2026-01-02", 550)],
    );
    expect(points[1]).toEqual({
      day: "2026-01-02",
      valueCents: 0,
      gainCents: 10_000,
      investedCents: -10_000, // put in $1,000, took out $1,100 — the $100 was gains
      shortfallCents: 0,
    });
  });

  test("a withdrawal the replay can't fund liquidates and carries a labeled shortfall — never a short position", () => {
    // the holding 5×'d while SPY made +2%: selling half the holding withdraws
    // $5,000 but the replay is only worth $2,040 — SPY couldn't have funded it
    const points = replayFlows(
      [d("2026-01-01", 200_000, 200_000), d("2026-01-02", 500_000, -500_000)],
      [c("2026-01-01", 500), c("2026-01-02", 510)],
    );
    expect(points[1]).toEqual({
      day: "2026-01-02",
      valueCents: 0, // fully liquidated — NOT −$2,960 short
      gainCents: 4_000, // the +2% SPY earned before liquidation
      investedCents: -4_000,
      shortfallCents: 296_000, // the withdrawals SPY could not have funded
    });
    // and the line never moves inversely to the benchmark afterwards
    const later = replayFlows(
      [d("2026-01-01", 200_000, 200_000), d("2026-01-02", 500_000, -500_000), d("2026-01-03", 500_000, 0)],
      [c("2026-01-01", 500), c("2026-01-02", 510), c("2026-01-03", 561)],
    );
    expect(later[2]!.valueCents).toBe(0);
    expect(later[2]!.gainCents).toBe(4_000); // flat, not falling as SPY rises
  });

  test("a deposit after a dry spell re-invests from zero", () => {
    const points = replayFlows(
      [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 0, -150_000), d("2026-01-03", 50_000, 50_000)],
      [c("2026-01-01", 500), c("2026-01-02", 500), c("2026-01-03", 500)],
    );
    expect(points[1]!.valueCents).toBe(0);
    expect(points[1]!.shortfallCents).toBe(50_000);
    expect(points[2]!.valueCents).toBe(50_000); // the new deposit buys fresh units
    expect(points[2]!.shortfallCents).toBe(50_000); // the shortfall stays on record
  });

  test("gain always reconciles: value − invested, every priced day", () => {
    const days = [
      d("2026-01-01", 50_000, 50_000),
      d("2026-01-02", 80_000, 25_000),
      d("2026-01-03", 70_000, -10_000),
      d("2026-01-04", 90_000, 0),
    ];
    const closes = [c("2026-01-01", 411.17), c("2026-01-02", 415.03), c("2026-01-03", 404.44), c("2026-01-04", 419.9)];
    for (const p of replayFlows(days, closes)) {
      expect(p.valueCents).not.toBeNull();
      expect(p.gainCents).toBe(p.valueCents! - p.investedCents);
    }
  });
});

describe("replayEnd", () => {
  test("the last priced point vs the actual NAV — 'you'd have $X, Δ $Y'", () => {
    const days = [d("2026-01-01", 100_000, 100_000), d("2026-01-02", 104_000, 0)];
    const closes = [c("2026-01-01", 500), c("2026-01-02", 550)];
    const end = replayEnd(replayFlows(days, closes), days);
    expect(end).toEqual({
      valueCents: 110_000,
      gainCents: 10_000,
      // Δ = replay − actual: SPY would have ended $60 ahead of the real $1,040
      deltaVsActualCents: 6_000,
      shortfallCents: 0,
    });
  });

  test("null when the benchmark never priced any day", () => {
    const days = [d("2026-01-01", 100_000, 100_000)];
    expect(replayEnd(replayFlows(days, [c("2026-01-01", null)]), days)).toBeNull();
  });

  test("defensive: a half-priced point is skipped; an empty days list deltas vs zero", () => {
    // replayFlows never emits these shapes, but the API accepts arbitrary points
    expect(
      replayEnd(
        [{ day: "2026-01-01", valueCents: 100, gainCents: null, investedCents: 100, shortfallCents: 0 }],
        [],
      ),
    ).toBeNull();
    expect(
      replayEnd(
        [{ day: "2026-01-01", valueCents: 100, gainCents: 0, investedCents: 100, shortfallCents: 0 }],
        [],
      )!.deltaVsActualCents,
    ).toBe(100);
  });
});
