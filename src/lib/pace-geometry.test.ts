import { describe, expect, test } from "vitest";
import { paceGeometry, PACE_VH, PACE_VW } from "./pace-geometry";

/**
 * The e2e clock is pinned to E2E_FAKE_TODAY, so every Playwright run renders the
 * SAME day of the SAME 31-day month. Day 1, the final day, February, and a month
 * with nothing spent yet are unreachable from any spec — so they are pinned here
 * or they are not pinned at all.
 */

/** a month of `days` buckets with `elapsed` measured cumulative totals */
function month(days: number, cumulative: number[]): (number | null)[] {
  return Array.from({ length: days }, (_, i) => cumulative[i] ?? null);
}

/** the fixture's real July 2026 shape, measured at 2026-07-08 */
const JULY = month(31, [227459, 227459, 236747, 262486, 262486, 262486, 262486, 271186]);
const JULY_PROJECTED = 1050846;

describe("paceGeometry", () => {
  test("returns null for a period too short to chart", () => {
    expect(paceGeometry({ actualCents: [], projectedCents: 100 })).toBeNull();
    expect(paceGeometry({ actualCents: [500], projectedCents: 100 })).toBeNull();
  });

  test("returns null when no bucket has been measured yet", () => {
    expect(paceGeometry({ actualCents: [null, null, null], projectedCents: 500 })).toBeNull();
  });

  /**
   * The 1st of a month, before anything is spent. The old code drew a flat
   * dashed rule across the full width — a chart asserting a $0 month-end
   * projection. Measured on the real ledger at 2026-08-01.
   */
  test("returns null when nothing is spent and nothing is projected", () => {
    expect(paceGeometry({ actualCents: month(31, [0]), projectedCents: 0 })).toBeNull();
  });

  // both operands of the zero guard, in both directions — a coverage number
  // cannot distinguish a live `&&` from a dead one
  test("still charts when nothing is projected but something WAS spent", () => {
    const geo = paceGeometry({ actualCents: month(31, [1500]), projectedCents: 0 });
    expect(geo).not.toBeNull();
  });

  test("still charts when nothing is spent yet but a projection exists", () => {
    const geo = paceGeometry({ actualCents: month(31, [0]), projectedCents: 9000 });
    expect(geo).not.toBeNull();
    expect(geo!.projection).not.toBeNull();
  });

  test("steps rather than interpolating — every segment is horizontal or vertical", () => {
    const geo = paceGeometry({ actualCents: JULY, projectedCents: JULY_PROJECTED })!;
    // an interpolated path would carry `L` commands with two coordinates
    expect(geo.solid).not.toMatch(/L/);
    expect(geo.solid.match(/H/g)).toHaveLength(7);
    expect(geo.solid.match(/V/g)).toHaveLength(7);
    expect(geo.solid.startsWith("M ")).toBe(true);
  });

  test("a flat day emits a step whose vertical leg does not move", () => {
    // buckets 0→1 are identical in JULY ($2,274.59 twice)
    const geo = paceGeometry({ actualCents: JULY, projectedCents: JULY_PROJECTED })!;
    const [, first, second] = geo.solid.match(/^M \S+ (\S+) H \S+ V (\S+)/)!;
    expect(first).toBe(second);
  });

  test("the area closes on a true zero baseline, not on the first value", () => {
    const geo = paceGeometry({ actualCents: JULY, projectedCents: JULY_PROJECTED })!;
    const baseline = PACE_VH - 4;
    expect(geo.area).toContain(`V ${baseline}`);
    expect(geo.area.endsWith("Z")).toBe(true);
    expect(geo.area.startsWith(geo.solid)).toBe(true);
  });

  test("the projection runs from the last measured point to the month's end", () => {
    const geo = paceGeometry({ actualCents: JULY, projectedCents: JULY_PROJECTED })!;
    expect(geo.projection).toBe(`M ${geo.todayX} ${geo.todayY} L ${PACE_VW} 4`);
  });

  test("drops the projection on the last day of the month, when there is nothing left to project", () => {
    const full = Array.from({ length: 31 }, (_, i) => (i + 1) * 1000);
    const geo = paceGeometry({ actualCents: full, projectedCents: 31000 })!;
    expect(geo.projection).toBeNull();
    expect(geo.todayX).toBe(PACE_VW);
  });

  test("spreads a 28-day February across the same width", () => {
    const feb = month(28, [1000, 2000, 3000]);
    const geo = paceGeometry({ actualCents: feb, projectedCents: 28000 })!;
    // 27 gaps, not 30 — the step is the month's own length
    expect(geo.solid).toContain(`H ${Math.round((1 / 27) * PACE_VW * 10) / 10}`);
  });

  test("never divides by zero when the only measured value is zero", () => {
    const geo = paceGeometry({ actualCents: month(31, [0, 0]), projectedCents: 1 })!;
    for (const n of [...geo.solid.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]))) {
      expect(Number.isFinite(n)).toBe(true);
    }
  });

  test("keeps every coordinate inside the viewBox", () => {
    const geo = paceGeometry({ actualCents: JULY, projectedCents: JULY_PROJECTED })!;
    const coords = [...geo.area.matchAll(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g)];
    expect(coords.length).toBeGreaterThan(0);
    for (const [, cx, cy] of coords) {
      expect(Number(cx)).toBeGreaterThanOrEqual(0);
      expect(Number(cx)).toBeLessThanOrEqual(PACE_VW);
      expect(Number(cy)).toBeGreaterThanOrEqual(0);
      expect(Number(cy)).toBeLessThanOrEqual(PACE_VH);
    }
  });

  test("today's marker sits on the last measured point", () => {
    const geo = paceGeometry({ actualCents: JULY, projectedCents: JULY_PROJECTED })!;
    expect(geo.solid.endsWith(`V ${geo.todayY}`)).toBe(true);
    expect(geo.todayX).toBe(Math.round((7 / 30) * PACE_VW * 10) / 10);
  });
});
