import { describe, expect, test } from "vitest";
import {
  daysNotImportedYet,
  emptyPeriodCopy,
  emptyPeriodReason,
  emptyTrendCopy,
  unreachedDashNote,
  unreachedKind,
} from "./empty-period";

const reason = (over: Partial<Parameters<typeof emptyPeriodReason>[0]> = {}) =>
  emptyPeriodReason({
    from: "2026-09-01",
    to: "2026-09-30",
    today: "2026-09-04",
    ledgerOpens: "2022-12-01",
    ledgerReaches: "2026-08-31",
    ...over,
  });

/**
 * ⛔ One arithmetic for the days a pace figure has not seen. The dashboard tile
 * computed it inline and /spending's readout not at all; on 2026-09-14 (newest
 * row Sep 12) the tile said "2 days of September 2026 not imported yet" and the
 * readout said nothing. These are the tile's own cases, carried over.
 */
describe("daysNotImportedYet", () => {
  const july = (over: Partial<Parameters<typeof daysNotImportedYet>[0]> = {}) =>
    daysNotImportedYet({ from: "2026-07-01", to: "2026-07-31", today: "2026-07-08", ledgerOpens: "2026-06-20", ledgerReaches: "2026-07-02", ...over });

  test("the elapsed days past the newest row", () => {
    expect(july()).toBe(6);
    expect(july({ ledgerReaches: "2026-09-12", from: "2026-09-01", to: "2026-09-30", today: "2026-09-14" })).toBe(2);
  });

  test("a month nothing has reached yet: every elapsed day", () => {
    expect(july({ ledgerReaches: "2026-06-20" })).toBe(8);
  });

  test("an import that reaches today leaves none", () => {
    expect(july({ ledgerReaches: "2026-07-08" })).toBe(0);
  });

  test("days BEFORE the oldest row are not 'not imported yet'", () => {
    // the ledger opens on the newest row itself, Jul 2: Jul 1 is before it, Jul 3–8 after
    expect(july({ ledgerOpens: "2026-07-02" })).toBe(6);
  });

  test("an empty ledger has not imported any elapsed day", () => {
    expect(july({ ledgerOpens: null, ledgerReaches: null })).toBe(8);
  });

  test("a window that has not started has no elapsed day to miss", () => {
    expect(july({ from: "2026-08-01", to: "2026-08-31" })).toBe(0);
  });
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
      beforeDays: 0,
    });
  });

  /*
   * 🔴 THE OTHER END. Every partly-covered window used to be read as running
   * past the NEWEST row, so a window that starts before the records begin was
   * told "— the ledger stops on Sep 12, 2026" of days that lie before 2022-08-25.
   * The front became one click away when "All time" started on the ledger's
   * first day: its Year pill is 2022, which the ledger enters in August.
   */
  test("a window that straddles the OLDEST row counts its uncovered days as before the records", () => {
    const frontier = { today: "2026-09-14", ledgerOpens: "2022-08-25", ledgerReaches: "2026-09-12" };
    // Jan 1 – Aug 24, 2022 is 236 days nobody has imported
    expect(reason({ from: "2022-01-01", to: "2022-12-31", ...frontier })).toEqual({
      kind: "partly-covered",
      uncoveredDays: 236,
      beforeDays: 236,
    });
    // both ends at once: 967 before the records, 2 after them
    expect(reason({ from: "2020-01-01", to: "2026-09-14", ...frontier })).toEqual({
      kind: "partly-covered",
      uncoveredDays: 969,
      beforeDays: 967,
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
      beforeDays: 0,
    });
  });

  /* …and the oldest row landing on the window's LAST day covers exactly that day */
  test("the oldest row landing on the window's last day leaves every earlier day before the records", () => {
    expect(reason({ from: "2022-08-01", to: "2022-08-25", today: "2026-09-14", ledgerOpens: "2022-08-25" })).toEqual({
      kind: "partly-covered",
      uncoveredDays: 24,
      beforeDays: 24,
    });
  });
});

