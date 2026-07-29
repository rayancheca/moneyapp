import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * THE SHRINK GATE for the "Where it went" relief.
 *
 * Same failure shape as `src/app/page.test.ts`, one layer down and measured on
 * the running app: a grid item's automatic minimum size is its min-content
 * size, and the relief's stage holds an `<svg width={DEFAULT_WIDTH}>` (720px)
 * until the ResizeObserver has measured. Below `lg` the grid falls back to a
 * single implicit `auto` track, so that 720 — plus the stage's 1px borders —
 * became the track's floor: `/spending?where=relief` scrolled the DOCUMENT
 * sideways by +323px at a 440px window and +227px at 768.
 *
 * `overflow-hidden` on the stage clips the drawing, but it only zeroes the
 * automatic minimum of a FLEX/GRID item — the stage is a block child, so its
 * min-content still propagates. The guard therefore belongs on the track.
 *
 * Above `lg` the explicit `minmax(0,1fr)` already did this, which is exactly
 * why the bug was invisible at every width the visual suite screenshots.
 */

const SOURCE = path.join(process.cwd(), "src/components/charts/CategoryMassif.tsx");
const source = fs.readFileSync(SOURCE, "utf8");

/** Every literal className in the file — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

describe("the relief's tracks can shrink", () => {
  test("there is a grid here to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(classNames(source).filter(isGrid).length).toBeGreaterThanOrEqual(1);
  });

  test("every grid zeroes its items' automatic minimum size", () => {
    for (const cls of classNames(source).filter(isGrid)) {
      expect(
        cls.includes("*:min-w-0"),
        "grid without a shrink guard — add `*:min-w-0`. Without it the stage's " +
          "720px <svg> sets the track width and /spending?where=relief scrolls " +
          `sideways on a phone:\n  ${cls}`,
      ).toBe(true);
    }
  });

  test("the two-column composition above lg survived the fix", () => {
    // the cure must not have been "delete the rail beside the plate"
    const stage = classNames(source).find((c) => c.includes("lg:grid-cols-[minmax(0,1fr)_19rem]"));
    expect(stage).toBeDefined();
    expect(stage).toContain("*:min-w-0");
  });

  test("the stage still clips the pre-measurement drawing", () => {
    // min-w-0 lets the TRACK shrink; overflow-hidden is what stops the 720px
    // first-paint svg from painting outside the card. Both are required.
    const stage = classNames(source).find((c) => c.includes("h-[17rem]"));
    expect(stage).toBeDefined();
    expect(stage).toContain("overflow-hidden");
  });
});
