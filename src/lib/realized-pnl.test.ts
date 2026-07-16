import { describe, expect, test } from "vitest";
import { realizedPnl, realizedSales, sumRealized, type ValuedTrade } from "./realized-pnl";

/** Terse builder: whole-unit qty, dollar close. */
function t(day: string, qty: number, close: number | null): ValuedTrade {
  return { day, qtyE8: Math.round(qty * 1e8), closeCents: close === null ? null : Math.round(close * 100) };
}

describe("realizedPnl", () => {
  test("no trades → zero, exact", () => {
    expect(realizedPnl([])).toEqual({
      realizedCents: 0,
      proceedsCents: 0,
      basisCents: 0,
      sellCount: 0,
      exact: true,
    });
  });

  test("buys alone realize nothing", () => {
    const r = realizedPnl([t("2026-01-01", 10, 100), t("2026-02-01", 5, 120)]);
    expect(r.realizedCents).toBe(0);
    expect(r.sellCount).toBe(0);
  });

  test("a sell realizes proceeds minus average cost", () => {
    // buy 10 @ $100, sell 4 @ $150 → realized 4 × ($150 − $100) = $200
    const r = realizedPnl([t("2026-01-01", 10, 100), t("2026-03-01", -4, 150)]);
    expect(r.realizedCents).toBe(200_00);
    expect(r.proceedsCents).toBe(600_00);
    expect(r.basisCents).toBe(400_00);
    expect(r.sellCount).toBe(1);
    expect(r.exact).toBe(true);
  });

  test("average cost blends multiple buys", () => {
    // 10 @ $100 + 10 @ $200 → avg $150; sell 5 @ $180 → realized 5 × $30 = $150
    const r = realizedPnl([
      t("2026-01-01", 10, 100),
      t("2026-02-01", 10, 200),
      t("2026-03-01", -5, 180),
    ]);
    expect(r.realizedCents).toBe(150_00);
  });

  test("a losing sell realizes a negative figure", () => {
    const r = realizedPnl([t("2026-01-01", 10, 100), t("2026-02-01", -10, 80)]);
    expect(r.realizedCents).toBe(-200_00);
  });

  test("the remaining basis carries correctly across successive sells", () => {
    // 10 @ $100; sell 5 @ $200 (realize $500); sell 5 @ $50 (realize −$250)
    const r = realizedPnl([
      t("2026-01-01", 10, 100),
      t("2026-02-01", -5, 200),
      t("2026-03-01", -5, 50),
    ]);
    expect(r.realizedCents).toBe(500_00 - 250_00);
    expect(r.sellCount).toBe(2);
  });

  test("selling more than held is clamped (import gap), empty-book sells are no-ops", () => {
    const clamped = realizedPnl([t("2026-01-01", 2, 100), t("2026-02-01", -5, 150)]);
    expect(clamped.realizedCents).toBe(100_00); // only the held 2 realize
    const empty = realizedPnl([t("2026-01-01", -3, 150)]);
    expect(empty.realizedCents).toBe(0);
    expect(empty.sellCount).toBe(0);
  });

  test("an unpriced trade is skipped and flags the figure inexact", () => {
    const r = realizedPnl([t("2026-01-01", 10, 100), t("2026-02-01", -4, null)]);
    expect(r.exact).toBe(false);
    expect(r.sellCount).toBe(0);
  });

  test("zero-quantity rows are ignored (reconciliation no-ops)", () => {
    const r = realizedPnl([t("2026-01-01", 10, 100), t("2026-02-01", 0, 120), t("2026-03-01", -1, 120)]);
    expect(r.realizedCents).toBe(20_00);
  });
});

describe("sumRealized", () => {
  test("sums parts and ANDs exactness", () => {
    const a = realizedPnl([t("2026-01-01", 10, 100), t("2026-02-01", -4, 150)]);
    const b = realizedPnl([t("2026-01-01", 10, 100), t("2026-02-01", -4, null)]);
    const sum = sumRealized([a, b]);
    expect(sum.realizedCents).toBe(a.realizedCents);
    expect(sum.sellCount).toBe(1);
    expect(sum.exact).toBe(false);
  });

  test("empty → zero, exact", () => {
    expect(sumRealized([]).exact).toBe(true);
  });
});

