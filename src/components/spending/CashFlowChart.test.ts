import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { CashFlow, CashFlowBucket, SpendingProjection } from "@/services/spending";
import { CashFlowBucketTooltip, CashFlowChart } from "./CashFlowChart";

// the readout never navigates; the chart's click handlers only need a router to exist
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

/**
 * September 2026 on the real ledger, 2026-09-14 (newest active row Sep 12): every
 * figure below is what `cashFlowByPeriod` and `spendingProjection` returned for
 * it, read-only. Its 30 day buckets and 7 of its 8 spending series are left out —
 * the readout reads none of them, and one series is what draws the card at all.
 */
const HEALTH = "019f4c7d-cc8b-7322-ab85-d15512376000";
const SEPTEMBER: CashFlow = {
  buckets: [],
  incomeSeries: [],
  spendingSeries: [{ key: HEALTH, label: "Health", categoryId: HEALTH, hue: "red" }],
  totals: { earnedCents: 0, spentCents: 143_105, refundsCents: 0, netCents: -143_105, savingsRatePct: null },
  pace: {
    elapsedFraction: 14 / 30,
    actualToDateCents: 143_105,
    upfrontToDateCents: 0,
    projectedCents: 306_654,
    avgPerBucketCents: 10_222,
  },
  spendingUnaccounted: null,
};
const PROJECTION: SpendingProjection = {
  projectedSpendCents: 306_654,
  paceBasis: "pace from 14 of 30 days elapsed",
  paceConfidence: 0.65,
  pacePartlyRead: { uncoveredDays: 2, line: "spending imported through Sep 12 · 2 days of this period unaccounted" },
  prior: null,
};

/** the markup's text, which is what a screen reader reads: tags, attributes and comments stripped */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");
const occurrences = (text: string, phrase: string): number => text.split(phrase).length - 1;

function render(): string {
  return renderToStaticMarkup(
    createElement(CashFlowChart, { data: SEPTEMBER, projection: PROJECTION }),
  );
}

describe("CashFlowChart's pace readout", () => {
  /**
   * 🔴 The basis — also the sr-only span after the figure — carried the
   * not-imported clause, and the clause was its own visible part as well. A
   * screen reader heard it twice: "On pace for at least $3,066.54 — pace from 14
   * of 30 days elapsed; 2 days of September 2026 not imported yet spent this
   * period · at least $1,431.05 so far · 2 days of September 2026 not imported yet".
   *
   * ⚖️ The clause is the period proof's line now (decision 72) — the words "Where it went" prints under its chip.
   */
  test("says the unaccounted days once, to the eye and to a screen reader alike", () => {
    const html = render();
    const text = textOf(html);
    expect(occurrences(text, "unaccounted")).toBe(1);
    expect(text).toContain("On pace for at least $3,066.54 — pace from 14 of 30 days elapsed spent this period");
    expect(text).toContain(
      "at least $1,431.05 so far · spending imported through Sep 12 · 2 days of this period unaccounted",
    );
    expect(text).not.toContain("not imported yet");

    const srOnly = /<span class="sr-only">(.*?)<\/span>/.exec(html)?.[1];
    expect(srOnly === undefined ? null : textOf(srOnly)).toBe(" — pace from 14 of 30 days elapsed");
  });

  test("the method stays on hover, without the clause the readout already shows", () => {
    expect(render()).toContain('title="pace from 14 of 30 days elapsed"');
  });
});

/**
 * 🔴 S11, the chart lens. Hovering a bucket nobody has read printed "Earned
 * $0.00 · Spent $0.00 · Net $0.00" — the same measured zero the table lens
 * printed. September 2026 on the owner's ledger, 2026-09-14: Sep 12 holds $4.75
 * spent (the newest active row), Sep 13 has not been imported, Sep 15 has not
 * happened.
 */
describe("CashFlowChart's tooltip — a bucket the ledger has not reached", () => {
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
  const tooltip = (b: CashFlowBucket, ghostCents: number | null = null): string =>
    textOf(renderToStaticMarkup(createElement(CashFlowBucketTooltip, { bucket: b, ghostCents })));

  test("a reached bucket states its figures", () => {
    const text = tooltip(bucket("2026-09-12", "12", { spendingCents: 475, netCents: -475 }));
    expect(text).toContain("Spent$4.75");
    expect(text).toContain("Income$0.00");
    expect(text).not.toContain("Earned");
  });

  test("an unreached bucket says which world it is in, and prints no figure", () => {
    const text = tooltip(bucket("2026-09-13", "13", { unreached: "after-records" }));
    expect(text).toContain("not imported yet");
    expect(text).not.toContain("$0.00");
    expect(text).not.toContain("Income");
    expect(tooltip(bucket("2026-09-15", "15", { unreached: "future" }))).toContain("has not happened yet");
    expect(tooltip(bucket("2022-08-24", "24", { unreached: "before-records" }))).toContain("before your records begin");
  });

  /* ⛔ the prior period's bucket is a fact about THAT period (owner decision E1a) */
  test("the prior period's bucket is still given beside an unreached one", () => {
    const text = tooltip(bucket("2026-09-13", "13", { unreached: "after-records" }), 3_451);
    expect(text).toContain("Prior period, this point$34.51");
  });

  /*
   * ⚖️ Decisions 64 + 72. 🔴 On his ledger copy 2026-10-13 (review of 2fce458) `/spending?period=2026-09`'s default chart
   * hovered Sep 15 "Income $0.00 · Spent $0.00 · Net $0.00" and Sep 23 "Spent $0.00" beside its $4,567.68, under a
   * heatmap whose cells for the same days read "nothing found so far — spending imported through Aug 12".
   */
  test("a day past the day all his spending is read through, with nothing found, says that in the heatmap's words", () => {
    const text = tooltip(bucket("2026-09-15", "15", { spendingUnaccounted: "spending imported through Aug 12" }), 3_451);
    expect(text).toBe("15nothing found so far — spending imported through Aug 12Prior period, this point$34.51");
  });

  test("…and with its pay found, prints the pay and a dash under Spent and Net, and says why", () => {
    const pay = { incomeCents: 456_768, netCents: 456_768, spendingUnaccounted: "spending imported through Aug 12" };
    const text = tooltip(bucket("2026-09-23", "23", pay));
    expect(text).toContain("Income$4,567.68");
    expect(text).toContain("Spent—");
    expect(text).toContain("Net—");
    expect(text).toContain("nothing found so far — spending imported through Aug 12");
    expect(text).not.toContain("$0.00");
  });
});
