import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * THE SHRINK GATE for the dashboard.
 *
 * A grid item's automatic minimum size is its min-content size, so a track will
 * happily size itself to the widest merchant name in the ledger and push the
 * whole document sideways — measured here at +95px on a 375px window and +30px
 * at 440px, from a single 454px track inside a 343px page. It is invisible on
 * seed data (short names) and only appears on the owner's real transactions,
 * which is exactly why it needs a gate rather than an eye.
 *
 * The cure is one token, `*:min-w-0`, and the failure repeats: it is the same
 * shape as `truncate` needing `min-w-0`, and the same shape as the four other
 * containers this pass found elsewhere in the app. So every grid on this page
 * must say out loud that its tracks are allowed to shrink.
 */

const source = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");

/** Every literal className on the page — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

describe("the dashboard's tracks can shrink", () => {
  test("there are grids here to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(classNames(source).filter(isGrid).length).toBeGreaterThanOrEqual(2);
  });

  test("every grid zeroes its items' automatic minimum size", () => {
    for (const cls of classNames(source).filter(isGrid)) {
      expect(
        cls.includes("*:min-w-0"),
        `grid without a shrink guard — add \`*:min-w-0\`, or the widest cell ` +
          `sets the track width and the page scrolls sideways on a phone:\n  ${cls}`,
      ).toBe(true);
    }
  });

  test("the activity hub still composes 1.5fr against 1fr above lg", () => {
    // the fix must not have been "delete the two-column layout"
    const activity = classNames(source).find((c) => c.includes("lg:grid-cols-[1.5fr_1fr]"));
    expect(activity).toBeDefined();
    expect(activity).toContain("*:min-w-0");
  });
});
