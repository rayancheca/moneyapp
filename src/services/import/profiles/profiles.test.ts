import { describe, expect, test } from "vitest";
import type { ParsedStatement, SniffedFile } from "../types";
import { capitalOneStatementPdf, parseCapitalOneLines } from "./capitalone-statement-profile";
import { chaseDepositCsv, robinhoodActivityCsv, sofiCsv } from "./csv-profiles";
import { chaseSpendingReportPdf, parseSpendingReportLines } from "./spending-report-profile";

/* ── Chase spending-report PDF (text-level core) ────────────────────── */

const REPORT_LINES = [
  "07-10-2026",
  "AUTOMOTIVE",
  "Transaction Date Posted Date Description Amount",
  "May 10, 2026 May 12, 2026 U-HAUL MOVING & STORAGE A $155.94",
  "Total $155.94",
  "BILLS_AND_UTILITIES",
  "Transaction Date Posted Date Description Amount",
  "Jan 09, 2026 Jan 11, 2026 Spotify P3E3F4E925 $5.99",
  "Feb 09, 2026 Feb 10, 2026 Spotify P3F328A528 -$5.99",
  "Total $39.94",
  "Jan 01, 2026 to Jul 10, 2026 Spending Report 9805 11",
  "JPMorgan Chase Bank, N.A. Member FDIC",
];

describe("parseSpendingReportLines", () => {
  test("parses rows under their category bucket with flipped signs", () => {
    const parsed = parseSpendingReportLines(REPORT_LINES);

    expect(parsed.txns).toHaveLength(3);
    const uhaul = parsed.txns[0]!;
    expect(uhaul).toEqual({
      transactedOn: "2026-05-10",
      postedOn: "2026-05-12",
      amountCents: -15_594, // charge → money out
      rawDescription: "U-HAUL MOVING & STORAGE A",
      bankCategory: "AUTOMOTIVE",
    });
    expect(parsed.txns[1]!.bankCategory).toBe("BILLS_AND_UTILITIES");
    // printed refund (negative) flips back to an inflow
    expect(parsed.txns[2]!.amountCents).toBe(599);
  });

  test("extracts the declared range and the card identifier from the footer", () => {
    const parsed = parseSpendingReportLines(REPORT_LINES);
    expect(parsed.rangeStart).toBe("2026-01-01");
    expect(parsed.rangeEnd).toBe("2026-07-10");
    expect(parsed.last4).toBe("9805");
  });

  test("skips column headers, totals, and footers without inventing rows", () => {
    const parsed = parseSpendingReportLines(REPORT_LINES);
    for (const t of parsed.txns) {
      expect(t.rawDescription).not.toMatch(/Total|Transaction Date|JPMorgan/);
    }
  });

  test("throws when the range footer is missing (not a spending report)", () => {
    expect(() =>
      parseSpendingReportLines(["AUTOMOTIVE", "May 10, 2026 May 12, 2026 X $1.00"]),
    ).toThrow(/not a Chase spending report/);
  });

  test("throws when no rows parse", () => {
    expect(() =>
      parseSpendingReportLines(["Jan 01, 2026 to Jul 10, 2026 Spending Report 9805 1"]),
    ).toThrow(/No transaction rows/);
  });

  test("profile matches by filename, pdf format only", () => {
    const pdf = (name: string): SniffedFile => ({ name, buffer: Buffer.alloc(0), format: "pdf", text: "" });
    expect(chaseSpendingReportPdf.matches(pdf("Spending Report PDF.pdf"))).toBe(true);
    expect(chaseSpendingReportPdf.matches(pdf("Spending Report PDF (1).pdf"))).toBe(true);
    expect(chaseSpendingReportPdf.matches(pdf("20260630-statements-3522-.pdf"))).toBe(false);
    expect(chaseSpendingReportPdf.matches({ ...pdf("Spending Report.csv"), format: "csv" })).toBe(false);
  });
});

/* ── Chase deposit CSV — blank running balances (real-export quirk) ──── */

const CSV_HEADER = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #";

function csvFile(rows: string[]): SniffedFile {
  const text = [CSV_HEADER, ...rows].join("\n");
  return { name: "Chase3522_Activity_20260710.CSV", buffer: Buffer.from(text), format: "csv", text };
}

