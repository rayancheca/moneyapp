import { describe, expect, test } from "vitest";
import { RUNWAY_STATED_MONTHS_MAX, runway, type RunwayInput } from "./runway";

/**
 * The real position, measured on the live ledger 2026-08-24 before this module
 * existed:
 *
 *   liquid        $3,121.59   Chase $3,007.60 + RH Cash $113.88 + SoFi $0.11
 *   cards owed      $925.61   Discover $557.62 + Venture X $367.99
 *   net cash      $2,195.98
 *   investments $107,126.39   Robinhood Brokerage $70,291.75 + Crypto $36,834.64
 *   income rate   $4,537.00   incomeExpectation().basis, levelled
 *   spend         $8,025.92   monthlySpending, mean of the 6 complete months
 *                             2026-02..2026-07 — the only figure here that is
 *                             a measurement of behaviour rather than a rate
 *
 *   net burn      $3,488.92/month
 *   net-cash runway    0.629 months → 19 days
 *   with investments  31.3  months → past the stated horizon
 *
 * Card debt is netted off the cash base and shown as its own subtraction. It is
 * spending from months already past that has not settled, so no other term
 * carries it — and at this scale it is eight days of a twenty-seven-day answer.
 *
 * ⛔ The two decisions behind this shape were the owner's, taken 2026-08-24:
 * BOTH cash bases are published (liquid headline, portfolio as a second line),
 * and the outflow is TRUE TOTAL SPEND rather than the committed book. Committed
 * outflows alone are $3,211.04/month against $4,537.00 of income, so a runway
 * built on them divides by a negative burn and reports that he never runs out —
 * which stops being true the first time he buys food.
 */
const REAL: RunwayInput = {
  liquidCents: 312159,
  cardDebtCents: 92561,
  investableCents: 10712639,
  monthlyIncomeCents: 453700,
  monthlySpendCents: 802592,
};

describe("runway — the real position", () => {
  test("burns the measured difference between spending and the income rate", () => {
    expect(runway(REAL)).toMatchObject({ kind: "burning", netBurnCents: 348892 });
  });

  test("the headline horizon spends down NET cash — cards already subtracted", () => {
    const r = runway(REAL);
    expect(r.netCashCents).toBe(219598);
    expect(r.liquid.cents).toBe(219598);
    expect(r.liquid.months).toBeCloseTo(0.6294, 4);
    expect(r.liquid.label).toBe("19 days");
    expect(r.liquid.isBeyondHorizon).toBe(false);
  });

  test("cards shorten the runway rather than being ignored", () => {
    const ignored = runway({ ...REAL, cardDebtCents: 0 });
    expect(ignored.liquid.label).toBe("27 days");
    expect(runway(REAL).liquid.months).toBeLessThan(ignored.liquid.months ?? 0);
  });

  test("owing more than the cash on hand is no cash left, not negative runway", () => {
    const r = runway({ ...REAL, cardDebtCents: 500000 });
    expect(r.netCashCents).toBeLessThan(0);
    expect(r.liquid).toMatchObject({ months: 0, label: "none left" });
    expect(r.headline).toBe("No cash left");
  });

  test("the second horizon adds the portfolio, and refuses to date it precisely", () => {
    const { withInvestments } = runway(REAL);
    expect(withInvestments.cents).toBe(219598 + 10712639);
    expect(withInvestments.months).toBeCloseTo(31.3, 1);
    // 31.6 months is arithmetic, not a forecast: it extrapolates a six-month
    // spend average and a levelled rate two and a half years out. Publishing
    // "31.6 months" would claim a precision neither input carries.
    expect(withInvestments.label).toBe("more than 2 years");
    expect(withInvestments.isBeyondHorizon).toBe(true);
  });

  test("headline and explanation come from the same branch as the figure", () => {
    const r = runway(REAL);
    expect(r.headline).toBe("19 days of cash");
    expect(r.explanation).toMatch(/spend more than you earn/i);
  });

  test("lists exactly the four inputs it used, as its assumptions", () => {
    expect(runway(REAL).assumptions).toEqual([
      { id: "liquid", label: "Cash you can spend today", cents: 312159 },
      { id: "cards", label: "Less what you owe on cards", cents: 92561 },
      { id: "spend", label: "What you spend a month", cents: 802592 },
      { id: "income", label: "What you earn a month", cents: 453700 },
      { id: "investments", label: "What selling investments would add", cents: 10712639 },
    ]);
  });
});

/**
 * The failure mode the owner's second decision exists to avoid, kept as a test
 * so nobody re-specs it away: fed the COMMITTED book instead of true spend, the
 * same position reports that the money never runs out.
 */
