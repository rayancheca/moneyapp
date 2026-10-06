import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import { AgentsIncomeNote, ForecastCard } from "./ForecastCard";

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const words = (agents: MonthForecast["agentsIncome"]): string =>
  text(renderToStaticMarkup(createElement(AgentsIncomeNote, { agents })));

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
    const halves = [0, -0, 4, 7, -496, -500];
    for (const netCents of halves) {
      for (const committedNetCents of halves) {
        const note = words({ netCents, committedNetCents });
        const shape = JSON.stringify({ netCents: Object.is(netCents, -0) ? "-0" : netCents, committedNetCents: Object.is(committedNetCents, -0) ? "-0" : committedNetCents });
        expect(note === "", shape).toBe(netCents === 0 && committedNetCents === 0);
        expect(note, shape).not.toMatch(/\$0\.00/);
        // a reading that nets below zero is said so, plainly — and only then
        expect(/nets negative/.test(note), shape).toBe(netCents < 0 || committedNetCents < 0);
        expect(/your net worth holds it/.test(note), shape).toBe(note !== "" && netCents >= 0 && committedNetCents >= 0);
      }
    }
  });
});

/**
 * ⚖️ Owner decision 2026-10-06 (§6A 43): a schedule of the agent's filed in an income category that takes money out — a
 * clawback — lowers the agent's income (`agentsSeriesBand`), so a month whose clawbacks come to more than the agent is
 * paid nets BELOW ZERO. "Projected to be paid -$4.96" would say the opposite of what happens, so the note says it
 * plainly: what the account gives back, which reading nets negative, and that net worth pays it.
 */
describe("AgentsIncomeNote — a month the agent's income nets negative", () => {
  test("one amount: what the agent's account gives back, and that its income nets negative", () => {
    expect(words({ netCents: -496, committedNetCents: -496 })).toBe(
      "EOM net worth counts the -$4.96 the agent's own account is projected to give back by month end, net of what it " +
        "is paid: its income nets negative. " +
        "That is the agent's money, not your income: your net worth pays it, and Income and Net leave it out.",
    );
    expect(words({ netCents: 0, committedNetCents: -500 })).toBe(
      "EOM net worth in the headline counts the -$5.00 the agent's own account is projected to give back by month end, " +
        "net of what it is paid: its income nets negative. " +
        "That is the agent's money, not your income: your net worth pays it, and Income and Net leave it out.",
    );
  });

  test("two amounts: each under its reading, and which of them nets negative", () => {
    expect(words({ netCents: 3, committedNetCents: -500 })).toBe(
      "EOM net worth counts what the agent's own account is projected to be paid by month end, net of what it gives " +
        "back: -$5.00 in the headline and +$0.03 at your recent pace. " +
        "In the headline its income nets negative: it gives back more than it is paid. " +
        "That is the agent's money, not your income: your net worth holds or pays it, and Income and Net leave it out.",
    );
    expect(words({ netCents: -496, committedNetCents: 4 })).toMatch(
      /At your recent pace its income nets negative: it gives back more than it is paid\. .*holds or pays it/,
    );
    expect(words({ netCents: -493, committedNetCents: -496 })).toBe(
      "EOM net worth counts what the agent's own account is projected to be paid by month end, net of what it gives " +
        "back: -$4.96 in the headline and -$4.93 at your recent pace. " +
        "On both readings its income nets negative: it gives back more than it is paid. " +
        "That is the agent's money, not your income: your net worth pays it, and Income and Net leave it out.",
    );
  });
});

/** A running October with no line of his and nothing outside cash — every figure on the card but the agent's at rest. */
const october = (agentsIncome: MonthForecast["agentsIncome"]): MonthForecast => {
  const reading = (agentsCents: number) => ({
    incomeCents: 0,
    spendCents: 0,
    netCents: 0,
    eomCashCents: 392_640,
    // net worth today + the net + what the agent's account is paid (`MonthForecast.agentsIncome`)
    eomNetWorthCents: 494_741 + agentsCents,
  });
  const pace = reading(agentsIncome.netCents);
  return {
    today: "2026-10-05",
    monthKey: "2026-10",
    basis: "current",
    monthStart: "2026-10-01",
    monthEnd: "2026-10-31",
    daysInMonth: 31,
    remainingDays: 27,
    projectedIncomeCents: pace.incomeCents,
    projectedSpendCents: pace.spendCents,
    projectedNetCents: pace.netCents,
    projectedEomCashCents: pace.eomCashCents,
    projectedEomNetWorthCents: pace.eomNetWorthCents,
    committed: reading(agentsIncome.committedNetCents),
    components: [],
    unbankedIncome: { totalCents: 0, occurrenceCount: 0, checkedOccurrenceCount: 0, frontier: { kind: "unchecked" }, names: [] },
    outsideCash: { netCents: 0, committedNetCents: 0, accountNames: [] },
    agentsIncome,
    agentsCosts: { netCents: 0, committedNetCents: 0 },
  };
};

const card = (agentsIncome: MonthForecast["agentsIncome"]): string =>
  text(renderToStaticMarkup(createElement(ForecastCard, { forecast: october(agentsIncome) })));

/** Read off the card itself, as /recurring renders it — the sentence is a component, and the card must print it. */
describe("ForecastCard — the card prints the agent's income its EOM net worth counts, below zero too", () => {
  test("a month the agent's account is paid, or gives back more than it is paid: the note, once, on the card", () => {
    for (const agents of [
      { netCents: 4, committedNetCents: 4 },
      { netCents: 7, committedNetCents: 4 },
      // §6A 43: a clawback filed in Interest, netting the agent's income below zero
      { netCents: -496, committedNetCents: -496 },
      { netCents: 3, committedNetCents: -500 },
    ]) {
      const note = words(agents);
      expect(note, JSON.stringify(agents)).not.toBe("");
      expect(card(agents).split(note).length - 1, JSON.stringify(agents)).toBe(1);
    }
  });
});