describe("chaseDepositCsv — blank balances", () => {
  test("pending rows without a balance parse, and the chain spans them", () => {
    // newest-first, like real exports; middle row has no printed balance
    const [statement] = chaseDepositCsv.parse(
      csvFile([
        'DEBIT,07/10/2026,"PENDING ACH",-14.21,ACH_DEBIT, ,,',
        'DEBIT,07/08/2026,"CARD PURCHASE",-50.00,DEBIT_CARD, ,,',
        'CREDIT,07/07/2026,"DEPOSIT",150.00,MISC_CREDIT,1120.90,,',
        'DEBIT,07/06/2026,"COFFEE",-4.10,DEBIT_CARD,970.90,,',
      ]),
    ) as ParsedStatement[];

    expect(statement!.txns).toHaveLength(4);
    // ledger = newest PRINTED balance, not the blank pending rows
    expect(statement!.ledger).toEqual({ cents: 112_090, asOf: "2026-07-07" });
  });

  test("a broken chain across a blank row still fails loudly", () => {
    expect(() =>
      chaseDepositCsv.parse(
        csvFile([
          'CREDIT,07/07/2026,"DEPOSIT",150.00,MISC_CREDIT,1120.90,,',
          'DEBIT,07/06/2026,"MYSTERY", -4.10,DEBIT_CARD, ,,',
          'DEBIT,07/05/2026,"COFFEE",-4.10,DEBIT_CARD,900.00,,',
        ]),
      ),
    ).toThrow(/Running balance breaks/);
  });

  test("an all-blank balance column yields no ledger anchor", () => {
    const [statement] = chaseDepositCsv.parse(
      csvFile(['DEBIT,07/06/2026,"COFFEE",-4.10,DEBIT_CARD, ,,']),
    ) as ParsedStatement[];
    expect(statement!.ledger).toBeUndefined();
  });
});

/* ── Robinhood activity CSV — real-export quirks ─────────────────────── */

const RH_HEADER =
  '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"';

function rhFile(rows: string[]): SniffedFile {
  const text = [RH_HEADER, ...rows].join("\n");
  return { name: "19f645c5 (1).csv", buffer: Buffer.from(text), format: "csv", text };
}

describe("robinhoodActivityCsv — real-export quirks", () => {
  test("non-zero-padded dates parse instead of being silently dropped", () => {
    const [statement] = robinhoodActivityCsv.parse(
      rhFile(['"6/5/2026","6/5/2026","6/5/2026","","Stock Lending","SLIP","","","$0.01"']),
    ) as ParsedStatement[];
    expect(statement!.txns).toHaveLength(1);
    expect(statement!.txns[0]!.postedOn).toBe("2026-06-05");
  });

  test("multi-line quoted descriptions flatten to one line", () => {
    const [statement] = robinhoodActivityCsv.parse(
      rhFile([
        '"6/4/2026","6/4/2026","6/5/2026","MRVL","Marvell Technology\nCUSIP: 573874104","Sell","9","$285.48","$2,569.26"',
      ]),
    ) as ParsedStatement[];
    const txn = statement!.txns[0]!;
    expect(txn.rawDescription).toBe("Marvell Technology CUSIP: 573874104 (MRVL)");
    expect(txn.amountCents).toBe(256_926);
    expect(txn.categoryPath).toBe("Investments > Sells");
  });

  test("transfer-code rows stay unpaired but fee riders categorize as fees", () => {
    const [statement] = robinhoodActivityCsv.parse(
      rhFile([
        '"6/2/2026","6/2/2026","6/2/2026","","Instant bank transfer - withdrawal fee","RTP","","","($4.95)"',
        '"6/2/2026","6/2/2026","6/2/2026","","Instant bank transfer - account ending in 3522","RTP","","","($277.97)"',
        '"6/5/2026","6/5/2026","6/5/2026","","Transfer from Brokerage to Brokerage","ITRF","","","($26.64)"',
        '"5/1/2026","5/1/2026","5/1/2026","","External debit card transfer - account ending in 4918","DCF","","","$50.00"',
      ]),
    ) as ParsedStatement[];
    const [fee, transfer, itrf, dcf] = statement!.txns;
    expect(fee!.categoryPath).toBe("Fees > Bank Fees");
    expect(fee!.amountCents).toBe(-495); // ($4.95) parses negative
    expect(transfer!.categoryPath).toBeUndefined();
    expect(itrf!.categoryPath).toBeUndefined();
    expect(dcf!.categoryPath).toBeUndefined();
  });

  test("amount-less rows (stock splits) skip; dateless disclaimer rows skip; junk dates throw", () => {
    const [statement] = robinhoodActivityCsv.parse(
      rhFile([
        '"6/1/2026","6/1/2026","6/1/2026","COKE","Coca-Cola Consolidated\nCUSIP: 191098102","SPL","32.98","",""',
        '"","","","","Disclaimer: something legal","","","",""',
      ]),
    ) as ParsedStatement[];
    expect(statement!.txns).toHaveLength(0);

    expect(() =>
      robinhoodActivityCsv.parse(
        rhFile(['"not-a-date","","","","X","SLIP","","","$1.00"']),
      ),
    ).toThrow(/Bad Activity Date/);
  });

  test("unknown trans codes still refuse to guess", () => {
    expect(() =>
      robinhoodActivityCsv.parse(
        rhFile(['"6/1/2026","","","","Mystery","WAT","","","$1.00"']),
      ),
    ).toThrow(/Unknown Trans Code/);
  });
});

