import { describe, expect, test } from "vitest";
import { ParseError, type KnownAccount } from "../types";
import type { Line } from "./pdf-profile";
import {
  accountSections,
  isRobinhoodBrokerageStatementText,
  parseRobinhoodBrokerageLines,
  parseSweepActivity,
  robinhoodBrokerageStatements,
  selectAccountSections,
} from "./robinhood-brokerage-statement-profile";

/** A text line with the token x-positions a column reader needs; `[str, x]` pairs. */
const line = (text: string, tokens: [string, number][] = []): Line => ({
  y: 0,
  text,
  tokens: tokens.map(([str, x]) => ({ str, x })),
});
const asLines = (texts: readonly string[]): Line[] => texts.map((t) => line(t));

/** The owner's Robinhood accounts, as `parseContextFor` offers them once #655929651 is tracked. */
const BROKERAGE: KnownAccount = { last4: "3525", type: "investment", subtype: "brokerage" };
const CRYPTO: KnownAccount = { last4: "8474", type: "investment", subtype: "crypto" };
const AGENTIC: KnownAccount = { last4: "9651", type: "checking", subtype: null };

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
  "Total Securities ** $59,329.88 $67,859.26",
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
  "Total Securities * $6,243.57 $20,431.79",
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

describe("choosing the account sections", () => {
  /**
   * From 2026-06 the owner's statement carries a SECOND account, #655929651 —
   * the $26.64 he moved over on 2026-06-05 for Claude to trade with. June and
   * July print it second. The 2026-08 statement printed it FIRST, and "parse the
   * first section" read $26.64 → $26.64 as Robinhood Cash's month — a trial
   * import graded the period a $679.37 gap, turned 60 days into gap days and
   * quarantined both crypto cash legs. Sections are chosen by the accounts the
   * ledger TRACKS, never by where they happen to print — and once the owner
   * tracks #655929651 as an account of its own, BOTH are chosen.
   */
  const TRACKED = ["3525"];
  /** the ledger once the second account is tracked — Robinhood Crypto is ····8474 */
  const BOTH = ["3525", "8474", "9651"];
  const UNTRACKED = [
    "Individual Account #:655929651",
    "Account Summary",
    "Net Account Balance $26.64 $26.64",
    "Total Securities $0.00 $0.00",
    "Portfolio Value $26.64 $26.64",
  ];
  const TRACKED_FIRST = [...ERA_C, ...UNTRACKED];
  /** the 2026-08 order — every literal copied from the extracted file */
  const UNTRACKED_FIRST = [
    "08/01/2026 to 08/31/2026",
    ...UNTRACKED,
    "08/01/2026 to 08/31/2026",
    "Individual Account #:487513525",
    "Account Summary",
    "Brokerage Cash Balance * $1,679.93 $0.68",
    "Deposit Sweep Balance $0.45 $1,000.33",
    "Total Securities ** $67,859.26 $72,959.32",
    "Portfolio Value $69,539.64 $73,960.33",
  ];

  test("splits the document at every account header", () => {
    const sections = accountSections(UNTRACKED_FIRST);
    expect(sections.map((s) => s.accountNumber)).toEqual(["655929651", "487513525"]);
    const second = UNTRACKED_FIRST.slice(sections[1]!.start, sections[1]!.end);
    expect(second).not.toContain("Net Account Balance $26.64 $26.64");
    expect(second).toContain("Brokerage Cash Balance * $1,679.93 $0.68");
  });

  test("the tracked account's balances are read when it prints first", () => {
    const [cash, securities, ...rest] = robinhoodBrokerageStatements(asLines(TRACKED_FIRST), [BROKERAGE]);
    expect(rest).toEqual([]);
    expect(cash!.accountHint.preferName).toBe("Robinhood Cash");
    expect(cash!.period).toMatchObject({ endCents: 167993 + 45 }); // not 2664
    expect(securities!.accountHint.preferName).toBe("Robinhood Brokerage");
  });

  test("⛔ and when it prints SECOND — the 2026-08 order", () => {
    const [cash, securities, ...rest] = robinhoodBrokerageStatements(asLines(UNTRACKED_FIRST), [BROKERAGE]);
    expect(rest).toEqual([]);
    expect(cash!.period).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
      beginCents: 167993 + 45, // not 2664
      endCents: 68 + 100033, // not 2664
    });
    expect(securities!.period).toMatchObject({ beginCents: 6785926, endCents: 7295932 }); // not 0
  });

  test("refuses a multi-account statement when no section is an account the ledger tracks", () => {
    expect(() => selectAccountSections(UNTRACKED_FIRST, [])).toThrow(/655929651.*487513525/);
    expect(() => selectAccountSections(UNTRACKED_FIRST, ["9999"])).toThrow(ParseError);
    expect(() => parseRobinhoodBrokerageLines(TRACKED_FIRST)).toThrow(ParseError);
  });

  test("⛔ chooses EVERY tracked section, in print order — the June/July order and the 2026-08 order", () => {
    expect(selectAccountSections(TRACKED_FIRST, BOTH).map((s) => s.accountNumber)).toEqual(["487513525", "655929651"]);
    expect(selectAccountSections(UNTRACKED_FIRST, BOTH).map((s) => s.accountNumber)).toEqual(["655929651", "487513525"]);
  });

  test("an untracked section is still skipped beside a tracked one", () => {
    expect(selectAccountSections(UNTRACKED_FIRST, TRACKED).map((s) => s.accountNumber)).toEqual(["487513525"]);
  });

  test("⛔ refuses a statement that carries ONLY an untracked account — it would overwrite Robinhood Cash's anchor", () => {
    const untrackedAlone = ["08/01/2026 to 08/31/2026", ...UNTRACKED];
    expect(() => selectAccountSections(untrackedAlone, TRACKED)).toThrow(/655929651/);
  });

  test("a single-account statement needs no tracked account on a ledger that tracks none", () => {
    expect(parseRobinhoodBrokerageLines(ERA_C).accountNumber).toBe("487513525");
    expect(selectAccountSections(ERA_C, TRACKED).map((s) => s.accountNumber)).toEqual(["487513525"]);
  });

  test("⛔ refuses when one tracked last4 matches two sections — which of them is the account?", () => {
    const repeated = [...TRACKED_FIRST, "Individual Account #:487513525", "Account Summary"];
    expect(() => selectAccountSections(repeated, TRACKED)).toThrow(/····3525.*more than one section/);
  });

  test("⛔ refuses when one section matches two tracked accounts — two ledger accounts share a last4", () => {
    expect(() => selectAccountSections(ERA_C, ["3525", "3525"])).toThrow(/#487513525.*more than one account/);
  });

  test("throws when the document carries no account number", () => {
    expect(() => accountSections(["Account Summary", "Portfolio Value $1.00 $2.00"])).toThrow(ParseError);
  });

  test("⛔ crypto money movements are read from the brokerage's section only", () => {
    const header = line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [
      ["Debit", 500],
      ["Credit", 553],
    ]);
    const movement = (day: string, amount: string): Line =>
      line(`Crypto Money Movement Margin COIN ${day} ${amount}`, [
        [day, 400],
        [amount, 553],
      ]);
    const doc = [
      ...asLines(UNTRACKED_FIRST.slice(0, 6)),
      header,
      movement("08/05/2026", "$9.99"),
      ...asLines(UNTRACKED_FIRST.slice(6)),
      header,
      movement("08/24/2026", "$1,499.99"),
    ];
    const [cash] = robinhoodBrokerageStatements(doc, [BROKERAGE]);
    expect(cash!.txns).toEqual([
      { postedOn: "2026-08-24", amountCents: 149999, rawDescription: "Crypto Money Movement", categoryPath: "Transfers", soleSource: true },
    ]);
  });
});

