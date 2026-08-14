import { describe, expect, test } from "vitest";
import { addDays } from "./dates";
import { fakeDailyClose, fakeIntradayClose, priceWobble } from "./fake-prices";

/**
 * The fake price walk is what the fixture simulator, the demo loader and
 * MONEYAPP_FAKE_PRICES all draw from, so a change here silently rewrites every
 * synthetic statement AND the prices the app charts next to them. These tests
 * pin the properties those three callers rely on — not specific numbers, which
 * would just re-state the implementation.
 */

const SYMBOLS = ["VOO", "AAPL", "MSFT", "ETH", "UNLISTED"] as const;
const DAYS = ["2024-01-01", "2025-03-14", "2026-07-31", "2024-02-29"] as const;

describe("fakeDailyClose", () => {
  test("is deterministic for the same symbol and day", () => {
    for (const symbol of SYMBOLS) {
      for (const day of DAYS) {
        expect(fakeDailyClose(symbol, day)).toBe(fakeDailyClose(symbol, day));
      }
    }
  });

  test("is quoted in whole cents", () => {
    for (const symbol of SYMBOLS) {
      for (const day of DAYS) {
        const price = fakeDailyClose(symbol, day);
        // round-trip rather than `price * 100 === Math.round(price * 100)`:
        // 2583.99 * 100 is 258398.99999999997 in binary floating point, so the
        // naive form fails on values that ARE whole cents
        expect(Math.round(price * 100) / 100).toBe(price);
      }
    }
  });

  test("is case-insensitive in the symbol, so a lowercase ticker is the same asset", () => {
    expect(fakeDailyClose("voo", "2026-07-31")).toBe(fakeDailyClose("VOO", "2026-07-31"));
  });
});

describe("priceWobble", () => {
  const INDICES = Array.from({ length: 400 }, (_, i) => i);

  test("is deterministic in (symbol, t)", () => {
    for (const symbol of SYMBOLS) {
      for (const t of [0, 1, 97, 733]) {
        expect(priceWobble(symbol, t)).toBe(priceWobble(symbol, t));
      }
    }
  });

  test("is case-insensitive in the symbol", () => {
    expect(priceWobble("eth", 42)).toBe(priceWobble("ETH", 42));
  });

  /**
   * The reason this function exists. The e2e fixture used to store its trend
   * directly and every investment chart came out a straight diagonal; a wobble
   * that returned a constant would put that back, and no baseline would fail
   * loudly enough to say why.
   */
  test("actually bends the line — a trend multiplied by it reverses direction repeatedly", () => {
    for (const symbol of SYMBOLS) {
      // a strictly rising trend, exactly the fixture's shape
      const series = INDICES.map((t) => (100 + t * 0.25) * priceWobble(symbol, t));
      const deltas = series.slice(1).map((v, i) => v - series[i]!);
      const turns = deltas.filter((d, i) => i > 0 && Math.sign(d) !== Math.sign(deltas[i - 1]!)).length;
      expect(turns).toBeGreaterThan(20);
    }
  });

  test("stays within ±5% of the trend, so the shape it decorates still reads", () => {
    for (const symbol of SYMBOLS) {
      for (const t of INDICES) {
        expect(priceWobble(symbol, t)).toBeGreaterThan(0.95);
        expect(priceWobble(symbol, t)).toBeLessThan(1.05);
      }
    }
  });

  test("gives different symbols different wobbles, so a portfolio does not move as one", () => {
    const a = INDICES.map((t) => priceWobble("AAPL", t));
    const b = INDICES.map((t) => priceWobble("MSFT", t));
    expect(a).not.toEqual(b);
  });
});

