import fs from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildCanarySource,
  CANARY_LAUNCH,
  canaryCode,
  openCanary,
  readShippedFonts,
} from "./canary";
import { faceName, facesDrawn } from "./faces";

/**
 * Every face the app's baselined pages draw text with, named by faceName. Measured 2026-09-29
 * (macOS 27.2, Playwright 1.61.1's headless shell) with facesDrawn's method over every text node
 * of the 24 pages e2e/visual.spec.ts photographs (its 19 routes, and the category, holding,
 * account, series and merchant pages), light and dark at 1440 and light at 320: 72 page loads.
 *
 * Where each comes from, when it is not plain Geist: the wordmark on every page (AppShell.tsx)
 * is Iowan Old Style Bold, its <em> Bold Italic; an uncategorized CategoryChip and the imports
 * pages' <em> are Geist slanted by Chromium, which ships no italic; the holdings table's ⇄ falls
 * back to Hiragino Sans, the calendar's ✕ to Zapf Dingbats and its ✓ to SF; figures are Geist
 * Mono at 400, 500 and 600, and chart labels are SVG text in Geist and Geist Mono.
 */
const APP_FACES = [
  ".SFNS-Bold",
  "Geist-Bold",
  "Geist-Medium",
  "Geist-Medium in SVG",
  "Geist-Regular",
  "Geist-Regular in SVG",
  "Geist-Regular oblique",
  "Geist-SemiBold",
  "GeistMono-Medium",
  "GeistMono-Regular",
  "GeistMono-Regular in SVG",
  "GeistMono-SemiBold",
  "HiraginoSans-W4",
  "IowanOldStyle-Bold",
  "IowanOldStyle-BoldItalic",
  "ZapfDingbatsITC",
];

describe("faceName", () => {
  test("a face slanted by Chromium, and SVG text, are named as drawn differently", () => {
    expect(faceName("Geist-Regular", "normal", false)).toBe("Geist-Regular");
    expect(faceName("Geist-Regular", "italic", false)).toBe("Geist-Regular oblique");
    expect(faceName("IowanOldStyle-BoldItalic", "italic", false)).toBe("IowanOldStyle-BoldItalic");
    expect(faceName("GeistMono-Regular", "normal", true)).toBe("GeistMono-Regular in SVG");
  });
});

/**
 * The canary is only evidence for the faces it draws: a macOS revision of one it lacks, or a
 * Chromium roll that changes one path, moves baselines while the gate reads "match". Rendered
 * for real, so macOS only: these are its system fonts.
 */
const onMacOS = describe.runIf(process.platform === "darwin");