describe("runway — income that covers spending", () => {
  const covered: RunwayInput = { ...REAL, monthlySpendCents: 321104 };

  test("does not divide by a negative burn", () => {
    const r = runway(covered);
    expect(r.kind).toBe("covered");
    expect(r.netBurnCents).toBe(321104 - 453700);
    expect(r.liquid.months).toBeNull();
    expect(r.withInvestments.months).toBeNull();
  });

  test("says so in words rather than printing an infinity", () => {
    const r = runway(covered);
    expect(r.liquid.label).toBe("not running down");
    expect(r.headline).toBe("Your income covers your spending");
    expect(r.explanation).toMatch(/earn more than you spend/i);
    expect(JSON.stringify(r)).not.toMatch(/Infinity|null months|NaN/);
  });

  test("breaking exactly even is covered, not a division by zero", () => {
    const r = runway({ ...REAL, monthlySpendCents: REAL.monthlyIncomeCents });
    expect(r.kind).toBe("covered");
    expect(r.netBurnCents).toBe(0);
    expect(r.liquid.months).toBeNull();
  });

  test("net refunds for a month are covered, not a negative runway", () => {
    const r = runway({ ...REAL, monthlySpendCents: -5000 });
    expect(r.kind).toBe("covered");
    expect(r.liquid.months).toBeNull();
  });
});

describe("runway — cash that has already run out", () => {
  test("an empty account is zero months, never a negative one", () => {
    const r = runway({ ...REAL, liquidCents: 0, cardDebtCents: 0 });
    expect(r.liquid).toMatchObject({ months: 0, label: "none left" });
  });

  test("an overdrawn account is zero months, never a negative one", () => {
    const r = runway({ ...REAL, liquidCents: -25000, cardDebtCents: 0 });
    expect(r.liquid).toMatchObject({ months: 0, label: "none left" });
    expect(r.headline).toBe("No cash left");
  });

  test("the portfolio still carries a horizon when the current account is empty", () => {
    const r = runway({ ...REAL, liquidCents: 0, cardDebtCents: 0 });
    expect(r.withInvestments.months).toBeGreaterThan(0);
    expect(r.withInvestments.label).toBe("more than 2 years");
  });
});

/**
 * How a duration is said. Precision is proportional to magnitude on purpose —
 * "0.9 months" is both awkward and falsely precise, and "31.6 months" claims a
 * forecast the inputs cannot support.
 */
describe("runway — how long is said", () => {
  const withBurn = (liquidCents: number): string =>
    runway({ ...REAL, liquidCents, cardDebtCents: 0 }).liquid.label;

  test("under a month is said in days", () => {
    expect(withBurn(345000)).toBe("30 days");
    expect(withBurn(116297)).toBe("10 days");
    expect(withBurn(11630)).toBe("1 day"); // singular, not "1 days"
  });

  test("the day/month boundary is exactly one month, and does not skip a value", () => {
    expect(withBurn(348891)).toBe("30 days"); // a cent under one month's burn
    expect(withBurn(348892)).toBe("1.0 months"); // exactly one month's burn
  });

  test("a sliver of cash is still said honestly", () => {
    expect(withBurn(1)).toBe("less than a day");
  });

  test("one to ten months keeps a decimal", () => {
    expect(withBurn(348892 * 2)).toBe("2.0 months");
    expect(withBurn(348892 * 2.5)).toBe("2.5 months");
    // 2.4499 months rounds DOWN — the decimal is real, not decorative
    expect(withBurn(Math.round(348892 * 2.45))).toBe("2.4 months");
  });

  test("ten months and beyond rounds to whole months", () => {
    expect(withBurn(348892 * 11)).toBe("11 months");
    expect(withBurn(348892 * 23)).toBe("23 months");
  });

  test("past the stated horizon it stops naming a number", () => {
    expect(withBurn(348892 * RUNWAY_STATED_MONTHS_MAX)).toBe("more than 2 years");
    expect(withBurn(348892 * 100)).toBe("more than 2 years");
  });

  test("the horizon cap is checkable, not magic", () => {
    expect(RUNWAY_STATED_MONTHS_MAX).toBe(24);
    const at = runway({ ...REAL, liquidCents: 348892 * 24, cardDebtCents: 0 });
    const under = runway({ ...REAL, liquidCents: 348892 * 23, cardDebtCents: 0 });
    expect(at.liquid.isBeyondHorizon).toBe(true);
    expect(under.liquid.isBeyondHorizon).toBe(false);
  });
});

describe("runway — the horizons cannot disagree", () => {
  test("adding investments never shortens the runway", () => {
    const r = runway(REAL);
    expect(r.withInvestments.cents).toBeGreaterThanOrEqual(r.liquid.cents);
    expect(r.withInvestments.months ?? 0).toBeGreaterThanOrEqual(r.liquid.months ?? 0);
  });

  test("with no portfolio the two horizons are the same number", () => {
    const r = runway({ ...REAL, investableCents: 0 });
    expect(r.withInvestments.months).toBe(r.liquid.months);
    expect(r.withInvestments.label).toBe(r.liquid.label);
  });

  test("a portfolio worth less than nothing cannot lengthen the runway", () => {
    // margin debt is representable; it must not be able to ADD runway
    const r = runway({ ...REAL, investableCents: -50000 });
    expect(r.withInvestments.cents).toBe(r.liquid.cents);
    expect(r.withInvestments.months).toBe(r.liquid.months);
  });
});
