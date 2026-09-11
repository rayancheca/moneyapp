import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CategoryMonthPoint } from "@/services/category-detail";
import { MonthlyTrendBars, trendScaleCents } from "./MonthlyTrendBars";

function months(values: readonly number[]): CategoryMonthPoint[] {
  return values.map((cents, i) => ({
    month: `2026-${String(i + 1).padStart(2, "0")}`,
    spentCents: cents,
    txnCount: cents === 0 ? 0 : 1,
    href: "/transactions",
    reached: true,
  }));
}

describe("trendScaleCents", () => {
  test("an ordinary spending run scales to its biggest month", () => {
    expect(trendScaleCents(months([100_00, 250_00, 40_00]))).toBe(250_00);
  });

  /*
   * ⛔ THE WHOLE POINT. `Math.max(m, p.spentCents)` seeded at 0 cannot tell a
   * series that is entirely NEGATIVE from one that is entirely zero, and the
   * component printed "No spending in the last 12 months." for both.
   *
   * Measured 2026-09-04 on `/categories/<Pass-through>?period=2026-08`: that
   * sentence sat directly above two rows dated 08-11 and 08-12 inside the same
   * window, +$4,000.00 and +$1,000.00.
   */
  test("a series that is all money IN has a scale, not an absence", () => {
    expect(trendScaleCents(months([-1_000_00, -4_000_00]))).toBe(4_000_00);
  });

  test("a mixed month keeps the largest magnitude on either side", () => {
    expect(trendScaleCents(months([-3_510_70, 5_00]))).toBe(3_510_70);
  });

  test("only a genuinely empty run has no scale", () => {
    expect(trendScaleCents(months([0, 0, 0]))).toBe(0);
    expect(trendScaleCents([])).toBe(0);
  });
});

describe("MonthlyTrendBars", () => {
  test("claims absence only when every month really is zero", () => {
    /*
     * ⛔ …AND ONLY OVER THE MONTHS IT WAS HANDED. This assertion used to pin
     * "No activity in the last 12 months" over a TWO-point series, because the
     * sentence hard-coded the 12 — a second, quieter version of the same
     * over-reach the branch below is about.
     */
    expect(renderToStaticMarkup(createElement(MonthlyTrendBars, { points: months([0, 0]) }))).toContain(
      "No activity in the last 2 months",
    );
  });

  /**
   * 🔴 A MONTH NOBODY HAS IMPORTED HAS NO ZERO TO REPORT. The bars have refused
   * to state one since they shipped — a point past the frontier reads "not
   * imported yet" — and the sentence that replaces all twelve of them asserted
   * a measurement about the whole year anyway. On 2026-09-11 that sentence sat
   * two cards above the same page's "September 2026 has not been imported yet
   * … a window nobody has looked at, not one in which nothing happened", on
   * /categories/<Hotels>, <Water/Gas> and <Interest Charges>.
   */
  test("an unread month is discounted, not asserted over", () => {
    const points = months([0, 0, 0]);
    points[2]!.reached = false;
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points }));
    expect(html).toContain("No activity in the 2 months the ledger covers");
    expect(html).toContain("The newest 1 month has not been imported");
    expect(html).not.toContain("No activity in the last 3 months");
  });

  test("draws a bar for money that came IN rather than calling it nothing", () => {
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points: months([-4_000_00]) }));
    expect(html).not.toContain("No activity");
    expect(html).toContain("$4,000.00");
  });

  /*
   * 🔴 The accessible name was hard-coded to "Monthly spending" on every
   * category page, including ones whose own header calls the figure "Received"
   * or "Net" — a screen reader was told the Salary chart was spending.
   */
  test("the chart is named by what the page calls the figure", () => {
    const html = renderToStaticMarkup(
      createElement(MonthlyTrendBars, { points: months([100_00]), flowLabel: "Received" }),
    );
    expect(html).toContain('aria-label="Monthly money received, last 12 months"');
  });

  test("and defaults to spending, which is what most categories are", () => {
    expect(renderToStaticMarkup(createElement(MonthlyTrendBars, { points: months([100_00]) }))).toContain(
      'aria-label="Monthly spending, last 12 months"',
    );
  });
});

describe("a month nobody has imported has no zero to report", () => {
  /*
   * 🔴 "Sep 2026: $0.00, 0 transactions" read out on all 76 category pages,
   * three cards above the same page's "September 2026 has not been imported
   * yet … a window nobody has looked at, not one in which nothing happened."
   * Measured 2026-09-10.
   */
  const mixed: CategoryMonthPoint[] = [
    { month: "2026-08", spentCents: 5_000, txnCount: 2, href: "/transactions", reached: true },
    { month: "2026-09", spentCents: 0, txnCount: 0, href: "/transactions", reached: false },
  ];

  test("an unreached month says so instead of naming a measured zero", () => {
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points: mixed }));
    expect(html).toContain("Sep 2026: not imported yet");
    expect(html).not.toContain("Sep 2026: $0.00, 0 transactions");
  });

  test("a reached month still reports its figures, zero included", () => {
    const zeroButReached: CategoryMonthPoint[] = [
      { month: "2026-07", spentCents: 5_000, txnCount: 2, href: "/transactions", reached: true },
      { month: "2026-08", spentCents: 0, txnCount: 0, href: "/transactions", reached: true },
    ];
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points: zeroButReached }));
    // a month the ledger walked through and found empty IS a measurement
    expect(html).toContain("Aug 2026: $0.00, 0 transactions");
  });
});
