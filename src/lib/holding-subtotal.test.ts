import { describe, expect, test } from "vitest";
import { sharePercent } from "./insight-facts";
import {
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
      allocationShare: null,
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

/**
 * 🔴 S28's second surface. The bar printed `sharePercent(Σ allocationPct)` — the
 * unrounded sum, rounded once — directly under Alloc cells that each round on
 * their own. Measured on the owner's ledger 2026-09-15: ticking AAPL 6.5%, AMZN
 * 8.2% and SPY 15.5% put "Share 30.1%" under rows adding to 30.2 — 13 of the 120
 * two- and three-row selections that hold no sliver row disagreed that way.
 *
 * ⚖️ Owner decision 2026-09-14 (F2): the subtotal is the SUM of the rounded rows,
 * so every holding keeps the one share it prints everywhere.
 */
describe("the Share a selection prints is the sum of the Alloc cells ticked", () => {
  test("adds the tenths the ticked rows print, not the unrounded shares", () => {
    // today's AAPL, AMZN and SPY on the owner's ledger
    const s = subtotalHoldings([
      row({ allocationPct: 6.475920654411064 }),
      row({ allocationPct: 8.175320690731345 }),
      row({ allocationPct: 15.454985839403612 }),
    ]);
    expect(s.allocationShare).toBe("30.2%");
    expect(subtotalHoldings([row({ allocationPct: 21.3886 }), row({ allocationPct: 8.1522 })]).allocationShare).toBe(
      "29.6%",
    );
    expect(subtotalHoldings([row({ allocationPct: 33.8685 }), row({ allocationPct: 6.4576 })]).allocationShare).toBe(
      "40.4%",
    );
  });

  /**
   * 🔴 Ticking WMT alone on /investments put "Share 0.0%" in the subtotal bar
   * directly under a row whose own Alloc cell already read "<0.1%" — the same
   * $43.70, two answers, one screen.
   */
  test("a lone sliver reads <0.1%, exactly as the row it subtotals does", () => {
    expect(subtotalHoldings([row({ allocationPct: 0.04001679056915048 })]).allocationShare).toBe(
      sharePercent(0.04001679056915048),
    );
    expect(subtotalHoldings([row({ allocationPct: 0.04001679056915048 })]).allocationShare).toBe("<0.1%");
    // …and a sliver beside a printed row adds nothing a reader can see
    expect(subtotalHoldings([row({ allocationPct: 0.0413 }), row({ allocationPct: 21.3886 })]).allocationShare).toBe(
      "21.4%",
    );
  });

  test("a share that IS zero still prints a zero, and one row prints its own cell", () => {
    expect(subtotalHoldings([row({ allocationPct: 0 })]).allocationShare).toBe("0.0%");
    expect(subtotalHoldings([row({ allocationPct: 8.000000000000002 })]).allocationShare).toBe("8.0%");
    expect(subtotalHoldings([row({ allocationPct: 0.05 })]).allocationShare).toBe("0.1%");
  });

  test("an unshared row is left out of the sum as it is left out of the total", () => {
    expect(subtotalHoldings([row({ allocationPct: 21.3886 }), row({ allocationPct: null })]).allocationShare).toBe(
      "21.4%",
    );
    expect(subtotalHoldings([row({ allocationPct: null })]).allocationShare).toBeNull();
    expect(subtotalHoldings([]).allocationShare).toBeNull();
  });

  test("the live region says the figure the bar prints", () => {
    const s = subtotalHoldings([
      row({ valueCents: 1_000_00, dayChangeCents: 0, allocationPct: 21.3886 }),
      row({ valueCents: 1_000_00, dayChangeCents: 0, allocationPct: 8.1522 }),
    ]);
    expect(subtotalAnnouncement(s, "today")).toContain("29.6% of the portfolio");
  });

  /**
   * ⚠️ AN OPEN QUESTION, pinned as shipped — and reachable today. Ticking every
   * row on /investments except WMT puts nine Alloc cells adding to exactly 100.0
   * above a bar (and a live region) reading ">99.9%" — the only one of the 511
   * selections without a "<0.1%" row where the bar is not the sum of its cells,
   * measured on the owner's ledger 2026-09-15 at these shares. Two of his rules
   * meet here: F2 (2026-09-14) says the subtotal is the sum of the rows, so
   * "100.0%"; `renderPercent`'s floor says a selection that leaves a priced
   * holding out is not the whole — the mirror of the "Share 0.0%" over WMT alone
   * that this bar already refuses. Kept on the floor until he rules.
   */
  test("every row but a sliver: the cells add to 100.0, and the bar will not claim the whole", () => {
    const allButWmt = [
      6.475920654411064, 8.175320690731345, 6.213988850463129, 0.09923383295589179, 5.528794558528278,
      18.20668294992252, 15.454985839403612, 6.803528114218564, 33.00000284469098,
    ];
    const cells = allButWmt.map(sharePercent);
    expect(cells).toEqual(["6.5%", "8.2%", "6.2%", "0.1%", "5.5%", "18.2%", "15.5%", "6.8%", "33.0%"]);
    expect(cells.reduce((s, c) => s + Math.round(Number.parseFloat(c) * 10), 0)).toBe(1000);

    const s = subtotalHoldings(allButWmt.map((p) => row({ allocationPct: p })));
    expect(s.allocationShare).toBe(">99.9%");
    expect(subtotalAnnouncement(s, "today")).toContain(">99.9% of the portfolio");
    // ticking WMT as well IS the whole, and says so
    const all = [...allButWmt, 0.041541664674618284].map((p) => row({ allocationPct: p }));
    expect(subtotalHoldings(all).allocationShare).toBe("100.0%");
  });
});

describe("subtotalAnnouncement", () => {
  test("says nothing when nothing is selected", () => {
    expect(subtotalAnnouncement(subtotalHoldings([]), "today")).toBe("");
  });

  test("states count, value, share and day change for a complete selection", () => {
    const s = subtotalHoldings([row({ valueCents: 1_000_00, dayChangeCents: 25_00, allocationPct: 12.5 })]);
    expect(subtotalAnnouncement(s, "today")).toBe(
      "1 holding selected: $1,000.00, 12.5% of the portfolio, +$25.00 today.",
    );
  });

  test("discloses the omission in the sentence, not only in the bar", () => {
    const s = subtotalHoldings([
      row({ valueCents: 500_00, dayChangeCents: 5_00, allocationPct: 20 }),
      row({ valueCents: null, dayChangeCents: null, allocationPct: null }),
    ]);
    expect(subtotalAnnouncement(s, "today")).toBe(
      "2 holdings selected: $500.00 (1 of 2 priced), 20.0% of the portfolio (1 of 2 with a share), +$5.00 today (1 of 2 with a day change).",
    );
  });

  test("calls the day change what the caller calls it, never 'today' by default", () => {
    /*
     * The word used to be hardcoded. The summed figure is each holding's last
     * close against its previous one, so it is only today's move when prices
     * were refreshed today — and on the real ledger the closes trail by about a
     * week. This channel is the one whose user cannot see the price-age note
     * that would contradict it, so the label has to arrive already correct.
     */
    const s = subtotalHoldings([row({ valueCents: 1_000_00, dayChangeCents: 25_00, allocationPct: 12.5 })]);
    expect(subtotalAnnouncement(s, "last close")).toContain("+$25.00 last close.");
    expect(subtotalAnnouncement(s, "last close")).not.toContain("today");
    // and the coverage caveat still lands AFTER the term, not inside it
    const partial = subtotalHoldings([
      row({ valueCents: 500_00, dayChangeCents: 5_00, allocationPct: 20 }),
      row({ valueCents: null, dayChangeCents: null, allocationPct: null }),
    ]);
    expect(subtotalAnnouncement(partial, "last close")).toContain(
      "+$5.00 last close (1 of 2 with a day change)",
    );
  });

  test("never announces a $0.00 total for a wholly unpriced selection", () => {
    const s = subtotalHoldings([row({ valueCents: null, dayChangeCents: null, allocationPct: null })]);
    const said = subtotalAnnouncement(s, "today");
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
