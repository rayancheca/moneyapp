import { describe, expect, test } from "vitest";
import {
  agoPhrase,
  beforeFirstBalance,
  countedDetail,
  countFooting,
  coverageDetail,
  unverifiedDetail,
  type CoverageDetailInput,
} from "./coverage-detail";
import { formatDayFull, MONTHS_SHORT } from "./format-date";

const detail = (over: Partial<CoverageDetailInput> = {}): string =>
  coverageDetail({
    grade: "verified",
    verifiedThrough: "2026-08-12",
    firstBalanceOn: null,
    firstBalanceIsCount: false,
    unverifiedSince: null,
    uncheckedSince: null,
    uncheckedRunDays: 0,
    brokenSince: null,
    daysSinceVerified: 15,
    lastManualUpdate: null,
    gapDays: 0,
    unverifiedDays: 0,
    hasStatements: true,
    pricedFromHoldings: true,
    countedOn: null,
    keptOpeningOn: null,
    balancesThrough: null,
    ...over,
  });

describe("an unverified account states BOTH halves", () => {
  test("what closes, and where it stops", () => {
    /*
     * ⛔ The shipped sentence was "nothing has checked this account since
     * 2026-08-11", and this test was written believing Cash on Hand closes to
     * the cent through 2026-08-03. It does not: Aug 3 is a balance he typed,
     * and a count is not a check (see "a balance he counted" below). The input
     * here is an account whose chain DOES close through Aug 3.
     *
     * 🔴 …and the tail of it was untrue too. This asserted "rests on an export
     * with no closing balance" of `Cash on Hand`, which has no statement
     * period, no import file and one hand-entered anchor. The /imports row
     * printed "no statements" beside the badge and then explained itself with a
     * document, on one line. `hasStatements` is that same field.
     */
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: "2026-08-03",
        unverifiedSince: "2026-08-11",
        daysSinceVerified: 24,
        unverifiedDays: 1,
        hasStatements: false,
      }),
    ).toBe(
      "closes to the cent through Aug 3, 2026 (24 days ago), then carries that balance forward for 7 days; the first day it does not is Aug 11, 2026 — 1 day rests on entries alone, with no document to check them against",
    );
  });

  /*
   * The other account on the owner's ledger with the same grade, and the reason
   * the export clause exists at all: Robinhood Cash holds 33 statement anchors,
   * and the 52 days that do not close really do rest on an export that carried
   * no closing figure.
   */
  test("an account that HAS statements still blames the export", () => {
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: null,
        unverifiedSince: "2023-12-05",
        daysSinceVerified: null,
        unverifiedDays: 52,
        hasStatements: true,
      }),
    ).toBe(
      "nothing closes to the cent from its first day; the first day it does not is Dec 5, 2023 — 52 days rest on an export with no closing balance",
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

  test("an account unproven from its first day says so, instead of claiming nothing ever closed", () => {
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
      "nothing closes to the cent from its first day; the first day it does not is Dec 5, 2023 — 41 days rest on an export with no closing balance",
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
      "nothing closes to the cent from its first day",
    );
  });

  test("a date with no day count still names the date", () => {
    expect(detail({ daysSinceVerified: null })).toBe("closes to the cent through Aug 12, 2026");
  });
});

/**
 * 🔴 "CLOSES TO THE CENT THROUGH AUG 3, 2026" OF A BALANCE HE TYPED. Measured
 * 2026-09-16 on a copy of the real ledger, /imports' Cash on Hand row read
 * "closes to the cent through Aug 3, 2026 (44 days ago), then carries that
 * balance forward for 7 days; the first day it does not is Aug 11, 2026 — 1 day
 * rests on entries alone, with no document to check them against". Aug 3 is his
 * own count and nothing was ever replayed onto it. `accountCoverage` now leaves
 * it out of `verifiedThrough` and publishes it as `countedOn`; the row says what
 * the days stand on instead.
 */
/**
 * ⚖️ Owner decision 20, 2026-09-17: an account whose statement he un-imported keeps the opening it printed, and its
 * kept rows replay from it — unchecked. Wells Fargo Everyday Checking's shape: no statement left, rows under an export.
 */
