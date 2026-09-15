import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CategoryMonthPoint } from "@/services/category-detail";
import { MonthlyTrendBars, trendScaleCents, trendWindowLabel } from "./MonthlyTrendBars";

function months(values: readonly number[]): CategoryMonthPoint[] {
  return values.map((cents, i) => ({
    month: `2026-${String(i + 1).padStart(2, "0")}`,
    spentCents: cents,
    txnCount: cents === 0 ? 0 : 1,
    href: "/transactions",
    unreached: null,
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
      "No activity in Jan 2026 to Feb 2026",
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
    points[2] = { ...points[2]!, unreached: "after-records" };
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points }));
    expect(html).toContain("No activity in the 2 months of Jan 2026 to Mar 2026 the ledger covers");
    expect(html).toContain("The other 1 month has not been imported");
    expect(html).not.toContain("the last");
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
    /*
     * ⛔ …AND IT SAID "last 12 months" OF A ONE-MONTH SERIES. The span was
     * hard-coded beside a noun that was not, so the half of the name that
     * described the DATA was fixed while the half describing the WINDOW went on
     * asserting a window it had never been given. It reads its own points now.
     */
    expect(html).toContain('aria-label="Monthly money received, Jan 2026"');
    expect(html).not.toContain("last 12 months");
  });

  test("and defaults to spending, which is what most categories are", () => {
    expect(renderToStaticMarkup(createElement(MonthlyTrendBars, { points: months([100_00]) }))).toContain(
      'aria-label="Monthly spending, Jan 2026"',
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
    { month: "2026-08", spentCents: 5_000, txnCount: 2, href: "/transactions", unreached: null },
    { month: "2026-09", spentCents: 0, txnCount: 0, href: "/transactions", unreached: "after-records" },
  ];

  test("an unreached month says so instead of naming a measured zero", () => {
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points: mixed }));
    expect(html).toContain("Sep 2026: not imported yet");
    expect(html).not.toContain("Sep 2026: $0.00, 0 transactions");
  });

  test("a reached month still reports its figures, zero included", () => {
    const zeroButReached: CategoryMonthPoint[] = [
      { month: "2026-07", spentCents: 5_000, txnCount: 2, href: "/transactions", unreached: null },
      { month: "2026-08", spentCents: 0, txnCount: 0, href: "/transactions", unreached: null },
    ];
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points: zeroButReached }));
    // a month the ledger walked through and found empty IS a measurement
    expect(html).toContain("Aug 2026: $0.00, 0 transactions");
  });

  /**
   * 🔴 THE OTHER END, IN THE WRONG WORDS. A month before the ledger opens was
   * read out as "not imported yet" — the words for a month past its newest row
   * — while /spending's heatmap and cash-flow table say "before your records
   * begin" of the same days. Measured on the owner's ledger 2026-09-15 (first
   * row 2022-08-25): `/categories/<Groceries>?period=2023-03` read "Apr 2022:
   * not imported yet" … "Jul 2022: not imported yet" beside "Aug 2022: $19.35,
   * 4 transactions"; 1,863 bars on 368 of 2,880 (category × month) pages.
   */
  test("a month before the records begin says so, in the words every other surface uses", () => {
    const opening: CategoryMonthPoint[] = [
      { month: "2022-07", spentCents: 0, txnCount: 0, href: "/transactions", unreached: "before-records" },
      { month: "2022-08", spentCents: 1_935, txnCount: 4, href: "/transactions", unreached: null },
    ];
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points: opening }));
    expect(html).toContain("Jul 2022: before your records begin");
    expect(html).not.toContain("Jul 2022: not imported yet");
    expect(html).toContain("Aug 2022: $19.35, 4 transactions");
  });

  test("a month that has not happened says that, not that nobody imported it", () => {
    const html = renderToStaticMarkup(
      createElement(MonthlyTrendBars, {
        points: [
          { month: "2026-09", spentCents: 5_000, txnCount: 2, href: "/transactions", unreached: null },
          { month: "2026-10", spentCents: 0, txnCount: 0, href: "/transactions", unreached: "future" },
        ],
      }),
    );
    expect(html).toContain("Oct 2026: has not happened yet");
  });

  /**
   * 🔴 …AND THE SENTENCE THAT REPLACES ALL TWELVE BARS said "The other 1 month
   * has not been imported" of July 2022 on `/categories/<Interest>?period=2023-06`.
   */
  test("the absence line names a pre-records month by its own cause too", () => {
    const window: CategoryMonthPoint[] = Array.from({ length: 12 }, (_, i) => {
      const month = i === 0 ? "2022-07" : i < 6 ? `2022-${String(i + 7).padStart(2, "0")}` : `2023-${String(i - 5).padStart(2, "0")}`;
      return { month, spentCents: 0, txnCount: 0, href: "/transactions", unreached: i === 0 ? "before-records" : null };
    });
    const html = renderToStaticMarkup(createElement(MonthlyTrendBars, { points: window }));
    expect(html).toContain(
      "No activity in the 11 months of Jul 2022 to Jun 2023 the ledger covers. The other 1 month is before your records begin",
    );
    expect(html).not.toContain("has not been imported");
  });
});

/**
 * 🔴 THE CARD IGNORED THE PAGE'S OWN PERIOD SELECTOR, and its accessible name
 * said "last 12 months" over whatever window it happened to hold. On
 * `/categories/<Groceries>?period=2023-11` — a page whose every other card read
 * "November 2023" — the bars ran Oct 2025 to Sep 2026 under a heading that said
 * nothing about which twelve months they were. Same on all 80 category pages
 * and every past period.
 */
describe("trendWindowLabel — the bars name the months they are drawn over", () => {
  const at = (month: string): CategoryMonthPoint => ({ month, spentCents: 0, txnCount: 0, href: "/x", unreached: null });

  test("names both ends of the run", () => {
    expect(trendWindowLabel([at("2022-12"), at("2023-06"), at("2023-11")])).toBe("Dec 2022 to Nov 2023");
  });

  test("a single month is named once, not as a range of itself", () => {
    expect(trendWindowLabel([at("2023-11")])).toBe("Nov 2023");
  });

  test("no points name no months rather than an empty range", () => {
    expect(trendWindowLabel([])).toBe("no months");
  });

  test("the accessible name carries the window, never a hardcoded 'last 12 months'", () => {
    const html = renderToStaticMarkup(
      createElement(MonthlyTrendBars, { points: [at("2022-12"), { ...at("2023-11"), spentCents: -100 }] }),
    );
    expect(html).toContain("Monthly spending, Dec 2022 to Nov 2023");
    expect(html).not.toContain("last 12 months");
  });
});
