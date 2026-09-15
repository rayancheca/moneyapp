import { describe, expect, test } from "vitest";
import { budgetCoverageFact, budgetCoverageSentence, type BudgetCoverageInput } from "./budget-coverage";

const input = (over: Partial<BudgetCoverageInput> = {}): BudgetCoverageInput => ({
  importedThroughOn: "2026-09-02",
  spentFromSince: "2026-03-01",
  spentFromAccounts: 3,
  uncoveredDays: 13,
  bounds: { start: "2026-09-01" },
  ...over,
});

describe("budgetCoverageFact — the day the details panel names", () => {
  test("names the day every account the category is spent from has been imported through", () => {
    // Food on the real ledger 2026-09-15: Venture X Sep 13, Discover Sep 8,
    // Chase Sapphire Sep 2 — never Food's own newest row (Sep 12)
    expect(budgetCoverageFact(input())).toBe("spending imported through Sep 2");
  });

  test("with no account spent from in the window, names where the window opens", () => {
    expect(budgetCoverageFact(input({ importedThroughOn: null, spentFromAccounts: 0 }))).toBe(
      "nothing imported for this category since Mar 1",
    );
  });

  test("with accounts that carry no import date, does not claim nothing was imported", () => {
    // an investment account holds rows, but is priced rather than imported
    expect(budgetCoverageFact(input({ importedThroughOn: null, spentFromAccounts: 1 }))).toBe(
      "spent only from accounts with no import date since Mar 1",
    );
  });

  test("a day outside the graded period's year carries its year", () => {
    const january = { start: "2027-01-01" };
    expect(budgetCoverageFact(input({ importedThroughOn: "2026-12-20", bounds: january }))).toBe(
      "spending imported through Dec 20, 2026",
    );
    expect(
      budgetCoverageFact(input({ importedThroughOn: null, spentFromAccounts: 0, spentFromSince: "2026-07-01", bounds: january })),
    ).toBe("nothing imported for this category since Jul 1, 2026");
  });
});

describe("budgetCoverageSentence — the withheld row", () => {
  test("is the details panel's fact plus the days of THIS period it leaves", () => {
    // one fact in two places: the row and the panel cannot name two days
    expect(budgetCoverageSentence(input())).toBe(
      `${budgetCoverageFact(input())} · 13 days of this period unaccounted`,
    );
    expect(budgetCoverageSentence(input())).toBe("spending imported through Sep 2 · 13 days of this period unaccounted");
  });

  test("a single day is singular", () => {
    expect(budgetCoverageSentence(input({ importedThroughOn: "2026-09-14", uncoveredDays: 1 }))).toBe(
      "spending imported through Sep 14 · 1 day of this period unaccounted",
    );
  });
});