describe("an opening kept from a statement he un-imported", () => {
  const keptOpening: Partial<CoverageDetailInput> = {
    grade: "unverified",
    verifiedThrough: null,
    daysSinceVerified: null,
    keptOpeningOn: "2026-07-26",
    unverifiedSince: "2026-07-26",
    uncheckedSince: "2026-07-26",
    uncheckedRunDays: 54,
    unverifiedDays: 54,
    hasStatements: false,
  };

  test("is named as what every day rests on, never as a chain that closes or as his entries", () => {
    const text = detail(keptOpening);
    expect(text).toBe(
      "nothing closes to the cent: it rests on the opening balance of a statement you un-imported, printed for Jul 26, 2026 — 54 days rest on it, and nothing checks them",
    );
    expect(text).not.toContain("closes to the cent through");
    expect(text).not.toContain("entries");
  });

  test("one day reads in the singular", () => {
    expect(detail({ ...keptOpening, unverifiedDays: 1 })).toContain("— 1 day rests on it, and nothing checks it");
  });
});

describe("a balance he counted", () => {
  const cashOnHand: Partial<CoverageDetailInput> = {
    grade: "unverified",
    verifiedThrough: null,
    countedOn: "2026-08-03",
    unverifiedSince: "2026-08-11",
    uncheckedSince: "2026-08-11",
    uncheckedRunDays: 1,
    daysSinceVerified: null,
    unverifiedDays: 1,
    hasStatements: false,
  };

  test("is named as his count, never as a chain that closes", () => {
    const text = detail(cashOnHand);
    expect(text).toBe(
      "nothing closes to the cent: it rests on the balance you counted on Aug 3, 2026, carried forward for 7 days; the first day past that count is Aug 11, 2026 — 1 day rests on entries alone, with no document to check them against",
    );
    expect(text).not.toContain("closes to the cent through");
  });

  test("a count the entries start from the next day carries nothing", () => {
    expect(detail({ ...cashOnHand, countedOn: "2026-08-10" })).toBe(
      "nothing closes to the cent: it rests on the balance you counted on Aug 10, 2026; the first day past that count is Aug 11, 2026 — 1 day rests on entries alone, with no document to check them against",
    );
  });

  test("a count after a chain that closed names both", () => {
    expect(detail({ ...cashOnHand, verifiedThrough: "2026-07-31", daysSinceVerified: 47, countedOn: "2026-08-01" })).toBe(
      "closes to the cent through Jul 31, 2026 (47 days ago), then rests on the balance you counted on Aug 1, 2026, carried forward for 9 days; the first day past that count is Aug 11, 2026 — 1 day rests on entries alone, with no document to check them against",
    );
  });

  test("a count with no unchecked day after it says nothing else checks it", () => {
    expect(
      detail({
        ...cashOnHand,
        unverifiedSince: null,
        uncheckedSince: null,
        uncheckedRunDays: 0,
        unverifiedDays: 0,
      }),
    ).toBe("nothing closes to the cent: it rests on the balance you counted on Aug 3, 2026, and nothing else checks it");
  });

  /*
   * 🔴 "THE FIRST DAY PAST THAT COUNT IS JUL 27, 2026" — five days BEFORE his count. Measured
   * through the app's own path (§6A 28 review): a card with rows on Jul 28 and Jul 30, his
   * $90.00 recorded for Aug 1 through `addManualAnchor`, `rebuildAccount` to Aug 10. The rows
   * before the count replay backwards from it, unchecked; with no run open past the count the
   * row fell back to `unverifiedSince`, and the 9 days carried on the count fell out with it —
   * while net worth and the card's caveat said "nothing else checks it" of the same account.
   */
  test("a count whose rows start before it names no day before it, and counts the days it carries", () => {
    const text = detail({
      ...cashOnHand,
      countedOn: "2026-08-01",
      unverifiedSince: "2026-07-27",
      unverifiedDays: 5,
      uncheckedSince: null,
      uncheckedRunDays: 0,
      balancesThrough: "2026-08-10",
    });
    expect(text).toBe(
      "nothing closes to the cent: it rests on the balance you counted on Aug 1, 2026, carried forward for 9 days, and nothing else checks it",
    );
    expect(text).not.toContain("Jul 27");
  });

  test("a count with rows before it and a run past it names the run, and reconciles with the total", () => {
    expect(
      detail({
        ...cashOnHand,
        countedOn: "2026-08-01",
        unverifiedSince: "2026-07-28",
        unverifiedDays: 2,
        uncheckedSince: "2026-08-04",
        uncheckedRunDays: 1,
      }),
    ).toBe(
      "nothing closes to the cent: it rests on the balance you counted on Aug 1, 2026, carried forward for 2 days; the first day past that count is Aug 4, 2026 — 1 day rests on entries alone, with no document to check them against, of 2 unchecked in all",
    );
  });
});

