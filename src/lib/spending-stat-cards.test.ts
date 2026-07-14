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

  it("renders the savings rate as a percent with a kept/overspent delta", () => {
    const kept = spendingStatCards(totals({ savingsRatePct: 73, netCents: 100 }), RANGE).find(
      (c) => c.key === "savings",
    )!;
    expect(kept.text).toBe("73%");
    expect(kept.muted).toBeFalsy();
    expect(kept.delta).toBe("kept");

    const overspent = spendingStatCards(totals({ savingsRatePct: -12, netCents: -100 }), RANGE).find(
      (c) => c.key === "savings",
    )!;
    expect(overspent.delta).toBe("overspent");
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
