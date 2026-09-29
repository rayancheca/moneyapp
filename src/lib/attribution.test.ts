import { describe, expect, test } from "vitest";
import {
  ATTRIBUTION_BAND_LABEL,
  ATTRIBUTION_BAND_MEANING,
  ATTRIBUTION_BAND_ORDER,
  attribute,
  type AttributionInput,
} from "./attribution";

/**
 * A real window, measured on the live ledger 2026-07-01 → 2026-08-24 before any
 * of this was written. Every figure is a measurement, not an invention — a
 * fixture that draws with a ruler makes every assertion over it blind (pass 53),
 * and a bridge fixture whose bands are round numbers would hide exactly the
 * rounding and sign errors this module can make.
 *
 *   net worth          $82,897.66 → $109,322.37   (Δ +$26,424.71)
 *   earned                 +$52.95   4 rows — the cash job banks nothing
 *   refunds               +$113.11   2 credits inside expense categories
 *   spent             −$16,094.07   188 rows
 *   moved             +$18,870.53   transfer +$23,527.03, investment −$4,656.50
 *   market            +$18,869.69
 *   portfolio flow       −$387.50
 *   in transit              $0.00   every float in this window is settled
 *   unexplained        +$5,000.00   a manual anchor on Cash on Hand, 2026-08-03
 *
 * Rows on holdings-valued accounts are excluded from every transaction band:
 * those accounts do not replay, so their rows moved no balance.
 */
const REAL: AttributionInput = {
  openingCents: 8_289_766,
  closingCents: 10_932_237,
  earnedCents: 5_295,
  agentIncomeCents: 0,
  refundsCents: 11_311,
  spentCents: -1_609_407,
  movedCents: 1_887_053,
  marketCents: 1_886_969,
  portfolioFlowCents: -38_750,
  inTransitDeltaCents: 0,
  restatements: [{ accountName: "Cash on Hand", cents: 500_000, reason: "anchor" }],
};

