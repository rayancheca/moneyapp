import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { emptyPeriodCopy } from "@/lib/empty-period";
import type { SpendingPace } from "@/services/dashboard";
import type { Provenance } from "@/services/provenance";
import { SpendingPaceWidget } from "./SpendingPaceWidget";

/**
 * 🔴 ONE FACT, TWO WORDINGS, ONE CLICK APART. With not one elapsed day of October imported the dashboard's pace tile
 * read "October 2026 is not imported yet" under its "—", and the category headline it links toward "— October 2026
 * has not been imported yet" — the empty state's heading every page with a period selector prints (review of b2c9db7,
 * 2026-10-12). One phrase now, the empty state's (`notImportedTitle`).
 */

/** the month's proof over a window nobody has read, as `summedRowsProof` words an empty one */
const UNREAD_PROOF: Provenance = {
  verdict: "unknown",
  headline: "Nothing has been imported for 13 days between Oct 1, 2026 and Oct 31, 2026.",
  sources: [],
  checkedThrough: null,
  inputs: [],
};

const OCTOBER: SpendingPace = {
  monthLabel: "October 2026",
  actualToDateCents: 0,
  projectedCents: 0,
  partlyRead: { uncoveredDays: 13, line: "spending imported through Sep 24 · 13 days of this period unaccounted" },
  provenance: UNREAD_PROOF,
  spendingNotFound: null,
  waitsForIncome: false,
  points: [],
  freeToSpendCents: null,
  href: "/spending",
};

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("SpendingPaceWidget — a month nobody has imported", () => {
  test("says what the category headline and every empty state say of the same month, word for word", () => {
    const html = render(OCTOBER);
    const title = emptyPeriodCopy({ kind: "after-records", uncoveredDays: 13 }, "October 2026", "2026-08-12", (d) => d).title;
    expect(title).toBe("October 2026 has not been imported yet");
    expect(text(html)).toContain(`Free to spend — ${title}`);
    expect(html).not.toContain("is not imported yet");
    // ⛔ no proof beside a dash: the popover proves a rendered figure (`CategoryHeadline`'s rule) — nor its line
    expect(html).not.toContain("<button");
    expect(html).not.toContain("unaccounted");
  });

  test("a month read in part keeps its figures, marked as floors", () => {
    const line = "spending imported through Oct 11 · 2 days of this period unaccounted";
    const partly = {
      ...OCTOBER,
      actualToDateCents: 12_000,
      projectedCents: 40_000,
      partlyRead: { uncoveredDays: 2, line },
      freeToSpendCents: 50_000,
    };
    expect(text(render(partly))).toContain(`≈ $500.00 at least $120.00 spent · at least $400.00 projected ${line}`);
  });
});

/**
 * ⚖️ His decision 72 (2026-10-13): a total over days not every account is read for wears "partly read" and /budgets'
 * line. 🔴 Measured on his ledger copy 2026-10-21 (Venture X read through Oct 14, Chase Checking through Aug 12): the
 * tile read "at least $1,603.00 spent · at least $2,366.33 projected / 7 days of October 2026 not imported yet" with no
 * chip, beside /spending's "partly read" and "spending imported through Aug 12 · 21 days of this period unaccounted".
 */
describe("SpendingPaceWidget — a month not every account has read (decision 72)", () => {
  const LINE = "spending imported through Aug 12 · 21 days of this period unaccounted";
  const PARTLY_READ: SpendingPace = {
    ...OCTOBER,
    actualToDateCents: 160_300,
    projectedCents: 236_633,
    partlyRead: { uncoveredDays: 21, line: LINE },
    provenance: {
      verdict: "partly_read",
      headline: "October 2026 holds 43 rows.",
      sources: [],
      checkedThrough: null,
      inputs: [],
      partlyRead: { uncoveredDays: 21, line: LINE },
    },
    freeToSpendCents: -283_914,
  };

  test("wears the amber chip and prints /spending's line under the figures it found", () => {
    const html = render(PARTLY_READ);
    expect(text(html)).toContain("partly read");
    expect(text(html)).toContain(`at least $1,603.00 spent · at least $2,366.33 projected ${LINE}`);
    expect(html).not.toContain("not imported yet");
  });

  /*
   * ⛔ The chip sits on the heading, never inside the card's link: a <button> in an <a> is axe `nested-interactive`
   * (serious) — `ProvenancePopover`'s rule, and the reason /spending mounts its own chip on a heading too.
   */
  test("its chip is outside the card's link", () => {
    const html = render(PARTLY_READ);
    expect(html).toContain("<button");
    const links = html.match(/<a\b[\s\S]*?<\/a>/g) ?? [];
    expect(links.some((a) => a.includes("<button"))).toBe(false);
  });

  /*
   * ⚖️ Decision 64 (2026-10-12): no spending found and not one elapsed day read by the day every account he spends from
   * is read through — /spending's Spent card prints "—" there, and the tile that links to it does too, in its words.
   */
  test("a month with no spending found past that day is a dash, in /spending's words", () => {
    const html = render({ ...OCTOBER, spendingNotFound: "spending imported through Aug 12" });
    expect(text(html)).toContain("Free to spend — nothing found so far — spending imported through Aug 12");
    expect(html).not.toContain("not been imported");
    expect(html).not.toContain("<button");
  });

  /*
   * ⚖️ §6A 68 — no Income, no Free to spend (`SpendingPace.waitsForIncome`): the figure waits, in the words /spending's
   * savings-rate card prints for the same wait, and what was spent stands under it with its chip and line. 🔴 On his
   * ledger copy 2026-10-21 the tile read "≈ −$2,839.14" beside the dashboard's own Income card reading "—".
   */
  test("a month whose income nobody has looked for waits for it — and keeps what it found", () => {
    const html = render({ ...PARTLY_READ, freeToSpendCents: null, waitsForIncome: true });
    expect(text(html)).toContain(
      `Free to spend — until income is found at least $1,603.00 spent · at least $2,366.33 projected ${LINE}`,
    );
    expect(html).not.toContain("≈");
    expect(html).not.toContain("not imported yet");
    expect(html).not.toContain("nothing found so far");
    // the proof proves the spending figures still printed, so it stays on the heading
    expect(text(html)).toContain("partly read");
    expect(html).toContain("<button");
  });
});

function render(pace: SpendingPace): string {
  return renderToStaticMarkup(createElement(SpendingPaceWidget, { pace }));
}
