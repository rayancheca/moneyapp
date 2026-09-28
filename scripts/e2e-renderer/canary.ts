import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Browser, BrowserContextOptions, Page, PageScreenshotOptions } from "@playwright/test";

/**
 * The renderer canary: one frozen page whose pixels move when this machine's text rendering
 * moves, and at no other time.
 *
 * WHY IT EXISTS. The e2e gate compares 202 PNG baselines at maxDiffPixels 0 on one Mac. On
 * 2026-09-28 a macOS update changed text antialiasing and failed 107 of them after a 9-minute
 * run, although no UI had changed. Nothing in that run said "the machine changed"; it looked
 * exactly like 107 regressions. Launching a browser and rendering this page takes under a
 * second, so the gate can say it up front, before seeding a database or opening an app page.
 *
 * WHAT IT DRAWS: every text path the baselines use, in both themes. Measured with CDP's
 * CSS.getPlatformFontsForNode on 2026-09-28 (macOS 27.2, Chromium 149 headless shell), the page
 * is drawn by exactly the platform fonts the app's pages are:
 *   - Geist and Geist Mono, from the exact woff2 files the app ships, declared the way
 *     next/font's build output declares them. That includes the size-adjusted local Arial face
 *     it generates; Geist covers every symbol the app prints, so Arial draws nothing today.
 *   - The display serif stack, copied verbatim. Headless Chromium resolves neither `ui-serif`
 *     nor "New York", so the hero figures land on Iowan Old Style, and its missing → comes from
 *     Times New Roman. Both are macOS system fonts: an OS update can change the fonts
 *     themselves, not only how they are rasterised.
 *   - system-ui, the body's own fallback: ⌘ is not in Geist, so SF draws it, as it does in the
 *     app's shortcut hints.
 *   - The type scale's sizes and weights at the 1280px Desktop Chrome viewport, fractional sizes
 *     included, with tabular digits and the symbols the app prints ($ , . − → ≈ · and friends).
 *   - Ink on paper and paper on ink. Glyph masks are built per text luminance, so light-on-dark
 *     text takes a different path from dark-on-light and one theme alone would miss half of it.
 *   - SVG <text> the way chart ticks draw it, stroked icon and chart paths, a card's rounded
 *     edge and shadow, and the paper grain every page sits on.
 *
 * FROZEN ON PURPOSE. The tokens, font stacks and sizes are COPIED from src/app/globals.css and
 * next/font's generated CSS, never read from them. A canary that imported the app's styles
 * would move with every design change and report it as a renderer change, which is the one
 * confusion this file exists to remove. The figures are glyph coverage, not ledger data. Any
 * edit here changes sourceSha256, and the gate then says "canary-changed" until the canary is
 * recorded again.
 */

/**
 * The browser context the page renders in: devices["Desktop Chrome"] and the `use` block of
 * playwright.config.ts, minus the user agent. The user agent names the Chrome version, so
 * keeping it would make every Playwright upgrade read as "the canary changed" instead of "the
 * renderer changed". Nothing in it reaches a pixel.
 */
export const CANARY_CONTEXT = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  colorScheme: "light",
  locale: "en-US",
  timezoneId: "Pacific/Kiritimati",
} as const satisfies BrowserContextOptions;

/** What toHaveScreenshot passes by default, so the canary is captured the way baselines are. */
export const CANARY_SCREENSHOT = {
  type: "png",
  animations: "disabled",
  caret: "hide",
  scale: "css",
} as const satisfies PageScreenshotOptions;

/**
 * The font files next/font loads, resolved through the package's own entry points exactly as
 * next/font/local resolves `src` relative to dist/sans.js and dist/mono.js. Each loader must
 * still name its file: if geist ever points the app at another file, the canary would be
 * measuring a font the app no longer ships.
 */
const SHIPPED_FONTS = {
  sans: { entry: "geist/font/sans", file: "./fonts/geist-sans/Geist-Variable.woff2" },
  mono: { entry: "geist/font/mono", file: "./fonts/geist-mono/GeistMono-Variable.woff2" },
} as const;

/**
 * A settled page gives two identical screenshots in a row; one that never does is broken. The
 * backoff is expectScreenshot's own (0, 100, 250, 500 ms, then 1 s), so ten attempts is at
 * most about seven seconds: a canary that cannot settle in that has found a real problem.
 */
