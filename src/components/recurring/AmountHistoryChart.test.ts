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
    { date: "2026-08-27", amountCents: WEEK, perPayday: null, expectedCents: WEEK },
    { date: "2026-09-23", amountCents: WEEK * 4, perPayday: { paydays: 4, cents: WEEK }, expectedCents: WEEK },
    { date: "2026-10-01", amountCents: 120000, perPayday: null, expectedCents: WEEK },
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

  test("one rate for every row: the caption names it", () => {
    expect(html).toContain("against the expected $1,141.92");
  });
});

/**
 * ⚖️ EACH ROW AGAINST ITS OWN TIME'S RATE (owner decision 2026-10-08, §6A 55): his cash weeks at $1,047.00, his
 * payroll weeks at $1,141.92 (`AmountHistoryPoint.expectedCents`). 🔴 One expectation for all time read his Jun 4
 * cash week "vs expected -$94.92" — a week paid exactly what a cash week paid.
 */
describe("AmountHistoryChart — a rate with a dated history, in the table lens", () => {
  const CASH = 104700;
  const points = [
    { date: "2026-06-04", amountCents: CASH, perPayday: null, expectedCents: CASH },
    { date: "2026-09-23", amountCents: WEEK * 4, perPayday: { paydays: 4, cents: WEEK }, expectedCents: WEEK },
    { date: "2026-10-01", amountCents: 120000, perPayday: null, expectedCents: WEEK },
  ];
  const html = decode(
    renderToStaticMarkup(createElement(AmountHistoryChart, { points, expectedCents: WEEK, asTable: true })),
  );
  const rowOf = (date: string): string => {
    const at = html.indexOf(date);
    return html.slice(at, html.indexOf("</tr>", at));
  };

  test("the cash week is on plan against the cash rate, not $94.92 short of today's", () => {
    expect(rowOf("Jun 4, 2026")).toContain("on plan");
    expect(rowOf("Jun 4, 2026")).not.toContain("-$94.92");
  });

  test("a payroll week is still measured against the payroll rate", () => {
    expect(rowOf("Sep 23, 2026")).toContain("on plan");
    expect(rowOf("Oct 1, 2026")).toContain("+$58.08");
  });

  test("the caption does not claim one expected amount for every row", () => {
    expect(html).toContain("against the amount each was expected to be on its own day");
    expect(html).not.toContain("against the expected $1,141.92");
  });
});
