import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import { isChaseCardStatementText, parseChaseCardLines } from "./chase-card-statement-profile";

/**
 * Line shapes are copied from a real Sapphire statement's extractLines()
 * output (amounts and merchants changed). The two statements this was built
 * against carry 73 and 90 rows and were verified row-for-row by three
 * independent PDF engines, so the cases below pin the RULES rather than
 * re-checking that arithmetic.
 */
const HEADER = [
  "Manage your account online at: Customer Service:",
  "www.chase.com/cardhelp",
  "Account Number: XXXX XXXX XXXX 9805",
  "Previous Balance $464.27",
  "Payment, Credits -$2,185.29",
  "Purchases +$1,650.13",
  "New Balance -$70.89",
  "Opening/Closing Date 06/03/26 - 07/02/26",
  "Credit Access Line $12,100",
];
const ACTIVITY = [
  "ACCOUNT ACCOUNT ACTIVITY ACTIVITY",
  "Date of",
  "Transaction Merchant Name or Transaction Description $ Amount",
  "PAYMENTS AND OTHER CREDITS",
  "06/04 Payment Thank You-Mobile -464.27",
  "06/08 UBER *EATS 8005928996 CA -42.03",
  "06/23 Payment Thank You-Mobile -1,470.00",
  "06/25 Payment Thank You-Mobile -100.00",
  "06/30 Payment Thank You-Mobile -100.00",
  "06/19 APPLE.COM/BILL 866-712-7753 CA -8.99",
  "PURCHASE",
  "06/02 CITY OF MIAMI BEACH 305-673-7000 FL 17.13",
  "ACCOUNT ACTIVITY (CONTINUED)",
  "06/15 SOME MERCHANT MIAMI FL 1,633.00",
];
const LINES = [...HEADER, ...ACTIVITY];

describe("isChaseCardStatementText", () => {
  test("accepts a card statement on its markers", () => {
    expect(isChaseCardStatementText(LINES.join("\n"))).toBe(true);
  });

  test("rejects a Chase CHECKING statement — they share a download filename", () => {
    const checking = [
      "May 13, 2026 through June 10, 2026",
      "JPMorgan Chase Bank, N.A.",
      "Account Number: 000000889063522",
      "CHECKING SUMMARY",
      "Beginning Balance $55.77",
      "Ending Balance $75.58",
    ].join("\n");
    expect(isChaseCardStatementText(checking)).toBe(false);
  });

  test("a checking marker vetoes even when card markers are present", () => {
    expect(isChaseCardStatementText([...LINES, "CHECKING SUMMARY"].join("\n"))).toBe(false);
  });

  test("two card markers are not enough to claim a file", () => {
    expect(isChaseCardStatementText("Opening/Closing Date 06/03/26 - 07/02/26\nCredit Access Line $12,100")).toBe(false);
  });
});

describe("parseChaseCardLines", () => {
  test("reads the period, mask and balances, net-worth-signed", () => {
    const parsed = parseChaseCardLines(LINES);
    expect(parsed.periodStart).toBe("2026-06-03");
    expect(parsed.periodEnd).toBe("2026-07-02");
    expect(parsed.last4).toBe("9805");
    // "Previous Balance $464.27" is money OWED, so net worth is negative;
    // "New Balance -$70.89" is a credit balance, so net worth is positive
    expect(parsed.beginningBalanceCents).toBe(-46_427);
    expect(parsed.endingBalanceCents).toBe(7_089);
  });

  test("inverts the card's sign convention: a purchase lowers net worth", () => {
    const parsed = parseChaseCardLines(LINES);
    const purchase = parsed.txns.find((t) => t.rawDescription.startsWith("CITY OF MIAMI BEACH"))!;
    expect(purchase.amountCents).toBe(-1_713); // printed +17.13
    const payment = parsed.txns.find((t) => t.rawDescription === "Payment Thank You-Mobile")!;
    expect(payment.amountCents).toBe(464_27); // printed -464.27
  });

  test("records the printed date as the TRANSACTION date, not just the post date", () => {
    // the card statement prints one date and it is the transaction date; the
    // Spending Report rows already in the DB carry a post date 1-3 days later,
    // and dedupe can only bridge that if this is recorded honestly
    for (const t of parseChaseCardLines(LINES).txns) expect(t.transactedOn).toBe(t.postedOn);
  });

  test("keeps a row dated just OUTSIDE its own period", () => {
    // 06/02 precedes the 06/03 opening date and is still on the statement
    const parsed = parseChaseCardLines(LINES);
    expect(parsed.txns.some((t) => t.postedOn === "2026-06-02")).toBe(true);
    expect(parsed.txns).toHaveLength(8);
  });

  test("survives a page break inside a section", () => {
    // the row after 'ACCOUNT ACTIVITY (CONTINUED)' must still be collected
    const parsed = parseChaseCardLines(LINES);
    expect(parsed.txns.find((t) => t.rawDescription === "SOME MERCHANT MIAMI FL")?.amountCents).toBe(-163_300);
  });

  test("infers the year across a December boundary", () => {
    const decLines = [
      "Account Number: XXXX XXXX XXXX 9805",
      "Previous Balance $0.00",
      "New Balance $30.00",
      "Opening/Closing Date 12/20/25 - 01/19/26",
      "Credit Access Line $12,100",
      "Merchant Name or Transaction Description $ Amount",
      "PAYMENTS AND OTHER CREDITS",
      "12/28 DECEMBER MERCHANT 10.00",
      "01/05 JANUARY MERCHANT 20.00",
    ];
    const parsed = parseChaseCardLines(decLines);
    expect(parsed.txns.map((t) => t.postedOn)).toEqual(["2025-12-28", "2026-01-05"]);
  });

  test("refuses a statement that does not reconcile", () => {
    const broken = LINES.map((l) => (l === "New Balance -$70.89" ? "New Balance -$99.99" : l));
    expect(() => parseChaseCardLines(broken)).toThrow(ParseError);
    expect(() => parseChaseCardLines(broken)).toThrow(/does not reconcile/);
  });

  test("refuses when the rows disagree with the printed section totals", () => {
    const broken = LINES.map((l) => (l === "Purchases +$1,650.13" ? "Purchases +$1,650.14" : l));
    expect(() => parseChaseCardLines(broken)).toThrow(/Section totals disagree/);
  });

  test("does not mistake an MM/DD/YY date line for an activity row", () => {
    // these appear in the interest-rate block and would otherwise parse as rows
    const withDateLine = [...LINES, "07/27/26 APR SOMETHING 1.00"];
    expect(parseChaseCardLines(withDateLine).txns).toHaveLength(8);
  });

  test("ignores everything past the year-to-date block", () => {
    const withYtd = [...LINES, "2026 Totals Year-to-Date", "07/01 SHOULD NOT APPEAR 5.00"];
    expect(parseChaseCardLines(withYtd).txns).toHaveLength(8);
  });

  test("reports a missing period rather than guessing", () => {
    expect(() => parseChaseCardLines(HEADER.filter((l) => !l.startsWith("Opening/Closing")))).toThrow(
      /No 'Opening\/Closing Date/,
    );
  });

  test("reports no activity rows rather than returning an empty statement", () => {
    expect(() => parseChaseCardLines(HEADER)).toThrow(/No activity rows found/);
  });
});
