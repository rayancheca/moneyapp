import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Provenance } from "@/services/provenance";
import { CategoryHeadline } from "./CategoryHeadline";

/**
 * 🔴 THE HEADLINE PRINTED $0.00 OVER ITS OWN "NOT IMPORTED YET". Read on his ledger copy 2026-10-12:
 *
 *     SPENT · OCTOBER 2026   $0.00   0 transactions
 *     October 2026 has not been imported yet. Nothing has been imported for 12 days of it; spending in Housing is
 *     imported through Wed, Aug 12, 2026. That is a window nobody has looked at, not one in which nothing happened …
 *
 * The trend on the same page already refused a $0.00 bar for that month, and the dashboard's pace tile prints "an em
 * dash, not a $0.00" in exactly this case. The headline is drawn in the world its own empty state is written in
 * (`categoryEmptyCopy`'s `figure`).
 */

const OCTOBER = "October 2026";
const NOT_IMPORTED = { title: `${OCTOBER} has not been imported yet`, figure: "dash" as const };

/** the empty total's proof, as `summedRowsProof` words it over an unread window */
const EMPTY_PROOF: Provenance = {
  verdict: "unknown",
  headline:
    "Nothing has been imported for 12 days between Oct 1, 2026 and Oct 31, 2026, so this zero is a window nobody has looked at rather than a measurement.",
  sources: [],
  checkedThrough: null,
  inputs: [],
};

function render(over: Partial<Parameters<typeof CategoryHeadline>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CategoryHeadline, {
      flowLabel: "Spent",
      periodLabel: OCTOBER,
      flowCents: 0,
      txnCount: 0,
      empty: null,
      provenance: EMPTY_PROOF,
      ...over,
    }),
  );
}

/** the text a reader sees, tags dropped — and the proof's badge, which is pinned on its own below */
const text = (html: string): string =>
  html.replace(/<button[\s\S]*?<\/button>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const TRIGGER = 'aria-haspopup="dialog"';

describe("CategoryHeadline — a figure only where someone has looked", () => {
  test("a window nobody has looked at prints an em dash and the page's own reason, not $0.00 · 0 transactions", () => {
    const html = render({ empty: NOT_IMPORTED });
    expect(text(html)).toBe(`Spent · ${OCTOBER} — ${OCTOBER} has not been imported yet`);
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("transactions");
  });

  test("⛔ no proof is offered for a dash — there is no total for it to call a zero", () => {
    expect(render({ empty: NOT_IMPORTED })).not.toContain(TRIGGER);
    // …while a figure keeps its proof
    expect(render({ empty: { title: "No spending or income in this period", figure: "zero" } })).toContain(TRIGGER);
  });

  test("an income category's headline keeps its own word over the dash", () => {
    expect(text(render({ flowLabel: "Received", empty: NOT_IMPORTED }))).toBe(
      `Received · ${OCTOBER} — ${OCTOBER} has not been imported yet`,
    );
  });

  test("every other world the empty state names is a dash too, in its own words", () => {
    const titles = ["June 2021 is before your records begin", "Nothing imported yet", "November 2026 has not happened yet"];
    for (const title of titles) {
      expect(text(render({ empty: { title, figure: "dash" } }))).toBe(`Spent · ${OCTOBER} — ${title}`);
    }
  });

  test("a measured zero keeps its $0.00 and its count", () => {
    expect(text(render({ empty: { title: "No spending or income in this period", figure: "zero" } }))).toBe(
      `Spent · ${OCTOBER} $0.00 0 transactions`,
    );
  });

  test("a window imported only in part keeps its $0.00, called the lower bound the page below calls it", () => {
    const partly = {
      title: `No spending or income in the part of ${OCTOBER} that has been imported`,
      figure: "lower-bound" as const,
      zeroIs: "a lower bound rather than a measurement",
    };
    expect(text(render({ empty: partly }))).toBe(
      `Spent · ${OCTOBER} $0.00 0 transactions — a lower bound rather than a measurement`,
    );
  });

  /*
   * ⚖️ …and a Net's is called what the sentence under it and its proof call it (`categoryEmptyCopy`'s `zeroIs`, decision
   * 72's `partReadTotal`). 🔴 Review of b356d57, his ledger copy 2026-10-21: `/categories/<Buys>?period=2026-09` — a Net
   * of 1,917 negative rows to 80 positive — headlined "$0.00 0 transactions — a lower bound rather than a measurement",
   * while the days still to import push it below $0.00.
   */
  test("…and a Net's $0.00 read in part is neither a measurement nor a bound, in the words the page below uses", () => {
    const zeroIs = "neither a measurement nor a bound: the days still to import can move it either way";
    const partly = {
      title: `No spending or income in the part of ${OCTOBER} that has been imported`,
      figure: "lower-bound" as const,
      zeroIs,
    };
    const html = text(render({ flowLabel: "Net", empty: partly }));
    expect(html).toBe(`Net · ${OCTOBER} $0.00 0 transactions — ${zeroIs}`);
    expect(html).not.toMatch(/lower bound/);
  });

  test("a window holding rows prints its figure, as it always has", () => {
    expect(text(render({ periodLabel: "September 2026", flowCents: 229_847, txnCount: 2 }))).toBe(
      "Spent · September 2026 $2,298.47 2 transactions",
    );
    expect(text(render({ flowCents: 69_504, txnCount: 1 }))).toBe(`Spent · ${OCTOBER} $695.04 1 transaction`);
  });

  /*
   * ⚖️ His decision 72 (2026-10-13): a total over days its accounts have not been imported through keeps its figure,
   * its chip reads "partly read", and /budgets' line for those days sits under it. 🔴 Measured on his ledger copy
   * 2026-10-13: Food's September headlined "adds up · $160.72 · 25 transactions" and said nothing of the Aug 12 its
   * budget card, on the same page, names.
   */
  test("⚖️ a total read only in part prints its figure, its count, and /budgets' line for the days unread", () => {
    const line = "spending imported through Aug 12 · 30 days of this period unaccounted";
    const partly: Provenance = {
      verdict: "partly_read",
      headline:
        "This total is the sum of 25 rows from 1 document. A total is only as proven as its weakest row. " +
        `It is read only in part: ${line}, so this total is a lower bound rather than a measurement.`,
      sources: [],
      checkedThrough: "2026-09-13",
      inputs: [],
      partlyRead: { uncoveredDays: 30, line },
    };
    const html = render({ periodLabel: "Sep 1 – 30, 2026", flowCents: 16_072, txnCount: 25, provenance: partly });
    expect(text(html)).toBe(`Spent · Sep 1 – 30, 2026 $160.72 25 transactions ${line}`);
    expect(html).toContain('aria-label="How this spent total is known — it is partly read: not every account behind it');
    // a window read in full prints no line
    const full: Provenance = { ...partly, verdict: "derived", partlyRead: undefined };
    expect(text(render({ flowCents: 16_072, txnCount: 25, provenance: full }))).toBe(`Spent · ${OCTOBER} $160.72 25 transactions`);
  });
});
