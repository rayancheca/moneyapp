import { describe, expect, test } from "vitest";
import {
  HOLDING_METRICS,
  holdingMetricLabel,
  nextHoldingMetric,
  type HoldingMetric,
} from "./holding-cycle";

describe("nextHoldingMetric", () => {
  test("cycles day % → day $ → total P/L → back", () => {
    expect(nextHoldingMetric("dayPct")).toBe("dayDollar");
    expect(nextHoldingMetric("dayDollar")).toBe("totalPl");
    expect(nextHoldingMetric("totalPl")).toBe("dayPct");
  });

  test("cycling the length of the list returns to the start", () => {
    let m: HoldingMetric = "dayPct";
    for (let i = 0; i < HOLDING_METRICS.length; i += 1) m = nextHoldingMetric(m);
    expect(m).toBe("dayPct");
  });
});

describe("holdingMetricLabel", () => {
  test("labels every metric", () => {
    expect(holdingMetricLabel("dayPct")).toBe("Day %");
    expect(holdingMetricLabel("dayDollar")).toBe("Day change");
    expect(holdingMetricLabel("totalPl")).toBe("Total P/L");
  });
});