/**
 * #655929651 tracked as an account of its own — a CASH account, because every
 * statement it has printed says it holds nothing but cash: Brokerage Cash
 * Balance $26.64 at 100.00%, Total Securities $0.00. Every literal is copied
 * from the extracted file named above it, token x-positions included.
 */
describe("a section tracked as a cash account", () => {
  const TRACKED_ALL = [BROKERAGE, CRYPTO, AGENTIC];
  const headerAt = (debitX: number, creditX: number): Line =>
    line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [
      ["Debit", debitX],
      ["Credit", creditX],
    ]);
  const totalFunds = (debit: string, credit: string, debitX: number, creditX: number): Line =>
    line(`Total Funds Paid and Received ${debit} ${credit}`, [
      ["Total Funds Paid and Received", 36],
      [debit, debitX],
      [credit, creditX],
    ]);

  /** #487513525, 2026-06 (747059b1…, lines 2–18, 116–121, 200). */
  const JUNE_BROKERAGE = [
    line("06/01/2026 to 06/30/2026"),
    line("Individual Account #:487513525"),
    line("Account Summary"),
    line("Brokerage Cash Balance * $0.38 $192.22"),
    line("Deposit Sweep Balance $0.34 $0.07"),
    line("Total Securities ** $62,556.95 $59,329.88"),
    line("Portfolio Value $62,557.67 $59,522.17"),
    line("Account Activity"),
    headerAt(687.6, 746.63),
    // the brokerage's side of the same transfer — a DEBIT, and the activity CSV's row, not this file's
    line("Transfer from Brokerage to Brokerage Margin ITRF 06/05/2026 $26.64", [
      ["Transfer from Brokerage to Brokerage", 36],
      ["Margin", 391.8],
      ["ITRF", 445.69],
      ["06/05/2026", 507.26],
      ["$26.64", 687.6],
    ]),
    line("Crypto Money Movement Margin COIN 06/05/2026 $2,542.62", [
      ["Crypto Money Movement", 36],
      ["Margin", 391.8],
      ["COIN", 445.69],
      ["06/05/2026", 507.26],
      ["$2,542.62", 687.6],
    ]),
    totalFunds("$24,664.76", "$24,856.33", 687.6, 746.63),
  ];

  const ITRF_CREDIT = line("Transfer from Brokerage to Brokerage Cash ITRF 06/05/2026 $26.64", [
    ["Transfer from Brokerage to Brokerage", 36],
    ["Cash", 347.25],
    ["ITRF", 426.3],
    ["06/05/2026", 516.67],
    ["$26.64", 746.51],
  ]);

  /** #655929651, 2026-06 (747059b1…, lines 373–416) — its first statement, so the opening is `N/A`. */
  const JUNE_SECOND = [
    line("06/01/2026 to 06/30/2026"),
    line("Individual Account #:655929651"),
    line("Account Summary"),
    line("Net Account Balance N/A $26.64"),
    line("Total Securities N/A $0.00"),
    line("Portfolio Value N/A $26.64"),
    line("Portfolio Summary"),
    line("Total Securities $0.00 $0.00 0.00%"),
    line("Brokerage Cash Balance $26.64 100.00%"),
    line("Account Activity"),
    headerAt(695.33, 746.51),
    ITRF_CREDIT,
    totalFunds("$0.00", "$26.64", 695.33, 746.51),
    line("Executed Trades Pending Settlement"),
    line("Total Executed Trades Pending Settlement $0.00 $0.00"),
  ];

  /** #655929651 with no money movement — 2026-07 (8e3da90f…, lines 534–576) and 2026-08 (48afc52f…, lines 2–44). */
  const quietMonth = (period: string): Line[] => [
    line(period),
    line("Individual Account #:655929651"),
    line("Account Summary"),
    line("Net Account Balance $26.64 $26.64"),
    line("Total Securities $0.00 $0.00"),
    line("Portfolio Value $26.64 $26.64"),
    line("Portfolio Summary"),
    line("Total Securities $0.00 $0.00 0.00%"),
    line("Brokerage Cash Balance $26.64 100.00%"),
    line("Account Activity"),
    headerAt(685.13, 743.4),
    totalFunds("$0.00", "$0.00", 685.13, 743.4),
    line("Executed Trades Pending Settlement"),
    line("Total Executed Trades Pending Settlement $0.00 $0.00"),
  ];
  const JULY = [...asLines(ERA_C), ...quietMonth("07/01/2026 to 07/31/2026")];
  /** 2026-08 prints #655929651 FIRST (48afc52f…, lines 160–176 for #487513525). */
  const AUGUST = [
    ...quietMonth("08/01/2026 to 08/31/2026"),
    ...asLines([
      "08/01/2026 to 08/31/2026",
      "Individual Account #:487513525",
      "Account Summary",
      "Brokerage Cash Balance * $1,679.93 $0.68",
      "Deposit Sweep Balance $0.45 $1,000.33",
      "Total Securities ** $67,859.26 $72,959.32",
      "Portfolio Value $69,539.64 $73,960.33",
    ]),
  ];
  const JUNE = [...JUNE_BROKERAGE, ...JUNE_SECOND];

  const swap = (lines: Line[], text: string, replacement: Line): Line[] => lines.map((l) => (l.text === text ? replacement : l));

  test("June: an N/A opening is a ledger observation of $26.64 on 06-30, and the ITRF credit is signed + by its column", () => {
    const statements = robinhoodBrokerageStatements(JUNE, TRACKED_ALL);
    expect(statements).toHaveLength(3); // cash + securities for #487513525, and ONE cash statement for #655929651
    expect(statements[2]).toEqual({
      // by last4 alone — no type and no preferName, so it can never resolve to Robinhood Cash
      accountHint: { institution: "Robinhood", last4: "9651" },
      txns: [
        {
          postedOn: "2026-06-05",
          amountCents: 2664,
          rawDescription: "Transfer from Brokerage to Brokerage", // the activity CSV's own wording for the other leg
          bankCategory: "ITRF",
        },
      ],
      declaredRange: { start: "2026-06-01", end: "2026-06-30" },
      ledger: { cents: 2664, asOf: "2026-06-30" }, // never a $0.00 opening the statement did not print
    });
  });

  test("the brokerage's statements are exactly what they were before the second account was tracked", () => {
    const withSecond = robinhoodBrokerageStatements(JUNE, TRACKED_ALL);
    const without = robinhoodBrokerageStatements(JUNE, [BROKERAGE, CRYPTO]);
    expect(without).toHaveLength(2);
    expect(withSecond.slice(0, 2)).toEqual(without);
    expect(without[0]!.period).toEqual({ start: "2026-06-01", end: "2026-06-30", beginCents: 38 + 34, endCents: 19222 + 7 });
    // the brokerage's own ITRF debit is NOT emitted — the activity CSV already carries it
    expect(without[0]!.txns.map((t) => [t.rawDescription, t.amountCents])).toEqual([["Crypto Money Movement", -254262]]);
  });

  test("July and August: a $26.64 → $26.64 period, in either print order", () => {
    const quiet = (start: string, end: string) => ({
      accountHint: { institution: "Robinhood", last4: "9651" },
      txns: [],
      period: { start, end, beginCents: 2664, endCents: 2664 },
    });
    const july = robinhoodBrokerageStatements(JULY, TRACKED_ALL);
    expect(july).toHaveLength(3);
    expect(july[2]).toEqual(quiet("2026-07-01", "2026-07-31"));

    const august = robinhoodBrokerageStatements(AUGUST, TRACKED_ALL);
    expect(august).toHaveLength(3);
    expect(august[0]).toEqual(quiet("2026-08-01", "2026-08-31"));
    expect(august[1]!.period).toEqual({ start: "2026-08-01", end: "2026-08-31", beginCents: 167993 + 45, endCents: 68 + 100033 });
  });

  test("⛔ refuses an Account Activity row that is not an ITRF — an agent's Buy fails loudly instead of vanishing", () => {
    const buy = line("SPY Cash Buy 06/10/2026 0.016 $625.00000 $10.00", [
      ["SPY", 284.14],
      ["Cash", 347.25],
      ["Buy", 426.3],
      ["06/10/2026", 516.67],
      ["0.016", 608.51],
      ["$625.00000", 647.06],
      ["$10.00", 695.33],
    ]);
    const withBuy = JUNE.flatMap((l) => (l === ITRF_CREDIT ? [l, buy] : [l]));
    expect(() => robinhoodBrokerageStatements(withBuy, TRACKED_ALL)).toThrow(/#655929651.*SPY Cash Buy/);
  });

  test("⛔ refuses rows that do not add up to the printed Total Funds Paid and Received", () => {
    const dropped = JUNE.filter((l) => l !== ITRF_CREDIT);
    expect(() => robinhoodBrokerageStatements(dropped, TRACKED_ALL)).toThrow(/Total Funds Paid and Received/);
  });

  test("⛔ refuses a cash-account section that prints no Total Funds Paid and Received line", () => {
    const julyWithoutTotals = JULY.filter((l) => !l.text.startsWith("Total Funds Paid and Received"));
    expect(() => robinhoodBrokerageStatements(julyWithoutTotals, TRACKED_ALL)).toThrow(/#655929651.*Total Funds Paid and Received/);
  });

  test("⛔ refuses a cash account that prints securities — including a first month whose opening is N/A", () => {
    const julyHolding = swap(quietMonth("07/01/2026 to 07/31/2026"), "Total Securities $0.00 $0.00", line("Total Securities $0.00 $12.34"));
    const july = [...asLines(ERA_C), ...julyHolding];
    expect(() => robinhoodBrokerageStatements(july, TRACKED_ALL)).toThrow(/#655929651.*\$12\.34 of securities/);

    const juneHolding = swap(JUNE, "Total Securities N/A $0.00", line("Total Securities N/A $12.34"));
    expect(() => robinhoodBrokerageStatements(juneHolding, TRACKED_ALL)).toThrow(/#655929651.*\$12\.34 of securities/);
  });

  test("⛔ refuses a cash-account section that prints no Total Securities line — nothing then shows it holds only cash", () => {
    // 🔴 measured by a second reader: turning this refusal into a `return` left every test green
    const july = [...asLines(ERA_C), ...quietMonth("07/01/2026 to 07/31/2026").filter((l) => !l.text.startsWith("Total Securities"))];
    expect(() => robinhoodBrokerageStatements(july, TRACKED_ALL)).toThrow(/#655929651 prints no Total Securities line/);
  });

  /**
   * #655929651's Executed Trades Pending Settlement table (747059b1…, lines 413–416): the page itself says these
   * "may not be reflected in the other summaries". The Buy is invented — no statement has printed one — and set in
   * the real table's columns.
   */
  const PENDING_TITLE = "Executed Trades Pending Settlement";
  const pendingTotal = (debit: string, credit: string): Line =>
    line(`Total Executed Trades Pending Settlement ${debit} ${credit}`, [
      ["Total Executed Trades Pending Settlement", 36],
      [debit, 691.65],
      [credit, 745.05],
    ]);
  const pendingBuy = line("SPY Cash Buy 06/29/2026 07/01/2026 0.03 $650.00 $19.50", [
    ["SPY", 36],
    ["Cash", 190.65],
    ["Buy", 329.1],
    ["06/29/2026", 423.38],
    ["07/01/2026", 511.28],
    ["0.03", 601.09],
    ["$650.00", 641.33],
    ["$19.50", 691.65],
  ]);
  const juneWithPending = (rows: readonly Line[], total: Line): Line[] =>
    JUNE.flatMap((l) => {
      if (l.text === PENDING_TITLE) {
        return [
          l,
          line("These transactions may not be reflected in the other summaries"),
          line("Description Acct Type Transaction Trade Date Settle Date Qty Price Debit Credit", [
            ["Debit", 691.65],
            ["Credit", 745.05],
          ]),
          ...rows,
        ];
      }
      return l.text.startsWith("Total Executed Trades Pending Settlement") ? [total] : [l];
    });

  test("⛔ refuses a trade pending settlement, though Total Securities still reads $0.00 — the agent's first Buy", () => {
    const pending = juneWithPending([pendingBuy], pendingTotal("$19.50", "$0.00"));
    // named as the pending trade it is — not read as an Account Activity row, whose table ended above it
    expect(() => robinhoodBrokerageStatements(pending, TRACKED_ALL)).toThrow(/#655929651 prints a trade pending settlement — "SPY Cash Buy/);
  });

  test("⛔ refuses a pending row under $0.00 totals, and non-zero totals with no row — either half is enough", () => {
    expect(() => robinhoodBrokerageStatements(juneWithPending([pendingBuy], pendingTotal("$0.00", "$0.00")), TRACKED_ALL)).toThrow(
      /#655929651 prints a trade pending settlement — "SPY Cash Buy/,
    );
    expect(() => robinhoodBrokerageStatements(juneWithPending([], pendingTotal("$0.00", "$19.50")), TRACKED_ALL)).toThrow(
      /#655929651 prints \$19\.50 of trades pending settlement/,
    );
  });

  test("⛔ refuses a cash-account section that prints no pending-trades table — nothing then shows none is pending", () => {
    const julyWithoutTotal = JULY.filter((l) => !l.text.startsWith("Total Executed Trades Pending Settlement"));
    expect(() => robinhoodBrokerageStatements(julyWithoutTotal, TRACKED_ALL)).toThrow(
      /#655929651 prints no Total Executed Trades Pending Settlement line/,
    );
    const julyWithoutTitle = JULY.filter((l) => l.text !== PENDING_TITLE);
    expect(() => robinhoodBrokerageStatements(julyWithoutTitle, TRACKED_ALL)).toThrow(
      /#655929651 prints no Executed Trades Pending Settlement title above its total/,
    );
  });

  test("the real months' empty pending table, with the page break printed inside it, is nothing pending", () => {
    const june = JUNE.flatMap((l) =>
      l.text === PENDING_TITLE
        ? [l, line("Page 21 of 22"), line("These transactions may not be reflected in the other summaries")]
        : [l],
    );
    expect(robinhoodBrokerageStatements(june, TRACKED_ALL)[2]!.ledger).toEqual({ cents: 2664, asOf: "2026-06-30" });
  });

  test("⛔ refuses a section tracked as an account type a brokerage statement cannot be", () => {
    const savings: KnownAccount = { last4: "9651", type: "savings", subtype: null };
    expect(() => robinhoodBrokerageStatements(JUNE, [BROKERAGE, savings])).toThrow(/#655929651.*savings/);
    const secondBrokerage: KnownAccount = { last4: "9651", type: "investment", subtype: "brokerage" };
    expect(() => robinhoodBrokerageStatements(JUNE, [BROKERAGE, secondBrokerage])).toThrow(/more than one.*brokerage/);
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

/**
 * PASS 73 — the securities anchor, which is the arbiter `Robinhood Brokerage`
 * has never had.
 *
 * ⛔ Two traps, both hit while measuring the real archive rather than imagined:
 *
 *  1. **The footnote marker is one asterisk in 2025 and two in 2026.** A regex
 *     accepting `\*?` does not fail on the 2026 line — it falls through to the
 *     NEXT line that does match, which is a different table entirely.
 *  2. **`Total Securities` appears a second time under `Loaned Securities`**,
 *     where the columns are value / estimated dividend / share of portfolio.
 *     Reading it printed 2026-03's closing balance as **$421.61** — an annual
 *     dividend estimate — instead of $44,521.74. The end anchor after exactly
 *     two money tokens is what excludes it, the same guard
 *     `BROKERAGE_CASH_RE` already uses against the allocation table.
 */
describe("the securities anchor", () => {
  test("era B: reads the opening and closing securities value", () => {
    const parsed = parseRobinhoodBrokerageLines(ERA_B);
    expect(parsed.openingSecuritiesCents).toBe(624_357);
    expect(parsed.closingSecuritiesCents).toBe(2_043_179);
  });

  test("era C: two asterisks are still a footnote marker", () => {
    const parsed = parseRobinhoodBrokerageLines(ERA_C);
    expect(parsed.openingSecuritiesCents).toBe(5_932_988);
    expect(parsed.closingSecuritiesCents).toBe(6_785_926);
  });

  test("⛔ the Loaned Securities subtotal is not an opening/closing pair", () => {
    const parsed = parseRobinhoodBrokerageLines([
      ...ERA_C,
      "Portfolio Summary",
      "Loaned Securities Sym/Cusip Acct Type Qty Price Mkt Value Est. Dividend Yield % of Total Portfolio",
      // value, ESTIMATED DIVIDEND, share of portfolio — three tokens, not two
      "Total Securities * $44,521.74 $421.61 84.37%",
    ]);
    expect(parsed.closingSecuritiesCents).toBe(6_785_926);
  });

  test("⛔ and it is not read even when it comes FIRST", () => {
    const parsed = parseRobinhoodBrokerageLines([
      "Total Securities * $44,521.74 $421.61 84.37%",
      ...ERA_C,
    ]);
    expect(parsed.closingSecuritiesCents).toBe(6_785_926);
  });

  test("era A has no securities line at all, which is not a failure", () => {
    const parsed = parseRobinhoodBrokerageLines(ERA_A);
    expect(parsed.openingSecuritiesCents).toBeNull();
    expect(parsed.closingSecuritiesCents).toBeNull();
    // and the cash it DOES print is unaffected
    expect(parsed.closingCashCents).toBe(8);
  });

  test("a printed N/A opening is no anchor, not a zero", () => {
    const parsed = parseRobinhoodBrokerageLines([
      ...ERA_B.filter((l) => !l.startsWith("Total Securities")),
      "Total Securities * N/A $20,431.79",
    ]);
    expect(parsed.openingSecuritiesCents).toBeNull();
    expect(parsed.closingSecuritiesCents).toBeNull();
  });
});
