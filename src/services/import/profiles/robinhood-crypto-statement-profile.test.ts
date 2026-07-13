import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import { parseRobinhoodCryptoLines } from "./robinhood-crypto-statement-profile";

/**
 * Real Robinhood Crypto statement PDFs (single-column). Balances are portfolio
 * VALUES with sub-cent precision (parseAmountToCents rounds to the nearest cent);
 * the account is an investment value anchor. Activity columns are
 * DATE TYPE DEBIT CREDIT PRICE VALUE FEE — a Crypto Purchase credits crypto for
 * $VALUE (cash in), a Crypto Sale debits crypto for $VALUE (cash out).
 */

const STATEMENT = [
  "Crypto Statement",
  "11-2025",
  "NAME Rayan Karim checa",
  "ACCOUNT NUMBER 311070628474",
  "PERIOD START 2025-11-01",
  "PERIOD END 2025-11-30",
  "OPENING BALANCE $1504.99929923",
  "CLOSING BALANCE $3480.4884827",
  "ACCOUNT ACTIVITY",
  "DATE TRANSACTION TYPE DEBIT CREDIT PRICE VALUE FEE",
  "2025-11-04 Crypto Purchase -- 0.32258 ETH $3098.85441497 $999.63 --",
  "2025-11-30 Crypto Purchase -- 0.003247 ETH $3049.05 $9.90 --",
  "This statement is provided for informational purposes only and is not intended for tax reporting",
];

const WITH_SALE = [
  "Crypto Statement",
  "PERIOD START 2026-04-01",
  "PERIOD END 2026-04-30",
  "OPENING BALANCE $22533.85742813",
  "CLOSING BALANCE $23082.93686228",
  "ACCOUNT ACTIVITY",
  "2026-04-22 Crypto Sale 0.5 ETH -- $2377.8561797 $1188.93 --",
];

describe("parseRobinhoodCryptoLines", () => {
  test("extracts the ISO period and rounds the sub-cent portfolio values", () => {
    const p = parseRobinhoodCryptoLines(STATEMENT);
    expect(p.periodStart).toBe("2025-11-01");
    expect(p.periodEnd).toBe("2025-11-30");
    expect(p.openingValueCents).toBe(150500); // $1504.99929923 → nearest cent
    expect(p.closingValueCents).toBe(348049); // $3480.4884827 → nearest cent
  });

  test("a Crypto Purchase is cash-in (+value), tagged Investments > Buys", () => {
    const p = parseRobinhoodCryptoLines(STATEMENT);
    const buy = p.txns.find((t) => t.rawDescription.includes("0.32258"));
    expect(buy?.amountCents).toBe(99963);
    expect(buy?.categoryPath).toBe("Investments > Buys");
    expect(buy?.rawDescription).toBe("Crypto Purchase 0.32258 ETH");
  });

  test("a Crypto Sale is cash-out (−value), tagged Investments > Sells", () => {
    const p = parseRobinhoodCryptoLines(WITH_SALE);
    expect(p.txns).toHaveLength(1);
    const sale = p.txns[0]!;
    expect(sale.amountCents).toBe(-118893);
    expect(sale.categoryPath).toBe("Investments > Sells");
    expect(sale.rawDescription).toBe("Crypto Sale 0.5 ETH");
  });

  test("disclaimer and header lines never become transactions", () => {
    const p = parseRobinhoodCryptoLines(STATEMENT);
    expect(p.txns).toHaveLength(2);
  });

  test("throws when the period is missing", () => {
    expect(() =>
      parseRobinhoodCryptoLines(["OPENING BALANCE $1.00", "CLOSING BALANCE $2.00"]),
    ).toThrow(ParseError);
  });

  test("throws when the opening/closing values are missing", () => {
    expect(() =>
      parseRobinhoodCryptoLines(["PERIOD START 2025-11-01", "PERIOD END 2025-11-30"]),
    ).toThrow(ParseError);
  });
});
