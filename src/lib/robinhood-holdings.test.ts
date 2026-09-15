import { describe, expect, it } from "vitest";
import {
  ReconstructionError,
  extractDividendShareCounts,
  formatQuantityE8,
  parseQuantityE8,
  positionsAsOf,
  reconstructHoldings,
  verifyAgainstDividends,
  toActivityRows,
  mdyToIso,
  type ActivityRow,
} from "./robinhood-holdings";

/**
 * Fixtures are copied from the owner's real Robinhood export
 * (statements/robinhood/3ab6c2a8-….csv) — the dates, quantities and prices
 * below are the real rows, because the whole point of this module is that the
 * corrections it makes are read out of that file rather than invented.
 */
function row(over: Partial<ActivityRow> & Pick<ActivityRow, "settleDate">): ActivityRow {
  return {
    activityDate: over.activityDate ?? over.settleDate,
    settleDate: over.settleDate,
    symbol: over.symbol ?? "AAPL",
    code: over.code ?? "Buy",
    quantity: over.quantity ?? "",
    amountCents: over.amountCents ?? null,
    description: over.description ?? "",
  };
}

/** a dividend row, which states the share count it was paid on */
function dividend(symbol: string, recordDate: string, shares: string): ActivityRow {
  return row({
    settleDate: recordDate,
    symbol,
    code: "CDIV",
    description: `Cash Div: R/D ${recordDate} P/D ${recordDate} - ${shares} shares at 0.25`,
    amountCents: 2,
  });
}

describe("parseQuantityE8", () => {
  it("parses whole, fractional and grouped quantities exactly", () => {
    expect(parseQuantityE8("5")).toBe(500_000_000n);
    expect(parseQuantityE8("0.059926")).toBe(5_992_600n);
    expect(parseQuantityE8(".5")).toBe(50_000_000n);
    expect(parseQuantityE8("1,234.5")).toBe(123_450_000_000n);
    expect(parseQuantityE8(" 0.00000001 ")).toBe(1n);
  });

  it("refuses input that is not a decimal, or that would lose precision", () => {
    expect(() => parseQuantityE8("abc")).toThrow(ReconstructionError);
    expect(() => parseQuantityE8("")).toThrow(/Cannot parse quantity/);
    expect(() => parseQuantityE8("-1")).toThrow(/Cannot parse quantity/);
    expect(() => parseQuantityE8("1.123456789")).toThrow(/more than 8 decimal places/);
  });
});

describe("formatQuantityE8", () => {
  it("round-trips and strips trailing zeros", () => {
    expect(formatQuantityE8(2_673_700n)).toBe("0.026737");
    expect(formatQuantityE8(500_000_000n)).toBe("5");
    expect(formatQuantityE8(-1_818_417_600n)).toBe("-18.184176");
  });
});

describe("extractDividendShareCounts", () => {
  it("reads the share count Robinhood prints inside its own dividend lines", () => {
    const counts = extractDividendShareCounts([
      dividend("AAPL", "2026-05-11", "15.606784"),
      row({ settleDate: "2026-05-11", symbol: "", description: "R/D 2026-05-11 - 9 shares" }),
      row({ settleDate: "2026-05-11", symbol: "AAPL", description: "Brokerage Cash Interest" }),
    ]);
    expect(counts).toEqual([
      { symbol: "AAPL", recordDate: "2026-05-11", quantityE8: 1_560_678_400n },
    ]);
  });
});

