import { describe, expect, test } from "vitest";
import {
  buildForwardSeries,
  PROJECTION_METHOD_LABEL,
  periodProgress,
  projectBudgetTarget,
  projectPace,
  projectPriorPeriod,
  projectRecurringDriven,
  projectRunRate,
  projectTrailingAverage,
  reindexByPosition,
  sumOccurrencesInWindow,
} from "./projection";

// Money literals use _ separators: 120_000 = $1,200.00 (integer cents everywhere).

describe("periodProgress", () => {
  test("mid-period: elapsed/remaining split inclusive of both ends (the 'today tick')", () => {
    const p = periodProgress("2026-07-01", "2026-07-31", "2026-07-12");
    expect(p.totalDays).toBe(31);
    expect(p.elapsedDays).toBe(12); // 07-01..07-12 inclusive
    expect(p.remainingDays).toBe(19);
    expect(p.elapsedFraction).toBeCloseTo(12 / 31, 10);
    expect(p).toMatchObject({ isCurrent: true, isPast: false, isFuture: false });
  });

  test("first day of the window counts one elapsed day", () => {
    const p = periodProgress("2026-07-01", "2026-07-31", "2026-07-01");
    expect(p.elapsedDays).toBe(1);
    expect(p.remainingDays).toBe(30);
    expect(p.isCurrent).toBe(true);
  });

  test("last day of the window is fully elapsed", () => {
    const p = periodProgress("2026-07-01", "2026-07-31", "2026-07-31");
    expect(p.elapsedDays).toBe(31);
    expect(p.remainingDays).toBe(0);
    expect(p.elapsedFraction).toBe(1);
    expect(p.isCurrent).toBe(true);
  });

  test("a past window is fully elapsed (projection == actual)", () => {
    const p = periodProgress("2026-05-01", "2026-05-31", "2026-07-12");
    expect(p).toMatchObject({ elapsedDays: 31, remainingDays: 0, isPast: true, isCurrent: false });
    expect(p.elapsedFraction).toBe(1);
  });

  test("a future window has zero elapsed days", () => {
    const p = periodProgress("2026-08-01", "2026-08-31", "2026-07-12");
    expect(p).toMatchObject({ elapsedDays: 0, remainingDays: 31, isFuture: true, isCurrent: false });
    expect(p.elapsedFraction).toBe(0);
  });

  test("a single-day window is a valid 1-day period", () => {
    const p = periodProgress("2026-07-12", "2026-07-12", "2026-07-12");
    expect(p).toMatchObject({ totalDays: 1, elapsedDays: 1, remainingDays: 0, elapsedFraction: 1 });
  });
});

describe("projectPace basis grammar", () => {
  test("a single-day window reads 'day', not 'days'", () => {
    const p = projectPace({ from: "2026-07-12", to: "2026-07-12", today: "2026-07-12", actualToDateCents: 5_000 });
    expect(p.basis).toBe("pace from 1 of 1 day elapsed");
  });
});

