import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { PeriodTotals } from "@/services/spending";
import { SpendingStatCards } from "./SpendingStatCards";

const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };
const LINE = "spending imported through Aug 12 · 21 days of this period unaccounted";
const NOTE = "Not one day of October 2026 has been checked in the accounts that pay lands in, so nothing is shown.";

/** his October on his ledger copy 2026-10-21: no income found, $1,603.00 spent */
const totals: PeriodTotals = {
  earnedCents: 0,
  spentCents: 160_300,
  refundsCents: 0,
  netCents: -160_300,
  savingsRatePct: null,
};

type Unread = { uncoveredDays: number; line: string } | null;

function render(over: { incomeUnread?: string | null; partlyRead?: Unread; incomePartlyRead?: Unread } = {}) {
  return renderToStaticMarkup(
    createElement(SpendingStatCards, {
      totals,
      range: OCTOBER,
      spendingUnaccounted: null,
      incomeUnread: NOTE,
      partlyRead: { uncoveredDays: 21, line: LINE },
      incomePartlyRead: null,
      ...over,
    }),
  );
}

/** the card linking to `category=<category>` — each card is one link */
function card(html: string, category: string): string {
  const at = html.indexOf(`href="/transactions?category=${category}&amp;`);
  expect(at, category).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<a", at), html.indexOf("</a>", at));
}

/*
 * ⚖️ Decision 72 and §6A 68 on /spending's cards (2026-10-21). 🔴 Measured on his ledger copy 2026-10-21: `/spending`
 * carded October "INCOME $0.00 · SPENT $1,603.00" — the dashboard printing "—" for October's income, and "Where it
 * went" on the same page "partly read · spending imported through Aug 12 · 21 days of this period unaccounted".
 */
describe("SpendingStatCards — what the cards say of days nobody has read", () => {
  test("Spent wears the amber 'partly read' chip, with /budgets' line under its figure", () => {
    const spent = card(render(), "spending");
    expect(spent).toContain("$1,603.00");
    expect(spent).toMatch(/<span aria-hidden="true" class="[^"]*text-warning[^"]*">.*partly read<\/span><\/span>/);
    expect(spent).toContain(LINE);
  });

  // ⛔ the card is one <a>: a popover's <button> inside it is axe `nested-interactive` — the chip is no control
  test("the chip is an annotation, never a control inside the card's link", () => {
    expect(render()).not.toContain("<button");
  });

  test("Income prints the dashboard's dash and its words, never $0.00", () => {
    const income = card(render(), "income");
    expect(income).toContain("—");
    expect(income).toContain(NOTE);
    expect(income).not.toContain("$0.00");
  });

  // ⚖️ decision 72, extended to income totals: Income read in part wears the chip too, with its own line under it
  test("Income read only in part wears the chip, with income's line under its figure", () => {
    const line = "income imported through Jul 31 · 30 days of this period unaccounted";
    const html = render({
      incomeUnread: null,
      partlyRead: null,
      incomePartlyRead: { uncoveredDays: 30, line },
    });
    const income = card(html, "income");
    expect(income).toMatch(/<span aria-hidden="true" class="[^"]*text-warning[^"]*">.*partly read<\/span><\/span>/);
    expect(income).toContain(line);
    expect(card(html, "spending")).not.toContain("partly read");
  });

  test("a window read in full, with income checked, wears nothing new", () => {
    const html = render({ incomeUnread: null, partlyRead: null });
    expect(html).not.toContain("partly read");
    expect(card(html, "income")).toContain("$0.00");
  });
});
