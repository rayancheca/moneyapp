import { describe, expect, test } from "vitest";
import { xirr, type CashFlow } from "./xirr";

const cf = (day: string, amountCents: number): CashFlow => ({ day, amountCents });

describe("xirr", () => {
  test("a 10% one-year return solves to ~0.10", () => {
    // invest $1,000, get $1,100 back exactly 365 days later (2023 is non-leap)
    const rate = xirr([cf("2023-01-01", -100_000), cf("2024-01-01", 110_000)]);
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.1, 4);
  });

  test("a one-year loss solves to a negative rate", () => {
    const rate = xirr([cf("2023-01-01", -100_000), cf("2024-01-01", 90_000)]);
    expect(rate!).toBeCloseTo(-0.1, 4);
  });

  test("annualizes a multi-year flow (2 years, +10% total → ~4.88%/yr)", () => {
    // 2022-01-01 → 2024-01-01 = 730 days = exactly 2 years
    const rate = xirr([cf("2022-01-01", -100_000), cf("2024-01-01", 110_000)]);
    // (1+r)^2 ≈ 1.10 → r ≈ 0.0488
    expect(rate!).toBeCloseTo(0.0488, 3);
  });

  test("handles an intermediate contribution (money-weighted)", () => {
    // -$1,000 at start, another -$1,000 mid-year, +$2,200 at year end
    const rate = xirr([
      cf("2024-01-01", -100_000),
      cf("2024-07-01", -100_000),
      cf("2024-12-31", 220_000),
    ]);
    expect(rate).not.toBeNull();
    // sanity: the money-weighted return is positive and well under 20%
    expect(rate!).toBeGreaterThan(0.05);
    expect(rate!).toBeLessThan(0.2);
    // and NPV at the solved rate is ~0 (round-trip check)
  });

  test("NPV at the solved rate is approximately zero (round-trip)", () => {
    const flows = [cf("2024-01-01", -250_000), cf("2024-05-01", 30_000), cf("2025-01-01", 260_000)];
    const rate = xirr(flows)!;
    const t0 = flows[0]!.day;
    const npv = flows.reduce((sum, f) => {
      const years = daysBetween(t0, f.day) / 365;
      return sum + f.amountCents / (1 + rate) ** years;
    }, 0);
    expect(Math.abs(npv)).toBeLessThan(1); // within a cent of zero
  });

  test("returns null when there are fewer than two flows", () => {
    expect(xirr([])).toBeNull();
    expect(xirr([cf("2024-01-01", -100_000)])).toBeNull();
  });

  test("returns null when all flows share a sign (no root exists)", () => {
    expect(xirr([cf("2024-01-01", -100_000), cf("2025-01-01", -50_000)])).toBeNull();
    expect(xirr([cf("2024-01-01", 100_000), cf("2025-01-01", 50_000)])).toBeNull();
  });

  test("returns null for degenerate all-zero flows", () => {
    expect(xirr([cf("2024-01-01", 0), cf("2025-01-01", 0)])).toBeNull();
  });

  test("returns null when all flows fall on the same day (no time dimension)", () => {
    // two same-day, opposite flows → NPV is 0 for EVERY rate; no rate is defined
    // (a brand-new position bought & viewed today must read "—", not a made-up %)
    expect(xirr([cf("2024-01-01", -100_000), cf("2024-01-01", 100_000)])).toBeNull();
    expect(xirr([cf("2024-01-01", -100_000), cf("2024-01-01", 50_000), cf("2024-01-01", 60_000)])).toBeNull();
  });

  test("is order-independent (flows sorted internally by date)", () => {
    const a = xirr([cf("2025-01-01", 110_000), cf("2024-01-01", -100_000)]);
    const b = xirr([cf("2024-01-01", -100_000), cf("2025-01-01", 110_000)]);
    expect(a!).toBeCloseTo(b!, 8);
  });

  test("survives an extreme loss without throwing or returning NaN/Infinity", () => {
    const rate = xirr([cf("2023-01-01", -100_000), cf("2024-01-01", 1_000)]);
    // −99% over a year — a finite, very negative rate
    expect(rate).not.toBeNull();
    expect(Number.isFinite(rate!)).toBe(true);
    expect(rate!).toBeLessThan(-0.9);
  });
});

/** Local UTC day-diff for the round-trip assertion (mirrors lib/dates diffDays). */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