describe("toActivityRows", () => {
  const amount = (raw: string) => Math.round(Number(raw.replace(/[$,()]/g, "")) * 100);

  it("maps the export's columns, keeping settle and activity dates apart", () => {
    expect(
      toActivityRows(
        [
          {
            "Activity Date": "7/31/2026",
            "Settle Date": "8/3/2026",
            Instrument: "AAPL",
            Description: "Apple\nCUSIP: 037833100",
            "Trans Code": "Buy",
            Quantity: "5",
            Amount: "1566.50",
          },
        ],
        amount,
      ),
    ).toEqual([
      {
        activityDate: "2026-07-31",
        settleDate: "2026-08-03",
        symbol: "AAPL",
        code: "Buy",
        quantity: "5",
        amountCents: 156_650,
        description: "Apple CUSIP: 037833100",
      },
    ]);
  });

  it("falls back to the activity date, treats a blank amount as no cash, and drops undated rows", () => {
    const rows = toActivityRows(
      [
        { "Activity Date": "12/5/2023", Instrument: "AAPL", "Trans Code": "REC", Quantity: "0.0267" },
        { Description: "The trailing disclaimer line carries no date" },
        // the interest rows carry no instrument, code or quantity column value
        { "Activity Date": "7/31/2026", Amount: "13.59" },
      ],
      amount,
    );
    expect(rows).toEqual([
      {
        activityDate: "2023-12-05",
        settleDate: "2023-12-05",
        symbol: "AAPL",
        code: "REC",
        quantity: "0.0267",
        amountCents: null,
        description: "",
      },
      {
        activityDate: "2026-07-31",
        settleDate: "2026-07-31",
        symbol: "",
        code: "",
        quantity: "",
        amountCents: 1359,
        description: "",
      },
    ]);
  });

  it("rejects a date it cannot read rather than guessing one", () => {
    expect(mdyToIso("2026-07-31")).toBeNull();
    expect(mdyToIso("7/31/2026")).toBe("2026-07-31");
  });
});

describe("reconstructHoldings — settle date is the basis", () => {
  it("excludes a trade that settles after the asked-for day", () => {
    // the real 2026-07-31 AAPL buy: 5 shares, Settle Date 2026-08-03. This is
    // the whole "AAPL is 5 shares off the statement" mystery.
    const rows = [
      row({ activityDate: "2026-07-30", settleDate: "2026-07-31", quantity: "0.060197", amountCents: -2000 }),
      row({ activityDate: "2026-07-31", settleDate: "2026-08-03", quantity: "5", amountCents: -156_650 }),
    ];
    const { events } = reconstructHoldings(rows);
    expect(positionsAsOf(events, "2026-07-31").get("AAPL")).toBe(6_019_700n);
    expect(positionsAsOf(events, "2026-08-03").get("AAPL")).toBe(506_019_700n);
  });

  it("applies a same-day buy before the sell it funds", () => {
    // 2025-06-24 really settles both a 0.099319 buy and an 18.184176 sell
    // against 18.084857 held — only non-negative if the buy lands first.
    const rows = [
      row({ settleDate: "2025-06-01", quantity: "18.084857", amountCents: -360_000 }),
      row({ activityDate: "2025-06-23", settleDate: "2025-06-24", code: "Sell", quantity: "18.184176", amountCents: 366_948 }),
      row({ activityDate: "2025-06-23", settleDate: "2025-06-24", quantity: "0.099319", amountCents: -2000 }),
    ];
    const { positions } = reconstructHoldings(rows);
    expect(positions).toEqual([
      { symbol: "AAPL", quantityE8: 0n, costCents: 0, avgCostCents: null },
    ]);
  });

  it("orders by trade date within one settle date", () => {
    const rows = [
      row({ activityDate: "2026-01-06", settleDate: "2026-01-07", quantity: "2", amountCents: -20_000 }),
      row({ activityDate: "2026-01-05", settleDate: "2026-01-07", quantity: "1", amountCents: -9_000 }),
    ];
    const { events } = reconstructHoldings(rows);
    expect(events.map((e) => e.quantityDeltaE8)).toEqual([100_000_000n, 200_000_000n]);
  });

  it("refuses to let a position go negative", () => {
    expect(() =>
      reconstructHoldings([
        row({ settleDate: "2025-01-02", code: "Sell", quantity: "1", amountCents: 10_000 }),
      ]),
    ).toThrow(/goes negative/);
  });
});

