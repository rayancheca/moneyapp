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
    const [cash, securities, ...rest] = robinhoodBrokerageStatements(asLines(TRACKED_FIRST), [BROKERAGE]).statements;
    expect(rest).toEqual([]);
    expect(cash!.accountHint.preferName).toBe("Robinhood Cash");
    expect(cash!.period).toMatchObject({ endCents: 167993 + 45 }); // not 2664
    expect(securities!.accountHint.preferName).toBe("Robinhood Brokerage");
  });

  test("⛔ and when it prints SECOND — the 2026-08 order", () => {
    const [cash, securities, ...rest] = robinhoodBrokerageStatements(asLines(UNTRACKED_FIRST), [BROKERAGE]).statements;
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
    const [cash] = robinhoodBrokerageStatements(doc, [BROKERAGE]).statements;
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
  /** #487513525, 2026-08 (48afc52f…, lines 160–176). */
  const AUGUST_BROKERAGE = asLines([
    "08/01/2026 to 08/31/2026",
    "Individual Account #:487513525",
    "Account Summary",
    "Brokerage Cash Balance * $1,679.93 $0.68",
    "Deposit Sweep Balance $0.45 $1,000.33",
    "Total Securities ** $67,859.26 $72,959.32",
    "Portfolio Value $69,539.64 $73,960.33",
  ]);
  /** 2026-08 prints #655929651 FIRST. */
  const AUGUST = [...quietMonth("08/01/2026 to 08/31/2026"), ...AUGUST_BROKERAGE];
  const JUNE = [...JUNE_BROKERAGE, ...JUNE_SECOND];

  const JUNE_PERIOD = { start: "2026-06-01", end: "2026-06-30" };
  const JULY_PERIOD = { start: "2026-07-01", end: "2026-07-31" };
  const AUGUST_PERIOD = { start: "2026-08-01", end: "2026-08-31" };

  const swap = (lines: Line[], text: string, replacement: Line): Line[] => lines.map((l) => (l.text === text ? replacement : l));

  /**
   * 🔴 Every refusal below used to fail the WHOLE PDF, and the file is shared with the brokerage. Measured on
   * August's real figures with a constructed agent buy (agentic-design.json, option (c)): −$2,500.10 of Robinhood
   * Cash — the two Crypto Money Movement credits no other source carries — runway 27 → 11 days, forecast month-end
   * cash $1,093.15 → −$1,406.95, and `pnpm ledger-check` red.
   *
   * Now ONLY #655929651's section is withheld, named with its window and why, and the brokerage's statements are
   * exactly what the same file gives when #655929651 is not tracked at all.
   */
  const withheldFrom = (doc: Line[], period: { start: string; end: string }, reason: RegExp): void => {
    const read = robinhoodBrokerageStatements(doc, TRACKED_ALL);
    const untracked = robinhoodBrokerageStatements(doc, [BROKERAGE, CRYPTO]);
    expect(untracked.statements.length).toBeGreaterThan(0);
    expect(read.statements).toEqual(untracked.statements);
    expect(read.withheld).toEqual([
      {
        // the cash statement's own hint, so the withheld section names the account its statement would have gone to
        accountHint: { institution: "Robinhood", last4: "9651" },
        accountNumber: "655929651",
        period,
        reason: expect.stringMatching(reason),
      },
    ]);
  };

  test("June: an N/A opening is a ledger observation of $26.64 on 06-30, and the ITRF credit is signed + by its column", () => {
    const { statements, withheld } = robinhoodBrokerageStatements(JUNE, TRACKED_ALL);
    expect(withheld).toEqual([]); // a section the cash reader proves is never withheld
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
    const withSecond = robinhoodBrokerageStatements(JUNE, TRACKED_ALL).statements;
    const without = robinhoodBrokerageStatements(JUNE, [BROKERAGE, CRYPTO]).statements;
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
    const july = robinhoodBrokerageStatements(JULY, TRACKED_ALL).statements;
    expect(july).toHaveLength(3);
    expect(july[2]).toEqual(quiet("2026-07-01", "2026-07-31"));
    expect(robinhoodBrokerageStatements(JULY, TRACKED_ALL).withheld).toEqual([]);

    const { statements: august, withheld } = robinhoodBrokerageStatements(AUGUST, TRACKED_ALL);
    expect(withheld).toEqual([]);
    expect(august).toHaveLength(3);
    expect(august[0]).toEqual(quiet("2026-08-01", "2026-08-31"));
    expect(august[1]!.period).toEqual({ start: "2026-08-01", end: "2026-08-31", beginCents: 167993 + 45, endCents: 68 + 100033 });
  });

  test("⛔ a Buy whose shares the section does not print as held withholds the section, and only the section", () => {
    const buy = line("SPY Cash Buy 06/10/2026 0.016 $625.00000 $10.00", [
      ["SPY", 284.14],
      ["Cash", 347.25],
      ["Buy", 426.3],
      ["06/10/2026", 516.67],
      ["0.016", 608.51],
      ["$625.00000", 647.06],
      ["$10.00", 695.33],
    ]);
    // the totals add up — the Buy is really there — but Securities Held lists nothing and Total Securities reads $0.00
    const withBuy = JUNE.flatMap((l) => {
      if (l === ITRF_CREDIT) return [l, buy];
      return l.text.startsWith("Total Funds Paid and Received") ? [totalFunds("$10.00", "$26.64", 695.33, 746.51)] : [l];
    });
    withheldFrom(withBuy, JUNE_PERIOD, /its positions are not what the ledger held before Jun 1, 2026 plus this month's trades \(SPY: it prints 0, the trades give 0\.016\)/);
  });

  test("⛔ a Crypto Money Movement in the agent's own section — a crypto buy through its linked account — withholds it", () => {
    // set in #655929651's real 2026-08 columns (48afc52f…, line 38); the brokerage's own COIN rows sit under its header the same way
    const coin = line("Crypto Money Movement Cash COIN 08/12/2026 $10.00", [
      ["Crypto Money Movement", 36],
      ["Cash", 341.55],
      ["COIN", 431.63],
      ["08/12/2026", 534.56],
      ["$10.00", 685.13],
    ]);
    const august = AUGUST.flatMap((l) => {
      if (l.text.startsWith("Description Symbol Acct Type")) return [l, coin];
      return l.text.startsWith("Total Funds Paid and Received") ? [totalFunds("$10.00", "$0.00", 685.13, 743.4)] : [l];
    });
    // the owner, 2026-09-14: its linked crypto account #311407134147 is not tracked until it holds crypto
    withheldFrom(august, AUGUST_PERIOD, /a crypto money movement \("Crypto Money Movement Cash COIN 08\/12\/2026 \$10\.00"\), and its crypto account is not tracked/);
  });

  /**
   * The rehearsal's month (agentic-design.json, option (c)): the agent buys 0.25 WMT for $25.00 on 08/20. These are
   * #655929651's real 2026-08 lines (48afc52f…, lines 2–44) with only what that buy changes — both balances, one
   * Securities Held row, one Buy row set in the real columns, the Total Funds line. No statement for this account has
   * printed a position yet; the lines are constructed, never read from a file.
   */
  const AGENT_BUYS: Line[] = [
    line("08/01/2026 to 08/31/2026"),
    line("Individual Account #:655929651"),
    line("Account Summary"),
    line("Net Account Balance $26.64 $1.64"),
    line("Total Securities $0.00 $26.22"),
    line("Portfolio Value $26.64 $27.86"),
    line("Portfolio Summary"),
    line("Walmart"),
    line("WMT Cash 0.25 $104.87000 $26.22 $0.24 94.11%"),
    line("Total Securities $26.22 $0.24 94.11%"),
    line("Brokerage Cash Balance $1.64 5.89%"),
    line("Account Activity"),
    headerAt(685.13, 743.4),
    line("Walmart"),
    line("WMT Cash Buy 08/20/2026 0.25 $100.00000 $25.00", [
      ["WMT", 269.66],
      ["Cash", 341.55],
      ["Buy", 431.63],
      ["08/20/2026", 534.56],
      ["0.25", 586.28],
      ["$100.00000", 630.19],
      ["$25.00", 685.13],
    ]),
    line("CUSIP: 931142103"),
    totalFunds("$25.00", "$0.00", 685.13, 743.4),
    line("Executed Trades Pending Settlement"),
    line("Total Executed Trades Pending Settlement $0.00 $0.00"),
  ];

  test("⛔ the rehearsal's month, on a ledger where no position has ever been WMT, withholds #655929651's August and nothing else", () => {
    // asset type is never guessed from a ticker: "ETH" is a coin and a listed fund, and stock vs ETF prices differently
    withheldFrom([...AGENT_BUYS, ...AUGUST_BROKERAGE], AUGUST_PERIOD, /it holds WMT, and no position in this ledger records whether WMT is a stock or an ETF/);
  });

  test("⛔ rows that do not add up to the printed Total Funds Paid and Received withhold the section — a row the reader cannot see is there", () => {
    const dropped = JUNE.filter((l) => l !== ITRF_CREDIT);
    withheldFrom(dropped, JUNE_PERIOD, /add up to \$0\.00 out and \$0\.00 in, but it prints \$0\.00 out and \$26\.64 in/);
  });

  test("⛔ a cash-account section that prints no Total Funds Paid and Received line is withheld", () => {
    const julyWithoutTotals = JULY.filter((l) => !l.text.startsWith("Total Funds Paid and Received"));
    withheldFrom(julyWithoutTotals, JULY_PERIOD, /prints no Total Funds Paid and Received line/);
  });

  test("⛔ securities its Portfolio Summary does not list withhold the section — including a first month whose opening is N/A", () => {
    const julyHolding = swap(quietMonth("07/01/2026 to 07/31/2026"), "Total Securities $0.00 $0.00", line("Total Securities $0.00 $12.34"));
    withheldFrom([...asLines(ERA_C), ...julyHolding], JULY_PERIOD, /its Portfolio Summary lists \$0\.00 of securities, but its Account Summary closes at \$12\.34/);

    const juneHolding = swap(JUNE, "Total Securities N/A $0.00", line("Total Securities N/A $12.34"));
    withheldFrom(juneHolding, JUNE_PERIOD, /its Portfolio Summary lists \$0\.00 of securities, but its Account Summary closes at \$12\.34/);
  });

  test("⛔ a cash-account section that prints no Total Securities line is withheld — nothing then shows it holds only cash", () => {
    // 🔴 measured by a second reader: turning this refusal into a `return` left every test green
    const july = [...asLines(ERA_C), ...quietMonth("07/01/2026 to 07/31/2026").filter((l) => !l.text.startsWith("Total Securities"))];
    withheldFrom(july, JULY_PERIOD, /prints no Total Securities line/);
  });

  test("a section the cash reader cannot read at all is withheld too, with the reader's own words", () => {
    const july = [...asLines(ERA_C), ...quietMonth("07/01/2026 to 07/31/2026").filter((l) => !l.text.startsWith("Net Account Balance"))];
    withheldFrom(july, JULY_PERIOD, /could not be read: No Net Account Balance or Brokerage Cash Balance line/);
  });

  test("⛔ a file with no other tracked section is refused whole, as before — there is nothing beside the section to import", () => {
    const juneHolding = swap(JUNE, "Total Securities N/A $0.00", line("Total Securities N/A $12.34"));
    // the brokerage's #487513525 is untracked here, so #655929651 is the file's only tracked section
    expect(() => robinhoodBrokerageStatements(juneHolding, [CRYPTO, AGENTIC])).toThrow(
      /#655929651's Portfolio Summary totals \$0\.00 of securities against an Account Summary closing of \$12\.34/,
    );
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

  /**
   * A trade executed on the last trading day settles in the NEXT month: it is in no other table this month — the
   * settled cash has not moved, Securities Held does not list it — and next month's Account Activity lists it, dated
   * by its trade date (measured on #487513525: July 2026 printed `Apple Margin Buy 07/31/2026 08/03/2026 5` pending,
   * August's activity carries `AAPL Margin Buy 07/31/2026 5`). So it is read, checked against its own total, and
   * noted beside the month — never posted, or next month would post it a second time.
   */
  test("⛔ a trade pending settlement is read and noted, never posted — the month's cash and positions exclude it", () => {
    const { statements, withheld } = robinhoodBrokerageStatements(juneWithPending([pendingBuy], pendingTotal("$19.50", "$0.00")), TRACKED_ALL);
    expect(withheld).toEqual([]);
    const quietJune = robinhoodBrokerageStatements(JUNE, TRACKED_ALL).statements[2]!;
    expect(statements).toHaveLength(3); // no book: nothing is held and nothing traded that settled
    expect(statements[2]).toEqual({
      ...quietJune,
      pending: [
        {
          side: "Buy",
          description: "SPY",
          tradedOn: "2026-06-29",
          settlesOn: "2026-07-01",
          quantityE8: 3_000_000,
          amountCents: -1950,
          printed: "SPY Cash Buy 06/29/2026 07/01/2026 0.03 $650.00 $19.50",
        },
      ],
    });
  });

  test("⛔ a pending row under $0.00 totals, and non-zero totals with no row, each withhold the section — either half is enough", () => {
    withheldFrom(
      juneWithPending([pendingBuy], pendingTotal("$0.00", "$0.00")),
      JUNE_PERIOD,
      /its trades waiting to settle add up to \$19\.50 out and \$0\.00 in, but it prints \$0\.00 out and \$0\.00 in/,
    );
    withheldFrom(
      juneWithPending([], pendingTotal("$0.00", "$19.50")),
      JUNE_PERIOD,
      /its trades waiting to settle add up to \$0\.00 out and \$0\.00 in, but it prints \$0\.00 out and \$19\.50 in/,
    );
  });

  test("⛔ a cash-account section that prints no pending-trades table is withheld — nothing then shows none is pending", () => {
    const julyWithoutTotal = JULY.filter((l) => !l.text.startsWith("Total Executed Trades Pending Settlement"));
    withheldFrom(julyWithoutTotal, JULY_PERIOD, /prints no Executed Trades Pending Settlement total/);
    const julyWithoutTitle = JULY.filter((l) => l.text !== PENDING_TITLE);
    withheldFrom(julyWithoutTitle, JULY_PERIOD, /prints no Executed Trades Pending Settlement title above/);
  });

  test("the real months' empty pending table, with the page break printed inside it, is nothing pending", () => {
    const june = JUNE.flatMap((l) =>
      l.text === PENDING_TITLE
        ? [l, line("Page 21 of 22"), line("These transactions may not be reflected in the other summaries")]
        : [l],
    );
    expect(robinhoodBrokerageStatements(june, TRACKED_ALL).statements[2]!.ledger).toEqual({ cents: 2664, asOf: "2026-06-30" });
  });

  test("⛔ refuses a section tracked as an account type a brokerage statement cannot be", () => {
    const savings: KnownAccount = { last4: "9651", type: "savings", subtype: null };
    expect(() => robinhoodBrokerageStatements(JUNE, [BROKERAGE, savings])).toThrow(/#655929651.*savings/);
    const secondBrokerage: KnownAccount = { last4: "9651", type: "investment", subtype: "brokerage" };
    expect(() => robinhoodBrokerageStatements(JUNE, [BROKERAGE, secondBrokerage])).toThrow(/more than one.*brokerage/);
  });

  /*
   * ⚖️ The owner, 2026-09-15: when the agent buys a stock, show TWO accounts — Robinhood Agentic keeps the unspent
   * cash, and a brokerage book holds the positions, like Robinhood Cash + Robinhood Brokerage; every statement still
   * proves the cash to the cent.
   *
   * The positions come from the section's own lines and nowhere else, and they must PROVE themselves: what the ledger
   * held before the period, plus every Buy and Sell its Account Activity lists, must equal its Securities Held exactly
   * — the arbiter that reproduces #487513525's printed positions in 24 of 25 consecutive months of the real archive
   * (the miss is COKE's 10-for-1 split, which prints no row, and would be withheld rather than guessed).
   */
  const WMT: Readonly<Record<string, "stock" | "etf">> = { WMT: "stock" };
  const bookHolding = (events: { symbol: string; occurredOn: string; quantityDeltaE8: number }[]): KnownAccount => ({ ...AGENTIC, book: { events } });
  const BOUGHT_IN_AUGUST = [{ symbol: "WMT", occurredOn: "2026-08-20", quantityDeltaE8: 25_000_000 }];
  const agentBook = { institution: "Robinhood", type: "investment", subtype: "brokerage", bookOf: "9651" };

  /** CONSTRUCTED: #487513525 opening September where its real August closed, nothing moving. */
  const SEPTEMBER_BROKERAGE = asLines([
    "09/01/2026 to 09/30/2026",
    "Individual Account #:487513525",
    "Account Summary",
    "Brokerage Cash Balance * $0.68 $0.68",
    "Deposit Sweep Balance $1,000.33 $1,000.33",
    "Total Securities ** $72,959.32 $72,959.32",
    "Portfolio Value $73,960.33 $73,960.33",
  ]);
  const cdiv = line("Cash Div: R/D 2026-08-21 P/D 2026-09-08 - 0.25 shares at 0.2475 WMT Cash CDIV 09/08/2026 $0.06", [
    ["Cash Div: R/D 2026-08-21 P/D 2026-09-08 - 0.25 shares at 0.2475", 36],
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["CDIV", 431.63],
    ["09/08/2026", 534.56],
    ["$0.06", 743.4],
  ]);
  const sell = line("WMT Cash Sell 09/15/2026 0.1 $110.00000 $11.00", [
    ["WMT", 269.66],
    ["Cash", 341.55],
    ["Sell", 431.63],
    ["09/15/2026", 534.56],
    ["0.1", 586.28],
    ["$110.00000", 630.19],
    ["$11.00", 743.4],
  ]);
  /**
   * CONSTRUCTED from #655929651's real August lines: September opens holding the 0.25 WMT bought in August, collects a
   * $0.06 dividend on the 8th and sells 0.1 at $110.00 on the 15th. Cash $1.64 + $0.06 + $11.00 = $12.70; 0.15 WMT at
   * $110.90 = $16.635, printed $16.64.
   */
  const AGENT_SELLS: Line[] = [
    line("09/01/2026 to 09/30/2026"),
    line("Individual Account #:655929651"),
    line("Account Summary"),
    line("Net Account Balance $1.64 $12.70"),
    line("Total Securities $26.22 $16.64"),
    line("Portfolio Value $27.86 $29.34"),
    line("Portfolio Summary"),
    line("Walmart"),
    line("WMT Cash 0.15 $110.90000 $16.64 $0.14 56.71%"),
    line("Estimated Yield: 0.84%"),
    line("Total Securities $16.64 $0.14 56.71%"),
    line("Brokerage Cash Balance $12.70 43.29%"),
    line("Account Activity"),
    headerAt(685.13, 743.4),
    cdiv,
    line("Walmart"),
    sell,
    line("CUSIP: 931142103"),
    totalFunds("$0.00", "$11.06", 685.13, 743.4),
    line("Executed Trades Pending Settlement"),
    line("Total Executed Trades Pending Settlement $0.00 $0.00"),
  ];

  test("⛔ the rehearsal's month: Robinhood Agentic keeps the $1.64 of cash, its book holds the 0.25 WMT — both proven to the cent", () => {
    const { statements, withheld } = robinhoodBrokerageStatements([...AGENT_BUYS, ...AUGUST_BROKERAGE], TRACKED_ALL, WMT);

    expect(withheld).toEqual([]);
    expect(statements).toHaveLength(4); // #655929651 prints first: its cash, its book, then #487513525's two
    expect(statements[0]).toEqual({
      accountHint: { institution: "Robinhood", last4: "9651" },
      txns: [{ postedOn: "2026-08-20", amountCents: -2500, rawDescription: "Walmart", bankCategory: "Buy", categoryPath: "Investments > Buys" }],
      period: { start: "2026-08-01", end: "2026-08-31", beginCents: 2664, endCents: 164 },
    });
    expect(statements[1]).toEqual({
      // the book of the cash account ····9651 — by the stored link, never by a name
      accountHint: agentBook,
      txns: [],
      // Total Securities, the value anchor `pnpm ledger-check` checks the book against
      period: { start: "2026-08-01", end: "2026-08-31", beginCents: 0, endCents: 2622 },
      positions: {
        trades: [
          {
            symbol: "WMT",
            assetType: "stock",
            occurredOn: "2026-08-20",
            tradedOn: "2026-08-20",
            quantityDeltaE8: 25_000_000,
            costCents: 2500,
            printed: "WMT Cash Buy 08/20/2026 0.25 $100.00000 $25.00",
          },
        ],
        held: [{ symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, marketValueCents: 2622 }],
      },
    });
    // #487513525's statements are exactly what the file gives with #655929651 untracked
    expect(statements.slice(2)).toEqual(robinhoodBrokerageStatements([...AGENT_BUYS, ...AUGUST_BROKERAGE], [BROKERAGE, CRYPTO]).statements);
  });

  test("⛔ the next month: the ledger's 0.25 WMT, a Sell of 0.1 and a dividend prove September's 0.15 — the book sells, the cash receives", () => {
    const { statements, withheld } = robinhoodBrokerageStatements([...SEPTEMBER_BROKERAGE, ...AGENT_SELLS], [BROKERAGE, CRYPTO, bookHolding(BOUGHT_IN_AUGUST)], WMT);

    expect(withheld).toEqual([]);
    expect(statements.slice(2)).toEqual([
      {
        accountHint: { institution: "Robinhood", last4: "9651" },
        txns: [
          {
            postedOn: "2026-09-08",
            amountCents: 6,
            rawDescription: "Cash Div: R/D 2026-08-21 P/D 2026-09-08 - 0.25 shares at 0.2475",
            bankCategory: "CDIV",
            categoryPath: "Income > Dividends",
          },
          { postedOn: "2026-09-15", amountCents: 1100, rawDescription: "Walmart", bankCategory: "Sell", categoryPath: "Investments > Sells" },
        ],
        period: { start: "2026-09-01", end: "2026-09-30", beginCents: 164, endCents: 1270 },
      },
      {
        accountHint: agentBook,
        txns: [],
        period: { start: "2026-09-01", end: "2026-09-30", beginCents: 2622, endCents: 1664 },
        positions: {
          // a sale records no cost: proceeds are not what the shares cost, and the book's average cost is walked from its buys
          trades: [
            {
              symbol: "WMT",
              assetType: "stock",
              occurredOn: "2026-09-15",
              tradedOn: "2026-09-15",
              quantityDeltaE8: -10_000_000,
              costCents: null,
              printed: "WMT Cash Sell 09/15/2026 0.1 $110.00000 $11.00",
            },
          ],
          held: [{ symbol: "WMT", assetType: "stock", quantityE8: 15_000_000, marketValueCents: 1664 }],
        },
      },
    ]);
  });

  test("⛔ a Buy dated the previous month's last trading day, settled into this one, is a position from the period's first day", () => {
    // August's pending Buy of 0.05 on Mon 08/31 settles 09/01: September's activity lists it by its TRADE date
    const carried = line("WMT Cash Buy 08/31/2026 0.05 $104.00000 $5.20", [
      ["WMT", 269.66],
      ["Cash", 341.55],
      ["Buy", 431.63],
      ["08/31/2026", 534.56],
      ["0.05", 586.28],
      ["$104.00000", 630.19],
      ["$5.20", 685.13],
    ]);
    const september = AGENT_SELLS.flatMap((l): Line[] => {
      if (l === cdiv) return [line("Walmart"), carried, line("CUSIP: 931142103")];
      if (l === sell) return [];
      if (l.text === "Walmart" || l.text === "CUSIP: 931142103") return [];
      if (l.text.startsWith("Net Account Balance")) return [line("Net Account Balance $6.84 $1.64")];
      if (l.text.startsWith("Total Securities $26.22")) return [line("Total Securities $26.22 $33.27")];
      if (l.text.startsWith("WMT Cash 0.15")) return [line("Walmart"), line("WMT Cash 0.3 $110.90000 $33.27 $0.28 95.30%")];
      if (l.text.startsWith("Total Securities $16.64")) return [line("Total Securities $33.27 $0.28 95.30%")];
      if (l.text.startsWith("Total Funds Paid and Received")) return [totalFunds("$5.20", "$0.00", 685.13, 743.4)];
      return [l];
    });

    const { statements, withheld } = robinhoodBrokerageStatements([...SEPTEMBER_BROKERAGE, ...september], [BROKERAGE, CRYPTO, bookHolding(BOUGHT_IN_AUGUST)], WMT);

    expect(withheld).toEqual([]);
    // the cash row keeps the day it prints (the import files it inside the period); the shares arrive on the 1st,
    // so neither August's printed 0.25 nor September's opening breaks
    expect(statements[2]!.txns.map((t) => [t.postedOn, t.amountCents])).toEqual([["2026-08-31", -520]]);
    expect(statements[3]!.positions!.trades.map((t) => [t.occurredOn, t.tradedOn, t.quantityDeltaE8])).toEqual([["2026-09-01", "2026-08-31", 5_000_000]]);
  });

  test("⛔ a pending Buy at the month's end: the month proves without it, and it is noted beside the cash", () => {
    const pendingBuyLine = line("Cash Buy 09/30/2026 10/01/2026 0.05 $111.00000 $5.55", [
      ["Cash", 190.65],
      ["Buy", 329.1],
      ["09/30/2026", 423.38],
      ["10/01/2026", 511.28],
      ["0.05", 601.09],
      ["$111.00000", 641.33],
      ["$5.55", 691.65],
    ]);
    const withPending = AGENT_SELLS.flatMap((l): Line[] => {
      if (l.text === PENDING_TITLE) {
        return [
          l,
          line("These transactions may not be reflected in the other summaries"),
          line("Description Acct Type Transaction Trade Date Settle Date Qty Price Debit Credit", [
            ["Debit", 691.65],
            ["Credit", 745.05],
          ]),
          line("Walmart"),
          pendingBuyLine,
          line("CUSIP: 931142103"),
        ];
      }
      return l.text.startsWith("Total Executed Trades Pending Settlement") ? [pendingTotal("$5.55", "$0.00")] : [l];
    });
    const tracked = [BROKERAGE, CRYPTO, bookHolding(BOUGHT_IN_AUGUST)];

    const { statements, withheld } = robinhoodBrokerageStatements([...SEPTEMBER_BROKERAGE, ...withPending], tracked, WMT);

    expect(withheld).toEqual([]);
    const without = robinhoodBrokerageStatements([...SEPTEMBER_BROKERAGE, ...AGENT_SELLS], tracked, WMT).statements;
    expect(statements[3]).toEqual(without[3]); // the book: no trade, no share
    const { pending, ...cash } = statements[2]!;
    expect(cash).toEqual(without[2]); // the cash: no row
    expect(pending).toEqual([
      {
        side: "Buy",
        description: "Walmart",
        tradedOn: "2026-09-30",
        settlesOn: "2026-10-01",
        quantityE8: 5_000_000,
        amountCents: -555,
        printed: "Cash Buy 09/30/2026 10/01/2026 0.05 $111.00000 $5.55",
      },
    ]);
  });

  test("⛔ printed positions the ledger's shares plus this month's trades cannot reach are withheld — a split or a transfer is a question, not a guess", () => {
    const september = [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS];
    // the ledger never received August's buy: 0 + (−0.1) is not the printed 0.15
    const read = robinhoodBrokerageStatements(september, [BROKERAGE, CRYPTO, bookHolding([])], WMT);
    expect(read.statements).toEqual(robinhoodBrokerageStatements(september, [BROKERAGE, CRYPTO], WMT).statements);
    expect(read.withheld.map((w) => w.reason)).toEqual([
      "its positions are not what the ledger held before Sep 1, 2026 plus this month's trades (WMT: it prints 0.15, the trades give -0.1) — a split, a transfer or a trade this reader cannot see",
    ]);
  });

  test("⛔ a month whose trades the ledger already holds from another statement file is withheld, never counted twice", () => {
    const september = [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS];
    const twice = [...BOUGHT_IN_AUGUST, { symbol: "WMT", occurredOn: "2026-09-15", quantityDeltaE8: -10_000_000 }];
    const { withheld } = robinhoodBrokerageStatements(september, [BROKERAGE, CRYPTO, bookHolding(twice)], WMT);
    expect(withheld.map((w) => w.reason)).toEqual([
      "the ledger already holds this account's trades for Sep 1 – 30, 2026 from another statement, and a second copy would count its shares twice",
    ]);
  });

  test("an Account Activity code this reader has no place for withholds the section", () => {
    const ach = line("ACH Deposit Cash ACH 09/03/2026 $5.00", [
      ["ACH Deposit", 36],
      ["Cash", 341.55],
      ["ACH", 431.63],
      ["09/03/2026", 534.56],
      ["$5.00", 743.4],
    ]);
    const september = AGENT_SELLS.flatMap((l) => (l === cdiv ? [l, ach] : [l]));
    const { withheld } = robinhoodBrokerageStatements([...SEPTEMBER_BROKERAGE, ...september], [BROKERAGE, CRYPTO, bookHolding(BOUGHT_IN_AUGUST)], WMT);
    expect(withheld.map((w) => w.reason)).toEqual(['it shows activity this reader has no place for ("ACH Deposit Cash ACH 09/03/2026 $5.00")']);
  });

  const septemberWith = (edit: (l: Line) => Line[]): Line[] => [...SEPTEMBER_BROKERAGE, ...AGENT_SELLS.flatMap(edit)];
  const reasonsFor = (doc: Line[], events = BOUGHT_IN_AUGUST): string[] =>
    robinhoodBrokerageStatements(doc, [BROKERAGE, CRYPTO, bookHolding(events)], WMT).withheld.map((w) => w.reason);

  test("a position whose printed value its quantity and price do not make withholds the section — a misread column", () => {
    const doc = septemberWith((l) => (l.text.startsWith("WMT Cash 0.15") ? [line("WMT Cash 0.15 $111.90000 $16.64 $0.14 56.71%")] : [l]));
    expect(reasonsFor(doc)).toEqual([
      'it shows WMT worth $16.64, which its printed quantity and price do not make ("WMT Cash 0.15 $111.90000 $16.64 $0.14 56.71%")',
    ]);
  });

  test("⛔ positions that do not add up to the table's own Total Securities withhold the section — a position this reader cannot see is there", () => {
    // both totals agree with each other; the one row this reader sees does not make them
    const doc = septemberWith((l): Line[] => {
      if (l.text.startsWith("Total Securities $26.22")) return [line("Total Securities $26.22 $20.00")];
      return l.text.startsWith("Total Securities $16.64") ? [line("Total Securities $20.00 $0.17 61.16%")] : [l];
    });
    expect(reasonsFor(doc)).toEqual(["its positions add up to $16.64, but it prints $20.00 of securities — a position this reader cannot see is there"]);
  });

  test("⛔ a Sell printed in the Debit column withholds the section — the column is the only carrier of direction", () => {
    const wrongColumn = line("WMT Cash Sell 09/15/2026 0.1 $110.00000 $11.00", [...sell.tokens.slice(0, 6).map((t): [string, number] => [t.str, t.x]), ["$11.00", 685.13]]);
    const doc = septemberWith((l): Line[] => {
      if (l === sell) return [wrongColumn];
      return l.text.startsWith("Total Funds Paid and Received") ? [totalFunds("$11.00", "$0.06", 685.13, 743.4)] : [l];
    });
    expect(reasonsFor(doc)).toEqual(['it shows a sale in the wrong column ("WMT Cash Sell 09/15/2026 0.1 $110.00000 $11.00")']);
  });

  test("⛔ securities at the opening with no position in the ledger behind them withhold the section, even when nothing is left at the close", () => {
    // everything the agent held left without a trade row — a transfer out, which Account Activity does not list
    const doc = septemberWith((l): Line[] => {
      if (l === cdiv || l === sell || l.text === "Walmart" || l.text === "CUSIP: 931142103") return [];
      if (l.text.startsWith("WMT Cash 0.15") || l.text.startsWith("Estimated Yield")) return [];
      if (l.text.startsWith("Net Account Balance")) return [line("Net Account Balance $1.64 $1.64")];
      if (l.text.startsWith("Total Securities $26.22")) return [line("Total Securities $26.22 $0.00")];
      if (l.text.startsWith("Total Securities $16.64")) return [line("Total Securities $0.00 $0.00 0.00%")];
      return l.text.startsWith("Total Funds Paid and Received") ? [totalFunds("$0.00", "$0.00", 685.13, 743.4)] : [l];
    });
    expect(reasonsFor(doc, [])).toEqual(["it opens with $26.22 of securities, and the ledger holds no position for it before Sep 1, 2026"]);
  });

  test("⛔ a month's trades are withheld once the ledger holds a LATER month — those positions were proven without them", () => {
    const later = [...BOUGHT_IN_AUGUST, { symbol: "WMT", occurredOn: "2026-10-02", quantityDeltaE8: 5_000_000 }];
    expect(reasonsFor([...SEPTEMBER_BROKERAGE, ...AGENT_SELLS], later)).toEqual([
      "the ledger already holds this account's trades from a later statement, and those were proven without this month's",
    ]);
  });

  test("a trade dated after the section's own period withholds it", () => {
    const future = line("WMT Cash Sell 10/01/2026 0.1 $110.00000 $11.00", sell.tokens.map((t): [string, number] => [t.str === "09/15/2026" ? "10/01/2026" : t.str, t.x]));
    expect(reasonsFor(septemberWith((l) => (l === sell ? [future] : [l])))).toEqual([
      'it lists a trade dated after its own period ("WMT Cash Sell 10/01/2026 0.1 $110.00000 $11.00")',
    ]);
  });

  test("a position line this reader cannot read withholds the section rather than dropping a share", () => {
    const cusipOnly = AGENT_SELLS.map((l) => (l.text.startsWith("WMT Cash 0.15") ? line("931142103 Cash 0.15 $110.90000 $16.64 $0.14 56.71%") : l));
    const { withheld } = robinhoodBrokerageStatements([...SEPTEMBER_BROKERAGE, ...cusipOnly], [BROKERAGE, CRYPTO, bookHolding(BOUGHT_IN_AUGUST)], WMT);
    expect(withheld.map((w) => w.reason)).toEqual([
      'it shows a line among its positions this reader cannot read ("931142103 Cash 0.15 $110.90000 $16.64 $0.14 56.71%")',
    ]);
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
