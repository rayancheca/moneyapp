import { describe, expect, test } from "vitest";
import { computeWaterfallLayout, HAIRLINE_PX, type WaterfallInput } from "./waterfall-layout";

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
    expect(l.axisMinCents).toBe(Math.min(...runs));
    expect(l.axisMaxCents).toBe(Math.max(...runs));
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

  test("total columns are drawn from the axis floor, because a total IS its level", () => {
    const l = computeWaterfallLayout(REAL, OPTS);
    const opening = l.steps[0]!;
    expect(opening.y + opening.height).toBeCloseTo(OPTS.height, 6);
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
    expect(earned.height).toBeLessThan(HAIRLINE_PX);
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
