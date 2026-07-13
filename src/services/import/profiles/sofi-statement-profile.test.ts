import { describe, expect, test } from "vitest";
import { ParseError } from "../types";
import { parseSofiCombinedLines } from "./sofi-statement-profile";

/**
 * Hand-authored line fixtures mirroring the REAL SoFi combined-statement layout
 * (decoded from data/inbox/sofi/combined/*.pdf via extractLines — the PDFs stay
 * out of git). Each section is anchored on "Primary Account Holder Address
 * Account Number", prints its period inline on the address line, and lists
 * transactions NEWEST-FIRST with a per-row running balance, each trailed by a
 * "Transaction ID:" line and interrupted by page-break footers + a repeated
 * account header. Amounts are net-worth-signed (deposits +, withdrawals −).
 */

// checking: begin 100.00 → +20 (Apr 10) → −70 (Apr 20) → end 50.00
const CHECKING_SECTION = [
  "Primary Account Holder Address Account Number",
  "Rayan Karim Checa 2425 HOFFMAN ST APT 2 411016429067",
  "Member since Oct 27, 2023 Monthly Statement Period",
  "BRONX, NY 10458 Apr 1, 2026 - Apr 30, 2026",
  "Checking Account - 9067",
  "Current Balance Monthly Interest Paid Annual Percentage Yield Earned",
  "$50.00 $0.00 0.00%",
  "as of Apr 30, 2026",
  "Beginning Balance Year-to-date Interest Paid",
  "$100.00 $0.01",
  "as of Apr 1, 2026",
  "Current balances include the amount of interest paid.",
  "Transaction Details",
  "Balances below are the total funds resulting from the transaction(s) posted on that day.",
  "Checking Account - 9067",
  "DATE TYPE DESCRIPTION AMOUNT BALANCE",
  "Apr 20, 2026 Direct Payment Zelle® Payment to Rayan -$70.00 $50.00",
  "Transaction ID: 1081-117360001",
  // page break: footer then a repeated section header, neither is a transaction
  "SoFi Checking and Savings accounts are offered through SoFi Bank, N.A., Member FDIC Page 1 of 2",
  "Checking Account - 9067",
  "Apr 10, 2026 Deposit From Savings - 5791 $20.00 $120.00",
  "Transaction ID: 1080-456914002",
];

// savings: begin 1000.00 → −450 (Apr 5) → +497.88 (Apr 15) → +2.12 interest (Apr 30) → end 1050.00
const SAVINGS_SECTION = [
  "Primary Account Holder Address Account Number",
  "Rayan Karim Checa 2425 HOFFMAN ST APT 2 310022475791",
  "Member since Oct 27, 2023 Monthly Statement Period",
  "BRONX, NY 10458 Apr 1, 2026 - Apr 30, 2026",
  "Savings Account - 5791",
  "Current Balance Monthly Interest Paid Annual Percentage Yield Earned",
  "$1,050.00 $2.12 3.30%",
  "as of Apr 30, 2026",
  "Beginning Balance Year-to-date Interest Paid",
  "$1,000.00 $4.55",
  "as of Apr 1, 2026",
  "Transaction Details",
  "Savings Account - 5791",
  "DATE TYPE DESCRIPTION AMOUNT BALANCE",
  "Apr 30, 2026 Interest Earned Interest earned $2.12 $1,050.00",
  "Transaction ID: 1151-1",
  "Apr 15, 2026 Direct Deposit FORDHAM UNIVERSI PAYROLL $497.88 $1,047.88",
  "Transaction ID: 1144-16258001",
  "Apr 5, 2026 Withdrawal To Checking - 9067 -$450.00 $550.00",
  "Transaction ID: 1135-368013001",
];

const COMBINED = [...CHECKING_SECTION, ...SAVINGS_SECTION];

