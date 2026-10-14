import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { FeesCard as FeesCardData, FeeWindow } from "@/services/fees-card";
import type { Provenance } from "@/services/provenance";
import { FeesCard } from "./FeesCard";

/**
 * "What the banks charge you", rendered as the dashboard renders it, from a payload shaped as `feesCard()` returns it.
 *
 * ⚖️ His decision 72 (2026-10-13): a total over days its accounts have not been imported through keeps its figure, its
 * chip reads "partly read", and /budgets' line for those days sits UNDER the figure. 🔴 Measured on his ledger copy
 * 2026-10-13 (review of 06c6bf3): `feesCard(db, "2026-10-13").paidProvenance` came back partly read — "spending imported
 * through Aug 12 · 49 days of this period unaccounted" — and the card mounted only the chip: "Paid to them · 29 charges
 * · $163.45" wore "partly read" with no days anywhere on it.
 */

const LINE = "spending imported through Aug 12 · 49 days of this period unaccounted";

const WINDOW: FeeWindow = {
  from: "2026-04-01",
  to: "2026-09-30",
  paidCents: 16_345,
  unclassifiedCents: 0,
  unclassifiedRows: 0,
  unclassifiedCredits: 0,
  paidCharges: 29,
  earnedCents: 2_036,
  earnedCredits: 6,
  rowCount: 35,
  netCents: 2_036 - 16_345,
  direction: "behind",
  earnedPerDollarCents: 12,
};

/** the fee total's proof, as `summedRowsProof` words it over a window read only in part */
const PARTLY_READ: Provenance = {
  verdict: "partly_read",
  headline:
    "This total is the sum of 29 rows from 6 documents. A total is only as proven as its weakest row. " +
    `It is read only in part: ${LINE}, so this total is a lower bound rather than a measurement.`,
  sources: [],
  checkedThrough: "2026-08-12",
  inputs: [],
  partlyRead: { uncoveredDays: 49, line: LINE },
};

function data(paidProvenance: Provenance | null): FeesCardData {
  return {
    basis: "recent",
    headline: "$143.09",
    headlineNoun: "more in fees than interest, over the 6 months to Sep 2026",
    direction: "behind",
    summary: "$163.45 went out in fees over the 6 complete months Apr 2026 to Sep 2026, across every account.",
    recent: WINDOW,
    allTime: { ...WINDOW, from: "2022-12-01" },
    allTimeFromLabel: "Dec 2022",
    months: 6,
    fromMonth: "2026-04",
    toMonth: "2026-09",
    lines: [
      {
        categoryId: "c-overdraft",
        name: "Overdraft",
        cents: 16_345,
        charges: 29,
        isUnfiled: false,
        note: null,
        href: "/transactions?category=c-overdraft",
      },
    ],
    paidMonthlyCents: 2_724,
    earnedMonthlyCents: 339,
    interestHref: null,
    spendingHref: "/spending?from=2026-04-01&to=2026-09-30",
    earnedNote: null,
    unfiledNote: null,
    interestTrendNote: null,
    ratioNote: null,
    paidProvenance,
    today: "2026-10-13",
  };
}

const render = (paidProvenance: Provenance | null): string =>
  renderToStaticMarkup(createElement(FeesCard, { data: data(paidProvenance) }));

/** the "Paid to them" row of the recent block — from its label to the start of the next row */
function paidRow(html: string): string {
  const start = html.indexOf("Paid to them");
  const end = html.indexOf("Paid to you", start);
  return html.slice(start, end);
}

describe("FeesCard — a fee total read only in part says which days, under its figure", () => {
  test("⚖️ the proof's own line sits in the 'Paid to them' row, beside its partly read chip", () => {
    const row = paidRow(render(PARTLY_READ));
    expect(row).toContain("is partly read");
    expect(row).toContain(LINE);
  });

  /*
   * ⛔ Never a `<p>`: `ProvenancePopover` renders its panel as a `<div popover>` SIBLING of the trigger, which a
   * paragraph may not contain — the parser closes it, the DOM stops matching the server's HTML, and React throws #418
   * (the comment over this row in the component).
   */
  test("the line is no paragraph — the row holds a popover", () => {
    expect(paidRow(render(PARTLY_READ))).not.toMatch(/<p[\s>]/);
  });

  test("a fee total read in full prints no line, and a card with no proof prints none either", () => {
    const full: Provenance = { ...PARTLY_READ, verdict: "derived", partlyRead: undefined };
    expect(render(full)).not.toContain("unaccounted");
    expect(render(null)).not.toContain("unaccounted");
  });
});
