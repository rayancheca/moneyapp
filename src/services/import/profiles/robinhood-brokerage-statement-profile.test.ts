import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import {
  firstAccountSection,
  isRobinhoodBrokerageStatementText,
  parseRobinhoodBrokerageLines,
  parseSweepActivity,
} from "./robinhood-brokerage-statement-profile";

/**
 * Real Robinhood *securities* statements, one fixture per layout era found in
 * the owner's 32-month archive. Every literal below is copied from an extracted
 * PDF, including the quirks: the `*` footnote marker, parenthesised negatives,
 * `N/A` for the first statement's opening balance, and the portfolio-allocation
 * table that repeats the same labels with a percentage instead of a balance.
 */

/** Era C — brokerage cash + deposit sweep, plus the running cash ledger. */
const ERA_C = [
  "07/01/2026 to 07/31/2026",
  "Individual Account #:487513525",
  "Account Summary",
  "Brokerage Cash Balance * $192.22 $1,679.93",
  "Deposit Sweep Balance $0.07 $0.45",
  "Portfolio Value $59,522.17 $69,539.64",
  // the allocation table repeats both labels with ONE amount and a percentage
  "Brokerage Cash Balance $1,679.93 2.42%",
  "Deposit Sweep Balance $0.45 0.00%",
  "Opening Brokerage-held Cash Balance 07/01/2026 $192.22",
  "Closing Brokerage-held Cash Balance 07/31/2026 $1,651.02",
  "Total Brokerage-held Cash $8,584.63 $10,043.43",
];

/** Era B — the cash sits almost entirely in the SWEEP line. */
const ERA_B = [
  "07/01/2025 to 07/31/2025",
  "Individual Account #:487513525",
  "Account Summary",
  "Brokerage Cash Balance $0.00 $35.00",
  "Deposit Sweep Balance $15,246.18 $41,532.16",
  "Portfolio Value $21,489.75 $61,998.95",
];

/** Era A — a single `Net Account Balance` line, no sweep. */
const ERA_A = [
  "02/01/2025 to 02/28/2025",
  "Individual Account #:487513525",
  "Account Summary",
  "Net Account Balance $0.08 $0.08",
  "Portfolio Value $21.78 $20.53",
];

/** Era A′ — two-column layout: the amounts extract ABOVE their label. */
const ERA_A_PRIME = [
  "06/01/2024 to 06/30/2024",
  "RAYAN KARIM CHECA Account #:487513525",
  "Account Summary Opening Balance Closing Balance",
  "$0.04 $0.04",
  "Net Account Balance",
  "Cash and Cash Equivalents",
  "$16.66 $18.25 0.22%",
  "Total Securities*",
  "$16.70 $18.29",
  "Portfolio Value",
];

describe("isRobinhoodBrokerageStatementText", () => {
  test("accepts a brokerage statement", () => {
    expect(isRobinhoodBrokerageStatementText(ERA_C.join("\n"))).toBe(true);
    expect(isRobinhoodBrokerageStatementText(ERA_A_PRIME.join("\n"))).toBe(true);
  });

  test("rejects the crypto statement, which is also a Robinhood PDF", () => {
    const crypto = [
      "Crypto Statement 06-2026",
      "PERIOD START 2026-06-01",
      "PERIOD END 2026-06-30",
      "OPENING BALANCE $24835.87450346",
      "CLOSING BALANCE $27359.92709892",
    ].join("\n");
    expect(isRobinhoodBrokerageStatementText(crypto)).toBe(false);
  });

  test("does not gate on 'Robinhood Brokerage Statement', which no real file contains", () => {
    // a comment in the crypto profile long claimed this was the discriminator;
    // measured, it appears in 0 of 32 statements. Pin the correction.
    expect(ERA_C.join("\n")).not.toContain("Robinhood Brokerage Statement");
    expect(isRobinhoodBrokerageStatementText(ERA_C.join("\n"))).toBe(true);
  });

  test("rejects an unrelated statement", () => {
    expect(isRobinhoodBrokerageStatementText("Chase College Checking\nBeginning Balance")).toBe(false);
  });
});

