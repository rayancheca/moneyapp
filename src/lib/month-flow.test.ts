import { describe, expect, test } from "vitest";
import { flowArea, flowPolyline, monthFlow } from "./month-flow";

const M = "2026-08";
const day = (d: number) => `${M}-${String(d).padStart(2, "0")}`;

describe("monthFlow", () => {
  test("accumulates across the month, not per day", () => {
    const f = monthFlow(31, M, { [day(5)]: [{ settled: false, amountCents: -1000 }], [day(9)]: [{ settled: false, amountCents: -500 }] }, day(20));
    expect(f.points[3]!.scheduledCents).toBe(0); // the 4th, before anything
    expect(f.points[4]!.scheduledCents).toBe(-1000); // the 5th
    expect(f.points[8]!.scheduledCents).toBe(-1500); // the 9th, running
    expect(f.points[30]!.scheduledCents).toBe(-1500); // carries to month end
    expect(f.endCents).toBe(-1500);
  });

  test("several entries on one day all land on that day", () => {
    const f = monthFlow(30, M, { [day(10)]: [{ settled: false, amountCents: -5000 }, { settled: false, amountCents: -1421 }] }, day(20));
    expect(f.points[9]!.scheduledCents).toBe(-6421);
  });

  test("x spans the full width, first point to last", () => {
    const f = monthFlow(31, M, {}, day(1));
    expect(f.points[0]!.x).toBe(0);
    expect(f.points[30]!.x).toBe(1);
  });

  test("a one-day month does not divide by zero", () => {
    const f = monthFlow(1, M, { [day(1)]: [{ settled: false, amountCents: -100 }] }, day(1));
    expect(f.points).toHaveLength(1);
    expect(f.points[0]!.x).toBe(0);
    expect(Number.isFinite(f.points[0]!.yScheduled)).toBe(true);
    expect(Number.isFinite(f.points[0]!.ySettled)).toBe(true);
  });

  test("y is inverted — the lowest running total sits nearest the bottom", () => {
    const f = monthFlow(3, M, { [day(2)]: [{ settled: false, amountCents: -1000 }], [day(3)]: [{ settled: false, amountCents: 3000 }] }, day(1));
    const [a, b, c] = f.points;
    expect(b!.yScheduled).toBeGreaterThan(a!.yScheduled); // went down → further down the SVG
    expect(c!.yScheduled).toBeLessThan(a!.yScheduled); // ended up → nearer the top
  });

  test("a month where nothing moves reports it rather than drawing a flat lie", () => {
    // A horizontal rule across the middle is indistinguishable from a broken
    // renderer; pass 30 shipped a header reading "$0.00" over a live session for
    // want of exactly this distinction.
    const f = monthFlow(31, M, {}, day(20));
    expect(f.hasMovement).toBe(false);
    expect(f.points.every((p) => p.yScheduled === 0.5)).toBe(true);
  });

  test("a day whose entries are all zero is still no movement", () => {
    const f = monthFlow(5, M, { [day(2)]: [{ settled: false, amountCents: 0 }] }, day(1));
    expect(f.hasMovement).toBe(false);
  });

  test("the trough is the deepest point, not the last negative one", () => {
    const f = monthFlow(4, M, {
      [day(1)]: [{ settled: false, amountCents: -5000 }],
      [day(2)]: [{ settled: false, amountCents: -3000 }],
      [day(3)]: [{ settled: false, amountCents: 7000 }],
    }, day(1));
    expect(f.troughIndex).toBe(1); // the 2nd, at -8000
    expect(f.points[f.troughIndex]!.scheduledCents).toBe(-8000);
    expect(f.lowCents).toBe(-8000);
    expect(f.highCents).toBe(0);
  });

  /*
   * ⛔ A TROUGH PLATEAU IS THE COMMON CASE, not an edge one: nothing moves on
   * most days, so the cumulative line sits flat at its minimum for the whole
   * rest of the month. `MonthFlowStrip` prints "lowest {date} at {amount}" and
   * puts a marker dot on that day, so which day of the plateau wins is a DATE
   * on the screen — and with `<=` instead of `<` it becomes the last day of the
   * month instead of the day the money actually left.
   *
   * Found by mutation: the amount stays right either way, which is why nothing
   * caught it. The FIRST day at the minimum is the one that means something.
   */
  test("a flat trough names the day the money left, not the last day it stayed gone", () => {
    const f = monthFlow(20, M, {
      [day(3)]: [{ settled: false, amountCents: -8000 }],
    }, day(1));
    // days 3..20 all sit at -8000; the third is where it happened
    expect(f.troughIndex).toBe(2);
    expect(f.points[f.troughIndex]!.iso).toBe(day(3));
    expect(f.points.at(-1)!.scheduledCents).toBe(-8000);
  });

  test("the settled/forecast split falls on today, and today counts as future", () => {
    // `upcoming` in the calendar means "on or after today", and the line must
    // agree with the grid it sits above — a seam one day out reads as a bug.
    const f = monthFlow(31, M, {}, day(20));
    expect(f.points[18]!.isFuture).toBe(false); // the 19th
    expect(f.points[19]!.isFuture).toBe(true); // the 20th, today
    expect(f.lastSettledIndex).toBe(18);
  });

  test("a wholly future month has no settled segment at all", () => {
    const f = monthFlow(30, "2026-09", {}, "2026-08-25");
    expect(f.lastSettledIndex).toBe(-1);
    expect(f.points.every((p) => p.isFuture)).toBe(true);
  });

  test("a wholly past month is settled to the last day", () => {
    const f = monthFlow(30, "2026-06", {}, "2026-08-25");
    expect(f.lastSettledIndex).toBe(29);
  });

  test("zeroY sits where the running total is zero", () => {
    const f = monthFlow(3, M, { [day(2)]: [{ settled: false, amountCents: -1000 }] }, day(1));
    expect(f.zeroY).toBeCloseTo(f.points[0]!.yScheduled, 10); // day 1 is still at zero
  });
});

