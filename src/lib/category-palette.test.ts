import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { contrastRatio, isInSrgbGamut, type Oklch } from "./color-contrast";
import {
  CATEGORY_HUE_NAMES,
  CATEGORY_PALETTE,
  categoryHueVar,
  isCategoryHueName,
} from "./category-palette";

/**
 * The palette gate: proves the CSS mirror is in sync with the TS source and
 * that every hue meets its contrast contract in both themes. This is the
 * deterministic replacement for "axe will catch it" — axe only sees hues that
 * happen to render on a scanned page.
 */

const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * Extract the body of a top-level block (`:root { … }` / `.dark { … }`) by
 * brace counting. An indexOf("\n}") scan silently over-captures the moment
 * the blocks move inside `@layer`/`@media` (their closer indents), swallowing
 * the OTHER theme's tokens and letting contrast assertions validate the wrong
 * values while staying green — so the block must end at its true matching
 * brace, and the opener must sit at nesting depth 0.
 */
function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector ${selector} present in globals.css`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = 0; i < start; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
  }
  expect(depth, `selector ${selector} declared at top level, not nested in @layer/@media`).toBe(0);
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i);
    }
  }
  throw new Error(`Unbalanced braces after "${selector}" in globals.css`);
}

function parseOklchToken(block: string, token: string): Oklch {
  const match = block.match(new RegExp(`${token}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\);`));
  expect(match, `token ${token} defined as a literal oklch()`).not.toBeNull();
  const [, l, c, h] = match!;
  return { l: Number(l), c: Number(c), h: Number(h) };
}

const light = cssBlock(":root");
const dark = cssBlock(".dark");

describe("cssBlock extraction stays scoped", () => {
  test("neither theme slice swallows the other block", () => {
    expect(light).not.toContain(".dark {");
    expect(dark).not.toContain(":root {");
  });
});

describe("CSS mirror stays in sync with category-palette.ts", () => {
  for (const name of CATEGORY_HUE_NAMES) {
    test(`--cat-${name} light + dark, solid + soft match the TS source`, () => {
      const spec = CATEGORY_PALETTE[name];
      expect(parseOklchToken(light, `--cat-${name}`)).toEqual(spec.light.solid);
      expect(parseOklchToken(light, `--cat-${name}-soft`)).toEqual(spec.light.soft);
      expect(parseOklchToken(dark, `--cat-${name}`)).toEqual(spec.dark.solid);
      expect(parseOklchToken(dark, `--cat-${name}-soft`)).toEqual(spec.dark.soft);
    });
  }
});

describe("contrast contract", () => {
  const themes = [
    {
      label: "light",
      pick: (name: (typeof CATEGORY_HUE_NAMES)[number]) => CATEGORY_PALETTE[name].light,
      ink: parseOklchToken(light, "--ink"),
      surfaces: [
        parseOklchToken(light, "--surface"),
        parseOklchToken(light, "--surface-raised"),
        parseOklchToken(light, "--surface-sunken"),
      ],
    },
    {
      label: "dark",
      pick: (name: (typeof CATEGORY_HUE_NAMES)[number]) => CATEGORY_PALETTE[name].dark,
      ink: parseOklchToken(dark, "--ink"),
      surfaces: [
        parseOklchToken(dark, "--surface"),
        parseOklchToken(dark, "--surface-raised"),
        parseOklchToken(dark, "--surface-sunken"),
      ],
    },
  ];

  for (const theme of themes) {
    for (const name of CATEGORY_HUE_NAMES) {
      test(`${theme.label}/${name}: in gamut; ink on tint ≥ 4.5; solid ≥ 3 on every surface`, () => {
        const { solid, soft } = theme.pick(name);
        expect(isInSrgbGamut(solid), "solid in sRGB gamut").toBe(true);
        expect(isInSrgbGamut(soft), "soft in sRGB gamut").toBe(true);

        expect(contrastRatio(theme.ink, soft), "chip text (--ink) on -soft tint").toBeGreaterThanOrEqual(4.5);

        for (const surface of [...theme.surfaces, soft]) {
          expect(contrastRatio(solid, surface), "solid as graphical object").toBeGreaterThanOrEqual(3);
        }
      });
    }
  }

  test("state tokens: --info meets the same graphical bar in both themes", () => {
    const lightInfo = parseOklchToken(light, "--info");
    const darkInfo = parseOklchToken(dark, "--info");
    expect(contrastRatio(lightInfo, parseOklchToken(light, "--surface"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(darkInfo, parseOklchToken(dark, "--surface"))).toBeGreaterThanOrEqual(3);
  });

  /**
   * The signed tones as GRAPHICAL OBJECTS — a bar, a wedge, a fill — which is a
   * different bar from the two this file already holds. `--cat-*` solids are
   * gated on every surface, and `--positive`/`--negative` are gated as TEXT on
   * their own tint, but nothing asserted them as shapes on a page background.
   *
   * The measured values pass comfortably (≥4.98 light, ≥5.53 dark); the point is
   * that they were ungated, so a token tweak could have quietly dropped a signed
   * chart below the line with every test still green.
   */
  for (const [label, block] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const tone of ["positive", "negative"] as const) {
      test(`${label}/--${tone}: a filled shape on every surface ≥ 3`, () => {
        const solid = parseOklchToken(block, `--${tone}`);
        for (const surface of ["--surface", "--surface-raised", "--surface-sunken"] as const) {
          expect(
            contrastRatio(solid, parseOklchToken(block, surface)),
            `--${tone} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }

  test("⛔ --positive and --negative are NOT distinguishable from each other — hue can never be the only carrier", () => {
    /*
     * MEASURED, and deliberately asserted as a LIMIT rather than a target:
     * light 1.00, dark 1.35. The two tones were chosen to sit at the same
     * lightness so neither shouts louder than the other in a column of numbers,
     * and that is the right call for text. It means a chart placing an up-shape
     * beside a down-shape and relying on hue alone is unreadable in greyscale
     * and to a protan or deutan reader, in BOTH themes.
     *
     * This test exists so that fact is written down where the next person to
     * draw a signed chart will meet it, rather than discovered afterwards. The
     * house answer is already established: PnlCalendar carries direction in an
     * aria-hidden ▲/▼ with neutral numerals, and CategoryMassif's rule is
     * "COLOUR — category identity (never the only carrier of a fact)".
     *
     * If a future change DOES separate them, this test failing is the signal to
     * revisit that rule — not to raise the number here.
     */
    for (const [label, block] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const ratio = contrastRatio(parseOklchToken(block, "--positive"), parseOklchToken(block, "--negative"));
      expect(ratio, `${label}: --positive vs --negative`).toBeLessThan(3);
    }
  });
});

