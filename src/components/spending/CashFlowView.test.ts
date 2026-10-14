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
  spendingUnaccounted: null,
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

  // 🔴 S22: the column over income-kind money in was headed "Earned" — the word
  // /summary keeps for wages, tutoring and savings interest alone
  test("heads the money-in column Income, in the table and in its caption", () => {
    const html = renderTable(september, "September 2026");
    const head = textOf(/<thead[^>]*>([\s\S]*?)<\/thead>/.exec(html)![1]!);
    expect(head).toContain("Income");
    expect(head).not.toContain("Earned");
    expect(textOf(/<caption[^>]*>(.*?)<\/caption>/.exec(html)![1]!)).toContain("income, spent");
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

/*
 * ⚖️ Decisions 64 + 72: a day past the day every account he spends from is imported through, holding no spending, is no
 * measured zero. 🔴 Every figure below is what `cashFlowByPeriod` returned for `/spending?period=2026-09` on his ledger
 * copy 2026-10-13 (review of 2fce458) — Sep 15 and Sep 23 printed "$0.00 $0.00 $0.00" and "$4,567.68 $0.00
 * +$4,567.68" under a heatmap calling both days unaccounted, and a Where it went reading "30 days of this period
 * unaccounted".
 */
describe("CashFlowView's table — a day past the day all his spending is read through", () => {
  const FACT = "spending imported through Aug 12";
  const september = flow([
    bucket("2026-09-12", "12", { spendingCents: 475, netCents: -475 }),
    bucket("2026-09-15", "15", { spendingUnaccounted: FACT }),
    bucket("2026-09-23", "23", { incomeCents: 456_768, netCents: 456_768, spendingUnaccounted: FACT }),
    bucket("2026-09-25", "25", { unreached: "after-records" }),
  ]);
  const NOTE =
    "A dash is not a zero where nothing has been found so far — spending imported through Aug 12, and not every account " +
    "you spend from has been read for that day.";

  test("a day with nothing found prints no $0.00 — every money column is a dash", () => {
    expect(rowCells(renderTable(september, "September 2026"), "15")).toEqual(["15", "—", "—", "—"]);
  });

  test("a day whose pay is found prints it, and a dash under Spent and Net", () => {
    expect(rowCells(renderTable(september, "September 2026"), "23")).toEqual(["23", "$4,567.68", "—", "—"]);
  });

  test("a refund found is printed too; the rest of the day is a dash", () => {
    const html = renderTable(
      flow([bucket("2026-09-16", "16", { refundsCents: 1_800, netCents: 1_800, spendingUnaccounted: FACT })]),
      "September 2026",
    );
    expect(rowCells(html, "16")).toEqual(["16", "—", "—", "$18.00", "—"]);
  });

  test("a day holding spending keeps its figures, its income's measured zero included", () => {
    expect(rowCells(renderTable(september, "September 2026"), "12")).toEqual(["12", "$0.00", "$4.75", "-$4.75"]);
  });

  test("says why, naming the day, beside the worlds the other dashes are in — to the eye and in the caption", () => {
    const html = renderTable(september, "September 2026");
    const both = `A dash is not a zero: it marks a day that has not been imported yet. ${NOTE}`;
    expect(textOf(/<caption[^>]*>(.*?)<\/caption>/.exec(html)![1]!)).toContain(both);
    expect(html).toContain(`<p aria-hidden="true" class="mt-2 text-xs text-ink-faint">${both}</p>`);
  });

  test("…and alone, where no day is unreached", () => {
    const html = renderTable(flow([bucket("2026-09-15", "15", { spendingUnaccounted: FACT })]), "September 2026");
    expect(textOf(html)).toContain(NOTE);
    expect(textOf(html)).not.toContain("it marks a day that");
  });

  test("a month bucket says month", () => {
    const september = bucket("2026-09", "Sep", { incomeCents: 100, netCents: 100, spendingUnaccounted: FACT });
    const html = renderTable(flow([september]), "2026");
    expect(textOf(html)).toContain("has been read for that month.");
  });
});
