import { describe, expect, it } from "vitest";
import {
  VALUE_ANCHOR_TOLERANCE_CENTS,
  type LedgerBaseline,
  type LedgerObservation,
  type ValueAnchor,
  compareToBaseline,
  findChainBreaks,
  findValueAnchorDrift,
  formatLedgerFailures,
  statementDayValuation,
} from "./ledger-integrity";

const pair = (from: string, to: string, fromCents: number, movementCents: number, toCents: number) => ({
  from,
  to,
  fromCents,
  movementCents,
  toCents,
});

describe("findChainBreaks", () => {
  it("finds nothing when every pair closes exactly", () => {
    expect(
      findChainBreaks([pair("2026-01-31", "2026-02-28", 82_026, -47_955, 34_071)]),
    ).toEqual([]);
  });

  it("reports the signed shortfall of a pair that does not close", () => {
    // sign convention is the SHIPPED one: printed close minus replayed close,
    // identical to statement_periods.gap_cents, so a break and the period
    // verdict over the same window never disagree about direction
    expect(findChainBreaks([pair("2026-01-31", "2026-02-28", 82_026, -47_955, 33_070)])).toEqual([
      { from: "2026-01-31", to: "2026-02-28", offByCents: -1_001 },
    ]);
  });

  it("catches a one-cent break rather than rounding it away", () => {
    const breaks = findChainBreaks([pair("2026-02-28", "2026-03-31", 33_070, 791_442, 824_511)]);
    expect(breaks).toEqual([{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }]);
  });

  it("reports each failing pair independently", () => {
    expect(
      findChainBreaks([
        pair("2026-01-31", "2026-02-28", 82_026, -47_955, 33_070),
        pair("2026-02-28", "2026-03-31", 33_070, 791_442, 824_511),
      ]),
    ).toHaveLength(2);
  });
});

/*
 * ⛔ The MEASURED sets default to empty — nothing was walked, nothing was
 * valued, no account was read. A test that wants "this break closed" has to say
 * the window was walked; one that forgets gets an unmeasured finding, which is
 * the honest reading of an observation that measured nothing.
 */
const observation = (over: Partial<LedgerObservation> = {}): LedgerObservation => ({
  accounts: [],
  chainWindows: {},
  breaks: {},
  syntheticNetCents: {},
  staleVerdicts: [],
  valuedAnchorDays: {},
  valueAnchors: {},
  unpricedAnchors: [],
  gradedPeriods: {},
  ...over,
});

const baseline: LedgerBaseline = {
  breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
  syntheticNetCents: { "Robinhood Cash": -3_235_861 },
  valueAnchors: {},
};

