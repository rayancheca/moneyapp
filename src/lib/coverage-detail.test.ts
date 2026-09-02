import { describe, expect, test } from "vitest";
import { agoPhrase, coverageDetail, type CoverageDetailInput } from "./coverage-detail";

const detail = (over: Partial<CoverageDetailInput> = {}): string =>
  coverageDetail({
    grade: "verified",
    verifiedThrough: "2026-08-12",
    unverifiedSince: null,
    brokenSince: null,
    daysSinceVerified: 15,
    lastManualUpdate: null,
    gapDays: 0,
    unverifiedDays: 0,
    ...over,
  });

describe("an unverified account states BOTH halves", () => {
  test("what closes, and where it stops", () => {
    /*
     * ⛔ The shipped sentence was "nothing has checked this account since
     * 2026-08-11", which is untrue of Cash on Hand: it closes to the cent
     * through 2026-08-03 and exactly one day at the end does not.
     */
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: "2026-08-03",
        unverifiedSince: "2026-08-11",
        daysSinceVerified: 24,
        unverifiedDays: 1,
      }),
    ).toBe(
      "closes to the cent through Aug 3, 2026 (24 days ago), then carries that balance forward for 7 days; the first day it does not is Aug 11, 2026 — 1 day rests on an export with no closing balance",
    );
  });

  /*
   * 🔴 SEVEN DAYS FELL BETWEEN TWO TRUE CLAUSES. The sentence said it closes
   * through Aug 3 and that the first day it does not is Aug 11, leaving Aug 4–10
   * in a limbo a reader has to invent an explanation for.
   *
   * They are CARRIED, and that is not a guess: `verifiedThrough` is the last day
   * on a closed chain, so nothing after it is verified, and `unverifiedSince` is
   * the FIRST derived-unverified or gap day, so nothing before it is either.
   * Every day strictly between them has one remaining basis — the balance held
   * forward, which the trust card already calls "as proven as that balance, and
   * not a gap".
   */
  test("the days between the two dates are named, not left as a hole", () => {
    const gap = detail({
      grade: "unverified",
      verifiedThrough: "2026-08-03",
      unverifiedSince: "2026-08-11",
      daysSinceVerified: 24,
      unverifiedDays: 1,
    });
    expect(gap).toContain("carries that balance forward for 7 days");
  });

  test("consecutive dates leave no days to name", () => {
    const abutting = detail({
      grade: "unverified",
      verifiedThrough: "2026-08-10",
      unverifiedSince: "2026-08-11",
      daysSinceVerified: 17,
      unverifiedDays: 1,
    });
    expect(abutting).not.toContain("carries that balance forward");
    expect(abutting).toContain("closes to the cent through Aug 10, 2026 (17 days ago); the first day");
  });

  test("one carried day is singular", () => {
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: "2026-08-09",
        unverifiedSince: "2026-08-11",
        daysSinceVerified: 18,
        unverifiedDays: 1,
      }),
    ).toContain("carries that balance forward for 1 day;");
  });

  /* Nothing to carry FROM: an account that never closed has no balance to hold
     forward, and the clause must not appear at all. */
  test("an account that never closed carries nothing", () => {
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: null,
        unverifiedSince: "2023-12-05",
        daysSinceVerified: null,
        unverifiedDays: 41,
      }),
    ).not.toContain("carries that balance forward");
  });

  test("one day 'rests', many days 'rest' — the shipped line said '1 days'", () => {
    const one = detail({ grade: "unverified", unverifiedSince: "2026-08-11", unverifiedDays: 1 });
    const many = detail({ grade: "unverified", unverifiedSince: "2026-08-11", unverifiedDays: 41 });
    expect(one).toContain("1 day rests on");
    expect(many).toContain("41 days rest on");
  });

  test("an account that has never closed says so, instead of naming a date it did", () => {
    // Robinhood Cash: its ledger STARTS at its first unverified day, so there
    // is no trusted day before it and `verifiedThrough` is null
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: null,
        unverifiedSince: "2023-12-05",
        daysSinceVerified: null,
        unverifiedDays: 41,
      }),
    ).toBe(
      "nothing has closed on this account yet; the first day it does not is Dec 5, 2023 — 41 days rest on an export with no closing balance",
    );
  });
});

