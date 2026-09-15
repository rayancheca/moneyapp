import { describe, expect, test } from "vitest";
import { isInvestmentSide, isOwnPortfolioBook, liquidityOf } from "./account-side";

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
 * ⚖️ Owner decisions: #655929651 is tracked as "Robinhood Agentic" and KEPT OUT of his own brokerage returns
 * (2026-09-14); when the agent buys, a second account holds the positions while Robinhood Agentic keeps the cash
 * (2026-09-15). The book is paired with its cash account by a stored link, and whose returns it belongs to follows
 * that cash account — so the pair is always on ONE side of his boundary, never split across it.
 */
describe("isOwnPortfolioBook", () => {
  const agentic = { type: "checking", name: "Robinhood Agentic", institutionHasInvestment: true };

  test("an investment account paired with no cash account is his own — Robinhood Brokerage, Robinhood Crypto", () => {
    expect(isOwnPortfolioBook({ type: "investment", cashLeg: null })).toBe(true);
  });

  test("⛔ the book paired with Robinhood Agentic is not — the agent's positions stay out of his returns", () => {
    expect(isOwnPortfolioBook({ type: "investment", cashLeg: agentic })).toBe(false);
  });

  test("a book paired with a cash account on his investment side is his own — the pair moves together", () => {
    expect(
      isOwnPortfolioBook({ type: "investment", cashLeg: { type: "checking", name: "Robinhood Cash", institutionHasInvestment: true } }),
    ).toBe(true);
    // the same account renamed into the settlement vocabulary: its cash leg joins his side, and so does its book
    expect(isOwnPortfolioBook({ type: "investment", cashLeg: { ...agentic, name: "Robinhood Agentic Cash" } })).toBe(true);
  });

  test("an account that is not an investment account holds no book at all", () => {
    expect(isOwnPortfolioBook({ type: "checking", cashLeg: null })).toBe(false);
    expect(isOwnPortfolioBook({ type: "credit", cashLeg: null })).toBe(false);
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
