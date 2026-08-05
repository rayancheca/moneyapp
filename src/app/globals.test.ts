import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { oklchToLinearSrgb, type Oklch } from "@/lib/color-contrast";

/**
 * THE PAPER-AND-TYPE GATE.
 *
 * Two failures this file exists to make impossible.
 *
 * 1. A TOKEN CONTRACT NOBODY CONSUMES. Wave 1 shipped --grain-opacity and
 *    --grain-blend with a comment claiming a decorative overlay consumed them.
 *    No such overlay existed; the comment was the only evidence anyone had, and
 *    a comment cannot be wrong loudly. So the grain's consumer is asserted here
 *    — the CSS rule, and the node AppShell renders — along with the properties
 *    that make it safe: aria-hidden, pointer-events:none, an inline data: URI
 *    (never a network request), and no animation.
 *
 * 2. A TEXTURE THAT QUIETLY EATS THE CONTRAST BUDGET. The grain modulates the
 *    bare sheet, so every foreground that can land on bare paper is re-measured
 *    HERE against the grained sheet, with the blend and the amount read out of
 *    globals.css rather than restated. Retune --grain-opacity and this fails
 *    before it reaches a screen.
 *
 * The worst case below is deliberately harsher than the shipped tile: it
 * assumes a noise pixel at full alpha AND full black, which fractalNoise
 * reaches only in its tail. Measured in Chromium, the real extreme on the light
 * sheet is a 1.6% channel drop (249 → 245); the bound here is 4.5%.
 */

const root = process.cwd();
const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
const shell = fs.readFileSync(path.join(root, "src/components/shell/AppShell.tsx"), "utf8");
const mockup = fs.readFileSync(
  path.join(root, "docs/design-directions/direction-A-plus.html"),
  "utf8",
);

/** Declarations of one top-level block, by selector. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`globals.css: no \`${selector}\` block`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i);
  }
  throw new Error(`globals.css: \`${selector}\` block never closes`);
}

/** Custom properties of a block, comments stripped so a doc example can't win. */
function tokens(source: string): Map<string, string> {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map<string, string>();
  for (const m of bare.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(m[1] as string, (m[2] as string).trim().replace(/\s+/g, " "));
  }
  return found;
}

const rootTokens = tokens(block(css, ":root"));
const darkTokens = tokens(block(css, ".dark"));
const themeTokens = tokens(block(css, "@theme inline"));
const grainRule = block(css, ".paper-grain");

// ── colour plumbing ────────────────────────────────────────────────────────
// The grain blends in gamma-encoded sRGB (that is the space CSS composites in),
// so the OKLCH tokens have to be encoded before blending and decoded after.

function parseOklch(value: string): Oklch {
  const m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const raw = m[1] as string;
  return {
    l: raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw),
    c: Number(m[2]),
    h: Number(m[3]),
  };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const encode = (c: number): number =>
  clamp01(c) <= 0.0031308 ? 12.92 * clamp01(c) : 1.055 * clamp01(c) ** (1 / 2.4) - 0.055;
const decode = (c: number): number =>
  clamp01(c) <= 0.04045 ? clamp01(c) / 12.92 : ((clamp01(c) + 0.055) / 1.055) ** 2.4;

function toSrgb(color: Oklch): number[] {
  const { r, g, b } = oklchToLinearSrgb(color);
  return [encode(r), encode(g), encode(b)];
}

function luminance(srgb: readonly number[]): number {
  return 0.2126 * decode(srgb[0] ?? 0) + 0.7152 * decode(srgb[1] ?? 0) + 0.0722 * decode(srgb[2] ?? 0);
}

function ratio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const BLENDS: Record<string, (backdrop: number, source: number) => number> = {
  multiply: (cb, cs) => cb * cs,
  overlay: (cb, cs) => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)),
};

/** The sheet as the grain can leave it, at the noise's two extremes. */
function grainedSheet(surface: Oklch, blendName: string, alpha: number): number[][] {
  const blend = BLENDS[blendName];
  if (!blend) throw new Error(`no reference implementation for blend \`${blendName}\``);
  const paper = toSrgb(surface);
  // source alpha 1 (its harshest) at the darkest and lightest noise value
  return [0, 1].map((cs) => paper.map((cb) => cb * (1 - alpha) + alpha * blend(cb, cs)));
}

const AA_TEXT = 4.5;
const AA_GRAPHICAL = 3;

/** Every token that can be set as TEXT directly on the bare sheet. */
const TEXT_TOKENS = [
  "--ink",
  "--ink-muted",
  "--ink-faint",
  "--ink-display",
  "--annotation",
  "--accent",
  "--accent-ink",
  "--positive",
  "--negative",
  "--warning",
  "--info",
] as const;

const CATEGORY_HUES = [
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "pink",
  "brown",
] as const;