describe("parseRobinhoodBrokerageLines", () => {
  test("era C: total cash is brokerage cash PLUS deposit sweep", () => {
    const p = parseRobinhoodBrokerageLines(ERA_C);
    expect(p.periodStart).toBe("2026-07-01");
    expect(p.periodEnd).toBe("2026-07-31");
    expect(p.openingCashCents).toBe(19222 + 7); // $192.22 + $0.07
    expect(p.closingCashCents).toBe(167993 + 45); // $1,679.93 + $0.45
  });

  test("era C: verifies the printed cash ledger closes", () => {
    expect(parseRobinhoodBrokerageLines(ERA_C).ledgerVerified).toBe(true);
  });

  test("era C: refuses the file when the cash ledger does not close", () => {
    const broken = ERA_C.map((l) =>
      l.startsWith("Total Brokerage-held Cash") ? "Total Brokerage-held Cash $8,584.63 $9,999.99" : l,
    );
    expect(() => parseRobinhoodBrokerageLines(broken)).toThrow(ParseError);
  });

  test("era C: the allocation table's label+percentage row is not read as a balance pair", () => {
    // dropping the real line must FAIL rather than silently fall through to
    // "Brokerage Cash Balance $1,679.93 2.42%"
    const withoutRealLine = ERA_C.filter((l) => !l.startsWith("Brokerage Cash Balance * "));
    expect(() => parseRobinhoodBrokerageLines(withoutRealLine)).toThrow(ParseError);
  });

  test("era B: reads the sweep line, where the money actually is", () => {
    const p = parseRobinhoodBrokerageLines(ERA_B);
    // reading only "Brokerage Cash Balance" would say $35.00 and conclude the
    // account holds nothing — the mistake that stalled this parser for a pass
    expect(p.openingCashCents).toBe(1524618);
    expect(p.closingCashCents).toBe(3500 + 4153216);
    expect(p.ledgerVerified).toBe(false);
  });

  test("era A: a single Net Account Balance line", () => {
    const p = parseRobinhoodBrokerageLines(ERA_A);
    expect(p.openingCashCents).toBe(8);
    expect(p.closingCashCents).toBe(8);
  });

  test("era A′: pairs the bare label with the amounts line above it", () => {
    const p = parseRobinhoodBrokerageLines(ERA_A_PRIME);
    expect(p.periodStart).toBe("2024-06-01");
    expect(p.openingCashCents).toBe(4);
    expect(p.closingCashCents).toBe(4);
  });

  test("era A′: declines when the preceding line is not a clean amount pair", () => {
    const scrambled = ERA_A_PRIME.map((l) => (l === "$0.04 $0.04" ? "Portfolio Allocation" : l));
    expect(() => parseRobinhoodBrokerageLines(scrambled)).toThrow(ParseError);
  });

  test("`N/A` opening yields no opening balance rather than a fabricated zero", () => {
    const firstEver = ERA_A_PRIME.map((l) => (l === "$0.04 $0.04" ? "N/A $0.00" : l));
    const p = parseRobinhoodBrokerageLines(firstEver);
    expect(p.openingCashCents).toBeNull();
    expect(p.closingCashCents).toBe(0);
  });

  test("parses a parenthesised negative cash balance", () => {
    // 2025-11 really printed ($9.90); a regex accepting only $n.nn drops the
    // figure and silently shifts every balance derived after it
    const negative = [
      "11/01/2025 to 11/30/2025",
      "Individual Account #:487513525",
      "Account Summary",
      "Brokerage Cash Balance $35.11 ($9.90)",
      "Deposit Sweep Balance $9,804.98 $5,034.94",
      "Portfolio Value $66,452.67 $64,092.89",
    ];
    const p = parseRobinhoodBrokerageLines(negative);
    expect(p.openingCashCents).toBe(3511 + 980498);
    expect(p.closingCashCents).toBe(-990 + 503494);
  });

  test("throws when no statement period is printed", () => {
    expect(() => parseRobinhoodBrokerageLines(ERA_C.filter((l) => !/ to /.test(l)))).toThrow(ParseError);
  });
});

describe("firstAccountSection", () => {
  /**
   * From 2026-06 the owner's statement carries a SECOND account. Blending its
   * balances into `Robinhood Cash` would corrupt the anchor, so only the first
   * section is ever parsed.
   */
  const TWO_ACCOUNTS = [
    ...ERA_C,
    "Individual Account #:655929651",
    "Account Summary",
    "Net Account Balance $26.64 $26.64",
    "Portfolio Value $26.64 $26.64",
  ];

  test("stops at the next account block", () => {
    const { accountNumber, lines } = firstAccountSection(TWO_ACCOUNTS);
    expect(accountNumber).toBe("487513525");
    expect(lines).not.toContain("Net Account Balance $26.64 $26.64");
  });

  test("the second account's balances never reach the parse", () => {
    const p = parseRobinhoodBrokerageLines(TWO_ACCOUNTS);
    expect(p.accountNumber).toBe("487513525");
    expect(p.closingCashCents).toBe(167993 + 45); // not 2664
  });

  test("throws when the document carries no account number", () => {
    expect(() => firstAccountSection(["Account Summary", "Portfolio Value $1.00 $2.00"])).toThrow(ParseError);
  });
});

