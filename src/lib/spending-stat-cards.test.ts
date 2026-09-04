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
    expect(withRefunds.delta).toBe("earned + refunds − spent");
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
    expect(kept.delta).toBe("kept · of $17,760.00 earned");

    const overspent = spendingStatCards(
      totals({ savingsRatePct: -12, netCents: -100, earnedCents: 1_776_000 }),
      RANGE,
    ).find((c) => c.key === "savings")!;
    expect(overspent.delta).toBe("overspent · of $17,760.00 earned");
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
    expect(july.delta).toBe("overspent · of $52.95 earned");
    expect(july.ariaLabel).toContain("of 52.95 dollars earned");
  });

  it("shows an em-dash (muted) savings rate with no-income delta when there is no income", () => {
    const savings = spendingStatCards(totals({ savingsRatePct: null }), RANGE).find(
      (c) => c.key === "savings",
    )!;
    expect(savings.text).toBe("—");
    expect(savings.muted).toBe(true);
    expect(savings.delta).toBe("no income yet");
  });
});
