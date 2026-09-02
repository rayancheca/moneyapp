import { describe, expect, test } from "vitest";
import { carriedFromDay, carryForwardTo } from "./price-series";

describe("carryForwardTo", () => {
  test("extends flat to today, tagging the tail dashed and real points solid", () => {
    const out = carryForwardTo(
      [
        { day: "2026-07-08", valueCents: 100 },
        { day: "2026-07-10", valueCents: 130 },
      ],
      "2026-07-13",
    );
    expect(out).toEqual([
      { day: "2026-07-08", valueCents: 100, complete: true },
      { day: "2026-07-10", valueCents: 130, complete: true },
      // carried tail: last value repeated for every day after the last real day
      { day: "2026-07-11", valueCents: 130, complete: false },
      { day: "2026-07-12", valueCents: 130, complete: false },
      { day: "2026-07-13", valueCents: 130, complete: false },
    ]);
  });

  test("is a no-op when today is the last real day (pinned test/e2e clock)", () => {
    const out = carryForwardTo(
      [
        { day: "2026-07-05", valueCents: 50 },
        { day: "2026-07-08", valueCents: 70 },
      ],
      "2026-07-08",
    );
    expect(out).toEqual([
      { day: "2026-07-05", valueCents: 50, complete: true },
      { day: "2026-07-08", valueCents: 70, complete: true },
    ]);
    // no carried tail → hasPartialCoverage stays false → chart is byte-identical
    expect(out.every((p) => p.complete)).toBe(true);
  });

  test("is a no-op when today precedes the last real day (never truncates)", () => {
    const out = carryForwardTo([{ day: "2026-07-08", valueCents: 70 }], "2026-07-01");
    expect(out).toEqual([{ day: "2026-07-08", valueCents: 70, complete: true }]);
  });

  test("carries a single point forward across a month/year boundary", () => {
    const out = carryForwardTo([{ day: "2025-12-30", valueCents: 9 }], "2026-01-02");
    expect(out.map((p) => p.day)).toEqual([
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);
    expect(out.slice(1).every((p) => p.valueCents === 9 && !p.complete)).toBe(true);
  });

  test("preserves the point shape's extra fields on the carried tail (generic over closeCents)", () => {
    const out = carryForwardTo([{ day: "2026-07-08", closeCents: 300_000 }], "2026-07-09");
    expect(out).toEqual([
      { day: "2026-07-08", closeCents: 300_000, complete: true },
      { day: "2026-07-09", closeCents: 300_000, complete: false },
    ]);
  });

  test("empty input returns empty", () => {
    expect(carryForwardTo([], "2026-07-10")).toEqual([]);
  });
});

describe("carriedFromDay", () => {
  const series = [
    { day: "2026-08-31", valueCents: 100, complete: true },
    { day: "2026-09-01", valueCents: 200, complete: true },
    { day: "2026-09-02", valueCents: 200, complete: false },
    { day: "2026-09-03", valueCents: 200, complete: false },
  ];

  test("a carried day names the last real day it is holding", () => {
    expect(carriedFromDay(series, "2026-09-02")).toBe("2026-09-01");
  });

  test("a carried day two past the close still names the close, not the day before it", () => {
    expect(carriedFromDay(series, "2026-09-03")).toBe("2026-09-01");
  });

  test("a measured day is holding nothing", () => {
    expect(carriedFromDay(series, "2026-09-01")).toBeNull();
    expect(carriedFromDay(series, "2026-08-31")).toBeNull();
  });

  test("a day outside the series is not answered", () => {
    expect(carriedFromDay(series, "2026-07-04")).toBeNull();
    expect(carriedFromDay([], "2026-09-02")).toBeNull();
  });

  /* A series with no `complete` at all is exact by omission — the flag defaults
     to true everywhere it is read, so nothing here may report a hold. */
  test("a series that never flags a day reports no holds", () => {
    const exact = [{ day: "2026-09-01" }, { day: "2026-09-02" }];
    expect(carriedFromDay(exact, "2026-09-02")).toBeNull();
  });

  /* The output of `carryForwardTo` is the real input to this, so they are
     checked together rather than against a hand-built shape. */
  test("it reads the tail carryForwardTo actually produces", () => {
    const carried = carryForwardTo([{ day: "2026-09-01", valueCents: 500 }], "2026-09-03");
    expect(carriedFromDay(carried, "2026-09-03")).toBe("2026-09-01");
    expect(carriedFromDay(carried, "2026-09-01")).toBeNull();
  });
});
