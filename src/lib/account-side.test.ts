import { describe, expect, test } from "vitest";
import { isInvestmentSide } from "./account-side";

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
