import { describe, expect, test } from "vitest";
import { holdingReturnDays, valueCentsOf, type HoldingClose, type HoldingTrade } from "./holding-returns";
import { cumulativeReturns, dailyReturns, totalReturn } from "./portfolio-returns";

/** Terse builders: whole-unit qty, dollar close (matching priceCache semantics). */
function tr(day: string, qty: number): HoldingTrade {
  return { day, deltaE8: Math.round(qty * 1e8) };
}
function cl(day: string, close: number): HoldingClose {
  return { day, close };
}

describe("valueCentsOf", () => {
  test("values a fractional quantity at a dollar close, in cents", () => {
    expect(valueCentsOf(10e8, 100)).toBe(100_000); // 10 sh × $100 = $1,000.00
    expect(valueCentsOf(0.5e8, 123.45)).toBe(6_173); // 0.5 × $123.45 = $61.725 → 6173¢
    expect(valueCentsOf(0, 100)).toBe(0);
  });
});

describe("holdingReturnDays", () => {
  test("no trades or no closes → empty", () => {
    expect(holdingReturnDays([], [cl("2026-01-01", 100)])).toEqual([]);
    expect(holdingReturnDays([tr("2026-01-01", 10)], [])).toEqual([]);
    expect(holdingReturnDays([], [])).toEqual([]);
  });

  test("non-positive closes are dropped; all-invalid closes → empty", () => {
    expect(holdingReturnDays([tr("2026-01-01", 10)], [cl("2026-01-01", 0), cl("2026-01-02", -5)])).toEqual([]);
  });

  test("a single buy then a price rise: NAV tracks, the buy day is the neutralized baseline", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 10)],
      [cl("2026-01-01", 100), cl("2026-01-02", 110)],
    );
    expect(days).toEqual([
      { day: "2026-01-01", navCents: 100_000, flowCents: 100_000, exact: true },
      { day: "2026-01-02", navCents: 110_000, flowCents: 0, exact: true },
    ]);
    const total = totalReturn(days);
    expect(total.gainCents).toBe(10_000); // 10 sh × $10
    expect(total.twrPct).toBeCloseTo(10, 10); // = the price return 110/100 − 1
  });

  test("a mid-series buy (DCA) is a flow, never a gain", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 10), tr("2026-01-02", 5)],
      [cl("2026-01-01", 100), cl("2026-01-02", 110), cl("2026-01-03", 120)],
    );
    // day 2: 15 sh × $110 = $1,650; flow = value of the 5 new shares at that close
    expect(days[1]).toEqual({ day: "2026-01-02", navCents: 165_000, flowCents: 55_000, exact: true });
    const rs = dailyReturns(days);
    expect(rs[0]!.returnCents).toBe(10_000); // only the held 10 sh gained $10 each
    expect(rs[1]!.returnCents).toBe(15_000); // then all 15 sh gained $10 each
    // TWR still telescopes to the pure price return: 120/100 − 1 = 20%
    expect(totalReturn(days).twrPct).toBeCloseTo(20, 10);
  });

  test("trades before the first close roll into the neutralized opening", () => {
    // bought in 2024, prices only cached from 2026 — the position ENTERS the
    // series on its first priceable day at full NAV, never as a gain
    const days = holdingReturnDays(
      [tr("2024-08-01", 10), tr("2024-09-01", 5)],
      [cl("2026-01-01", 100), cl("2026-01-02", 101)],
    );
    expect(days[0]).toEqual({ day: "2026-01-01", navCents: 150_000, flowCents: 150_000, exact: true });
    expect(totalReturn(days).gainCents).toBe(1_500); // 15 sh × $1
  });

  test("a close gap (weekend) carries the last close — a flat, zero-return day", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 10)],
      [cl("2026-01-01", 100), cl("2026-01-04", 104)],
    );
    expect(days.map((d) => d.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    expect(days[1]!.navCents).toBe(100_000); // carried
    expect(days[2]!.navCents).toBe(100_000);
    const rs = dailyReturns(days);
    expect(rs[0]!.returnCents).toBe(0);
    expect(rs[1]!.returnCents).toBe(0);
    expect(rs[2]!.returnCents).toBe(4_000);
  });

  test("a full sell ends the series on the sell day and keeps the realized gain", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 10), tr("2026-01-03", -10)],
      [cl("2026-01-01", 100), cl("2026-01-02", 110), cl("2026-01-03", 120), cl("2026-01-10", 130)],
    );
    expect(days.at(-1)).toEqual({ day: "2026-01-03", navCents: 0, flowCents: -120_000, exact: true });
    const line = cumulativeReturns(days);
    expect(line.at(-1)!.cumGainCents).toBe(20_000); // $100 + $100 across the two held days
    // no trailing flat-zero days out to the last cached close
    expect(days).toHaveLength(3);
  });

  test("a sold-out gap is flat and a re-entry is neutralized, not a gain", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 10), tr("2026-01-02", -10), tr("2026-01-05", 4)],
      [
        cl("2026-01-01", 100),
        cl("2026-01-02", 110),
        cl("2026-01-03", 115),
        cl("2026-01-04", 118),
        cl("2026-01-05", 130),
      ],
    );
    const rs = dailyReturns(days);
    // sell day realizes the $10 move; the empty days return 0; the re-buy day is a flow
    expect(rs.map((r) => r.returnCents)).toEqual([10_000, 0, 0, 0]);
    expect(days.at(-1)).toEqual({ day: "2026-01-05", navCents: 52_000, flowCents: 52_000, exact: true });
    // the empty stretch compounds as flat (factor 1), never NaN/Infinity
    expect(rs.every((r) => Number.isFinite(r.factor))).toBe(true);
  });

  test("a round trip before prices + an in-window re-entry starts AT the re-entry — no fabricated flat-zero head", () => {
    // bought and fully sold in 2024 (before any cached close), re-bought 2026-01-10:
    // the series must not open at the first close with days of zero NAV the user
    // never held — that head would also rebase the benchmark unfairly early
    const days = holdingReturnDays(
      [tr("2024-01-05", 10), tr("2024-06-01", -10), tr("2026-01-10", 4)],
      [cl("2026-01-01", 100), cl("2026-01-05", 110), cl("2026-01-10", 120), cl("2026-01-15", 126)],
    );
    expect(days[0]).toEqual({ day: "2026-01-10", navCents: 48_000, flowCents: 48_000, exact: true });
    expect(days.at(-1)!.day).toBe("2026-01-15");
    // the return measures only the held window: 126/120 − 1 = 5%
    expect(totalReturn(days).twrPct).toBeCloseTo(5, 6);
  });

  test("held entering the price window with a later in-window buy: starts at the first close", () => {
    const days = holdingReturnDays(
      [tr("2024-01-01", 10), tr("2026-01-03", 5)],
      [cl("2026-01-01", 100), cl("2026-01-04", 104)],
    );
    expect(days[0]).toEqual({ day: "2026-01-01", navCents: 100_000, flowCents: 100_000, exact: true });
    expect(days[2]).toEqual({ day: "2026-01-03", navCents: 150_000, flowCents: 50_000, exact: true });
    expect(days.at(-1)!.navCents).toBe(156_000);
  });

  test("an over-sold opening (data anomaly) waits for the first day the position is actually held", () => {
    const days = holdingReturnDays(
      [tr("2024-01-01", -5), tr("2026-01-03", 10)],
      [cl("2026-01-01", 100), cl("2026-01-04", 104)],
    );
    // starts on the buy day; the stale −5 nets against it (5 held)
    expect(days[0]).toEqual({ day: "2026-01-03", navCents: 50_000, flowCents: 50_000, exact: true });
  });

  test("everything sold before prices begin → empty (never fabricate a series)", () => {
    const days = holdingReturnDays(
      [tr("2024-01-01", 10), tr("2024-02-01", -10)],
      [cl("2026-01-01", 100)],
    );
    expect(days).toEqual([]);
  });

  test("multiple trades on one day net into a single flow", () => {
    const days = holdingReturnDays(
      [tr("2026-01-02", 5), tr("2026-01-02", -2), tr("2026-01-01", 10)],
      [cl("2026-01-01", 100), cl("2026-01-02", 110)],
    );
    // 10 → 13 shares: flow = value(13) − value(10) at $110 = $330
    expect(days[1]).toEqual({ day: "2026-01-02", navCents: 143_000, flowCents: 33_000, exact: true });
  });

  test("a trade after the last close is valued at the carried close", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 10), tr("2026-01-04", 2)],
      [cl("2026-01-01", 100), cl("2026-01-02", 110)],
    );
    expect(days.map((d) => d.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    expect(days.at(-1)).toEqual({ day: "2026-01-04", navCents: 132_000, flowCents: 22_000, exact: true });
    expect(dailyReturns(days).at(-1)!.returnCents).toBe(0); // the buy is not a gain
  });

  test("an over-sell (data anomaly) floors the NAV at zero instead of going negative", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 10), tr("2026-01-02", -12)],
      [cl("2026-01-01", 100), cl("2026-01-02", 100)],
    );
    expect(days.at(-1)!.navCents).toBe(0);
    expect(totalReturn(days).gainCents).toBe(0); // flat price → no gain, no phantom loss
  });

  test("the cumulative line reconciles exactly to the total return", () => {
    const days = holdingReturnDays(
      [tr("2026-01-01", 3), tr("2026-01-03", 1.5), tr("2026-01-06", -2), tr("2026-01-08", 0.25)],
      [
        cl("2026-01-01", 97.31),
        cl("2026-01-02", 99.02),
        cl("2026-01-03", 95.55),
        cl("2026-01-06", 101.4),
        cl("2026-01-07", 103.02),
        cl("2026-01-08", 102.11),
      ],
    );
    const line = cumulativeReturns(days);
    const total = totalReturn(days);
    expect(line.at(-1)!.cumGainCents).toBe(total.gainCents);
    expect(line.at(-1)!.cumTwrPct).toBeCloseTo(total.twrPct, 10);
    // and the TWR telescopes to the stitched price return (held throughout) —
    // exactly in real arithmetic; integer-cent NAV rounding on these small
    // fractional quantities drifts it by ~0.001pp, so assert to 2 decimals
    expect(total.twrPct).toBeCloseTo((102.11 / 97.31 - 1) * 100, 2);
  });

  test("input order does not matter (defensive sort, immutably)", () => {
    const trades = [tr("2026-01-02", 5), tr("2026-01-01", 10)];
    const closes = [cl("2026-01-02", 110), cl("2026-01-01", 100)];
    const tradesCopy = trades.map((t) => ({ ...t }));
    const closesCopy = closes.map((c) => ({ ...c }));
    const days = holdingReturnDays(trades, closes);
    expect(days[0]!.day).toBe("2026-01-01");
    expect(trades).toEqual(tradesCopy); // inputs untouched
    expect(closes).toEqual(closesCopy);
  });
});