/**
 * State badges (Badge, SeriesTable) render `text-{tone}` on `bg-{tone}-soft` at
 * 10px — AA small text, ≥ 4.5:1. This is the route-independent guard: axe only
 * catches it if a badge of that tone happens to render on a scanned page, and
 * `positive` shipped at 4.45:1 (a /12 tint borrowed for a missing -soft token)
 * until this test existed to prove every tone-on-its-own-tint clears the bar.
 */
describe("state badge tints meet AA", () => {
  const TONES = ["positive", "negative", "warning", "info"] as const;
  for (const [label, block] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const tone of TONES) {
      // Contrast only: the tone TEXT tokens are intentionally saturated and can
      // sit just outside sRGB (the browser gamut-maps them); contrastRatio
      // clamps channels the same way, so the ratio matches the rendered color.
      test(`${label}/${tone}: --${tone} on --${tone}-soft ≥ 4.5`, () => {
        const text = parseOklchToken(block, `--${tone}`);
        const soft = parseOklchToken(block, `--${tone}-soft`);
        expect(contrastRatio(text, soft), "badge text on its own tint").toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("helpers", () => {
  test("isCategoryHueName accepts every palette name and rejects junk", () => {
    for (const name of CATEGORY_HUE_NAMES) expect(isCategoryHueName(name)).toBe(true);
    expect(isCategoryHueName("mauve")).toBe(false);
    expect(isCategoryHueName(null)).toBe(false);
    expect(isCategoryHueName(undefined)).toBe(false);
  });

  test("categoryHueVar emits solid and soft variable references", () => {
    expect(categoryHueVar("green")).toBe("var(--cat-green)");
    expect(categoryHueVar("green", "solid")).toBe("var(--cat-green)");
    expect(categoryHueVar("green", "soft")).toBe("var(--cat-green-soft)");
  });
});
