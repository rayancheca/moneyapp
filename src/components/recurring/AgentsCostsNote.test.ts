import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import { AgentsCostsNote } from "./ForecastCard";

const words = (agents: MonthForecast["agentsCosts"]): string =>
  renderToStaticMarkup(createElement(AgentsCostsNote, { agents }))
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * ⚖️ Owner decision 2026-10-02 (§6A 34): what the agent's own account pays is not his spending, so no line of the
 * forecast carries it — and net worth pays it, so both EOM net worth figures still count it
 * (`MonthForecast.agentsCosts`). Without this sentence those two figures move by money no row on the card names.
 * Each amount is named under its reading by the rule `OutsideCashNote` and `AgentsIncomeNote` name theirs by.
 */
describe("AgentsCostsNote — the forecast card names what its EOM net worth pays and its Spending does not", () => {
  test("no agent, or nothing projected for it: no note", () => {
    expect(words({ netCents: 0, committedNetCents: 0 })).toBe("");
  });

  test("only the pace projects it: one amount, under the reading it belongs to", () => {
    expect(words({ netCents: -435, committedNetCents: 0 })).toBe(
      "EOM net worth at your recent pace counts the -$4.35 the agent's own account is projected to pay by month end. " +
        "That is the agent's money, not your spending: your net worth pays it, and Spending and Net leave it out.",
    );
  });

  test("a schedule of the agent's and no pace: one amount, under no reading", () => {
    expect(words({ netCents: -500, committedNetCents: -500 })).toBe(
      "EOM net worth counts the -$5.00 the agent's own account is projected to pay by month end. " +
        "That is the agent's money, not your spending: your net worth pays it, and Spending and Net leave it out.",
    );
  });

  test("the two readings project different amounts: both, each under its reading", () => {
    expect(words({ netCents: -935, committedNetCents: -500 })).toBe(
      "EOM net worth counts what the agent's own account is projected to pay by month end: " +
        "-$5.00 in the headline and -$9.35 at your recent pace. " +
        "That is the agent's money, not your spending: your net worth pays it, and Spending and Net leave it out.",
    );
  });

  test("no shape of the two halves prints a zero amount, and only two zeros print no note", () => {
    const halves = [0, -0, -435, -500];
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
