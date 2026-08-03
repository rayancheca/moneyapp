import { describe, expect, test } from "vitest";
import { addDays } from "./dates";
import {
  compactMoney,
  dateAxisTicks,
  niceLinearTicks,
  windowExtremes,
} from "./chart-axis";

/** Inclusive [from, to] daily range, ascending — a stand-in for the net-worth series. */
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

describe("niceLinearTicks", () => {
  test("frames a wide range on round ticks (the real $18k–$110k net-worth span)", () => {
    const { domain, ticks } = niceLinearTicks(1_800_000, 11_000_000);
    expect(domain).toEqual([0, 12_500_000]); // $0 … $125k
    expect(ticks).toEqual([0, 2_500_000, 5_000_000, 7_500_000, 10_000_000, 12_500_000]);
  });

  test("frames a narrow window tightly instead of pinning it under $0", () => {
    // a $92k–$94k month must show its $2k of movement
    const { domain, ticks } = niceLinearTicks(9_200_000, 9_400_000);
    expect(domain).toEqual([9_200_000, 9_400_000]);
    expect(ticks).toEqual([9_200_000, 9_250_000, 9_300_000, 9_350_000, 9_400_000]);
  });

  test("a flat window synthesizes a centered band, never a zero-height line", () => {
    const { domain, ticks } = niceLinearTicks(9_400_000, 9_400_000);
    expect(domain[0]).toBeLessThan(9_400_000);
    expect(domain[1]).toBeGreaterThan(9_400_000);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  test("guards non-finite input", () => {
    expect(niceLinearTicks(NaN, 5)).toEqual({ domain: [0, 1], ticks: [0, 1] });
  });

  test("selects each nice step (1 / 2 / 10) as the rough spacing lands in its band", () => {
    // rough = range / (count-1) = range / 4
    expect(niceLinearTicks(0, 4).ticks).toEqual([0, 1, 2, 3, 4]); // rough 1 → step 1
    expect(niceLinearTicks(0, 6).ticks).toEqual([0, 2, 4, 6]); // rough 1.5 → step 2
    expect(niceLinearTicks(0, 28).ticks).toEqual([0, 10, 20, 30]); // rough 7 → step 10
  });

  test("a tiny sub-zero dip binds the bottom to the dip, not a full range-step below 0 (P0.3)", () => {
    // real bug: a −$106 Chase overdraft under a $13.1k window (cents) made the
    // range-step ($5,000) floor the axis to −$5,000 — a third of the chart wasted
    // below an invisible balance. The bottom should snug to the dip (≈ −$250) and
    // the scale stay anchored at 0.
    const { domain, ticks } = niceLinearTicks(-10_600, 1_310_000);
    expect(domain).toEqual([-25_000, 1_500_000]); // −$250 … $15k, not −$5,000
    expect(ticks).toEqual([0, 500_000, 1_000_000, 1_500_000]); // 0 is a tick, clean multiples
    expect(ticks[0]).toBe(0); // zero-anchored
    expect(domain[0]).toBeLessThanOrEqual(-10_600); // the dip is never clipped
    expect(domain[0]).toBeGreaterThan(-500_000); // and never a full range-step down
  });

  test("a dip that is a large fraction of the range keeps the range-step floor", () => {
    // −$4,800 under $13.1k is a real slice of the window — floor to −$5,000 as
    // before (the snug rule is only for a NEGLIGIBLE dip).
    const { domain, ticks } = niceLinearTicks(-480_000, 1_310_000);
    expect(domain[0]).toBe(-500_000);
    expect(ticks).toContain(0);
    expect(ticks).toContain(-500_000);
  });

  test("an all-negative window is unchanged (the snug rule needs a positive top)", () => {
    const { domain, ticks } = niceLinearTicks(-1_310_000, -10_600);
    const norm = (n: number) => n + 0; // normalize -0 → 0 for stable equality
    expect(domain.map(norm)).toEqual([-1_500_000, 0]);
    expect(ticks.map(norm)).toEqual([-1_500_000, -1_000_000, -500_000, 0]);
  });
});

describe("dateAxisTicks", () => {
  test("a 2-year span → 6-month boundaries, year on the first tick + at each year change", () => {
    const ticks = dateAxisTicks(dayRange("2024-07-11", "2026-07-10"));
    expect(ticks.map((t) => t.day)).toEqual(["2024-08-01", "2025-02-01", "2025-08-01", "2026-02-01"]);
    // first tick carries the year (multi-year window); then the year is stamped
    // only where it changes — so the second Aug (same year as Feb ’25) stays bare
    expect(ticks.map((t) => t.label)).toEqual(["Aug ’24", "Feb ’25", "Aug", "Feb ’26"]);
  });

  test("a dense monthly window crossing New Year stamps the year only at the boundary", () => {
    const ticks = dateAxisTicks(dayRange("2024-12-11", "2026-01-20"));
    // monthly-ish boundaries; the year appears on the first tick and again at the
    // Jan turnover, never repeated on every month
    const labels = ticks.map((t) => t.label);
    expect(labels.filter((l) => /’/.test(l)).length).toBeLessThanOrEqual(2);
    expect(labels.some((l) => /Jan ’26/.test(l))).toBe(true);
  });

  test("a ~quarter window in one year → monthly boundaries without years", () => {
    const ticks = dateAxisTicks(dayRange("2026-04-11", "2026-07-10"));
    expect(ticks.map((t) => t.day)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
    expect(ticks.map((t) => t.label)).toEqual(["May", "Jun", "Jul"]);
  });

  test("a sub-6-week window → day boundaries ending on the last point", () => {
    const ticks = dateAxisTicks(dayRange("2026-06-11", "2026-07-10"));
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.map((t) => t.label)).toContain("Jun 11");
    expect(ticks[ticks.length - 1]!.day).toBe("2026-07-10"); // always anchors the last point
  });

  test("a tiny window strides by 1 and lands on the last point without duplicating it", () => {
    const ticks = dateAxisTicks(dayRange("2026-07-05", "2026-07-10"));
    expect(ticks.map((t) => t.day)).toEqual([
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ]);
  });

  test("the anchored last day drops a crowding neighbor rather than doubling up", () => {
    // 32 days, stride 7 → ticks at indices 0,7,14,21,28 then the last is index 31;
    // 28 and 31 are only 3 apart, so the anchor replaces the index-28 tick
    const ticks = dateAxisTicks(dayRange("2026-06-10", "2026-07-11"));
    expect(ticks[ticks.length - 1]!.day).toBe("2026-07-11");
    expect(ticks.map((t) => t.day)).not.toContain("2026-07-08"); // the crowding neighbor is gone
    expect(ticks.map((t) => t.day)).toEqual([
      "2026-06-10",
      "2026-06-17",
      "2026-06-24",
      "2026-07-01",
      "2026-07-11",
    ]);
  });

  test("a well-spaced final stride tick is kept, and the last day is still anchored", () => {
    // 34 days, stride 7 → ticks at 0,7,14,21,28 then the last at index 33; the
    // gap (5) exceeds half a step, so index 28 stays AND the last day is added
    const ticks = dateAxisTicks(dayRange("2026-06-08", "2026-07-11"));
    expect(ticks.map((t) => t.day)).toContain("2026-07-06"); // the index-28 stride tick survives
    expect(ticks[ticks.length - 1]!.day).toBe("2026-07-11"); // last day still anchored
  });

  test("a mid-month window that straddles only one boundary falls back to its endpoints", () => {
    // span > 45 (month branch) but only a single interior month-start exists →
    // the endpoints read better than a lone off-center tick
    const ticks = dateAxisTicks(dayRange("2026-02-02", "2026-03-20"));
    expect(ticks).toEqual([
      { day: "2026-02-02", label: "Feb 2" },
      { day: "2026-03-20", label: "Mar 20" },
    ]);
  });

  test("a multi-year span falls back to the largest step → yearly boundaries", () => {
    // span/30/slots exceeds every MONTH_STEP, so the step saturates at 12 months
    const ticks = dateAxisTicks(dayRange("2020-01-01", "2026-01-20"));
    expect(ticks.map((t) => t.day)).toEqual([
      "2021-01-01",
      "2022-01-01",
      "2023-01-01",
      "2024-01-01",
      "2025-01-01",
      "2026-01-01",
    ]);
    // every tick is a fresh year, so each carries its year
    expect(ticks.every((t) => /’\d\d$/.test(t.label))).toBe(true);
  });

  test("degenerate inputs fall back to endpoints", () => {
    expect(dateAxisTicks([])).toEqual([]);
    expect(dateAxisTicks(["2026-07-10"])).toEqual([{ day: "2026-07-10", label: "Jul 10" }]);
  });
});

describe("compactMoney", () => {
  test("k / M / bare with one significant decimal where it helps", () => {
    expect(compactMoney(0)).toBe("$0");
    expect(compactMoney(2_500_000)).toBe("$25k");
    expect(compactMoney(12_000_000)).toBe("$120k");
    expect(compactMoney(9_414_453)).toBe("$94.1k");
    expect(compactMoney(120_000_000)).toBe("$1.2M");
    expect(compactMoney(-4_364)).toBe("-$44");
  });
});

describe("windowExtremes", () => {
  test("peak and trough, ignoring null days, first occurrence on ties", () => {
    const ex = windowExtremes([
      { day: "a", valueCents: 100 },
      { day: "b", valueCents: 50 },
      { day: "c", valueCents: 150 },
      { day: "d", valueCents: null },
      { day: "e", valueCents: 150 },
    ]);
    expect(ex).toEqual({ min: { day: "b", cents: 50 }, max: { day: "c", cents: 150 } });
  });

  test("null when nothing is chartable", () => {
    expect(windowExtremes([{ day: "a", valueCents: null }])).toBeNull();
  });
});

/**
 * `dateAxisTicks` must keep refusing an instant, on BOTH of its branches.
 *
 * This is why the 1D view cannot be built by adding a label field to the point
 * shape: tick SELECTION here is `diffDays(first, last)`, not just tick
 * labelling, and the ≤2-point branch formats with `formatDayShort`. Both parse a
 * calendar day. The session arrives with its ticks already chosen instead — see
 * `sessionView` in intraday-axis.
 */
describe("dateAxisTicks refuses an instant", () => {
  const INSTANTS = [
    "2026-07-31T13:30:00.000Z",
    "2026-07-31T13:35:00.000Z",
    "2026-07-31T13:40:00.000Z",
  ];

  test("on the span-based branch (3+ points)", () => {
    expect(() => dateAxisTicks(INSTANTS)).toThrow(/Invalid ISO date/);
  });

  test("on the short-series branch (≤2 points)", () => {
    expect(() => dateAxisTicks(INSTANTS.slice(0, 2))).toThrow(/Invalid ISO date/);
  });
});
