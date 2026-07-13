import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import { parseChaseCheckingLines } from "./chase-checking-statement-profile";

/**
 * Fixtures are small hand-made line arrays mirroring the REAL Chase College
 * Checking statement layout (decoded from data/inbox/chase/*.pdf via extractLines).
 * The real PDFs stay out of git; these arrays carry every decoded quirk:
 * MM/DD dates with no year, spaced negatives ("- 2.08"), wrapped card-number
 * orphans on the next line, and the printed running balance.
 */

const SAME_YEAR = [
  "August 25, 2022 through September 13, 2022",
  "JPMorgan Chase Bank, N.A.",
  "Account Number: 000000889063522",
  "*start*summary",
  "Chase College Checking",
  "CHECKING SUMMARY",
  "Beginning Balance $0.00",
  "Deposits and Additions 3,188.10",
  "ATM & Debit Card Withdrawals -264.80",
  "Ending Balance $2,923.30",
  "*end*summary",
  "*start*transaction detail",
  "TRANSACTION DETAIL",
  "DATE DESCRIPTION AMOUNT BALANCE",
  "Beginning Balance $0.00",
  "08/25 Deposit 1183713709 1,388.10 1,388.10",
  "08/29 ATM Cash Deposit 08/28 4780 3Rd Ave Bronx NY Card 7782 1,240.00 2,628.10",
  "08/29 Card Purchase 08/28 Subway 30703 Bronx NY Card 7782 -11.10 2,617.00",
  "08/30 Card Purchase 08/29 Love & Peace Convenienc Bronx NY Card 7782 - 2.08 2,614.92",
  // wrapped: the amount+balance are on the row line; "7782" orphans to the next
  "09/02 Card Purchase 09/01 Fordham-University-L#73 New York NY Card -11.95 2,602.97",
  "7782",
  "Ending Balance $2,923.30",
  "*end*transaction detail",
];

describe("parseChaseCheckingLines", () => {
  test("extracts period, account last4, and printed balances", () => {
    const parsed = parseChaseCheckingLines(SAME_YEAR);
    expect(parsed.periodStart).toBe("2022-08-25");
    expect(parsed.periodEnd).toBe("2022-09-13");
    expect(parsed.last4).toBe("3522");
    expect(parsed.beginningBalanceCents).toBe(0);
    expect(parsed.endingBalanceCents).toBe(292330);
  });

  test("signs deposits positive and purchases negative (net-worth convention)", () => {
    const parsed = parseChaseCheckingLines(SAME_YEAR);
    const deposit = parsed.txns.find((t) => t.rawDescription.includes("Deposit 1183713709"));
    expect(deposit?.amountCents).toBe(138810);
    const subway = parsed.txns.find((t) => t.rawDescription.includes("Subway"));
    expect(subway?.amountCents).toBe(-1110);
  });

  test("normalizes the spaced negative '- 2.08' to -208", () => {
    const parsed = parseChaseCheckingLines(SAME_YEAR);
    const row = parsed.txns.find((t) => t.rawDescription.includes("Convenienc"));
    expect(row?.amountCents).toBe(-208);
  });

  test("folds the wrapped card-number orphan into the prior row's description", () => {
    const parsed = parseChaseCheckingLines(SAME_YEAR);
    const wrapped = parsed.txns.find((t) => t.rawDescription.includes("Fordham-University"));
    expect(wrapped?.amountCents).toBe(-1195);
    expect(wrapped?.rawDescription.endsWith("7782")).toBe(true);
  });

  test("defaults to a checking account and reports the type", () => {
    expect(parseChaseCheckingLines(SAME_YEAR).accountType).toBe("checking");
  });

  test("does NOT fold the trailing legal footer/disclosure into the last transaction", () => {
    const parsed = parseChaseCheckingLines([
      "August 25, 2022 through September 13, 2022",
      "Account Number: 000000889063522",
      "Beginning Balance $0.00",
      "*start*transaction detail",
      "DATE DESCRIPTION AMOUNT BALANCE",
      // a wrapped row: the "7782" card number orphans to the next line
      "09/13 Card Purchase 09/12 Kfc K273018 Bronx NY Card - 10.01 2,933.70",
      "7782",
      "Ending Balance $2,923.30",
      "*end*transaction detail",
      "*start*dre portrait disclosure message area",
      "IN CASE OF ERRORS OR QUESTIONS ABOUT YOUR ELECTRONIC FUNDS TRANSFERS: Call us at 1-866-564-2262",
      "For personal accounts only: We must hear from you no later than 60 days after we sent you",
      "JPMorgan Chase Bank, N.A. Member FDIC",
      "*end*dre portrait disclosure message area",
      "Page 2 of 2",
    ]);
    const last = parsed.txns.at(-1)!;
    expect(last.amountCents).toBe(-1001);
    expect(last.rawDescription).toBe("Card Purchase 09/12 Kfc K273018 Bronx NY Card 7782"); // orphan folded
    expect(last.rawDescription).not.toContain("IN CASE OF ERRORS"); // footer NOT folded
    expect(last.rawDescription).not.toContain("Member FDIC");
  });

  test("detects a savings statement from a SAVINGS SUMMARY header", () => {
    const parsed = parseChaseCheckingLines([
      "August 25, 2022 through September 13, 2022",
      "Account Number: 000000889065791",
      "SAVINGS SUMMARY",
      "Beginning Balance $100.00",
      "Ending Balance $150.00",
      "*start*transaction detail",
      "DATE DESCRIPTION AMOUNT BALANCE",
      "08/30 Deposit 50.00 150.00",
      "*end*transaction detail",
    ]);
    expect(parsed.accountType).toBe("savings");
    expect(parsed.last4).toBe("5791");
  });

  test("infers row years across a Dec→Jan period boundary", () => {
    const parsed = parseChaseCheckingLines([
      "December 14, 2023 through January 12, 2024",
      "Account Number: 000000889063522",
      "Beginning Balance $100.00",
      "*start*transaction detail",
      "DATE DESCRIPTION AMOUNT BALANCE",
      "12/20 Card Purchase 12/19 Store A -10.00 90.00",
      "01/05 Card Purchase 01/04 Store B -5.00 85.00",
      "Ending Balance $85.00",
      "*end*transaction detail",
    ]);
    const dec = parsed.txns.find((t) => t.rawDescription.includes("Store A"));
    const jan = parsed.txns.find((t) => t.rawDescription.includes("Store B"));
    expect(dec?.postedOn).toBe("2023-12-20");
    expect(jan?.postedOn).toBe("2024-01-05");
  });

  test("throws when the account number is missing (not a Chase checking statement)", () => {
    expect(() =>
      parseChaseCheckingLines([
        "August 25, 2022 through September 13, 2022",
        "Beginning Balance $0.00",
        "Ending Balance $0.00",
      ]),
    ).toThrow(ParseError);
  });

  test("throws when no period header is present", () => {
    expect(() =>
      parseChaseCheckingLines(["Account Number: 000000889063522", "Beginning Balance $0.00"]),
    ).toThrow(ParseError);
  });
});
