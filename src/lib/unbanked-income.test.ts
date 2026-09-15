import { describe, expect, test } from "vitest";
import { formatDayLong } from "./format-date";
import {
  sharedFrontier,
  unbankedIncomeFrontierClause,
  type UnbankedFrontier,
  type UnbankedIncomeReading,
} from "./unbanked-income";

const PER_SCHEDULE = "per-schedule";
/** a day; `null` for an account nothing has checked; "per-schedule" for schedules checked through different days */
const frontierAt = (at: string | null): UnbankedFrontier =>
  at === null ? { kind: "unchecked" } : at === PER_SCHEDULE ? { kind: "per-schedule" } : { kind: "day", through: at };

const clause = (occurrenceCount: number, checkedOccurrenceCount: number, at: string | null): string | null =>
  unbankedIncomeFrontierClause(
    { occurrenceCount, checkedOccurrenceCount, frontier: frontierAt(at) } satisfies UnbankedIncomeReading,
    formatDayLong,
  );

/**
 * 🔴 /budgets and /recurring said September's two paydays passed "with no
 * deposit", and /recurring called them "Cash pay that never reaches a bank",
 * while the account that pay lands in had been checked through Aug 12 (measured
 * 2026-09-15). This is the clause both now print instead, in /spending's words.
 */
describe("unbankedIncomeFrontierClause — which passed paydays the ledger has looked for", () => {
  test("every payday on a checked day: nothing to add, and the surface's own sentence is true", () => {
    expect(clause(2, 2, "2026-09-14")).toBeNull();
    expect(clause(1, 1, "2026-09-14")).toBeNull();
    expect(clause(3, 3, PER_SCHEDULE)).toBeNull();
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

  /**
   * 🔴 Several schedules checked through different days have no one day every
   * unchecked payday falls after. The reading used to name the EARLIEST, and
   * printed "1 falls on a day already read, with no deposit; the other 3 fall
   * after Wed, Aug 12, 2026, which nothing has imported yet" of a Tutoring
   * schedule whose account was checked through Sep 4 — the payday it called
   * read was Tutoring's own Sep 3, after the day it named (measured 2026-09-15,
   * arrears.test.ts' fixture). The clause names no day, and says why.
   */
  test("schedules checked through different days: no day is named, and the reason is", () => {
    expect(clause(4, 0, PER_SCHEDULE)).toBe(
      "They all fall after the last day the accounts their pay lands in have been checked through, which differs by schedule — so the ledger has not looked for their deposits.",
    );
    expect(clause(4, 1, PER_SCHEDULE)).toBe(
      "1 falls on a day already checked, with no deposit; the other 3 fall after the last day the accounts their pay lands in have been checked through, which differs by schedule.",
    );
    expect(clause(4, 3, PER_SCHEDULE)).toBe(
      "3 fall on days already checked, with no deposit; the other one falls after the last day the accounts its pay lands in have been checked through, which differs by schedule.",
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
    const readings = [
      [2, 0, "2026-05-31"],
      [1, 0, "2026-05-31"],
      [3, 1, "2026-05-31"],
      [2, 0, null],
      [4, 2, null],
      [4, 0, PER_SCHEDULE],
      [4, 1, PER_SCHEDULE],
    ] as const;
    for (const [n, c, at] of readings) {
      const text = clause(n, c, at)!;
      expect(text).not.toMatch(/import|\bread\b/);
      expect(text).toMatch(/checked/);
    }
  });
});

describe("sharedFrontier — the one day several schedules were checked through, if there is one", () => {
  test("schedules on the same day name it", () => {
    expect(sharedFrontier(["2026-08-12"])).toEqual({ kind: "day", through: "2026-08-12" });
    expect(sharedFrontier(["2026-08-12", "2026-08-12"])).toEqual({ kind: "day", through: "2026-08-12" });
  });

  test("different days name none — the earliest is false of every later schedule, in either order", () => {
    expect(sharedFrontier(["2026-08-12", "2026-09-04"])).toEqual({ kind: "per-schedule" });
    expect(sharedFrontier(["2026-09-04", "2026-08-12"])).toEqual({ kind: "per-schedule" });
  });

  test("one unchecked landing account, or no schedule at all, is unchecked", () => {
    expect(sharedFrontier(["2026-08-12", null])).toEqual({ kind: "unchecked" });
    expect(sharedFrontier([null, "2026-08-12"])).toEqual({ kind: "unchecked" });
    expect(sharedFrontier(["2026-08-12", "2026-09-04", null])).toEqual({ kind: "unchecked" });
    expect(sharedFrontier([])).toEqual({ kind: "unchecked" });
  });
});
