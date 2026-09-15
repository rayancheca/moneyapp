import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { PortfolioDayChange, PortfolioOverview } from "@/services/portfolio";
import { PortfolioStats } from "./PortfolioStats";

/**
 * 🔴 The header stat measured a day no close was printed on, and called it
 * "Today". Measured on the real ledger, Tue 2026-09-15: every held close is Mon
 * Sep 14, the NAV series is carried to Tuesday, and /investments read "Today
 * $0.00 +0.00%" over a portfolio whose ten holdings had moved +$1,904.99 between
 * their last closes. The stat now shows the move INTO the newest close and names
 * it by the closes it was made of — the rule the movers strip and the holdings
 * subtotal already use.
 *
 * ⚠️ Rendered here rather than in Playwright: the e2e fixture quotes every
 * symbol through its own fake today, so only the "Today" branch paints there.
 */
const overview: PortfolioOverview = {
  valueCents: 10_897_493,
  asOf: "2026-09-15", // the carried day — never what the day change is named by
  twrPct: null,
  twrGainCents: 0,
  twrAnchor: null,
  xirrPct: null,
  xirrExact: true,
  costBasisPlCents: null,
  costBasisPlPct: null,
  realizedPlCents: null,
  realizedPlExact: true,
  realizedSellCount: 0,
  hasCrypto: true,
};

const stocks = { quotedOn: "2026-09-14", previousQuotedOn: "2026-09-11" };
const eth = { quotedOn: "2026-09-14", previousQuotedOn: "2026-09-13" };

const monday = (closes: PortfolioDayChange["closes"]): PortfolioDayChange => ({
  cents: 190_499,
  pct: 1.779,
  exact: true,
  on: "2026-09-14",
  vsDay: "2026-09-13",
  closes,
});

const render = (dayChange: PortfolioDayChange, today: string): string =>
  renderToStaticMarkup(createElement(PortfolioStats, { overview, dayChange, today }));

describe("PortfolioStats names its day change by the closes it measured", () => {
  test("the real ledger read Tue 2026-09-15: Monday's move, and no one pair of days to call it by", () => {
    const html = render(monday([stocks, eth]), "2026-09-15");
    expect(html).toContain("$1,904.99");
    expect(html).toContain("Day change");
    expect(html).not.toContain("Today");
    // ⛔ nor the SERIES' two days: "Sep 14 vs Sep 13" is false of nine stocks
    // that moved from Friday's close
    expect(html).not.toContain(" vs ");
  });

  test("closes every holding shares are named once, as the interval", () => {
    const html = render(monday([stocks, stocks]), "2026-09-15");
    expect(html).toContain("Last close");
    expect(html).toContain("Sep 14 vs Sep 11");
    expect(html).not.toContain("Today");
  });

  test("closes quoted today keep the word — the e2e fixture's state", () => {
    const html = render(
      { cents: -13_200, pct: -0.24, exact: true, on: "2026-07-08", vsDay: "2026-07-07", closes: [{ quotedOn: "2026-07-08", previousQuotedOn: "2026-07-07" }] },
      "2026-07-08",
    );
    expect(html).toContain("Today");
    expect(html).not.toContain(" vs ");
  });

  test("no figure is an em dash under a label that claims no day", () => {
    const html = render({ cents: null, pct: null, exact: true, on: null, vsDay: null, closes: [] }, "2026-09-15");
    // the first stat is the day change; the ones after it are other figures
    const stat = html.split("</div>")[0]!;
    expect(stat).toContain("Day change");
    expect(stat).toContain("—");
    expect(stat).not.toContain("$0.00");
  });
});
