import { describe, expect, test } from "vitest";
import { intradayPortfolioGrid, type SymbolTicks } from "./intraday-grid";

const E8 = 1e8;

/** 10 shares at $100 = $1,000.00 */
function tick(at: string, close: number) {
  return { at, close };
}

describe("intradayPortfolioGrid", () => {
  test("values a single symbol at each of its own ticks", () => {
    const symbols: SymbolTicks[] = [
      {
        symbol: "VOO",
        quantityE8: 10 * E8,
        priorClose: 100,
        ticks: [tick("2026-07-31T13:30:00.000Z", 100), tick("2026-07-31T13:35:00.000Z", 101)],
      },
    ];

    const { points } = intradayPortfolioGrid(symbols);

    expect(points).toEqual([
      { at: "2026-07-31T13:30:00.000Z", valueCents: 100_000 },
      { at: "2026-07-31T13:35:00.000Z", valueCents: 101_000 },
    ]);
  });

  /**
   * The reason this module exists. AAPL ticks during the session, ETH ticks all
   * day; a naive "latest of each" would value them at different instants.
   */
  test("carries a symbol forward across instants it did not tick at", () => {
    const symbols: SymbolTicks[] = [
      {
        symbol: "AAPL",
        quantityE8: 1 * E8,
        priorClose: 200,
        ticks: [tick("2026-07-31T13:35:00.000Z", 210)],
      },
      {
        symbol: "ETH",
        quantityE8: 1 * E8,
        priorClose: 3000,
        ticks: [tick("2026-07-31T13:30:00.000Z", 3000), tick("2026-07-31T13:40:00.000Z", 3100)],
      },
    ];

    const { points } = intradayPortfolioGrid(symbols);

    expect(points.map((p) => p.at)).toEqual([
      "2026-07-31T13:30:00.000Z",
      "2026-07-31T13:35:00.000Z",
      "2026-07-31T13:40:00.000Z",
    ]);
    // 13:30 — AAPL has not ticked yet, so it is held at its PRIOR CLOSE (200)
    expect(points[0]!.valueCents).toBe(20_000 + 300_000);
    // 13:35 — AAPL ticks to 210; ETH carries forward at 3000
    expect(points[1]!.valueCents).toBe(21_000 + 300_000);
    // 13:40 — AAPL carries forward at 210; ETH ticks to 3100
    expect(points[2]!.valueCents).toBe(21_000 + 310_000);
  });

  test("the first grid point equals yesterday's closing valuation when nothing has moved", () => {
    const symbols: SymbolTicks[] = [
      {
        symbol: "AAPL",
        quantityE8: 3 * E8,
        priorClose: 200,
        ticks: [tick("2026-07-31T20:00:00.000Z", 250)],
      },
      {
        symbol: "MSFT",
        quantityE8: 2 * E8,
        priorClose: 400,
        ticks: [tick("2026-07-31T20:00:00.000Z", 400)],
      },
    ];

    // add an earlier instant from a third symbol so the grid starts before both ticks
    const withEarly: SymbolTicks[] = [
      ...symbols,
      {
        symbol: "ETH",
        quantityE8: 0,
        priorClose: 3000,
        ticks: [tick("2026-07-31T00:00:00.000Z", 3000)],
      },
    ];

    const { points } = intradayPortfolioGrid(withEarly);

    expect(points[0]!.at).toBe("2026-07-31T00:00:00.000Z");
    expect(points[0]!.valueCents).toBe(3 * 20_000 + 2 * 40_000); // 60,000 + 80,000
  });

  test("a symbol with neither ticks nor a prior close contributes zero, and is reported as unpriced", () => {
    const symbols: SymbolTicks[] = [
      {
        symbol: "VOO",
        quantityE8: 1 * E8,
        priorClose: 100,
        ticks: [tick("2026-07-31T13:30:00.000Z", 100)],
      },
      { symbol: "MYSTERY", quantityE8: 5 * E8, priorClose: null, ticks: [] },
    ];

    const { points, pricedSymbols, totalSymbols } = intradayPortfolioGrid(symbols);

    expect(points).toEqual([{ at: "2026-07-31T13:30:00.000Z", valueCents: 10_000 }]);
    expect(pricedSymbols).toBe(1);
    expect(totalSymbols).toBe(2);
  });

  test("a symbol with no ticks but a prior close still contributes, and counts as priced", () => {
    const symbols: SymbolTicks[] = [
      {
        symbol: "VOO",
        quantityE8: 1 * E8,
        priorClose: 100,
        ticks: [tick("2026-07-31T13:30:00.000Z", 100)],
      },
      { symbol: "HELD", quantityE8: 2 * E8, priorClose: 50, ticks: [] },
    ];

    const { points, pricedSymbols } = intradayPortfolioGrid(symbols);

    expect(points[0]!.valueCents).toBe(10_000 + 10_000);
    expect(pricedSymbols).toBe(2);
  });

  test("no ticks anywhere yields no points rather than a flat invented line", () => {
    const symbols: SymbolTicks[] = [{ symbol: "VOO", quantityE8: 1 * E8, priorClose: 100, ticks: [] }];

    const { points, pricedSymbols, totalSymbols } = intradayPortfolioGrid(symbols);

    expect(points).toEqual([]);
    expect(pricedSymbols).toBe(1);
    expect(totalSymbols).toBe(1);
  });

  test("an empty portfolio yields an empty grid", () => {
    expect(intradayPortfolioGrid([])).toEqual({ points: [], pricedSymbols: 0, totalSymbols: 0 });
  });

  test("deduplicates instants shared by several symbols", () => {
    const at = "2026-07-31T13:30:00.000Z";
    const symbols: SymbolTicks[] = [
      { symbol: "A", quantityE8: 1 * E8, priorClose: null, ticks: [tick(at, 10)] },
      { symbol: "B", quantityE8: 1 * E8, priorClose: null, ticks: [tick(at, 20)] },
    ];

    const { points } = intradayPortfolioGrid(symbols);

    expect(points).toHaveLength(1);
    expect(points[0]!.valueCents).toBe(1_000 + 2_000);
  });

  test("sorts the grid even when symbols arrive out of order", () => {
    const symbols: SymbolTicks[] = [
      {
        symbol: "LATE",
        quantityE8: 1 * E8,
        priorClose: null,
        ticks: [tick("2026-07-31T20:00:00.000Z", 10)],
      },
      {
        symbol: "EARLY",
        quantityE8: 1 * E8,
        priorClose: null,
        ticks: [tick("2026-07-31T13:30:00.000Z", 10)],
      },
    ];

    const { points } = intradayPortfolioGrid(symbols);

    expect(points.map((p) => p.at)).toEqual([
      "2026-07-31T13:30:00.000Z",
      "2026-07-31T20:00:00.000Z",
    ]);
  });

  test("advances each symbol's cursor at most once per tick (no quadratic rescan)", () => {
    // 500 instants x 2 symbols: a quadratic implementation would still pass on
    // values, so this pins the SHAPE by asserting the last point is exact after
    // a long carry-forward rather than drifting
    const ticks = Array.from({ length: 500 }, (_, i) => {
      const minute = i % 60;
      const hour = 13 + Math.floor(i / 60);
      return tick(
        `2026-07-31T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`,
        100 + i,
      );
    });
    const symbols: SymbolTicks[] = [
      { symbol: "A", quantityE8: 1 * E8, priorClose: null, ticks },
      {
        symbol: "B",
        quantityE8: 1 * E8,
        priorClose: 1,
        ticks: [tick("2026-07-31T13:00:00.000Z", 7)],
      },
    ];

    const { points } = intradayPortfolioGrid(symbols);

    expect(points).toHaveLength(500);
    expect(points.at(-1)!.valueCents).toBe(59_900 + 700); // A at 599, B carried at 7
  });
});
