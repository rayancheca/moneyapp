import { describe, expect, test } from "vitest";
import {
  VERDICT_PRESENTATION,
  verdictToneClass,
  type PresentedVerdict,
  type ProvenanceTone,
} from "./provenance-verdict";

const ALL = Object.keys(VERDICT_PRESENTATION) as PresentedVerdict[];

describe("VERDICT_PRESENTATION", () => {
  /**
   * The service's verdict union and this vocabulary have to stay in step: a
   * verdict with no presentation would render as a blank badge, which reads as
   * "fine" — the exact misreading this feature exists to prevent.
   */
  test("covers every verdict the service can return", () => {
    expect([...ALL].sort()).toEqual(
      ["broken", "derived", "manual", "market_value", "sourced", "unknown", "unverified"].sort(),
    );
  });

  test("every verdict has a word, a glyph and an accessible suffix", () => {
    for (const v of ALL) {
      const p = VERDICT_PRESENTATION[v];
      expect(p.word.length).toBeGreaterThan(0);
      expect(p.icon.length).toBeGreaterThan(0);
      expect(p.ariaSuffix.length).toBeGreaterThan(0);
    }
  });

  /**
   * ⛔ market_value and manual are neither good nor bad. Toning them "weak"
   * would cry wolf on two thirds of a portfolio; toning them "proven" would
   * claim an arithmetic check that does not exist for either.
   */
  test("the two neutral verdicts are toned neither proven nor weak", () => {
    expect(VERDICT_PRESENTATION.market_value.tone).toBe("neutral");
    expect(VERDICT_PRESENTATION.manual.tone).toBe("neutral");
  });

  test("only the two proven verdicts read as proven", () => {
    const proven = ALL.filter((v) => VERDICT_PRESENTATION[v].tone === "proven");
    expect([...proven].sort()).toEqual(["derived", "sourced"]);
  });

  test("a figure that does not add up is the loudest thing on the page", () => {
    expect(VERDICT_PRESENTATION.broken.tone).toBe("broken");
    expect(VERDICT_PRESENTATION.broken.word).toMatch(/does not add up/);
  });

  /** The words go inside a sentence, so a capital letter would read as a shout. */
  test("every word is lower case and short enough to sit in a badge", () => {
    for (const v of ALL) {
      const { word } = VERDICT_PRESENTATION[v];
      expect(word).toBe(word.toLowerCase());
      expect(word.length).toBeLessThanOrEqual(18);
    }
  });
});

describe("verdictToneClass", () => {
  test("each tone maps to exactly one class, and they are all distinct", () => {
    const tones: ProvenanceTone[] = ["proven", "neutral", "weak", "broken"];
    const classes = tones.map(verdictToneClass);
    expect(new Set(classes).size).toBe(tones.length);
    for (const c of classes) expect(c).toMatch(/^text-/);
  });
});
