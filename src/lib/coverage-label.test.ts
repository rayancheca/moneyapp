import { describe, expect, test } from "vitest";
import {
  coverageLabel,
  coveragePhrase,
  formatNameList,
  openingLabel,
  sharedCoverageChange,
  splitMissing,
} from "./coverage-label";

describe("formatNameList", () => {
  test("joins when within the cap", () => {
    expect(formatNameList(["A", "B"])).toBe("A, B");
  });

  test("caps with a +N more suffix", () => {
    expect(formatNameList(["A", "B", "C", "D"])).toBe("A, B +2 more");
  });

  test("respects a custom max (untruncated for aria)", () => {
    expect(formatNameList(["A", "B", "C"], Number.MAX_SAFE_INTEGER)).toBe("A, B, C");
  });

  test("empty list is an empty string", () => {
    expect(formatNameList([])).toBe("");
  });
});

describe("coverageLabel", () => {
  test("complete day (no missing) → null", () => {
    expect(coverageLabel(["A", "B"], [])).toBeNull();
  });

  test("far fewer covered than missing → name the covered ('only')", () => {
    // 2022: only Chase existed → 'only Chase ····3522' beats listing 7 missing
    expect(coverageLabel(["Chase ····3522"], ["Discover", "SoFi", "Venture X"])).toEqual({
      kind: "only",
      text: "Chase ····3522",
    });
  });

  test("few missing → name the missing ('missing')", () => {
    expect(coverageLabel(["A", "B", "C", "D"], ["Robinhood Crypto", "Venture X"])).toEqual({
      kind: "missing",
      text: "Robinhood Crypto, Venture X",
    });
  });

  test("tie (equal covered and missing) → default to naming the missing", () => {
    expect(coverageLabel(["A", "B"], ["C", "D"])).toEqual({ kind: "missing", text: "C, D" });
  });

  test("no covered names at all → name the missing (defensive)", () => {
    expect(coverageLabel([], ["A"])).toEqual({ kind: "missing", text: "A" });
  });

  test("kind is the literal render verb, so surfaces cannot drift", () => {
    // one canonical word per branch — every UI surface renders `{kind} {text}`
    expect(coverageLabel(["A"], ["B", "C"])?.kind).toBe("only");
    expect(coverageLabel(["A", "B"], ["C"])?.kind).toBe("missing");
  });

  test("caps the covered list when many are covered but still fewer than missing", () => {
    expect(coverageLabel(["A", "B", "C"], ["D", "E", "F", "G", "H", "I"], 2)).toEqual({
      kind: "only",
      text: "A, B +1 more",
    });
  });

  test("max is threaded to the chosen list for full aria phrasing", () => {
    expect(coverageLabel(["A"], ["B", "C", "D"], Number.MAX_SAFE_INTEGER)).toEqual({
      kind: "only",
      text: "A",
    });
  });
});