describe("flowPolyline / flowArea", () => {
  test("scales the normalized points into the box", () => {
    const f = monthFlow(2, M, { [day(2)]: [{ settled: false, amountCents: -100 }] }, day(1));
    const poly = flowPolyline(f.points, 100, 40);
    expect(poly.startsWith("0.00,")).toBe(true);
    expect(poly.split(" ")).toHaveLength(2);
    expect(poly.endsWith(",35.20")).toBe(true); // 1 - PAD → 0.88 × 40
  });

  test("the area closes to the ZERO rule, not to the floor", () => {
    // Closing to the bottom edge would shade the axis padding too and imply the
    // month lost more than it did.
    const f = monthFlow(2, M, { [day(2)]: [{ settled: false, amountCents: -100 }] }, day(1));
    const d = flowArea(f.points, f.zeroY, 100, 40);
    const base = (f.zeroY * 40).toFixed(2);
    expect(d.startsWith(`M0.00,${base}`)).toBe(true);
    expect(d.endsWith(`L100.00,${base}Z`)).toBe(true);
  });

  test("an empty point list produces no path rather than a malformed one", () => {
    expect(flowArea([], 0.5, 100, 40)).toBe("");
    expect(flowPolyline([], 100, 40)).toBe("");
  });
});

describe("scheduled vs settled", () => {
  test("the settled line counts only what POSTED, not what is merely past", () => {
    // August 2026: three cash paydays behind today that have never reached the
    // ledger. Split by DATE, the line climbed to +$3,141 above a footer reading
    // "SETTLED $0.00".
    const f = monthFlow(
      31,
      M,
      {
        [day(6)]: [{ amountCents: 104700, settled: false }],
        [day(13)]: [{ amountCents: 104700, settled: false }],
        [day(20)]: [{ amountCents: 104700, settled: false }],
      },
      day(25),
    );
    expect(f.endCents).toBe(314100);
    expect(f.settledCents).toBe(0);
    expect(f.points[24]!.settledCents).toBe(0);
    expect(f.points[24]!.scheduledCents).toBe(314100);
  });

  test("a posted charge moves BOTH running totals", () => {
    const f = monthFlow(31, M, { [day(4)]: [{ amountCents: -5000, settled: true }] }, day(25));
    expect(f.settledCents).toBe(-5000);
    expect(f.endCents).toBe(-5000);
    expect(f.points[30]!.settledCents).toBe(-5000);
  });

  test("the axis holds both series, so neither clips", () => {
    // Scheduled dives while settled stays level; the low must come from the
    // series that actually reaches it.
    const f = monthFlow(
      10,
      M,
      {
        [day(2)]: [{ amountCents: 5000, settled: true }],
        [day(3)]: [{ amountCents: -20000, settled: false }],
      },
      day(9),
    );
    expect(f.lowCents).toBe(-15000);
    expect(f.highCents).toBe(5000);
    expect(f.points.every((p) => p.ySettled >= 0 && p.ySettled <= 1)).toBe(true);
    expect(f.points.every((p) => p.yScheduled >= 0 && p.yScheduled <= 1)).toBe(true);
  });

  test("a future day's SETTLED total never widens the axis", () => {
    // Past today the settled series is frozen and meaningless; letting it set
    // the axis would reserve space for a line that is not drawn there.
    const f = monthFlow(10, M, { [day(2)]: [{ amountCents: -900, settled: true }] }, day(3));
    expect(f.lowCents).toBe(-900);
  });

  test("dips is false for a month that only climbs", () => {
    // The first version printed "Lowest on Aug 1 at $0.00" — trivially true and
    // useless — because the trough of a rising month is its first point.
    const rising = monthFlow(5, M, { [day(2)]: [{ amountCents: 1000, settled: true }] }, day(1));
    expect(rising.dips).toBe(false);
    expect(rising.lowCents).toBe(0);

    const falling = monthFlow(5, M, { [day(2)]: [{ amountCents: -1000, settled: true }] }, day(1));
    expect(falling.dips).toBe(true);
  });

  test("flowPolyline draws whichever series it is asked for", () => {
    const f = monthFlow(
      2,
      M,
      { [day(2)]: [{ amountCents: -1000, settled: false }] },
      day(1),
    );
    expect(flowPolyline(f.points, 100, 40, "scheduled")).not.toBe(
      flowPolyline(f.points, 100, 40, "settled"),
    );
  });
});
