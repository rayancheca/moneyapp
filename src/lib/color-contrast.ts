/**
 * OKLCH → WCAG contrast math, used by the palette gate test to prove every
 * category hue meets its contrast contract in both themes without rendering
 * a single pixel (axe only sees hues that happen to be on a scanned page).
 * Conversion matrices are Björn Ottosson's OKLab reference values.
 */

export interface Oklch {
  /** perceptual lightness 0..1 */
  l: number;
  /** chroma, 0 = gray */
  c: number;
  /** hue angle in degrees */
  h: number;
}

interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

export function oklchToLinearSrgb({ l, c, h }: Oklch): LinearRgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);

  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    g: -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    b: -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  };
}

/** True when the color displays without clipping on an sRGB screen. */
export function isInSrgbGamut(color: Oklch, tolerance = 1e-4): boolean {
  const { r, g, b } = oklchToLinearSrgb(color);
  return [r, g, b].every((ch) => ch >= -tolerance && ch <= 1 + tolerance);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** WCAG relative luminance (channels clamped — callers gate gamut separately). */
export function wcagLuminance(color: Oklch): number {
  const { r, g, b } = oklchToLinearSrgb(color);
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);
}

/** WCAG 2.x contrast ratio, 1..21. Order of arguments does not matter. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const ya = wcagLuminance(a);
  const yb = wcagLuminance(b);
  const hi = Math.max(ya, yb);
  const lo = Math.min(ya, yb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * CSS `color-mix(in oklab, a p%, b)`, in the same OKLab space the browser uses.
 *
 * Needed because a contrast contract cannot be checked against a colour the
 * stylesheet computes at paint time. The recurring calendar tints each day by
 * how heavy it is — a continuous blend of a state tone into the card surface —
 * and "does live text still clear AA on top of it" is answerable only if the
 * blend can be reproduced here.
 *
 * OKLab is a Cartesian space, so the mix is a plain component-wise lerp of
 * (L, a, b); the polar (L, C, H) form has to be converted in and out, and the
 * hue must NOT be interpolated as an angle — that is `in oklch`, a different
 * and non-equivalent function.
 */
export function mixOklab(a: Oklch, b: Oklch, aPercent: number): Oklch {
  const t = aPercent / 100;
  const toLab = ({ l, c, h }: Oklch) => {
    const rad = (h * Math.PI) / 180;
    return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
  };
  const la = toLab(a);
  const lb = toLab(b);
  const l = lb.l + (la.l - lb.l) * t;
  const ax = lb.a + (la.a - lb.a) * t;
  const bx = lb.b + (la.b - lb.b) * t;
  const hue = (Math.atan2(bx, ax) * 180) / Math.PI;
  return { l, c: Math.hypot(ax, bx), h: hue < 0 ? hue + 360 : hue };
}