describe("realizedSales", () => {
  test("buys alone emit no sale rows", () => {
    expect(realizedSales([t("2026-01-01", 10, 100)])).toEqual([]);
  });

  test("a sell emits one row: day, qty, proceeds, avg-cost basis, gain", () => {
    const sales = realizedSales([t("2026-01-01", 10, 100), t("2026-03-01", -4, 150)]);
    expect(sales).toEqual([
      {
        day: "2026-03-01",
        qtyE8: 4e8,
        proceedsCents: 600_00,
        basisCents: 400_00,
        gainCents: 200_00,
        exact: true,
        clamped: false,
      },
    ]);
  });

  test("successive sells re-blend the remaining basis", () => {
    // 10 @ $100 + 10 @ $200 → avg $150; sell 5 @ $180 (+$150); avg stays $150;
    // sell 5 @ $120 (−$150)
    const sales = realizedSales([
      t("2026-01-01", 10, 100),
      t("2026-02-01", 10, 200),
      t("2026-03-01", -5, 180),
      t("2026-04-01", -5, 120),
    ]);
    expect(sales.map((s) => s.gainCents)).toEqual([150_00, -150_00]);
    expect(sales.map((s) => s.basisCents)).toEqual([750_00, 750_00]);
  });

  test("an over-sell is clamped to the held quantity and flagged", () => {
    const sales = realizedSales([t("2026-01-01", 10, 100), t("2026-02-01", -12, 110)]);
    expect(sales).toHaveLength(1);
    expect(sales[0]!.qtyE8).toBe(10e8);
    expect(sales[0]!.clamped).toBe(true);
    expect(sales[0]!.gainCents).toBe(100_00); // 10 × $10
  });

  test("a sell from an empty book emits nothing AND flags the book inexact", () => {
    // the sell proves buy history is missing (an import gap) — the realized
    // figures are partial, never silently "exact"
    expect(realizedSales([t("2026-01-01", -5, 100)])).toEqual([]);
    const totals = realizedPnl([t("2026-01-01", -5, 100)]);
    expect(totals.sellCount).toBe(0);
    expect(totals.exact).toBe(false);
  });

  test("fractional-cent closes round the PRODUCT once, matching the NAV convention", () => {
    // closeCents may carry fractional cents (close × 100 unrounded); the walk
    // must round qty × close once — never the per-unit price first
    const sales = realizedSales([
      { day: "2026-01-01", qtyE8: 10e8, closeCents: 100.456 },
      { day: "2026-02-01", qtyE8: -10e8, closeCents: 110.454 },
    ]);
    expect(sales[0]!.basisCents).toBe(1_005); // round(10 × 100.456) not 10 × 100
    expect(sales[0]!.proceedsCents).toBe(1_105); // round(10 × 110.454) not 10 × 110
  });

  test("an unpriced trade before a sale marks that sale approximate", () => {
    const sales = realizedSales([
      t("2026-01-01", 10, 100),
      t("2026-01-15", 5, null), // unpriced buy — basis is partial from here on
      t("2026-02-01", -4, 150),
    ]);
    expect(sales[0]!.exact).toBe(false);
  });

  test("an unpriced SALE is skipped entirely (never a fabricated row)", () => {
    const sales = realizedSales([t("2026-01-01", 10, 100), t("2026-02-01", -4, null)]);
    expect(sales).toEqual([]);
  });

  test("realizedPnl totals are exactly the sum of the sale rows", () => {
    const trades = [
      t("2026-01-01", 10, 100),
      t("2026-01-20", 6, 130),
      t("2026-02-01", -5, 150),
      t("2026-03-01", -8, 90),
    ];
    const sales = realizedSales(trades);
    const totals = realizedPnl(trades);
    expect(totals.realizedCents).toBe(sales.reduce((s, x) => s + x.gainCents, 0));
    expect(totals.proceedsCents).toBe(sales.reduce((s, x) => s + x.proceedsCents, 0));
    expect(totals.basisCents).toBe(sales.reduce((s, x) => s + x.basisCents, 0));
    expect(totals.sellCount).toBe(sales.length);
  });
});