const MAX_SCREENSHOT_ATTEMPTS = 10;
const SCREENSHOT_BACKOFF_MS: readonly number[] = [0, 100, 250, 500];
const SCREENSHOT_BACKOFF_CAP_MS = 1_000;

export interface CanaryFonts {
  sans: Buffer;
  mono: Buffer;
}

export interface CanarySource {
  html: string;
  sourceSha256: string;
}

export interface CanaryRender {
  /** sha256 of the decoded RGBA pixels: a PNG encoder or metadata change cannot move it */
  pixelSha256: string;
  /** sha256 of everything the canary feeds the renderer: context, page and font bytes */
  sourceSha256: string;
  width: number;
  height: number;
  png: Buffer;
}

function readShippedFont({ entry, file }: { entry: string; file: string }): Buffer {
  const loader = createRequire(import.meta.url).resolve(entry);
  if (!fs.readFileSync(loader, "utf8").includes(file)) {
    throw new Error(
      `renderer canary: ${entry} (${loader}) no longer loads ${file}, so the app ships a ` +
        "different font from the one the canary embeds. Point SHIPPED_FONTS at the new file.",
    );
  }
  return fs.readFileSync(path.join(path.dirname(loader), file));
}

export function readShippedFonts(): CanaryFonts {
  return { sans: readShippedFont(SHIPPED_FONTS.sans), mono: readShippedFont(SHIPPED_FONTS.mono) };
}

