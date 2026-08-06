import { describe, expect, test } from "vitest";
import {
  formatSharePct,
  subtotalAnnouncement,
  subtotalCoverage,
  subtotalHoldings,
  type SubtotalSource,
} from "./holding-subtotal";
import { holdingKey } from "@/components/investments/PortfolioHoldingsTable";

/** A fully priced row; each case overrides only the fields it is about. */
function row(overrides: Partial<SubtotalSource> = {}): SubtotalSource {
  return { valueCents: 100_00, dayChangeCents: 1_00, allocationPct: 10, ...overrides };
}

describe("subtotalHoldings", () => {
  test("sums every figure when all values are present", () => {
    const s = subtotalHoldings([
      row({ valueCents: 1_234_56, dayChangeCents: 12_34, allocationPct: 25 }),
      row({ valueCents: 765_44, dayChangeCents: -2_34, allocationPct: 15 }),
    ]);
    expect(s.selected).toBe(2);
    expect(s.valueCents).toEqual({ total: 2_000_00, contributors: 2 });
    expect(s.dayChangeCents).toEqual({ total: 10_00, contributors: 2 });
    expect(s.allocationPct.total).toBeCloseTo(40, 10);
    expect(s.allocationPct.contributors).toBe(2);
  });

  test("an unpriced row is omitted from the total AND disclosed by the count", () => {
    const s = subtotalHoldings([
      row({ valueCents: 300_00 }),
      row({ valueCents: 200_00 }),
      // no cached close: no value, no day change, no share
      row({ valueCents: null, dayChangeCents: null, allocationPct: null }),
    ]);
    expect(s.selected).toBe(3);
    // the total is the sum of what exists — the caller must say "2 of 3"
    expect(s.valueCents).toEqual({ total: 500_00, contributors: 2 });
    expect(subtotalCoverage(s.valueCents, s.selected, "priced")).toBe("2 of 3 priced");
  });

  test("a total is null, never $0.00, when nothing contributed", () => {
    const s = subtotalHoldings([
      row({ valueCents: null, dayChangeCents: null, allocationPct: null }),
      row({ valueCents: null, dayChangeCents: null, allocationPct: null }),
    ]);
    expect(s.selected).toBe(2);
    expect(s.valueCents).toEqual({ total: null, contributors: 0 });
    expect(s.dayChangeCents.total).toBeNull();
    expect(s.allocationPct.total).toBeNull();
  });

  test("a priced row with no day change keeps its value in the value total", () => {
    // one cached close only: valued and allocated, but no previous day to diff
    const s = subtotalHoldings([row({ valueCents: 400_00 }), row({ valueCents: 600_00, dayChangeCents: null })]);
    expect(s.valueCents).toEqual({ total: 1_000_00, contributors: 2 });
    expect(s.dayChangeCents).toEqual({ total: 1_00, contributors: 1 });
    expect(subtotalCoverage(s.valueCents, s.selected, "priced")).toBeNull();
    expect(subtotalCoverage(s.dayChangeCents, s.selected, "with a day change")).toBe(
      "1 of 2 with a day change",
    );
  });

  test("two legs of one symbol both count — allocationPct is per leg, not per symbol", () => {
    // services/portfolio.ts computes allocationPct as leg value ÷ whole
    // portfolio, so the same symbol in two accounts contributes twice and the
    // sum IS the combined share. Note this reducer cannot dedupe even in
    // principle — SubtotalSource carries no symbol — so the property that
    // actually keeps the two legs apart is the selection key, pinned in
    // holdingKey's own test below.
    const s = subtotalHoldings([
      row({ valueCents: 500_00, allocationPct: 5 }),
      row({ valueCents: 300_00, allocationPct: 3 }),
    ]);
    expect(s.allocationPct.total).toBeCloseTo(8, 10);
    expect(s.allocationPct.contributors).toBe(2);
    expect(s.valueCents.total).toBe(800_00);
  });

  test("empty selection totals nothing and counts nothing", () => {
    const s = subtotalHoldings([]);
    expect(s).toEqual({
      selected: 0,
      valueCents: { total: null, contributors: 0 },
      dayChangeCents: { total: null, contributors: 0 },
      allocationPct: { total: null, contributors: 0 },
    });
  });
});

describe("subtotalCoverage", () => {
  test("a complete figure carries no caveat", () => {
    expect(subtotalCoverage({ total: 1_00, contributors: 3 }, 3, "priced")).toBeNull();
  });

  test("an incomplete figure names both counts", () => {
    expect(subtotalCoverage({ total: 1_00, contributors: 1 }, 4, "priced")).toBe("1 of 4 priced");
  });

  test("a figure nothing fed still discloses the shortfall", () => {
    expect(subtotalCoverage({ total: null, contributors: 0 }, 2, "priced")).toBe("0 of 2 priced");
  });
});

describe("formatSharePct", () => {
  test("prints one decimal, matching the Alloc column", () => {
    expect(formatSharePct(8.000000000000002)).toBe("8.0%");
    expect(formatSharePct(0)).toBe("0.0%");
  });
});

describe("subtotalAnnouncement", () => {
  test("says nothing when nothing is selected", () => {
    expect(subtotalAnnouncement(subtotalHoldings([]))).toBe("");
  });

  test("states count, value, share and day change for a complete selection", () => {
    const s = subtotalHoldings([row({ valueCents: 1_000_00, dayChangeCents: 25_00, allocationPct: 12.5 })]);
    expect(subtotalAnnouncement(s)).toBe(
      "1 holding selected: $1,000.00, 12.5% of the portfolio, +$25.00 today.",
    );
  });

  test("discloses the omission in the sentence, not only in the bar", () => {
    const s = subtotalHoldings([
      row({ valueCents: 500_00, dayChangeCents: 5_00, allocationPct: 20 }),
      row({ valueCents: null, dayChangeCents: null, allocationPct: null }),
    ]);
    expect(subtotalAnnouncement(s)).toBe(
      "2 holdings selected: $500.00 (1 of 2 priced), 20.0% of the portfolio (1 of 2 with a share), +$5.00 today (1 of 2 with a day change).",
    );
  });

  test("never announces a $0.00 total for a wholly unpriced selection", () => {
    const s = subtotalHoldings([row({ valueCents: null, dayChangeCents: null, allocationPct: null })]);
    const said = subtotalAnnouncement(s);
    expect(said).toBe(
      "1 holding selected: no market value — none of them is priced, no share of the portfolio, no day change.",
    );
    expect(said).not.toContain("$0.00");
  });
});

describe("holdingKey — what actually keeps two legs of one symbol apart", () => {
  test("the same symbol in two accounts is two distinct selections", () => {
    // keying on symbol alone would make one tick select both legs and report a
    // subtotal for holdings the user never chose
    const a = holdingKey({ accountId: "acct-brokerage", symbol: "AAPL" });
    const b = holdingKey({ accountId: "acct-ira", symbol: "AAPL" });
    expect(a).not.toBe(b);
  });

  test("the same leg is the same selection across re-sorts", () => {
    // selection survives sorting because the id is CONTENT, not a row index
    expect(holdingKey({ accountId: "acct-1", symbol: "MSFT" })).toBe(
      holdingKey({ accountId: "acct-1", symbol: "MSFT" }),
    );
  });

  test("two symbols in one account are two distinct selections", () => {
    expect(holdingKey({ accountId: "acct-1", symbol: "AAPL" })).not.toBe(
      holdingKey({ accountId: "acct-1", symbol: "AMZN" }),
    );
  });
});
