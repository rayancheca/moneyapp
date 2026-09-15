import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SpendingCategoriesTable, type CategoryTableRow } from "./SpendingCategoriesTable";

/**
 * 🔴 A CATEGORY THAT STOPPED, ON A PHONE. /spending's List takes the categories
 * that spent last month and nothing this month (`lib/compared-categories`) as
 * $0.00 rows, because it prints each row's change — but that change column is
 * `hidden md:block`, and the owner's phone is 440px wide with List the default
 * lens. Measured on his ledger 2026-09-15 at ebf463e: `?period=2024-07` listed
 * Utilities, Subscriptions and Education, then nine rows reading only "0.0%
 * $0.00" — Food, Shopping, Health and six more — with no sign any of them fell;
 * 82 such rows over 39 of 46 whole months. `display: none` hid the fall from a
 * screen reader too.
 *
 * ⛔ Exactly one element carries a row's change at each breakpoint: the column
 * from md up, the line below it under md. Two would read the figure twice.
 */
const JUNE = "June 2026";

function row(over: Partial<CategoryTableRow>): CategoryTableRow {
  return {
    categoryId: "gov",
    name: "Government",
    hue: null,
    icon: null,
    spentCents: 0,
    sharePct: 0,
    momDeltaCents: -225_000,
    children: [],
    ...over,
  };
}

function render(rows: CategoryTableRow[], priorLabel: string | null): string {
  return renderToStaticMarkup(createElement(SpendingCategoriesTable, { rows, periodQuery: "period=2026-07", priorLabel }));
}

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

/** the text of every element whose class list holds all of `tokens` */
function textOfClass(html: string, ...tokens: string[]): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(p|span) class="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const classes = m[2]!.split(/\s+/);
    if (tokens.every((t) => classes.includes(t))) out.push(text(m[3]!));
  }
  return out;
}

describe("the List's change for a category that spent nothing this period", () => {
  test("below md, where the change column is hidden, the fall is a line of its own naming the prior window", () => {
    const html = render([row({})], JUNE);

    expect(textOfClass(html, "md:hidden")).toEqual(["-$2,250.00 against June 2026"]);
    // from md up the column still carries it, and is the only thing that does there
    expect(textOfClass(html, "hidden", "md:block")).toEqual(["-$2,250.00"]);
  });

  test("a row that spent keeps the one column it had", () => {
    const html = render([row({ name: "Travel", spentCents: 244_888, sharePct: 23.9, momDeltaCents: 185_864 })], JUNE);

    expect(textOfClass(html, "md:hidden")).toEqual([]);
    expect(textOfClass(html, "hidden", "md:block")).toEqual(["+$1,858.64"]);
  });

  test("a $0.00 row with no change has nothing to say below md either", () => {
    expect(textOfClass(render([row({ momDeltaCents: 0 })], JUNE), "md:hidden")).toEqual([]);
  });

  test("a List that compares nothing prints no change at any width", () => {
    const html = render([row({})], null);

    expect(textOfClass(html, "md:hidden")).toEqual([]);
    expect(html).not.toContain("2,250.00");
  });
});

/**
 * 🔴 THE CHANGE FOLLOWS THE COMPARISON, NOT THE CALENDAR. The page handed the List
 * a month-only `showDelta` beside the prior window's name, so a quarter compared
 * WHOLE printed no change and dropped the categories that stopped, while the Table
 * and the relief — which read only the prior window's name — printed both.
 * Measured on the owner's ledger 2026-09-15: `?period=2026-Q2` listed 17 rows over
 * the Table's 18, the missing one Gifts & Donations at -$10.40 against Q1 2026.
 *
 * ⛔ One predicate, the Table's: a change exists exactly when there is a prior
 * window to name. No second prop can say otherwise.
 */
describe("the List prints a change wherever there is a whole prior window to name", () => {
  test("a quarter compared whole: the column from md up, and the stopped category's fall below it", () => {
    const html = render(
      [
        row({ categoryId: "travel", name: "Travel", spentCents: 120_000, sharePct: 80, momDeltaCents: 40_000 }),
        row({ categoryId: "gifts", name: "Gifts & Donations", momDeltaCents: -1_040 }),
      ],
      "Q1 2026",
    );

    expect(textOfClass(html, "hidden", "md:block")).toEqual(["+$400.00", "-$10.40"]);
    expect(textOfClass(html, "md:hidden")).toEqual(["-$10.40 against Q1 2026"]);
  });

  test("with no prior window the List is silent about change, whatever the rows carry", () => {
    const html = render([row({ spentCents: 5_000, sharePct: 100, momDeltaCents: 5_000 })], null);

    expect(textOfClass(html, "hidden", "md:block")).toEqual([]);
    expect(html).not.toContain("+$50.00");
    expect(html).not.toContain("against");
  });
});

/**
 * 🔴 A FIGURE WITH NO WINDOW. From md up the change is a bare signed figure in a
 * column with no heading, and the card names the prior window only inside its
 * OTHER lenses (the relief's readout, the Table's header). A week's "+$120.00"
 * or a custom window's "-$48.10" says nothing of what it was set against. The
 * phone line below md already names it; the column now says the same, to a
 * screen reader and on hover — no pixel of it moves.
 */
describe("from md up the change column names the window it measured", () => {
  const html = render(
    [
      row({ categoryId: "travel", name: "Travel", spentCents: 120_000, sharePct: 80, momDeltaCents: 40_000 }),
      row({ categoryId: "gifts", name: "Gifts & Donations", momDeltaCents: -1_040 }),
    ],
    "Q1 2026",
  );

  test("each column reads its figure against the named window", () => {
    const columns = [...html.matchAll(/<span class="[^"]*\bmd:block\b[^"]*" title="([^"]*)">([\s\S]*?)<\/span><\/span>/g)];

    expect(columns.map((m) => m[1])).toEqual(["against Q1 2026", "against Q1 2026"]);
    expect(columns.map((m) => text(m[2]! + "</span>"))).toEqual(["+$400.00 against Q1 2026", "-$10.40 against Q1 2026"]);
  });

  test("the words ride only inside the column, so the phone line is still the one element that names it below md", () => {
    // ⚠️ scoped to the window's words: CategoryChip already reads each row's NAME as sr-only text
    expect(textOfClass(html, "sr-only").filter((t) => t.includes("against"))).toEqual([
      " against Q1 2026",
      " against Q1 2026",
    ]);
    expect(textOfClass(html, "md:hidden")).toEqual(["-$10.40 against Q1 2026"]);
  });
});
