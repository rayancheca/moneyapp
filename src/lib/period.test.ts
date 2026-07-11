import { describe, expect, test } from "vitest";
import {
  heatmapInitialMonth,
  quarterBounds,
  quarterOfMonth,
  resolvePeriod,
  stepPeriodParams,
  subBuckets,
  switchGranularityParams,
  type ResolvedPeriod,
} from "./period";

const TODAY = "2026-07-08";

describe("quarterOfMonth", () => {
  test("maps each month to its quarter", () => {
    expect([1, 2, 3].map(quarterOfMonth)).toEqual([1, 1, 1]);
    expect([4, 5, 6].map(quarterOfMonth)).toEqual([2, 2, 2]);
    expect([7, 8, 9].map(quarterOfMonth)).toEqual([3, 3, 3]);
    expect([10, 11, 12].map(quarterOfMonth)).toEqual([4, 4, 4]);
  });
});

describe("quarterBounds", () => {
  test("Q1 and Q4 span the right inclusive days", () => {
    expect(quarterBounds(2026, 1)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(quarterBounds(2026, 4)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
  });
  test("Q3 ends on Sep 30", () => {
    expect(quarterBounds(2026, 3)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });
});

describe("resolvePeriod", () => {
  test("month key resolves to that calendar month", () => {
    const p = resolvePeriod({ period: "2026-07" }, TODAY);
    expect(p).toMatchObject({ granularity: "month", key: "2026-07", from: "2026-07-01", to: "2026-07-31", label: "July 2026", isCurrent: true });
  });

  test("February resolves to 28 days in a non-leap year, 29 in a leap year", () => {
    expect(resolvePeriod({ period: "2025-02" }, TODAY).to).toBe("2025-02-28");
    expect(resolvePeriod({ period: "2024-02" }, TODAY).to).toBe("2024-02-29");
  });

  test("quarter key resolves to the quarter span", () => {
    const p = resolvePeriod({ period: "2026-Q3" }, TODAY);
    expect(p).toMatchObject({ granularity: "quarter", key: "2026-Q3", from: "2026-07-01", to: "2026-09-30", label: "Q3 2026", isCurrent: true });
  });

  test("year key resolves to the whole year", () => {
    const p = resolvePeriod({ period: "2026" }, TODAY);
    expect(p).toMatchObject({ granularity: "year", key: "2026", from: "2026-01-01", to: "2026-12-31", label: "2026", isCurrent: true });
  });

  test("custom from/to wins over anything", () => {
    const p = resolvePeriod({ period: "2026-07", from: "2026-03-05", to: "2026-04-20" }, TODAY);
    expect(p).toMatchObject({ granularity: "custom", key: null, from: "2026-03-05", to: "2026-04-20" });
    expect(p.isCurrent).toBe(false);
  });

  test("custom label collapses same-month, spells cross-month and cross-year", () => {
    expect(resolvePeriod({ from: "2026-07-03", to: "2026-07-03" }, TODAY).label).toBe("Jul 3, 2026");
    expect(resolvePeriod({ from: "2026-07-03", to: "2026-07-20" }, TODAY).label).toBe("Jul 3 – 20, 2026");
    expect(resolvePeriod({ from: "2026-07-03", to: "2026-08-02" }, TODAY).label).toBe("Jul 3 – Aug 2, 2026");
    expect(resolvePeriod({ from: "2025-12-20", to: "2026-01-05" }, TODAY).label).toBe("Dec 20, 2025 – Jan 5, 2026");
  });

  test("malformed / missing period falls back to the current month", () => {
    for (const bad of [undefined, null, "", "nonsense", "2026-13", "2026-Q9", "2026-00"]) {
      const p = resolvePeriod({ period: bad }, TODAY);
      expect(p).toMatchObject({ granularity: "month", key: "2026-07" });
    }
  });

  test("custom with from>to or invalid dates is ignored (falls through)", () => {
    expect(resolvePeriod({ from: "2026-08-01", to: "2026-07-01" }, TODAY).granularity).toBe("month");
    expect(resolvePeriod({ from: "not-a-date", to: "2026-07-01" }, TODAY).granularity).toBe("month");
    expect(resolvePeriod({ from: "2026-07-01" }, TODAY).granularity).toBe("month"); // only one bound
  });

  test("isCurrent is false for a past period", () => {
    expect(resolvePeriod({ period: "2025-01" }, TODAY).isCurrent).toBe(false);
    expect(resolvePeriod({ period: "2024" }, TODAY).isCurrent).toBe(false);
  });
});

describe("stepPeriodParams", () => {
  const step = (params: Parameters<typeof resolvePeriod>[0], delta: number) =>
    stepPeriodParams(resolvePeriod(params, TODAY), delta);

  test("month paging crosses the year boundary both ways", () => {
    expect(step({ period: "2026-01" }, -1)).toEqual({ period: "2025-12" });
    expect(step({ period: "2026-12" }, 1)).toEqual({ period: "2027-01" });
  });

  test("quarter paging wraps the year", () => {
    expect(step({ period: "2026-Q1" }, -1)).toEqual({ period: "2025-Q4" });
    expect(step({ period: "2026-Q4" }, 1)).toEqual({ period: "2027-Q1" });
  });

  test("year paging adds", () => {
    expect(step({ period: "2026" }, 1)).toEqual({ period: "2027" });
    expect(step({ period: "2026" }, -3)).toEqual({ period: "2023" });
  });

  test("custom paging shifts the window by its own length", () => {
    // 2026-07-03..2026-07-12 is 10 days → previous is 06-23..07-02
    expect(step({ from: "2026-07-03", to: "2026-07-12" }, -1)).toEqual({ from: "2026-06-23", to: "2026-07-02" });
    expect(step({ from: "2026-07-03", to: "2026-07-12" }, 1)).toEqual({ from: "2026-07-13", to: "2026-07-22" });
  });
});

describe("switchGranularityParams", () => {
  const from = (params: Parameters<typeof resolvePeriod>[0]) => resolvePeriod(params, TODAY);

  test("month → quarter → year anchor on the month", () => {
    const july = from({ period: "2026-07" });
    expect(switchGranularityParams(july, "quarter")).toEqual({ period: "2026-Q3" });
    expect(switchGranularityParams(july, "year")).toEqual({ period: "2026" });
    expect(switchGranularityParams(july, "month")).toEqual({ period: "2026-07" });
  });

  test("quarter/year → month anchors on the period start", () => {
    expect(switchGranularityParams(from({ period: "2026-Q3" }), "month")).toEqual({ period: "2026-07" });
    expect(switchGranularityParams(from({ period: "2026" }), "month")).toEqual({ period: "2026-01" });
  });

  test("custom → month/quarter/year anchors on `from`", () => {
    const custom = from({ from: "2026-05-14", to: "2026-06-02" });
    expect(switchGranularityParams(custom, "month")).toEqual({ period: "2026-05" });
    expect(switchGranularityParams(custom, "quarter")).toEqual({ period: "2026-Q2" });
    expect(switchGranularityParams(custom, "year")).toEqual({ period: "2026" });
  });
});

describe("subBuckets", () => {
  const p = (params: Parameters<typeof resolvePeriod>[0]) => resolvePeriod(params, TODAY);

  test("a month buckets by day, one per calendar day, labelled by day number", () => {
    const b = subBuckets(p({ period: "2026-07" }));
    expect(b).toHaveLength(31);
    expect(b[0]).toEqual({ key: "2026-07-01", from: "2026-07-01", to: "2026-07-01", label: "1" });
    expect(b[30]).toEqual({ key: "2026-07-31", from: "2026-07-31", to: "2026-07-31", label: "31" });
  });

  test("a quarter buckets into its 3 months, labelled by short name", () => {
    const b = subBuckets(p({ period: "2026-Q3" }));
    expect(b.map((x) => x.label)).toEqual(["Jul", "Aug", "Sep"]);
    expect(b[0]).toEqual({ key: "2026-07", from: "2026-07-01", to: "2026-07-31", label: "Jul" });
    expect(b[2]!.to).toBe("2026-09-30");
  });

  test("a year buckets into 12 months", () => {
    const b = subBuckets(p({ period: "2026" }));
    expect(b).toHaveLength(12);
    expect(b[0]!.from).toBe("2026-01-01");
    expect(b[11]!.to).toBe("2026-12-31");
  });

  test("a short custom window buckets by day", () => {
    const b = subBuckets(p({ from: "2026-07-03", to: "2026-07-06" }));
    expect(b.map((x) => x.key)).toEqual(["2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"]);
  });

  test("a long custom window buckets by month, clamped at both ends", () => {
    const b = subBuckets(p({ from: "2026-02-15", to: "2026-05-10" }));
    expect(b.map((x) => x.key)).toEqual(["2026-02", "2026-03", "2026-04", "2026-05"]);
    expect(b[0]).toMatchObject({ from: "2026-02-15", to: "2026-02-28" }); // clamped start
    expect(b[3]).toMatchObject({ from: "2026-05-01", to: "2026-05-10" }); // clamped end
  });

  test("buckets tile the period with no gaps or overlaps", () => {
    for (const params of [{ period: "2026-07" }, { period: "2026-Q3" }, { period: "2026" }, { from: "2026-02-15", to: "2026-05-10" }]) {
      const period = p(params);
      const b = subBuckets(period);
      expect(b[0]!.from).toBe(period.from);
      expect(b.at(-1)!.to).toBe(period.to);
      for (let i = 1; i < b.length; i += 1) {
        // each bucket starts the day after the previous ends
        expect(new Date(b[i]!.from).getTime()).toBe(new Date(b[i - 1]!.to).getTime() + 86_400_000);
      }
    }
  });
});

describe("heatmapInitialMonth", () => {
  const p = (params: Parameters<typeof resolvePeriod>[0]) => resolvePeriod(params, TODAY);

  test("in-progress period opens on today's month", () => {
    expect(heatmapInitialMonth(p({ period: "2026" }), TODAY)).toBe("2026-07");
    expect(heatmapInitialMonth(p({ period: "2026-Q3" }), TODAY)).toBe("2026-07");
  });
  test("past period opens on its last month", () => {
    expect(heatmapInitialMonth(p({ period: "2025" }), TODAY)).toBe("2025-12");
  });
  test("future period opens on its first month", () => {
    expect(heatmapInitialMonth(p({ period: "2027" }), TODAY)).toBe("2027-01");
  });
  test("a month period always opens on itself", () => {
    expect(heatmapInitialMonth(p({ period: "2025-03" }), TODAY)).toBe("2025-03");
  });
});

// exported type is used by services — a compile-time smoke check
const _typecheck: ResolvedPeriod = resolvePeriod({ period: "2026" }, TODAY);
void _typecheck;
