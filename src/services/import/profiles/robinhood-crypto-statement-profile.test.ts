import { describe, expect, test } from "vitest";
import { ParseError, type KnownAccount } from "../types";
import { cryptoAccountLast4s, parseRobinhoodCryptoLines } from "./robinhood-crypto-statement-profile";

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

/**
 * From 2026-07 the crypto statement carries TWO crypto accounts: #311070628474
 * (the owner's ETH, tracked as Robinhood Crypto ····8474) and #311407134147,
 * linked to the brokerage account #655929651 he funded for Claude. Every literal
 * below is copied from the extracted July 2026 file, where the tracked account
 * prints first. The parser used to take the first OPENING BALANCE and every
 * activity row anywhere in the document — right only because of that order, and
 * the same defect 3902f69 fixed in the brokerage statement.
 */
describe("choosing the crypto account section", () => {
  const ETH_ACCOUNT = [
    "Crypto Statement",
    "07-2026",
    "NAME Rayan Karim checa",
    "ACCOUNT NUMBER 311070628474",
    "RHS ACCOUNT NUMBER 487513525",
    "PERIOD START 2026-07-01",
    "PERIOD END 2026-07-31",
    "OPENING BALANCE $27359.92709892",
    "CLOSING BALANCE $28365.48180495",
    "ACCOUNT ACTIVITY",
    "DATE TRANSACTION TYPE DEBIT CREDIT PRICE VALUE FEE",
    "2026-07-07 Crypto Sale 2.798146 ETH -- $1786.80688415 $4999.75 --",
    "2026-07-19 Crypto Purchase -- 0.05269 ETH $1879.05360924 $99.01 --",
  ];
  const SECOND_ACCOUNT = [
    "Crypto Statement",
    "07-2026",
    "NAME Rayan Karim checa",
    "ACCOUNT NUMBER 311407134147",
    "RHS ACCOUNT NUMBER 655929651",
    "PERIOD START 2026-07-01",
    "PERIOD END 2026-07-31",
    "OPENING BALANCE $0",
    "CLOSING BALANCE $0",
    "You had no coin holding in your crypto account.",
    "You had no transactions in your crypto account for this month.",
  ];
  const TRACKED = ["3525", "8474", "9651"];

  test("the real order: the tracked account prints first and is the one read", () => {
    const p = parseRobinhoodCryptoLines([...ETH_ACCOUNT, ...SECOND_ACCOUNT], TRACKED);
    expect(p.openingValueCents).toBe(2_735_993);
    expect(p.closingValueCents).toBe(2_836_548);
    expect(p.txns.map((t) => t.amountCents)).toEqual([-499_975, 9_901]);
  });

  test("⛔ and when the other account prints FIRST, its $0 is not read as the ETH account's month", () => {
    const p = parseRobinhoodCryptoLines([...SECOND_ACCOUNT, ...ETH_ACCOUNT], TRACKED);
    expect(p.openingValueCents).toBe(2_735_993); // not 0
    expect(p.closingValueCents).toBe(2_836_548); // not 0
    expect(p.txns).toHaveLength(2);
  });

  test("⛔ an untracked account's activity rows never blend into the tracked account", () => {
    const secondWithARow = [...SECOND_ACCOUNT, "2026-07-20 Crypto Purchase -- 0.01 ETH $1900.00 $19.00 --"];
    const p = parseRobinhoodCryptoLines([...ETH_ACCOUNT, ...secondWithARow], TRACKED);
    expect(p.txns.map((t) => t.rawDescription)).toEqual(["Crypto Sale 2.798146 ETH", "Crypto Purchase 0.05269 ETH"]);
  });

  test("refuses a two-account statement on a ledger that tracks neither", () => {
    expect(() => parseRobinhoodCryptoLines([...ETH_ACCOUNT, ...SECOND_ACCOUNT], [])).toThrow(
      /311070628474, #311407134147.*refusing to guess/,
    );
  });

  test("refuses when BOTH crypto accounts are tracked — one statement routes to one Robinhood Crypto", () => {
    expect(() => parseRobinhoodCryptoLines([...ETH_ACCOUNT, ...SECOND_ACCOUNT], ["8474", "4147"])).toThrow(ParseError);
  });

  test("a single-account statement still parses on a ledger that tracks nothing, with or without its number", () => {
    expect(parseRobinhoodCryptoLines(ETH_ACCOUNT).closingValueCents).toBe(2_836_548);
    expect(parseRobinhoodCryptoLines(WITH_SALE).txns).toHaveLength(1); // no ACCOUNT NUMBER line at all
  });

  describe("the accounts its sections are chosen by", () => {
    const BROKERAGE: KnownAccount = { last4: "3525", type: "investment", subtype: "brokerage" };
    const CRYPTO: KnownAccount = { last4: "8474", type: "investment", subtype: "crypto" };
    const AGENTIC: KnownAccount = { last4: "9651", type: "checking", subtype: null };

    test("only the accounts the ledger tracks AS crypto — the owner's ledger offers ····8474 alone", () => {
      expect(cryptoAccountLast4s([BROKERAGE, CRYPTO, AGENTIC])).toEqual(["8474"]);
    });

    test("⛔ a ledger whose Robinhood Crypto has no number offers none, so a one-account statement reads as a fresh install", () => {
      expect(cryptoAccountLast4s([BROKERAGE, AGENTIC])).toEqual([]);
      expect(parseRobinhoodCryptoLines(ETH_ACCOUNT, cryptoAccountLast4s([BROKERAGE])).closingValueCents).toBe(2_836_548);
    });

    test("two tracked crypto accounts are both offered — and the two-account statement is refused, not blended", () => {
      const second: KnownAccount = { last4: "4147", type: "investment", subtype: "crypto" };
      expect(cryptoAccountLast4s([CRYPTO, second])).toEqual(["8474", "4147"]);
      expect(() => parseRobinhoodCryptoLines([...ETH_ACCOUNT, ...SECOND_ACCOUNT], cryptoAccountLast4s([CRYPTO, second]))).toThrow(
        /more than one is a crypto account/,
      );
    });
  });
});