describe("attribute — the bridge closes, or says by how much it does not", () => {
  test("the residual is the delta minus every named band, never a plug", () => {
    const got = attribute(REAL);
    // 10,932,237 − 8,289,766 = 2,642,471 of movement.
    expect(got.deltaCents).toBe(2_642_471);
    // and the bands account for all but the $5,000.00 anchor
    expect(got.unexplainedCents).toBe(500_000);
    expect(got.closes).toBe(false);
  });

  test("a fully attributed residual is reported as attributed, not as closed", () => {
    // The distinction the page has to draw: the ledger does not close, AND every
    // cent of the shortfall has a name. Collapsing those two into one boolean is
    // how a $5,000.00 hole gets rendered as a tick.
    const got = attribute(REAL);
    expect(got.attributedCents).toBe(500_000);
    expect(got.unattributedCents).toBe(0);
    expect(got.restatements.map((r) => r.accountName)).toEqual(["Cash on Hand"]);
  });

  test("a window with nothing unexplained closes", () => {
    const got = attribute({ ...REAL, restatements: [], openingCents: 8_789_766 });
    expect(got.unexplainedCents).toBe(0);
    expect(got.closes).toBe(true);
    expect(got.attributedCents).toBe(0);
    expect(got.unattributedCents).toBe(0);
  });

  test("a restatement that does NOT cover the residual leaves the remainder unattributed", () => {
    /*
     * The failure this pins is the one that matters: an explanation that covers
     * PART of a hole reads, at a glance, exactly like one that covers all of it.
     * $4,000.00 of named anchor against $5,000.00 of residual is a $1,000.00 hole
     * nobody has accounted for, and it must be its own number.
     */
    const got = attribute({
      ...REAL,
      restatements: [{ accountName: "Cash on Hand", cents: 400_000, reason: "anchor" }],
    });
    expect(got.unexplainedCents).toBe(500_000);
    expect(got.attributedCents).toBe(400_000);
    expect(got.unattributedCents).toBe(100_000);
  });

  test("over-attribution is reported too, and never silently clamped", () => {
    // Σrestatements > residual means the attribution itself is wrong — two
    // explanations for the same money. Clamping at zero would hide it.
    const got = attribute({
      ...REAL,
      restatements: [{ accountName: "Cash on Hand", cents: 700_000, reason: "anchor" }],
    });
    expect(got.attributedCents).toBe(700_000);
    expect(got.unattributedCents).toBe(-200_000);
  });

  test("the bands sum to the delta once the residual is included — the identity itself", () => {
    const got = attribute(REAL);
    const summed = got.bands.reduce((s, b) => s + b.cents, 0);
    expect(summed).toBe(got.deltaCents);
  });

  test("every band key appears exactly once, in the declared order", () => {
    /*
     * A waterfall is a running total: the order IS the arithmetic, so it cannot
     * be left to a Map's iteration order or to a caller.
     *
     * ⚠️ Written out LONGHAND rather than compared to `ATTRIBUTION_BAND_ORDER`.
     * `attribute` builds its output BY MAPPING over that constant, so an
     * assertion against it is structurally incapable of failing — deleting a key
     * from the constant deletes it from both sides at once and the test stays
     * green while the bridge silently stops accounting for a band. Caught in
     * review; the first version of this test was exactly that tautology.
     */
    const got = attribute(REAL);
    expect(got.bands.map((b) => b.key)).toEqual([
      "earned",
      "agentIncome",
      "refunds",
      "spent",
      "moved",
      "market",
      "portfolioFlow",
      "inTransit",
      "unexplained",
    ]);
    // and the constant the renderer will read agrees with what was just pinned
    expect([...ATTRIBUTION_BAND_ORDER]).toEqual(got.bands.map((b) => b.key));
  });

  test("`closes` is EXACT — one cent short is not closed", () => {
    // The module's central promise, and it survived `Math.abs(x) < 100` until a
    // review said so. A bridge that tolerates slack is a bridge that hides the
    // smallest and most interesting holes.
    const off = attribute({ ...REAL, closingCents: REAL.closingCents - 499_999 });
    expect(off.unexplainedCents).toBe(1);
    expect(off.closes).toBe(false);
    const exact = attribute({ ...REAL, closingCents: REAL.closingCents - 500_000 });
    expect(exact.unexplainedCents).toBe(0);
    expect(exact.closes).toBe(true);
  });

  test("each band carries its OWN input, and none is wired to another's", () => {
    /*
     * Pins the assignment itself. Every band here gets a distinct prime-ish
     * value, so swapping any two inputs — market for portfolioFlow is the easy
     * mistake, they come out of one call — moves a number this test reads.
     */
    const got = attribute({
      openingCents: 0,
      closingCents: 0,
      earnedCents: 11,
      agentIncomeCents: 13,
      refundsCents: 22,
      spentCents: -33,
      movedCents: 44,
      marketCents: 55,
      portfolioFlowCents: -66,
      inTransitDeltaCents: 77,
      restatements: [],
    });
    const at = (k: string) => got.bands.find((b) => b.key === k)!.cents;
    expect(at("earned")).toBe(11);
    expect(at("agentIncome")).toBe(13);
    expect(at("refunds")).toBe(22);
    expect(at("spent")).toBe(-33);
    expect(at("moved")).toBe(44);
    expect(at("market")).toBe(55);
    expect(at("portfolioFlow")).toBe(-66);
    expect(at("inTransit")).toBe(77);
    // delta 0 less the named total is the residual, sign included
    expect(at("unexplained")).toBe(-(11 + 13 + 22 - 33 + 44 + 55 - 66 + 77));
  });

  test("a band that is exactly zero is still present, and marked", () => {
    // Dropping empty bands makes two windows incomparable and makes a missing
    // term indistinguishable from a zero one.
    const got = attribute({ ...REAL, inTransitDeltaCents: 0 });
    const transit = got.bands.find((b) => b.key === "inTransit");
    expect(transit).toBeDefined();
    expect(transit!.cents).toBe(0);
    expect(transit!.isZero).toBe(true);
  });

  test("direction is derived from the sign, and zero is neither", () => {
    const got = attribute(REAL);
    const dir = (k: string) => got.bands.find((b) => b.key === k)!.direction;
    expect(dir("earned")).toBe("up");
    expect(dir("spent")).toBe("down");
    expect(dir("inTransit")).toBe("flat");
  });

  test("an all-zero window is flat, closed, and says so without dividing by zero", () => {
    const got = attribute({
      openingCents: 0,
      closingCents: 0,
      earnedCents: 0,
      agentIncomeCents: 0,
      spentCents: 0,
      refundsCents: 0,
      movedCents: 0,
      marketCents: 0,
      portfolioFlowCents: 0,
      inTransitDeltaCents: 0,
      restatements: [],
    });
    expect(got.deltaCents).toBe(0);
    expect(got.closes).toBe(true);
    expect(got.bands.every((b) => b.isZero)).toBe(true);
    expect(got.bands.every((b) => b.sharePct === 0)).toBe(true);
  });

  test("share is measured against the GROSS movement, not the net delta", () => {
    /*
     * Measured, and the reason this is not `cents / deltaCents`: over July–August
     * the net delta is $26,424.71 while the bands move $59,387.85 in total. A
     * share over the net delta would put `market` at 71%, `moved` at 71% and
     * `spent` at −61% — three bands each reading "most of it", and one of them
     * off the end of any bar. Gross is the only denominator on which the shares
     * are comparable and bounded.
     */
    const got = attribute(REAL);
    const total = got.bands.reduce((s, b) => s + Math.abs(b.cents), 0);
    expect(got.grossCents).toBe(total);
    for (const b of got.bands) {
      expect(Math.abs(b.sharePct)).toBeLessThanOrEqual(100);
      expect(b.sharePct).toBeCloseTo((b.cents / total) * 100, 6);
    }
  });

  test("a residual on the opposite side of the delta is still reported honestly", () => {
    // Net worth FELL while the bands say it should have risen. The residual is
    // negative and the reader has to be told, not shielded.
    const got = attribute({ ...REAL, closingCents: 8_000_000, restatements: [] });
    expect(got.deltaCents).toBe(-289_766);
    expect(got.unexplainedCents).toBeLessThan(0);
    expect(got.closes).toBe(false);
  });
});

