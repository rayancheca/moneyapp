import { describe, expect, test } from "vitest";
import { RECONCILIATION_STATES } from "@/db/schema/imports";
import { PROFILES } from "@/services/import/profiles";
import { OPENING_STATEMENT_PROFILES, carriesBalances, countsAsStatement } from "./statements-by-account";

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
