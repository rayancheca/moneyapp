import { describe, expect, test } from "vitest";
import { formatDayLong } from "./format-date";
import type { UnattachedMatch } from "./unattached-match";
import {
  noIncomeDayCheckedIn,
  noIncomeDayCheckedNote,
  noIncomeDayCheckedOf,
  noIncomeDayCheckedWindowNote,
  passedPaydaysWords,
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

  /*
   * 🔴 Two paydays read "They all fall after Thu, Sep 24, 2026" — on the dashboard's Earned vs banked, /budgets' header,
   * his pay's page and the forecast's note (a copy of his ledger, 2026-10-13, Oct 1 and Oct 8). Two are both.
   */
  test("every payday after the frontier — the owner's September", () => {
    expect(clause(2, 0, "2026-08-12")).toBe(
      "Both fall after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked through — so the ledger has not looked for their deposits.",
    );
    expect(clause(3, 0, "2026-08-12")).toBe(
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
    expect(clause(2, 0, PER_SCHEDULE)).toBe(
      "Both fall after the last day the accounts their pay lands in have been checked through, which differs by schedule — so the ledger has not looked for their deposits.",
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

/*
 * ⛔ …and of the checked paydays a row matches to the cent unattached (`unattached`, the one rule's), the rows by their
 * day and amount — the clause is what his pay's page, /budgets and Earned vs banked below the stale bar print instead
 * of the sentence that names them. 🔴 Review of e6ad55a (MEDIUM): on the pre-filing copy read Oct 31 his pay's page and
 * /budgets printed only "4 fall on days already checked, with no deposit attached to it; the other one falls after Mon,
 * Oct 26, 2026, …", and with Oct 1, 8 and 15 filed and Oct 22 unattached, read Nov 2, the card's verdict "1 falls on a
 * day already checked, with no deposit attached to it; …" one line over the difference naming Oct 22's row.
 */
describe("unbankedIncomeFrontierClause — the checked paydays a row matches to the cent are named by their rows", () => {
  const PAYROLL = 114192;
  const matchOn = (date: string, notFiledAsIncome = false): UnattachedMatch => ({
    date,
    row: { id: `r-${date}`, postedOn: date, amountCents: PAYROLL, ...(notFiledAsIncome ? { notFiledAsIncome } : {}) },
  });
  const OCTOBER = ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"];
  const withRows = (n: number, c: number, at: string | null, unattached: readonly UnattachedMatch[]) =>
    unbankedIncomeFrontierClause(
      { occurrenceCount: n, checkedOccurrenceCount: c, frontier: frontierAt(at), unattached },
      formatDayLong,
    );
  const rows =
    "rows of $1,141.92 on Thu, Oct 1, 2026, Thu, Oct 8, 2026, Thu, Oct 15, 2026, and Thu, Oct 22, 2026 that are not " +
    "attached to it";

  test("every checked payday matched — his pre-filing October read Oct 31", () => {
    expect(withRows(5, 4, "2026-10-26", OCTOBER.map((d) => matchOn(d)))).toBe(
      `4 fall on days already checked, with no deposit attached to it — they are matched to the cent by ${rows}; the ` +
        "other one falls after Mon, Oct 26, 2026, the last day every account that pay lands in has been checked " +
        "through.",
    );
  });

  test("one checked payday, matched — Oct 22 read Nov 2 with Oct 1, 8 and 15 filed", () => {
    expect(withRows(2, 1, "2026-10-26", [matchOn("2026-10-22")])).toBe(
      "1 falls on a day already checked, with no deposit attached to it — it is matched to the cent by a row of " +
        "$1,141.92 on Thu, Oct 22, 2026 that is not attached to it; the other one falls after Mon, Oct 26, 2026, the " +
        "last day every account that pay lands in has been checked through.",
    );
  });

  test("some of the checked paydays: how many, and their rows — beside an account nothing has checked too", () => {
    expect(withRows(5, 4, "2026-10-26", OCTOBER.slice(0, 3).map((d) => matchOn(d)))).toBe(
      "4 fall on days already checked, with no deposit attached to it — 3 of them are matched to the cent by rows of " +
        "$1,141.92 on Thu, Oct 1, 2026, Thu, Oct 8, 2026, and Thu, Oct 15, 2026 that are not attached to it; the " +
        "other one falls after Mon, Oct 26, 2026, the last day every account that pay lands in has been checked " +
        "through.",
    );
    expect(withRows(4, 2, null, [matchOn("2026-10-01")])).toBe(
      "2 fall on days already checked, with no deposit attached to it — 1 of them is matched to the cent by a row of " +
        "$1,141.92 on Thu, Oct 1, 2026 that is not attached to it; for the other 2, the ledger has not checked every " +
        "account that pay could land in.",
    );
  });

  test("rows the import attached and filed nowhere are said as that", () => {
    expect(withRows(5, 4, "2026-10-26", OCTOBER.map((d) => matchOn(d, true)))).toBe(
      "4 fall on days already checked, with no deposit attached to it and filed as income — they are matched to the " +
        "cent by rows of $1,141.92 on Thu, Oct 1, 2026, Thu, Oct 8, 2026, Thu, Oct 15, 2026, and Thu, Oct 22, 2026 " +
        "that are attached to it but not filed as income; the other one falls after Mon, Oct 26, 2026, the last day " +
        "every account that pay lands in has been checked through.",
    );
  });

  /*
   * ⛔ The forecast's note prints the clause AND its `notProjected` — once the clause names the rows, the subject points
   * at them rather than naming them twice. 🔴 …and the subject's parts are joined once: with some paydays matched and
   * some past the checked day it read "Pay that never reaches a bank, and pay matched … that is not attached to it,,
   * and pay the ledger has not looked for, cannot be projected as arriving".
   */
  test("the forecast's note names the rows once, and its subject joins its parts once", () => {
    const passed = (pastGrace: number, unattached: readonly UnattachedMatch[]) =>
      passedPaydaysWords(
        {
          occurrenceCount: 5,
          checkedOccurrenceCount: 4,
          pastGraceOccurrenceCount: pastGrace,
          frontier: frontierAt("2026-10-26"),
          unattached,
        },
        formatDayLong,
      );
    const all = passed(4, OCTOBER.map((d) => matchOn(d)));
    expect(all.unread).toContain(`they are matched to the cent by ${rows}`);
    expect(all.notProjected).toBe(
      "Pay those rows match, and pay the ledger has not looked for, cannot be projected as arriving",
    );
    const some = passed(4, OCTOBER.slice(0, 2).map((d) => matchOn(d)));
    expect(some.notProjected).toBe(
      "Pay that never reaches a bank, and pay those rows match, and pay the ledger has not looked for, cannot be " +
        "projected as arriving",
    );
    // every payday checked: no clause, so the subject names the rows itself
    const checkedAll = passedPaydaysWords(
      {
        occurrenceCount: 4,
        checkedOccurrenceCount: 4,
        pastGraceOccurrenceCount: 4,
        frontier: frontierAt("2026-10-26"),
        unattached: OCTOBER.slice(0, 2).map((d) => matchOn(d)),
      },
      formatDayLong,
    );
    expect(checkedAll.unread).toBeNull();
    expect(checkedAll.notProjected).toBe(
      "Pay that never reaches a bank, and pay matched to the cent by rows of $1,141.92 on Thu, Oct 1, 2026 and Thu, " +
        "Oct 8, 2026 that are not attached to it, cannot be projected as arriving",
    );
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

/*
 * ⚖️ §6A 68, one wording for one window (2026-10-29): a window ONE day long says the day has not been checked — the
 * table's and the chart hover's words for it (`noIncomeDayCheckedOf("day")`), the day named — and only a longer one
 * says "not one day of". 🔴 His ledger copy 2026-10-29: `/spending?period=2026-09-25` carded Income "Not one day of Sep
 * 25, 2026 has been checked in the accounts that pay lands in, so nothing is shown." — and its Sankey lens said the same
 * — over a table reading "A dash under Income is not a zero where the day has not been checked …" of that one day.
 */
describe("noIncomeDayCheckedWindowNote / noIncomeDayCheckedIn — a window's words for an Income nobody has looked for", () => {
  const sep25 = { from: "2026-09-25", to: "2026-09-25", label: "Sep 25, 2026" };
  const october = { from: "2026-10-01", to: "2026-10-31", label: "October 2026" };

  test("a window one day long says the day has not been checked, in the table's words", () => {
    expect(noIncomeDayCheckedWindowNote(sep25)).toBe(
      "Sep 25, 2026 has not been checked in the accounts that pay lands in, so nothing is shown.",
    );
    expect(noIncomeDayCheckedWindowNote(sep25)).not.toContain("Not one day of");
    expect(noIncomeDayCheckedIn({ ...sep25, label: "the day" })).toBe(noIncomeDayCheckedOf("day"));
  });

  test("a longer window says not one day of it has been — the dashboard's month sentence, word for word", () => {
    expect(noIncomeDayCheckedWindowNote(october)).toBe(
      "Not one day of October 2026 has been checked in the accounts that pay lands in, so nothing is shown.",
    );
    expect(noIncomeDayCheckedWindowNote(october)).toBe(noIncomeDayCheckedNote("October 2026"));
    expect(noIncomeDayCheckedIn({ ...october, label: "the month" })).toBe(noIncomeDayCheckedOf("month"));
  });

  // the days a running total sums (`/spending`'s graph hover): its clause, lower case, with no "so nothing is shown"
  test("the days of a running total read the same way, whatever their bucket's label", () => {
    expect(noIncomeDayCheckedIn({ from: "2026-09-26", to: "2026-10-31", label: "Sep 26 – Oct 31, 2026" })).toBe(
      "not one day of Sep 26 – Oct 31, 2026 has been checked in the accounts that pay lands in",
    );
    expect(noIncomeDayCheckedIn({ from: "2026-10-01", to: "2026-10-01", label: "Oct 1, 2026" })).toBe(
      "Oct 1, 2026 has not been checked in the accounts that pay lands in",
    );
  });
});
