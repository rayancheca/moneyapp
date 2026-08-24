import { describe, expect, test } from "vitest";
import * as jargon from "./jargon";
import { BUDGET_JARGON, CATEGORY_KIND_JARGON, RESERVED_JARGON_PHRASES } from "./jargon";
import { RESERVED_NOTE_PHRASES } from "./section-notes";

/**
 * Every authored definition in the module, discovered REFLECTIVELY rather than
 * listed.
 *
 * Listing the maps by hand is how a guard becomes decoration: the sweep below is
 * the only thing standing between a new tooltip and a red assertion three specs
 * away, and a fourth map added without touching this file would sail past it. A
 * jargon map is the module's only export shaped as a plain object of strings —
 * `RESERVED_JARGON_PHRASES` is an array and is skipped by that same shape test.
 */
const definitions = Object.entries(jargon).flatMap(([exportName, value]) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === "string")
    ? Object.entries(value as Record<string, string>).map(
        ([key, body]) => [`${exportName}.${key}`, body] as const,
      )
    : [],
);

describe("jargon copy", () => {
  test("the reflective sweep actually finds every map, and nothing else", () => {
    // If this drops to the size of one map, the sweep silently stopped guarding
    // the other — the failure mode the reflection exists to prevent.
    expect(definitions.length).toBe(
      Object.keys(CATEGORY_KIND_JARGON).length + Object.keys(BUDGET_JARGON).length,
    );
    expect(definitions.some(([name]) => name.startsWith("CATEGORY_KIND_JARGON."))).toBe(true);
    expect(definitions.some(([name]) => name.startsWith("BUDGET_JARGON."))).toBe(true);
  });

  test("covers every category kind the manager groups by", () => {
    // KIND_ORDER's members, which is what CategoryManager renders a heading for.
    // A missing entry silently drops the tip rather than failing the render.
    expect(Object.keys(CATEGORY_KIND_JARGON).sort()).toEqual(
      ["expense", "income", "investment", "rewards", "system", "transfer"].sort(),
    );
  });

  test("covers every term /budgets mounts a tip on", () => {
    // Same failure as above: BudgetsPage reads these by key, and a missing one
    // renders nothing at all rather than erroring.
    expect(Object.keys(BUDGET_JARGON).sort()).toEqual(
      [
        // one per basis `incomeBasis` can select — exactly one renders
        "expectedIncomeLevelled",
        "expectedIncomeBanked",
        "expectedIncomeCalendar",
        "leftToAllocate",
        "totalBudgeted",
        // one per state `budgetVerdict` can return — a missing key is a row that
        // renders a headline with nothing behind it
        "paceUnder",
        "paceAtRisk",
        "paceOver",
        "paceWithheld",
      ].sort(),
    );
  });

  test("no definition repeats a phrase the surrounding UI owns", () => {
    /**
     * The failure this prevents is remote and silent: a tooltip body is live DOM
     * text even while closed, and Playwright's text engine ignores visibility.
     * Repeating a graded phrase turns a page-level exact-count assertion red in
     * a spec that has nothing to do with tooltips.
     */
    for (const [name, body] of definitions) {
      for (const phrase of RESERVED_JARGON_PHRASES) {
        expect(body, `${name} must not contain "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  test("the reserved list has no duplicates", () => {
    // A repeated entry is harmless to the sweep and a reliable sign the list was
    // appended to without being read — which is exactly how a phrase gets banned
    // twice and a different one not at all.
    expect([...new Set(RESERVED_JARGON_PHRASES)]).toHaveLength(RESERVED_JARGON_PHRASES.length);
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
    for (const [name, body] of definitions) {
      expect(body, `${name} must not contain a digit`).not.toMatch(/\d/u);
      expect(body, `${name} must not contain a currency symbol`).not.toMatch(/[$€£]/u);
    }
  });

  test("every definition is one sentence of real prose", () => {
    for (const [name, body] of definitions) {
      expect(body.trim().length, name).toBeGreaterThan(40);
      expect(body.trim().endsWith("."), `${name} should end in a period`).toBe(true);
    }
  });
});
