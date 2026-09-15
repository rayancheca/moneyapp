import { describe, expect, test } from "vitest";
import { formatDayLong } from "./format-date";
import { unbankedIncomeFrontierClause, type UnbankedIncomeReading } from "./unbanked-income";

const clause = (occurrenceCount: number, checkedOccurrenceCount: number, checkedThrough: string | null): string | null =>
  unbankedIncomeFrontierClause({ occurrenceCount, checkedOccurrenceCount, checkedThrough } satisfies UnbankedIncomeReading, formatDayLong);

/**
 * 🔴 /budgets and /recurring said September's two paydays passed "with no
 * deposit", and /recurring called them "Cash pay that never reaches a bank",
 * while the account that pay lands in had been read through Aug 12 (measured
 * 2026-09-15). This is the clause both now print instead, in /spending's words.
 */
describe("unbankedIncomeFrontierClause — which passed paydays the ledger has looked for", () => {
  test("every payday on a read day: nothing to add, and the surface's own sentence is true", () => {
    expect(clause(2, 2, "2026-09-14")).toBeNull();
    expect(clause(1, 1, "2026-09-14")).toBeNull();
  });

  test("every payday after the frontier — the owner's September", () => {
    expect(clause(2, 0, "2026-08-12")).toBe(
      "They all fall after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked through — so the ledger has not looked for their deposits.",
    );
    expect(clause(1, 0, "2026-08-12")).toBe(
      "It falls after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked through — so the ledger has not looked for its deposit.",
    );
  });

  test("a window straddling the frontier names both halves", () => {
    expect(clause(3, 1, "2026-08-12")).toBe(
      "1 falls on a day already checked, with no deposit; the other 2 fall after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked through.",
    );
    expect(clause(3, 2, "2026-08-12")).toBe(
      "2 fall on days already checked, with no deposit; the other one falls after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked through.",
    );
  });

  test("an account nothing has checked: the ledger cannot say", () => {
    expect(clause(2, 0, null)).toBe(
      "The ledger has not checked every account that pay could land in, so it cannot say whether any of it arrived.",
    );
    // …and when another series' paydays WERE checked, those still say so
    expect(clause(4, 2, null)).toBe(
      "2 fall on days already checked, with no deposit; for the other 2, the ledger has not checked every account that pay could land in.",
    );
  });

  test("the frontier day is spelled as prose, never an ISO date", () => {
    for (const [n, c] of [[2, 0], [3, 1]] as const) expect(clause(n, c, "2026-08-12")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  /**
   * 🔴 The frontier is `earliestVerified` over `verifiedThrough` — the last day
   * a balance chain closes — and the clause called it the day "which nothing
   * has imported yet". On the e2e ledger after "Detect now", Capital One 360
   * Checking is checked through May 31 while its rows run to Jun 15 (the series'
   * own deposit among them) and its statement to Jul 5, so /budgets and
   * /recurring printed "It falls after Sun, May 31, 2026, which nothing has
   * imported yet" (measured 2026-09-15). "Read" had the same double meaning.
   * No branch may make a claim about imports: the reading never measured one.
   */
  test("no branch claims anything about what was imported — the frontier is a checked day", () => {
    for (const [n, c, through] of [[2, 0, "2026-05-31"], [1, 0, "2026-05-31"], [3, 1, "2026-05-31"], [2, 0, null], [4, 2, null]] as const) {
      const text = clause(n, c, through)!;
      expect(text).not.toMatch(/import|\bread\b/);
      expect(text).toMatch(/checked/);
    }
  });
});