describe("a broken account", () => {
  test("names the first HOLE, not the first unverified day", () => {
    const text = detail({
      grade: "broken",
      verifiedThrough: "2025-10-31",
      brokenSince: "2025-11-04",
      unverifiedSince: "2023-12-05",
      daysSinceVerified: 300,
      gapDays: 264,
    });
    expect(text).toContain("the chain first fails on Nov 4, 2025");
    // the innocent date must not appear: it is where the replay begins, and
    // pairing it with the gap count accused eighteen months of closed history
    expect(text).not.toContain("Dec 5");
    expect(text).toContain("264 days cannot be trusted");
  });

  test("pluralises a single gap day", () => {
    expect(detail({ grade: "broken", brokenSince: "2025-11-04", gapDays: 1 })).toContain("1 day cannot be trusted");
  });
});

describe("a verified account", () => {
  test("dates itself and says how long ago, because the rhythm is monthly", () => {
    // 27 days quiet is this ledger's ordinary cycle, not a fault — the reader
    // can only know that if the panel says how long it has been
    expect(detail()).toBe("closes to the cent through Aug 12, 2026 (15 days ago)");
  });

  test("today reads as today, never as '0 days ago'", () => {
    expect(detail({ daysSinceVerified: 0 })).toBe("closes to the cent through Aug 12, 2026 (today)");
  });

  test("one day reads as '1 day ago'", () => {
    expect(detail({ daysSinceVerified: 1 })).toBe("closes to the cent through Aug 12, 2026 (1 day ago)");
  });

  test("⚠️ a verified account whose every day is carried has no date to give", () => {
    // it rendered "through null" before this branch existed
    expect(detail({ verifiedThrough: null, daysSinceVerified: null })).toBe(
      "nothing has closed on this account yet",
    );
  });

  test("a date with no day count still names the date", () => {
    expect(detail({ daysSinceVerified: null })).toBe("closes to the cent through Aug 12, 2026");
  });
});

describe("the states that are not about arithmetic", () => {
  test("an investment account is priced, not proved", () => {
    expect(detail({ grade: "market_value" })).toContain("priced from holdings");
  });

  test("a manual account names the day he counted it", () => {
    expect(detail({ grade: "manual", lastManualUpdate: "2026-08-11" })).toBe(
      "you are the statement — last counted Aug 11, 2026",
    );
    expect(detail({ grade: "manual", lastManualUpdate: null })).toBe(
      "you are the statement — no balance recorded yet",
    );
  });

  test("an account with no balances says what to do about it", () => {
    expect(detail({ grade: "unknown" })).toContain("import a statement to start the chain");
  });
});

describe("a date always carries its year", () => {
  test("a three-year-old hole does not read as this December", () => {
    // `formatDayShort` renders 2023-12-05 as "Dec 5", which on a panel whose
    // dates are forensic is a different claim entirely
    const text = detail({ grade: "unverified", unverifiedSince: "2023-12-05", unverifiedDays: 41 });
    expect(text).toContain("Dec 5, 2023");
  });

  test("an unparseable day is echoed, never rendered as 'undefined NaN'", () => {
    expect(detail({ grade: "manual", lastManualUpdate: "not-a-day" })).toContain("not-a-day");
  });

  test("a state that should carry a date and does not says so, rather than printing a blank", () => {
    // neither is reachable through `accountCoverage`, but the TYPE allows both
    // and `?? ""` rendered an empty string where a date belongs
    expect(detail({ grade: "broken", brokenSince: null, gapDays: 3 })).toContain(
      "the chain first fails on a day the record does not name",
    );
    expect(detail({ grade: "unverified", unverifiedSince: null, unverifiedDays: 3 })).toContain(
      "the first day it does not is a day the record does not name",
    );
  });
});

describe("agoPhrase", () => {
  test("null means nothing has ever closed", () => {
    expect(agoPhrase(null)).toBeNull();
  });

  test("zero and negative both read as today", () => {
    // a verifiedThrough in the future is a clock skew, not a fault to announce
    expect(agoPhrase(0)).toBe("today");
    expect(agoPhrase(-3)).toBe("today");
  });

  test("counts days", () => {
    expect(agoPhrase(1)).toBe("1 day ago");
    expect(agoPhrase(27)).toBe("27 days ago");
  });
});
