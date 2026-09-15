import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DecompositionBar } from "./ReturnViewParts";

/**
 * 🔴 A CUMULATIVE SPLIT UNDER A HEADER THAT NAMES A RANGE, WITH NO BASIS DAY.
 *
 * Measured on the real ledger 2026-09-15, /investments?view=returns&range=1M:
 * the header read "+$11,211.49 ▲ (+11.32%) · return · 1M" and the bar directly
 * under it "Value = net contributed + market gains $108,974.93 … Market gains
 * +$23,561.70" — the ALL-range total, since Wed, Jul 10, 2024. UNH's page put a
 * green "+$2,948.04" gains under a red 1M "−$351.12". The two legends on the
 * same card already say "since {day}"; this was the part that did not.
 *
 * ⛔ The bar is NOT windowed. `decomposeValue` books the series' first NAV as
 * capital put in, so handing it a 1M slice would print the $99,695.59 opening
 * value as "Net contributed" — a new false statement in place of an omission.
 */
const REAL_LEDGER_ALL = {
  sinceDay: "2024-07-10",
  grossContributedCents: 17_058_364,
  withdrawnCents: 8_517_041,
  netContributedCents: 8_541_323,
  gainsCents: 2_356_170,
  valueCents: 10_897_493,
};

describe("DecompositionBar names the day it counts from", () => {
  test("the caption and the accessible name both say 'since' the series' first day", () => {
    const html = renderToStaticMarkup(createElement(DecompositionBar, { decomposition: REAL_LEDGER_ALL }));
    // the visible caption
    expect(html).toMatch(/Value = net contributed \+ market gains · since Wed, Jul 10, 2024</);
    // the bar's accessible name, which a screen reader hears instead of the caption
    expect(html).toMatch(/aria-label="[^"]*is market gains since Wed, Jul 10, 2024\."/);
    // and the figures themselves are untouched
    expect(html).toContain("Market gains +$23,561.70");
    expect(html).toContain("Net contributed +$85,413.23 · in $170,583.64 · out $85,170.41");
  });

  test("a series with no sells and a loss keeps its own wording, and the basis", () => {
    const html = renderToStaticMarkup(
      createElement(DecompositionBar, {
        decomposition: {
          sinceDay: "2026-08-16",
          grossContributedCents: 100_000,
          withdrawnCents: 0,
          netContributedCents: 100_000,
          gainsCents: -5_000,
          valueCents: 95_000,
        },
      }),
    );
    expect(html).toMatch(/Value = contributions \+ market losses · since Sun, Aug 16, 2026</);
    expect(html).toMatch(/is market losses since Sun, Aug 16, 2026\."/);
  });
});