describe("reconstructHoldings — splits are a ratio, not the printed delta", () => {
  it("recovers the exact multiplier the export rounded away", () => {
    // COKE's real 10-for-1: 1.001455 held, printed delta 9.0131, true 9.013095
    const rows = [
      row({ settleDate: "2025-05-26", symbol: "COKE", quantity: "1.001455", amountCents: -120_000 }),
      row({ settleDate: "2025-05-27", symbol: "COKE", code: "SPL", quantity: "9.0131" }),
      dividend("COKE", "2025-07-25", "10.01455"),
    ];
    const { events, positions } = reconstructHoldings(rows);
    expect(events[1]!.quantityDeltaE8).toBe(901_309_500n);
    expect(positions[0]!.quantityE8).toBe(1_001_455_000n);
    expect(events[1]!.note).toBe("split 10.01455/1.001455 — export printed 9.0131");
    // 🔴 the kind travels with the event: a rebuild that wrote this row as a "trade"
    // (2026-09-15) erased the marker the valuation reads, and spring-2025 NAV fell
    // by up to $1,021.71 until the split was re-marked
    expect(events.map((e) => e.eventKind)).toEqual(["trade", "split"]);
  });

  it("leaves cost untouched across a split, so avg cost divides by the ratio", () => {
    const rows = [
      row({ settleDate: "2025-05-26", symbol: "COKE", quantity: "1", amountCents: -120_000 }),
      row({ settleDate: "2025-05-27", symbol: "COKE", code: "SPL", quantity: "9" }),
    ];
    const { positions } = reconstructHoldings(rows);
    expect(positions[0]).toEqual({
      symbol: "COKE",
      quantityE8: 1_000_000_000n,
      costCents: 120_000,
      avgCostCents: 12_000,
    });
  });

  it("refuses a split with nothing to split, or one smaller than the position", () => {
    expect(() =>
      reconstructHoldings([row({ settleDate: "2025-05-27", code: "SPL", quantity: "9" })]),
    ).toThrow(/no position to split/);

    expect(() =>
      reconstructHoldings([
        row({ settleDate: "2025-05-26", quantity: "10", amountCents: -100 }),
        row({ settleDate: "2025-05-27", code: "SPL", quantity: "1" }),
      ]),
    ).toThrow(/smaller than the/);
  });
});

describe("reconstructHoldings — rounded receipts are calibrated, not guessed", () => {
  it("reads the referral share's true quantity out of the next dividend", () => {
    // the real 2023-12-05 rows. The export prints 0.0267; the 2024-02-12
    // dividend states 0.086663 shares, and 0.086663 - 0.059926 = 0.026737.
    const rows = [
      row({ settleDate: "2023-12-05", code: "REC", quantity: "0.0267" }),
      row({ settleDate: "2023-12-05", quantity: "0.059926", amountCents: -1160 }),
      dividend("AAPL", "2024-02-12", "0.086663"),
    ];
    const { events, positions } = reconstructHoldings(rows);
    const receipt = events.find((e) => e.note?.startsWith("REC"))!;
    expect(receipt.quantityDeltaE8).toBe(2_673_700n);
    expect(receipt.note).toBe(
      "REC — export printed 0.0267, dividend record implies 0.026737",
    );
    expect(positions[0]!.quantityE8).toBe(8_666_300n);
    // a free share costs nothing, so the whole basis is the cash buy
    expect(positions[0]!.costCents).toBe(1160);
  });

  it("keeps the printed quantity and says so when no dividend follows", () => {
    const { events, positions } = reconstructHoldings([
      row({ settleDate: "2023-12-05", code: "REC", quantity: "0.0267" }),
    ]);
    expect(events[0]!.quantityDeltaE8).toBe(2_670_000n);
    expect(events[0]!.note).toBe(
      "REC — export printed 0.0267, no later dividend to calibrate against",
    );
    expect(positions[0]!.costCents).toBe(0);
    expect(positions[0]!.avgCostCents).toBe(0);
  });

  it("refuses a correction too large to be a rounding artefact", () => {
    // a dividend implying a wildly different position is a missing share
    // event, not a rounded one — say so instead of absorbing it
    expect(() =>
      reconstructHoldings([
        row({ settleDate: "2023-12-05", code: "REC", quantity: "0.0267" }),
        dividend("AAPL", "2024-02-12", "9.5"),
      ]),
    ).toThrow(/too far apart to be a rounding artefact/);
  });

  it("ignores events that settle after the calibrating dividend's record date", () => {
    const rows = [
      row({ settleDate: "2023-12-05", code: "REC", quantity: "0.0267" }),
      dividend("AAPL", "2024-02-12", "0.0267"),
      row({ settleDate: "2024-03-01", quantity: "4", amountCents: -80_000 }),
    ];
    const { events } = reconstructHoldings(rows);
    expect(events[0]!.quantityDeltaE8).toBe(2_670_000n);
  });
});

