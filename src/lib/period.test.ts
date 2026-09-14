import { describe, expect, test } from "vitest";
import { compareDates, periodBounds } from "./dates";
import {
  dayWindowLabel,
  ALL_TIME_FLOOR,
  currentPeriodLabel,
  periodParams,
  periodQuery,
  withPeriod,
  currentPeriodParams,
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

  /**
   * 🔴 `isCurrent` HAS TWO ENDS AND NEITHER WAS PINNED.
   *
   * Every fixture asks on 2026-07-08 — comfortably inside July, on neither the
   * 1st nor the 31st — so both `>= 0` → `> 0` on the lower bound and `<= 0` →
   * `< 0` on the upper survived the suite. A month you are standing on the
   * first day of is the CURRENT month, and so is one on its last day; getting
   * either wrong turns off the pace tile and the "so far" wording on the two
   * days of the month a reader is most likely to be looking.
   */
  test("a period is current on its own first day and on its own last", () => {
    expect(resolvePeriod({ period: "2026-07" }, "2026-07-01").isCurrent).toBe(true);
    expect(resolvePeriod({ period: "2026-07" }, "2026-07-31").isCurrent).toBe(true);
    // …and not on the days either side of it
    expect(resolvePeriod({ period: "2026-07" }, "2026-06-30").isCurrent).toBe(false);
    expect(resolvePeriod({ period: "2026-07" }, "2026-08-01").isCurrent).toBe(false);
    // the same at year granularity, where the ends are eleven months apart
    expect(resolvePeriod({ period: "2026" }, "2026-01-01").isCurrent).toBe(true);
    expect(resolvePeriod({ period: "2026" }, "2026-12-31").isCurrent).toBe(true);
    expect(resolvePeriod({ period: "2026" }, "2025-12-31").isCurrent).toBe(false);
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

describe("week + day granularities (user ask: Week/Day views)", () => {
  test("a day key resolves to a one-day period", () => {
    const r = resolvePeriod({ period: "2026-07-16" }, TODAY);
    expect(r.granularity).toBe("day");
    expect(r.from).toBe("2026-07-16");
    expect(r.to).toBe("2026-07-16");
    expect(r.key).toBe("2026-07-16");
    expect(r.label).toBe("Jul 16, 2026");
  });

  test("a week key resolves Monday→Sunday and normalizes any in-week anchor", () => {
    const monday = resolvePeriod({ period: "W2026-07-13" }, TODAY);
    expect(monday.granularity).toBe("week");
    expect(monday.from).toBe("2026-07-13");
    expect(monday.to).toBe("2026-07-19");
    expect(monday.key).toBe("W2026-07-13");
    // a mid-week anchor lands on the SAME canonical week
    const thursday = resolvePeriod({ period: "W2026-07-16" }, TODAY);
    expect(thursday.key).toBe("W2026-07-13");
    expect(thursday.from).toBe("2026-07-13");
  });

  test("an invalid day/week key falls back to the current month", () => {
    expect(resolvePeriod({ period: "2026-13-45" }, TODAY).granularity).toBe("month");
    expect(resolvePeriod({ period: "W2026-99-99" }, TODAY).granularity).toBe("month");
  });

  test("paging steps a day by 1 and a week by 7", () => {
    expect(stepPeriodParams(resolvePeriod({ period: "2026-07-16" }, TODAY), 1)).toEqual({ period: "2026-07-17" });
    expect(stepPeriodParams(resolvePeriod({ period: "2026-07-16" }, TODAY), -1)).toEqual({ period: "2026-07-15" });
    expect(stepPeriodParams(resolvePeriod({ period: "W2026-07-13" }, TODAY), 1)).toEqual({ period: "W2026-07-20" });
    expect(stepPeriodParams(resolvePeriod({ period: "W2026-07-13" }, TODAY), -1)).toEqual({ period: "W2026-07-06" });
  });

  test("switching granularity anchors on the period start", () => {
    const july = resolvePeriod({ period: "2026-07" }, TODAY);
    expect(switchGranularityParams(july, "day")).toEqual({ period: "2026-07-01" });
    // 2026-07-01 is a Wednesday — its week starts Monday 2026-06-29
    expect(switchGranularityParams(july, "week")).toEqual({ period: "W2026-06-29" });
    const week = resolvePeriod({ period: "W2026-07-13" }, TODAY);
    expect(switchGranularityParams(week, "month")).toEqual({ period: "2026-07" });
  });

  test("subBuckets: a week tiles 7 day buckets, a day is a single bucket", () => {
    const week = subBuckets(resolvePeriod({ period: "W2026-07-13" }, TODAY));
    expect(week).toHaveLength(7);
    expect(week[0]!.from).toBe("2026-07-13");
    expect(week[6]!.to).toBe("2026-07-19");
    const day = subBuckets(resolvePeriod({ period: "2026-07-16" }, TODAY));
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ from: "2026-07-16", to: "2026-07-16" });
  });

  test("currentPeriodParams targets today's period at each granularity", () => {
    expect(currentPeriodParams("day", "2026-07-16")).toEqual({ period: "2026-07-16" });
    expect(currentPeriodParams("week", "2026-07-16")).toEqual({ period: "W2026-07-13" });
    expect(currentPeriodParams("month", "2026-07-16")).toEqual({ period: "2026-07" });
    expect(currentPeriodParams("quarter", "2026-07-16")).toEqual({ period: "2026-Q3" });
    expect(currentPeriodParams("year", "2026-07-16")).toEqual({ period: "2026" });
  });

  test("currentPeriodLabel names each reset", () => {
    expect(currentPeriodLabel("day")).toBe("Today");
    expect(currentPeriodLabel("week")).toBe("This week");
    expect(currentPeriodLabel("month")).toBe("This month");
    expect(currentPeriodLabel("quarter")).toBe("This quarter");
    expect(currentPeriodLabel("year")).toBe("This year");
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

describe("anchored ranges — YTD and All time", () => {
  const TODAY = "2026-08-06";

  test("YTD runs from Jan 1 to today and is always in progress", () => {
    const p = resolvePeriod({ period: "YTD" }, TODAY);
    expect(p.granularity).toBe("ytd");
    expect(p.from).toBe("2026-01-01");
    expect(p.to).toBe(TODAY);
    expect(p.label).toBe("2026 to date");
    // the window ends today by definition, so spending pace always applies
    expect(p.isCurrent).toBe(true);
  });

  test("All time starts at the ledger's own first day when it is given", () => {
    const p = resolvePeriod({ period: "ALL" }, TODAY, "2022-08-15");
    expect(p.granularity).toBe("all");
    expect(p.from).toBe("2022-08-15");
    expect(p.to).toBe(TODAY);
    expect(p.label).toBe("All time");
  });

  test("All time falls back to the floor when no ledger day is known", () => {
    // a pure caller (no database) still resolves, just from the constant
    expect(resolvePeriod({ period: "ALL" }, TODAY).from).toBe(ALL_TIME_FLOOR);
  });

  test("All time never inverts, even if handed a start in the future", () => {
    // from > to would make every range query return nothing, silently
    const p = resolvePeriod({ period: "ALL" }, TODAY, "2030-01-01");
    expect(compareDates(p.from, p.to)).toBeLessThanOrEqual(0);
    expect(p.from).toBe(TODAY);
  });

  test("YTD steps to the SAME window a year earlier, not the previous N days", () => {
    // the useful comparison for "2026 to date" is "2025 to date"
    const p = resolvePeriod({ period: "YTD" }, TODAY);
    expect(stepPeriodParams(p, -1)).toEqual({ from: "2025-01-01", to: "2025-08-06" });
  });

  /*
   * 🔴 On a leap day the prior-year window was built as `${y-1}${to.slice(4)}`
   * — the string "2027-02-29", which is not a date. `resolvePeriod` rejects it
   * and falls back to the CURRENT MONTH, so a reader asking for the prior year
   * to date silently gets four weeks instead, with nothing saying so.
   *
   * ⚠️ Not reachable by clicking: `PeriodSelector` suppresses both pager arrows
   * for the anchored ranges. It IS reachable by URL, and by any future caller
   * of `stepPeriodParams` — which is why this is fixed rather than filed.
   */
  test("a leap-day YTD steps to a real date, clamped", () => {
    const leap = resolvePeriod({ period: "YTD" }, "2028-02-29");
    expect(leap.to).toBe("2028-02-29");
    const prior = stepPeriodParams(leap, -1);
    expect(prior).toEqual({ from: "2027-01-01", to: "2027-02-28" });
    // and it must survive the round trip that the invalid date failed
    const resolved = resolvePeriod(prior as { from: string; to: string }, "2028-02-29");
    expect(resolved.granularity).toBe("custom");
    expect(resolved.from).toBe("2027-01-01");
    expect(resolved.to).toBe("2027-02-28");
  });

  test("a leap-day YTD stepped back four years lands on the leap day again", () => {
    const leap = resolvePeriod({ period: "YTD" }, "2028-02-29");
    expect(stepPeriodParams(leap, -4)).toEqual({ from: "2024-01-01", to: "2024-02-29" });
  });

  test("All time steps to the window before the ledger began", () => {
    // ⛔ a window before the records, not an empty one: paging may land there,
    // but no comparison may read it as a measured zero — `compared-windows`
    // refuses it, and its own tests pin that (this one only pins the step)
    const p = resolvePeriod({ period: "ALL" }, TODAY, "2026-08-01");
    const prev = stepPeriodParams(p, -1);
    expect(compareDates(prev.to!, p.from)).toBeLessThan(0);
  });

  test("switching into an anchored range always lands on the live window", () => {
    const march = resolvePeriod({ period: "2026-03" }, TODAY);
    expect(switchGranularityParams(march, "ytd")).toEqual({ period: "YTD" });
    expect(switchGranularityParams(march, "all")).toEqual({ period: "ALL" });
  });

  test("the reset link names each range", () => {
    expect(currentPeriodLabel("ytd")).toBe("Year to date");
    expect(currentPeriodLabel("all")).toBe("All time");
    expect(currentPeriodParams("ytd", TODAY)).toEqual({ period: "YTD" });
    expect(currentPeriodParams("all", TODAY)).toEqual({ period: "ALL" });
  });

  test("an unknown period string still falls back to the current month", () => {
    // "YTD"/"ALL" must not have widened the parser into accepting anything
    expect(resolvePeriod({ period: "ALLTIME" }, TODAY).granularity).toBe("month");
    expect(resolvePeriod({ period: "ytd" }, TODAY).granularity).toBe("month");
  });
})

describe("month bucket labels disambiguate across years", () => {
  test("a single-year window keeps the bare month name", () => {
    const p = resolvePeriod({ period: "2026" }, "2026-08-06");
    expect(subBuckets(p).map((b) => b.label).slice(0, 3)).toEqual(["Jan", "Feb", "Mar"]);
  });

  test("a multi-year window carries the year, so four Augusts are distinguishable", () => {
    const p = resolvePeriod({ period: "ALL" }, "2026-08-06", "2022-08-15");
    const labels = subBuckets(p).map((b) => b.label);
    // 🔴 both ends are CLAMPED and used to read "Aug '22" and "Aug '26" — the
    // first holds Aug 15–31 and the last Aug 1–6, and each sat in a row of
    // whole months a reader compares bar heights across
    expect(labels[0]).toBe("Aug 15–31 '22");
    expect(labels.at(-1)).toBe("Aug 1–6 '26");
    expect(labels[1]).toBe("Sep '22");
    // the whole point: no label appears twice
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("YTD stays within one year, so it stays bare — except the month it stops inside", () => {
    const p = resolvePeriod({ period: "YTD" }, "2026-08-06");
    expect(subBuckets(p).map((b) => b.label)).toEqual([
      "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug 1–6",
    ]);
  });
})

describe("a clamped month bucket is named by the days it holds", () => {
  const p = (params: Record<string, string>) => resolvePeriod(params, TODAY, "2022-08-15");

  test("a custom window's two clamped ends name their own days", () => {
    const b = subBuckets(p({ from: "2026-02-15", to: "2026-05-10" }));
    expect(b.map((x) => x.label)).toEqual(["Feb 15–28", "Mar", "Apr", "May 1–10"]);
  });

  test("a clamped bucket holding one day is named by that day, not a range", () => {
    // ≥46 days, or the window buckets by day and there is no month label at all
    const b = subBuckets(p({ from: "2026-02-28", to: "2026-06-01" }));
    expect(b.map((x) => x.label)).toEqual(["Feb 28", "Mar", "Apr", "May", "Jun 1"]);
  });

  test("a window whose ends fall on month boundaries keeps the bare names", () => {
    const b = subBuckets(p({ from: "2026-02-01", to: "2026-04-30" }));
    expect(b.map((x) => x.label)).toEqual(["Feb", "Mar", "Apr"]);
  });

  test("the label always describes the bucket's own from/to", () => {
    // the invariant, not three examples: every clamped bucket names its days
    for (const params of [
      { from: "2026-02-15", to: "2026-05-10" },
      { period: "YTD" },
      { period: "ALL" },
    ]) {
      const period = resolvePeriod(params, TODAY, "2022-08-15");
      for (const b of subBuckets(period)) {
        if (b.key.length !== 7) continue;
        const { start, end } = periodBounds(`${b.key}-01`, "monthly");
        if (b.from === start && b.to === end) continue;
        expect(b.label).toContain(String(Number(b.from.slice(8, 10))));
        expect(b.label).toContain(String(Number(b.to.slice(8, 10))));
      }
    }
  });
});

describe("a day bucket that could collide carries its month", () => {
  test("a month's own days stay bare — they cannot collide", () => {
    const b = subBuckets(resolvePeriod({ period: "2026-07" }, TODAY));
    expect(b[0]!.label).toBe("1");
    expect(b.at(-1)!.label).toBe("31");
  });

  test("a custom window crossing a month end names the month, so 25 and 25 differ", () => {
    // 🔴 `?from=2026-07-25&to=2026-08-25` drew two bars both labelled "25", and
    // the tooltip and the table lens's "Period" cell read the same string.
    const b = subBuckets(resolvePeriod({ from: "2026-07-25", to: "2026-08-25" }, TODAY));
    expect(b[0]!.label).toBe("Jul 25");
    expect(b.at(-1)!.label).toBe("Aug 25");
    expect(new Set(b.map((x) => x.label)).size).toBe(b.length);
  });

  test("a week straddling a month end is the same shape", () => {
    const b = subBuckets(resolvePeriod({ period: "W2026-07-29" }, TODAY));
    expect(b.map((x) => x.label)).toEqual(["Jul 27", "Jul 28", "Jul 29", "Jul 30", "Jul 31", "Aug 1", "Aug 2"]);
  });

  test("a window crossing a year end carries the year too", () => {
    const b = subBuckets(resolvePeriod({ from: "2025-12-28", to: "2026-01-03" }, TODAY));
    expect(b[0]!.label).toBe("Dec 28 '25");
    expect(b.at(-1)!.label).toBe("Jan 3 '26");
    expect(new Set(b.map((x) => x.label)).size).toBe(b.length);
  });
});

describe("dayWindowLabel — a window named by its own two ends", () => {
  /*
   * The rule six surfaces now read: the merchant share sentence and its strip
   * caption, /spending's cash-earnings notes, the dashboard's custom-window
   * header, the scrub chart's reset pill and its too-little-data note, and the
   * activity panel. It drops only what genuinely repeats.
   */
  test("one day is a day", () => {
    expect(dayWindowLabel("2026-02-07", "2026-02-07")).toBe("Feb 7, 2026");
  });

  test("two days in one month repeat neither the month nor the year", () => {
    expect(dayWindowLabel("2026-02-16", "2026-02-17")).toBe("Feb 16 – 17, 2026");
  });

  test("two months in one year repeat only the year", () => {
    expect(dayWindowLabel("2026-06-04", "2026-10-14")).toBe("Jun 4 – Oct 14, 2026");
  });

  test("a window crossing a year names BOTH", () => {
    // 🔴 `formatDayShort` on both ends dropped the year always, so the
    // dashboard's custom window read "Nov 15 – Feb 3" beside a header on the
    // same line printing "opened Jan 13, 2026".
    expect(dayWindowLabel("2025-11-15", "2026-02-03")).toBe("Nov 15, 2025 – Feb 3, 2026");
  });

  test("the same day-of-month in two months is still two days", () => {
    expect(dayWindowLabel("2026-07-25", "2026-08-25")).toBe("Jul 25 – Aug 25, 2026");
  });
});

describe("periodParams / periodQuery / withPeriod — a link lands where it was clicked from", () => {
  /**
   * 🔴 A BARE HREF IS NOT "NO PERIOD". `resolvePeriod`'s fallback is the current
   * calendar month, so on the real ledger 2026-09-11 every category link on
   * `/spending?period=2026-07` opened a September 2026 page reading
   * "$0.00 · 0 transactions" — a month with nothing imported in it.
   */
  test("a keyed period travels as ?period=", () => {
    const july = resolvePeriod({ period: "2026-07" }, TODAY);
    expect(periodParams(july)).toEqual({ period: "2026-07" });
    expect(periodQuery(july)).toBe("period=2026-07");
    expect(withPeriod("/categories/abc", july)).toBe("/categories/abc?period=2026-07");
    // …and it round-trips: the destination resolves the window the caller measured
    expect(resolvePeriod({ period: "2026-07" }, TODAY).from).toBe(july.from);
    expect(resolvePeriod({ period: "2026-07" }, TODAY).to).toBe(july.to);
  });

  test("a custom window has no key, so it travels as ?from=&to=", () => {
    const custom = resolvePeriod({ from: "2026-03-04", to: "2026-05-06" }, TODAY);
    expect(custom.key).toBeNull();
    expect(periodParams(custom)).toEqual({ from: "2026-03-04", to: "2026-05-06" });
    expect(withPeriod("/spending", custom)).toBe("/spending?from=2026-03-04&to=2026-05-06");
    const back = resolvePeriod({ from: "2026-03-04", to: "2026-05-06" }, TODAY);
    expect([back.from, back.to]).toEqual([custom.from, custom.to]);
  });

  test("the anchored ranges travel by their key, not by their resolved ends", () => {
    // ⛔ YTD and All END AT TODAY. Sending their ends as from/to would freeze
    // them at the day the link was rendered; the key keeps them anchored.
    //
    // 🔴 THIS TEST COULD NOT FAIL AS FIRST WRITTEN. It asked for "ytd" and "all",
    // which `resolvePeriod` does not recognise, so both iterations fell back to
    // the current month and the anchored branch never ran — and it compared
    // against `p.key`, the very value the implementation reads. The keys are
    // upper-case, the granularity proves the branch ran, and the expectation is
    // a literal.
    for (const [key, granularity] of [["YTD", "ytd"], ["ALL", "all"]] as const) {
      const p = resolvePeriod({ period: key }, TODAY);
      expect(p.granularity).toBe(granularity);
      expect(periodParams(p)).toEqual({ period: key });
      expect(periodParams(p)).not.toHaveProperty("from");
      expect(withPeriod("/x", p)).toBe(`/x?period=${key}`);
    }
  });

  test("a bare link would mean the current month — which is the defect", () => {
    const bare = resolvePeriod({}, TODAY);
    expect(bare.key).toBe(TODAY.slice(0, 7)); // this clock's own month, not "none"
    // so a link clicked on a MARCH page that carried nothing lands on July
    const march = resolvePeriod({ period: "2026-03" }, TODAY);
    expect(bare.from).not.toBe(march.from);
    expect(withPeriod("/categories/abc", march)).toBe("/categories/abc?period=2026-03");
  });
});