describe("projectPace", () => {
  test("no recurring inputs reduces to actual ÷ elapsed-fraction (Engine C)", () => {
    const p = projectPace({
      from: "2026-07-01",
      to: "2026-07-31",
      today: "2026-07-12",
      actualToDateCents: 120_000,
    });
    // 120_000 × 31/12 = 310_000
    expect(p.expectedTotalCents).toBe(310_000);
    expect(p.method).toBe("pace");
    expect(p.targetCents).toBeNull();
    expect(p.basis).toBe("pace from 12 of 31 days elapsed");
    expect(p.confidence).toBe(0.6); // 0.35 + 0.65×(12/31)
  });

  test("splits variable vs recurring, adds the tail, and floors at a committed actual", () => {
    const p = projectPace({
      from: "2026-07-01",
      to: "2026-07-31",
      today: "2026-07-12",
      actualToDateCents: 100_000,
      recurringPostedCents: 40_000,
      expectedTailCents: 30_000,
      floorCents: 200_000,
    });
    // variable = 60_000; remainder = 60_000×19/12 = 95_000; sum = 100_000+30_000+95_000 = 225_000 (> floor)
    expect(p.expectedTotalCents).toBe(225_000);
    expect(p.basis).toContain("+30000¢ expected recurring");
  });

  test("the floor wins when it exceeds the extrapolation (a large committed future charge)", () => {
    const p = projectPace({
      from: "2026-07-01",
      to: "2026-07-31",
      today: "2026-07-12",
      actualToDateCents: 100_000,
      floorCents: 500_000,
    });
    expect(p.expectedTotalCents).toBe(500_000);
  });

  test("a future window projects only its expected recurring tail, at zero confidence", () => {
    const p = projectPace({
      from: "2026-08-01",
      to: "2026-08-31",
      today: "2026-07-12",
      actualToDateCents: 0,
      expectedTailCents: 50_000,
    });
    expect(p.expectedTotalCents).toBe(50_000);
    expect(p.confidence).toBe(0);
  });

  test("never extrapolates a non-positive variable part below what's already posted", () => {
    const p = projectPace({
      from: "2026-07-01",
      to: "2026-07-31",
      today: "2026-07-12",
      actualToDateCents: 30_000,
      recurringPostedCents: 50_000, // variable = −20_000 → no negative remainder
    });
    expect(p.expectedTotalCents).toBe(30_000);
  });
});

describe("projectTrailingAverage", () => {
  test("no prior periods → zero total, ZERO confidence (no data ⇒ no confidence), honest basis", () => {
    const p = projectTrailingAverage({ trailingTotalsCents: [] });
    expect(p).toMatchObject({ expectedTotalCents: 0, confidence: 0, basis: "no prior periods" });
  });

  test("a single period averages to itself with reduced confidence", () => {
    const p = projectTrailingAverage({ trailingTotalsCents: [80_000] });
    expect(p.expectedTotalCents).toBe(80_000);
    expect(p.confidence).toBe(0.4);
    expect(p.basis).toBe("avg of last 1 period");
  });

  test("a steady history projects the mean at full confidence (no trend note)", () => {
    const p = projectTrailingAverage({ trailingTotalsCents: [50_000, 50_000, 50_000] });
    expect(p.expectedTotalCents).toBe(50_000);
    expect(p.confidence).toBe(1);
    expect(p.basis).toBe("avg of last 3 periods");
  });

  test("a rising history nudges the estimate up by the trend and reads it in the basis", () => {
    const p = projectTrailingAverage({ trailingTotalsCents: [40_000, 50_000, 60_000] });
    // avg 50_000 + trend (60_000−40_000)/2 = 10_000 → 60_000
    expect(p.expectedTotalCents).toBe(60_000);
    expect(p.confidence).toBe(0.84);
    expect(p.basis).toBe("avg of last 3 periods + trend 10000¢");
  });

  test("a collapsing history floors at zero and reads the trend as a subtraction", () => {
    const p = projectTrailingAverage({ trailingTotalsCents: [100_000, 0] });
    // avg 50_000 + trend (0−100_000)/2 = −50_000 → 0
    expect(p.expectedTotalCents).toBe(0);
    expect(p.confidence).toBe(0); // cv = 1
    expect(p.basis).toBe("avg of last 2 periods - trend 50000¢"); // sign-aware, never "+ trend -50000¢"
  });

  test("a wildly scattered history clamps confidence to zero (cv > 1)", () => {
    const p = projectTrailingAverage({ trailingTotalsCents: [0, 0, 150_000] });
    expect(p.confidence).toBe(0);
    expect(p.expectedTotalCents).toBe(125_000); // avg 50_000 + trend 75_000
  });

  test("applyTrend:false drops the trend nudge", () => {
    const p = projectTrailingAverage({ trailingTotalsCents: [40_000, 60_000], applyTrend: false });
    expect(p.expectedTotalCents).toBe(50_000);
    expect(p.basis).toBe("avg of last 2 periods");
  });
});

describe("projectPriorPeriod", () => {
  test("returns the prior total as a labeled, historical-fact reference", () => {
    const p = projectPriorPeriod({ priorTotalCents: 85_000, label: "last month" });
    expect(p).toMatchObject({
      method: "priorPeriod",
      expectedTotalCents: 85_000,
      confidence: 1,
      basis: "same period previously (last month)",
    });
  });

  test("works without a label", () => {
    expect(projectPriorPeriod({ priorTotalCents: 1 }).basis).toBe("same period previously");
  });
});