/**
 * Net worth's line, the dashboard card's row and its line in "what you owe" say this in one line;
 * /imports says it at length. Both are worded from `countFooting`, so they name the same days.
 */
describe("countedDetail — his count in one line", () => {
  const counted: CoverageDetailInput = {
    grade: "unverified",
    verifiedThrough: null,
    firstBalanceOn: null,
    firstBalanceIsCount: false,
    unverifiedSince: "2026-07-27",
    uncheckedSince: null,
    uncheckedRunDays: 0,
    brokenSince: null,
    daysSinceVerified: null,
    lastManualUpdate: "2026-08-01",
    gapDays: 0,
    unverifiedDays: 5,
    hasStatements: false,
    pricedFromHoldings: false,
    countedOn: "2026-08-01",
    keptOpeningOn: null,
    balancesThrough: "2026-08-10",
  };
  const withRun: CoverageDetailInput = {
    ...counted,
    uncheckedSince: "2026-08-04",
    uncheckedRunDays: 7,
    unverifiedDays: 12,
  };

  test("names his count, then the run still open past it or that nothing else checks it", () => {
    expect(countedDetail(counted, formatDayFull)).toBe("you counted it on Aug 1, 2026, and nothing else checks it");
    expect(countedDetail(withRun, formatDayFull)).toBe(
      "you counted it on Aug 1, 2026, and nothing checks it since Aug 4, 2026",
    );
  });

  test("says nothing of an account whose days do not rest on his count", () => {
    expect(countedDetail({ ...counted, countedOn: null }, formatDayFull)).toBeNull();
    expect(countedDetail({ ...counted, grade: "broken" }, formatDayFull)).toBeNull();
    expect(countFooting({ ...counted, grade: "manual" })).toBeNull();
  });

  // 🔴 the row said "the first day past that count is Jul 27, 2026" where the line said "nothing else"
  test("the line and /imports' row name the same days", () => {
    const lineTail = countedDetail(counted, formatDayFull)!.split(", and ")[1];
    expect(coverageDetail(counted)).toContain(`, and ${lineTail}`);
    expect(countFooting(withRun)).toEqual({
      countedOn: "2026-08-01",
      carriedDays: 2,
      uncheckedSince: "2026-08-04",
      uncheckedDays: 7,
    });
    expect(coverageDetail(withRun)).toContain("the first day past that count is Aug 4, 2026 — 7 days rest");
    expect(countedDetail(withRun, formatDayFull)).toContain("since Aug 4, 2026");
  });
});

/*
 * 🔴 The dashboard's "what you owe" row kept its own copy of this line and dated "since" from
 * `unverifiedSince`: "nothing has checked it since Jul 19 — 22 days ago" of a card two statements
 * checked through Aug 5, whose export reached back before the first of them (§6A 28 review).
 */
describe("unverifiedDetail — an unverified account in one line", () => {
  // checked by statements through Aug 5; Jul 19–24 replayed backwards from the first of them
  const checked: CoverageDetailInput = {
    grade: "unverified",
    verifiedThrough: "2026-08-05",
    firstBalanceOn: "2026-07-25",
    firstBalanceIsCount: false,
    unverifiedSince: "2026-07-19",
    uncheckedSince: null,
    uncheckedRunDays: 0,
    brokenSince: null,
    daysSinceVerified: 5,
    lastManualUpdate: "2026-08-05",
    gapDays: 0,
    unverifiedDays: 6,
    hasStatements: true,
    pricedFromHoldings: false,
    countedOn: null,
    keptOpeningOn: null,
    balancesThrough: "2026-08-10",
  };

  test("names the run still open, never the first unchecked day the account ever had", () => {
    const withRun = {
      ...checked,
      uncheckedSince: "2026-08-08",
      uncheckedRunDays: 3,
      unverifiedDays: 9,
    };
    expect(unverifiedDetail(withRun, formatDayFull)).toBe("nothing checks it since Aug 8, 2026");
  });

  test("with no run open, names the checked day and the days before it, and no 'since'", () => {
    expect(unverifiedDetail(checked, formatDayFull)).toBe(
      "checked through Aug 5, 2026, and unchecked days before that",
    );
  });

  test("his count comes first, in `countedDetail`'s words", () => {
    const counted = {
      ...checked,
      verifiedThrough: null,
      countedOn: "2026-08-01",
      uncheckedSince: "2026-08-04",
    };
    expect(unverifiedDetail(counted, formatDayFull)).toBe(countedDetail(counted, formatDayFull));
    expect(unverifiedDetail(counted, formatDayFull)).toBe(
      "you counted it on Aug 1, 2026, and nothing checks it since Aug 4, 2026",
    );
  });

  test("says nothing of another grade, nor 'checked through' a day nothing checked", () => {
    expect(unverifiedDetail({ ...checked, grade: "verified" }, formatDayFull)).toBeNull();
    expect(unverifiedDetail({ ...checked, grade: "broken" }, formatDayFull)).toBeNull();
    expect(unverifiedDetail({ ...checked, verifiedThrough: null }, formatDayFull)).toBeNull();
    expect(unverifiedDetail({ ...checked, unverifiedSince: null }, formatDayFull)).toBeNull();
  });
});

