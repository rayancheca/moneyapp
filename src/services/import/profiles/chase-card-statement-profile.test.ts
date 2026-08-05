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

describe("fees and interest are charges, not purchases", () => {
  /**
   * A real Sapphire statement (2025-03-02) was rejected outright because it
   * carried the $95 annual fee: Chase printed `Purchases +$5,371.57` and
   * `Fees Charged +$95.00`, but listed the fee as an ordinary activity row, so
   * the rows summed to $5,466.57 and the section check called it a mismatch.
   * The difference was exactly the fee.
   */
  const withFee = [
    "Account Number: XXXX XXXX XXXX 9805",
    "Previous Balance $100.00",
    "Payment, Credits -$0.00",
    "Purchases +$50.00",
    "Fees Charged +$95.00",
    "Interest Charged $0.00",
    "New Balance $245.00",
    "Opening/Closing Date 02/03/25 - 03/02/25",
    "02/10 SOME MERCHANT MIAMI FL 50.00",
    "02/11 ANNUAL MEMBERSHIP FEE 95.00",
  ];

  test("a statement carrying the annual fee parses instead of being rejected", () => {
    const parsed = parseChaseCardLines(withFee);
    expect(parsed.txns).toHaveLength(2);
    // card-side charge -> net-worth negative
    expect(parsed.txns.map((t) => t.amountCents)).toEqual([-5000, -9500]);
    expect(parsed.endingBalanceCents).toBe(-24500);
  });

  test("interest is counted the same way", () => {
    const withInterest = withFee.map((l) =>
      l === "Fees Charged +$95.00" ? "Fees Charged $0.00"
      : l === "Interest Charged $0.00" ? "Interest Charged +$95.00"
      : l === "02/11 ANNUAL MEMBERSHIP FEE 95.00" ? "02/11 PURCHASE INTEREST CHARGE 95.00"
      : l);
    expect(parseChaseCardLines(withInterest).txns).toHaveLength(2);
  });

  test("a genuinely missing row is still caught to the cent", () => {
    // the whole point of adding fees back rather than dropping the check
    const missingRow = withFee.filter((l) => l !== "02/10 SOME MERCHANT MIAMI FL 50.00");
    expect(() => parseChaseCardLines(missingRow)).toThrow(ParseError);
  });

  test("a phantom fee that no row backs is still caught", () => {
    const phantom = withFee.map((l) => (l === "Fees Charged +$95.00" ? "Fees Charged +$120.00" : l));
    expect(() => parseChaseCardLines(phantom)).toThrow(/Section totals disagree/);
  });
});

describe("sub-dollar amounts printed without a leading zero", () => {
  /**
   * Chase prints `.78`, never `0.78`. Requiring a digit before the decimal
   * silently dropped 71 real charges worth $32.95 across the owner's 18
   * Sapphire statements — and six of them then failed to reconcile by exactly
   * the dropped amount. The rows were fine; the reader refused to see them.
   */
  const base = [
    "Account Number: XXXX XXXX XXXX 9805",
    "Previous Balance $0.00",
    "Payment, Credits -$0.00",
    "Purchases +$2.34",
    "New Balance $2.34",
    "Opening/Closing Date 03/03/25 - 04/02/25",
  ];

  test("reads a bare .NN amount", () => {
    const parsed = parseChaseCardLines([
      ...base,
      "03/13 EAST 110 CANDY GROCERY CO NEW YORK NY .78",
      "03/13 EAST 110 CANDY GROCERY CO NEW YORK NY .78",
      "03/13 EAST 110 CANDY GROCERY CO NEW YORK NY .78",
    ]);
    expect(parsed.txns).toHaveLength(3);
    expect(parsed.txns.map((t) => t.amountCents)).toEqual([-78, -78, -78]);
  });

  test("a bare .NN credit keeps its sign", () => {
    const parsed = parseChaseCardLines([
      "Account Number: XXXX XXXX XXXX 9805",
      "Previous Balance $1.00",
      "Payment, Credits -$0.78",
      "Purchases +$0.00",
      "New Balance $0.22",
      "Opening/Closing Date 03/03/25 - 04/02/25",
      "03/13 SOME REFUND NEW YORK NY -.78",
    ]);
    expect(parsed.txns.map((t) => t.amountCents)).toEqual([78]);
  });

  test("ordinary amounts are unaffected", () => {
    const parsed = parseChaseCardLines([
      "Account Number: XXXX XXXX XXXX 9805",
      "Previous Balance $0.00",
      "Payment, Credits -$0.00",
      "Purchases +$1,234.56",
      "New Balance $1,234.56",
      "Opening/Closing Date 03/03/25 - 04/02/25",
      "03/13 BIG PURCHASE NEW YORK NY 1,234.56",
    ]);
    expect(parsed.txns.map((t) => t.amountCents)).toEqual([-123456]);
  });

  test("a comma-only integer part is NOT a row, so it can never reach the money parser", () => {
    // `[\d,]*` would have admitted this and thrown MoneyParseError out of the
    // profile as an unexpected error type; `(?:\d[\d,]*)?` refuses it outright.
    expect(() =>
      parseChaseCardLines([...base, "03/13 WEIRD MERCHANT NEW YORK NY ,.21"]),
    ).toThrow(/No activity rows found/);
  });

  test("the reconcile check still catches a genuinely dropped sub-dollar row", () => {
    expect(() =>
      parseChaseCardLines([
        ...base,
        "03/13 EAST 110 CANDY GROCERY CO NEW YORK NY .78",
        "03/13 EAST 110 CANDY GROCERY CO NEW YORK NY .78",
      ]),
    ).toThrow(ParseError);
  });
});
