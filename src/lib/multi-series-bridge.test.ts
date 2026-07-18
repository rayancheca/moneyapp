import { describe, expect, test } from "vitest";
import { bridgeDashboardSeries } from "./multi-series-bridge";
import type { DashboardSeries } from "./multi-series";

const series = (points: DashboardSeries["points"]): DashboardSeries => ({
  key: "assets",
  label: "Assets",
  owedFrame: false,
  points,
});

describe("bridgeDashboardSeries", () => {
  test("adds the correction on covered window days and marks inTransitCents", () => {
    const out = bridgeDashboardSeries(
      series([
        { day: "2026-03-26", valueCents: 7_000, complete: true },
        { day: "2026-03-27", valueCents: 5_700, complete: true },
        { day: "2026-03-31", valueCents: 7_010, complete: true },
      ]),
      [{ startDay: "2026-03-27", endDay: "2026-03-31", deltaCents: 1_296 }],
    );
    expect(out.points.map((p) => p.valueCents)).toEqual([7_000, 6_996, 7_010]);
    expect(out.points.map((p) => p.inTransitCents)).toEqual([0, 1_296, 0]);
  });

  test("a null (uncovered) day is never bridged — no fabricated coverage", () => {
    const out = bridgeDashboardSeries(
      series([
        { day: "2026-03-27", valueCents: null, complete: false },
        { day: "2026-03-28", valueCents: 100, complete: false },
      ]),
      [{ startDay: "2026-03-27", endDay: null, deltaCents: 50 }],
    );
    expect(out.points[0]).toEqual({ day: "2026-03-27", valueCents: null, complete: false, inTransitCents: 0 });
    expect(out.points[1]).toEqual({ day: "2026-03-28", valueCents: 150, complete: false, inTransitCents: 50 });
  });

  test("no adjustments -> values unchanged, inTransitCents 0, metadata preserved", () => {
    const input = series([{ day: "2026-01-01", valueCents: 42, complete: true }]);
    const out = bridgeDashboardSeries(input, []);
    expect(out.key).toBe("assets");
    expect(out.owedFrame).toBe(false);
    expect(out.points).toEqual([{ day: "2026-01-01", valueCents: 42, complete: true, inTransitCents: 0 }]);
    // input untouched
    expect(input.points[0]).toEqual({ day: "2026-01-01", valueCents: 42, complete: true });
  });
});
