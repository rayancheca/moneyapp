import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { noIncomeDayCheckedNote } from "@/lib/unbanked-income";
import { IncomeSoFar, IncomeSoFarNote } from "./IncomeSoFar";

/**
 * /budgets' header after "left to allocate ·": what has come in so far this month and what is still expected.
 *
 * ⚖️ §6A 68 (2026-10-13): with not one day of the month checked where the pay lands, "— in so far", not "$0.00". 🔴 No
 * test ever rendered that branch (review of 9652477) — and its spoken half read as two sentences run together: "no day
 * of this month checked yet in the accounts that pay lands in, so nothing is shown in so far, $3,425.76 still expected
 * from It America LLC". Measured on his ledger copy 2026-10-13, where this is the branch he sees.
 *
 * 🔴 …and its fix still spliced it, for whoever reads the page's TEXT (`scripts/read-surface.mjs`, a copy, a find): the
 * dash's spoken stand-in sat beside it, so his ledger copy 2026-10-21 read "$33.76 left to allocate · — in so far, what
 * has come in so far is not shown, since no day of this month has been checked yet in the accounts that pay lands in;
 * $2,283.84 still expected from It America LLC (weekly pay)" — "in so far" twice, the reason between the dash and the
 * figures. One text now, for the eye, a screen reader and the page alike, and the reason a line of its own under it.
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

  test("…read the same by the eye, a screen reader and the page's text — 'in so far' once, nothing spliced in", () => {
    const html = render();
    expect(heard(html)).toBe(seen(html));
    expect(squeeze(html)).toBe(seen(html));
    expect(squeeze(html).split("in so far")).toHaveLength(2);
  });

  test("…and why there is none is its own line under it: the dashboard's sentence under its dash", () => {
    const note = renderToStaticMarkup(createElement(IncomeSoFarNote, { noIncomeDayRead: true, month: "Oct 2026" }));
    expect(squeeze(note)).toBe(
      "Not one day of Oct 2026 has been checked in the accounts that pay lands in, so nothing is shown.",
    );
    expect(squeeze(note)).toBe(noIncomeDayCheckedNote("Oct 2026"));
    expect(note).toMatch(/^<p /);
    // a day of it checked: a figure stands, and there is nothing to explain
    const read = renderToStaticMarkup(createElement(IncomeSoFarNote, { noIncomeDayRead: false, month: "Oct 2026" }));
    expect(read).toBe("");
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
    expect(page).toMatch(/<IncomeSoFarNote\s/);
    expect(page).not.toContain("noIncomeDayCheckedNote");
    expect(page).not.toMatch(/\/> in so far,/);
    expect(page).not.toContain("sr-only");
    expect(page).not.toContain("NO_INCOME_DAY_CHECKED");
  });
});
