import { describe, expect, test } from "vitest";
import { computeWaterfallLayout, LEGIBLE_PX, type WaterfallInput } from "./waterfall-layout";

/**
 * The real July–August window, measured. Deliberately NOT round numbers: a
 * fixture drawn with a ruler makes every baseline over it blind (pass 53), and a
 * waterfall's whole claim is that unequal parts add up.
 */
const REAL: WaterfallInput = {
  openingCents: 8_289_766,
  closingCents: 10_932_237,
  bands: [
    { key: "earned", label: "Earned", cents: 5_295 },
    { key: "refunds", label: "Refunds", cents: 11_311 },
    { key: "spent", label: "Spent", cents: -1_609_407 },
    { key: "moved", label: "Moved", cents: 1_887_053 },
    { key: "market", label: "Market", cents: 1_886_969 },
    { key: "portfolioFlow", label: "Into holdings", cents: -38_750 },
    { key: "inTransit", label: "In transit", cents: 0 },
    { key: "unexplained", label: "Unexplained", cents: 500_000 },
  ],
};
const OPTS = { width: 800, height: 200 };

describe("computeWaterfallLayout — a running total that visibly closes", () => {
  test("the first step is the opening total and the last is the closing total", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    expect(l.steps[0]).toMatchObject({ key: "opening", kind: "total", cents: 8_289_766 });
    expect(l.steps.at(-1)).toMatchObject({ key: "closing", kind: "total", cents: 10_932_237 });
    expect(l.steps).toHaveLength(REAL.bands.length + 2);
  });

  test("each band carries the running total AFTER it, and the last one lands on the close", () => {
    // The arithmetic the picture is making. If this drifts the chart is drawing
    // a bridge that does not reach the far bank.
    const l = computeWaterfallLayout(REAL, OPTS);
    const bands = l.steps.filter((s) => s.kind === "band");
    let running = REAL.openingCents;
    for (const [i, b] of bands.entries()) {
      running += REAL.bands[i]!.cents;
      expect(b.runningCents, b.key).toBe(running);
    }
    expect(running).toBe(REAL.closingCents);
    expect(l.closes).toBe(true);
  });

  test("a set of bands that does NOT reach the close is reported, not redrawn", () => {
    // The bridge's own `unexplained` band guarantees closure, so this can only
    // happen if a caller assembles the steps by hand — and then the picture is
    // lying and has to say so rather than stretching the last bar.
    const l = computeWaterfallLayout(
      { ...REAL, bands: REAL.bands.filter((b) => b.key !== "unexplained") },
      OPTS,
    );
    expect(l.closes).toBe(false);
    expect(l.shortfallCents).toBe(500_000);
  });

  test("the axis spans the running totals and SAYS it does not start at zero", () => {
    /*
     * A zero-anchored axis over an $82,898 → $109,322 bridge makes every band a
     * sliver — `earned` is 0.05% of it. So the axis is the excursion, and the
     * layout states that plainly so the renderer can disclose it. An axis that
     * silently omits zero is the same class of thing as the pace chart's
     * arithmetic ceiling: true, and unreadable unless it is said out loud.
     */
    const l = computeWaterfallLayout(REAL, OPTS);
    expect(l.axisStartsAtZero).toBe(false);
    const runs = l.steps.map((s) => s.runningCents);
    expect(l.dataMinCents).toBe(Math.min(...runs));
    expect(l.dataMaxCents).toBe(Math.max(...runs));
    // the DRAWING floor sits below the data, so the lowest total still has a bar
    expect(l.axisMinCents).toBeLessThan(l.dataMinCents);
    expect(l.axisMaxCents).toBe(l.dataMaxCents);
  });

  test("a window that only ever rises still puts its opening mark where the opening is", () => {
    // The shape that produced the original bug: net worth only rose, so the
    // OPENING was the lowest running total and its bar collapsed onto the floor.
    // As a level there is nothing to collapse.
    const rising = computeWaterfallLayout(
      {
        openingCents: 6_558_800,
        closingCents: 13_347_339,
        bands: [
          { key: "earned", label: "Earned", cents: 7_525_318 },
          { key: "spent", label: "Spent", cents: -736_779 },
        ],
      },
      OPTS,
    );
    const opening = rising.steps[0]!;
    expect(opening.runningCents).toBe(rising.dataMinCents);
    expect(opening.height).toBe(0);
    // strictly inside the canvas — the pad keeps it off the bottom edge
    expect(opening.y).toBeLessThan(OPTS.height);
    expect(opening.y).toBeGreaterThan(0);
  });

  test("padding never pushes a non-negative axis below zero — it snaps to zero instead", () => {
    // A net-worth axis dipping under zero when nothing did is a worse lie than a
    // shorter column, and snapping makes `axisStartsAtZero` honestly true.
    const l = computeWaterfallLayout(
      { openingCents: 1_000, closingCents: 90_000, bands: [{ key: "a", label: "A", cents: 89_000 }] },
      OPTS,
    );
    expect(l.axisMinCents).toBe(0);
    expect(l.axisStartsAtZero).toBe(true);
    expect(l.dataMinCents).toBe(1_000);
  });

  test("a window that really goes negative is allowed to pad below zero", () => {
    const l = computeWaterfallLayout(
      { openingCents: -50_000, closingCents: 10_000, bands: [{ key: "a", label: "A", cents: 60_000 }] },
      OPTS,
    );
    expect(l.axisMinCents).toBeLessThan(-50_000);
    expect(l.axisStartsAtZero).toBe(false);
  });

  test("a bridge that really does reach zero says THAT truthfully too", () => {
    const l = computeWaterfallLayout(
      { openingCents: 0, closingCents: 1_000, bands: [{ key: "earned", label: "E", cents: 1_000 }] },
      OPTS,
    );
    expect(l.axisMinCents).toBe(0);
    expect(l.axisStartsAtZero).toBe(true);
  });

  test("bands are drawn between their own two running totals, never from the floor", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    const spent = l.steps.find((s) => s.key === "spent")!;
    const refunds = l.steps.find((s) => s.key === "refunds")!;
    // spent is negative: it hangs DOWN from where refunds left the running total
    const y = (v: number) =>
      OPTS.height * ((l.axisMaxCents - v) / (l.axisMaxCents - l.axisMinCents));
    expect(spent.y).toBeCloseTo(y(refunds.runningCents), 6);
    expect(spent.height).toBeCloseTo(y(spent.runningCents) - y(refunds.runningCents), 6);
  });

  test("a total is a LEVEL — a mark at its value, with no height at all", () => {
    /*
     * ⛔ The defect this replaces, measured in review on the real ledger: totals
     * were drawn as bars from the padded floor, so the all-time window rendered
     * the opening as a **77.97px column labelled "$0.00"** beside a 205.23px
     * column labelled "$109,322.37" — a drawn ratio of 0.380 against a true
     * ratio of 0.000. And whenever the opening was also the lowest running
     * total, its height came out at exactly `height × pad/(1+pad)` — 24.00px —
     * REGARDLESS of the number printed beneath it.
     *
     * A rectangle's height encodes a magnitude. The distance from an arbitrary
     * floor up to a level is not one.
     */
    const l = computeWaterfallLayout(REAL, OPTS);
    const y = (v: number) => OPTS.height * ((l.axisMaxCents - v) / (l.axisMaxCents - l.axisMinCents));
    for (const total of [l.steps[0]!, l.steps.at(-1)!]) {
      expect(total.kind).toBe("total");
      expect(total.height, `${total.key} must have no height`).toBe(0);
      expect(total.y, `${total.key} sits at its own level`).toBeCloseTo(y(total.cents), 6);
      expect(total.belowHairline).toBe(false);
    }
  });

  test("a total's mark does not move when the floor padding does", () => {
    // The property the old geometry failed: the pad is decoration, so nothing
    // measured may depend on it. Both totals must land on the same LEVEL under
    // any padding, even though the pixel scale differs.
    const a = computeWaterfallLayout(REAL, { ...OPTS, floorPadFraction: 0 });
    const b = computeWaterfallLayout(REAL, { ...OPTS, floorPadFraction: 0.5 });
    for (const [x, z] of [
      [a.steps[0]!, b.steps[0]!],
      [a.steps.at(-1)!, b.steps.at(-1)!],
    ] as const) {
      expect(x.cents).toBe(z.cents);
      expect(x.height).toBe(0);
      expect(z.height).toBe(0);
      // and the RATIO between the two marks' levels is the data's, not the pad's
      expect(x.runningCents).toBe(z.runningCents);
    }
  });

  test("a band too small to draw to scale is MARKED, and its geometry is left honest", () => {
    /*
     * `earned` is $52.95 against a $26,424.71 delta — 0.09% of the axis, which is
     * 0.18px at this height. The house answer elsewhere is a 2px minimum bar
     * (deviation-layout), and it cannot be used here: a waterfall's claim is that
     * the parts ADD UP, and a floored bar makes the geometry visibly not close.
     *
     * So the height stays true and the step says it is below the hairline. The
     * renderer draws a rule and the table lens carries the number.
     */
    const l = computeWaterfallLayout(REAL, OPTS);
    const earned = l.steps.find((s) => s.key === "earned")!;
    expect(earned.height).toBeLessThan(LEGIBLE_PX);
    expect(earned.belowHairline).toBe(true);
    // …and NOT inflated to a floor
    const y = (v: number) => OPTS.height * ((l.axisMaxCents - v) / (l.axisMaxCents - l.axisMinCents));
    expect(earned.height).toBeCloseTo(Math.abs(y(REAL.openingCents + 5_295) - y(REAL.openingCents)), 6);
    // a big band is not marked
    expect(l.steps.find((s) => s.key === "market")!.belowHairline).toBe(false);
  });

  test("conservation: every band's height sums to the distance between the two totals", () => {
    // The property that makes the picture an argument rather than a decoration.
    const l = computeWaterfallLayout(REAL, OPTS);
    const bands = l.steps.filter((s) => s.kind === "band");
    const signed = bands.reduce((sum, b) => sum + (b.direction === "down" ? b.height : -b.height), 0);
    const opening = l.steps[0]!;
    const closing = l.steps.at(-1)!;
    expect(signed).toBeCloseTo(closing.y - opening.y, 6);
  });

  test("a zero band has zero height, is flat, and is still laid out", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    const transit = l.steps.find((s) => s.key === "inTransit")!;
    expect(transit.height).toBe(0);
    expect(transit.direction).toBe("flat");
    expect(transit.belowHairline).toBe(true);
    // a zero band leaves the running total exactly where the step before it did
    expect(transit.runningCents).toBe(
      l.steps.find((s) => s.key === "portfolioFlow")!.runningCents,
    );
    expect(transit.runningCents).toBe(10_432_237);
  });

  test("columns are evenly spaced, in order, and inside the width", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    for (const [i, s] of l.steps.entries()) {
      expect(s.x, s.key).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width, s.key).toBeLessThanOrEqual(OPTS.width + 1e-9);
      if (i > 0) expect(s.x, s.key).toBeGreaterThan(l.steps[i - 1]!.x);
    }
  });

  test("a connector runs from each step's end level to the next step's start", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    const y = (v: number) => OPTS.height * ((l.axisMaxCents - v) / (l.axisMaxCents - l.axisMinCents));
    for (const [i, s] of l.steps.entries()) {
      if (i === l.steps.length - 1) {
        expect(s.connectorY, "the last step has nothing to connect to").toBeNull();
        continue;
      }
      expect(s.connectorY!, s.key).toBeCloseTo(y(s.runningCents), 6);
    }
  });

  test("every CENTS value it publishes is a whole cent", () => {
    /*
     * `formatCents` throws on a fractional value, so a float here is not a
     * rounding nit — it is a crashed dashboard. The padded floor was a float and
     * took the page down with `RangeError: Invalid cents value: 10259599.92` the
     * first time anything rendered it.
     */
    for (const input of [
      REAL,
      { ...REAL, closingCents: 8_000_000 },
      { openingCents: -3_331, closingCents: 7, bands: [{ key: "a", label: "A", cents: 3_338 }] },
    ]) {
      const l = computeWaterfallLayout(input, OPTS);
      for (const [name, v] of [
        ["axisMinCents", l.axisMinCents],
        ["axisMaxCents", l.axisMaxCents],
        ["dataMinCents", l.dataMinCents],
        ["dataMaxCents", l.dataMaxCents],
        ["shortfallCents", l.shortfallCents],
      ] as const) {
        expect(Number.isInteger(v), name).toBe(true);
      }
      for (const st of l.steps) {
        expect(Number.isInteger(st.cents), `${st.key}.cents`).toBe(true);
        expect(Number.isInteger(st.runningCents), `${st.key}.runningCents`).toBe(true);
      }
    }
  });

  test("the padded floor only ever moves DOWN, never up into the data", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    expect(l.axisMinCents).toBeLessThanOrEqual(l.dataMinCents);
  });

  test("a completely flat window does not divide by zero", () => {
    // Opening equals closing and every band is zero: the axis has no extent, and
    // every height would be 0/0.
    const l = computeWaterfallLayout(
      { openingCents: 500_000, closingCents: 500_000, bands: [{ key: "earned", label: "E", cents: 0 }] },
      OPTS,
    );
    expect(l.axisMinCents).toBe(l.axisMaxCents);
    for (const s of l.steps) {
      expect(Number.isFinite(s.y), s.key).toBe(true);
      expect(Number.isFinite(s.height), s.key).toBe(true);
      expect(s.height).toBe(0);
    }
    expect(l.closes).toBe(true);
  });

  test("direction follows the sign of the band, and a total is never up or down", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    const dir = (k: string) => l.steps.find((s) => s.key === k)!.direction;
    expect(dir("earned")).toBe("up");
    expect(dir("spent")).toBe("down");
    expect(dir("inTransit")).toBe("flat");
    expect(dir("opening")).toBe("flat");
    expect(dir("closing")).toBe("flat");
  });

  test("no geometry is emitted with a negative height or a NaN", () => {
    // The cheap sweep that catches a sign slip anywhere in the module.
    for (const input of [
      REAL,
      { ...REAL, openingCents: 10_932_237, closingCents: 8_289_766 },
      { openingCents: -500_000, closingCents: 500_000, bands: [{ key: "a", label: "A", cents: 1_000_000 }] },
    ]) {
      for (const s of computeWaterfallLayout(input, OPTS).steps) {
        expect(Number.isFinite(s.x) && Number.isFinite(s.y), s.key).toBe(true);
        expect(s.height, s.key).toBeGreaterThanOrEqual(0);
        expect(s.width, s.key).toBeGreaterThan(0);
      }
    }
  });
});
