import { describe, expect, test } from "vitest";
import {
  firstCompleteDay,
  hasPartialCoverage,
  netWorthChartSeries,
  splitCoverageSeries,
  type CoveragePoint,
} from "./scrub-series";

describe("splitCoverageSeries", () => {
  test("all-complete points stay on the solid line, dashed empty", () => {
    const pts: CoveragePoint[] = [
      { day: "2026-01-01", valueCents: 100 },
      { day: "2026-01-02", valueCents: 200 },
      { day: "2026-01-03", valueCents: 300 },
    ];
    const out = splitCoverageSeries(pts);
    expect(out.map((p) => p.solid)).toEqual([100, 200, 300]);
    expect(out.map((p) => p.soft)).toEqual([null, null, null]);
    expect(out.map((p) => p.v)).toEqual([100, 200, 300]);
  });

  test("explicit complete:true behaves like the default", () => {
    const out = splitCoverageSeries([{ day: "d", valueCents: 5, complete: true }]);
    expect(out).toEqual([{ day: "d", v: 5, solid: 5, soft: null }]);
  });

  test("a partial run bridges to its bounding solid points on the dashed line", () => {
    const pts: CoveragePoint[] = [
      { day: "d0", valueCents: 10, complete: true },
      { day: "d1", valueCents: 20, complete: true },
      { day: "d2", valueCents: 30, complete: false },
      { day: "d3", valueCents: 40, complete: false },
      { day: "d4", valueCents: 50, complete: true },
      { day: "d5", valueCents: 60, complete: true },
    ];
    const out = splitCoverageSeries(pts);
    // solid present only on complete days
    expect(out.map((p) => p.solid)).toEqual([10, 20, null, null, 50, 60]);
    // dashed present on partial days PLUS the immediate solid neighbors (d1, d4)
    expect(out.map((p) => p.soft)).toEqual([null, 20, 30, 40, 50, null]);
  });

  test("a lone partial point bridges both neighbors", () => {
    const pts: CoveragePoint[] = [
      { day: "d0", valueCents: 10, complete: true },
      { day: "d1", valueCents: 20, complete: false },
      { day: "d2", valueCents: 30, complete: true },
    ];
    const out = splitCoverageSeries(pts);
    expect(out.map((p) => p.solid)).toEqual([10, null, 30]);
    expect(out.map((p) => p.soft)).toEqual([10, 20, 30]);
  });

  test("a null value is a hard break in both lines and does not bridge", () => {
    const pts: CoveragePoint[] = [
      { day: "d0", valueCents: 10, complete: true },
      { day: "d1", valueCents: null },
      { day: "d2", valueCents: 30, complete: true },
    ];
    const out = splitCoverageSeries(pts);
    expect(out).toEqual([
      { day: "d0", v: 10, solid: 10, soft: null },
      { day: "d1", v: null, solid: null, soft: null },
      { day: "d2", v: 30, solid: 30, soft: null },
    ]);
  });

  test("a null value never counts as a partial neighbor for bridging", () => {
    // d1 is null (no data). d0/d2 are complete and must NOT be pulled onto the
    // dashed line — the break is real, not a partial span.
    const pts: CoveragePoint[] = [
      { day: "d0", valueCents: 10, complete: true },
      { day: "d1", valueCents: null, complete: false },
      { day: "d2", valueCents: 30, complete: true },
    ];
    const out = splitCoverageSeries(pts);
    expect(out.map((p) => p.soft)).toEqual([null, null, null]);
  });

  test("empty input yields empty output", () => {
    expect(splitCoverageSeries([])).toEqual([]);
  });
});

describe("hasPartialCoverage", () => {
  test("true when any point is an incomplete non-null day", () => {
    expect(
      hasPartialCoverage([
        { day: "d0", valueCents: 10 },
        { day: "d1", valueCents: 20, complete: false },
      ]),
    ).toBe(true);
  });

  test("false when every point is complete (or default)", () => {
    expect(
      hasPartialCoverage([
        { day: "d0", valueCents: 10 },
        { day: "d1", valueCents: 20, complete: true },
      ]),
    ).toBe(false);
  });

  test("a null-valued incomplete day is not partial coverage (it is a break)", () => {
    expect(hasPartialCoverage([{ day: "d0", valueCents: null, complete: false }])).toBe(false);
  });
});

