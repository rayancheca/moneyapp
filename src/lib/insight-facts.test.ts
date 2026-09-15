import { describe, expect, test } from "vitest";
import {
  countFact,
  deltaFact,
  factSet,
  rankFact,
  scalarFact,
  shareFact,
  multipleFact,
  multipleOfMagnitudes,
  renderMultiple,
  trendFact,
  renderPercent,
  sharePercent,
  spendingShare,
  spendingShareBase,
  sumOfPrintedShares,
} from "./insight-facts";

/**
 * 🔴 S17. Three hand copies of "a share of spending divides by the POSITIVE
 * spend" existed — the relief's, the Table lens's and the List lens's — and the
 * relief's summed its rows AFTER folding a refund into them, so on
 * `/spending?period=2025-02` its widths divided $5,500.44 while the table beside
 * it divided $5,585.07.
 */
describe("spendingShareBase — the one denominator of a share of spending", () => {
  test("sums what was spent; a category that netted money back is dropped, not subtracted", () => {
    expect(spendingShareBase([{ spentCents: 50_000 }, { spentCents: -4_000 }, { spentCents: 8_000 }])).toBe(58_000);
  });

  test("nothing spent is a zero base, and a refund alone does not make it negative", () => {
    expect(spendingShareBase([])).toBe(0);
    expect(spendingShareBase([{ spentCents: -1 }])).toBe(0);
    expect(spendingShareBase([{ spentCents: 0 }])).toBe(0);
  });
});

/**
 * 🔴 S28. A subtotal printed beside rows was `sharePercent(Σ)` — the unrounded
 * sum rounded once — while each row rounds on its own, so a reader adding the
 * rows landed a tenth away from the figure beside them. Measured on the owner's
 * ledger 2026-09-15: "Individual stocks 51.5%" under stock rows adding to 51.6,
 * and "Share 30.1%" under ticked Alloc cells adding to 30.2.
 *
 * ⚖️ Owner decision 2026-09-14 (F2): the subtotal is the SUM of the rounded rows,
 * the movers card's "the total is the sum of the rows" — never an apportionment
 * that moves a row off its honest round.
 */
