import { describe, expect, test } from "vitest";
import { CATEGORY_KIND_JARGON, RESERVED_JARGON_PHRASES } from "./jargon";
import { RESERVED_NOTE_PHRASES } from "./section-notes";

const definitions = Object.entries(CATEGORY_KIND_JARGON);

describe("jargon copy", () => {
  test("covers every category kind the manager groups by", () => {
    // KIND_ORDER's members, which is what CategoryManager renders a heading for.
    // A missing entry silently drops the tip rather than failing the render.
    expect(Object.keys(CATEGORY_KIND_JARGON).sort()).toEqual(
      ["expense", "income", "investment", "rewards", "system", "transfer"].sort(),
    );
  });

  test("no definition repeats a phrase the surrounding UI owns", () => {
    /**
     * The failure this prevents is remote and silent: a tooltip body is live DOM
     * text even while closed, and Playwright's text engine ignores visibility.
     * Repeating a graded phrase turns a page-level exact-count assertion red in
     * a spec that has nothing to do with tooltips.
     */
    for (const [kind, body] of definitions) {
      for (const phrase of RESERVED_JARGON_PHRASES) {
        expect(body, `${kind} must not contain "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  test("the section-note reserved list is a subset, so the two cannot drift apart", () => {
    // Both kinds of authored copy render on the same pages. A phrase banned for
    // one is banned for the other; keeping one list a superset makes that structural
    // rather than a thing to remember.
    for (const phrase of RESERVED_NOTE_PHRASES) {
      expect(RESERVED_JARGON_PHRASES).toContain(phrase);
    }
  });

  test("no definition states a figure", () => {
    // A number here is one nobody measured, and it collides with the single-match
    // locators that read the real ones.
    for (const [kind, body] of definitions) {
      expect(body, `${kind} must not contain a digit`).not.toMatch(/\d/u);
      expect(body, `${kind} must not contain a currency symbol`).not.toMatch(/[$€£]/u);
    }
  });

  test("every definition is one sentence of real prose", () => {
    for (const [kind, body] of definitions) {
      expect(body.trim().length, kind).toBeGreaterThan(40);
      expect(body.trim().endsWith("."), `${kind} should end in a period`).toBe(true);
    }
  });
});