describe("parseSofiCombinedLines", () => {
  test("splits a combined statement into a checking and a savings section", () => {
    const { checking, savings } = parseSofiCombinedLines(COMBINED);
    expect(checking?.type).toBe("checking");
    expect(checking?.last4).toBe("9067");
    expect(savings?.type).toBe("savings");
    expect(savings?.last4).toBe("5791");
  });

  test("extracts the inline period and the first printed balance token per section", () => {
    const { checking, savings } = parseSofiCombinedLines(COMBINED);
    expect(checking?.periodStart).toBe("2026-04-01");
    expect(checking?.periodEnd).toBe("2026-04-30");
    expect(checking?.beginningBalanceCents).toBe(10000);
    expect(checking?.endingBalanceCents).toBe(5000);
    // savings balances carry a thousands comma and interest trailing columns
    expect(savings?.beginningBalanceCents).toBe(100000);
    expect(savings?.endingBalanceCents).toBe(105000);
  });

  test("preserves the newest-first row order the statement prints", () => {
    const { savings } = parseSofiCombinedLines(COMBINED);
    expect(savings?.txns.map((t) => t.postedOn)).toEqual(["2026-04-30", "2026-04-15", "2026-04-05"]);
  });

  test("signs deposits positive and withdrawals/payments negative (net-worth convention)", () => {
    const { checking, savings } = parseSofiCombinedLines(COMBINED);
    const payment = checking?.txns.find((t) => t.rawDescription.includes("Zelle"));
    expect(payment?.amountCents).toBe(-7000);
    const deposit = checking?.txns.find((t) => t.rawDescription.includes("Deposit From Savings"));
    expect(deposit?.amountCents).toBe(2000);
    const payroll = savings?.txns.find((t) => t.rawDescription.includes("PAYROLL"));
    expect(payroll?.amountCents).toBe(49788);
    const withdrawal = savings?.txns.find((t) => t.rawDescription.includes("Withdrawal"));
    expect(withdrawal?.amountCents).toBe(-45000);
  });

  test("uses the whole TYPE + DESCRIPTION span as rawDescription", () => {
    const { checking } = parseSofiCombinedLines(COMBINED);
    const payment = checking?.txns.find((t) => t.amountCents === -7000);
    expect(payment?.rawDescription).toBe("Direct Payment Zelle® Payment to Rayan");
  });

  test("captures the trailing Transaction ID as fitid and never as a transaction", () => {
    const { checking } = parseSofiCombinedLines(COMBINED);
    // exactly two rows survive across the page-break footer + repeated header
    expect(checking?.txns.length).toBe(2);
    const payment = checking?.txns.find((t) => t.amountCents === -7000);
    expect(payment?.fitid).toBe("1081-117360001");
    const deposit = checking?.txns.find((t) => t.amountCents === 2000);
    expect(deposit?.fitid).toBe("1080-456914002");
  });

  test("reconciles both sections to the cent (no throw)", () => {
    expect(() => parseSofiCombinedLines(COMBINED)).not.toThrow();
    const { checking, savings } = parseSofiCombinedLines(COMBINED);
    const sum = (t: { amountCents: number }[]) => t.reduce((a, x) => a + x.amountCents, 0);
    expect(checking!.beginningBalanceCents + sum(checking!.txns)).toBe(checking!.endingBalanceCents);
    expect(savings!.beginningBalanceCents + sum(savings!.txns)).toBe(savings!.endingBalanceCents);
  });

  test("throws when a section does not reconcile to the printed balance", () => {
    // tamper the Current Balance so Beginning + Σamounts ≠ ending
    const broken = COMBINED.map((l) => (l === "$50.00 $0.00 0.00%" ? "$60.00 $0.00 0.00%" : l));
    expect(() => parseSofiCombinedLines(broken)).toThrow(ParseError);
  });

  test("throws when a printed running balance is internally inconsistent", () => {
    // break the mid-chain balance without touching begin/end totals
    const broken = COMBINED.map((l) =>
      l === "Apr 15, 2026 Direct Deposit FORDHAM UNIVERSI PAYROLL $497.88 $1,047.88"
        ? "Apr 15, 2026 Direct Deposit FORDHAM UNIVERSI PAYROLL $497.88 $1,099.99"
        : l,
    );
    expect(() => parseSofiCombinedLines(broken)).toThrow(ParseError);
  });

  test("accepts a zero-activity section only when Beginning equals Current", () => {
    const emptyOk = [
      "Primary Account Holder Address Account Number",
      "Rayan Karim Checa 2425 HOFFMAN ST APT 2 411016429067",
      "BRONX, NY 10458 Jun 1, 2026 - Jun 30, 2026",
      "Checking Account - 9067",
      "Current Balance Monthly Interest Paid Annual Percentage Yield Earned",
      "$0.01 $0.00 0.00%",
      "Beginning Balance Year-to-date Interest Paid",
      "$0.01 $0.00",
      "DATE TYPE DESCRIPTION AMOUNT BALANCE",
    ];
    expect(parseSofiCombinedLines(emptyOk).checking?.txns).toEqual([]);

    const emptyBroken = emptyOk.map((l) => (l === "$0.01 $0.00" ? "$99.00 $0.00" : l));
    expect(() => parseSofiCombinedLines(emptyBroken)).toThrow(ParseError);
  });

  test("throws when the 'Primary Account Holder' anchor is absent", () => {
    expect(() => parseSofiCombinedLines(["Checking Account - 9067", "$0.00 $0.00"])).toThrow(ParseError);
  });
});
