import { describe, expect, test } from "vitest";

import {
  panIndexWindow,
  panPointsFromWheel,
  zoomFactorFromWheel,
  zoomIndexWindow,
  ZOOM_SENSITIVITY,
  type IndexWindow,
} from "./chart-zoom";

const w = (startIdx: number, endIdx: number): IndexWindow => ({ startIdx, endIdx });

describe("zoomFactorFromWheel", () => {
  test("a pinch OPEN (negative deltaY) shrinks the span — zooming in", () => {
    expect(zoomFactorFromWheel(-10)).toBeLessThan(1);
  });

  test("a pinch CLOSED (positive deltaY) grows the span — zooming out", () => {
    expect(zoomFactorFromWheel(10)).toBeGreaterThan(1);
  });

  test("no delta is no change", () => {
    expect(zoomFactorFromWheel(0)).toBe(1);
  });

  /**
   * The reason the factor is exponential rather than linear. Zooming out by some
   * amount and back in by the same amount has to land exactly where it started;
   * with a linear factor (1 + kd) the round trip drifts, and the drift shows up
   * as a window the user cannot get back to.
   */
  test("equal-and-opposite gestures compose back to identity", () => {
    expect(zoomFactorFromWheel(40) * zoomFactorFromWheel(-40)).toBeCloseTo(1, 12);
  });

  test("the sensitivity constant is the exponent base", () => {
    expect(zoomFactorFromWheel(1)).toBeCloseTo(Math.exp(ZOOM_SENSITIVITY), 12);
  });
});

describe("zoomIndexWindow", () => {
  test("zooming in halves the span", () => {
    expect(zoomIndexWindow(101, w(0, 100), 0.5, 0.5)).toEqual({ startIdx: 25, endIdx: 75 });
  });

  test("zooming out doubles the span", () => {
    expect(zoomIndexWindow(101, w(25, 75), 0.5, 2)).toEqual({ startIdx: 0, endIdx: 100 });
  });

  /** The point under the cursor stays under the cursor — the whole feel of the gesture. */
  test("holds the anchored point fixed when zooming at the left edge", () => {
    const next = zoomIndexWindow(101, w(0, 100), 0, 0.5);
    expect(next.startIdx).toBe(0); // anchor was index 0, so it must remain index 0
    expect(next.endIdx - next.startIdx).toBe(50);
  });

  test("holds the anchored point fixed when zooming at the right edge", () => {
    const next = zoomIndexWindow(101, w(0, 100), 1, 0.5);
    expect(next.endIdx).toBe(100); // anchor was the last index
    expect(next.endIdx - next.startIdx).toBe(50);
  });

  /**
   * The anchor guarantee is "within half an index", not "exact" — windows are
   * integer indices, so a fractional anchor cannot survive the snap. Asserting
   * exactness here would be asserting something the function does not promise;
   * asserting ≤ 0.5 is the real invariant and it still fails if the anchor is
   * dropped altogether (which would land at 12.5, off by 12.5).
   */
  test("holds a point a quarter in, to within the index snap", () => {
    const next = zoomIndexWindow(101, w(0, 100), 0.25, 0.5);
    const anchorAfter = next.startIdx + 0.25 * (next.endIdx - next.startIdx);
    expect(Math.abs(anchorAfter - 25)).toBeLessThanOrEqual(0.5);
  });

  test("never zooms out past the full series", () => {
    expect(zoomIndexWindow(101, w(0, 100), 0.5, 100)).toEqual({ startIdx: 0, endIdx: 100 });
  });

  test("never zooms in below two points, however hard you pinch", () => {
    const next = zoomIndexWindow(101, w(40, 60), 0.5, 0.0001);
    expect(next.endIdx - next.startIdx).toBe(1);
    expect(next.endIdx).toBeGreaterThan(next.startIdx);
  });

  test("clamps an anchor ratio outside 0..1 instead of escaping the series", () => {
    for (const ratio of [-5, 5]) {
      const next = zoomIndexWindow(101, w(0, 100), ratio, 0.5);
      expect(next.startIdx).toBeGreaterThanOrEqual(0);
      expect(next.endIdx).toBeLessThanOrEqual(100);
      expect(next.endIdx).toBeGreaterThan(next.startIdx);
    }
  });

  test("a degenerate one-point series yields a valid, non-inverted window", () => {
    const next = zoomIndexWindow(1, w(0, 0), 0.5, 0.5);
    expect(next.startIdx).toBe(0);
    expect(next.endIdx).toBe(0);
  });

  test("an empty series does not produce negative indices", () => {
    const next = zoomIndexWindow(0, w(0, 0), 0.5, 2);
    expect(next.startIdx).toBe(0);
    expect(next.endIdx).toBe(0);
  });

  test("an already-inverted window is repaired rather than propagated", () => {
    const next = zoomIndexWindow(101, w(60, 40), 0.5, 1);
    expect(next.endIdx).toBeGreaterThan(next.startIdx);
  });
});

describe("panIndexWindow", () => {
  test("slides the window without changing its span", () => {
    expect(panIndexWindow(101, w(10, 30), 5)).toEqual({ startIdx: 15, endIdx: 35 });
  });

  test("slides backwards", () => {
    expect(panIndexWindow(101, w(10, 30), -5)).toEqual({ startIdx: 5, endIdx: 25 });
  });

  /**
   * Parking against an edge must PRESERVE the span. Re-deriving the end from a
   * clamped start would squash the window as it hits the boundary — a pan that
   * silently zooms, which is disorienting precisely when the user is trying to
   * reach the edge of the data.
   */
  test("parks against the start edge keeping its span", () => {
    expect(panIndexWindow(101, w(10, 30), -999)).toEqual({ startIdx: 0, endIdx: 20 });
  });

  test("parks against the end edge keeping its span", () => {
    expect(panIndexWindow(101, w(10, 30), 999)).toEqual({ startIdx: 80, endIdx: 100 });
  });

  test("a full-width window cannot be panned anywhere", () => {
    expect(panIndexWindow(101, w(0, 100), 50)).toEqual({ startIdx: 0, endIdx: 100 });
  });

  test("an empty series stays at zero", () => {
    expect(panIndexWindow(0, w(0, 0), 10)).toEqual({ startIdx: 0, endIdx: 0 });
  });

  test("an inverted window is clamped to a non-negative span", () => {
    const next = panIndexWindow(101, w(30, 10), 0);
    expect(next.endIdx).toBeGreaterThanOrEqual(next.startIdx);
  });
});

describe("panPointsFromWheel", () => {
  test("scales with the visible span so the data tracks the fingers 1:1", () => {
    // half the plot's width of travel should move half the visible span
    expect(panPointsFromWheel(500, 100, 1000)).toBe(50);
    // …and the same pixels move fewer points when fewer are on screen
    expect(panPointsFromWheel(500, 10, 1000)).toBe(5);
  });

  test("carries the sign of the gesture", () => {
    expect(panPointsFromWheel(-500, 100, 1000)).toBe(-50);
  });

  test("falls back to one point per event when the plot has not been measured", () => {
    // a zero width would divide by zero; the fallback still moves, so an early
    // gesture is not silently swallowed
    expect(panPointsFromWheel(30, 100, 0)).toBe(1);
    expect(panPointsFromWheel(-30, 100, 0)).toBe(-1);
    expect(panPointsFromWheel(0, 100, 0)).toBe(0);
  });

  test("a negative width is treated as unmeasured, not inverted", () => {
    expect(panPointsFromWheel(30, 100, -10)).toBe(1);
  });
});
