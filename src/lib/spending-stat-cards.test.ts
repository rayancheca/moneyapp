import { describe, expect, it } from "vitest";
import { spendingStatCards } from "./spending-stat-cards";
import type { PeriodTotals } from "@/services/spending";
import type { DateRange } from "@/services/analytics";

const RANGE: DateRange = { from: "2026-01-01", to: "2026-01-31" };

function totals(overrides: Partial<PeriodTotals> = {}): PeriodTotals {
  return {
    earnedCents: 1_777_600,
    spentCents: 480_800,
    refundsCents: 0,
    netCents: 1_296_800,
    savingsRatePct: 73,
    ...overrides,
  };
}

describe("spendingStatCards", () => {
  it("shows the four core cards (no Refunds) when there are no refunds", () => {
    const cards = spendingStatCards(totals({ refundsCents: 0 }), RANGE);
    expect(cards.map((c) => c.key)).toEqual(["earned", "spent", "net", "savings"]);
  });

  it("inserts a Refunds card right after Spent when refundsCents > 0", () => {
    const cards = spendingStatCards(totals({ refundsCents: 1_706_800 }), RANGE);
    expect(cards.map((c) => c.key)).toEqual(["earned", "spent", "refunds", "net", "savings"]);
  });

  it("never shows a Refunds card for a zero or negative refunds total", () => {
    expect(spendingStatCards(totals({ refundsCents: 0 }), RANGE).some((c) => c.key === "refunds")).toBe(
      false,
    );
    // refundsCents is defined as a positive sum; guard against a stray negative anyway
    expect(spendingStatCards(totals({ refundsCents: -50 }), RANGE).some((c) => c.key === "refunds")).toBe(
      false,
    );
  });

  it("builds the Refunds card as an exact drill-down to the refund rows (spending + flow=in)", () => {
    const refunds = spendingStatCards(totals({ refundsCents: 1_706_800 }), RANGE).find(
      (c) => c.key === "refunds",
    )!;
    expect(refunds.label).toBe("Refunds");
    expect(refunds.cents).toBe(1_706_800);
    expect(refunds.flow).toBe(true); // money-in, shown signed + positive tone
    expect(refunds.mobileFull).toBe(true); // spans the 2-col mobile grid so it isn't an orphan
    expect(refunds.href).toBe(
      "/transactions?category=spending&from=2026-01-01&to=2026-01-31&flow=in",
    );
    expect(refunds.ariaLabel).toContain("Refunds this period");
    expect(refunds.ariaLabel).toContain("back");
  });

  it("links Earned and Spent to their kind-scoped, reconciling ledger lists", () => {
    const cards = spendingStatCards(totals(), RANGE);
    const earned = cards.find((c) => c.key === "earned")!;
    const spent = cards.find((c) => c.key === "spent")!;
    expect(earned.href).toBe("/transactions?category=income&from=2026-01-01&to=2026-01-31");
    expect(spent.href).toBe(
      "/transactions?category=spending&from=2026-01-01&to=2026-01-31&flow=out",
    );
    expect(spent.ariaLabel).toContain("gross");
  });

  it("explains Net's composition only when refunds are present", () => {
    const withRefunds = spendingStatCards(totals({ refundsCents: 1_000 }), RANGE).find(
      (c) => c.key === "net",
    )!;
    const noRefunds = spendingStatCards(totals({ refundsCents: 0 }), RANGE).find(
      (c) => c.key === "net",
    )!;
    expect(withRefunds.delta).toBe("income + refunds − spent");
    expect(noRefunds.delta).toBeUndefined();
  });

  it("announces a negative Net as negative", () => {
    const net = spendingStatCards(totals({ netCents: -1_226_000 }), RANGE).find(
      (c) => c.key === "net",
    )!;
    expect(net.flow).toBe(true);
    expect(net.ariaLabel).toContain("negative");
  });

  it("renders the savings rate as a percent, naming what it was struck against", () => {
    const kept = spendingStatCards(totals({ savingsRatePct: 73, netCents: 100, earnedCents: 1_776_000 }), RANGE).find(
      (c) => c.key === "savings",
    )!;
    expect(kept.text).toBe("73%");
    expect(kept.muted).toBeFalsy();
    expect(kept.delta).toBe("kept · of $17,760.00 income");

    const overspent = spendingStatCards(
      totals({ savingsRatePct: -12, netCents: -100, earnedCents: 1_776_000 }),
      RANGE,
    ).find((c) => c.key === "savings")!;
    expect(overspent.delta).toBe("overspent · of $17,760.00 income");
  });

  /*
   * ❓ OWNER DECISION, 2026-09-04: NAME THE DENOMINATOR, do not suppress the
   * figure. Measured on `?from=2026-07-01&to=2026-07-31`:
   *
   *     EARNED $52.95 · SPENT $10,353.96 · REFUNDS +$113.11 · NET -$10,187.90
   *     SAVINGS RATE  -19240.6%   overspent
   *
   * July's recorded income is $52.95 of dividends and interest; the cash job's
   * $5,235.00 never reached a bank, which the note under the cards says in
   * full. Refusing the rate whenever there is unbanked pay would refuse it on
   * every recent window, and his decision of 2026-08-21 is that both readings
   * stand. Nothing here was wrong — only unreadable.
   */
  it("makes a rate struck against almost nothing readable rather than refusing it", () => {
    const july = spendingStatCards(
      totals({ savingsRatePct: -19_240.6, netCents: -1_018_790, earnedCents: 5_295 }),
      RANGE,
    ).find((c) => c.key === "savings")!;
    expect(july.text).toBe("-19240.6%");
    expect(july.delta).toBe("overspent · of $52.95 income");
    expect(july.ariaLabel).toContain("of 52.95 dollars of income");
  });

  /*
   * 🔴 S22 — ONE WORD, TWO POPULATIONS. This card is `periodTotals.earnedCents`:
   * every positive row in an income-kind category. /summary's "Earned" is wages,
   * tutoring and savings interest only, and files financial aid and
   * reimbursements under "Money in that you did not earn". Measured on the real
   * ledger 2026-09-15: /spending?period=2024 "Earned $32,717.06" and "Savings
   * rate 14.9% · kept · of $32,717.06 earned" — over a base holding a $14,171.00
   * financial-aid refund. Owner decision 2026-09-14: this population is called
   * Income; /summary keeps its narrow Earned. No figure, base or link moves.
   */
  it("names the income-kind population Income on every card that reads it, and never Earned", () => {
    const cards = spendingStatCards(totals({ refundsCents: 1_000, earnedCents: 3_271_706, netCents: 486_966, savingsRatePct: 14.9 }), RANGE);
    const income = cards.find((c) => c.key === "earned")!;
    expect(income.label).toBe("Income");
    expect(income.ariaLabel).toBe("Income this period. 32717.06 dollars. View income transactions.");
    expect(income.href).toBe("/transactions?category=income&from=2026-01-01&to=2026-01-31");
    const net = cards.find((c) => c.key === "net")!;
    expect(net.ariaLabel).toContain("View the income and spending behind it.");
    const savings = cards.find((c) => c.key === "savings")!;
    expect(savings.delta).toBe("kept · of $32,717.06 income");
    expect(savings.ariaLabel).toBe("Savings rate 14.9 percent, of 32717.06 dollars of income.");
    for (const c of cards) {
      expect(`${c.label} ${c.delta ?? ""} ${c.ariaLabel}`, c.key).not.toMatch(/earn/i);
    }
  });

  it("shows an em-dash (muted) savings rate with no-income delta when there is no income", () => {
    const savings = spendingStatCards(totals({ savingsRatePct: null }), RANGE).find(
      (c) => c.key === "savings",
    )!;
    expect(savings.text).toBe("—");
    expect(savings.muted).toBe(true);
    expect(savings.delta).toBe("no income yet");
  });

  /*
   * ⚖️ Decisions 64 + 72: a window holding no spending row, not one of whose elapsed days is read by the day every
   * account he spends from is imported through, has no Spent — the cash-flow table, the chart's hover and the heatmap
   * on the same page print "—" for it (`CashFlow.spendingUnaccounted`). 🔴 Measured on his ledger copy 2026-10-13
   * (review of 516d6fc): `/spending?period=2026-09-23` read "Income $4,567.68 · Spent $0.00 · Net +$4,567.68 · Savings
   * rate 100%" over a table row "$4,567.68 — —" and a heatmap calling the day "nothing found so far — spending
   * imported through Aug 12". Latent on his copy 2026-10-21 (the card statements reach Oct): 0 of 81 day and week
   * windows past Aug 12 hold income with no spending found.
   */
  it("dashes Spent, Net and the savings rate where no spending has been found past the day it is read through", () => {
    const fact = "spending imported through Aug 12";
    const cards = spendingStatCards(
      totals({ earnedCents: 456_768, spentCents: 0, refundsCents: 0, netCents: 456_768, savingsRatePct: 100 }),
      RANGE,
      fact,
    );
    const by = (key: string) => cards.find((c) => c.key === key)!;
    // what was found keeps its figure
    expect(by("earned").cents).toBe(456_768);
    for (const key of ["spent", "net", "savings"]) {
      expect(by(key), key).toMatchObject({ text: "—", muted: true });
      expect(by(key).cents, key).toBeUndefined();
    }
    expect(by("spent").delta).toBe("nothing found so far — spending imported through Aug 12");
    expect(by("spent").ariaLabel).toBe(
      "Spent this period: nothing found so far — spending imported through Aug 12. View spending transactions.",
    );
    expect(by("net").ariaLabel).toBe("Net this period: no figure until spending is found. View the income and spending behind it.");
    // ⚖️ the base is still named (owner decision 2026-09-04) — the rate is what waits
    expect(by("savings").delta).toBe("of $4,567.68 income");
    expect(by("savings").ariaLabel).toBe("Savings rate unavailable until spending is found, of 4567.68 dollars of income.");
    for (const c of cards) expect(`${c.label} ${c.text ?? ""} ${c.delta ?? ""}`, c.key).not.toMatch(/\$0\.00|100%/);
    // the links are the same lists: a dash still opens the rows behind it
    expect(cards.map((c) => c.href)).toEqual(spendingStatCards(totals(), RANGE).map((c) => c.href));
    // …and a window where spending was found, or a day was read, prints its figures as it always has
    expect(spendingStatCards(totals(), RANGE, null)).toEqual(spendingStatCards(totals(), RANGE));
  });

  /*
   * ⚖️ §6A 68 (2026-10-13), one rule on every caller: a window with no income found, not one of whose days is checked
   * where his pay lands, has no Income — the dashboard's "Income recorded in Oct 2026" and /budgets' "in so far" print
   * "—" for it (`CashFlow.incomeUnread`, asked by `noIncomeDayReadOf`). 🔴 Measured on his ledger copy 2026-10-21:
   * `/spending` carded October "INCOME $0.00 · SPENT $1,603.00 · NET -$1,603.00 · SAVINGS RATE — no income yet", Wells
   * Fargo checked through Sep 24.
   */
  it("dashes Income, Net and the savings rate where no day is checked where the pay lands, under the dashboard's words", () => {
    const note = "Not one day of October 2026 has been checked in the accounts that pay lands in, so nothing is shown.";
    const october = totals({ earnedCents: 0, spentCents: 160_300, refundsCents: 0, netCents: -160_300, savingsRatePct: null });
    const cards = spendingStatCards(october, RANGE, null, { incomeUnread: note });
    const by = (key: string) => cards.find((c) => c.key === key)!;
    for (const key of ["earned", "net", "savings"]) {
      expect(by(key), key).toMatchObject({ text: "—", muted: true });
      expect(by(key).cents, key).toBeUndefined();
    }
    expect(by("earned").delta).toBe(note);
    expect(by("earned").ariaLabel).toBe(`Income this period: no figure. ${note} View income transactions.`);
    expect(by("net").ariaLabel).toBe("Net this period: no figure until income is found. View the income and spending behind it.");
    expect(by("savings").delta).toBe("until income is found");
    expect(by("savings").ariaLabel).toBe("Savings rate unavailable until income is found.");
    // what was found keeps its figure
    expect(by("spent").cents).toBe(160_300);
    for (const c of cards) {
      expect(`${c.label} ${c.text ?? ""} ${c.delta ?? ""} ${c.ariaLabel}`, c.key).not.toMatch(/\$0\.00|no income yet|\b0 dollars/);
    }
    // the links are the same lists
    expect(cards.map((c) => c.href)).toEqual(spendingStatCards(october, RANGE).map((c) => c.href));
    // …and Income found, or a day checked, prints as it always has
    expect(spendingStatCards(totals(), RANGE, null, { incomeUnread: null })).toEqual(spendingStatCards(totals(), RANGE));
  });

  it("with neither Spent nor Income found, Net and the rate wait for both", () => {
    const cards = spendingStatCards(totals({ earnedCents: 0, spentCents: 0, netCents: 0, savingsRatePct: null }), RANGE, "spending imported through Aug 12", {
      incomeUnread: "Not one day of October 2026 has been checked in the accounts that pay lands in, so nothing is shown.",
    });
    const by = (key: string) => cards.find((c) => c.key === key)!;
    expect(by("net").ariaLabel).toBe(
      "Net this period: no figure until spending and income are found. View the income and spending behind it.",
    );
    expect(by("savings").delta).toBe("until spending and income are found");
  });

  /*
   * ⚖️ Decision 72 (2026-10-13): a total over days not every account he spends from is read for keeps its figure and
   * wears "partly read", with /budgets' line under it — the period proof's own (`Provenance.partlyRead`, the chip "Where
   * it went" wears on the same page). Net and the savings rate are Spent's arithmetic over the same days, and Refunds is
   * read from the same accounts: each wears it where it prints a figure; the line sits once, under Spent. 🔴 Measured on
   * his ledger copy 2026-10-21: `/spending` carded October "SPENT $1,603.00" bare over "Where it went · partly read ·
   * spending imported through Aug 12 · 21 days of this period unaccounted".
   */
  it("marks the spending figures partly read, with the period proof's line under Spent", () => {
    const partlyRead = { uncoveredDays: 21, line: "spending imported through Aug 12 · 21 days of this period unaccounted" };
    const september = totals({
      earnedCents: 617_788,
      spentCents: 862_388,
      refundsCents: 1_568,
      netCents: -243_032,
      savingsRatePct: -39.3,
    });
    const cards = spendingStatCards(september, RANGE, null, { partlyRead });
    const by = (key: string) => cards.find((c) => c.key === key)!;
    for (const key of ["spent", "refunds", "net", "savings"]) expect(by(key).partlyRead, key).toBe(true);
    // ⛔ Income is read where the pay lands, not by spending's day
    expect(by("earned").partlyRead).toBeUndefined();
    // the figures stand
    const figures = [by("spent").cents, by("refunds").cents, by("net").cents, by("savings").text];
    expect(figures).toEqual([862_388, 1_568, -243_032, "-39.3%"]);
    expect(by("spent").delta).toBe(partlyRead.line);
    expect(by("spent").ariaLabel).toBe(
      `Spent this period, gross. 8623.88 dollars, partly read: ${partlyRead.line}. View spending transactions.`,
    );
    expect(by("refunds").ariaLabel).toBe("Refunds this period. 15.68 dollars back, partly read. View refund transactions.");
    expect(by("net").ariaLabel).toBe(
      "Net this period. negative 2430.32 dollars, partly read. View the income and spending behind it.",
    );
    expect(by("savings").ariaLabel).toBe("Savings rate -39.3 percent, of 6177.88 dollars of income, partly read.");
    // a window read in full wears nothing new
    expect(spendingStatCards(september, RANGE, null, { partlyRead: null })).toEqual(spendingStatCards(september, RANGE));
  });

  it("a dash wears no chip: there is no figure to call partly read", () => {
    const partlyRead = { uncoveredDays: 21, line: "spending imported through Aug 12 · 21 days of this period unaccounted" };
    const cards = spendingStatCards(
      totals({ earnedCents: 0, spentCents: 160_300, netCents: -160_300, savingsRatePct: null }),
      RANGE,
      null,
      {
        partlyRead,
        incomeUnread: "Not one day of October 2026 has been checked in the accounts that pay lands in, so nothing is shown.",
      },
    );
    expect(cards.filter((c) => c.partlyRead).map((c) => c.key)).toEqual(["spent"]);
  });

  /*
   * ⚖️ Decision 72, extended to income totals (ruled implied 2026-10-14): Income is a total over a window too, read by
   * the accounts his income landed in — the Income category page's reading of the same days (`allIncomePartlyRead`) —
   * and Net and the savings rate are its arithmetic as much as Spent's. 🔴 Measured on his ledger copy 2026-10-21
   * (review of 827e9a5): `/spending?period=2026-09` carded "Income $6,177.88" bare beside Spent, Refunds, Net and the
   * rate wearing "partly read", while `/categories/<Income>` for the same days read "partly read · income imported
   * through Jul 31 · 30 days of this period unaccounted".
   */
  it("marks Income partly read by its own reading, with its line under it, and Net and the rate with it", () => {
    const incomePartlyRead = { uncoveredDays: 30, line: "income imported through Jul 31 · 30 days of this period unaccounted" };
    const september = totals({
      earnedCents: 617_788,
      spentCents: 862_388,
      refundsCents: 1_568,
      netCents: -243_032,
      savingsRatePct: -39.3,
    });
    const cards = spendingStatCards(september, RANGE, null, { incomePartlyRead });
    const by = (key: string) => cards.find((c) => c.key === key)!;
    expect(cards.filter((c) => c.partlyRead).map((c) => c.key)).toEqual(["earned", "net", "savings"]);
    // ⛔ Spent and Refunds are read where he spends, not by income's day
    expect(by("spent").delta).toBeUndefined();
    expect(by("earned").cents).toBe(617_788);
    expect(by("earned").delta).toBe(incomePartlyRead.line);
    expect(by("earned").ariaLabel).toBe(
      `Income this period. 6177.88 dollars, partly read: ${incomePartlyRead.line}. View income transactions.`,
    );
    expect(by("net").ariaLabel).toBe(
      "Net this period. negative 2430.32 dollars, partly read. View the income and spending behind it.",
    );
    expect(by("savings").ariaLabel).toBe("Savings rate -39.3 percent, of 6177.88 dollars of income, partly read.");

    // both read in part: every figure wears it, and each line sits under its own card
    const spendingPartlyRead = { uncoveredDays: 30, line: "spending imported through Aug 12 · 30 days of this period unaccounted" };
    const both = spendingStatCards(september, RANGE, null, { incomePartlyRead, partlyRead: spendingPartlyRead });
    expect(both.filter((c) => c.partlyRead).map((c) => c.key)).toEqual(["earned", "spent", "refunds", "net", "savings"]);
    expect(both.find((c) => c.key === "earned")!.delta).toBe(incomePartlyRead.line);
    expect(both.find((c) => c.key === "spent")!.delta).toBe(spendingPartlyRead.line);

    // …a dash wears none, and a window read in full wears nothing new
    const october = totals({ earnedCents: 0, spentCents: 160_300, netCents: -160_300, savingsRatePct: null });
    const dashed = spendingStatCards(october, RANGE, null, {
      incomePartlyRead,
      incomeUnread: "Not one day of October 2026 has been checked in the accounts that pay lands in, so nothing is shown.",
    });
    expect(dashed.filter((c) => c.partlyRead)).toEqual([]);
    expect(spendingStatCards(september, RANGE, null, { incomePartlyRead: null })).toEqual(spendingStatCards(september, RANGE));
  });
});
