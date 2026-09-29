import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type {
  Browser,
  BrowserContextOptions,
  LaunchOptions,
  Page,
  PageScreenshotOptions,
} from "@playwright/test";

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
 * WHAT IT DRAWS: every face the baselines' text is drawn with, the way the app draws it, in both
 * themes. Measured 2026-09-29 (macOS 27.2, Playwright 1.61.1's headless shell) with faces.ts,
 * which asks CDP's CSS.getPlatformFontsForNode, over every text node of the 24 pages
 * e2e/visual.spec.ts photographs, light and dark at 1440 and light at 320: 16 faces, each of which
 * this page draws too. canary.test.ts holds it to that list (APP_FACES), and to every line of text
 * lying inside its panel, where the screenshot sees it.
 *   - Geist and Geist Mono, from the exact woff2 files the app ships, declared the way
 *     next/font's build output declares them, at the weights the app uses (Geist 400 to 700, Mono
 *     400, 500 and 600). That includes the size-adjusted local Arial face next/font generates,
 *     which draws nothing today.
 *   - Geist slanted by Chromium: the variable font has no italic, so an uncategorized
 *     CategoryChip and an <em> are obliqued by the renderer itself, a path of its own.
 *   - The wordmark on every page (AppShell.tsx): the display serif stack, copied verbatim,
 *     semibold and uppercase, with an italic <em>. Headless Chromium resolves neither `ui-serif`
 *     nor "New York", so it lands on Iowan Old Style Bold and Bold Italic. The same stack at 500
 *     draws Iowan Old Style Roman, and its missing → Times New Roman: no baselined page draws those
 *     two today; they stay, since a display figure would. All are macOS system fonts: an OS update
 *     can change the fonts themselves, not only how they are rasterised.
 *   - The symbols Geist lacks, as the app prints them, which macOS draws from its own fonts:
 *     ⌘ and the calendar's ✓ from SF, its ✕ from Zapf Dingbats, the holdings table's ⇄ from
 *     Hiragino Sans.
 *   - The type scale's sizes and weights at the 1280px Desktop Chrome viewport, fractional sizes
 *     included, from the smallest 7px label to the 48px figures, with tabular digits and the
 *     symbols the app prints ($ , . − → ≈ · and friends).
 *   - Ink on paper and paper on ink. Glyph masks are built per text luminance, so light-on-dark
 *     text takes a different path from dark-on-light and one theme alone would miss half of it.
 *   - SVG <text> the way charts draw it (ticks in Geist, flow labels in Geist Medium, deltas in
 *     Geist Mono), stroked icon and chart paths, a card's rounded edge and shadow, and the paper
 *     grain every page sits on.
 *
 * FROZEN ON PURPOSE. The tokens, font stacks and sizes are COPIED from src/app/globals.css and
 * next/font's generated CSS, never read from them. A canary that imported the app's styles
 * would move with every design change and report it as a renderer change, which is the one
 * confusion this file exists to remove. The figures are glyph coverage, not ledger data. Any
 * edit here changes sourceSha256, because the hash covers this file's own text: the page, and
 * the code that launches its browser, loads its faces and captures it, which decide the pixels as
 * much as the page does. The gate then says "canary-changed" until the canary is recorded again,
 * rather than "renderer-changed" and a system font blamed for an edit. A Geist upgrade changes
 * fontSha256 as well, and the gate says "fonts-changed": the app's own change, whose baselines
 * are redrawn with it (fingerprint.ts).
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
 * How the canary's browser is launched: the launch the test runner makes for the baselines, with
 * no channel and no flag, so the headless shell. Declared here, and made here (measureCanary),
 * so that the hash of this file covers it: a flag added to the launch moves pixels too.
 */
export const CANARY_LAUNCH = {} as const satisfies LaunchOptions;

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
  fontSha256: string;
}

