import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * THE SHRINK GATE for /spending — the same gate src/app/page.test.ts puts on the
 * dashboard and src/app/investments/page.test.ts puts on the portfolio.
 *
 * A grid item's automatic minimum size is its MIN-CONTENT size, so below `lg`,
 * where each of this page's grids collapses to one implicit column, the column
 * sized itself to its widest card and pushed the document sideways. Measured on
 * the running app: +155px at 320, +100 at 375, +35 at 440 (his phone).
 *
 * The cure is one token, `*:min-w-0`. It keeps any horizontal scrolling INSIDE
 * the card that owns a scroller, which is the distinction that matters: a wide
 * table scrolling in its own container is fine, a PAGE scrolling is not.
 *
 * Source gate rather than a rendered one on purpose — jsdom has no layout
 * engine and cannot measure an overflow, and the page is an async server
 * component that reads the database. A browser does the measuring; this just
 * makes sure nobody quietly drops the token.
 */

const source = fs.readFileSync(path.join(process.cwd(), "src/app/spending/page.tsx"), "utf8");

/** Every literal className on the page — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

/**
 * 🔴 ONE POPULATION for "Where it went". The List, the relief and the Table each
 * mapped `breakdown` — THIS period's categories — and looked a prior figure up
 * beside it, while "What moved" read the union of both windows. Measured on the
 * owner's ledger 2026-09-15, `?period=2026-07`: What moved counted 15 categories
 * and named Government's -$2,250.00 the largest move; the card below it had 12
 * rows and a relief reading "+$588.75 against June 2026" over a change of
 * -$2,057.14. `comparedCategories` reads What moved's rule; this gate keeps the
 * page from growing a second mapping beside it. Source, not render: the page is
 * an async server component that reads the database.
 */
describe("Where it went is cut from the comparison's one population", () => {
  test("the relief, the Table and the List all read comparedCategories", () => {
    expect(source).toContain('import { comparedCategories } from "@/lib/compared-categories";');
    expect(source).toMatch(/const compared = comparedCategories\(breakdown, prevBreakdown\);/);
    expect(source).toMatch(/const whereRows: WhereItWentRow\[\] = compared\.map\(/);
    expect(source).toMatch(/const spentRows: CategoryTableRow\[\] = \(listCompares \? compared : .+\)\.map\(/);
  });

  /*
   * 🔴 The List's change column is `hidden md:block`, so on a phone a category
   * that stopped read "0.0% $0.00" with no sign it fell (`SpendingCategoriesTable`
   * prints it on a line of its own there, naming the window). The List and the
   * relief name ONE prior window, asked once.
   */
  test("the List is told which window its change measured — the one the relief and the Table name", () => {
    expect(source).toMatch(/const wholePriorLabel = comparison\.kind === "whole" \? comparison\.prior\.label : null;/);
    expect(source).toMatch(/<SpendingCategoriesTable[^>]*\bpriorLabel=\{wholePriorLabel\}/);
    expect(source).toMatch(/<WhereItWentPanel[^>]*\bpriorLabel=\{wholePriorLabel\}/);
  });

  test("no lens looks a prior figure up for this period's categories on its own", () => {
    expect(source).not.toContain("prevById");
    expect(source).not.toMatch(/breakdown\s*\.filter\(\(r\) => r\.categoryId !== null\)\s*\.map\(/);
  });
});

describe("the spending page's tracks can shrink", () => {
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

  test("the heatmap/merchants split still composes 3:2 above lg", () => {
    // the fix must not have been "delete the asymmetric layout"
    const split = classNames(source).find((c) => c.includes("lg:grid-cols-5"));
    expect(split).toBeDefined();
    expect(split).toContain("*:min-w-0");
    expect(source).toContain("lg:col-span-3");
    expect(source).toContain("lg:col-span-2");
  });
});