onMacOS("the faces the canary draws", { timeout: 60_000 }, () => {
  let browser: Browser | undefined;
  beforeAll(async () => {
    browser = await chromium.launch(CANARY_LAUNCH);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });
  const open = () => {
    if (browser === undefined) throw new Error("no browser was launched");
    return openCanary(browser);
  };

  test("every face the app's baselined pages draw text with", async () => {
    const canary = await open();
    try {
      const drawn = await facesDrawn(canary.page);
      const missing = APP_FACES.filter((face) => !drawn.includes(face));
      expect(missing, `the canary draws: ${drawn.join(", ")}`).toEqual([]);
    } finally {
      await canary.close();
    }
  });

  /**
   * CDP names a face for text a panel clips as readily as for text it paints, so a specimen
   * pushed out of its panel would pass the test above while the screenshot never saw it.
   */
  test("every line of text lies inside its panel, where the screenshot sees it", async () => {
    const canary = await open();
    try {
      const outside = await canary.page.evaluate(() =>
        [...document.querySelectorAll("body *")].flatMap((el) => {
          const own = [...el.childNodes].some(
            (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
          );
          const panel = el.closest(".panel");
          if (!own || panel === null) return own ? [`${el.tagName} outside any panel`] : [];
          const r = el.getBoundingClientRect();
          const p = panel.getBoundingClientRect();
          const inside =
            r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom;
          return inside ? [] : [`${el.tagName}.${el.getAttribute("class")}: ${el.textContent}`];
        }),
      );
      expect(outside).toEqual([]);
    } finally {
      await canary.close();
    }
  });
});

/**
 * That the canary draws the same pixels every time is proven by rendering it (2026-09-29: 6
 * renders across 3 launches, one pixel hash); these pin the half that decides whether two renders
 * are comparable at all.
 */
describe("buildCanarySource", () => {
  const fonts = readShippedFonts();

  test("the fonts are the woff2 files next/font ships", () => {
    expect(fonts.sans.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(fonts.mono.subarray(0, 4).toString("latin1")).toBe("wOF2");
  });

  test("the same inputs build the same page and the same source hash", () => {
    const a = buildCanarySource(fonts);
    const b = buildCanarySource({ sans: Buffer.from(fonts.sans), mono: Buffer.from(fonts.mono) });
    expect(b).toEqual(a);
    expect(a.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * A Geist upgrade moves every baseline with text, so it must never be compared against pixels
   * drawn from the old font.
   */
  test("one changed byte in either font changes the source hash", () => {
    const base = buildCanarySource(fonts).sourceSha256;
    for (const key of ["sans", "mono"] as const) {
      const changed = Buffer.from(fonts[key]);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
      expect(buildCanarySource({ ...fonts, [key]: changed }).sourceSha256).not.toBe(base);
    }
  });

  /**
   * The fonts are hashed on their own as well, so the gate can tell a Geist upgrade (the app's
   * change, which moves baselines) from an edit to the canary page (which moves none).
   */
  test("the Geist files have a hash of their own, which one changed byte moves", () => {
    const base = buildCanarySource(fonts);
    expect(base.fontSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(base.fontSha256).not.toBe(base.sourceSha256);
    for (const key of ["sans", "mono"] as const) {
      const changed = Buffer.from(fonts[key]);
      changed[0] = changed[0]! ^ 0xff;
      expect(buildCanarySource({ ...fonts, [key]: changed }).fontSha256).not.toBe(base.fontSha256);
    }
    expect(buildCanarySource({ sans: fonts.mono, mono: fonts.sans }).fontSha256).not.toBe(
      base.fontSha256,
    );
  });

  /**
   * The code that launches, loads the faces and captures decides the pixels as much as the page
   * does. Left out of the hash, an edit there moves the pixels under an unchanged source, and the
   * gate says "renderer-changed" and blames a system font or a driver for it.
   */
  test("an edit to the canary's code, not only its page, changes the source hash", () => {
    const base = buildCanarySource(fonts);
    const edited = buildCanarySource(fonts, `${canaryCode()}\n// one more line`);
    expect(edited.sourceSha256).not.toBe(base.sourceSha256);
    expect(edited.fontSha256).toBe(base.fontSha256);
    expect(edited.html).toBe(base.html);
  });

  test("the code hashed is canary.ts itself: the launch, the font wait, the capture", () => {
    const code = canaryCode();
    expect(code).toBe(fs.readFileSync("scripts/e2e-renderer/canary.ts", "utf8"));
    expect(code).toContain("async function waitForCanaryFonts(");
    expect(code).toContain("async function settledScreenshot(");
    expect(code).toMatch(/chromium\.launch\(CANARY_LAUNCH\)/);
  });

  test("fingerprint.ts launches no browser of its own: every canary launch is hashed", () => {
    const fingerprint = fs.readFileSync("scripts/e2e-renderer/fingerprint.ts", "utf8");
    expect(fingerprint).not.toMatch(/\.launch\(/);
  });

  /** The same two files in each other's faces are a different page, so a different source. */
  test("swapping the two fonts changes the source hash", () => {
    const base = buildCanarySource(fonts).sourceSha256;
    expect(buildCanarySource({ sans: fonts.mono, mono: fonts.sans }).sourceSha256).not.toBe(base);
  });

  test("the page embeds both fonts and needs nothing from outside it", () => {
    const { html } = buildCanarySource(fonts);
    expect(html).toContain(`data:font/woff2;base64,${fonts.sans.toString("base64")}`);
    expect(html).toContain(`data:font/woff2;base64,${fonts.mono.toString("base64")}`);
    expect(html).not.toContain("{{");
    expect(html).not.toMatch(/<(link|script)\b/);
    expect(html).not.toMatch(/url\(\s*["']?https?:/);
  });
});
