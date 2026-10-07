import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AmountHistoryChart } from "./AmountHistoryChart";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const WEEK = 114192;

/**
 * 🔴 The series page compared his Sep 23 lump of $4,567.68 with ONE week and
 * printed "vs expected +$3,425.76", one tab over from a calendar drawing the same
 * row `paid` as four weeks of pay. The history reads it as the calendar does
 * (`lib/per-payday`): four paydays at $1,141.92, on plan.
 */
describe("AmountHistoryChart — a lump of pay, in the table lens", () => {
  const points = [
    { date: "2026-08-27", amountCents: WEEK, perPayday: null },
    { date: "2026-09-23", amountCents: WEEK * 4, perPayday: { paydays: 4, cents: WEEK } },
    { date: "2026-10-01", amountCents: 120000, perPayday: null },
  ];
  const html = decode(
    renderToStaticMarkup(createElement(AmountHistoryChart, { points, expectedCents: WEEK, asTable: true })),
  );
  const rowOf = (date: string): string => {
    const at = html.indexOf(date);
    return html.slice(at, html.indexOf("</tr>", at));
  };

  test("the lump's row keeps the deposit's amount and says it is four paydays at a week each", () => {
    expect(rowOf("Sep 23, 2026")).toContain("+$4,567.68");
    expect(rowOf("Sep 23, 2026")).toContain("4 paydays at $1,141.92 each");
  });

  test("it is on plan — compared per payday, as the calendar grades it", () => {
    expect(rowOf("Sep 23, 2026")).toContain("on plan");
    expect(rowOf("Sep 23, 2026")).not.toContain("+$3,425.76");
  });

  test("a raise still reads as the difference it is", () => {
    expect(rowOf("Oct 1, 2026")).toContain("+$58.08");
  });
});
