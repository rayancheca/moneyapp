import { describe, expect, test } from "vitest";
import { contrastRatio, isInSrgbGamut, mixOklab, oklchToLinearSrgb, wcagLuminance } from "./color-contrast";

const WHITE = { l: 1, c: 0, h: 0 };
const BLACK = { l: 0, c: 0, h: 0 };

describe("oklchToLinearSrgb", () => {
  test("white maps to all channels ≈ 1", () => {
    const { r, g, b } = oklchToLinearSrgb(WHITE);
    expect(r).toBeCloseTo(1, 3);
    expect(g).toBeCloseTo(1, 3);
    expect(b).toBeCloseTo(1, 3);
  });

  test("black maps to all channels ≈ 0", () => {
    const { r, g, b } = oklchToLinearSrgb(BLACK);
    expect(r).toBeCloseTo(0, 3);
    expect(g).toBeCloseTo(0, 3);
    expect(b).toBeCloseTo(0, 3);
  });

  test("a saturated red has r dominant over g and b", () => {
    const { r, g, b } = oklchToLinearSrgb({ l: 0.55, c: 0.2, h: 25 });
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });
});

describe("isInSrgbGamut", () => {
  test("grays are always in gamut", () => {
    expect(isInSrgbGamut({ l: 0.5, c: 0, h: 0 })).toBe(true);
  });

  test("impossible chroma falls out of gamut", () => {
    expect(isInSrgbGamut({ l: 0.5, c: 0.4, h: 145 })).toBe(false);
  });

  test("tolerance parameter admits marginal values", () => {
    const marginal = { l: 0.9999, c: 0.001, h: 90 };
    expect(isInSrgbGamut(marginal, 1)).toBe(true);
  });
});

describe("wcagLuminance", () => {
  test("white ≈ 1 and black ≈ 0", () => {
    expect(wcagLuminance(WHITE)).toBeCloseTo(1, 3);
    expect(wcagLuminance(BLACK)).toBeCloseTo(0, 3);
  });

  test("out-of-gamut channels are clamped instead of distorting the result", () => {
    const overdriven = { l: 1.2, c: 0, h: 0 };
    expect(wcagLuminance(overdriven)).toBe(1);
  });
});

describe("contrastRatio", () => {
  test("white vs black is the WCAG maximum ≈ 21", () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 1);
  });

  test("is symmetric in its arguments", () => {
    const gray = { l: 0.578, c: 0, h: 0 };
    expect(contrastRatio(WHITE, gray)).toBeCloseTo(contrastRatio(gray, WHITE), 10);
  });

  test("oklch gray L 0.578 (#767676) hits ≈ 4.5:1 against white — the AA anchor", () => {
    const ratio = contrastRatio({ l: 0.578, c: 0, h: 0 }, WHITE);
    expect(ratio).toBeGreaterThan(4.3);
    expect(ratio).toBeLessThan(4.8);
  });

  test("identical colors ratio 1", () => {
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });
});

describe("mixOklab", () => {
  test("the endpoints are the endpoints", () => {
    const a = { l: 0.5, c: 0.15, h: 30 };
    const b = { l: 0.99, c: 0.002, h: 85 };
    expect(mixOklab(a, b, 100).l).toBeCloseTo(a.l, 10);
    expect(mixOklab(a, b, 0).l).toBeCloseTo(b.l, 10);
  });

  test("mixes in OKLab, not around the hue circle", () => {
    // `in oklab` and `in oklch` are different CSS functions and do NOT agree:
    // interpolating the ANGLE between 30° and 300° travels the long way round
    // through green, while the Cartesian mix passes through grey. The browser
    // does the latter, so this must too — a hue near neither input is the tell.
    const mixed = mixOklab({ l: 0.6, c: 0.14, h: 30 }, { l: 0.6, c: 0.14, h: 300 }, 50);
    expect(mixed.c).toBeLessThan(0.14);
  });

  test("a mix landing in the lower half-plane still reports a positive hue", () => {
    // atan2 returns (-π, π]; a hue of -75° would be rejected by every consumer
    // that expects degrees in [0, 360).
    const mixed = mixOklab({ l: 0.6, c: 0.14, h: 300 }, { l: 0.6, c: 0.14, h: 280 }, 50);
    expect(mixed.h).toBeGreaterThanOrEqual(0);
    expect(mixed.h).toBeLessThan(360);
  });

  test("every mix of two in-gamut tones stays a usable colour", () => {
    for (const pct of [0, 12, 50, 88, 100]) {
      const m = mixOklab({ l: 0.53, c: 0.15, h: 30 }, { l: 0.996, c: 0.002, h: 85 }, pct);
      expect(Number.isFinite(m.l) && Number.isFinite(m.c) && Number.isFinite(m.h)).toBe(true);
      expect(m.h).toBeGreaterThanOrEqual(0);
    }
  });
});