describe("splitMissing", () => {
  test("a day before the account's own history starts is PRE-START, not a hole", () => {
    // the wallet holds physical cash and legitimately starts 2026-08-03; every
    // earlier day is a fact about the calendar, and backfilling it would be
    // fabricated financial history
    expect(splitMissing("2026-07-01", [{ name: "Cash on Hand", opensOn: "2026-08-03" }])).toEqual({
      notYetOpen: [{ name: "Cash on Hand", opensOn: "2026-08-03" }],
      gapAccounts: [],
      emptyAccounts: [],
    });
  });

  test("a day inside the account's life with no coverage is a GAP", () => {
    expect(splitMissing("2024-05-05", [{ name: "Discover", opensOn: "2023-09-30" }])).toEqual({
      notYetOpen: [],
      gapAccounts: ["Discover"],
      emptyAccounts: [],
    });
  });

  test("the opening day itself is not pre-start (its own history covers it)", () => {
    expect(splitMissing("2026-08-03", [{ name: "Cash on Hand", opensOn: "2026-08-03" }])).toEqual({
      notYetOpen: [],
      gapAccounts: ["Cash on Hand"],
      emptyAccounts: [],
    });
  });

  test("an account with no covered day anywhere is a hole, never an 'opens' claim", () => {
    // there is no date to name, so calling it pre-start would invent one
    expect(splitMissing("2026-07-01", [{ name: "Ghost", opensOn: null }])).toEqual({
      notYetOpen: [],
      gapAccounts: ["Ghost"],
      emptyAccounts: [],
    });
  });

  test("both causes on one day are reported separately", () => {
    expect(
      splitMissing("2026-07-01", [
        { name: "Cash on Hand", opensOn: "2026-08-03" },
        { name: "Discover", opensOn: "2023-09-30" },
      ]),
    ).toEqual({
      notYetOpen: [{ name: "Cash on Hand", opensOn: "2026-08-03" }],
      gapAccounts: ["Discover"],
      emptyAccounts: [],
    });
  });

  /**
   * 🔴 The regression this bucket exists for. `Capital One 360 Checking` holds
   * zero rows and zero balances, so it has no `opensOn`, so it fell through to
   * `gapAccounts` on ALL 1,464 days of the live series: the dashboard published
   * "no statement for Capital One 360 Checking on this date" in the warning tone
   * every single day, and not one day of the net-worth chart could be complete.
   */
  test("an account holding nothing at all is EMPTY, not a hole", () => {
    expect(
      splitMissing("2026-07-01", [{ name: "Capital One 360 Checking", opensOn: null, hasHistory: false }]),
    ).toEqual({
      notYetOpen: [],
      gapAccounts: [],
      emptyAccounts: ["Capital One 360 Checking"],
    });
  });

  /**
   * ⛔ …and the other side of that line, which must NOT move. An account with
   * rows the ledger cannot place is money a total cannot see — a real hole —
   * and only the absence of history moves it to the empty bucket.
   */
  test("an account with history but no opening day is still a hole", () => {
    expect(splitMissing("2026-07-01", [{ name: "Stranded", opensOn: null, hasHistory: true }])).toEqual({
      notYetOpen: [],
      gapAccounts: ["Stranded"],
      emptyAccounts: [],
    });
  });

  /** Omitting the flag keeps the old behaviour, so existing callers are unmoved. */
  test("without the flag an account with no opening day stays a hole", () => {
    expect(splitMissing("2026-07-01", [{ name: "Legacy", opensOn: null }])).toEqual({
      notYetOpen: [],
      gapAccounts: ["Legacy"],
      emptyAccounts: [],
    });
  });
});

describe("openingLabel", () => {
  test("few accounts still to come → name each with the day it opens", () => {
    expect(openingLabel(["Chase", "SoFi"], [{ name: "Cash on Hand", opensOn: "2026-08-03" }])).toEqual({
      kind: "opened",
      text: "Cash on Hand opens Aug 3, 2026",
    });
  });

  test("early history → naming the one open account beats nine opening dates", () => {
    const pending = ["B", "C", "D", "E"].map((name) => ({ name, opensOn: "2024-01-01" }));
    expect(openingLabel(["Chase ····3522"], pending)).toEqual({
      kind: "only",
      text: "Chase ····3522",
    });
  });

  test("soonest opening first, and the rest are capped", () => {
    expect(
      openingLabel(
        [],
        [
          { name: "Venture X", opensOn: "2026-01-13" },
          { name: "Cash on Hand", opensOn: "2026-08-03" },
          { name: "Robinhood Crypto", opensOn: "2025-11-01" },
        ],
        1,
      ),
    ).toEqual({ kind: "opened", text: "Robinhood Crypto opens Nov 1, 2025 +2 more" });
  });

  test("every account already open → nothing to say", () => {
    expect(openingLabel(["A", "B"], [])).toBeNull();
  });

  test("the opening date carries its year (a chart spans four of them)", () => {
    const label = openingLabel(["A", "B"], [{ name: "Cash on Hand", opensOn: "2026-08-03" }]);
    expect(label?.text).toContain("2026");
  });
});

