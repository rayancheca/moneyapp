import { describe, expect, test } from "vitest";
import { applyInFlight, inFlightDeltaByDay, type InFlightAdjustment } from "./in-flight";

const win = (startDay: string, endDay: string | null, deltaCents: number): InFlightAdjustment => ({
  startDay,
  endDay,
  deltaCents,
});

const pt = (day: string, totalCents: number) => ({ day, totalCents });

describe("inFlightDeltaByDay", () => {
  test("no adjustments -> empty map", () => {
    expect(inFlightDeltaByDay(["2026-01-01", "2026-01-02"], []).size).toBe(0);
  });

  test("half-open window [start, end): start day adjusted, end day not", () => {
    const map = inFlightDeltaByDay(
      ["2026-03-26", "2026-03-27", "2026-03-30", "2026-03-31"],
      [win("2026-03-27", "2026-03-31", 1_296_200)],
    );
    expect(map.get("2026-03-26")).toBeUndefined();
    expect(map.get("2026-03-27")).toBe(1_296_200);
    expect(map.get("2026-03-30")).toBe(1_296_200);
    expect(map.get("2026-03-31")).toBeUndefined();
  });

  test("a day inside the range but not equal to startDay is still adjusted (day-gapped axis)", () => {
    // the series skips days (union-of-covered-days axis) — range comparison, not identity
    const map = inFlightDeltaByDay(["2026-01-01", "2026-01-04"], [win("2026-01-02", "2026-01-06", 500)]);
    expect(map.get("2026-01-01")).toBeUndefined();
    expect(map.get("2026-01-04")).toBe(500);
  });

  test("negative delta (money posted in both accounts) subtracts", () => {
    const map = inFlightDeltaByDay(
      ["2025-01-28", "2025-01-29"],
      [win("2025-01-28", "2025-01-29", -1_000_000)],
    );
    expect(map.get("2025-01-28")).toBe(-1_000_000);
    expect(map.get("2025-01-29")).toBeUndefined();
  });

  test("overlapping windows sum per day", () => {
    const map = inFlightDeltaByDay(
      ["2026-06-01", "2026-06-02", "2026-06-03"],
      [win("2026-06-01", "2026-06-03", 100), win("2026-06-02", "2026-06-04", 50)],
    );
    expect(map.get("2026-06-01")).toBe(100);
    expect(map.get("2026-06-02")).toBe(150);
    expect(map.get("2026-06-03")).toBe(50);
  });

  test("open-ended window (endDay null) runs to the end of the axis", () => {
    const map = inFlightDeltaByDay(
      ["2026-05-01", "2026-05-02", "2026-05-09"],
      [win("2026-05-02", null, 700)],
    );
    expect(map.get("2026-05-01")).toBeUndefined();
    expect(map.get("2026-05-02")).toBe(700);
    expect(map.get("2026-05-09")).toBe(700);
  });

  test("window entirely outside the axis has no effect", () => {
    const map = inFlightDeltaByDay(["2026-01-01"], [win("2026-02-01", "2026-02-03", 999)]);
    expect(map.size).toBe(0);
  });

  test("windows that cancel to zero on a day are dropped, not stored as 0", () => {
    const map = inFlightDeltaByDay(
      ["2026-06-01"],
      [win("2026-06-01", "2026-06-02", 100), win("2026-06-01", "2026-06-02", -100)],
    );
    expect(map.get("2026-06-01")).toBeUndefined();
  });
});

describe("applyInFlight", () => {
  test("no adjustments -> totals unchanged, inTransitCents 0 everywhere", () => {
    const out = applyInFlight([pt("2026-01-01", 1000), pt("2026-01-02", 1100)], []);
    expect(out).toEqual([
      { day: "2026-01-01", totalCents: 1000, inTransitCents: 0 },
      { day: "2026-01-02", totalCents: 1100, inTransitCents: 0 },
    ]);
  });

  test("bridges the dip: totals inside the window are lifted by the in-flight amount", () => {
    // the user's Mar 26-31 shape: money leaves view on the 27th, returns on the 31st
    const out = applyInFlight(
      [
        pt("2026-03-26", 7_000_000),
        pt("2026-03-27", 5_700_000),
        pt("2026-03-30", 5_710_000),
        pt("2026-03-31", 7_010_000),
      ],
      [win("2026-03-27", "2026-03-31", 1_296_200)],
    );
    expect(out.map((p) => p.totalCents)).toEqual([7_000_000, 6_996_200, 7_006_200, 7_010_000]);
    expect(out.map((p) => p.inTransitCents)).toEqual([0, 1_296_200, 1_296_200, 0]);
  });

  test("removes a double-count: negative delta lowers the doubled day", () => {
    const out = applyInFlight(
      [pt("2025-01-27", 5_000_000), pt("2025-01-28", 6_000_000), pt("2025-01-29", 5_000_000)],
      [win("2025-01-28", "2025-01-29", -1_000_000)],
    );
    expect(out.map((p) => p.totalCents)).toEqual([5_000_000, 5_000_000, 5_000_000]);
    expect(out[1]!.inTransitCents).toBe(-1_000_000);
  });

  test("preserves every other field on the point (generic passthrough)", () => {
    const rich = { day: "2026-01-01", totalCents: 100, complete: true, coveredAccounts: 3 };
    const out = applyInFlight([rich], [win("2026-01-01", null, 50)]);
    expect(out[0]).toEqual({ ...rich, totalCents: 150, inTransitCents: 50 });
  });

  test("does not mutate the input points", () => {
    const input = [pt("2026-01-01", 100)];
    applyInFlight(input, [win("2026-01-01", null, 50)]);
    expect(input[0]).toEqual({ day: "2026-01-01", totalCents: 100 });
  });

  test("empty series -> empty result", () => {
    expect(applyInFlight([], [win("2026-01-01", null, 50)])).toEqual([]);
  });

  /**
   * A zero-delta adjustment is skipped before it ever touches a day. It matters
   * that this is skipped at the SOURCE and not merely pruned afterwards: the
   * final prune only removes days whose NET is zero, so a real +500 on the same
   * day as a 0 would keep the day and the 0 would be invisible either way —
   * this asserts the cheaper guard actually holds, and that a detector emitting
   * a no-op window cannot manufacture a `0` entry in the delta map.
   */
  test("an adjustment with a zero delta contributes no day at all", () => {
    expect(inFlightDeltaByDay(["2026-01-01", "2026-01-02"], [win("2026-01-01", null, 0)]).size).toBe(
      0,
    );
  });

  test("a zero-delta window does not disturb a real one covering the same days", () => {
    const deltas = inFlightDeltaByDay(
      ["2026-01-01", "2026-01-02"],
      [win("2026-01-01", null, 0), win("2026-01-01", null, 500)],
    );
    expect([...deltas.entries()]).toEqual([
      ["2026-01-01", 500],
      ["2026-01-02", 500],
    ]);
  });
});