describe("the states that are not about arithmetic", () => {
  test("an investment account is priced, not proved", () => {
    expect(detail({ grade: "market_value", pricedFromHoldings: true })).toContain("priced from holdings");
  });

  /**
   * 🔴 `market_value` is every investment account; "priced from holdings" is
   * only the ones `derivesFromHoldings` says so of. One with no holding events
   * is a recorded balance held flat, and the row said holdings priced it.
   */
  test("an investment account with no holdings is held at its recorded balance", () => {
    const text = detail({ grade: "market_value", pricedFromHoldings: false });
    expect(text).toBe("held at its recorded balance; no holdings price it, and no transaction arithmetic checks it");
    expect(text).not.toContain("priced from holdings");
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

describe("the date and the count are about the SAME run", () => {
  /*
   * 🔴 `/imports` read, on one row:
   *
   *     Robinhood Cash · Unverified · statements → 2026-07-31
   *     nothing closes to the cent from its first day; the first day it does
   *     not is Dec 5, 2023 — 52 days rest on an export with no closing balance
   *
   * of an account with 32 statement anchors and 32 reconciled periods listed
   * further down the same page. Two faults, one line: `verifiedThrough` was
   * defeated by 26 days of prehistory before the account's very first anchor
   * (fixed in `services/coverage`), and the sentence paired the FIRST unchecked
   * day the account ever had with a count of ALL of them — two runs 946 checked
   * days apart.
   */
  test("an account with prehistory names the run that is still open", () => {
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: "2026-08-02",
        daysSinceVerified: 33,
        unverifiedSince: "2023-12-05",
        unverifiedDays: 52,
        uncheckedSince: "2026-08-03",
        uncheckedRunDays: 26,
      }),
    ).toBe(
      "closes to the cent through Aug 2, 2026 (33 days ago); the first day it does not is Aug 3, 2026 — " +
        "26 days rest on an export with no closing balance, of 52 unchecked in all",
    );
  });

  test("one run needs no reconciling clause", () => {
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: "2026-08-03",
        daysSinceVerified: 32,
        unverifiedSince: "2026-08-11",
        unverifiedDays: 1,
        uncheckedSince: "2026-08-11",
        uncheckedRunDays: 1,
        hasStatements: false,
      }),
    ).toContain("1 day rests on entries alone, with no document to check them against");
  });

  test("and it never says 'of N unchecked in all' when N is the same number", () => {
    expect(
      detail({
        grade: "unverified",
        verifiedThrough: "2026-08-03",
        daysSinceVerified: 32,
        unverifiedSince: "2026-08-11",
        unverifiedDays: 1,
        uncheckedSince: "2026-08-11",
        uncheckedRunDays: 1,
      }),
    ).not.toContain("in all");
  });
});

/*
 * 🔴 "THE FIRST DAY IT DOES NOT IS JUN 4, 2026" — EIGHT WEEKS BEFORE THE DAY IT CLOSES THROUGH.
 * Measured 2026-10-01 on a copy of his ledger, /imports' Robinhood Agentic row read "closes to
 * the cent through Aug 31, 2026 (31 days ago); the first day it does not is Jun 4, 2026 — 26 days
 * rest on an export with no closing balance". Its first balance is the Jun 30 statement; Jun 4–29
 * are replayed backwards from it through the Jun 5 transfer that funded the account, which the
 * June statement printed (no export holds it); Jul 1 – Sep 15 close or carry, and nothing is
 * unchecked past Aug 31. With no run open the row fell back to `unverifiedSince` — the first
 * unchecked day the account EVER had — and named the days before its first balance as the day it
 * stopped closing. Net worth's line for the same account read "checked through Aug 31, 2026, and
 * unchecked days before that".
 */