describe("sumOfPrintedShares — a subtotal is the sum of the rows printed beside it", () => {
  test("adds the tenths the rows print, not the unrounded shares", () => {
    // ETH 54.7375% prints 54.7% and AAPL 13.5147% prints 13.5%: a reader adds 68.2
    expect(sumOfPrintedShares([54.7375, 13.5147])).toBe("68.2%");
    expect(sharePercent(54.7375 + 13.5147)).toBe("68.3%");
    expect(sumOfPrintedShares([21.3886, 8.1522])).toBe("29.6%");
    expect(sumOfPrintedShares([33.8685, 6.4576])).toBe("40.4%");
  });

  test("one row's subtotal is that row, floors and all", () => {
    const rows = [0, 0.0413, 0.05, 8.000000000000002, 33, 49.92, 99.94, 99.97, 100, -0.03, -30];
    for (const p of rows) expect(sumOfPrintedShares([p])).toBe(sharePercent(p));
    expect(rows.map((p) => sumOfPrintedShares([p]))).toHaveLength(11);
  });

  test("rows that all print a floor never add to a printed zero", () => {
    expect(sumOfPrintedShares([0.02, 0.02])).toBe("<0.1%");
    // three slivers really are 0.12% — "<0.1%" would be false, "0.0%" worse
    expect(sumOfPrintedShares([0.04, 0.04, 0.04])).toBe("0.1%");
    expect(sumOfPrintedShares([0, 0])).toBe("0.0%");
    expect(sumOfPrintedShares([])).toBe("0.0%");
  });

  test("a sliver beside a printed row adds nothing a reader can see", () => {
    expect(sumOfPrintedShares([0.0413, 21.3886])).toBe("21.4%");
  });

  test("rows printing to the whole of something that is not the whole never claim it", () => {
    // 59.97 prints 60.0 and 39.99 prints 40.0, of 99.96 — past renderPercent's own floor
    expect(sumOfPrintedShares([59.97, 39.99])).toBe(">99.9%");
    // one near-whole row keeps its own floor beside a sliver
    expect(sumOfPrintedShares([99.97, 0.01])).toBe(">99.9%");
  });

  /**
   * 🔴 …nor a floor that is false. Whenever the rows printed to 100.0 or more
   * short of the whole, the subtotal said ">99.9%" — which is true only from
   * 99.95% up. Ten rows of 9.96% each print 10.0% and add to 100.0 on screen, of
   * a real 99.6% (second reader on uc/shares-rounding, 2026-09-15). No sum a
   * reader makes is true there — 100.0% of something that is not the whole, or
   * 100.2% of anything — so the subtotal is the selection's own share by
   * renderPercent's rule.
   */
  test("rows printing to the whole of well short of it print the real share, never a false floor", () => {
    expect(sumOfPrintedShares(Array.from({ length: 10 }, () => 9.96))).toBe("99.6%");
    // nine rows of 10.06 print 10.1 and 9.26 prints 9.3: the rows add to 100.2 of a real 99.8
    expect(sumOfPrintedShares([...Array.from({ length: 9 }, () => 10.06), 9.26])).toBe("99.8%");
    // 59.96 prints 60.0 and 39.96 prints 40.0, of 99.92 — which renderPercent prints 99.9%
    expect(sumOfPrintedShares([59.96, 39.96])).toBe("99.9%");
  });

  /**
   * 🔴 The tenths a subtotal adds must be the tenths `sharePercent` PRINTS, and
   * `sharePercent` rounds `(pct / 100) * 100`, not `pct`: on a tie the round trip
   * lands on the other tenth. A row reading "0.9%" was added as 0.8, one reading
   * "7.2%" as 7.3 — 48 of ten million shares on a 0.00001 grid disagreed that way
   * (measured 2026-09-15).
   */
  test("the tenths added are the tenths printed, even on a tie", () => {
    expect([0.85, 1.65, 7.25].map(sharePercent)).toEqual(["0.9%", "1.7%", "7.2%"]);
    expect(sumOfPrintedShares([0.85])).toBe("0.9%");
    expect(sumOfPrintedShares([7.25])).toBe("7.2%");
    expect(sumOfPrintedShares([0.85, 1.65])).toBe("2.6%");
  });

  test("rows printing PAST the whole of the whole stop at the whole", () => {
    // 33.35 prints 33.4 twice: 100.1 of exactly 100
    expect(sumOfPrintedShares([33.35, 33.35, 33.3])).toBe("100.0%");
    // sevenths print 14.3 seven times (100.1) and their float sum is 99.99999999999997 —
    // a whole that floating point shaved must not read as short of it
    const sevenths = Array.from({ length: 7 }, () => (1 / 7) * 100);
    expect(sevenths.reduce((s, p) => s + p, 0)).toBeLessThan(100);
    expect(sumOfPrintedShares(sevenths)).toBe("100.0%");
  });

  test("rows printing short of the whole keep the sum a reader makes", () => {
    // thirds print 33.3 three times: the rows say 99.9, and so does their subtotal
    const thirds = Array.from({ length: 3 }, () => (1 / 3) * 100);
    expect(sumOfPrintedShares(thirds)).toBe("99.9%");
  });
});