describe("firstCompleteDay", () => {
  test("returns the first fully-covered day", () => {
    const pts: CoveragePoint[] = [
      { day: "2026-01-01", valueCents: 10, complete: false },
      { day: "2026-01-02", valueCents: 20, complete: false },
      { day: "2026-01-03", valueCents: 30, complete: true },
      { day: "2026-01-04", valueCents: 40, complete: true },
    ];
    expect(firstCompleteDay(pts)).toBe("2026-01-03");
  });

  test("defaults (no complete flag) count as complete", () => {
    expect(firstCompleteDay([{ day: "d0", valueCents: 5 }])).toBe("d0");
  });

  test("null when every day is partial (or has no data)", () => {
    expect(
      firstCompleteDay([
        { day: "d0", valueCents: 5, complete: false },
        { day: "d1", valueCents: null, complete: false },
      ]),
    ).toBeNull();
  });
});

describe("netWorthChartSeries", () => {
  test("draws one continuous line and fills complete days only (leading partial prefix bare)", () => {
    const pts: CoveragePoint[] = [
      { day: "2026-01-01", valueCents: 10, complete: false },
      { day: "2026-01-02", valueCents: 20, complete: false },
      { day: "2026-01-03", valueCents: 30, complete: true },
      { day: "2026-01-04", valueCents: 40, complete: true },
    ];
    const out = netWorthChartSeries(pts);
    // the stroke is unbroken across the whole window
    expect(out.map((p) => p.lineValue)).toEqual([10, 20, 30, 40]);
    // the fill only exists on the fully-covered days (estimated prefix bare)
    expect(out.map((p) => p.fillValue)).toEqual([null, null, 30, 40]);
  });

  test("an INTERIOR partial gap is unfilled even though the window starts complete", () => {
    // coverage is not monotonic: complete → partial → complete. The gap must NOT
    // be filled (honesty), and the line stays continuous across it.
    const pts: CoveragePoint[] = [
      { day: "2026-01-01", valueCents: 10, complete: true },
      { day: "2026-01-02", valueCents: 20, complete: false },
      { day: "2026-01-03", valueCents: 30, complete: true },
    ];
    const out = netWorthChartSeries(pts);
    expect(out.map((p) => p.lineValue)).toEqual([10, 20, 30]);
    expect(out.map((p) => p.fillValue)).toEqual([10, null, 30]);
  });

  test("a genuine no-data day is a hard break in the line, never filled", () => {
    const pts: CoveragePoint[] = [
      { day: "2026-01-01", valueCents: 10, complete: true },
      { day: "2026-01-02", valueCents: null },
      { day: "2026-01-03", valueCents: 30, complete: true },
    ];
    const out = netWorthChartSeries(pts);
    expect(out.map((p) => p.lineValue)).toEqual([10, null, 30]);
    expect(out.map((p) => p.fillValue)).toEqual([10, null, 30]);
  });

  test("all-complete window fills the whole area", () => {
    const out = netWorthChartSeries([
      { day: "2026-01-01", valueCents: 10 },
      { day: "2026-01-02", valueCents: 20 },
    ]);
    expect(out.map((p) => p.fillValue)).toEqual([10, 20]);
  });

  test("all-partial window → no fill anywhere, line still continuous", () => {
    const out = netWorthChartSeries([
      { day: "2026-01-01", valueCents: 10, complete: false },
      { day: "2026-01-02", valueCents: 20, complete: false },
    ]);
    expect(out.map((p) => p.lineValue)).toEqual([10, 20]);
    expect(out.map((p) => p.fillValue)).toEqual([null, null]);
  });
});