describe("the days before its first balance are not where it stops closing", () => {
  // Robinhood Agentic's coverage, as `accountCoverage` gave it on a copy of his ledger, 2026-10-01
  const agentic: CoverageDetailInput = {
    grade: "unverified",
    verifiedThrough: "2026-08-31",
    firstBalanceOn: "2026-06-30",
    firstBalanceIsCount: false,
    unverifiedSince: "2026-06-04",
    uncheckedSince: null,
    uncheckedRunDays: 0,
    brokenSince: null,
    daysSinceVerified: 31,
    lastManualUpdate: "2026-08-31",
    gapDays: 0,
    unverifiedDays: 26,
    hasStatements: true,
    pricedFromHoldings: false,
    countedOn: null,
    keptOpeningOn: null,
    balancesThrough: "2026-09-15",
  };

  test("names them as the days before its first balance, never as the first day it does not close", () => {
    const text = coverageDetail(agentic);
    expect(text).toBe(
      "closes to the cent through Aug 31, 2026 (31 days ago); " +
        "the 26 days before its first balance, on Jun 30, 2026, are unchecked — " +
        "replayed backwards from it, with nothing earlier to check them against",
    );
    // what is missing before a first balance is an EARLIER one, not an export's closing figure
    expect(text).not.toContain("export");
  });

  test("one day reads in the singular", () => {
    expect(coverageDetail({ ...agentic, unverifiedSince: "2026-06-29", unverifiedDays: 1 })).toContain(
      "; the 1 day before its first balance, on Jun 30, 2026, is unchecked — replayed backwards from it, " +
        "with nothing earlier to check it against",
    );
  });

  /*
   * 🔴 THE FIRST DAY THAT CLOSES IS NOT ALWAYS ITS FIRST BALANCE (review, 2026-10-01). The row
   * named `chainOpensOn` — the first CLOSED day — as "its first balance". A balance he typed
   * closes nothing when the days before it are replayed backwards from it, so with his count first
   * and statements after, the chain opens on the Jun 30 statement and the row said Jun 4–19 were
   * replayed backwards from Jun 30. They were replayed from his count on Jun 20, and a count is
   * named as his. services/coverage.test.ts builds this shape through `addManualAnchor`.
   */
  test("his count as its first balance is named as his, on the day he counted it", () => {
    // Jun 4–19 replayed backwards from the balance he typed for Jun 20; statements from Jun 30
    const counted = {
      ...agentic,
      firstBalanceOn: "2026-06-20",
      firstBalanceIsCount: true,
      unverifiedDays: 16,
    };
    expect(coverageDetail(counted)).toBe(
      "closes to the cent through Aug 31, 2026 (31 days ago); " +
        "the 16 days before its first balance, the one you counted on Jun 20, 2026, are unchecked — " +
        "replayed backwards from it, with nothing earlier to check them against",
    );
    expect(beforeFirstBalance(counted)).toEqual({
      checkedThrough: "2026-08-31",
      firstBalanceOn: "2026-06-20",
      firstBalanceIsCount: true,
    });
    // net worth's line names neither day, so it reads as it did
    expect(unverifiedDetail(counted, formatDayFull)).toBe(
      "checked through Aug 31, 2026, and unchecked days before that",
    );
  });

  test("the row and net worth's line read the same days", () => {
    expect(beforeFirstBalance(agentic)).toEqual({
      checkedThrough: "2026-08-31",
      firstBalanceOn: "2026-06-30",
      firstBalanceIsCount: false,
    });
    expect(unverifiedDetail(agentic, formatDayFull)).toBe(
      "checked through Aug 31, 2026, and unchecked days before that",
    );
  });

  test("a run still open is the run, on both surfaces", () => {
    // Robinhood Cash, the same copy: the run Sep 1–15, and 26 days before its first balance
    const robinhoodCash = {
      ...agentic,
      firstBalanceOn: "2023-12-31",
      unverifiedSince: "2023-12-05",
      uncheckedSince: "2026-09-01",
      uncheckedRunDays: 15,
      unverifiedDays: 41,
    };
    expect(beforeFirstBalance(robinhoodCash)).toBeNull();
    expect(unverifiedDetail(robinhoodCash, formatDayFull)).toBe("nothing checks it since Sep 1, 2026");
    expect(coverageDetail(robinhoodCash)).toBe(
      "closes to the cent through Aug 31, 2026 (31 days ago); the first day it does not is Sep 1, 2026 — " +
        "15 days rest on an export with no closing balance, of 41 unchecked in all",
    );
  });

  test("his count, or no day before its first balance, is not this reading", () => {
    // none is reachable through `accountCoverage` with no run open, but the type allows each
    expect(beforeFirstBalance({ ...agentic, countedOn: "2026-09-01" })).toBeNull();
    expect(beforeFirstBalance({ ...agentic, grade: "verified" })).toBeNull();
    expect(beforeFirstBalance({ ...agentic, verifiedThrough: null })).toBeNull();
    expect(beforeFirstBalance({ ...agentic, unverifiedSince: null })).toBeNull();
    expect(beforeFirstBalance({ ...agentic, firstBalanceOn: null })).toBeNull();
    // the first unchecked day ON its first balance is not before it
    expect(beforeFirstBalance({ ...agentic, unverifiedSince: "2026-06-30" })).toBeNull();
  });
});

