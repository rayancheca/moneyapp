import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { SankeyGraph } from "@/lib/sankey-layout";
import type { CashFlow, CashFlowBucket } from "@/services/spending";
import { CashFlowView } from "./CashFlowView";

// the table never navigates or persists; the view switcher only needs both to exist
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: async () => undefined }));

const bucket = (key: string, label: string, over: Partial<CashFlowBucket> = {}): CashFlowBucket => ({
  key,
  label,
  from: key,
  to: key,
  income: {},
  spending: {},
  incomeCents: 0,
  spendingCents: 0,
  refundsCents: 0,
  netCents: 0,
  unreached: null,
  ...over,
});

const flow = (buckets: CashFlowBucket[]): CashFlow => {
  const spentCents = buckets.reduce((t, b) => t + b.spendingCents, 0);
  const earnedCents = buckets.reduce((t, b) => t + b.incomeCents, 0);
  return {
    buckets,
    incomeSeries: [],
    spendingSeries: [],
    totals: { earnedCents, spentCents, refundsCents: 0, netCents: earnedCents - spentCents, savingsRatePct: null },
    pace: null,
  };
};

const NO_SANKEY: SankeyGraph = { nodes: [], links: [] };

function renderTable(cashFlow: CashFlow, periodLabel: string): string {
  return renderToStaticMarkup(
    createElement(CashFlowView, {
      cashFlow,
      projection: null,
      sankey: NO_SANKEY,
      viewState: { cash: "table" },
      baseParams: {},
      periodLabel,
      paceWindowName: periodLabel,
    }),
  );
}

const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");

/** the cells of the body row whose first cell reads `label` */
function rowCells(html: string, label: string): string[] {
  const rows = html.split("<tr").slice(1);
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((m) => textOf(m[1]!));
    if (cells[0] === label) return cells;
  }
  throw new Error(`no row labelled ${label}`);
}

/**
 * 🔴 S11. The table printed "$0.00 $0.00 $0.00" in every bucket nobody has read.
 * Every figure below is what `cashFlowByPeriod` returned on the owner's ledger
 * 2026-09-14, read-only (first active row 2022-08-25, newest 2026-09-12).
 */
describe("CashFlowView's table — a bucket the ledger has not reached", () => {
  /* September 2026: Sep 12 holds $4.75 spent; Sep 13 is not imported; Sep 15 has not happened */
  const september = flow([
    bucket("2026-09-12", "12", { spendingCents: 475, netCents: -475 }),
    bucket("2026-09-13", "13", { unreached: "after-records" }),
    bucket("2026-09-15", "15", { unreached: "future" }),
  ]);

  test("prints a dash, not $0.00, under every money column of an unreached bucket", () => {
    const html = renderTable(september, "September 2026");
    expect(rowCells(html, "13")).toEqual(["13", "—", "—", "—"]);
    expect(rowCells(html, "15")).toEqual(["15", "—", "—", "—"]);
  });

  test("a reached bucket keeps its figures, its measured zero included", () => {
    expect(rowCells(renderTable(september, "September 2026"), "12")).toEqual(["12", "$0.00", "$4.75", "-$4.75"]);
  });

  test("says why, naming only the worlds its dashes are in", () => {
    const html = renderTable(september, "September 2026");
    const note = "A dash is not a zero: it marks a day that has not been imported yet or has not happened yet.";
    expect(textOf(/<caption[^>]*>(.*?)<\/caption>/.exec(html)![1]!)).toContain(note);
    expect(textOf(html)).not.toContain("before your records begin");
  });

  /*
   * ⛔ ONCE PER AUDIENCE. The caption is screen-reader-only and announced as the
   * table is entered, before its dashes; the line under the table is for the eye.
   * The pace readout on this card was heard twice for exactly this shape (9dcda96).
   */
  test("the visible line under the table is hidden from screen readers, which hear the caption", () => {
    const html = renderTable(september, "September 2026");
    expect(html).toMatch(/<p aria-hidden="true"[^>]*>A dash is not a zero: it marks a day that has not been imported yet or has not happened yet\.<\/p>/);
  });

  /* August 2022: Aug 24 is before the records begin; Aug 25 holds $1,388.10 earned */
  test("the opening end: a day before the records begin", () => {
    const html = renderTable(
      flow([
        bucket("2022-08-24", "24", { unreached: "before-records" }),
        bucket("2022-08-25", "25", { incomeCents: 138_810, netCents: 138_810 }),
      ]),
      "August 2022",
    );
    expect(rowCells(html, "24")).toEqual(["24", "—", "—", "—"]);
    expect(rowCells(html, "25")).toEqual(["25", "$1,388.10", "$0.00", "+$1,388.10"]);
    expect(textOf(html)).toContain("A dash is not a zero: it marks a day that is before your records begin.");
  });

  test("a table with nothing dashed says nothing about dashes", () => {
    const html = renderTable(flow([bucket("2026-09-12", "12", { spendingCents: 475, netCents: -475 })]), "September 2026");
    expect(textOf(html)).not.toContain("A dash");
  });
});
