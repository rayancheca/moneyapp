import { describe, expect, test } from "vitest";
import { contrastRatio, isInSrgbGamut, oklchToLinearSrgb, wcagLuminance } from "./color-contrast";

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
