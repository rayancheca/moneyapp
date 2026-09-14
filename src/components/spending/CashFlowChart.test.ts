import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { CashFlow, SpendingProjection } from "@/services/spending";
import { CashFlowChart } from "./CashFlowChart";

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
  pace: { elapsedFraction: 14 / 30, actualToDateCents: 143_105, projectedCents: 306_654, avgPerBucketCents: 10_222 },
};
const PROJECTION: SpendingProjection = {
  projectedSpendCents: 306_654,
  paceBasis: "pace from 14 of 30 days elapsed",
  paceConfidence: 0.65,
  paceUncoveredDays: 2,
  prior: null,
};

/** the markup's text, which is what a screen reader reads: tags, attributes and comments stripped */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");
const occurrences = (text: string, phrase: string): number => text.split(phrase).length - 1;

function render(): string {
  return renderToStaticMarkup(
    createElement(CashFlowChart, { data: SEPTEMBER, projection: PROJECTION, paceWindowName: "September 2026" }),
  );
}

describe("CashFlowChart's pace readout", () => {
  /**
   * 🔴 The basis — also the sr-only span after the figure — carried the
   * not-imported clause, and the clause was its own visible part as well. A
   * screen reader heard it twice: "On pace for at least $3,066.54 — pace from 14
   * of 30 days elapsed; 2 days of September 2026 not imported yet spent this
   * period · at least $1,431.05 so far · 2 days of September 2026 not imported yet".
   */
  test("says the unimported days once, to the eye and to a screen reader alike", () => {
    const html = render();
    const text = textOf(html);
    expect(occurrences(text, "not imported yet")).toBe(1);
    expect(text).toContain("On pace for at least $3,066.54 — pace from 14 of 30 days elapsed spent this period");
    expect(text).toContain("at least $1,431.05 so far · 2 days of September 2026 not imported yet");

    const srOnly = /<span class="sr-only">(.*?)<\/span>/.exec(html)?.[1];
    expect(srOnly === undefined ? null : textOf(srOnly)).toBe(" — pace from 14 of 30 days elapsed");
  });

  test("the method stays on hover, without the clause the readout already shows", () => {
    expect(render()).toContain('title="pace from 14 of 30 days elapsed"');
  });
});