describe("a fact renders itself, and the caller cannot disagree with it", () => {
  test("display comes from value, so the words and the number cannot drift", () => {
    expect(scalarFact("f1", "Dining", 196324, "money").display).toBe("$1,963.24");
    expect(scalarFact("f1", "Runway", 1.3, "months").display).toBe("1.3 months");
    expect(scalarFact("f1", "Runway", 1, "months").display).toBe("1 month");
    expect(scalarFact("f1", "Gap", 0, "days").display).toBe("0 days");
    expect(scalarFact("f1", "Accounts", 12, "plain").display).toBe("12");
    expect(shareFact("f1", "ETH", 0.323, "everything you own").display).toBe("32.3%");
  });

  test("a delta keeps its sign and a scalar never grows one", () => {
    expect(deltaFact("f1", "Travel", 99800, "money", "June", "July").display).toBe("+$998.00");
    expect(deltaFact("f1", "Travel", -99800, "money", "June", "July").display).toBe("-$998.00");
    expect(deltaFact("f1", "Travel", 0, "money", "June", "July").display).toBe("$0.00");
    expect(scalarFact("f1", "Travel", 99800, "money").display).toBe("$998.00");
  });

  test("zero is not an increase in any unit", () => {
    // "+0.0%" would claim a rise that did not happen; formatCentsSigned already
    // drops the sign at zero and every other unit follows it
    expect(deltaFact("f1", "Rent", 0, "percent", "June", "July").display).toBe("0.0%");
    expect(deltaFact("f1", "Rent", 0, "days", "June", "July").display).toBe("0 days");
    expect(deltaFact("f1", "Rent", 0, "plain", "June", "July").display).toBe("0");
    expect(deltaFact("f1", "Rent", -0.5, "plain", "June", "July").display).toBe("-0.5");
    expect(deltaFact("f1", "Rent", -2, "days", "June", "July").display).toBe("-2 days");
    expect(deltaFact("f1", "Rent", -0.05, "percent", "June", "July").display).toBe("-5.0%");
  });

  test("a count says what it counted, and pluralises it", () => {
    expect(countFact("f1", "Dining", 502, "purchase", "in Jul 2026").display).toBe("502 purchases");
    expect(countFact("f1", "Dining", 1, "purchase", "in Jul 2026").display).toBe("1 purchase");
    expect(countFact("f1", "Dining", 0, "purchase", "in Jul 2026").display).toBe("0 purchases");
    expect(countFact("f1", "Rows", 10111, "row", "in Jul 2026").display).toBe("10,111 rows");
  });

  test("a rank displays the ordinal alone — the set size is its frame, not its value", () => {
    // "3rd of 22" in the display AND "22 categories" in the frame produced
    // "sits 1st of 2 of your 2 spending categories" the first time one template
    // read both
    expect(rankFact("f1", "Dining", 1, 22, "categories").display).toBe("1st");
    expect(rankFact("f1", "Dining", 2, 22, "categories").display).toBe("2nd");
    expect(rankFact("f1", "Dining", 3, 22, "categories").display).toBe("3rd");
    expect(rankFact("f1", "Dining", 4, 22, "categories").display).toBe("4th");
    // the teens are the case an ordinal helper always gets wrong
    expect(rankFact("f1", "Dining", 11, 22, "categories").display).toBe("11th");
    expect(rankFact("f1", "Dining", 12, 22, "categories").display).toBe("12th");
    expect(rankFact("f1", "Dining", 13, 22, "categories").display).toBe("13th");
    expect(rankFact("f1", "Dining", 21, 22, "categories").display).toBe("21st");
    expect(rankFact("f1", "Dining", 111, 222, "categories").display).toBe("111th");
  });

  test("a trend states how many observations it read", () => {
    expect(trendFact("f1", "Dining", "rising", "March", 6).display).toBe("rising across 6 months since March");
    expect(trendFact("f1", "Rent", "flat", "March", 12).display).toBe("flat across 12 months since March");
  });
});

describe("a multiple", () => {
  test("renders as a magnitude with a times sign", () => {
    expect(multipleFact("f1", "This charge", 21.8, "your usual there").display).toBe("21.8×");
    expect(multipleFact("f1", "This charge", 1, "your usual there").display).toBe("1.0×");
  });

  test("⛔ a multiple at or below zero is refused, not rendered", () => {
    // a caller producing one has divided by something that was not a
    // magnitude — most often a median that netted to zero across refunds
    expect(() => multipleFact("f1", "x", 0, "y")).toThrow(/above zero/);
    expect(() => multipleFact("f1", "x", -3, "y")).toThrow(/above zero/);
    expect(() => multipleFact("f1", "x", Number.POSITIVE_INFINITY, "y")).toThrow(/above zero/);
  });

  /**
   * 🔴 The refusal keeps "0.0×" off a multiple at zero, and `toFixed(1)` put it
   * straight back on every multiple ABOVE zero and under 0.05 — a measured zero
   * printed over two magnitudes. `renderPercent`'s floor, applied to a multiple.
   */
  test("⛔ a multiple too small for a tenth reads <0.1×, never a measured 0.0×", () => {
    expect(multipleFact("f1", "x", 0.03, "y").display).toBe("<0.1×");
    expect(multipleFact("f1", "x", 0.049999, "y").display).toBe("<0.1×");
    expect(multipleFact("f1", "x", 1e-318, "y").display).toBe("<0.1×");
    // the first value `toFixed(1)` already rounds up to a tenth keeps its tenth
    expect(multipleFact("f1", "x", 0.05, "y").display).toBe("0.1×");
    expect(multipleFact("f1", "x", 0.3, "y").display).toBe("0.3×");
    for (let v = 1e-6; v < 2; v *= 1.37) {
      expect(multipleFact("f1", "x", v, "y").display).not.toBe("0.0×");
    }
  });
});

