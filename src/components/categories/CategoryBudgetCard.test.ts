import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { budgetVerdict } from "@/lib/budget-verdict";
import type { CategoryBudgetRef } from "@/services/category-detail";
import { CategoryBudgetCard } from "./CategoryBudgetCard";

/**
 * 🔴 THE CARD GRADED A MONTH NOBODY HAD IMPORTED, IN GREEN. Read on his ledger copy 2026-10-12, one card under a
 * headline reading "— October 2026 has not been imported yet":
 *
 *     Budget   monthly budget · grading Oct 1 – Oct 31     $0.00 of $2,291.21   $2,291.21 left   (text-positive)
 *
 * while /budgets, for the same row and the same 31 days, read "Awaiting statements" over "spending imported through
 * Aug 12 · 12 days of this period unaccounted" with its "Left" in no colour at all. The card is drawn in /budgets'
 * shape now: the row's withheld verdict, the row's coverage sentence, and a "left" that is not called healthy.
 */

const ROW = { spentFromAccounts: 1, spentFromWallets: 0 };

/** Housing on his ledger copy 2026-10-12, as `categoryBudgetRef` returns it — less the reading, which each test sets */
const HOUSING = {
  amountCents: 229_121,
  rolloverCents: 0,
  availableCents: 229_121,
  spentCents: 0,
  remainingCents: 229_121,
  period: "monthly",
  bounds: { start: "2026-10-01", end: "2026-10-31" },
  alert: "none",
  href: "/budgets",
} as const;

const AWAITING: CategoryBudgetRef = {
  ...HOUSING,
  verdict: budgetVerdict({ ...ROW, pace: "at-risk", pct: 0, uncoveredDays: 12 }),
  coverageSentence: "spending imported through Aug 12 · 12 days of this period unaccounted",
};

function render(budget: CategoryBudgetRef): string {
  return renderToStaticMarkup(createElement(CategoryBudgetCard, { budget }));
}

/** the text a reader sees, tags dropped */
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** the class list on the element whose text is exactly `words` */
function classOf(html: string, words: string): string {
  const at = html.indexOf(`>${words}<`);
  if (at === -1) throw new Error(`no element reads "${words}"`);
  const open = html.lastIndexOf("<", at);
  return /class="([^"]*)"/.exec(html.slice(open, at))?.[1] ?? "";
}

describe("CategoryBudgetCard — /budgets' reading of the same row and window", () => {
  test("an unimported month is withheld in the row's words, not graded in green", () => {
    const html = render(AWAITING);
    expect(text(html)).toBe(
      "Budget Awaiting statements monthly budget · grading Oct 1 – Oct 31 " +
        "spending imported through Aug 12 · 12 days of this period unaccounted " +
        "$0.00 of $2,291.21 $2,291.21 left Budgets →",
    );
    // /budgets' "Left" carries no colour while its verdict is withheld — and neither does this one
    expect(classOf(html, "$2,291.21 left")).not.toMatch(/text-(positive|warning|negative)/);
  });

  /*
   * ⛔ /budgets' definitions end on its bar's anatomy — "the dark mark is how far through the period you are" — and
   * this card draws no bar. A tooltip body is live text even while closed, so it would describe a mark nobody can see.
   */
  test("the headline is the row's, without the row's definition of a bar this card does not draw", () => {
    const html = render(AWAITING);
    expect(AWAITING.verdict.explanation).toMatch(/the dark mark is how far through the period you are/);
    expect(html).not.toContain("dark mark");
    expect(html).not.toContain("aria-haspopup");
    // the card is still called "Budget": the reading stands beside its heading, not inside it
    expect(html).toMatch(/<h2[^>]*>Budget<\/h2>/);
  });

  test("⚖️ a category spent only from a cash wallet says so, and no statement is promised", () => {
    const cash: CategoryBudgetRef = {
      ...HOUSING,
      verdict: budgetVerdict({ spentFromAccounts: 0, spentFromWallets: 1, pace: "under", pct: 0, uncoveredDays: 12 }),
      coverageSentence: "spent only from a cash wallet since Apr 1 — no statement will ever cover it",
    };
    const html = render(cash);
    expect(text(html)).toMatch(/^Budget Cash only monthly budget · grading Oct 1 – Oct 31 spent only from a cash wallet/);
    expect(classOf(html, "$2,291.21 left")).not.toMatch(/text-(positive|warning|negative)/);
  });

  test("a measured month keeps its figure and its colour, and says nothing about coverage", () => {
    const measured: CategoryBudgetRef = {
      ...HOUSING,
      spentCents: 120_000,
      remainingCents: 109_121,
      verdict: budgetVerdict({ ...ROW, pace: "under", pct: 0.52, uncoveredDays: 0 }),
      coverageSentence: null,
    };
    const html = render(measured);
    expect(text(html)).toBe("Budget monthly budget · grading Oct 1 – Oct 31 $1,200.00 of $2,291.21 $1,091.21 left Budgets →");
    expect(classOf(html, "$1,091.21 left")).toContain("text-positive");
    expect(html).not.toContain("Awaiting statements");
  });

  test("past the line on partial data is graded, as /budgets grades it", () => {
    const over: CategoryBudgetRef = {
      ...HOUSING,
      spentCents: 247_000,
      remainingCents: -17_879,
      alert: "over",
      verdict: budgetVerdict({ ...ROW, pace: "over", pct: 1.08, uncoveredDays: 12 }),
      coverageSentence: null,
    };
    const html = render(over);
    expect(text(html)).toBe("Budget monthly budget · grading Oct 1 – Oct 31 $2,470.00 of $2,291.21 $178.79 over Budgets →");
    expect(classOf(html, "$178.79 over")).toContain("text-negative");
  });
});