/**
 * The Deposit Sweep Activity table — a DAY-level arbiter the profile ignored
 * until now. Every literal is copied from the real 2025-03 statement, whose
 * page break, `Interest Payment` rows and `Total Swept Funds` line are exactly
 * the three things that broke the first version of the parser.
 */
const SWEEP = [
  "Deposit Sweep Activity",
  "Description Date Debit Credit Balance",
  "Opening Sweep Balance 03/01/2025 $100.02",
  "FDIC Sweep 03/03/2025 $100.00 $0.02",
  "FDIC Sweep 03/06/2025 $100.00 $100.02",
  "FDIC Sweep 03/06/2025 $200.00 $300.02",
  "FDIC Sweep 03/07/2025 $300.00 $0.02",
  // a row that is NOT an "FDIC Sweep" — skipping these broke the chain on 5
  // of the archive's 18 sweep statements
  "Interest Payment 03/26/2025 $0.50 $0.52",
  "Closing Sweep Balance 03/31/2025 $0.52",
  "Total Swept Funds $400.00 $300.50",
];

describe("parseSweepActivity", () => {
  const drop = (needle: string) => SWEEP.filter((l) => !l.includes(needle));
  const swap = (needle: string, replacement: string) =>
    SWEEP.map((l) => (l.includes(needle) ? replacement : l));

  test("returns null when the statement prints no sweep table", () => {
    // 14 of the owner's 32 statements have none — absence is not an error
    expect(parseSweepActivity(ERA_A)).toBeNull();
  });

  test("reads the opening and closing balances and their days", () => {
    const sweep = parseSweepActivity(SWEEP)!;
    expect(sweep.openingOn).toBe("2025-03-01");
    expect(sweep.openingCents).toBe(10002);
    expect(sweep.closingOn).toBe("2025-03-31");
    expect(sweep.closingCents).toBe(52);
  });

  test("signs each movement from the running balance, not from the printed amount", () => {
    // the PDF puts the amount in a Debit or a Credit column and column position
    // does not survive text extraction — the balance is the only witness
    const sweep = parseSweepActivity(SWEEP)!;
    expect(sweep.movements.map((m) => m.amountCents)).toEqual([-10000, 10000, 20000, -30000, 50]);
    expect(sweep.movements.map((m) => m.day)).toEqual([
      "2025-03-03", "2025-03-06", "2025-03-06", "2025-03-07", "2025-03-26",
    ]);
  });

  test("reads rows that are not FDIC Sweeps", () => {
    // `Interest Payment` inside the table. Pinning the description to "FDIC
    // Sweep" is the obvious first implementation and it is wrong.
    const sweep = parseSweepActivity(SWEEP)!;
    expect(sweep.movements).toHaveLength(5);
    expect(sweep.movements.at(-1)!.amountCents).toBe(50);
  });

  test("CHECK 1: refuses a row whose printed amount contradicts its own balance step", () => {
    expect(() => parseSweepActivity(swap("03/03/2025", "FDIC Sweep 03/03/2025 $99.00 $0.02"))).toThrow(
      /moves .* but prints/,
    );
  });

  test("CHECK 2: refuses a table whose last row misses the printed closing balance", () => {
    // the failure a dropped FINAL row produces, which check 1 cannot see
    expect(() => parseSweepActivity(drop("Interest Payment"))).toThrow(/a row is missing/);
  });

  test("CHECK 3: refuses rows that do not sum to the printed Total Swept Funds", () => {
    expect(() => parseSweepActivity(swap("Total Swept Funds", "Total Swept Funds $400.00 $999.99"))).toThrow(
      /Total Swept Funds/,
    );
  });

  test("reads rows ONLY between the opening and closing lines", () => {
    // `Closing Collateral Balance 10/31/2025 $969.77 $0.00` is a different
    // ledger that matches the same generic row shape. Before the window it must
    // be ignored; the chain would break instantly if it were not.
    const withCollateral = [
      "Opening Collateral Balance 03/01/2025 $0.00",
      "Closing Collateral Balance 03/31/2025 $969.77 $0.00",
      ...SWEEP,
    ];
    expect(parseSweepActivity(withCollateral)!.movements).toHaveLength(5);
  });

  test("a table with no movements at all still yields its opening and closing", () => {
    expect(
      parseSweepActivity([
        "Opening Sweep Balance 03/01/2025 $0.52",
        "Closing Sweep Balance 03/31/2025 $0.52",
      ])!.movements,
    ).toEqual([]);
  });
});
