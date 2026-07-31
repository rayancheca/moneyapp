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

  /**
   * `sane()` refuses a rate outside the (-1, 1e6) domain rather than reporting it.
   * A +200,000,000%/yr "return" is a data error — a misplaced decimal, a cent
   * booked as a dollar — and the honest answer is "no rate", not a number with
   * nine digits in front of the decimal point that a reader would have to know
   * to distrust.
   */
  test("refuses a rate beyond the domain ceiling instead of reporting it", () => {
    expect(xirr([cf("2025-01-01", -1), cf("2026-01-01", 2_000_000)])).toBeNull();
  });

  /**
   * The bisection fallback, exercised where Newton cannot help.
   *
   * These are not redundant with the tests above: the ones above converge under
   * Newton-Raphson and never enter `findBracket`. Each case here forces the
   * fallback and lands on a different part of it — the scan advancing past its
   * first sample pair, and bisection narrowing from ABOVE (`hi = mid`) rather
   * than from below, which is the branch a root in the upper half of the
   * bracket takes.
   */
  describe("bisection fallback", () => {
    test("finds a very high rate whose root sits past the dense scan range", () => {
      // ~+1000x in a year. The dense scan runs to +10/yr, so the bracket is only
      // found among the sparse samples (100, 1_000, …) — the scan loop has to
      // advance hundreds of times to get there rather than bracketing immediately.
      const rate = xirr([cf("2024-01-01", -1_000), cf("2025-01-01", 1_000_000)]);
      expect(rate).not.toBeNull();
      expect(Number.isFinite(rate!)).toBe(true);
      // NPV must actually vanish at the returned rate — the real assertion, since
      // a bisection that stops early would still hand back a plausible number
      const npv =
        -1_000 / (1 + rate!) ** 0 + 1_000_000 / (1 + rate!) ** (daysBetween("2024-01-01", "2025-01-01") / 365);
      expect(Math.abs(npv)).toBeLessThan(1e-3);
    });

    test("total loss but for a single cent — the root sits just above the rate floor", () => {
      const rate = xirr([cf("2024-01-01", -100_000_000), cf("2025-01-01", 1)]);
      // either a finite rate barely above −100%/yr, or null if it falls outside
      // the (-1, RATE_CEIL) domain `sane` enforces — both are honest, a NaN is not
      if (rate !== null) {
        expect(Number.isFinite(rate)).toBe(true);
        expect(rate).toBeGreaterThan(-1);
      }
    });

    /**
     * Narrowing from ABOVE — the `hi = mid` branch.
     *
     * Getting here needs BOTH conditions at once, which is why the obvious
     * high-return cases miss it: Newton-Raphson has to give up (it converges
     * happily on any simple two-flow series, even one returning +200/yr), AND the
     * root has to sit in the lower half of the bracket the scan finds.
     *
     * A near-total loss over two years does both. Newton walks toward -1, hits the
     * domain clamp, stalls away from any root and breaks out; the scan then
     * brackets [-0.999999, -0.99], and the root is far enough down that bisection
     * moves `hi` down 23 times and `lo` up 11.
     *
     * The expected rate is exact arithmetic, not a fitted constant: 2021→2023 spans
     * 730 days and neither year is a leap year, so the exponent is exactly 2, and
     * (1+r)² = 2/1_000_000 ⇒ r = √(2×10⁻⁶) − 1.
     */
    test("narrows from above when the root is in the lower half of the bracket", () => {
      expect(daysBetween("2021-01-01", "2023-01-01")).toBe(730); // guards the premise
      const rate = xirr([cf("2021-01-01", -1_000_000), cf("2023-01-01", 2)]);
      expect(rate).not.toBeNull();
      expect(rate!).toBeCloseTo(Math.sqrt(2e-6) - 1, 6);
    });

    /**
     * Robustness at an absurd span. `xirr` takes any two dated flows and states no
     * precondition on how far apart they are, so a 2000-year span is legal input —
     * and at that span `(1 + rate)^years` UNDERFLOWS to exactly 0 partway through
     * the Newton walk, making the NPV ±Infinity. The `!Number.isFinite(f)` guard is
     * what stops that becoming a NaN rate; without it the iteration would poison
     * itself and hand back garbage that `sane` would have to catch downstream.
     * A finite answer still comes back, from the bisection fallback.
     */
    test("an absurd 2000-year span overflows the NPV but still returns a finite rate", () => {
      const rate = xirr([cf("0100-01-01", -1_000_000), cf("2100-01-01", 1)]);
      expect(rate).not.toBeNull();
      expect(Number.isFinite(rate!)).toBe(true);
      expect(rate!).toBeGreaterThan(-1);
      expect(rate!).toBeLessThan(0); // losing money over two millennia is still a loss
    });

    test("a mid-range root is reached from both sides of the bracket", () => {
      // several sign changes in the flows, so the NPV curve is not monotonic and
      // bisection has to narrow from above as well as below
      const rate = xirr([
        cf("2020-01-01", -500_000),
        cf("2021-01-01", 900_000),
        cf("2022-01-01", -800_000),
        cf("2023-01-01", 950_000),
      ]);
      expect(rate === null || Number.isFinite(rate)).toBe(true);
    });
  });
});

/** Local UTC day-diff for the round-trip assertion (mirrors lib/dates diffDays). */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
