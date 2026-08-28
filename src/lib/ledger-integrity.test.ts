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

const observation = (over: Partial<LedgerObservation> = {}): LedgerObservation => ({
  breaks: {},
  syntheticNetCents: {},
  staleVerdicts: [],
  valueAnchors: {},
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
    // no longer notice it coming back
    const failures = compareToBaseline(
      observation({ syntheticNetCents: { "Robinhood Cash": -3_235_861 } }),
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
    // the mirror rows being deleted is as much a change as a plug arriving
    const failures = compareToBaseline(
      observation({
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

  it("the tolerance is a parameter, and one cent is what it defaults to", () => {
    expect(VALUE_ANCHOR_TOLERANCE_CENTS).toBe(1);
    expect(findValueAnchorDrift([anchor({ derivedCents: 775_539 - 50 })], 50).drifts).toEqual({});
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
    const failures = compareToBaseline(observation(), withBaseline());
    expect(failures.map((f) => f.kind)).toEqual(["fixed-value-drift"]);
    expect(failures[0]!.detail).toContain("remove it from the baseline");
  });
});