/**
 * 🔴 The rule `multipleFact` enforces had one caller. The eating-out card
 * divided its two nets itself and printed "-2.0×" and "0.0×" when refunds
 * outweighed a bucket — see `eating-out-multiple.test.ts`. This is the rule
 * where a caller holding two quantities can ask it BEFORE dividing.
 */
describe("a multiple of two magnitudes", () => {
  test("is the ratio when both are above zero", () => {
    expect(multipleOfMagnitudes(6000, 1500)).toBe(4);
    expect(multipleOfMagnitudes(1500, 6000)).toBe(0.25);
  });

  test("⛔ is nothing when either side is at or below zero", () => {
    expect(multipleOfMagnitudes(0, 1500)).toBeNull();
    expect(multipleOfMagnitudes(-3000, 1500)).toBeNull();
    expect(multipleOfMagnitudes(6000, 0)).toBeNull();
    expect(multipleOfMagnitudes(6000, -1500)).toBeNull();
  });

  /** ⛔ The trap a check on the RATIO alone walks into: −3000 / −2000 is a healthy-looking 1.5. */
  test("⛔ two nets that both went negative are no multiple, though their ratio is positive", () => {
    expect(multipleOfMagnitudes(-3000, -2000)).toBeNull();
  });

  test("a ratio that is not a finite number is no multiple", () => {
    expect(multipleOfMagnitudes(Number.POSITIVE_INFINITY, 1)).toBeNull();
    expect(multipleOfMagnitudes(Number.NaN, 1)).toBeNull();
    expect(multipleOfMagnitudes(1, Number.NaN)).toBeNull();
    expect(multipleOfMagnitudes(1e308, 1e-10)).toBeNull();
    // two positive sides whose ratio is an exact zero — found by the loop below
    expect(multipleOfMagnitudes(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("everything it returns, multipleFact accepts", () => {
    const sides = [-1e308, -2000, -1, 0, 1e-10, 1, 1500, 6000, 1e308, Number.NaN, Number.POSITIVE_INFINITY];
    for (const is of sides) {
      for (const of of sides) {
        const value = multipleOfMagnitudes(is, of);
        if (value !== null) expect(() => multipleFact("f1", "x", value, "y")).not.toThrow();
      }
    }
  });
});

/**
 * 🔴 The floor lived inside `multipleFact`, and the concentration card states a
 * multiple in words — "ETH on its own is 8.7 times that" — with a bare
 * `toFixed(1)` of its own, so a top position under a twentieth of the rest read
 * "0.0 times that". A multiple's figure has one rounding rule, with or without
 * its sign.
 */
describe("a multiple's figure", () => {
  test("is the one rounding rule multipleFact's display is made of", () => {
    for (const v of [1e-6, 0.03, 0.049999, 0.05, 0.3, 1, 8.66, 22.7, 2500]) {
      expect(multipleFact("f1", "x", v, "y").display).toBe(`${renderMultiple(v)}×`);
    }
    expect(renderMultiple(0.049999)).toBe("<0.1");
    expect(renderMultiple(0.05)).toBe("0.1");
    expect(renderMultiple(8.66)).toBe("8.7");
  });

  test("⛔ refuses exactly what multipleFact refuses", () => {
    for (const v of [0, -0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => renderMultiple(v)).toThrow(/above zero/);
    }
  });
});

describe("what a fact refuses to be", () => {
  test("a slot id must look like a slot", () => {
    expect(() => scalarFact("total", "Dining", 1, "money")).toThrow(/must look like/);
    expect(() => scalarFact("f0", "Dining", 1, "money")).toThrow(/must look like/);
    expect(() => scalarFact("", "Dining", 1, "money")).toThrow(/must look like/);
    expect(scalarFact("f10", "Dining", 1, "money").id).toBe("f10");
  });

  test("a label cannot open a tag, a brace or an escape", () => {
    expect(() => scalarFact("f1", "<b>Dining</b>", 1, "money")).toThrow(/cannot contain/);
    expect(() => scalarFact("f1", "{{f2.value}}", 1, "money")).toThrow(/cannot contain/);
    expect(() => scalarFact("f1", "   ", 1, "money")).toThrow(/cannot be empty/);
    expect(() => countFact("f1", "Dining", 1, "<i>x", "in Jul 2026")).toThrow(/cannot contain/);
    expect(() => shareFact("f1", "Dining", 0.5, "{x}")).toThrow(/cannot contain/);
    expect(() => rankFact("f1", "Dining", 1, 2, "a\\b")).toThrow(/cannot contain/);
    expect(() => deltaFact("f1", "D", 1, "money", "<a", "July")).toThrow(/cannot contain/);
    expect(() => deltaFact("f1", "D", 1, "money", "June", "<a")).toThrow(/cannot contain/);
    expect(() => trendFact("f1", "D", "rising", "<a", 3)).toThrow(/cannot contain/);
    // digits are fine — "Feb 2026" and "SoFi 9067" are real labels
    expect(scalarFact("f1", "SoFi 9067", 1, "money").subject).toBe("SoFi 9067");
  });

  test("a real share never rounds away to zero, or up to the whole", () => {
    // $4.24 of $10,240.85 is 0.041% — "0.0%" asserts a measured zero about
    // money that was really spent, and it was on a category page before this
    expect(shareFact("f1", "Health", 4.24 / 10_240.85, "everything").display).toBe("<0.1%");
    expect(shareFact("f1", "Health", 0.0004, "everything").display).toBe("<0.1%");
    // and the mirror: 99.96% is not the whole of anything
    expect(shareFact("f1", "Rent", 0.9996, "everything").display).toBe(">99.9%");
    // the boundaries themselves are exact and print normally
    expect(shareFact("f1", "X", 0, "everything").display).toBe("0.0%");
    expect(shareFact("f1", "X", 1, "everything").display).toBe("100.0%");
    expect(shareFact("f1", "X", 0.0005, "everything").display).toBe("0.1%");
    expect(shareFact("f1", "X", 0.9995, "everything").display).toBe(">99.9%");
  });

  test("a delta in percent obeys the same floor", () => {
    // "rose by 0.0%" is the same false sentence with a direction attached.
    // ⚠️ No surface renders a percent DELTA today — every delta in the app is
    // money — so this shape is PINNED rather than chosen. If one ever does,
    // "+<0.1%" is the thing to look at first.
    expect(deltaFact("f1", "Rent", 0.0002, "percent", "Jun", "Jul").display).toBe("+<0.1%");
    expect(deltaFact("f1", "Rent", -0.0002, "percent", "Jun", "Jul").display).toBe("-<0.1%");
  });

  test("a share outside 0–1 is refused, not clamped", () => {
    // 32.3 passed where 0.323 was meant would render 3230.0% and back a
    // "more than half" claim that is arithmetically impossible
    expect(() => shareFact("f1", "ETH", 32.3, "everything")).toThrow(/within 0–1/);
    expect(() => shareFact("f1", "ETH", -0.1, "everything")).toThrow(/within 0–1/);
    expect(shareFact("f1", "ETH", 1, "everything").display).toBe("100.0%");
    expect(shareFact("f1", "ETH", 0, "everything").display).toBe("0.0%");
  });

  test("a trend needs three observations — two points are a line, not a trend", () => {
    expect(() => trendFact("f1", "Dining", "rising", "July", 2)).toThrow(/at least 3/);
    expect(() => trendFact("f1", "Dining", "rising", "July", 0)).toThrow(/at least 3/);
    expect(() => trendFact("f1", "Dining", "rising", "July", 2.5)).toThrow(/at least 3/);
    expect(trendFact("f1", "Dining", "rising", "July", 3).points).toBe(3);
  });

  test("a rank cannot exceed its set, and does not start at zero", () => {
    expect(() => rankFact("f1", "Dining", 0, 22, "categories")).toThrow(/starts at 1/);
    expect(() => rankFact("f1", "Dining", 1.5, 22, "categories")).toThrow(/starts at 1/);
    expect(() => rankFact("f1", "Dining", 23, 22, "categories")).toThrow(/cannot exceed/);
    expect(() => rankFact("f1", "Dining", 1, 1.5, "categories")).toThrow(/cannot exceed/);
  });

  test("a count is a non-negative whole number", () => {
    expect(() => countFact("f1", "Dining", -1, "purchase", "in Jul 2026")).toThrow(/non-negative integer/);
    expect(() => countFact("f1", "Dining", 1.5, "purchase", "in Jul 2026")).toThrow(/non-negative integer/);
  });

  test("a non-finite measurement is refused before it can render as NaN", () => {
    expect(() => scalarFact("f1", "Dining", Number.NaN, "money")).toThrow(/finite/);
    expect(() => scalarFact("f1", "Dining", Number.POSITIVE_INFINITY, "money")).toThrow(/finite/);
    expect(() => deltaFact("f1", "Dining", Number.NaN, "money", "June", "July")).toThrow(/finite/);
  });
});

describe("a fact set", () => {
  test("refuses a duplicate slot", () => {
    // two claims about two subjects rendering through one slot is exactly the
    // ambiguity this whole module exists to make impossible
    expect(() =>
      factSet([scalarFact("f1", "Dining", 1, "money"), scalarFact("f1", "Groceries", 2, "money")]),
    ).toThrow(/Duplicate fact slot f1/);
  });

  test("is keyed by slot id", () => {
    const set = factSet([scalarFact("f1", "Dining", 1, "money"), scalarFact("f2", "Groceries", 2, "money")]);
    expect(set.get("f2")?.subject).toBe("Groceries");
    expect(set.size).toBe(2);
    expect(factSet([]).size).toBe(0);
  });
});

describe("renderPercent — a real quantity is never rounded away", () => {
  /*
   * 🔴 It was private to this module, and six UI renderers went on using
   * `toFixed(1)`. Measured 2026-09-10: "Health · 1 entry · 0.0% · $4.24" in
   * /spending's table lens and again in its sankey link name; "0.0% of held"
   * on SoFi Savings ($0.10) and SoFi Checking ($0.01); WMT at $44.98 printed
   * "0.0%" twice on /investments; "Money in → Gifts & Donations · $10.43 ·
   * 0.0%". Every one of those is money that really moved.
   */
  test("a share too small for 1dp says so rather than claiming none", () => {
    expect(renderPercent(4.24 / 10_240.85)).toBe("<0.1%"); // 0.041%
    expect(renderPercent(0.1 / 114_498.97)).toBe("<0.1%"); // 0.000087%
    expect(renderPercent(10.43 / 81_850.2)).toBe("<0.1%"); // 0.013%
  });

  test("a share just short of everything does not claim the whole", () => {
    expect(renderPercent(0.9996)).toBe(">99.9%");
  });

  test("an exact zero is an exact zero", () => {
    expect(renderPercent(0)).toBe("0.0%");
  });

  test("ordinary shares round to 1dp", () => {
    expect(renderPercent(0.602)).toBe("60.2%");
    expect(renderPercent(1)).toBe("100.0%");
  });

  test("sharePercent takes the 0-100 framing and agrees", () => {
    expect(sharePercent(0.000087)).toBe(renderPercent(0.0000087));
    expect(sharePercent(60.2)).toBe("60.2%");
    expect(sharePercent(0)).toBe("0.0%");
  });
});

describe("renderPercent — a signed share keeps its floor and its sign", () => {
  /** the net-worth bridge's "Share of movement" is signed (`attribute`'s sharePct) */
  test("a small share the other way is '-<0.1%', never '-0.0%'", () => {
    expect(renderPercent(-0.0002)).toBe("-<0.1%");
    expect(sharePercent(-0.03)).toBe("-<0.1%");
  });

  test("a larger negative share keeps its sign and its digits", () => {
    expect(sharePercent(-30)).toBe("-30.0%");
  });

  test("negative zero is zero", () => {
    expect(renderPercent(-0)).toBe("0.0%");
  });
});

describe("spendingShare — a refunded category took no share, not a zero one", () => {
  /**
   * 🔴 Every share of spending divides `Math.max(0, spentCents)` by the
   * period's positive spend. That clamp is right for a WIDTH — a refunded
   * category has no footprint — and it manufactures an exact zero for the
   * sentence beside it. On the real ledger 2026-09-11, all three lenses of
   * one card: "/spending?period=2024-05 — Shopping · 0.0% · -$1,605.11".
   */
  test("a category that netted money back is refused a share, with the reason", () => {
    const s = spendingShare(-160_511, 0);
    expect(s.label).toBe("—");
    expect(s.title).toBe("took no share of spending — this category netted money back");
  });

  test("a category that really spent nothing keeps its measured zero", () => {
    expect(spendingShare(0, 0)).toEqual({ label: "0.0%", title: null });
  });

  test("a normal share is the module's own percent rule", () => {
    expect(spendingShare(42_370, 42.37)).toEqual({ label: "42.4%", title: null });
    expect(spendingShare(1, 0.04)).toEqual({ label: "<0.1%", title: null });
  });
});
