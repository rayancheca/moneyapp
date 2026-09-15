import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AccountHoldingRow } from "@/services/holdings";
import { AccountHoldingsTable } from "./AccountHoldingsTable";

/**
 * 🔴 /accounts/[id]'s Day column printed a move with no date. Measured on the
 * real ledger, Tue 2026-09-15: Robinhood Brokerage's nine rows read "+5.77%",
 * "+3.36%" … under a bare "Day", every one a move between Fri Sep 11's and Mon
 * Sep 14's closes — while /investments/stock/COKE dated the same +5.77% "Last
 * close · Sep 14 vs Sep 11". The column now dates its moves by the rule the
 * movers strip and the /investments holdings subtotal use: once on the column
 * when every row shares a name, on each row when they do not.
 *
 * ⚠️ Rendered here rather than in Playwright: the e2e fixture quotes every
 * symbol through its own fake today, so only the "Today" branch paints there —
 * and that branch deliberately paints nothing new.
 */
const row = (
  symbol: string,
  quotedOn: string | null,
  previousQuotedOn: string | null,
  pct: number,
  valueCents: number,
  assetType: AccountHoldingRow["assetType"] = "stock",
): AccountHoldingRow => ({
  symbol,
  assetType,
  quantityE8: 100_000_000,
  avgCostCents: null,
  latestClose: valueCents / 100,
  quotedOn,
  previousQuotedOn,
  valueCents,
  dayChangeCents: Math.round(valueCents * (pct / 100)),
  dayChangePct: pct,
  plCents: null,
  plPct: null,
  allocationPct: 50,
});

const render = (rows: AccountHoldingRow[], today: string): string =>
  renderToStaticMarkup(createElement(AccountHoldingsTable, { rows, today }));

/** the <th> whose text starts with the column's name */
const header = (html: string, name: string): string =>
  html.match(new RegExp(`<th[^>]*>(?:(?!</th>).)*?>${name}<(?:(?!</th>).)*</th>`))?.[0] ?? "";

describe("AccountHoldingsTable dates each day move by its own two closes", () => {
  test("Robinhood Brokerage read Tue 2026-09-15: the column names Sep 14 vs Sep 11, once", () => {
    const html = render(
      [row("COKE", "2026-09-14", "2026-09-11", 5.77, 20_000), row("AAPL", "2026-09-14", "2026-09-11", -0.27, 10_000)],
      "2026-09-15",
    );
    expect(header(html, "Day")).toContain("Sep 14 vs Sep 11");
    // said at the column, never again on each row
    expect(html.split("Sep 14 vs Sep 11")).toHaveLength(2);
    expect(html).not.toMatch(/today/i);
  });

  test("rows whose closes differ each carry their own, and the column claims no date", () => {
    const html = render(
      [row("ETH", "2026-09-14", "2026-09-13", 2.26, 10_000, "crypto"), row("COKE", "2026-09-14", "2026-09-11", 5.77, 20_000)],
      "2026-09-15",
    );
    expect(header(html, "Day")).not.toContain(" vs ");
    // sorted by value, so COKE's row paints first — each term follows its holding, not its position
    expect(html).toMatch(/COKE[\s\S]*Sep 14 vs Sep 11[\s\S]*ETH[\s\S]*Sep 14 vs Sep 13/);
    expect(html.split(" vs ")).toHaveLength(3);
  });

  test("a row with one close is given no date, and does not un-date the rows beside it", () => {
    const html = render(
      [row("COKE", "2026-09-14", "2026-09-11", 5.77, 20_000), row("NEW", "2026-09-14", null, 0, 10_000)],
      "2026-09-15",
    );
    expect(header(html, "Day")).toContain("Sep 14 vs Sep 11");
    expect(html.split(" vs ")).toHaveLength(2);
  });

  test("moves that closed today paint nothing new — the e2e fixture's state, and Monday's on the real ledger", () => {
    const fixture = render(
      [row("AAPL", "2026-07-08", "2026-07-07", 1.5, 20_000), row("MSFT", "2026-07-08", "2026-07-07", -1.27, 10_000)],
      "2026-07-08",
    );
    expect(fixture).not.toMatch(/today| vs /i);
    // read on Mon 2026-09-14, a Friday→Monday stock and a Sunday→Monday coin are both "Today"
    const monday = render(
      [row("COKE", "2026-09-14", "2026-09-11", 5.77, 20_000), row("ETH", "2026-09-14", "2026-09-13", 2.26, 10_000, "crypto")],
      "2026-09-14",
    );
    expect(monday).not.toMatch(/today| vs /i);
  });
});
