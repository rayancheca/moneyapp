import { describe, expect, test } from "vitest";
import {
  combineCategoryForecast,
  seasonallyAdjust,
  SEASONAL_WEIGHT,
} from "./category-forecast";
import {
  projectRecurringDriven,
  projectTrailingAverage,
  type Projection,
} from "./projection";

// Money literals use _ separators: 180_000 = $1,800.00 (integer cents everywhere).

/** A minimal Projection literal for focused composition tests. */
function proj(overrides: Partial<Projection>): Projection {
  return {
    method: "trailingAverage",
    expectedTotalCents: 0,
    targetCents: null,
    basis: "test",
    confidence: 0.5,
    ...overrides,
  };
}

describe("seasonallyAdjust", () => {
  test("null seasonal prior leaves the discretionary projection untouched", () => {
    const disc = proj({ expectedTotalCents: 150_000, confidence: 0.6, basis: "avg of last 3 periods" });
    expect(seasonallyAdjust(disc, null)).toBe(disc);
  });

  test("blends the point estimate toward the year-ago figure by SEASONAL_WEIGHT", () => {
    const disc = proj({ expectedTotalCents: 100_000, confidence: 0.6 });
    const adjusted = seasonallyAdjust(disc, 200_000);
    // (1 - 0.35)*100_000 + 0.35*200_000 = 65_000 + 70_000 = 135_000
    expect(adjusted.expectedTotalCents).toBe(
      Math.round((1 - SEASONAL_WEIGHT) * 100_000 + SEASONAL_WEIGHT * 200_000),
    );
    expect(adjusted.expectedTotalCents).toBe(135_000);
  });

  test("corroborating signals (within 25%) nudge confidence up and name the adjustment", () => {
    const disc = proj({ expectedTotalCents: 100_000, confidence: 0.6, basis: "avg of last 3 periods" });
    const adjusted = seasonallyAdjust(disc, 110_000); // 10% apart → agree
    expect(adjusted.confidence).toBeGreaterThan(0.6);
    expect(adjusted.basis).toMatch(/same period last year/i);
    expect(adjusted.basis).toMatch(/avg of last 3 periods/); // keeps the base basis
  });

  test("conflicting signals (>75% apart) cut confidence", () => {
    const disc = proj({ expectedTotalCents: 100_000, confidence: 0.8 });
    const adjusted = seasonallyAdjust(disc, 0); // last year $0 vs trend $1000 → full conflict
    expect(adjusted.confidence).toBeLessThan(0.8);
    // blended = 0.65 * 100_000 = 65_000
    expect(adjusted.expectedTotalCents).toBe(65_000);
  });

  test("never blends below zero", () => {
    const disc = proj({ expectedTotalCents: 0, confidence: 0 });
    const adjusted = seasonallyAdjust(disc, 0);
    expect(adjusted.expectedTotalCents).toBe(0);
    // a $0/$0 blend gains no confidence (nothing to be confident about)
    expect(adjusted.confidence).toBe(0);
  });

  test("preserves the underlying method", () => {
    const disc = proj({ method: "trailingAverage", expectedTotalCents: 50_000 });
    expect(seasonallyAdjust(disc, 40_000).method).toBe("trailingAverage");
  });
});

describe("combineCategoryForecast", () => {
  test("total is recurring + discretionary; parts carry method/basis/confidence", () => {
    const recurring = proj({ method: "recurringDriven", expectedTotalCents: 210_900, confidence: 0.85, basis: "1 expected recurring charge" });
    const discretionary = proj({ method: "trailingAverage", expectedTotalCents: 154_000, confidence: 0.5, basis: "avg of last 3 periods" });
    const f = combineCategoryForecast(recurring, discretionary);

    expect(f.recurringCents).toBe(210_900);
    expect(f.discretionaryCents).toBe(154_000);
    expect(f.expectedTotalCents).toBe(364_900);
    expect(f.parts).toHaveLength(2);
    expect(f.parts[0]).toMatchObject({ key: "recurring", cents: 210_900, method: "Expected recurring" });
    expect(f.parts[1]).toMatchObject({ key: "discretionary", cents: 154_000, method: "Typical (recent average)" });
    expect(f.basis).toMatch(/expected recurring/i);
    expect(f.basis).toMatch(/discretionary/i);
  });

  test("confidence is dollar-weighted across the two parts", () => {
    const recurring = proj({ method: "recurringDriven", expectedTotalCents: 300_000, confidence: 0.9 });
    const discretionary = proj({ method: "trailingAverage", expectedTotalCents: 100_000, confidence: 0.4 });
    const f = combineCategoryForecast(recurring, discretionary);
    // (300_000*0.9 + 100_000*0.4) / 400_000 = (270_000 + 40_000)/400_000 = 0.775
    expect(f.confidence).toBeCloseTo(0.78, 2);
  });

  test("no recurring bills → discretionary-only, confidence follows discretionary", () => {
    const recurring = proj({ method: "recurringDriven", expectedTotalCents: 0, confidence: 0, basis: "0 expected recurring charges" });
    const discretionary = proj({ method: "trailingAverage", expectedTotalCents: 154_000, confidence: 0.55 });
    const f = combineCategoryForecast(recurring, discretionary);
    expect(f.expectedTotalCents).toBe(154_000);
    expect(f.confidence).toBe(0.55);
    // the recurring part is omitted when there is no recurring spend (no "$0" noise)
    expect(f.parts).toHaveLength(1);
    expect(f.parts[0]!.key).toBe("discretionary");
    expect(f.basis).toMatch(/no recurring/i);
  });

  test("both zero → zero total and zero confidence", () => {
    const f = combineCategoryForecast(
      proj({ method: "recurringDriven", expectedTotalCents: 0, confidence: 0 }),
      proj({ method: "trailingAverage", expectedTotalCents: 0, confidence: 0 }),
    );
    expect(f.expectedTotalCents).toBe(0);
    expect(f.confidence).toBe(0);
  });

  test("composes real projection.ts outputs end-to-end", () => {
    // known bill: rent $2,109/mo, one occurrence next period
    const recurring = projectRecurringDriven({
      from: "2026-08-01",
      to: "2026-08-31",
      occurrences: [{ day: "2026-08-01", amountCents: 210_900 }],
    });
    // discretionary shopping: last 3 complete months, rising trend
    const discBase = projectTrailingAverage({ trailingTotalsCents: [120_000, 140_000, 160_000] });
    const discretionary = seasonallyAdjust(discBase, 150_000);
    const f = combineCategoryForecast(recurring, discretionary);

    expect(f.recurringCents).toBe(210_900);
    expect(f.discretionaryCents).toBe(discretionary.expectedTotalCents);
    expect(f.expectedTotalCents).toBe(f.recurringCents + f.discretionaryCents);
    expect(f.confidence).toBeGreaterThan(0);
    expect(f.confidence).toBeLessThanOrEqual(1);
    expect(f.parts.map((p) => p.key)).toEqual(["recurring", "discretionary"]);
  });
});
