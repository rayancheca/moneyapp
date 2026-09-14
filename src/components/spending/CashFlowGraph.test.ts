import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CashCumulativePoint } from "@/lib/cash-flow-cumulative";
import { RunningTotalTooltip } from "./CashFlowGraph";

const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");

/**
 * September 2026 on the owner's ledger, 2026-09-14, read-only: $1,431.05 spent
 * through Sep 12, the newest active row; nothing earned or refunded. Sep 13 and
 * later carry the same running totals, because nothing past Sep 12 has been
 * imported — and the tooltip said "Through 13 … Spent $1,431.05" of a day no
 * import has reached, "Through 30" of one that has not happened.
 */
const point = (key: string, label: string): CashCumulativePoint => ({
  key,
  label,
  earnedCum: 0,
  refundsCum: 0,
  spentCum: 143_105,
  netCum: -143_105,
  ghostCum: null,
  ghostWhole: false,
});

function render(p: CashCumulativePoint, unreached: Parameters<typeof RunningTotalTooltip>[0]["unreached"]): string {
  return textOf(
    renderToStaticMarkup(createElement(RunningTotalTooltip, { point: p, unreached, hasRefunds: false, priorLabel: null })),
  );
}

describe("CashFlowGraph's tooltip — a running total is only as far as the ledger reads", () => {
  test("the newest imported day states its running totals", () => {
    const text = render(point("2026-09-12", "12"), null);
    expect(text).toContain("Through 12");
    expect(text).toContain("$1,431.05");
  });

  test("a day not imported yet does not claim a running total through it", () => {
    const text = render(point("2026-09-13", "13"), "after-records");
    expect(text).not.toContain("Through");
    expect(text).not.toContain("$1,431.05");
    expect(text).toContain("not imported yet");
  });

  test("nor does a day that has not happened, or one before the records begin", () => {
    expect(render(point("2026-09-30", "30"), "future")).toContain("has not happened yet");
    expect(render(point("2026-09-30", "30"), "future")).not.toContain("Through");
    expect(render(point("2022-08-24", "24"), "before-records")).toContain("before your records begin");
  });

  /* ⛔ the prior period's figure is a fact about THAT period, and stays (owner decision E1a) */
  test("the prior period's running total is still given beside an unreached point", () => {
    const text = renderToStaticMarkup(
      createElement(RunningTotalTooltip, {
        point: { ...point("2026-09-13", "13"), ghostCum: 3_451 },
        unreached: "after-records",
        hasRefunds: false,
        priorLabel: "August 2026",
      }),
    );
    expect(textOf(text)).toContain("Spent by here, August 2026");
    expect(textOf(text)).toContain("$34.51");
  });
});
