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

function render(rows: CategoryTableRow[], showDelta: boolean, priorLabel: string | null): string {
  return renderToStaticMarkup(
    createElement(SpendingCategoriesTable, { rows, periodQuery: "period=2026-07", showDelta, priorLabel }),
  );
}

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

/** the text of every element whose class list holds all of `tokens` */
function textOfClass(html: string, ...tokens: string[]): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(p|span) class="([^"]*)">([\s\S]*?)<\/\1>/g)) {
    const classes = m[2]!.split(/\s+/);
    if (tokens.every((t) => classes.includes(t))) out.push(text(m[3]!));
  }
  return out;
}

describe("the List's change for a category that spent nothing this period", () => {
  test("below md, where the change column is hidden, the fall is a line of its own naming the prior window", () => {
    const html = render([row({})], true, JUNE);

    expect(textOfClass(html, "md:hidden")).toEqual(["-$2,250.00 against June 2026"]);
    // from md up the column still carries it, and is the only thing that does there
    expect(textOfClass(html, "hidden", "md:block")).toEqual(["-$2,250.00"]);
  });

  test("a row that spent keeps the one column it had", () => {
    const html = render([row({ name: "Travel", spentCents: 244_888, sharePct: 23.9, momDeltaCents: 185_864 })], true, JUNE);

    expect(textOfClass(html, "md:hidden")).toEqual([]);
    expect(textOfClass(html, "hidden", "md:block")).toEqual(["+$1,858.64"]);
  });

  test("a $0.00 row with no change has nothing to say below md either", () => {
    expect(textOfClass(render([row({ momDeltaCents: 0 })], true, JUNE), "md:hidden")).toEqual([]);
  });

  test("a List that compares nothing prints no change at any width", () => {
    const html = render([row({})], false, null);

    expect(textOfClass(html, "md:hidden")).toEqual([]);
    expect(html).not.toContain("2,250.00");
  });
});