describe("reconstructHoldings — average cost", () => {
  it("releases cost in proportion to the shares sold", () => {
    const rows = [
      row({ settleDate: "2025-01-02", quantity: "4", amountCents: -40_000 }),
      row({ settleDate: "2025-02-03", code: "Sell", quantity: "1", amountCents: 15_000 }),
    ];
    const { events, positions } = reconstructHoldings(rows);
    expect(events[1]!.costCents).toBe(-10_000);
    expect(positions[0]).toEqual({
      symbol: "AAPL",
      quantityE8: 300_000_000n,
      costCents: 30_000,
      avgCostCents: 10_000,
    });
  });

  it("zeroes the basis of an exited position", () => {
    const { positions } = reconstructHoldings([
      row({ settleDate: "2025-01-02", symbol: "PM", quantity: "2", amountCents: -20_000 }),
      row({ settleDate: "2025-02-03", symbol: "PM", code: "Sell", quantity: "2", amountCents: 25_000 }),
    ]);
    expect(positions[0]).toEqual({
      symbol: "PM",
      quantityE8: 0n,
      costCents: 0,
      avgCostCents: null,
    });
  });

  it("skips rows that move no shares", () => {
    const { events, positions } = reconstructHoldings([
      row({ settleDate: "2025-01-02", symbol: "", code: "INT", amountCents: 1359 }),
      row({ settleDate: "2025-01-02", code: "CDIV", amountCents: 421 }),
    ]);
    expect(events).toEqual([]);
    expect(positions).toEqual([]);
  });
});

describe("verifyAgainstDividends", () => {
  it("is what makes the corrections safe — a wrong one shows up as a mismatch", () => {
    const rows = [
      row({ settleDate: "2023-12-05", quantity: "0.059926", amountCents: -1160 }),
      dividend("AAPL", "2024-02-12", "0.059926"),
      dividend("AAPL", "2024-05-13", "9.9"),
    ];
    const { events } = reconstructHoldings(rows);
    const checks = verifyAgainstDividends(events, rows);
    expect(checks.map((c) => c.matches)).toEqual([true, false]);
    expect(checks[1]).toMatchObject({
      symbol: "AAPL",
      recordDate: "2024-05-13",
      expectedE8: 990_000_000n,
      actualE8: 5_992_600n,
    });
  });

  it("counts each symbol's own events only", () => {
    const rows = [
      row({ settleDate: "2025-01-02", symbol: "MSFT", quantity: "1", amountCents: -40_000 }),
      row({ settleDate: "2025-01-02", symbol: "SPY", quantity: "9", amountCents: -600_000 }),
      dividend("MSFT", "2025-03-01", "1"),
    ];
    const { events } = reconstructHoldings(rows);
    expect(verifyAgainstDividends(events, rows)[0]!.matches).toBe(true);
  });
});