describe("sumOccurrencesInWindow", () => {
  const occ = [
    { day: "2026-06-30", amountCents: 999 }, // before window
    { day: "2026-07-05", amountCents: 1_800 },
    { day: "2026-07-20", amountCents: 1_800 },
    { day: "2026-08-01", amountCents: 999 }, // after window
  ];

  test("counts only occurrences inside [from, to]", () => {
    expect(sumOccurrencesInWindow(occ, "2026-07-01", "2026-07-31")).toEqual({
      totalCents: 3_600,
      count: 2,
    });
  });
});

describe("projectRecurringDriven", () => {
  test("sums the projected occurrences that land in the window", () => {
    const p = projectRecurringDriven({
      from: "2026-07-01",
      to: "2026-07-31",
      occurrences: [
        { day: "2026-07-05", amountCents: 1_800 },
        { day: "2026-07-20", amountCents: 1_800 },
      ],
    });
    expect(p).toMatchObject({ expectedTotalCents: 3_600, confidence: 0.85, basis: "2 expected recurring charges" });
  });

  test("no occurrences → zero total, zero confidence", () => {
    const p = projectRecurringDriven({ from: "2026-07-01", to: "2026-07-31", occurrences: [] });
    expect(p).toMatchObject({ expectedTotalCents: 0, confidence: 0, basis: "0 expected recurring charges" });
  });

  test("singular grammar for one charge", () => {
    const p = projectRecurringDriven({
      from: "2026-07-01",
      to: "2026-07-31",
      occurrences: [{ day: "2026-07-05", amountCents: 1_800 }],
    });
    expect(p.basis).toBe("1 expected recurring charge");
  });
});

describe("projectRunRate", () => {
  test("extrapolates the endpoint slope forward to the window end", () => {
    const p = projectRunRate({
      series: [
        { day: "2026-07-01", valueCents: 100_000 },
        { day: "2026-07-11", valueCents: 110_000 },
      ],
      to: "2026-07-31",
    });
    // slope 1_000/day over 10 days, extrapolate 20 days → 130_000
    expect(p.expectedTotalCents).toBe(130_000);
    expect(p.confidence).toBe(0.33); // observed 10 / total 30
    expect(p.basis).toBe("linear run rate over 2 points, extrapolated 20 days");
  });

  test("ignores null points when fitting the line", () => {
    const p = projectRunRate({
      series: [
        { day: "2026-07-01", valueCents: null },
        { day: "2026-07-11", valueCents: 100_000 },
        { day: "2026-07-21", valueCents: 120_000 },
      ],
      to: "2026-07-31",
    });
    // slope 2_000/day over 10 days from 07-11→07-21, extrapolate 10 more → 140_000
    expect(p.expectedTotalCents).toBe(140_000);
  });

  test("a single real point can't fit a run rate (flat, zero confidence)", () => {
    const p = projectRunRate({ series: [{ day: "2026-07-11", valueCents: 5_000 }], to: "2026-07-31" });
    expect(p).toMatchObject({ expectedTotalCents: 5_000, confidence: 0, basis: "not enough points to fit a run rate" });
  });

  test("an empty series yields zero", () => {
    expect(projectRunRate({ series: [], to: "2026-07-31" }).expectedTotalCents).toBe(0);
  });

  test("two same-day points give a flat (zero-slope) run rate", () => {
    const p = projectRunRate({
      series: [
        { day: "2026-07-11", valueCents: 100_000 },
        { day: "2026-07-11", valueCents: 100_000 },
      ],
      to: "2026-07-31",
    });
    expect(p.expectedTotalCents).toBe(100_000);
    expect(p.confidence).toBe(0); // observed span 0
  });

  test("no forward days to extrapolate → full confidence, singular grammar", () => {
    const p = projectRunRate({
      series: [
        { day: "2026-07-01", valueCents: 100_000 },
        { day: "2026-07-11", valueCents: 110_000 },
      ],
      to: "2026-07-05",
    });
    expect(p.expectedTotalCents).toBe(110_000); // extrapolate 0 days
    expect(p.confidence).toBe(1);
    expect(p.basis).toBe("linear run rate over 2 points, extrapolated 0 days");
  });

  test("singular grammar when extrapolating exactly one day", () => {
    const p = projectRunRate({
      series: [
        { day: "2026-07-01", valueCents: 100_000 },
        { day: "2026-07-11", valueCents: 110_000 },
      ],
      to: "2026-07-12",
    });
    expect(p.basis).toBe("linear run rate over 2 points, extrapolated 1 day");
  });

  test("zero observed span and zero extrapolation → zero confidence", () => {
    const p = projectRunRate({
      series: [
        { day: "2026-07-11", valueCents: 100_000 },
        { day: "2026-07-11", valueCents: 100_000 },
      ],
      to: "2026-07-11",
    });
    expect(p.confidence).toBe(0);
  });
});