const THEMES = [
  { name: "light", tokens: rootTokens },
  { name: "dark", tokens: darkTokens },
] as const;

describe("the paper tooth is a real layer, not a comment", () => {
  test("globals.css declares the consumer the grain tokens were written for", () => {
    expect(rootTokens.get("--grain-opacity")).toBeTruthy();
    expect(rootTokens.get("--grain-blend")).toBeTruthy();
    expect(darkTokens.get("--grain-opacity")).toBeTruthy();
    expect(darkTokens.get("--grain-blend")).toBeTruthy();
    // both must be READ by the rule, or the two themes cannot disagree
    expect(grainRule).toMatch(/opacity:\s*var\(--grain-opacity\)/);
    expect(grainRule).toMatch(/mix-blend-mode:\s*var\(--grain-blend\)/);
  });

  test("AppShell renders it, decoratively", () => {
    const node = /<div className="paper-grain"[^>]*\/>/.exec(shell);
    expect(node?.[0], "AppShell.tsx no longer renders <div className=\"paper-grain\" …/>").toBeTruthy();
    expect(node?.[0]).toMatch(/\baria-hidden\b/);
  });

  test("it cannot take a click and cannot cover content", () => {
    expect(grainRule).toMatch(/pointer-events:\s*none/);
    expect(grainRule).toMatch(/position:\s*fixed/);
    // negative z-index is the whole contrast argument: above the canvas fill,
    // below every background box, so it can never paint on top of a glyph
    const z = /z-index:\s*(-?\d+)/.exec(grainRule);
    expect(Number(z?.[1])).toBeLessThan(0);
  });

  test("the tile is inline and still, never a request and never a frame", () => {
    expect(grainRule).toMatch(/background-image:\s*url\("data:image\/svg\+xml,/);
    // the xmlns INSIDE the tile is a namespace, not a fetch; what must never
    // appear is a url() the browser would go to the network for
    expect(grainRule).not.toMatch(/url\(\s*["']?https?:/);
    expect(grainRule).not.toMatch(/\banimation\b|\btransition\b/);
  });

  test("paper does not print itself", () => {
    expect(css).toMatch(/@media print\s*\{\s*\.paper-grain\s*\{\s*display:\s*none/);
  });
});

describe("the grain never spends the contrast budget", () => {
  for (const theme of THEMES) {
    const surface = parseOklch(theme.tokens.get("--surface") as string);
    const alpha = Number(theme.tokens.get("--grain-opacity"));
    const blendName = theme.tokens.get("--grain-blend") as string;
    const sheets = grainedSheet(surface, blendName, alpha);

    test(`${theme.name}: the amount and the blend are readable, and sane`, () => {
      expect(alpha).toBeGreaterThan(0);
      // more than a tenth and it stops being tooth and starts being a filter
      expect(alpha).toBeLessThanOrEqual(0.1);
      expect(Object.keys(BLENDS)).toContain(blendName);
    });

    test(`${theme.name}: every text token still clears AA on the grained sheet`, () => {
      for (const name of TEXT_TOKENS) {
        const fg = luminance(toSrgb(parseOklch(theme.tokens.get(name) as string)));
        const worst = Math.min(...sheets.map((sheet) => ratio(fg, luminance(sheet))));
        expect(worst, `${name} on the grained ${theme.name} sheet: ${worst.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });

    /**
     * Soft-tint pills (`bg-<tone>-soft text-<tone>`) are used for the nav
     * badges and status chips, and nothing gated them until pass 36: the
     * check above puts every tone on the SHEET, never on its own tint. The
     * duplicates pill (`--warning` on `--warning-soft`) measures 4.71:1 in
     * light — passing, but by 0.21, so a future token retune could break it
     * silently.
     */
    test(`${theme.name}: every tone clears AA on its OWN soft tint`, () => {
      for (const tone of ["--accent", "--positive", "--negative", "--warning", "--info"]) {
        const soft = theme.tokens.get(`${tone}-soft`);
        if (soft === undefined) continue;
        const fg = luminance(toSrgb(parseOklch(theme.tokens.get(tone) as string)));
        const bg = luminance(toSrgb(parseOklch(soft)));
        const r = ratio(fg, bg);
        expect(r, `${tone} on ${tone}-soft (${theme.name}): ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });

    test(`${theme.name}: every category solid still clears the graphical bar`, () => {
      for (const hue of CATEGORY_HUES) {
        const name = `--cat-${hue}`;
        const fg = luminance(toSrgb(parseOklch(theme.tokens.get(name) as string)));
        const worst = Math.min(...sheets.map((sheet) => ratio(fg, luminance(sheet))));
        expect(worst, `${name} on the grained ${theme.name} sheet: ${worst.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_GRAPHICAL);
      }
    });

    test(`${theme.name}: the grain moves the sheet, but only just`, () => {
      const plain = luminance(toSrgb(surface));
      const moved = sheets.map((sheet) => Math.abs(luminance(sheet) - plain));
      // it has to do something…
      expect(Math.max(...moved)).toBeGreaterThan(0);
      // …and it has to stay a texture, not a tint
      expect(Math.max(...moved) / Math.max(plain, 1e-6)).toBeLessThan(0.12);
    });
  }
});

describe("the editorial type scale reconciles to Direction A+", () => {
  /** A+'s own `--text-*` block, read out of the approved mockup. */
  const approved = new Map<string, string>();
  for (const m of mockup.matchAll(/(--text-[\w-]+|--track-eyebrow|--measure)\s*:\s*([^;]+);/g)) {
    approved.set(m[1] as string, (m[2] as string).trim().replace(/\s+/g, " "));
  }

  const STEPS = [
    "eyebrow",
    "micro",
    "body",
    "lede",
    "h3",
    "h2",
    "h1",
    "display",
    "display-2",
  ] as const;

  test("the mockup really does declare all nine steps", () => {
    // guards the guard: a renamed step in the mockup must not silently make
    // the parity assertions below vacuous
    for (const step of STEPS) expect(approved.has(`--text-${step}`), `mockup lost --text-${step}`).toBe(true);
  });

  test("every step matches A+ value-for-value", () => {
    for (const step of STEPS) {
      const ours = rootTokens.get(`--type-${step}`);
      expect(ours, `globals.css is missing --type-${step}`).toBeTruthy();
      // whitespace and how a number is spelled are the only licence taken:
      // A+ writes `1.60rem`, prettier writes `1.6rem`, and those are one value
      const norm = (v: string): string =>
        v.replace(/\s+/g, "").replace(/\d*\.?\d+/g, (n) => String(Number(n)));
      expect(norm(ours as string), `--type-${step}`).toBe(norm(approved.get(`--text-${step}`) as string));
    }
    expect(rootTokens.get("--track-eyebrow")).toBe(approved.get("--track-eyebrow"));
    expect(rootTokens.get("--measure")).toBe(approved.get("--measure"));
  });

  test("every step is reachable as a Tailwind utility", () => {
    // `@theme inline` does NOT emit its keys as custom properties — it inlines
    // the value into the utility — so a step declared only in :root would have
    // no `text-…` class at all, and a step declared only in @theme would have
    // no `var()`. Both halves, or the scale is half-built.
    for (const step of STEPS) {
      expect(themeTokens.get(`--text-${step}`), `no text-${step} utility`).toBe(`var(--type-${step})`);
    }
    expect(themeTokens.get("--font-display")).toBe("var(--face-display)");
    expect(themeTokens.get("--tracking-eyebrow")).toBe("var(--track-eyebrow)");
    expect(themeTokens.get("--container-measure")).toBe("var(--measure)");
  });

  test("the two display steps carry the line-heights A+ states", () => {
    expect(themeTokens.get("--text-display--line-height")).toBe("0.9");
    expect(themeTokens.get("--text-display-2--line-height")).toBe("1.05");
  });

  test("the scale does not change between themes", () => {
    // a sheet does not resize when the lights go out
    for (const step of STEPS) expect(darkTokens.has(`--type-${step}`)).toBe(false);
  });

  test("the shell consumes the scale and the display ink", () => {
    // the tokens' first real consumer: A+'s wordmark, `Money<em>App</em>`
    expect(shell).toMatch(/font-display/);
    expect(shell).toMatch(/text-h3/);
    expect(shell).toMatch(/text-ink-display/);
    expect(shell).toMatch(/text-accent-ink/);
    expect(shell).toMatch(/className="eyebrow/);
    // …and the nameplate is still ONE word. `Money` and `<em>App</em>` have to
    // stay adjacent: put anything but a line break between them and JSX emits a
    // literal space, so the DOM text becomes "Money App" and every `MoneyApp`
    // text query, plus the accessible name, quietly stops matching.
    expect(
      /Money\s*<em\b/.test(shell) && !/Money[ \t]+<em\b/.test(shell),
      "the wordmark must render the single string `MoneyApp`",
    ).toBe(true);
  });
});

describe("figures do not shimmy", () => {
  const body = block(css, "body");

  test("the page sets tabular numerals once, for everything", () => {
    // Geist Sans' proportional digits span 384–663/1000em — a 72.7% spread —
    // so any figure outside `.figures` (chart axes, SVG labels, the scrub
    // tooltip's date) changed width as it updated. One inherited declaration
    // fixes all of them; `tnum` flattens all ten digits to one advance.
    expect(body).toMatch(/font-variant-numeric:[^;]*\btabular-nums\b/);
  });

  test("`.figures` still agrees with it", () => {
    expect(block(css, ".figures")).toMatch(/font-variant-numeric:[^;]*\btabular-nums\b/);
  });
});
