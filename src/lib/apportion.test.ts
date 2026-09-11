import { describe, expect, test } from "vitest";
import { apportionPercents } from "./apportion";

describe("apportionPercents", () => {
  /**
   * 🔴 THE REAL LEDGER, 2026-09-11. The dashboard read "94% of your usual
   * spending posts to 4 accounts" over rows printed as 51 · 22 · 20 · 2 — which
   * add to 95. Both halves were honest rounds of the same four figures.
   */
  test("the parts add to the whole the headline rounds to", () => {
    const parts = [50.888497, 21.68417, 19.976802, 1.784702];
    const whole = apportionPercents(parts);
    expect(whole).toEqual([51, 21, 20, 2]);
    expect(whole.reduce((s, w) => s + w, 0)).toBe(94);
    // what the card used to print, and why it did not add up
    expect(parts.map(Math.round).reduce((s: number, w) => s + w, 0)).toBe(95);
    expect(Math.round(parts.reduce((s, p) => s + p, 0))).toBe(94);
  });

  /** ⛔ the e2e fixture had the same shape, the other way: 99 over rows adding to 98 */
  test("the fixture's own three shares reconcile too", () => {
    expect(apportionPercents([77.2646, 19.4036, 2.0202])).toEqual([77, 20, 2]);
  });

  test("no part moves by more than one point", () => {
    for (const parts of [[33.333333, 33.333333, 33.333333], [45.4, 15.3], [99.6, 0.2, 0.2]]) {
      const whole = apportionPercents(parts);
      whole.forEach((w, i) => expect(Math.abs(w - parts[i]!)).toBeLessThan(1));
      expect(whole.reduce((s, w) => s + w, 0)).toBe(Math.round(parts.reduce((s, p) => s + p, 0)));
    }
  });

  test("thirds become 34/33/33, never 33/33/33", () => {
    expect(apportionPercents([33.333333, 33.333333, 33.333333])).toEqual([34, 33, 33]);
  });

  test("ties break on the caller's own order, so the result is deterministic", () => {
    expect(apportionPercents([33.5, 33.5, 33])).toEqual([34, 33, 33]);
  });

  test("exact integers are left alone", () => {
    expect(apportionPercents([50, 25, 25])).toEqual([50, 25, 25]);
    expect(apportionPercents([100])).toEqual([100]);
  });

  test("nothing to share out is nothing", () => {
    expect(apportionPercents([])).toEqual([]);
    expect(apportionPercents([0, 0])).toEqual([0, 0]);
  });
});
