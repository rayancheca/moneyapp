import { describe, expect, test } from "vitest";
import { HEAT_BASE_PCT, HEAT_RANGE_PCT, heatMixPercent } from "./calendar-heat";
import { contrastRatio, mixOklab, type Oklch } from "./color-contrast";

const ok = (l: number, c: number, h: number): Oklch => ({ l, c, h });

/** Verbatim from globals.css — the tokens a day cell actually paints with. */
const LIGHT = {
  surfaceRaised: ok(0.996, 0.002, 85),
  ink: ok(0.22, 0.015, 75),
  inkMuted: ok(0.46, 0.014, 75),
  positive: ok(0.5, 0.11, 160),
  negative: ok(0.53, 0.15, 30),
};
const DARK = {
  surfaceRaised: ok(0.23, 0.013, 75),
  ink: ok(0.93, 0.009, 85),
  inkMuted: ok(0.7, 0.011, 80),
  positive: ok(0.73, 0.115, 160),
  negative: ok(0.68, 0.14, 30),
};

describe("heatMixPercent", () => {
  test("an empty-ish day is still visibly raised, and the heaviest is capped", () => {
    expect(heatMixPercent(0)).toBe(HEAT_BASE_PCT);
    expect(heatMixPercent(1)).toBe(HEAT_BASE_PCT + HEAT_RANGE_PCT);
  });

  test("clamps rather than extrapolating", () => {
    // `dayWeight` promises 0..1 and a caller could still hand over a ratio; a
    // 300% mix would paint the tone flat over the cell and take the text with it.
    expect(heatMixPercent(-4)).toBe(HEAT_BASE_PCT);
    expect(heatMixPercent(9)).toBe(HEAT_BASE_PCT + HEAT_RANGE_PCT);
  });

  test("is monotonic, so a heavier day is never paler", () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map(heatMixPercent);
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
  });
});

describe("the strongest tint keeps every foreground above AA", () => {
  // The cell paints: the date (--ink), the day's total (--positive/--negative),
  // the merchant name and the overflow count (--ink-muted). 4.5:1 is the AA bar.
  //
  // --ink-faint is absent BY DESIGN and the component must keep it that way: it
  // is the dimmest ink that clears AA on the app's plain surfaces, so it has no
  // headroom left once a tone is mixed underneath. Putting it back on a day cell
  // would silently reintroduce the 4.03:1 failure this file was written for.
  test.each([
    ["light", LIGHT],
    ["dark", DARK],
  ])("%s theme", (_label, t) => {
    const strongest = heatMixPercent(1);
    for (const tone of [t.positive, t.negative]) {
      const tinted = mixOklab(tone, t.surfaceRaised, strongest);
      for (const [name, fg] of [
        ["ink", t.ink],
        ["ink-muted", t.inkMuted],
        ["the amount itself", tone],
      ] as const) {
        const ratio = contrastRatio(fg, tinted);
        expect(ratio, `${name} on the heaviest tint`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