describe("band copy", () => {
  test("every band has a label and a meaning, and no band has two of either", () => {
    // Both maps are read by key from the chart AND from its table. A missing
    // entry renders `undefined` in a legend rather than erroring.
    expect(Object.keys(ATTRIBUTION_BAND_LABEL).sort()).toEqual([...ATTRIBUTION_BAND_ORDER].sort());
    expect(Object.keys(ATTRIBUTION_BAND_MEANING).sort()).toEqual([...ATTRIBUTION_BAND_ORDER].sort());
    expect(new Set(Object.values(ATTRIBUTION_BAND_LABEL)).size).toBe(ATTRIBUTION_BAND_ORDER.length);
  });

  test("a meaning says what the code does, at a length someone will actually read", () => {
    for (const [key, body] of Object.entries(ATTRIBUTION_BAND_MEANING)) {
      expect(body.trim().length, key).toBeGreaterThan(40);
      expect(body.trim().endsWith("."), key).toBe(true);
    }
  });

  test("no label collides with a phrase the dashboard grades by", () => {
    // Same failure as a tooltip body: a legend word that an exact-count locator
    // reads turns an unrelated spec red.
    for (const label of Object.values(ATTRIBUTION_BAND_LABEL)) {
      expect(["Net worth", "Assets", "Owed", "Split", "Accounts", "Flow", "Terrain"]).not.toContain(
        label,
      );
    }
  });
});

/*
 * 🔴 S22 — the bridge band over the income-kind positive population was labelled
 * "Earned" (measured on the real ledger 2026-09-15: 1Y "Earned $41,841.20", ALL
 * "Earned $117,979.61"), the word /summary keeps for wages, tutoring and savings
 * interest alone. Owner decision 2026-09-14: the band is Income, and so is every
 * other surface over that population.
 */
describe("the income band's words", () => {
  test("is labelled Income, and neither it nor the refunds band calls the money earned", () => {
    expect(ATTRIBUTION_BAND_LABEL.earned).toBe("Income");
    expect(ATTRIBUTION_BAND_MEANING.earned).not.toMatch(/earn/i);
    expect(ATTRIBUTION_BAND_MEANING.refunds).not.toMatch(/earn/i);
  });

  /*
   * ⚖️ Owner decision 2026-09-28 (§6A 27): the agent's income is not his, and /spending's Income leaves it out — but
   * net worth holds it, so the bridge NAMES it rather than hiding it inside "Income" (one word, two populations: the
   * S22 defect) or inside "Moved" (which says it is a transfer).
   */
  test("the agent's income has a band of its own, and its words say whose money it is", () => {
    expect(ATTRIBUTION_BAND_LABEL.agentIncome).toBe("Agent's income");
    expect(ATTRIBUTION_BAND_MEANING.agentIncome).toMatch(/agent/i);
    expect(ATTRIBUTION_BAND_MEANING.agentIncome).toMatch(/not your income/i);
    expect(ATTRIBUTION_BAND_MEANING.agentIncome).not.toMatch(/earn/i);
    // the Income band's meaning no longer claims every income-kind row
    expect(ATTRIBUTION_BAND_MEANING.earned).toMatch(/agent/i);
  });
});
