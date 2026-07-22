import { describe, expect, test } from "vitest";
import { hasEstimatedDay, windowedPoints, windowPoints } from "./chart-window";

const TODAY = "2026-07-08";

/** A day series with a value; only `day` matters to the windowing. */
function days(...ds: string[]): { day: string; valueCents: number | null }[] {
  return ds.map((day, i) => ({ day, valueCents: i * 100 }));
}

describe("windowPoints — range windows", () => {
  test("ALL keeps every point (and returns a copy, not the input array)", () => {
    const points = days("2020-01-01", "2026-07-08");
    const out = windowPoints(points, TODAY, "ALL");
    expect(out).toEqual(points);
    expect(out).not.toBe(points);
  });

  test("1M keeps points on or after today − 30 days (inclusive lower bound)", () => {
    const points = days("2026-06-07", "2026-06-08", "2026-06-09", "2026-07-08");
    expect(windowPoints(points, TODAY, "1M").map((p) => p.day)).toEqual([
      "2026-06-08",
      "2026-06-09",
      "2026-07-08",
    ]);
  });

  test("3M counts back 91 days and 1Y counts back 365", () => {
    const points = days("2025-07-07", "2025-07-08", "2026-04-08", "2026-07-08");
    expect(windowPoints(points, TODAY, "3M").map((p) => p.day)).toEqual(["2026-04-08", "2026-07-08"]);
    expect(windowPoints(points, TODAY, "1Y").map((p) => p.day)).toEqual([
      "2025-07-08",
      "2026-04-08",
      "2026-07-08",
    ]);
  });

  test("YTD anchors to Jan 1 of today's year", () => {
    const points = days("2025-12-31", "2026-01-01", "2026-07-08");
    expect(windowPoints(points, TODAY, "YTD").map((p) => p.day)).toEqual(["2026-01-01", "2026-07-08"]);
  });

  test("points dated after today are kept — the window has no upper bound", () => {
    const points = days("2026-07-08", "2026-08-01");
    expect(windowPoints(points, TODAY, "1M").map((p) => p.day)).toEqual(["2026-07-08", "2026-08-01"]);
  });
});

describe("windowPoints — the <2 fallback (the chart's honesty seam)", () => {
  test("a window holding one point falls back to the ENTIRE series", () => {
    const points = days("2020-01-01", "2020-06-01", "2026-07-08");
    // only 2026-07-08 is within 1M → 1 point → fall back to all three
    expect(windowPoints(points, TODAY, "1M")).toEqual(points);
  });

  test("a window holding zero points falls back to the ENTIRE series", () => {
    const points = days("2020-01-01", "2020-06-01");
    expect(windowPoints(points, TODAY, "1M")).toEqual(points);
  });

  test("exactly two points in the window do NOT fall back", () => {
    const points = days("2020-01-01", "2026-06-20", "2026-07-08");
    expect(windowPoints(points, TODAY, "1M").map((p) => p.day)).toEqual(["2026-06-20", "2026-07-08"]);
  });

  test("a series shorter than two points is returned as-is", () => {
    expect(windowPoints([], TODAY, "1M")).toEqual([]);
    const one = days("2026-07-08");
    expect(windowPoints(one, TODAY, "1M")).toEqual(one);
  });
});

describe("windowPoints — custom window (drag-select) takes precedence", () => {
  test("keeps points inside the window, both ends inclusive", () => {
    const points = days("2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01");
    const out = windowPoints(points, TODAY, "1M", { start: "2026-02-01", end: "2026-03-01" });
    expect(out.map((p) => p.day)).toEqual(["2026-02-01", "2026-03-01"]);
  });

  test("the range is ignored entirely while a custom window is active", () => {
    const points = days("2020-01-01", "2020-02-01", "2026-07-08");
    const out = windowPoints(points, TODAY, "ALL", { start: "2020-01-01", end: "2020-02-01" });
    expect(out.map((p) => p.day)).toEqual(["2020-01-01", "2020-02-01"]);
  });

  test("a hair-thin custom window falls back to the entire series too", () => {
    const points = days("2026-01-01", "2026-02-01", "2026-03-01");
    expect(windowPoints(points, TODAY, "ALL", { start: "2026-02-01", end: "2026-02-01" })).toEqual(points);
  });

  test("an explicitly null custom window behaves like none", () => {
    const points = days("2026-06-20", "2026-07-08");
    expect(windowPoints(points, TODAY, "1M", null).map((p) => p.day)).toEqual([
      "2026-06-20",
      "2026-07-08",
    ]);
  });
});

