import { describe, expect, test } from "vitest";
import { buildCanarySource, readShippedFonts } from "./canary";

/**
 * The browser half of the canary is proven by rendering it (5 renders across 3 launches, one
 * pixel hash); these pin the half that decides whether two renders are comparable at all.
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
   * A Geist upgrade moves every baseline with text, so it must read as "the canary changed"
   * rather than being compared against pixels drawn from the old font.
   */
  test("one changed byte in either font changes the source hash", () => {
    const base = buildCanarySource(fonts).sourceSha256;
    for (const key of ["sans", "mono"] as const) {
      const changed = Buffer.from(fonts[key]);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
      expect(buildCanarySource({ ...fonts, [key]: changed }).sourceSha256).not.toBe(base);
    }
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
