import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import { AgentsCostsNote, ForecastCard } from "./ForecastCard";

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const words = (agents: MonthForecast["agentsCosts"]): string =>
  text(renderToStaticMarkup(createElement(AgentsCostsNote, { agents })));

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
    const halves = [0, -0, -435, -500, 65, 500];
    for (const netCents of halves) {
      for (const committedNetCents of halves) {
        const note = words({ netCents, committedNetCents });
        const shape = JSON.stringify({ netCents: Object.is(netCents, -0) ? "-0" : netCents, committedNetCents: Object.is(committedNetCents, -0) ? "-0" : committedNetCents });
        expect(note === "", shape).toBe(netCents === 0 && committedNetCents === 0);
        expect(note, shape).not.toMatch(/\$0\.00/);
        // a reading that nets to a credit is said so, plainly — and only then
        expect(/net to a credit/.test(note), shape).toBe(netCents > 0 || committedNetCents > 0);
        expect(/your net worth pays it/.test(note), shape).toBe(note !== "" && netCents <= 0 && committedNetCents <= 0);
      }
    }
  });
});

/**
 * ⚖️ Owner decision 2026-10-06 (§6A 39): a scheduled credit to the agent's cash is named by its category, so a monthly
 * refund of its Gold fee, filed in Fees, nets inside the agent's costs (`agentsSeriesBand`) — and a month whose refunds
 * come to more than its fees nets to a CREDIT. "Projected to pay +$5.00" would say the opposite of what happens: the
 * note says it plainly instead.
 */
describe("AgentsCostsNote — a month the agent's costs net to a credit", () => {
  test("one amount: what the agent's account gets back, and that its costs net to a credit", () => {
    expect(words({ netCents: 500, committedNetCents: 500 })).toBe(
      "EOM net worth counts the +$5.00 the agent's own account is projected to get back by month end, net of what it " +
        "pays: its costs net to a credit. " +
        "That is the agent's money, not your spending: your net worth holds it, and Spending and Net leave it out.",
    );
    expect(words({ netCents: 65, committedNetCents: 0 })).toBe(
      "EOM net worth at your recent pace counts the +$0.65 the agent's own account is projected to get back by month " +
        "end, net of what it pays: its costs net to a credit. " +
        "That is the agent's money, not your spending: your net worth holds it, and Spending and Net leave it out.",
    );
  });

  test("two amounts: each under its reading, and which of them nets to a credit", () => {
    expect(words({ netCents: -100, committedNetCents: 500 })).toBe(
      "EOM net worth counts what the agent's own account is projected to pay by month end, net of what it gets back: " +
        "+$5.00 in the headline and -$1.00 at your recent pace. " +
        "In the headline its costs net to a credit: it gets back more than it pays. " +
        "That is the agent's money, not your spending: your net worth pays or holds it, and Spending and Net leave it out.",
    );
    expect(words({ netCents: 65, committedNetCents: -500 })).toMatch(
      /At your recent pace its costs net to a credit: it gets back more than it pays\. .*pays or holds it/,
    );
    expect(words({ netCents: 65, committedNetCents: 500 })).toBe(
      "EOM net worth counts what the agent's own account is projected to pay by month end, net of what it gets back: " +
        "+$5.00 in the headline and +$0.65 at your recent pace. " +
        "On both readings its costs net to a credit: it gets back more than it pays. " +
        "That is the agent's money, not your spending: your net worth holds it, and Spending and Net leave it out.",
    );
  });
});

/** A running October with no line of his and nothing outside cash — every figure on the card but the agent's at rest. */
const october = (agentsCosts: MonthForecast["agentsCosts"]): MonthForecast => {
  const reading = (agentsCents: number) => ({
    incomeCents: 0,
    spendCents: 0,
    netCents: 0,
    eomCashCents: 392_640,
    // net worth today + the net + what the agent's account pays (`MonthForecast.agentsCosts`)
    eomNetWorthCents: 494_741 + agentsCents,
  });
  const pace = reading(agentsCosts.netCents);
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
    committed: reading(agentsCosts.committedNetCents),
    components: [],
    unbankedIncome: { totalCents: 0, occurrenceCount: 0, checkedOccurrenceCount: 0, frontier: { kind: "unchecked" }, names: [] },
    outsideCash: { netCents: 0, committedNetCents: 0, accountNames: [] },
    agentsIncome: { netCents: 0, committedNetCents: 0 },
    agentsCosts,
  };
};

const card = (agentsCosts: MonthForecast["agentsCosts"]): string =>
  text(renderToStaticMarkup(createElement(ForecastCard, { forecast: october(agentsCosts) })));

/**
 * 🔴 The sentence above is a component, and nothing proved the card prints it: `ForecastCard` without
 * `<AgentsCostsNote …/>` left every test green while both EOM net worth figures moved by money no row on the card
 * named. Read off the card itself, as /recurring renders it.
 */
describe("ForecastCard — the card prints the agent's costs its EOM net worth counts", () => {
  test("a month the agent's account is projected to pay in: the note, once, on the card", () => {
    for (const agents of [
      { netCents: -500, committedNetCents: -500 },
      { netCents: -435, committedNetCents: 0 },
      { netCents: -935, committedNetCents: -500 },
      // §6A 39: refunds of the agent's fee, filed in Fees, netting its costs to a credit
      { netCents: 65, committedNetCents: 500 },
    ]) {
      const note = words(agents);
      expect(note, JSON.stringify(agents)).not.toBe("");
      expect(card(agents).split(note).length - 1, JSON.stringify(agents)).toBe(1);
    }
  });

  test("a month it pays nothing in: no word of it", () => {
    expect(card({ netCents: 0, committedNetCents: 0 })).not.toMatch(/agent's own account is projected to pay/);
  });
});
