import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import { parseChaseCheckingLines, withoutMarginIdentifier } from "./chase-checking-statement-profile";

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

/**
 * Chase prints a 20-digit statement identifier in the right margin, one per
 * page. unpdf clusters text by baseline, so that identifier joins whatever
 * line happens to share its y — and the joined line then fails ROW_RE,
 * BALANCE_RE, or drags the margin digits into a description.
 *
 * Every line below is the decoded shape of a real printed line (identifiers and
 * amounts as they appear in data/originals); the statements themselves stay out
 * of git.
 */
describe("the 20-digit margin statement identifier", () => {
  const head = (beginning = "$342.00") => [
    "February 13, 2025 through March 12, 2025",
    "JPMorgan Chase Bank, N.A.",
    "Account Number: 000000889063522",
    "*start*transaction detail",
    "TRANSACTION DETAIL",
    "DATE DESCRIPTION AMOUNT BALANCE",
    `Beginning Balance ${beginning}`,
  ];
  const HEAD = head();

  test("reads a row the identifier merged onto, keeping the printed amount and balance", () => {
    const parsed = parseChaseCheckingLines([
      ...head("$308.00"),
      "02/28 Zelle Payment From Oliver Denna Fontaine 23892926660 34.00 342.00",
      "02/28 Zelle Payment From Joshua A Zuchowski Mntdkak9Lezz 33.99 375.99 11790210202000000062",
      "Ending Balance $375.99",
      "*end*transaction detail",
    ]);
    const zelle = parsed.txns.find((t) => t.rawDescription.includes("Mntdkak9Lezz"));
    expect(zelle).toBeDefined();
    expect(zelle!.amountCents).toBe(3399);
    expect(zelle!.postedOn).toBe("2025-02-28");
    expect(zelle!.rawDescription).toBe("Zelle Payment From Joshua A Zuchowski Mntdkak9Lezz");
    // the row above it keeps its own description — the merged line must not fold
    const prior = parsed.txns.find((t) => t.rawDescription.includes("Oliver Denna Fontaine"));
    expect(prior!.rawDescription).toBe("Zelle Payment From Oliver Denna Fontaine 23892926660");
    // and the statement reconciles against its own printed balances
    const sum = parsed.txns.reduce((a, t) => a + t.amountCents, 0);
    expect(parsed.beginningBalanceCents + sum).toBe(parsed.endingBalanceCents);
  });

  test("keeps the identifier out of a wrapped card-number continuation", () => {
    const parsed = parseChaseCheckingLines([
      ...HEAD,
      "09/12 Card Purchase 09/11 U-Haul Tolls And Cita 800-789-3638 AZ Card - 10.11 331.89",
      "7782 10287890202000000062",
      "Ending Balance $331.89",
      "*end*transaction detail",
    ]);
    const row = parsed.txns.at(-1)!;
    expect(row.amountCents).toBe(-1011);
    expect(row.rawDescription).toBe(
      "Card Purchase 09/11 U-Haul Tolls And Cita 800-789-3638 AZ Card 7782",
    );
  });

  test("keeps a standalone identifier line out of the description it sits inside", () => {
    const parsed = parseChaseCheckingLines([
      ...HEAD,
      "04/11 Card Purchase 04/11 Mta*Mnr Etix Ticket 877-690-5116 NY Card -5.00 337.00",
      "19947370303000000063",
      "7782",
      "Ending Balance $337.00",
      "*end*transaction detail",
    ]);
    const row = parsed.txns.at(-1)!;
    expect(row.amountCents).toBe(-500);
    // the wrapped card number still folds; only the margin digits are dropped
    expect(row.rawDescription).toBe(
      "Card Purchase 04/11 Mta*Mnr Etix Ticket 877-690-5116 NY Card 7782",
    );
  });

  test("reads an Ending Balance the identifier merged onto", () => {
    const parsed = parseChaseCheckingLines([
      "February 13, 2025 through March 12, 2025",
      "Account Number: 000000889063522",
      "*start*transaction detail",
      "DATE DESCRIPTION AMOUNT BALANCE",
      "Beginning Balance $258.21",
      "04/08 Sofi Bank Transfer Rkarim Checa Web ID: 9039430511 -243.21 15.00",
      "Ending Balance $15.00 10835640202000000062",
      "*end*transaction detail",
    ]);
    expect(parsed.endingBalanceCents).toBe(1500);
  });

  /**
   * The sweep that found this defect asked one question of all 48 statements:
   * does anything the parser emits still carry the margin digits? This is that
   * question as a guard — the identifier put on every kind of line it was
   * measured landing on, at once.
   */
  test("no parsed field carries the margin digits, whatever line they land on", () => {
    const parsed = parseChaseCheckingLines([
      "February 13, 2025 through March 12, 2025",
      "Account Number: 000000889063522",
      "Beginning Balance $308.00 11790210202000000060",
      "*start*transaction detail",
      "DATE DESCRIPTION AMOUNT BALANCE",
      "02/28 Zelle Payment From Oliver Denna Fontaine 23892926660 34.00 342.00",
      "02/28 Zelle Payment From Joshua A Zuchowski Mntdkak9Lezz 33.99 375.99 11790210202000000062",
      "03/01 Card Purchase 02/28 Kfc K273018 Bronx NY Card -10.00 365.99",
      "7782 11790210202000000063",
      "03/02 Card Purchase 03/01 Target 00033803 New York NY Card -5.00 360.99",
      "11790210202000000064",
      "7782",
      "Ending Balance $360.99 11790210202000000065",
      "*end*transaction detail 11790210202000000066",
    ]);
    const digits = /\d{20}/;
    expect(parsed.txns.filter((t) => digits.test(t.rawDescription))).toEqual([]);
    expect(parsed.txns).toHaveLength(4);
    expect(parsed.beginningBalanceCents).toBe(30800);
    expect(parsed.endingBalanceCents).toBe(36099);
    const sum = parsed.txns.reduce((a, t) => a + t.amountCents, 0);
    expect(parsed.beginningBalanceCents + sum).toBe(parsed.endingBalanceCents);
    // the two wrapped card numbers still reach the rows they belong to
    expect(parsed.txns.at(-2)!.rawDescription.endsWith("Card 7782")).toBe(true);
    expect(parsed.txns.at(-1)!.rawDescription.endsWith("Card 7782")).toBe(true);
  });

  test("leaves the 15-digit account number and shorter reference numbers alone", () => {
    const parsed = parseChaseCheckingLines([
      ...HEAD,
      "02/28 Zelle Payment From Oliver Denna Fontaine 23892926660 34.00 376.00",
      "Ending Balance $376.00",
      "*end*transaction detail",
    ]);
    expect(parsed.last4).toBe("3522");
    expect(parsed.txns.at(-1)!.rawDescription).toBe(
      "Zelle Payment From Oliver Denna Fontaine 23892926660",
    );
  });

  /**
   * The rows v1 stored before this rule existed carry the identifier wherever its line folded in. A comparison of
   * the two reads (scripts/probe-chase-redrop.ts) needs, for each stored row, the words THIS parser reads from the
   * same printed lines — the stored words below are two of the live ledger's 13, as measured 2026-09-28.
   */
  test.each([
    [
      "Card Purchase 09/11 U-Haul Tolls And Cita 800-789-3638 AZ Card 7782 10287890202000000062",
      [
        "09/12 Card Purchase 09/11 U-Haul Tolls And Cita 800-789-3638 AZ Card - 10.11 331.89",
        "7782 10287890202000000062",
        "Ending Balance $331.89",
      ],
    ],
    [
      "Card Purchase 04/11 Mta*Mnr Etix Ticket 877-690-5116 NY Card 19947370303000000063 7782",
      [
        "04/11 Card Purchase 04/11 Mta*Mnr Etix Ticket 877-690-5116 NY Card -5.00 337.00",
        "19947370303000000063",
        "7782",
        "Ending Balance $337.00",
      ],
    ],
  ])("a stored v1 description less the identifier is what the parser reads: %s", (stored, printed) => {
    const read = parseChaseCheckingLines([...HEAD, ...printed, "*end*transaction detail"]).txns.at(-1)!.rawDescription;
    expect(withoutMarginIdentifier(stored)).toBe(read);
  });

  test("a 20-digit run inside a longer token is not the identifier", () => {
    // the shapes of the live ledger's other 42 rows with a 20-digit run (digits made up): an IBAN, a card
    // reference glued to the state, a Wells Fargo reference
    for (const words of [
      "CONSUMER ONLINE INTERNATIONAL WIRE BEN:/ES0012340000000000000000 FAMILY EXPENSES",
      "TST*SOME DINER NEW YORK NY00100000000000000000AA",
      "WFB Opening Deposit From Card Xxxxxxxxxxxx0000 Ref #1000000000000000000000 on 07/27/26",
    ]) {
      expect(withoutMarginIdentifier(words)).toBe(words);
    }
  });
});
