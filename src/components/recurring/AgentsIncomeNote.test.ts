import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import { AgentsIncomeNote } from "./ForecastCard";

const words = (agents: MonthForecast["agentsIncome"]): string =>
  renderToStaticMarkup(createElement(AgentsIncomeNote, { agents }))
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * ⚖️ Owner decision 2026-09-28 (§6A 27): what the agent's own account is paid is not his income, so no line of the
 * forecast carries it — and net worth holds the agent's money, so both EOM net worth figures still count it
 * (`MonthForecast.agentsIncome`). Without this sentence those two figures move by money no row on the card names.
 * Each amount is named under its reading by the rule `OutsideCashNote` names its own by.
 */
describe("AgentsIncomeNote — the forecast card names what its EOM net worth counts and its Income does not", () => {
  test("no agent, or nothing projected for it: no note", () => {
    expect(words({ netCents: 0, committedNetCents: 0 })).toBe("");
  });

  test("a series of the agent's and no pace: one amount, under no reading", () => {
    expect(words({ netCents: 4, committedNetCents: 4 })).toBe(
      "EOM net worth counts the +$0.04 the agent's own account is projected to be paid by month end. " +
        "That is the agent's money, not your income: your net worth holds it, and Income and Net leave it out.",
    );
  });

  test("only the pace projects it: one amount, under the reading it belongs to", () => {
    expect(words({ netCents: 3, committedNetCents: 0 })).toBe(
      "EOM net worth at your recent pace counts the +$0.03 the agent's own account is projected to be paid by month end. " +
        "That is the agent's money, not your income: your net worth holds it, and Income and Net leave it out.",
    );
  });

  test("the two readings project different amounts: both, each under its reading", () => {
    expect(words({ netCents: 7, committedNetCents: 4 })).toBe(
      "EOM net worth counts what the agent's own account is projected to be paid by month end: " +
        "+$0.04 in the headline and +$0.07 at your recent pace. " +
        "That is the agent's money, not your income: your net worth holds it, and Income and Net leave it out.",
    );
  });

  test("no shape of the two halves prints a zero amount, and only two zeros print no note", () => {
    const halves = [0, -0, 4, 7];
    for (const netCents of halves) {
      for (const committedNetCents of halves) {
        const note = words({ netCents, committedNetCents });
        const shape = JSON.stringify({ netCents: Object.is(netCents, -0) ? "-0" : netCents, committedNetCents: Object.is(committedNetCents, -0) ? "-0" : committedNetCents });
        expect(note === "", shape).toBe(netCents === 0 && committedNetCents === 0);
        expect(note, shape).not.toMatch(/\$0\.00/);
      }
    }
  });
});
