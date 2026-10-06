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
    expect(source).toContain('import { whereItWentRows } from "@/lib/where-it-went-rows";');
    expect(source).toMatch(/const \{ list: categoryRows, where: whereRows \} = whereItWentRows\(compared, \{/);
  });

  /*
   * 🔴 The rows themselves are tested in `lib/where-it-went-rows.test.ts`; this
   * gate keeps the page from cutting them again on the way in. A one-line filter
   * of the List's rows back to this period's categories off months passed every
   * test while the page built the rows itself (2026-09-15) — and it is exactly the
   * population that left 11 of 14 whole quarters short of the Table.
   */
  test("each lens is handed the helper's rows untouched, and the page builds no row of its own", () => {
    expect(source).toMatch(/<WhereItWentPanel\s+rows=\{whereRows\}\s/);
    expect(source).toMatch(/<SpendingCategoriesTable\s+rows=\{categoryRows\}\s/);
    // the destructure and the prop: nothing re-cuts the List in between
    expect(source.match(/\bcategoryRows\b/g)).toHaveLength(2);
    expect(source).not.toMatch(/\bwhereRows\s*\.\s*(filter|slice|map|concat)\(/);
    expect(source).not.toMatch(/\bCategoryTableRow\b/);
    expect(source).not.toMatch(/\bWhereItWentRow\b/);
  });

  /*
   * 🔴 The List compared only MONTHS (`listCompares`, a month-only `showDelta`),
   * so on a quarter compared whole it printed no change and listed only what the
   * quarter spent, while the Table and the relief printed every category that
   * stopped. Measured on the owner's ledger 2026-09-15: 11 whole quarters listed
   * fewer rows than the Table; `?period=2026-Q2` 17 against 18, missing Gifts &
   * Donations at -$10.40. Whether a change exists is the comparison's answer
   * (`wholePriorLabel`), asked once — never the granularity's.
   */
  test("the List compares wherever the Table does, and never by granularity", () => {
    expect(source).not.toMatch(/\blistCompares\b/);
    expect(source).not.toMatch(/\bshowDelta\b/);
    expect(source).not.toMatch(/granularity === "month" &&\s*prevBreakdown/);
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

/*
 * ⛔ ONE EMPTY STATE, ASKED OF THE SERVICE THAT KNOWS WHOSE MONEY IS IN THE WINDOW. `spendingEmptyCopy` names his own
 * Uncategorized bucket and says the agent's money is left out when the window holds some (owner decisions 2026-09-28,
 * 2026-10-02, 2026-10-05). 🔴 Composed here, the page promised "Uncategorized outflows would show up above" over a
 * period whose only outflow was the agent's unfiled money. Source, not render: the page reads the database.
 */
describe("the empty state is the service's", () => {
  test("the page hands its window to spendingEmptyCopy and composes no copy of its own", () => {
    expect(source).toMatch(/spendingEmptyCopy\(db, range, \{/);
    expect(source).not.toMatch(/\bemptyPeriodCopy\(/);
    expect(source).not.toMatch(/\bemptyPeriodReason\(/);
  });
});
