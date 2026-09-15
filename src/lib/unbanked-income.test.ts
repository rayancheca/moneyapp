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
      "They all fall after Wed, Aug 12, 2026, which nothing has imported yet — so the ledger has not looked for their deposits.",
    );
    expect(clause(1, 0, "2026-08-12")).toBe(
      "It falls after Wed, Aug 12, 2026, which nothing has imported yet — so the ledger has not looked for its deposit.",
    );
  });

  test("a window straddling the frontier names both halves", () => {
    expect(clause(3, 1, "2026-08-12")).toBe(
      "1 falls on a day already read, with no deposit; the other 2 fall after Wed, Aug 12, 2026, which nothing has imported yet.",
    );
    expect(clause(3, 2, "2026-08-12")).toBe(
      "2 fall on days already read, with no deposit; the other one falls after Wed, Aug 12, 2026, which nothing has imported yet.",
    );
  });

  test("an account nobody has read: the ledger cannot say", () => {
    expect(clause(2, 0, null)).toBe(
      "The ledger has not read every account that pay could land in, so it cannot say whether any of it arrived.",
    );
    // …and when another series' paydays WERE read, those still say so
    expect(clause(4, 2, null)).toBe(
      "2 fall on days already read, with no deposit; for the other 2, the ledger has not read every account that pay could land in.",
    );
  });

  test("the frontier day is spelled as prose, never an ISO date", () => {
    for (const [n, c] of [[2, 0], [3, 1]] as const) expect(clause(n, c, "2026-08-12")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