describe("reconstructHoldings — ordering holds whatever order the export arrives in", () => {
  // the real export is newest-first, so every comparator is exercised in
  // reverse as well as forward
  it("sorts a reverse-chronological file, and reports symbols alphabetically", () => {
    const rows = [
      row({ settleDate: "2026-01-08", symbol: "SPY", quantity: "1", amountCents: -70_000 }),
      row({ settleDate: "2026-01-02", symbol: "AAPL", quantity: "2", amountCents: -40_000 }),
      row({ activityDate: "2026-01-05", settleDate: "2026-01-06", symbol: "AAPL", quantity: "3", amountCents: -60_000 }),
      row({ activityDate: "2026-01-02", settleDate: "2026-01-06", symbol: "AAPL", quantity: "4", amountCents: -80_000 }),
    ];
    const { events, positions } = reconstructHoldings(rows);
    expect(events.map((e) => [e.occurredOn, e.quantityDeltaE8])).toEqual([
      ["2026-01-02", 200_000_000n],
      ["2026-01-06", 400_000_000n],
      ["2026-01-06", 300_000_000n],
      ["2026-01-08", 100_000_000n],
    ]);
    expect(positions.map((p) => p.symbol)).toEqual(["AAPL", "SPY"]);
  });

  it("applies a split last among rows sharing its trade AND settle date", () => {
    const rows = [
      row({ settleDate: "2025-05-27", symbol: "COKE", code: "SPL", quantity: "9" }),
      row({ settleDate: "2025-05-27", symbol: "COKE", code: "Sell", quantity: "0.5", amountCents: 60_000 }),
      row({ settleDate: "2025-05-27", symbol: "COKE", quantity: "1.5", amountCents: -180_000 }),
    ];
    const { events } = reconstructHoldings(rows);
    // buy 1.5 → sell 0.5 → 1.0 held, then ×10
    expect(events.map((e) => e.quantityDeltaE8)).toEqual([
      150_000_000n,
      -50_000_000n,
      900_000_000n,
    ]);
  });

  it("nets a sell inside the calibration window, and picks the earliest usable dividend", () => {
    const rows = [
      // a dividend on another symbol, and one predating the receipt, are both
      // irrelevant — the calibration must reach past them to AAPL's first
      dividend("MSFT", "2024-01-15", "3"),
      row({ settleDate: "2023-11-01", symbol: "MSFT", quantity: "3", amountCents: -120_000 }),
      dividend("AAPL", "2023-06-01", "0"),
      row({ settleDate: "2023-12-05", code: "REC", quantity: "0.0267" }),
      row({ settleDate: "2023-12-06", quantity: "1", amountCents: -19_357 }),
      row({ settleDate: "2023-12-07", code: "Sell", quantity: "0.5", amountCents: 9_700 }),
      dividend("AAPL", "2024-05-13", "0.6"),
      dividend("AAPL", "2024-02-12", "0.526737"),
      dividend("AAPL", "2024-08-14", "0.9"),
    ];
    const { events } = reconstructHoldings(rows);
    // calibrated against the 2024-02-12 line: 0.526737 - (1 - 0.5) = 0.026737
    const receipt = events.find((e) => e.note?.startsWith("REC"))!;
    expect(receipt.quantityDeltaE8).toBe(2_673_700n);
  });

  it("refuses a dividend implying FEWER shares than the export printed", () => {
    expect(() =>
      reconstructHoldings([
        row({ settleDate: "2023-12-05", code: "REC", quantity: "0.0267" }),
        dividend("AAPL", "2024-02-12", "0.0266"),
      ]),
    ).toThrow(/too far apart to be a rounding artefact/);
  });
});

describe("positionsAsOf", () => {
  it("accumulates only what has settled by the day asked for", () => {
    const { events } = reconstructHoldings([
      row({ settleDate: "2025-01-02", quantity: "1", amountCents: -20_000 }),
      row({ settleDate: "2025-06-02", quantity: "2", amountCents: -40_000 }),
      row({ settleDate: "2025-06-02", symbol: "SPY", quantity: "3", amountCents: -200_000 }),
    ]);
    expect(positionsAsOf(events, "2025-01-02")).toEqual(new Map([["AAPL", 100_000_000n]]));
    expect(positionsAsOf(events, "2025-06-02")).toEqual(
      new Map([
        ["AAPL", 300_000_000n],
        ["SPY", 300_000_000n],
      ]),
    );
  });
});