/* ── SoFi CSV — real-export quirks ───────────────────────────────────── */

const SOFI_HEADER = "Date,Description,Type,Amount,Current balance,Status";

function sofiFile(rows: string[], name = "SOFI-Savings•5791-2026-07-10.csv"): SniffedFile {
  const text = [SOFI_HEADER, ...rows].join("\n");
  return { name, buffer: Buffer.from(text), format: "csv", text };
}

describe("sofiCsv — real-export quirks", () => {
  test("canceled deposits are informational no-ops the chain skips", () => {
    // newest-first: real deposit lands on 150; the canceled row (printed
    // balance 0, amount never applied) sits between two chained rows
    const [statement] = sofiCsv.parse(
      sofiFile([
        "2025-04-05,JPMORGAN CHASE BANK NA,DEPOSIT,50.00,150,Posted",
        '2025-04-04,"Canceled deposit from JPMORGAN CHASE BANK, NA",DEPOSIT,489.9,0,Posted',
        "2025-04-03,Knack Payout,DEPOSIT,100.00,100,Posted",
      ]),
    ) as ParsedStatement[];
    expect(statement!.txns).toHaveLength(2);
    expect(statement!.txns.some((t) => t.rawDescription.startsWith("Canceled"))).toBe(false);
    expect(statement!.ledger).toEqual({ cents: 15_000, asOf: "2025-04-05" });
  });

  test("a genuine drain to zero chain-validates (0 is a real balance)", () => {
    const [statement] = sofiCsv.parse(
      sofiFile([
        "2026-01-21,CAPITAL ONE,DIRECT_PAY,-291,0,Posted",
        "2026-01-21,FORDHAM UNIVERSI,DEPOSIT,291,291,Posted",
      ]),
    ) as ParsedStatement[];
    expect(statement!.txns).toHaveLength(2);
    expect(statement!.ledger).toEqual({ cents: 0, asOf: "2026-01-21" });
  });

  test("interest maps to Income > Interest; ATM withdrawals to Cash & ATM; last4 from the filename", () => {
    const [statement] = sofiCsv.parse(
      sofiFile(
        [
          "2026-05-31,Interest earned,INTEREST_EARNED,0.10,100.10,Posted",
          "2026-05-30,ATM withdrawal,ATM,-40.00,100,Posted",
          "2026-05-29,ATM cash deposit,ATM,140.00,140,Posted",
        ],
        "SOFI-Checking•9067-2026-07-10.csv",
      ),
    ) as ParsedStatement[];
    const [interest, withdrawal, deposit] = statement!.txns;
    expect(interest!.categoryPath).toBe("Income > Interest");
    expect(withdrawal!.categoryPath).toBe("Cash & ATM > ATM Withdrawals");
    expect(deposit!.categoryPath).toBeUndefined(); // the Salary rule owns cash deposits
    expect(statement!.accountHint.last4).toBe("9067");
    expect(statement!.accountHint.type).toBe("checking");
  });

  test("pending rows never import", () => {
    const [statement] = sofiCsv.parse(
      sofiFile([
        "2026-06-01,Coffee,DEBIT_CARD,-4.00,96,Posted",
        "2026-06-02,Pending thing,DEBIT_CARD,-10.00,86,Pending",
      ]),
    ) as ParsedStatement[];
    expect(statement!.txns).toHaveLength(1);
  });

  test("deposit reversals flip sign — the export prints the original's magnitude", () => {
    const [statement] = sofiCsv.parse(
      sofiFile([
        "2025-04-09,Reversal of deposit from CAPITAL ONE N.A.,DEPOSIT,3,97,Posted",
        "2025-04-08,CAPITAL ONE N.A.,DEPOSIT,3,100,Posted",
        "2025-04-07,Knack Payout,DEPOSIT,97.00,97,Posted",
      ]),
    ) as ParsedStatement[];
    const reversal = statement!.txns.find((t) => t.rawDescription.startsWith("Reversal"))!;
    expect(reversal.amountCents).toBe(-300);
    expect(statement!.ledger).toEqual({ cents: 9_700, asOf: "2025-04-09" });
  });
});