describe("projectBudgetTarget", () => {
  test("carries the set target as both the reference line and the expected total", () => {
    const p = projectBudgetTarget({ targetCents: 200_000 });
    expect(p).toMatchObject({
      method: "budgetTarget",
      targetCents: 200_000,
      expectedTotalCents: 200_000,
      confidence: 1,
      basis: "set budget target",
    });
  });
});

describe("buildForwardSeries", () => {
  test("interpolates a dashed tail from the anchor to the expected end", () => {
    const out = buildForwardSeries({
      lastActualDay: "2026-07-12",
      lastActualCents: 120_000,
      to: "2026-07-15",
      expectedTotalCents: 150_000,
    });
    expect(out).toEqual([
      { day: "2026-07-12", valueCents: 120_000, complete: true },
      { day: "2026-07-13", valueCents: 130_000, complete: false },
      { day: "2026-07-14", valueCents: 140_000, complete: false },
      { day: "2026-07-15", valueCents: 150_000, complete: false },
    ]);
  });

  test("returns just the solid anchor when the window has no future left", () => {
    const out = buildForwardSeries({
      lastActualDay: "2026-07-12",
      lastActualCents: 120_000,
      to: "2026-07-12",
      expectedTotalCents: 150_000,
    });
    expect(out).toEqual([{ day: "2026-07-12", valueCents: 120_000, complete: true }]);
  });

  test("never projects backwards (to before the anchor is just the anchor)", () => {
    const out = buildForwardSeries({
      lastActualDay: "2026-07-12",
      lastActualCents: 120_000,
      to: "2026-07-10",
      expectedTotalCents: 150_000,
    });
    expect(out).toEqual([{ day: "2026-07-12", valueCents: 120_000, complete: true }]);
  });
});

describe("reindexByPosition", () => {
  test("empty input → empty", () => {
    expect(reindexByPosition([], 5)).toEqual([]);
  });

  test("non-positive target length → empty", () => {
    expect(reindexByPosition([10, 20], 0)).toEqual([]);
  });

  test("a single-bucket target takes the last prior value", () => {
    expect(reindexByPosition([10, 20, 30], 1)).toEqual([30]);
  });

  test("a single prior value fills every bucket (flat ghost)", () => {
    expect(reindexByPosition([50], 3)).toEqual([50, 50, 50]);
  });

  test("same-length reindex is the identity", () => {
    expect(reindexByPosition([10, 20, 30], 3)).toEqual([10, 20, 30]);
  });

  test("downsamples a longer prior period by nearest position", () => {
    expect(reindexByPosition([10, 20, 30, 40, 50], 3)).toEqual([10, 30, 50]);
  });

  test("upsamples a shorter prior period by nearest position", () => {
    expect(reindexByPosition([10, 20, 30], 5)).toEqual([10, 20, 20, 30, 30]);
  });
});

describe("PROJECTION_METHOD_LABEL", () => {
  test("every method has a human label", () => {
    expect(PROJECTION_METHOD_LABEL.pace).toBe("At this pace");
    expect(PROJECTION_METHOD_LABEL.priorPeriod).toBe("Same period previously");
    expect(Object.keys(PROJECTION_METHOD_LABEL)).toHaveLength(6);
  });
});