export interface CanaryRender {
  /** sha256 of the decoded RGBA pixels: a PNG encoder or metadata change cannot move it */
  pixelSha256: string;
  /**
   * sha256 of everything that decides the canary's pixels but the machine: canary.ts's own code
   * (its launch, font wait and capture), its context, its page and the font bytes
   */
  sourceSha256: string;
  /**
   * sha256 of the Geist files alone. The app ships the same files, so this moving is the app's
   * change, not the canary's or the renderer's (compareRecord's "fonts-changed").
   */
  fontSha256: string;
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

/**
 * This file's own text: the page and everything that draws it. The launch, the font wait and the
 * capture decide the pixels as much as the page does, so an edit to any of them must read as
 * "canary-changed" rather than as the renderer moving; the hash takes the text whole, comments
 * included, because no narrower rule can be trusted to find every line that reaches a pixel.
 */
export function canaryCode(): string {
  return fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
}

export function buildCanarySource(fonts: CanaryFonts, code: string = canaryCode()): CanarySource {
  const template = canaryTemplate();
  const html = template
    .replace("{{GEIST_SANS_WOFF2}}", fonts.sans.toString("base64"))
    .replace("{{GEIST_MONO_WOFF2}}", fonts.mono.toString("base64"));
  const sourceSha256 = sha256OfParts([
    code,
    JSON.stringify(CANARY_CONTEXT),
    JSON.stringify(CANARY_SCREENSHOT),
    JSON.stringify(CANARY_LAUNCH),
    template,
    fonts.sans,
    fonts.mono,
  ]);
  return { html, sourceSha256, fontSha256: sha256OfParts([fonts.sans, fonts.mono]) };
}

export interface OpenCanary {
  page: Page;
  source: CanarySource;
  close(): Promise<void>;
}

/** The canary page in its own context, every embedded face loaded: what renderCanary shoots. */
export async function openCanary(browser: Browser): Promise<OpenCanary> {
  const source = buildCanarySource(readShippedFonts());
  const context = await browser.newContext(CANARY_CONTEXT);
  try {
    const page = await context.newPage();
    await page.setContent(source.html, { waitUntil: "load" });
    await waitForCanaryFonts(page);
    return { page, source, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function renderCanary(browser: Browser): Promise<CanaryRender> {
  const { page, source, close } = await openCanary(browser);
  try {
    const png = await settledScreenshot(page);
    // Raw RGBA, not the PNG bytes: the question is what was drawn, not how it was encoded.
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      pixelSha256: crypto.createHash("sha256").update(data).digest("hex"),
      sourceSha256: source.sourceSha256,
      fontSha256: source.fontSha256,
      width: info.width,
      height: info.height,
      png,
    };
  } finally {
    await close();
  }
}

/**
 * The canary in a browser of its own, launched as CANARY_LAUNCH says: what the gate and the
 * re-base command measure. Playwright is loaded here rather than at the top, so that reading the
 * canary's source or hashes, which is all most tests do, never loads a browser driver.
 */
export async function measureCanary(): Promise<CanaryRender> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch(CANARY_LAUNCH);
  try {
    return await renderCanary(browser);
  } finally {
    await browser.close();
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
  --accent-ink: oklch(0.38 0.075 165);
  --surface-sunken: oklch(0.955 0.006 85);
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
  --accent-ink: oklch(0.8 0.1 165);
  --surface-sunken: oklch(0.165 0.011 75);
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
 * h3 19.84px (the wordmark's too), h2 28.8px, h1 41.12px, display 94.72px, display-2 40px, plus
 * the fixed eyebrow (11px) and micro (12px) steps, Tailwind's 13, 14, 16 and 48px, and the 7, 8
 * and 9px the smallest labels use. Fractional sizes are kept because they are what the baselines
 * rasterise. The grain sits under the second column, clear of every line of text.
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
  .wordmark {
    font-family: var(--face-display); font-size: 19.84px; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-display);
  }
  .wordmark em { letter-spacing: 0.02em; color: var(--accent-ink); }
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
  .chip {
    display: inline-flex; align-items: center; padding: 2px 8px; border: 1px solid var(--line);
    border-radius: 9999px; background-color: var(--surface-sunken); font-size: 12px;
    font-style: italic; color: var(--ink-faint);
  }
  .legend { font-size: 11px; color: var(--ink-faint); }
  .mark { font-size: 12px; font-weight: 700; line-height: 1; color: var(--ink-muted); }
  .mark9 { font-size: 9px; font-weight: 700; line-height: 1; color: var(--positive); }
  .cycle { font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; }
  .t9 { font-size: 9px; color: var(--ink-muted); }
  .t8 { font-size: 8px; color: var(--ink-muted); }
  .t7 { font-size: 7px; font-weight: 600; }
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
  .f15 { font-size: 15px; font-weight: 500; }
  .f48 { font-size: 48px; font-weight: 600; line-height: 1; margin-top: 6px; }
  svg { display: block; overflow: visible; }
  .grid-line { stroke: var(--line); stroke-width: 1; }
  .tick { font-size: 11px; fill: var(--ink-muted); }
  .tick-x { font-size: 11px; fill: var(--annotation); }
  .node { font-size: 10px; font-weight: 500; fill: var(--ink); }
  .delta {
    font-family: var(--font-geist-mono), ui-monospace, monospace; font-size: 9px;
    fill: var(--ink-muted);
  }
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
    position: absolute; left: 552px; bottom: 14px; width: 200px; height: 44px;
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
    <text class="node" x="44" y="12">Chase Total Checking</text>
    <text class="delta" x="296" y="12" text-anchor="end">+$82.03 · +104%</text>
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
      <p class="wordmark">Money<em>App</em></p>
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
      <p class="t12"><span class="chip">Uncategorized</span> the money is <em>checked</em>,
        not filed</p>
      <p class="legend"><span class="mark">✓</span> Paid <span class="mark">✕</span> Missed
        <span class="mark">?</span> Not yet known <span class="mark9">✓ ✕ ! •</span>
        <span class="cycle">Day % ⇄</span></p>
      <p><span class="t9">Skip to content · Accounts</span> <span class="figures t8">07 08 · excl.
        360</span> <span class="t7">CO CH DI</span></p>
      <p class="system">System UI · 0123456789 $ , . − → ≈ ·</p>
    </div>
    <div>
      <div class="card">
        <p class="figures f16">$120,345.67</p>
        <p class="figures f14">
          <span class="neg">−$695.04</span> <span class="pos">+$8,901.23</span></p>
        <p class="figures f12">0123456789 $,.−→≈· 42.0%</p>
        <p class="figures f15">$145,269.81 · (+24.6%)</p>
      </div>
      ${CHART}
      <div class="icons">${ICONS}</div>
      <p class="figures f48">$1,317.38</p>
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