/* ── Capital One statement PDF (text-level core) ─────────────────────── */

const CAPONE_LINES = [
  "Account Summary Previous Balance $43.17 Payments - $3,120.62",
  "New Balance = -$140.59 Credit Limit $40,000.00",
  "Venture X Card | Visa Infinite ending in 4147",
  "May 15, 2026 - Jun 13, 2026 | 30 days in Billing Cycle",
  "Pay or manage your account at capitalone.com",
  "New Balance - $140.59 Minimum Payment Due $0.00", // payment slip — ambiguous, must be ignored
  "Trans Date Post Date Description Amount",
  "May 21 May 21 CAPITAL ONE MOBILE PYMT - $43.17",
  "May 14 May 15 CHELSEA DELI CORPNEW YORKNY $14.03",
  "Jun 5 Jun 5 UBER *TRIPHELP.UBER.COMCA $62.41",
];

describe("parseCapitalOneLines", () => {
  test("period, balances (summary '=' form, never the payment slip), card and name", () => {
    const parsed = parseCapitalOneLines(CAPONE_LINES);
    expect(parsed.periodStart).toBe("2026-05-15");
    expect(parsed.periodEnd).toBe("2026-06-13");
    expect(parsed.previousBalanceCents).toBe(4_317);
    expect(parsed.newBalanceCents).toBe(-14_059); // overpaid → credit balance
    expect(parsed.last4).toBe("4147");
    expect(parsed.isVentureX).toBe(true);
  });

  test("yearless activity dates inherit the cycle year; signs flip to canonical", () => {
    const parsed = parseCapitalOneLines(CAPONE_LINES);
    const payment = parsed.txns.find((t) => t.rawDescription.includes("MOBILE PYMT"))!;
    const charge = parsed.txns.find((t) => t.rawDescription.includes("CHELSEA"))!;
    expect(payment.amountCents).toBe(4_317); // "- $43.17" printed → money in
    expect(charge.amountCents).toBe(-1_403); // "$14.03" printed → money out
    expect(charge.transactedOn).toBe("2026-05-14");
    expect(charge.postedOn).toBe("2026-05-15");
    expect(parsed.txns.find((t) => t.rawDescription.includes("UBER"))!.postedOn).toBe("2026-06-05");
  });

  test("a December–January cycle wraps yearless dates correctly", () => {
    const parsed = parseCapitalOneLines([
      "Account Summary Previous Balance $100.00",
      "New Balance = $150.00",
      "Dec 15, 2025 - Jan 13, 2026 | 30 days in Billing Cycle capitalone.com #4147",
      "Dec 20 Dec 21 LATE DECEMBER CHARGE $25.00",
      "Jan 2 Jan 3 EARLY JANUARY CHARGE $25.00",
    ]);
    expect(parsed.txns[0]!.postedOn).toBe("2025-12-21");
    expect(parsed.txns[1]!.postedOn).toBe("2026-01-03");
  });

  test("refuses non-Capital-One content and missing periods loudly", () => {
    expect(() => parseCapitalOneLines(["Some Chase thing $1.00"])).toThrow(/Not a Capital One/);
    expect(() =>
      parseCapitalOneLines(["capitalone.com", "New Balance = $1.00", "Previous Balance $1.00"]),
    ).toThrow(/No billing-cycle period/);
  });

  test("profile matches Capital One's download naming and the inbox rename convention", () => {
    const pdf = (name: string): SniffedFile => ({ name, buffer: Buffer.alloc(0), format: "pdf", text: "" });
    expect(capitalOneStatementPdf.matches(pdf("Statement_062026_4208.pdf"))).toBe(true);
    expect(capitalOneStatementPdf.matches(pdf("capitalone-venturex-statement-2026-06.pdf"))).toBe(true);
    expect(capitalOneStatementPdf.matches(pdf("Spending Report PDF.pdf"))).toBe(false);
  });
});
