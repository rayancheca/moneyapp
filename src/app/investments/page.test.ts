import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * THE SHRINK GATE for /investments — the same gate src/app/page.test.ts puts on
 * the dashboard, because this page had the same bug and it was the worst of it.
 *
 * A grid item's automatic minimum size is its MIN-CONTENT size, so a track will
 * size itself to the widest thing inside it and push the whole document
 * sideways. Below `lg` this page's holdings/allocation grid collapses to one
 * implicit column, and that column sized itself to the six-column holdings
 * table. Measured on the running app: +337px at 320, +282 at 375, +217 at 440
 * (his phone), +121 at 768 — the worst horizontal overflow in the app. The
 * portfolio was literally unreadable without panning sideways.
 *
 * The cure is one token, `*:min-w-0`, and it is not decoration: it hands the
 * scrolling back to the table's OWN overflow-x-auto, where a wide financial
 * table legitimately scrolls. A wide table that scrolls inside its card is
 * fine; a PAGE that scrolls is not.
 *
 * This is a source gate rather than a rendered one on purpose — jsdom has no
 * layout engine, so it cannot measure an overflow, and the page is an async
 * server component that reads the database. The real measurement is a browser.
 * What a gate can do cheaply is make sure nobody quietly drops the token.
 */

const source = fs.readFileSync(path.join(process.cwd(), "src/app/investments/page.tsx"), "utf8");

/** Every literal className on the page — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

describe("the investments page's tracks can shrink", () => {
  test("there are grids here to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(classNames(source).filter(isGrid).length).toBeGreaterThanOrEqual(1);
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

  test("the holdings/allocation grid still composes a 280px companion rail above lg", () => {
    // the fix must not have been "delete the two-column layout"
    const holdings = classNames(source).find((c) => c.includes("lg:grid-cols-[minmax(0,1fr)_280px]"));
    expect(holdings).toBeDefined();
    expect(holdings).toContain("*:min-w-0");
  });
});