/**
 * ⛔ The defect as an invariant: a row that says it closes through one day and names another as
 * the first it does not — or the first past his count — contradicts itself unless the second day
 * is later. Every unverified shape the row words, as `accountCoverage` gives them.
 */
describe("no row names a day it stops closing on or before the day it closes through", () => {
  const iso = (day: string): string => {
    const [month, date, year] = day.replace(",", "").split(" ");
    const m = MONTHS_SHORT.indexOf(month as (typeof MONTHS_SHORT)[number]) + 1;
    return `${year}-${String(m).padStart(2, "0")}-${date!.padStart(2, "0")}`;
  };
  const DAY = String.raw`([A-Z][a-z]{2} \d{1,2}, \d{4})`;
  const base: CoverageDetailInput = {
    grade: "unverified",
    verifiedThrough: "2026-08-31",
    firstBalanceOn: "2026-06-30",
    firstBalanceIsCount: false,
    unverifiedSince: "2026-06-04",
    uncheckedSince: null,
    uncheckedRunDays: 0,
    brokenSince: null,
    daysSinceVerified: 31,
    lastManualUpdate: "2026-08-31",
    gapDays: 0,
    unverifiedDays: 26,
    hasStatements: true,
    pricedFromHoldings: false,
    countedOn: null,
    keptOpeningOn: null,
    balancesThrough: "2026-09-15",
  };
  const shapes: Record<string, CoverageDetailInput> = {
    "days before its first balance, nothing open (Robinhood Agentic)": base,
    "days before its first balance, and a run open (Robinhood Cash)": {
      ...base,
      firstBalanceOn: "2023-12-31",
      unverifiedSince: "2023-12-05",
      uncheckedSince: "2026-09-01",
      uncheckedRunDays: 15,
      unverifiedDays: 41,
    },
    "a run open, carried into": {
      ...base,
      unverifiedSince: "2026-09-08",
      uncheckedSince: "2026-09-08",
      uncheckedRunDays: 8,
      unverifiedDays: 8,
    },
    "a count after a chain that closed, a run open past it": {
      ...base,
      verifiedThrough: "2026-07-31",
      daysSinceVerified: 62,
      countedOn: "2026-08-01",
      uncheckedSince: "2026-08-11",
      uncheckedRunDays: 1,
      unverifiedDays: 27,
    },
  };

  test("every named stop is after the day it closes through", () => {
    let compared = 0;
    for (const [name, input] of Object.entries(shapes)) {
      const text = coverageDetail(input);
      const through = text.match(new RegExp(`closes to the cent through ${DAY}`))?.[1];
      const stop = text.match(new RegExp(`the first day (?:it does not|past that count) is ${DAY}`))?.[1];
      expect(through, `${name}: "${text}"`).toBeDefined();
      if (stop === undefined) continue;
      compared += 1;
      expect(iso(stop) > iso(through!), `${name}: "${text}"`).toBe(true);
    }
    // ⛔ guard the guard: three of the four name a stop — a run, open past the day it closes through
    expect(compared).toBe(3);
  });
});
