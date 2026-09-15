import { describe, expect, test } from "vitest";
import { isInvestmentSide, liquidityOf } from "./account-side";

describe("isInvestmentSide", () => {
  test("an investment-type account always qualifies", () => {
    expect(
      isInvestmentSide({ type: "investment", name: "Robinhood Brokerage", institutionHasInvestment: true }),
    ).toBe(true);
  });

  test("a settlement-cash sibling at an investment institution qualifies", () => {
    expect(
      isInvestmentSide({ type: "checking", name: "Robinhood Cash", institutionHasInvestment: true }),
    ).toBe(true);
  });

  test("a plain checking account at a bank without investments does not", () => {
    expect(
      isInvestmentSide({ type: "checking", name: "Chase Checking", institutionHasInvestment: false }),
    ).toBe(false);
  });

  test("a savings account at an investment institution without settlement naming does not", () => {
    expect(isInvestmentSide({ type: "savings", name: "SoFi Savings", institutionHasInvestment: true })).toBe(
      false,
    );
  });

  test("a credit card at an investment institution never qualifies", () => {
    expect(
      isInvestmentSide({ type: "credit", name: "Robinhood Cash Back Card", institutionHasInvestment: true }),
    ).toBe(false);
  });
});

/**
 * ⚖️ Owner decision 2026-09-15: Robinhood Cash ($0.90, the brokerage's settlement
 * cash) and Robinhood Agentic ($26.64, Claude's trading money) are not cash he
 * can spend today — they are what selling investments would add. Both are typed
 * `checking` for balance replay, so the TYPE cannot say so; the statement that
 * prints them can.
 */
describe("liquidityOf", () => {
  test("a checking or savings account on its own bank's statements is cash you can spend today", () => {
    expect(liquidityOf({ type: "checking", printedWithInvestment: false })).toBe("spendable");
    expect(liquidityOf({ type: "savings", printedWithInvestment: false })).toBe("spendable");
  });

  test("a deposit account printed on a brokerage's statement is the brokerage's own cash", () => {
    expect(liquidityOf({ type: "checking", printedWithInvestment: true })).toBe("investable");
    expect(liquidityOf({ type: "savings", printedWithInvestment: true })).toBe("investable");
  });

  test("an investment account is what selling would add, whatever prints it", () => {
    expect(liquidityOf({ type: "investment", printedWithInvestment: true })).toBe("investable");
    expect(liquidityOf({ type: "investment", printedWithInvestment: false })).toBe("investable");
  });

  test("a card is owed, even one printed beside an investment", () => {
    expect(liquidityOf({ type: "credit", printedWithInvestment: false })).toBe("owed");
    expect(liquidityOf({ type: "credit", printedWithInvestment: true })).toBe("owed");
  });
});
