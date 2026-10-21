import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { IncomeSoFar } from "./IncomeSoFar";

/**
 * /budgets' header after "left to allocate ·": what has come in so far this month and what is still expected.
 *
 * ⚖️ §6A 68 (2026-10-13): with not one day of the month checked where the pay lands, "— in so far", not "$0.00". 🔴 No
 * test ever rendered that branch (review of 9652477) — and its spoken half read as two sentences run together: "no day
 * of this month checked yet in the accounts that pay lands in, so nothing is shown in so far, $3,425.76 still expected
 * from It America LLC". Measured on his ledger copy 2026-10-13, where this is the branch he sees.
 */

const OCTOBER = { postedCents: 0, expectedCents: 342_576, from: "It America LLC" };

function render(over: Partial<Parameters<typeof IncomeSoFar>[0]> = {}): string {
  return renderToStaticMarkup(createElement(IncomeSoFar, { noIncomeDayRead: true, ...OCTOBER, ...over }));
}

const squeeze = (s: string): string => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ ([,;])/g, "$1").trim();

/** `html` without every span opening with `open`, nested spans and all */
function without(html: string, open: string): string {
  let out = html;
  for (let at = out.indexOf(open); at !== -1; at = out.indexOf(open)) {
    const tag = /<span\b[^>]*>|<\/span>/g;
    tag.lastIndex = at;
    let depth = 0;
    let end = out.length;
    for (let m = tag.exec(out); m !== null; m = tag.exec(out)) {
      depth += m[0] === "</span>" ? -1 : 1;
      if (depth === 0) {
        end = tag.lastIndex;
        break;
      }
    }
    out = out.slice(0, at) + out.slice(end);
  }
  return out;
}
/** what the eye reads: the spoken-only text dropped */
const seen = (html: string): string => squeeze(without(html, '<span class="sr-only">'));
/** what a screen reader reads: the text hidden from it dropped */
const heard = (html: string): string => squeeze(without(html, '<span aria-hidden="true">'));

describe("IncomeSoFar — /budgets' header: in so far, still expected", () => {
  test("⚖️ no day of the month checked where the pay lands: an em dash, not $0.00", () => {
    const html = render();
    expect(seen(html)).toBe("— in so far, $3,425.76 still expected from It America LLC");
    expect(html).not.toContain("$0.00");
  });

  test("…and a screen reader hears one sentence saying why, with the figures after it", () => {
    expect(heard(render())).toBe(
      "what has come in so far is not shown, since no day of this month has been checked yet in the accounts that " +
        "pay lands in; $3,425.76 still expected from It America LLC",
    );
  });

  test("a day of it checked: the figure, $0.00 included, as it always was", () => {
    const html = render({ noIncomeDayRead: false });
    expect(seen(html)).toBe("$0.00 in so far, $3,425.76 still expected from It America LLC");
    expect(heard(html)).toBe(seen(html));
    expect(seen(render({ noIncomeDayRead: false, postedCents: 114_192, from: null }))).toBe(
      "$1,141.92 in so far, $3,425.76 still expected",
    );
  });

  test("the page draws its header with this, and says none of it itself", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/budgets/page.tsx"), "utf8");
    expect(page).toMatch(/<IncomeSoFar\s/);
    expect(page).not.toMatch(/\/> in so far,/);
    expect(page).not.toContain("sr-only");
    expect(page).not.toContain("NO_INCOME_DAY_CHECKED");
  });
});
