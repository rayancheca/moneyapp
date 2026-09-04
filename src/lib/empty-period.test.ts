import { describe, expect, test } from "vitest";
import { emptyPeriodCopy, emptyPeriodReason } from "./empty-period";

const reason = (over: Partial<Parameters<typeof emptyPeriodReason>[0]> = {}) =>
  emptyPeriodReason({
    from: "2026-09-01",
    to: "2026-09-30",
    today: "2026-09-04",
    ledgerOpens: "2022-12-01",
    ledgerReaches: "2026-08-31",
    ...over,
  });

describe("emptyPeriodReason", () => {
  /*
   * ⛔ THE MEASURED CASE. On 2026-09-04 the owner's newest active row was
   * 2026-08-31 and /spending read "No activity in this period" over September —
   * four elapsed days, none of them imported for any account.
   */
  test("a month whose elapsed days are all past the newest row is unimported", () => {
    expect(reason()).toEqual({ kind: "after-records", uncoveredDays: 4 });
  });

  test("the window is clipped at today — days that have not happened are not uncovered", () => {
    // Sep 1–30 asked on Sep 4 is four elapsed days, not thirty
    expect(reason().uncoveredDays).toBe(4);
    expect(reason({ today: "2026-09-01" }).uncoveredDays).toBe(1);
  });

  test("a window entirely inside the records is a measured zero", () => {
    expect(reason({ from: "2026-05-01", to: "2026-05-31" })).toEqual({
      kind: "measured",
      uncoveredDays: 0,
    });
  });

  test("a window that straddles the newest row is partly covered", () => {
    // Aug 1–31 asked on Sep 4 with records to Aug 20: 11 days unread
    expect(reason({ from: "2026-08-01", to: "2026-08-31", ledgerReaches: "2026-08-20" })).toEqual({
      kind: "partly-covered",
      uncoveredDays: 11,
    });
  });

  test("a window before the oldest row says so, rather than blaming the newest", () => {
    expect(reason({ from: "2020-01-01", to: "2020-01-31" })).toEqual({
      kind: "before-records",
      uncoveredDays: 31,
    });
  });

  test("a window that has not started yet is future, not unimported", () => {
    expect(reason({ from: "2026-10-01", to: "2026-10-31" })).toEqual({
      kind: "future",
      uncoveredDays: 0,
    });
  });

  test("an empty ledger is its own answer", () => {
    expect(reason({ ledgerOpens: null, ledgerReaches: null }).kind).toBe("no-ledger");
  });

  /* The boundary: the newest row falls on the window's first day. One day is
     covered, so it is partly covered and not "after the records". */
  test("the newest row landing on the window's first day covers exactly that day", () => {
    expect(reason({ ledgerReaches: "2026-09-01" })).toEqual({
      kind: "partly-covered",
      uncoveredDays: 3,
    });
  });
});

describe("emptyPeriodCopy", () => {
  const fmt = (iso: string) => iso;

  test("an unimported month is not called a measurement", () => {
    const copy = emptyPeriodCopy(reason(), "September 2026", "2026-08-31", fmt);
    expect(copy.title).toBe("September 2026 has not been imported yet");
    expect(copy.description).toContain("nobody has looked at");
    expect(copy.description).toContain("2026-08-31");
  });

  test("a covered window IS called a measurement", () => {
    const copy = emptyPeriodCopy(
      reason({ from: "2026-05-01", to: "2026-05-31" }),
      "May 2026",
      "2026-08-31",
      fmt,
    );
    expect(copy.title).toBe("No activity in this period");
    expect(copy.description).toContain("measured zero rather than an unread window");
    // ⛔ never the stronger claim: the frontier is whole-ledger, not per account
    expect(copy.description).not.toContain("Every day of it has been imported");
  });

  /* Every branch of the copy, because each one is the only sentence a reader
     gets in that world — and a world with no sentence renders an empty card. */
  test("each world gets its own heading and body", () => {
    expect(emptyPeriodCopy({ kind: "no-ledger", uncoveredDays: 0 }, "September 2026", null, fmt))
      .toMatchObject({ title: "Nothing imported yet" });
    expect(emptyPeriodCopy({ kind: "future", uncoveredDays: 0 }, "October 2026", "2026-08-31", fmt))
      .toMatchObject({ title: "October 2026 has not happened yet" });
    const before = emptyPeriodCopy(
      { kind: "before-records", uncoveredDays: 31 },
      "Jan 2019",
      "2022-12-01",
      fmt,
    );
    expect(before.title).toBe("Jan 2019 is before your records begin");
    expect(before.description).toContain("31 days");
    const partly = emptyPeriodCopy(
      { kind: "partly-covered", uncoveredDays: 11 },
      "August 2026",
      "2026-08-20",
      fmt,
    );
    expect(partly.title).toBe("Nothing posted in the part of August 2026 that has been imported");
    expect(partly.description).toContain("11 days of it have not been imported");
    expect(partly.description).toContain("2026-08-20");
    expect(partly.description).toContain("lower bound");
  });

  /* ⚠️ Every branch that names a date must survive not having one — a window
     can be uncovered on a ledger whose newest row the caller could not resolve. */
  test("the sentences hold up with no date to name", () => {
    for (const kind of ["after-records", "partly-covered"] as const) {
      const copy = emptyPeriodCopy({ kind, uncoveredDays: 3 }, "September 2026", null, fmt);
      expect(copy.description).not.toContain("null");
      expect(copy.description).not.toContain("undefined");
      expect(copy.description).toContain("3 days");
    }
  });

  test("one partly-covered day is singular too", () => {
    const copy = emptyPeriodCopy(
      { kind: "partly-covered", uncoveredDays: 1 },
      "August 2026",
      "2026-08-30",
      fmt,
    );
    expect(copy.description).toContain("1 day of it has not been imported");
    expect(copy.description).not.toContain("1 days");
  });

  test("one uncovered day is singular", () => {
    const copy = emptyPeriodCopy(
      { kind: "after-records", uncoveredDays: 1 },
      "September 2026",
      "2026-08-31",
      fmt,
    );
    expect(copy.description).toContain("imported for 1 day of it");
    expect(copy.description).not.toContain("1 days");
  });
});