describe("compareToBaseline", () => {
  it("passes when the ledger matches the recorded baseline exactly", () => {
    const failures = compareToBaseline(
      observation({
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
      }),
      baseline,
    );
    expect(failures).toEqual([]);
  });

  it("fails on a NEW break the baseline does not record", () => {
    const failures = compareToBaseline(
      observation({
        breaks: {
          "Robinhood Cash": [
            { from: "2026-02-28", to: "2026-03-31", offByCents: -1 },
            { from: "2026-03-31", to: "2026-04-30", offByCents: -1 },
          ],
        },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "new-break", account: "Robinhood Cash" });
  });

  it("fails ONCE when a recorded break changes size — same window, different money", () => {
    // reporting this as "a new break appeared" plus "the old one was fixed" is
    // two true sentences and one confusing report; the window is the identity
    const failures = compareToBaseline(
      observation({
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -500 }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "changed-break", account: "Robinhood Cash" });
    expect(failures[0]?.detail).toContain("$5.00");
  });

  it("fails when a baselined break DISAPPEARS, so the baseline gets tightened", () => {
    // a fixed break is good news, but leaving it recorded means the check would
    // no longer notice it coming back — and it is only a fix because the window
    // was WALKED and closed
    const failures = compareToBaseline(
      observation({
        chainWindows: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31" }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "fixed-break" });
  });

  it("fails when synthetic money in replay moves — the plug detector", () => {
    // a hand-entered row with no source document changes this total; that is
    // exactly how the +$3,579.67 July plug entered the ledger unnoticed
    const failures = compareToBaseline(
      observation({
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 + 357_967 },
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "synthetic-drift", account: "Robinhood Cash" });
  });

  it("fails on synthetic money in an account the baseline never mentioned", () => {
    const failures = compareToBaseline(
      observation({
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861, "Chase Checking": 5_000 },
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "synthetic-drift", account: "Chase Checking" });
  });

  it("always fails a stale verdict, baseline or not", () => {
    const failures = compareToBaseline(
      observation({
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
        staleVerdicts: [
          {
            account: "Robinhood Cash",
            periodStart: "2026-07-01",
            storedGapCents: 23_185,
            freshGapCents: 381_152,
          },
        ],
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "stale-verdict" });
  });

  it("fails on a break in an account the baseline never mentioned at all", () => {
    const failures = compareToBaseline(
      observation({
        breaks: {
          "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }],
          "SoFi Checking": [{ from: "2026-05-31", to: "2026-06-30", offByCents: 250 }],
        },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "new-break", account: "SoFi Checking" });
  });

  it("fails when baselined synthetic money DISAPPEARS from an account", () => {
    // the mirror rows being deleted is as much a change as a plug arriving —
    // on an account the check READ, so its $0.00 is a measurement
    const failures = compareToBaseline(
      observation({
        accounts: ["Robinhood Cash"],
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "synthetic-drift", account: "Robinhood Cash" });
    expect(failures[0]?.detail).toContain("$0.00");
  });

  it("renders a stale verdict whose gaps are null — a reconciled period that broke", () => {
    // a 'reconciled' period stores gapCents: null, so the common real case is
    // null → a number, and the line must still read as money
    const failures = compareToBaseline(
      observation({
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
        staleVerdicts: [
          {
            account: "SoFi Savings",
            periodStart: "2026-04-01",
            storedGapCents: null,
            freshGapCents: null,
          },
        ],
      }),
      baseline,
    );
    expect(failures).toHaveLength(1);
    expect(formatLedgerFailures(failures)).toContain("$0.00");
  });

  it("names the account and the money in every failure line", () => {
    const failures = compareToBaseline(
      observation({ syntheticNetCents: { "Chase Checking": 5_000 } }),
      { breaks: {}, syntheticNetCents: {}, valueAnchors: {} },
    );
    const text = formatLedgerFailures(failures);
    expect(text).toContain("Chase Checking");
    expect(text).toContain("$50.00");
  });
});

/**
 * PASS 73 — the arbiter `Robinhood Brokerage` never had.
 *
 * ⛔ Not the same question as a chain break. An investment period is graded
 * `value_anchor` and can never be a `gap`, because a residual there is market
 * movement rather than missing money. This asks something a period cannot: do
 * the statement and the app agree about the SAME INSTANT? Any disagreement
 * there is about the holdings or about a price, and one of the two is wrong.
 */
describe("findValueAnchorDrift", () => {
  const anchor = (over: Partial<ValueAnchor> = {}): ValueAnchor => ({
    account: "Robinhood Brokerage",
    on: "2025-04-30",
    printedCents: 775_539,
    derivedCents: 775_539,
    ...over,
  });

  it("agreement is silence", () => {
    expect(findValueAnchorDrift([anchor()]).drifts).toEqual({});
  });

  it("a cent either way is a rounding difference, not a disagreement", () => {
    expect(findValueAnchorDrift([anchor({ derivedCents: 775_540 })]).drifts).toEqual({});
    expect(findValueAnchorDrift([anchor({ derivedCents: 775_538 })]).drifts).toEqual({});
  });

  it("two cents is a disagreement, and the sign says which way", () => {
    expect(findValueAnchorDrift([anchor({ derivedCents: 775_537 })]).drifts).toEqual({
      "Robinhood Brokerage": [{ on: "2025-04-30", offByCents: -2 }],
    });
  });

  /*
   * The real one. Measured on the owner's archive: the app valued COKE at
   * $135.58 on 2025-04-30 where the statement printed $1,355.81 — Coca-Cola
   * Consolidated's 10-for-1 split, where the price history is back-adjusted and
   * the position of that era is not.
   */
  it("catches the ten-fold price error a percentage band would have to be absurd to see", () => {
    const { drifts } = findValueAnchorDrift([anchor({ derivedCents: 775_539 - 66_786 })]);
    expect(drifts["Robinhood Brokerage"]).toEqual([{ on: "2025-04-30", offByCents: -66_786 }]);
  });

  /*
   * ⛔ An anchor the app cannot value is a MISSING ANSWER, not a drift.
   * Reporting it as a drift of the whole printed amount would read as a total
   * loss, which is the opposite of "we do not know".
   */
  it("an unvalued day is reported apart from the disagreements", () => {
    const { drifts, unpriced } = findValueAnchorDrift([anchor({ derivedCents: null })]);
    expect(drifts).toEqual({});
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0]!.printedCents).toBe(775_539);
  });

  it("groups by account and orders by day", () => {
    const { drifts } = findValueAnchorDrift([
      anchor({ on: "2025-08-31", derivedCents: 775_539 + 816 }),
      anchor({ on: "2025-02-28", derivedCents: 775_539 - 9_121 }),
      anchor({ account: "Robinhood Crypto", on: "2025-03-31", derivedCents: 0 }),
    ]);
    expect(drifts["Robinhood Brokerage"]!.map((d) => d.on)).toEqual(["2025-02-28", "2025-08-31"]);
    expect(drifts["Robinhood Crypto"]).toHaveLength(1);
  });

  /*
   * The DENOMINATOR of `drifts`: every day the rule actually compared, agreeing
   * or not. Without it a day that stopped being compared and a day that started
   * agreeing are the same absence.
   */
  it("reports every day it compared, agreeing or not — and not the days it could not value", () => {
    const { valued } = findValueAnchorDrift([
      anchor({ on: "2026-08-31", derivedCents: 775_539 + 10_625 }),
      anchor({ on: "2025-04-30" }),
      anchor({ on: "2026-07-31", derivedCents: null }),
      anchor({ account: "Robinhood Crypto", on: "2026-08-31", derivedCents: 0, printedCents: 0 }),
    ]);
    expect(valued).toEqual({
      "Robinhood Brokerage": ["2025-04-30", "2026-08-31"],
      "Robinhood Crypto": ["2026-08-31"],
    });
  });

  it("the tolerance is a parameter, and one cent is what it defaults to", () => {
    expect(VALUE_ANCHOR_TOLERANCE_CENTS).toBe(1);
    expect(findValueAnchorDrift([anchor({ derivedCents: 775_539 - 50 })], 50).drifts).toEqual({});
  });
});

/**
 * What the app says an investment account was worth on a statement's day.
 *
 * ⛔ Measured on a copy of the owner's ledger (2026-09-15): deactivating
 * Robinhood Brokerage made `portfolioSeries` return no points for it — the app
 * values active accounts only — and the check read "no points" as "nothing was
 * ever held". All 25 of its statements were valued at $0.00: 21 new drifts each
 * the size of the whole printed amount (-$72,959.32 on 2026-08-31), the total
 * loss `findValueAnchorDrift` exists never to report.
 */
describe("statementDayValuation", () => {
  const book = [
    { day: "2026-07-31", valueCents: 6_766_164 },
    { day: "2026-08-01", valueCents: 6_771_002 },
    { day: "2026-08-31", valueCents: 7_306_557 },
  ];

  it("inside the book, the day's own valuation", () => {
    expect(statementDayValuation(book)("2026-08-31")).toBe(7_306_557);
    expect(statementDayValuation(book)("2026-07-31")).toBe(6_766_164);
  });

  it("before the book begins or after it ends, nothing was held — $0.00, not unknown", () => {
    expect(statementDayValuation(book)("2026-06-30")).toBe(0);
    expect(statementDayValuation(book)("2026-09-30")).toBe(0);
  });

  it("a day missing from the MIDDLE of the book is unknown", () => {
    expect(statementDayValuation(book)("2026-08-15")).toBeNull();
  });

  it("a valued account with an empty book held nothing on any day", () => {
    expect(statementDayValuation([])("2026-08-31")).toBe(0);
  });

  it("an account the app does not value has no answer on any day — never $0.00", () => {
    const valuationOn = statementDayValuation(null);
    expect(valuationOn("2026-08-31")).toBeNull();
    expect(valuationOn("2024-08-31")).toBeNull();
  });
});

describe("compareToBaseline — value anchors", () => {
  const known = { on: "2025-04-30", offByCents: -66_786 };
  const withBaseline = (over: Partial<LedgerBaseline> = {}): LedgerBaseline => ({
    breaks: {},
    syntheticNetCents: {},
    valueAnchors: { "Robinhood Brokerage": [known] },
    ...over,
  });

  it("a recorded disagreement is expected, and says nothing", () => {
    expect(
      compareToBaseline(observation({ valueAnchors: { "Robinhood Brokerage": [known] } }), withBaseline()),
    ).toEqual([]);
  });

  it("a NEW disagreement fails", () => {
    const failures = compareToBaseline(
      observation({ valueAnchors: { "Robinhood Brokerage": [known, { on: "2026-08-31", offByCents: 500 }] } }),
      withBaseline(),
    );
    expect(failures.map((f) => f.kind)).toEqual(["new-value-drift"]);
    expect(failures[0]!.detail).toContain("2026-08-31");
  });

  /*
   * An account the baseline has never mentioned at all — the shape a SECOND
   * investment account takes the first time its statements are imported, and
   * the branch a baseline lookup for an unknown account goes down.
   */
  it("an account with no baseline entry at all still reports its disagreements", () => {
    const failures = compareToBaseline(
      observation({
        valueAnchors: {
          "Robinhood Brokerage": [known],
          "Robinhood Crypto": [{ on: "2025-10-31", offByCents: -150_500 }],
        },
      }),
      withBaseline(),
    );
    expect(failures.map((f) => f.kind)).toEqual(["new-value-drift"]);
    expect(failures[0]!.account).toBe("Robinhood Crypto");
  });

  it("a disagreement that CHANGES SIZE fails", () => {
    const failures = compareToBaseline(
      observation({ valueAnchors: { "Robinhood Brokerage": [{ on: "2025-04-30", offByCents: -66_787 }] } }),
      withBaseline(),
    );
    expect(failures.map((f) => f.kind)).toEqual(["changed-value-drift"]);
  });

  /*
   * ⛔ Good news still has to be written down. A baseline listing a
   * disagreement that no longer exists has stopped describing the ledger, and
   * the next time it returns the check would call it expected.
   */
  it("a disagreement that has been FIXED fails until the baseline says so", () => {
    // fixed = the day was still valued, and the two sides now agree
    const failures = compareToBaseline(
      observation({ valuedAnchorDays: { "Robinhood Brokerage": ["2025-04-30"] } }),
      withBaseline(),
    );
    expect(failures.map((f) => f.kind)).toEqual(["fixed-value-drift"]);
    expect(failures[0]!.detail).toContain("remove it from the baseline");
  });
});

/**
 * A baseline entry is a claim about a WITNESS: this anchor pair, this statement
 * day, this account. When the witness is gone, nothing was measured — and a
 * measurement that did not happen cannot agree, close, or read $0.00.
 *
 * ⛔ Measured on a copy of the owner's ledger, 2026-09-15: un-importing the
 * August 2026 Robinhood Brokerage statement took the value anchors from 43 to
 * 42, and the check said the 2026-08-31 disagreement ($106.25) "now agrees —
 * remove it from the baseline". Following that advice turns a lost witness into
 * a passing check, on the hook that runs before every commit.
 */
describe("compareToBaseline — a witness that is gone is not a fix", () => {
  it("a known disagreement on a day no statement is valued for any more is UNMEASURED, not agreeing", () => {
    const failures = compareToBaseline(
      observation({
        valuedAnchorDays: { "Robinhood Brokerage": ["2025-08-31", "2026-07-31"] },
        valueAnchors: { "Robinhood Brokerage": [{ on: "2025-08-31", offByCents: 816 }] },
      }),
      {
        breaks: {},
        syntheticNetCents: {},
        valueAnchors: {
          "Robinhood Brokerage": [
            { on: "2025-08-31", offByCents: 816 },
            { on: "2026-08-31", offByCents: 10_625 },
          ],
        },
      },
    );
    expect(failures.map((f) => f.kind)).toEqual(["unmeasured-value-drift"]);
    expect(failures[0]!.account).toBe("Robinhood Brokerage");
    expect(failures[0]!.detail).toContain("2026-08-31");
    expect(failures[0]!.detail).toContain("$106.25");
    expect(failures[0]!.detail).not.toContain("now agrees");
    expect(failures[0]!.detail).not.toContain("remove it from the baseline");
  });

  it("a known break whose window is no longer walked is UNMEASURED, not closed", () => {
    // the pair that spanned it lost an anchor — or the account was not walked
    const failures = compareToBaseline(
      observation({
        chainWindows: { "Robinhood Cash": [{ from: "2026-01-31", to: "2026-03-31" }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
      }),
      baseline,
    );
    expect(failures.map((f) => f.kind)).toEqual(["unmeasured-break"]);
    expect(failures[0]!.detail).toContain("2026-02-28 → 2026-03-31");
    expect(failures[0]!.detail).toContain("-$0.01");
    expect(failures[0]!.detail).not.toContain("now closes");
    expect(failures[0]!.detail).not.toContain("remove it from the baseline");
  });

  it("an account the check did not read has no $0.00 of undocumented money — it is UNMEASURED", () => {
    // a rename is the reachable case: the old name stops being read
    const failures = compareToBaseline(
      observation({ accounts: ["Cash Wallet"], syntheticNetCents: { "Cash Wallet": -500_000 } }),
      { breaks: {}, syntheticNetCents: { "Cash on Hand": -500_000 }, valueAnchors: {} },
    );
    expect(failures.map((f) => [f.kind, f.account])).toEqual([
      ["synthetic-drift", "Cash Wallet"],
      ["unmeasured-synthetic", "Cash on Hand"],
    ]);
    const gone = failures[1]!.detail;
    expect(gone).toContain("-$5,000.00");
    expect(gone).not.toContain("$0.00");
  });

  it("an observed entry is measured by being observed — the measured set is not consulted for it", () => {
    // a drift on a day the caller forgot to list is still a drift, never a gap
    const failures = compareToBaseline(
      observation({
        valueAnchors: { "Robinhood Brokerage": [{ on: "2026-08-31", offByCents: 10_625 }] },
        breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
        syntheticNetCents: { "Robinhood Cash": -3_235_861 },
      }),
      { ...baseline, valueAnchors: { "Robinhood Brokerage": [{ on: "2026-08-31", offByCents: 10_625 }] } },
    );
    expect(failures).toEqual([]);
  });

  /*
   * ⛔ The usual way a break gets fixed is the missing statement ARRIVING — and
   * its anchor lands inside the recorded window, so the exact window is never
   * walked again. Measured on a copy of the owner's ledger (2026-09-15, review):
   * with Robinhood Cash's -$8,562.85 over 2026-04-30 → 2026-06-30 recorded and
   * the June statement present, the check said "no anchor pair spans that window
   * any more — nothing was measured". Both halves were walked and closed; an
   * anchor ARRIVED. Replay adds up across windows that abut, so the halves
   * measure the whole.
   */
  describe("a recorded window an arriving anchor divided", () => {
    const recorded: LedgerBaseline = {
      breaks: { "Robinhood Cash": [{ from: "2026-04-30", to: "2026-06-30", offByCents: -856_285 }] },
      syntheticNetCents: {},
      valueAnchors: {},
    };
    const walk = [
      { from: "2026-03-31", to: "2026-04-30" },
      { from: "2026-04-30", to: "2026-05-31" },
      { from: "2026-05-31", to: "2026-06-30" },
      { from: "2026-06-30", to: "2026-07-31" },
    ];

    it("whose halves both close is FIXED — the span was measured, and closes", () => {
      const failures = compareToBaseline(
        observation({ accounts: ["Robinhood Cash"], chainWindows: { "Robinhood Cash": walk } }),
        recorded,
      );
      expect(failures.map((f) => f.kind)).toEqual(["fixed-break"]);
      expect(failures[0]!.detail).toContain("2026-04-30 → 2026-06-30");
      expect(failures[0]!.detail).toContain("now closes");
    });

    it("whose halves still do not close across it is neither fixed nor unmeasured", () => {
      const failures = compareToBaseline(
        observation({
          accounts: ["Robinhood Cash"],
          chainWindows: { "Robinhood Cash": walk },
          breaks: { "Robinhood Cash": [{ from: "2026-05-31", to: "2026-06-30", offByCents: -856_285 }] },
        }),
        recorded,
      );
      expect(failures.map((f) => f.kind)).toEqual(["new-break", "split-break"]);
      const split = failures[1]!.detail;
      expect(split).toContain("2026-04-30 → 2026-06-30");
      expect(split).toContain("2 windows");
      expect(split).toContain("-$8,562.85");
      expect(split).not.toContain("now closes");
      expect(split).not.toContain("nothing was measured");
    });

    it("the span's money is the SUM of its halves — two breaks that cancel close it", () => {
      const failures = compareToBaseline(
        observation({
          accounts: ["Robinhood Cash"],
          chainWindows: { "Robinhood Cash": walk },
          breaks: {
            "Robinhood Cash": [
              { from: "2026-04-30", to: "2026-05-31", offByCents: 1_200 },
              { from: "2026-05-31", to: "2026-06-30", offByCents: -1_200 },
            ],
          },
        }),
        recorded,
      );
      expect(failures.map((f) => f.kind)).toEqual(["new-break", "new-break", "fixed-break"]);
    });

    it("a split whose halves are still off by a DIFFERENT amount says the new total", () => {
      const failures = compareToBaseline(
        observation({
          accounts: ["Robinhood Cash"],
          chainWindows: { "Robinhood Cash": walk },
          breaks: { "Robinhood Cash": [{ from: "2026-04-30", to: "2026-05-31", offByCents: -100 }] },
        }),
        recorded,
      );
      expect(failures.map((f) => f.kind)).toEqual(["new-break", "split-break"]);
      expect(failures[1]!.detail).toContain("-$1.00");
    });

    it("a walk that reaches past the recorded end without stopping on it is UNMEASURED", () => {
      // 2026-06-30 left: the walk starts on the recorded day and never lands on the other
      const failures = compareToBaseline(
        observation({
          accounts: ["Robinhood Cash"],
          chainWindows: {
            "Robinhood Cash": [
              { from: "2026-04-30", to: "2026-05-31" },
              { from: "2026-05-31", to: "2026-07-31" },
            ],
          },
        }),
        recorded,
      );
      expect(failures.map((f) => f.kind)).toEqual(["unmeasured-break"]);
    });

    it("both ends walked with a HOLE between them is UNMEASURED — the span is not tiled", () => {
      const failures = compareToBaseline(
        observation({
          accounts: ["Robinhood Cash"],
          chainWindows: {
            "Robinhood Cash": [
              { from: "2026-04-30", to: "2026-05-15" },
              { from: "2026-05-31", to: "2026-06-30" },
            ],
          },
        }),
        recorded,
      );
      expect(failures.map((f) => f.kind)).toEqual(["unmeasured-break"]);
    });
  });

  /*
   * ⛔ A statement day the app cannot value is ONE finding. Measured on a copy
   * of the owner's ledger (2026-09-15, review): a deactivated Robinhood
   * Brokerage printed 29 findings for 25 statements — each of its four recorded
   * days twice, once as `unpriced-anchor` and once as "no statement on that day
   * was valued — the witness is gone". The statement is not gone; the app had
   * no answer for it.
   */
  describe("a statement day the app cannot value", () => {
    const unvalued = (on: string, printedCents: number): ValueAnchor => ({
      account: "Robinhood Brokerage",
      on,
      printedCents,
      derivedCents: null,
    });

    it("fails on its own, naming the printed amount", () => {
      const failures = compareToBaseline(
        observation({ unpricedAnchors: [unvalued("2026-08-31", 7_295_932)] }),
        { breaks: {}, syntheticNetCents: {}, valueAnchors: {} },
      );
      expect(failures).toEqual([
        {
          kind: "unpriced-anchor",
          account: "Robinhood Brokerage",
          detail: "2026-08-31 prints $72,959.32 of securities and the ledger has no valuation for that day",
        },
      ]);
    });

    it("that the baseline records a disagreement on is still ONE finding, and says the record was not re-measured", () => {
      const failures = compareToBaseline(
        observation({ unpricedAnchors: [unvalued("2026-08-31", 7_295_932)] }),
        {
          breaks: {},
          syntheticNetCents: {},
          valueAnchors: { "Robinhood Brokerage": [{ on: "2026-08-31", offByCents: 10_625 }] },
        },
      );
      expect(failures.map((f) => f.kind)).toEqual(["unpriced-anchor"]);
      expect(failures[0]!.detail).toContain("$72,959.32");
      expect(failures[0]!.detail).toContain("$106.25");
      expect(failures[0]!.detail).not.toContain("witness is gone");
      expect(failures[0]!.detail).not.toContain("now agrees");
    });

    it("only covers ITS account's day — the same day on another account is still unmeasured", () => {
      const failures = compareToBaseline(
        observation({ unpricedAnchors: [unvalued("2026-08-31", 7_295_932)] }),
        {
          breaks: {},
          syntheticNetCents: {},
          valueAnchors: { "Robinhood Crypto": [{ on: "2026-08-31", offByCents: 2_811 }] },
        },
      );
      expect(failures.map((f) => [f.kind, f.account])).toEqual([
        ["unmeasured-value-drift", "Robinhood Crypto"],
        ["unpriced-anchor", "Robinhood Brokerage"],
      ]);
      expect(failures[1]!.detail).not.toContain("recorded disagreement");
    });
  });

  it("every unmeasured kind still fails the check — none of them is silence", () => {
    const failures = compareToBaseline(observation(), {
      breaks: { "SoFi Checking": [{ from: "2026-05-31", to: "2026-06-30", offByCents: 250 }] },
      syntheticNetCents: { "Cash on Hand": -500_000 },
      valueAnchors: { "Robinhood Crypto": [{ on: "2026-08-31", offByCents: 2_811 }] },
    });
    expect(failures.map((f) => f.kind).sort()).toEqual([
      "unmeasured-break",
      "unmeasured-synthetic",
      "unmeasured-value-drift",
    ]);
  });
});
