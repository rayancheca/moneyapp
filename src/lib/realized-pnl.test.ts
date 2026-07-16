import { describe, expect, test } from "vitest";
import { realizedPnl, sumRealized, type ValuedTrade } from "./realized-pnl";

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
