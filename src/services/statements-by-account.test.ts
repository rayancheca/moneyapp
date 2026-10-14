import { describe, expect, test } from "vitest";
import { RECONCILIATION_STATES } from "@/db/schema/imports";
import { PROFILES } from "@/services/import/profiles";
import {
  OPENING_STATEMENT_PROFILES,
  balanceLessKind,
  carriesBalances,
  countsAsStatement,
  isOpeningStatement,
} from "./statements-by-account";

/**
 * Which `statement_periods` rows are statements (the schedule and Missing statements) and which printed balances
 * ("What the statements proved" and its tiles) — two questions, and a Robinhood opening statement is where they part.
 */
describe("countsAsStatement", () => {
  test("every state that printed balances is a statement, whatever read it", () => {
    for (const reconciliation of RECONCILIATION_STATES.filter((s) => s !== "not_applicable")) {
      expect(countsAsStatement({ reconciliation, parserProfile: null })).toBe(true);
      expect(countsAsStatement({ reconciliation, parserProfile: "chase-spending-report-pdf" })).toBe(true);
    }
  });

  test("⛔ a balance-less period is a statement only when its file is a statement whose first month prints no opening", () => {
    const of = (parserProfile: string | null) => countsAsStatement({ reconciliation: "not_applicable", parserProfile });
    expect(of("robinhood-brokerage-statement-pdf")).toBe(true);
    // the 8512476 rule, held: a Spending Report, a Rocket Money CSV, an OFX download, a file of no known kind
    expect(of("chase-spending-report-pdf")).toBe(false);
    expect(of("rocket-money-csv")).toBe(false);
    expect(of("ofx-generic")).toBe(false);
    expect(of(null)).toBe(false);
  });

  test("🔴 every profile named there is one the import has — a renamed parser must not drop its opening statements", () => {
    const ids = new Set(PROFILES.map((p) => p.id));
    expect([...OPENING_STATEMENT_PROFILES].filter((id) => !ids.has(id))).toEqual([]);
    expect(OPENING_STATEMENT_PROFILES.size).toBeGreaterThan(0);
  });
});

describe("carriesBalances", () => {
  test("an opening statement is a statement, but it printed no balances to prove anything with", () => {
    expect(carriesBalances("not_applicable")).toBe(false);
    expect(countsAsStatement({ reconciliation: "not_applicable", parserProfile: "robinhood-brokerage-statement-pdf" })).toBe(true);
    for (const state of RECONCILIATION_STATES.filter((s) => s !== "not_applicable")) expect(carriesBalances(state)).toBe(true);
  });
});

describe("isOpeningStatement", () => {
  test("a statement that printed no balances — never one that did, never a report", () => {
    const opening = "robinhood-brokerage-statement-pdf";
    const balanceLess = (parserProfile: string | null) =>
      isOpeningStatement({ reconciliation: "not_applicable", parserProfile });
    expect(balanceLess(opening)).toBe(true);
    // a Robinhood statement that printed both balances is a statement, but no opening one
    for (const reconciliation of RECONCILIATION_STATES.filter((s) => s !== "not_applicable")) {
      expect(isOpeningStatement({ reconciliation, parserProfile: opening })).toBe(false);
    }
    expect(balanceLess("chase-spending-report-pdf")).toBe(false);
    expect(balanceLess(null)).toBe(false);
  });
});

/**
 * What a period that printed no balances IS — four kinds, and every reader names one by this: the period line on a
 * row's and a day's sheet, the period's own sheet, and /imports' footer.
 *
 * 🔴 The review of 601f155, on a copy of data/e2e.db (2026-10-12): an OFX download declares its days and records the
 * account's balance (LEDGERBAL, an `ofx_ledger` anchor of the same file), yet its period line read "this file carries
 * no balances to check against" under that file's "balance recorded on Sep 30, 2024" — 18 of the fixture's 27
 * balance-less periods. The state cannot tell them apart, nor can the parser; what the file recorded for the account
 * can.
 */
describe("balanceLessKind", () => {
  const of = (parserProfile: string | null, recordedOn: string | null) =>
    balanceLessKind({ reconciliation: "not_applicable", parserProfile, recordedOn });

  test("a period that printed balances is none of them", () => {
    for (const reconciliation of RECONCILIATION_STATES.filter((s) => s !== "not_applicable")) {
      expect(balanceLessKind({ reconciliation, parserProfile: "ofx-generic", recordedOn: "2024-09-30" })).toBeNull();
    }
  });

  test("🔴 a file that recorded the account's balance — whatever read it — is not one that carries none", () => {
    expect(of("ofx-generic", "2024-09-30")).toBe("balance_recorded");
    expect(of("chase-spending-report-pdf", null)).toBe("no_balance");
    expect(of(null, "2024-09-30")).toBe("balance_recorded");
  });

  /*
   * 🔴 …and a download the ledger keeps no balance of was the kind a Spending Report is. 74f25fb told the two apart in
   * /imports' footer by reading the parser beside this rule, so the footer said "9 imported downloads left the ledger
   * no balance of their own" while every sheet that reads this kind still said of the same files "coverage declared,
   * but this file carries no balances to check against" — each printed a LEDGERBAL its quarter's CSV re-recorded
   * (measured on a copy of data/e2e.db 2026-10-14, Chase8721_Activity_2026-04-01_2026-06-30.QFX among them). The kind
   * tells them apart now, for every reader.
   */
  test("🔴 a download the ledger keeps no balance of is its own kind — never a report's", () => {
    expect(of("ofx-generic", null)).toBe("download_no_balance");
    for (const report of ["chase-spending-report-pdf", "rocket-money-csv", "chase-deposit-csv", null]) {
      expect(of(report, null)).toBe("no_balance");
    }
  });

  test("an account's opening statement stays a statement, though its file recorded the close", () => {
    // Robinhood Agentic, Jun 2026: `N/A` printed for the opening, the Jun 30 close an anchor of the same PDF
    expect(of("robinhood-brokerage-statement-pdf", "2026-06-30")).toBe("opening_statement");
    expect(of("robinhood-brokerage-statement-pdf", null)).toBe("opening_statement");
  });
});