describe("coveragePhrase", () => {
  test("the two naming kinds read as `{kind} {text}`", () => {
    expect(coveragePhrase({ kind: "only", text: "Chase" })).toBe("only Chase");
    expect(coveragePhrase({ kind: "missing", text: "Discover" })).toBe("missing Discover");
  });

  test("'opened' carries its own verb (a date cannot follow a bare one)", () => {
    expect(coveragePhrase({ kind: "opened", text: "Cash on Hand opens Aug 3, 2026" })).toBe(
      "Cash on Hand opens Aug 3, 2026",
    );
  });
});

describe("sharedCoverageChange", () => {
  const whole = (cents: number) => ({ cents, coverage: { complete: true } });

  test("both ends complete → the ordinary %, measured over everything", () => {
    expect(sharedCoverageChange(whole(100_000), whole(150_000))).toEqual({ pct: 50, scope: null, deltaCents: 50_000 });
  });

  test("an account absent at the START endpoint is excluded from BOTH ends", () => {
    // the $1,800 wallet opened 2026-08-03: counting it as growth would invent
    // $1,800 of income out of money that was always in the safe
    const start = {
      cents: 80_000,
      coverage: {
        complete: false,
        coveredAccountNames: ["Chase", "SoFi"],
        coveredCents: [50_000, 30_000],
        notYetOpen: [{ name: "Cash on Hand", opensOn: "2026-08-03" }],
        gapAccounts: [],
        totalAccounts: 3,
      },
    };
    const end = {
      cents: 270_000,
      coverage: {
        complete: true,
        coveredAccountNames: ["Chase", "SoFi", "Cash on Hand"],
        coveredCents: [60_000, 30_000, 180_000],
        gapAccounts: [],
        totalAccounts: 3,
      },
    };
    // 90,000 against 80,000 — NOT 270,000 against 80,000
    expect(sharedCoverageChange(start, end)).toEqual({
      pct: 12.5,
      scope: "excl. Cash on Hand, opened Aug 3, 2026",
      // $90,000 − $80,000. NOT the raw $190,000: the dollar figure the header
      // prints beside the % must cover the same accounts the % measured
      deltaCents: 10_000,
    });
  });

  test("the '40k → 3 → 90' artifact does not come back through the shared %", () => {
    const start = {
      cents: 300,
      coverage: {
        complete: false,
        coveredAccountNames: ["Chase"],
        coveredCents: [300],
        notYetOpen: [{ name: "SoFi", opensOn: "2024-01-01" }],
        gapAccounts: [],
        totalAccounts: 2,
      },
    };
    const end = {
      cents: 9_000_000,
      coverage: {
        complete: true,
        coveredAccountNames: ["Chase", "SoFi"],
        coveredCents: [500, 8_999_500],
        gapAccounts: [],
        totalAccounts: 2,
      },
    };
    const change = sharedCoverageChange(start, end);
    // Chase's own 300 → 500, not the whole ledger's 300 → 9,000,000
    expect(change.pct).toBeCloseTo(66.67, 1);
    expect(change.scope).toBe("excl. SoFi, opened Jan 1, 2024");
  });

  test("both ends missing the SAME account → a true like-for-like %, still scoped", () => {
    const coverage = (names: string[], cents: number[]) => ({
      complete: false,
      coveredAccountNames: names,
      coveredCents: cents,
      notYetOpen: [{ name: "Cash on Hand", opensOn: "2026-08-03" }],
      gapAccounts: [],
      totalAccounts: 3,
    });
    expect(
      sharedCoverageChange(
        { cents: 80_000, coverage: coverage(["Chase", "SoFi"], [50_000, 30_000]) },
        { cents: 88_000, coverage: coverage(["Chase", "SoFi"], [58_000, 30_000]) },
      ),
    ).toEqual({ pct: 10, scope: "across 2 of 3 accounts", deltaCents: 8_000 });
  });

  test("a genuine interior gap still suppresses — the total itself is short", () => {
    const gappy = {
      cents: 80_000,
      coverage: {
        complete: false,
        coveredAccountNames: ["Chase"],
        coveredCents: [80_000],
        notYetOpen: [],
        gapAccounts: ["Discover"],
        totalAccounts: 2,
      },
    };
    expect(sharedCoverageChange(gappy, whole(120_000))).toEqual({ pct: null, scope: null, deltaCents: null });
    expect(sharedCoverageChange(whole(120_000), gappy)).toEqual({ pct: null, scope: null, deltaCents: null });
  });

  test("a partial series with no per-account detail keeps the old suppression", () => {
    // the portfolio/holding charts carry no coverage detail; guessing would be
    // worse than the blunt rule they have always had
    expect(sharedCoverageChange({ cents: 100_000, coverage: { complete: false } }, whole(150_000))).toEqual({
      pct: null,
      scope: null,
      deltaCents: null,
    });
  });

  test("no shared account at all → no honest comparison exists", () => {
    expect(
      sharedCoverageChange(
        {
          cents: 10_000,
          coverage: {
            complete: false,
            coveredAccountNames: ["Chase"],
            coveredCents: [10_000],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
        {
          cents: 20_000,
          coverage: {
            complete: false,
            coveredAccountNames: ["SoFi"],
            coveredCents: [20_000],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
      ),
    ).toEqual({ pct: null, scope: null, deltaCents: null });
  });

  test("several excluded accounts are named as a capped list, without dates", () => {
    // no single account owns the caveat, so the phrase stays a list — and a
    // series that never said when they open cannot claim a day
    expect(
      sharedCoverageChange(
        {
          cents: 10_000,
          coverage: {
            complete: false,
            coveredAccountNames: ["Chase"],
            coveredCents: [10_000],
            gapAccounts: [],
            totalAccounts: 4,
          },
        },
        {
          cents: 40_000,
          coverage: {
            complete: true,
            coveredAccountNames: ["Chase", "SoFi", "Venture X", "Discover"],
            coveredCents: [12_000, 8_000, 11_000, 9_000],
            gapAccounts: [],
            totalAccounts: 4,
          },
        },
      ),
    ).toEqual({ pct: 20, scope: "excl. SoFi, Venture X +1 more", deltaCents: 2_000 });
  });

  test("one excluded account with no opening on record is named without a date", () => {
    expect(
      sharedCoverageChange(
        {
          cents: 10_000,
          coverage: {
            complete: false,
            coveredAccountNames: ["Chase"],
            coveredCents: [10_000],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
        {
          cents: 25_000,
          coverage: {
            complete: true,
            coveredAccountNames: ["Chase", "SoFi"],
            coveredCents: [11_000, 14_000],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
      ),
    ).toEqual({ pct: 10, scope: "excl. SoFi", deltaCents: 1_000 });
  });

  test("an account the END endpoint cannot see is dropped from the start too", () => {
    // the mirror of the wallet case: whatever one end cannot see, neither end counts
    expect(
      sharedCoverageChange(
        {
          cents: 100_000,
          coverage: {
            complete: true,
            coveredAccountNames: ["Chase", "Wise"],
            coveredCents: [60_000, 40_000],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
        {
          cents: 70_000,
          coverage: {
            complete: false,
            coveredAccountNames: ["Chase"],
            coveredCents: [70_000],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
      ),
    ).toEqual({ pct: (10_000 / 60_000) * 100, scope: "excl. Wise", deltaCents: 10_000 });
  });

  test("a series that never said how many accounts exist still discloses the scope", () => {
    const coverage = (cents: number[]) => ({
      complete: false,
      coveredAccountNames: ["Chase", "SoFi"],
      coveredCents: cents,
      gapAccounts: [],
    });
    expect(
      sharedCoverageChange(
        { cents: 80_000, coverage: coverage([50_000, 30_000]) },
        { cents: 88_000, coverage: coverage([58_000, 30_000]) },
      ),
    ).toEqual({ pct: 10, scope: "across 2 accounts", deltaCents: 8_000 });
  });

  test("per-account detail that does not line up is not detail at all", () => {
    const partial = (coverage: Record<string, unknown>) => ({ cents: 80_000, coverage });
    // names without balances
    expect(
      sharedCoverageChange(partial({ complete: false, coveredAccountNames: ["Chase"] }), whole(90_000)),
    ).toEqual({ pct: null, scope: null, deltaCents: null });
    // and a mismatched pair, which would silently mis-attribute a balance
    expect(
      sharedCoverageChange(
        partial({ complete: false, coveredAccountNames: ["Chase", "SoFi"], coveredCents: [80_000] }),
        whole(90_000),
      ),
    ).toEqual({ pct: null, scope: null, deltaCents: null });
  });

  test("a zero shared baseline has no percentage (division, not honesty)", () => {
    expect(
      sharedCoverageChange(
        {
          cents: 0,
          coverage: {
            complete: false,
            coveredAccountNames: ["Chase"],
            coveredCents: [0],
            notYetOpen: [{ name: "SoFi", opensOn: "2026-01-01" }],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
        {
          cents: 50_000,
          coverage: {
            complete: true,
            coveredAccountNames: ["Chase", "SoFi"],
            coveredCents: [20_000, 30_000],
            gapAccounts: [],
            totalAccounts: 2,
          },
        },
      ),
    ).toEqual({ pct: null, scope: null, deltaCents: null });
  });
});

describe("sharedCoverageChange — the dollar figure matches the percentage", () => {
  /**
   * The percentage and the dollar delta printed beside it must describe the
   * same accounts. Pairing a shared-scope % with an all-account $ does not
   * remove the fabricated figure the suppression rule guarded against — it
   * relocates it into the pairing, where a reader who divides one by the other
   * lands on a third number that is true of nothing.
   */
  test("deltaCents is the shared-scope change, not the raw total change", () => {
    const change = sharedCoverageChange(
      {
        cents: 80_000,
        coverage: {
          complete: false,
          coveredAccountNames: ["Chase", "SoFi"],
          coveredCents: [50_000, 30_000],
          notYetOpen: [{ name: "Cash on Hand", opensOn: "2026-08-03" }],
          gapAccounts: [],
          totalAccounts: 3,
        },
      },
      {
        cents: 270_000,
        coverage: {
          complete: true,
          coveredAccountNames: ["Chase", "SoFi", "Cash on Hand"],
          coveredCents: [60_000, 30_000, 180_000],
          gapAccounts: [],
          totalAccounts: 3,
        },
      },
    );
    // the raw totals moved $190,000; the shared accounts moved $10,000
    expect(change.deltaCents).toBe(10_000);
    expect(change.deltaCents).not.toBe(270_000 - 80_000);
    // and the two agree: 10,000 / 80,000 = 12.5%
    expect((change.deltaCents! / 80_000) * 100).toBeCloseTo(change.pct!, 10);
  });

  test("a zero starting total has no percentage, so it has no paired dollar either", () => {
    // dividing by zero is not a growth rate; the dollar figure must vanish with
    // the percentage rather than appear beside a blank
    const change = sharedCoverageChange(
      { cents: 0, coverage: { complete: true } },
      { cents: 150_000, coverage: { complete: true } },
    );
    expect(change.pct).toBeNull();
    expect(change.deltaCents).toBeNull();
  });

  test("deltaCents is null exactly when pct is null", () => {
    const gappy = {
      cents: 80_000,
      coverage: { complete: false, gapAccounts: ["Discover"], coveredAccountNames: ["Chase"], coveredCents: [80_000] },
    };
    const change = sharedCoverageChange(gappy, { cents: 90_000, coverage: { complete: true } });
    expect(change.pct).toBeNull();
    expect(change.deltaCents).toBeNull();
  });
});
