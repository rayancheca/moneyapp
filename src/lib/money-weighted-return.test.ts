import { describe, expect, test } from "vitest";
import {
  moneyWeightedReturn,
  type MoneyWeightedInput,
  type ReturnBoundary,
} from "./money-weighted-return";

/**
 * The real 2026 window, measured 2026-08-25: the portfolio opens complete at
 * $65,038.62 on 2025-12-31 and closes complete at $106,458.62 on 2026-08-25,
 * with 41 Investment Contribution rows netting to almost nothing across it.
 *
 * And the real 2025 window, which must be REFUSED: it opens on 2024-12-31, a
 * day when only one of two investment accounts could be valued — $21.70 of
 * visible portfolio. A return computed from that describes missing data, not
 * money.
 */
const complete = (day: string, valueCents: number): ReturnBoundary => ({
  day,
  valueCents,
  complete: true,
  coveredAccounts: 2,
  totalAccounts: 2,
});

const REAL_2026: MoneyWeightedInput = {
  open: complete("2025-12-31", 6503862),
  close: complete("2026-08-25", 10645862),
  flows: [
    { day: "2026-02-10", amountCents: -500000 },
    { day: "2026-05-20", amountCents: 500872 },
  ],
  windowEnd: "2026-12-31",
};

describe("moneyWeightedReturn — the real window", () => {
  test("computes an annual rate and names the period behind it", () => {
    const r = moneyWeightedReturn(REAL_2026);
    expect(r.computed).toBe(true);
    if (!r.computed) return;
    expect(r.fromDay).toBe("2025-12-31");
    expect(r.throughDay).toBe("2026-08-25");
    expect(r.openCents).toBe(6503862);
    expect(r.closeCents).toBe(10645862);
    // the boundary valuations are flows too, and are counted as such
    expect(r.flowCount).toBe(4);
    expect(r.rate).toBeGreaterThan(0.5);
  });

  test("a window that has not finished is flagged partial", () => {
    const r = moneyWeightedReturn(REAL_2026);
    expect(r.computed && r.partial).toBe(true);
  });

  test("a window that reaches its end is not", () => {
    const r = moneyWeightedReturn({ ...REAL_2026, windowEnd: "2026-08-25" });
    expect(r.computed && r.partial).toBe(false);
  });

  test("a zero-amount flow is dropped rather than fed to the solver", () => {
    const withZero = moneyWeightedReturn({
      ...REAL_2026,
      flows: [...REAL_2026.flows, { day: "2026-03-01", amountCents: 0 }],
    });
    const without = moneyWeightedReturn(REAL_2026);
    expect(withZero.computed && without.computed && withZero.flowCount).toBe(
      without.computed ? without.flowCount : -1,
    );
  });
});

/**
 * The refusals. These are the reason this module is pure and gated at 100%: a
 * mutation that deleted the incomplete-opening guard SURVIVED the service's own
 * tests, because reaching that branch through the database needs a seeded
 * portfolio with prices and holdings — so in practice it was never reached.
 */
describe("moneyWeightedReturn — what it refuses to state", () => {
  test("an incomplete OPENING is refused, and the coverage is named", () => {
    const r = moneyWeightedReturn({
      ...REAL_2026,
      open: { day: "2024-12-31", valueCents: 2170, complete: false, coveredAccounts: 1, totalAccounts: 2 },
    });
    expect(r.computed).toBe(false);
    if (r.computed) return;
    expect(r.reason).toContain("2024-12-31");
    expect(r.reason).toContain("1 of 2");
    expect(r.reason).toMatch(/meaningless/);
  });

  test("an incomplete CLOSE is refused too", () => {
    const r = moneyWeightedReturn({
      ...REAL_2026,
      close: { day: "2026-08-25", valueCents: 10645862, complete: false, coveredAccounts: 1, totalAccounts: 2 },
    });
    expect(r.computed).toBe(false);
    if (!r.computed) expect(r.reason).toContain("1 of 2");
  });

  test("a missing opening valuation is refused", () => {
    const r = moneyWeightedReturn({ ...REAL_2026, open: null });
    expect(r.computed).toBe(false);
    if (!r.computed) expect(r.reason).toMatch(/no valuation to open/);
  });

  test("a missing closing valuation is refused", () => {
    const r = moneyWeightedReturn({ ...REAL_2026, close: null });
    expect(r.computed).toBe(false);
    if (!r.computed) expect(r.reason).toMatch(/no valuation to close/);
  });

  /**
   * A first year of investing opens at zero. Every cent of the close is then a
   * contribution or a gain on one, and the rate depends entirely on which day
   * the money arrived — which is a fact about timing, not about performance.
   */
  test("an opening of nothing is refused rather than reported as infinite growth", () => {
    const r = moneyWeightedReturn({ ...REAL_2026, open: complete("2025-12-31", 0) });
    expect(r.computed).toBe(false);
    if (!r.computed) expect(r.reason).toMatch(/worth nothing/);
  });

  test("a negative opening is refused on the same ground", () => {
    const r = moneyWeightedReturn({ ...REAL_2026, open: complete("2025-12-31", -100) });
    expect(r.computed).toBe(false);
  });

  test("flows with no sign change are refused rather than forced to a root", () => {
    // money only ever going in, and a close of nothing: no rate solves this
    const r = moneyWeightedReturn({
      open: complete("2026-01-01", 100000),
      close: complete("2026-12-31", 0),
      flows: [{ day: "2026-06-01", amountCents: -50000 }],
      windowEnd: "2026-12-31",
    });
    expect(r.computed).toBe(false);
    if (!r.computed) expect(r.reason).toMatch(/single rate of return/);
  });
});

describe("moneyWeightedReturn — the rate is directionally right", () => {
  test("a portfolio that doubled in a year reports about 100%", () => {
    const r = moneyWeightedReturn({
      open: complete("2025-01-01", 1000000),
      close: complete("2026-01-01", 2000000),
      flows: [],
      windowEnd: "2026-01-01",
    });
    expect(r.computed).toBe(true);
    if (r.computed) expect(r.rate).toBeCloseTo(1.0, 1);
  });

  test("a portfolio that halved reports a loss", () => {
    const r = moneyWeightedReturn({
      open: complete("2025-01-01", 2000000),
      close: complete("2026-01-01", 1000000),
      flows: [],
      windowEnd: "2026-01-01",
    });
    expect(r.computed).toBe(true);
    if (r.computed) expect(r.rate).toBeLessThan(0);
  });

  test("growth funded entirely by contributions is not reported as a return", () => {
    // opens at $10k, $10k paid in, closes at $20k — the portfolio EARNED nothing
    const r = moneyWeightedReturn({
      open: complete("2025-01-01", 1000000),
      close: complete("2026-01-01", 2000000),
      flows: [{ day: "2025-01-02", amountCents: -1000000 }],
      windowEnd: "2026-01-01",
    });
    expect(r.computed).toBe(true);
    if (r.computed) expect(r.rate).toBeCloseTo(0, 1);
  });
});