describe("windowPoints — series shape is preserved", () => {
  test("input order is preserved and nothing is sorted or deduped", () => {
    const points = days("2026-07-08", "2026-06-20", "2026-06-20");
    expect(windowPoints(points, TODAY, "1M").map((p) => p.day)).toEqual([
      "2026-07-08",
      "2026-06-20",
      "2026-06-20",
    ]);
  });

  test("null-valued days are kept — they are breaks in the line, not absent rows", () => {
    const points = [
      { day: "2026-06-20", valueCents: null },
      { day: "2026-07-01", valueCents: 500 },
      { day: "2026-07-08", valueCents: null },
    ];
    expect(windowPoints(points, TODAY, "1M")).toEqual(points);
  });

  test("extra per-point fields survive the window (generic over the point shape)", () => {
    const points = [
      { day: "2026-06-20", valueCents: 1, basis: "carried" as const },
      { day: "2026-07-08", valueCents: 2, basis: "anchored" as const },
    ];
    expect(windowPoints(points, TODAY, "1M")[0]!.basis).toBe("carried");
  });
});

describe("windowedPoints — the fell-back flag", () => {
  test("reports fellBack=false when the requested window stands on its own", () => {
    const points = days("2020-01-01", "2026-06-20", "2026-07-08");
    expect(windowedPoints(points, TODAY, "1M")).toEqual({
      points: [points[1]!, points[2]!],
      fellBack: false,
    });
  });

  test("reports fellBack=true when the window was too thin and the full series is shown", () => {
    const points = days("2020-01-01", "2020-06-01", "2026-07-08");
    const out = windowedPoints(points, TODAY, "1M");
    expect(out.fellBack).toBe(true);
    expect(out.points).toEqual(points);
  });

  test("ALL never counts as a fallback — it IS the whole series", () => {
    const points = days("2020-01-01", "2026-07-08");
    expect(windowedPoints(points, TODAY, "ALL").fellBack).toBe(false);
  });

  test("a series with fewer than two points is not a fallback either", () => {
    const one = days("2026-07-08");
    expect(windowedPoints(one, TODAY, "1M")).toEqual({ points: one, fellBack: false });
    expect(windowedPoints([], TODAY, "1M")).toEqual({ points: [], fellBack: false });
  });

  test("a too-thin custom window reports fellBack=true", () => {
    const points = days("2026-01-01", "2026-02-01", "2026-03-01");
    expect(windowedPoints(points, TODAY, "ALL", { start: "2026-02-01", end: "2026-02-01" }).fellBack).toBe(
      true,
    );
  });
});

describe("hasEstimatedDay", () => {
  test("false for an exact series that omits the flag entirely", () => {
    // the portfolio/holding shape: day-stamped points with no `complete` at all
    const exact: { day: string; complete?: boolean }[] = [{ day: "2026-07-07" }, { day: "2026-07-08" }];
    expect(hasEstimatedDay(exact)).toBe(false);
  });

  test("false when every day is explicitly complete", () => {
    expect(hasEstimatedDay([{ complete: true }, { complete: true }])).toBe(false);
  });

  test("true when any day is explicitly incomplete", () => {
    expect(hasEstimatedDay([{ complete: true }, { complete: false }])).toBe(true);
  });

  test("only an explicit false counts — undefined is exact, not unknown", () => {
    expect(hasEstimatedDay([{ complete: undefined }])).toBe(false);
  });

  test("false for an empty series", () => {
    expect(hasEstimatedDay([])).toBe(false);
  });
});
