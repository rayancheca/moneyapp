import { describe, expect, it } from "vitest";
import {
  type LedgerBaseline,
  type LedgerObservation,
  compareToBaseline,
  findChainBreaks,
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
  ...over,
});

const baseline: LedgerBaseline = {
  breaks: { "Robinhood Cash": [{ from: "2026-02-28", to: "2026-03-31", offByCents: -1 }] },
  syntheticNetCents: { "Robinhood Cash": -3_235_861 },
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
      { breaks: {}, syntheticNetCents: {} },
    );
    const text = formatLedgerFailures(failures);
    expect(text).toContain("Chase Checking");
    expect(text).toContain("$50.00");
  });
});
