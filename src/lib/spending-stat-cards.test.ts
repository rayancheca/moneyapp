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
});