/** Length-prefixed, so moving bytes from one part to the next cannot keep the same hash. */
function sha256OfParts(parts: readonly (string | Buffer)[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function buildCanarySource(fonts: CanaryFonts): CanarySource {
  const template = canaryTemplate();
  const html = template
    .replace("{{GEIST_SANS_WOFF2}}", fonts.sans.toString("base64"))
    .replace("{{GEIST_MONO_WOFF2}}", fonts.mono.toString("base64"));
  const sourceSha256 = sha256OfParts([
    JSON.stringify(CANARY_CONTEXT),
    JSON.stringify(CANARY_SCREENSHOT),
    template,
    fonts.sans,
    fonts.mono,
  ]);
  return { html, sourceSha256 };
}

export async function renderCanary(browser: Browser): Promise<CanaryRender> {
  const source = buildCanarySource(readShippedFonts());
  const context = await browser.newContext(CANARY_CONTEXT);
  try {
    const page = await context.newPage();
    await page.setContent(source.html, { waitUntil: "load" });
    await waitForCanaryFonts(page);
    const png = await settledScreenshot(page);
    // Raw RGBA, not the PNG bytes: the question is what was drawn, not how it was encoded.
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      pixelSha256: crypto.createHash("sha256").update(data).digest("hex"),
      sourceSha256: source.sourceSha256,
      width: info.width,
      height: info.height,
      png,
    };
  } finally {
    await context.close();
  }
}

/**
 * Loads every declared face explicitly, then waits for document.fonts.ready. `ready` alone can
 * resolve before layout has asked for a face, and a screenshot taken then shows the fallback:
 * a canary that sometimes draws Arial would cry "renderer changed" at random.
 *
 * Settled rather than all-or-nothing, so the statuses below decide. Only the two embedded faces
 * must load: they are the canary's own bytes. Arial is the machine's font, and a machine
 * without it has changed renderer, which is for the pixels to report rather than a crash.
 */
async function waitForCanaryFonts(page: Page): Promise<void> {
  const faces = await page.evaluate(async () => {
    await Promise.allSettled([
      document.fonts.load('400 16px "GeistSans"'),
      document.fonts.load('400 16px "GeistMono"'),
      document.fonts.load('400 16px "GeistSans Fallback"'),
    ]);
    await document.fonts.ready;
    return [...document.fonts].map((face) => ({ family: face.family, status: face.status }));
  });
  const embedded = faces.filter((f) => f.family === "GeistSans" || f.family === "GeistMono");
  const failed = embedded.filter((f) => f.status !== "loaded");
  if (embedded.length !== 2 || failed.length > 0) {
    throw new Error(
      "renderer canary: the embedded Geist faces did not load, so the page would draw fallback " +
        `fonts and measure nothing the baselines use: ${JSON.stringify(faces)}`,
    );
  }
}

function nextTwoFrames(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Captured the way toHaveScreenshot captures a baseline (playwright-core's expectScreenshot):
 * two animation frames before each shot, the same backoff between shots, and done when two
 * consecutive shots agree. A shot that FAILS is retried there rather than thrown, and it is
 * here too. On 2026-09-28, under a load average of 12, one canary render in about a hundred
 * died inside page.screenshot after its font wait, where only the capture calls remain. The
 * baselines' own path would have retried it, and a canary flakier than the suite it guards
 * would teach everyone to skip it.
 */
async function settledScreenshot(page: Page): Promise<Buffer> {
  let previous: Buffer | undefined;
  let lastFailure: unknown;
  for (let attempt = 0; attempt < MAX_SCREENSHOT_ATTEMPTS; attempt++) {
    const wait = SCREENSHOT_BACKOFF_MS[attempt] ?? SCREENSHOT_BACKOFF_CAP_MS;
    if (wait > 0) await delay(wait);
    let shot: Buffer;
    try {
      await nextTwoFrames(page);
      shot = await page.screenshot(CANARY_SCREENSHOT);
    } catch (error) {
      // as in expectScreenshot, a failure also breaks the run of agreeing shots
      lastFailure = error;
      previous = undefined;
      continue;
    }
    if (previous?.equals(shot)) return shot;
    previous = shot;
  }
  const reason = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
  const failure = lastFailure === undefined ? "" : ` The last attempt failed with: ${reason}`;
  throw new Error(
    `renderer canary: no two consecutive screenshots agreed in ${MAX_SCREENSHOT_ATTEMPTS} ` +
      `attempts, so the page never settled and its hash would not mean anything.${failure}`,
  );
}

/* ── The page ────────────────────────────────────────────────────────────────────────────── */

/**
 * Tokens copied verbatim from globals.css (:root and .dark), one set per panel. Only the ones
 * the page draws with are here.
 */
const LIGHT_TOKENS = `
  --surface: oklch(0.977 0.005 85);
  --surface-raised: oklch(0.996 0.002 85);
  --ink: oklch(0.22 0.015 75);
  --ink-muted: oklch(0.46 0.014 75);
  --ink-faint: oklch(0.52 0.012 78);
  --line: oklch(0.9 0.008 85);
  --accent: oklch(0.45 0.095 165);
  --positive: oklch(0.5 0.11 160);
  --negative: oklch(0.53 0.15 30);
  --ink-display: oklch(0.17 0.02 70);
  --annotation: oklch(0.5 0.013 78);
  --emboss-hi: oklch(100% 0 0 / 0.85);
  --emboss-lo: oklch(0.22 0.015 75 / 0.055);
  --press-2:
    0 1px 1px var(--emboss-lo), 0 6px 18px -12px oklch(0.22 0.015 75 / 0.22),
    inset 0 1px 0 var(--emboss-hi);
  --grain-opacity: 0.045;
  --grain-blend: multiply;`;

const DARK_TOKENS = `
  --surface: oklch(0.19 0.012 75);
  --surface-raised: oklch(0.23 0.013 75);
  --ink: oklch(0.93 0.009 85);
  --ink-muted: oklch(0.7 0.011 80);
  --ink-faint: oklch(0.64 0.011 80);
  --line: oklch(0.31 0.013 75);
  --accent: oklch(0.73 0.105 165);
  --positive: oklch(0.73 0.115 160);
  --negative: oklch(0.68 0.14 30);
  --ink-display: oklch(0.965 0.01 85);
  --annotation: oklch(0.66 0.012 80);
  --emboss-hi: oklch(100% 0 0 / 0.055);
  --emboss-lo: oklch(0% 0 0 / 0.4);
  --press-2:
    0 1px 2px var(--emboss-lo), 0 6px 18px -12px oklch(0% 0 0 / 0.55),
    inset 0 1px 0 var(--emboss-hi);
  --grain-opacity: 0.07;
  --grain-blend: overlay;`;

/** globals.css `.paper-grain`, verbatim: one feTurbulence tile under every app page. */
const GRAIN_TILE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23g)'/%3E%3C/svg%3E";

/**
 * The sizes are the type scale's clamps evaluated at the 1280px viewport: body 15px, lede 18px,
 * h3 19.84px, h2 28.8px, h1 41.12px, display 94.72px, display-2 40px, plus the fixed eyebrow
 * (11px) and micro (12px) steps and Tailwind's 13, 14 and 16px. Fractional sizes are kept
 * because they are what the baselines rasterise.
 */
const PAGE_CSS = `
  @font-face {
    font-family: "GeistSans"; src: url(data:font/woff2;base64,{{GEIST_SANS_WOFF2}}) format("woff2");
    font-display: swap; font-weight: 100 900;
  }
  @font-face {
    font-family: "GeistSans Fallback"; src: local(Arial);
    ascent-override: 94.56%; descent-override: 27.76%; line-gap-override: 0.0%; size-adjust: 106.28%;
  }
  @font-face {
    font-family: "GeistMono"; src: url(data:font/woff2;base64,{{GEIST_MONO_WOFF2}}) format("woff2");
    font-display: swap; font-weight: 100 900;
  }
  :root {
    --font-geist-sans: "GeistSans", "GeistSans Fallback";
    --font-geist-mono: "GeistMono", ui-monospace, SFMono-Regular, Roboto Mono, Menlo, Monaco,
      Liberation Mono, DejaVu Sans Mono, Courier New, monospace;
    --face-display: ui-serif, "New York", "Iowan Old Style", "Palatino Linotype",
      Palatino, "Times New Roman", Georgia, serif;
    --track-eyebrow: 0.16em;
  }
  *, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
  html, body { width: 1280px; height: 720px; overflow: hidden; line-height: 1.55; }
  body {
    font-family: var(--font-geist-sans), system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums lining-nums;
  }
  .panel {
    position: absolute; left: 0; width: 1280px; height: 360px; overflow: hidden;
    display: grid; grid-template-columns: 500px 376px 300px; gap: 24px; padding: 18px 28px;
    background-color: var(--surface); color: var(--ink);
  }
  .light { top: 0; ${LIGHT_TOKENS} }
  .dark { top: 360px; ${DARK_TOKENS} }
  .eyebrow {
    font-size: 11px; font-weight: 600; letter-spacing: var(--track-eyebrow);
    text-transform: uppercase; color: var(--ink-faint);
  }
  .display {
    font-family: var(--face-display); font-weight: 500; letter-spacing: -0.025em;
    color: var(--ink-display);
  }
  .hero { font-size: 94.72px; line-height: 0.9; margin-top: 6px; }
  .second { font-size: 40px; line-height: 1.05; margin-top: 10px; }
  .h1 { font-size: 41.12px; font-weight: 600; letter-spacing: -0.02em; margin-top: 8px; }
  .h2 { font-size: 28.8px; font-weight: 600; }
  .h3 { font-size: 19.84px; font-weight: 600; }
  .lede { font-size: 18px; color: var(--ink-muted); }
  .t16 { font-size: 16px; }
  .t15 { font-size: 15px; font-weight: 500; }
  .t14 { font-size: 14px; color: var(--ink-muted); }
  .t13 { font-size: 13px; font-weight: 700; }
  .t12 { font-size: 12px; color: var(--ink-faint); }
  .system { font-family: system-ui; font-size: 15px; }
  .pos { color: var(--positive); }
  .neg { color: var(--negative); }
  .card {
    background-color: var(--surface-raised); border: 1px solid var(--line); border-radius: 0.75rem;
    box-shadow: var(--press-2); padding: 10px 14px;
  }
  .figures {
    font-family: var(--font-geist-mono), ui-monospace, monospace;
    font-variant-numeric: tabular-nums lining-nums; letter-spacing: -0.01em;
  }
  .f16 { font-size: 16px; font-weight: 600; }
  .f14 { font-size: 14px; }
  .f12 { font-size: 12px; color: var(--ink-muted); }
  svg { display: block; overflow: visible; }
  .grid-line { stroke: var(--line); stroke-width: 1; }
  .tick { font-size: 11px; fill: var(--ink-muted); }
  .tick-x { font-size: 11px; fill: var(--annotation); }
  .trend {
    fill: none; stroke: var(--accent); stroke-width: 2;
    stroke-linejoin: round; stroke-linecap: round;
  }
  .area { fill: var(--accent); fill-opacity: 0.12; }
  .icons { display: flex; gap: 10px; align-items: center; margin-top: 8px; color: var(--ink-muted); }
  .icon {
    fill: none; stroke: currentColor; stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .grain {
    position: absolute; left: 28px; bottom: 14px; width: 200px; height: 44px;
    opacity: var(--grain-opacity); mix-blend-mode: var(--grain-blend);
    background-image: url("${GRAIN_TILE}"); background-size: 200px 200px;
  }`;

/** Stroked the way the app's icons are: a 24-unit box, width 2, round ends, at 14–20px. */
const ICONS = `
  <svg class="icon" width="16" height="16" viewBox="0 0 24 24">
    <path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>
  <svg class="icon" width="16" height="16" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>
  <svg class="icon" width="20" height="20" viewBox="0 0 24 24">
    <path d="M6 6l12 12M18 6L6 18"/></svg>
  <svg class="icon" width="14" height="14" viewBox="0 0 24 24">
    <path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

/** A chart the way the app's charts draw one: hairline grid, SVG tick text, a fractional line. */
const CHART = `
  <svg width="300" height="112" viewBox="0 0 300 112">
    <line class="grid-line" x1="40" x2="296" y1="20.5" y2="20.5"/>
    <line class="grid-line" x1="40" x2="296" y1="55.5" y2="55.5"/>
    <line class="grid-line" x1="40" x2="296" y1="90.5" y2="90.5"/>
    <text class="tick" x="34" y="24" text-anchor="end">$6.5k</text>
    <text class="tick" x="34" y="59" text-anchor="end">$3.25k</text>
    <text class="tick" x="34" y="94" text-anchor="end">$0</text>
    <text class="tick-x" x="66" y="108" text-anchor="middle">Jul '26</text>
    <text class="tick-x" x="158" y="108" text-anchor="middle">Aug 14</text>
    <text class="tick-x" x="250" y="108" text-anchor="middle">Sep 28</text>
    <path class="area" d="M40 84.6L66.2 79.3L92.4 81.8L118.7 66.4L144.9 70.2L171.1 52.7
      L197.3 58.9L223.6 41.5L249.8 45.1L276 30.8L276 90.5L40 90.5Z"/>
    <path class="trend" d="M40 84.6L66.2 79.3L92.4 81.8L118.7 66.4L144.9 70.2L171.1 52.7
      L197.3 58.9L223.6 41.5L249.8 45.1L276 30.8"/>
  </svg>`;

/** One panel per theme, identical markup, so the two differ only in ink and paper. */
function panel(theme: "light" | "dark"): string {
  return `
  <section class="panel ${theme}">
    <div>
      <p class="eyebrow">Net worth · ${theme} · 13 accounts</p>
      <p class="display hero">$1,234.56</p>
      <p class="display second">−$7,890.12 → ≈ 3.4 mo</p>
      <p class="h1">Cash flow ▲ 12%</p>
      <p class="h2">Spending — Groceries</p>
    </div>
    <div>
      <p class="h3">Recurring · every 7 days</p>
      <p class="lede">Levelled pay ≈ $4,321.09/mo</p>
      <p class="t16">Deposit → Checking · <span class="pos">+$1,234.50</span></p>
      <p class="t15">Market — Groceries · <span class="neg">−$86.40</span> ± 0.5%</p>
      <p class="t14">Sep 23, 2026 · 4 weeks ($5,678.90) ▲ 12% ▼ 3%</p>
      <p class="t13">10,987 rows… ← back · ⌘K · × close</p>
      <p class="t12">Every figure traces to a statement line · 0123456789</p>
      <p class="system">System UI · 0123456789 $ , . − → ≈ ·</p>
    </div>
    <div>
      <div class="card">
        <p class="figures f16">$120,345.67</p>
        <p class="figures f14">
          <span class="neg">−$695.04</span> <span class="pos">+$8,901.23</span></p>
        <p class="figures f12">0123456789 $,.−→≈· 42.0%</p>
      </div>
      ${CHART}
      <div class="icons">${ICONS}</div>
    </div>
    <div class="grain"></div>
  </section>`;
}

function canaryTemplate(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>renderer canary</title>
<style>${PAGE_CSS}
</style>
</head>
<body>${panel("light")}${panel("dark")}
</body>
</html>
`;
}
