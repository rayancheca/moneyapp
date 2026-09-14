import { describe, expect, test } from "vitest";
import { emptyPeriodCopy, emptyPeriodReason, emptyTrendCopy } from "./empty-period";

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
    /*
     * ⛔ AND THE MEASUREMENT IS OF THREE POPULATIONS, NOT THE LEDGER. The
     * caller's gate counts expense-kind outflows, income-kind positives and
     * uncategorized outflows, so a window holding only transfers, card payments
     * or investment flows reaches this branch. Measured 2026-09-11: **79 day
     * windows printed "nothing posted in it" over 298 posted rows** — and the
     * heatmap on the very same page had been corrected for the identical claim
     * hours earlier, leaving one page saying both things about one day.
     */
    expect(copy.title).toBe("Nothing spent or earned in this period");
    expect(copy.description).toContain("nothing was spent or earned in it");
    expect(copy.description).toContain("Transfers, card payments and investment flows are not counted here");
    expect(copy.description).toContain("measured zero rather than an unread window");
    // ⛔ never the stronger claim: the frontier is whole-ledger, not per account
    expect(copy.description).not.toContain("Every day of it has been imported");
    // …nor the stronger claim about WHAT is absent
    expect(copy.description).not.toContain("nothing posted in it");
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

describe("the uncategorized-bucket clause", () => {
  const measured = { kind: "measured", uncoveredDays: 0 } as const;
  const day = (iso: string) => iso;

  /*
   * ⚠️ `/spending` prints an explicit Uncategorized bucket above this copy, so
   * naming it there is what makes a measured zero honest. A category page has
   * no such bucket — the clause would point at a control the reader cannot see.
   */
  test("is offered only to the surface that has the bucket", () => {
    expect(
      emptyPeriodCopy(measured, "August 2026", "2026-08-31", day, { uncategorizedBucket: true }).description,
    ).toContain("their own explicit bucket");
  });

  test("and is absent by default", () => {
    const copy = emptyPeriodCopy(measured, "August 2026", "2026-08-31", day);
    expect(copy.description).not.toContain("bucket");
    expect(copy.description).toContain("a measured zero rather than an unread window");
  });
});

describe("emptyTrendCopy — an unread month is not an empty one, and the window is named", () => {
  /** twelve months ending Dec 2025, the first `unreadBefore` and last `unreadAfter` unreached */
  const months = (unreadBefore: number, unreadAfter: number, total = 12) =>
    Array.from({ length: total }, (_, i) => ({
      month: `2025-${String(i + 1).padStart(2, "0")}`,
      reached: i >= unreadBefore && i < total - unreadAfter,
    }));

  /**
   * 🔴 It said "the last 12 months" over a window anchored in the past: the
   * card read "12-month trend · Apr 2022 to Mar 2023" two lines above "No
   * activity in the last 12 months."
   */
  test("a fully-covered window names its own twelve months", () => {
    expect(emptyTrendCopy(months(0, 0))).toBe("No activity in Jan 2025 to Dec 2025.");
    expect(emptyTrendCopy(months(0, 0))).not.toContain("the last");
  });

  test("months after the ledger stops are discounted, and said", () => {
    expect(emptyTrendCopy(months(0, 1))).toBe(
      "No activity in the 11 months of Jan 2025 to Dec 2025 the ledger covers. The other 1 month has not been imported, " +
        "so it is a window nobody has looked at rather than an empty one.",
    );
  });

  /** 🔴 the other end — months before the ledger opens are just as unread */
  test("months before the ledger opens are discounted the same way", () => {
    expect(emptyTrendCopy(months(3, 0))).toBe(
      "No activity in the 9 months of Jan 2025 to Dec 2025 the ledger covers. The other 3 months have not been imported, " +
        "so they are a window nobody has looked at rather than an empty one.",
    );
  });

  test("nothing imported at all measures nothing at all", () => {
    expect(emptyTrendCopy(months(12, 0))).toBe(
      "None of Jan 2025 to Dec 2025 has been imported — there is nothing here to measure.",
    );
  });

  test("the noun is the page's own word for the figure", () => {
    expect(emptyTrendCopy(months(0, 0), "money received")).toBe("No money received in Jan 2025 to Dec 2025.");
  });

  test("a single month is named once, and no points name no window", () => {
    expect(emptyTrendCopy(months(0, 0, 1))).toBe("No activity in Jan 2025.");
    expect(emptyTrendCopy([])).toBe("None of this window has been imported — there is nothing here to measure.");
  });
});