describe("fakeIntradayClose", () => {
  /**
   * THE invariant. If the last tick of a session were merely close to the daily
   * close, /investments' 1D view and its own daily series would disagree about
   * the same quantity by a few cents — the class of defect this app has shipped
   * before and now checks for explicitly.
   */
  test("its last tick IS the day's close, exactly, for every symbol and day", () => {
    for (const symbol of SYMBOLS) {
      for (const day of DAYS) {
        expect(fakeIntradayClose(symbol, day, 78, 78)).toBe(fakeDailyClose(symbol, day));
      }
    }
  });

  test("its first tick IS the previous day's close, exactly", () => {
    for (const symbol of SYMBOLS) {
      for (const day of DAYS) {
        expect(fakeIntradayClose(symbol, day, 0, 78)).toBe(
          fakeDailyClose(symbol, addDays(day, -1)),
        );
      }
    }
  });

  test("the endpoints hold at any tick resolution", () => {
    // a 5-minute equity session, a 1-minute one, and 24h of crypto candles
    for (const steps of [78, 390, 288, 1]) {
      expect(fakeIntradayClose("AAPL", "2026-07-31", steps, steps)).toBe(
        fakeDailyClose("AAPL", "2026-07-31"),
      );
      expect(fakeIntradayClose("AAPL", "2026-07-31", 0, steps)).toBe(
        fakeDailyClose("AAPL", "2026-07-30"),
      );
    }
  });

  test("is deterministic", () => {
    expect(fakeIntradayClose("ETH", "2026-07-31", 41, 288)).toBe(
      fakeIntradayClose("ETH", "2026-07-31", 41, 288),
    );
  });

  test("is quoted in whole cents", () => {
    for (let i = 0; i <= 78; i++) {
      const price = fakeIntradayClose("MSFT", "2026-07-31", i, 78);
      expect(Math.round(price * 100) / 100).toBe(price);
    }
  });

  test("stays inside the day's move plus the wobble, never wandering off", () => {
    for (const symbol of SYMBOLS) {
      const day = "2026-07-31";
      const open = fakeDailyClose(symbol, addDays(day, -1));
      const close = fakeDailyClose(symbol, day);
      const lo = Math.min(open, close);
      const hi = Math.max(open, close);
      // the noise is a fraction of the interpolated base, so bound by the wider end
      const slack = hi * 0.006;
      let sawMovement = false;
      for (let i = 0; i <= 78; i++) {
        const price = fakeIntradayClose(symbol, day, i, 78);
        expect(price).toBeGreaterThanOrEqual(lo - slack);
        expect(price).toBeLessThanOrEqual(hi + slack);
        if (price !== open && price !== close) sawMovement = true;
      }
      // guard the guard: a walk that returned a constant would satisfy the
      // bounds above while being useless as a session
      expect(sawMovement, `${symbol} produced a flat session`).toBe(true);
    }
  });

  test("clamps a tick index outside the session onto its endpoints", () => {
    const first = fakeIntradayClose("VOO", "2026-07-31", 0, 78);
    const last = fakeIntradayClose("VOO", "2026-07-31", 78, 78);

    expect(fakeIntradayClose("VOO", "2026-07-31", -5, 78)).toBe(first);
    expect(fakeIntradayClose("VOO", "2026-07-31", 999, 78)).toBe(last);
  });

  test("treats a non-positive tick count as a single step rather than dividing by zero", () => {
    const single = fakeIntradayClose("VOO", "2026-07-31", 1, 1);

    expect(fakeIntradayClose("VOO", "2026-07-31", 1, 0)).toBe(single);
    expect(fakeIntradayClose("VOO", "2026-07-31", 1, -3)).toBe(single);
    expect(Number.isFinite(fakeIntradayClose("VOO", "2026-07-31", 0, 0))).toBe(true);
  });

  test("truncates fractional ticks instead of producing a fractional seed", () => {
    expect(fakeIntradayClose("VOO", "2026-07-31", 12.7, 78)).toBe(
      fakeIntradayClose("VOO", "2026-07-31", 12, 78),
    );
  });

  test("gives different symbols different sessions", () => {
    const a = Array.from({ length: 20 }, (_, i) => fakeIntradayClose("AAPL", "2026-07-31", i, 78));
    const b = Array.from({ length: 20 }, (_, i) => fakeIntradayClose("MSFT", "2026-07-31", i, 78));

    expect(a).not.toEqual(b);
  });

  test("gives the same symbol different sessions on different days", () => {
    const a = Array.from({ length: 20 }, (_, i) => fakeIntradayClose("AAPL", "2026-07-30", i, 78));
    const b = Array.from({ length: 20 }, (_, i) => fakeIntradayClose("AAPL", "2026-07-31", i, 78));

    expect(a).not.toEqual(b);
  });
});