describe("emptyPeriodCopy", () => {
  const fmt = (iso: string) => iso;

  test("an unimported month is not called a measurement", () => {
    const copy = emptyPeriodCopy(reason(), "September 2026", "2026-08-31", fmt);
    expect(copy.title).toBe("September 2026 has not been imported yet");
    expect(copy.description).toContain("nobody has looked at");
    /*
     * 🔴 S32(b), the owner's decision 2026-09-14: once a statement's end counts
     * as imported, the day named here can be a statement close with no row on
     * it — Venture X closes Sep 13, the newest row is Sep 12 — so "the ledger
     * stops on" named a day on which nothing was posted. "imported through" is
     * what `ledgerReaches` measures, and what MoversCard already says of the same
     * day ("Venture X imported through Sep 13").
     */
    expect(copy.description).toContain("the ledger is imported through 2026-08-31");
    expect(copy.description).not.toContain("stops on");
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

  test("⛔ days before the records are never blamed on where the ledger stops", () => {
    const before = emptyPeriodCopy(
      { kind: "partly-covered", uncoveredDays: 236, beforeDays: 236 },
      "2022",
      "2026-09-12",
      fmt,
      { ledgerOpens: "2022-08-25" },
    );
    expect(before.description).toContain("236 days of it have not been imported");
    expect(before.description).not.toContain("imported through");
    expect(before.description).toContain("your records begin on 2022-08-25");
    expect(before.description).toContain("lower bound");

    const both = emptyPeriodCopy(
      { kind: "partly-covered", uncoveredDays: 969, beforeDays: 967 },
      "All time",
      "2026-09-12",
      fmt,
      { ledgerOpens: "2022-08-25" },
    );
    expect(both.description).toContain("your records begin on 2022-08-25");
    // S32(b): the frontier's own word, not "stops on" — see the test above
    expect(both.description).toContain("the ledger is imported through 2026-09-12");
    expect(both.description).not.toContain("stops on");

    // a caller that cannot name the first day says nothing false either
    const unnamed = emptyPeriodCopy({ kind: "partly-covered", uncoveredDays: 236, beforeDays: 236 }, "2022", "2026-09-12", fmt);
    expect(unnamed.description).not.toContain("imported through");
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

/**
 * 🔴 A CELL THAT ZERO-FILLS A CALENDAR WINDOW ASKED ONLY ONE END OF THE LEDGER.
 * Measured on the owner's ledger 2026-09-14 (first active row 2022-08-25):
 * `/spending?period=2022-08` read "Aug 1: nothing spent or earned" … "Aug 24:
 * nothing spent or earned" — while `?period=2026-09` on the same component
 * already said "Sep 13: not imported yet" and "Sep 15: has not happened yet".
 * This is the one question every such cell asks now.
 */
describe("unreachedKind — whether a window's figures can be read as a measurement", () => {
  const frontier = { today: "2026-09-14", ledgerOpens: "2022-08-25", ledgerReaches: "2026-09-12" };
  const day = (iso: string, over: Partial<Parameters<typeof unreachedKind>[0]> = {}) =>
    unreachedKind({ from: iso, to: iso, ...frontier, ...over });

  test("a day before the ledger opens is before the records, and the opening day is a measurement", () => {
    expect(day("2022-08-24")).toBe("before-records");
    expect(day("2022-08-25")).toBeNull();
  });

  test("a day past the newest row is unimported, and the newest row's day is a measurement", () => {
    expect(day("2026-09-12")).toBeNull();
    expect(day("2026-09-13")).toBe("after-records");
  });

  test("today is not the future — it is merely unimported; tomorrow has not happened", () => {
    expect(day("2026-09-14")).toBe("after-records");
    expect(day("2026-09-15")).toBe("future");
  });

  /* ⛔ `emptyPeriodReason` answers "no-ledger" before it asks "future", so a
     caller that forwarded its kind would call an unhappened day unimported */
  test("the future is asked first, even of an empty ledger", () => {
    expect(day("2026-09-15", { ledgerOpens: null, ledgerReaches: null })).toBe("future");
    expect(day("2026-09-14", { ledgerOpens: null, ledgerReaches: null })).toBe("no-ledger");
  });

  test("a window the ledger opens or stops inside has been looked at, and is a figure", () => {
    // Aug 2022 holds Aug 25–31; Sep 2026 holds Sep 1–12 of its 14 elapsed days
    expect(unreachedKind({ from: "2022-08-01", to: "2022-08-31", ...frontier })).toBeNull();
    expect(unreachedKind({ from: "2026-09-01", to: "2026-09-30", ...frontier })).toBeNull();
    // …and a month that has not begun is the future, whatever the ledger holds
    expect(unreachedKind({ from: "2026-10-01", to: "2026-10-31", ...frontier })).toBe("future");
    expect(unreachedKind({ from: "2022-07-01", to: "2022-07-31", ...frontier })).toBe("before-records");
  });
});

/**
 * ⛔ A dash with no sentence reads as a rendering gap (owner decision E1a: keep
 * the row, print "—", say why). The sentence names only the worlds its dashes
 * are in — `?period=2026-09` has unimported and unhappened days and no day
 * before the records; `?period=2022-08` has only the last.
 */
describe("unreachedDashNote — the line a table prints about its dashes", () => {
  test("names only the worlds present", () => {
    expect(unreachedDashNote(["future", "after-records"], "day")).toBe(
      "A dash is not a zero: it marks a day that has not been imported yet or has not happened yet.",
    );
    expect(unreachedDashNote(["before-records"], "day")).toBe(
      "A dash is not a zero: it marks a day that is before your records begin.",
    );
  });

  test("in calendar order whatever order the buckets came in, and an empty ledger reads as unimported", () => {
    expect(unreachedDashNote(["future", "no-ledger", "before-records", "after-records"], "month")).toBe(
      "A dash is not a zero: it marks a month that is before your records begin, has not been imported yet, or has not happened yet.",
    );
  });

  test("nothing dashed, nothing said", () => {
    expect(unreachedDashNote([], "day")).toBeNull();
  });
});
