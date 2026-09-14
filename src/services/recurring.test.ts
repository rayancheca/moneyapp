import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { addDays } from "@/lib/dates";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { categorizeAll, detectTransfers } from "./categorize";
import {
  absorbIntoLiveSeries,
  amountsAreStable,
  analyzeGroup,
  detectRecurringSeries,
  loadRecomputeCtx,
  fitCadence,
  isDayOfMonthBimodal,
  isSeriesActive,
  seriesEvidence,
  lapsedSeriesShouldStopForecasting,
  listSeries,
  median,
  populationStddev,
  projectOccurrences,
  rollForwardNextExpected,
  seriesHasLapsed,
  seriesStaleness,
  setSeriesStatus,
  upcomingOccurrences,
  type SeriesOverrides,
} from "./recurring";

const TODAY = "2026-07-08";

/** Deterministic PRNG (mulberry32) — the corpus must be identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("statistics primitives", () => {
  test("median of odd-length list", () => {
    expect(median([31, 28, 31, 30, 31])).toBe(31);
  });

  test("median of even-length list averages the middle pair", () => {
    expect(median([28, 30, 31, 31])).toBe(30.5);
  });

  test("population stddev of identical values is 0", () => {
    expect(populationStddev([1549, 1549, 1549])).toBe(0);
  });

  test("population stddev matches a hand calculation", () => {
    // mean 20, deviations ±10 → variance 100 → stddev 10
    expect(populationStddev([10, 30, 10, 30])).toBe(10);
  });
});

describe("isDayOfMonthBimodal", () => {
  test("1st + 15th pattern is bimodal", () => {
    expect(isDayOfMonthBimodal([1, 15, 1, 15, 1, 15])).toBe(true);
  });

  test("weekend-shifted clusters (±1 day) still count as two modes", () => {
    expect(isDayOfMonthBimodal([1, 2, 15, 16, 1, 15])).toBe(true);
  });

  test("biweekly drift across the month is not bimodal", () => {
    expect(isDayOfMonthBimodal([2, 16, 30, 13, 27, 10, 24])).toBe(false);
  });

  test("a single stray day is not a second mode", () => {
    expect(isDayOfMonthBimodal([1, 1, 1, 1, 15])).toBe(false);
  });
});

describe("fitCadence buckets", () => {
  test("weekly: median 5–9 days", () => {
    expect(fitCadence(7, [1, 8, 15])).toBe("weekly");
    expect(fitCadence(5, [1, 6, 11])).toBe("weekly");
    expect(fitCadence(9, [1, 10, 19])).toBe("weekly");
  });

  test("monthly: median 28–33 days", () => {
    expect(fitCadence(31, [1, 1, 1])).toBe("monthly");
    expect(fitCadence(28, [15, 15, 15])).toBe("monthly");
  });

  test("quarterly and annual buckets", () => {
    expect(fitCadence(91, [1, 1, 1])).toBe("quarterly");
    expect(fitCadence(365.5, [10, 10, 10])).toBe("annual");
  });

  test("semimonthly needs day-of-month bimodality", () => {
    expect(fitCadence(14, [1, 15, 1, 15, 1, 15])).toBe("semimonthly");
  });

  test("median 14–16 without bimodality prefers biweekly (too close to call)", () => {
    expect(fitCadence(14, [2, 16, 30, 13, 27])).toBe("biweekly");
    expect(fitCadence(16, [3, 19, 4, 20, 6])).toBe("biweekly");
  });

  test("median 17 without bimodality is not a series", () => {
    expect(fitCadence(17, [2, 19, 5, 22, 9])).toBeNull();
  });

  test("gaps outside every bucket are rejected", () => {
    expect(fitCadence(3, [1, 4, 7])).toBeNull();
    expect(fitCadence(11, [1, 12, 23])).toBeNull();
    expect(fitCadence(20, [1, 21, 11])).toBeNull();
    expect(fitCadence(50, [1, 21, 11])).toBeNull();
    expect(fitCadence(200, [1, 21, 11])).toBeNull();
  });
});

describe("analyzeGroup", () => {
  const txn = (id: string, postedOn: string, amountCents: number) => ({ id, postedOn, amountCents });

  test("fewer than 3 occurrences is never a series", () => {
    expect(analyzeGroup([txn("a", "2026-01-01", -1000), txn("b", "2026-02-01", -1000)])).toBeNull();
  });

  /**
   * The end of the chain the anchor day exists for. Detection sees a month-end
   * bill whose newest posting is February's clamp; the stored `next_expected_on`
   * has to come out on the 31st of March, not the 28th.
   */
  test("a month-end series stores the anchor day and projects past the clamp", () => {
    const stats = analyzeGroup([
      txn("a", "2026-12-31", -228570),
      txn("b", "2027-01-31", -228570),
      txn("c", "2027-02-28", -228570),
    ]);
    expect(stats).not.toBeNull();
    expect(stats!.cadence).toBe("monthly");
    expect(stats!.anchorDay).toBe(31);
    // the newest posting is the clamped 28th, and the next charge is NOT the 28th
    expect(stats!.lastMatchedOn).toBe("2027-02-28");
    expect(stats!.nextExpectedOn).toBe("2027-03-31");
  });

  test("an ordinary mid-month series records no anchor day and is unchanged", () => {
    const stats = analyzeGroup([
      txn("a", "2026-01-08", -180000),
      txn("b", "2026-02-08", -180000),
      txn("c", "2026-03-08", -180000),
    ]);
    expect(stats!.anchorDay).toBeNull();
    expect(stats!.nextExpectedOn).toBe("2026-04-08");
  });

  test("unstable amounts (stddev/|mean| > 0.2) are rejected", () => {
    expect(
      analyzeGroup([
        txn("a", "2026-01-01", -1000),
        txn("b", "2026-02-01", -9000),
        txn("c", "2026-03-01", -400),
      ]),
    ).toBeNull();
  });

  test("identical amounts pass stability even with zero variance shortcut", () => {
    const stats = analyzeGroup([
      txn("a", "2026-01-01", -180000),
      txn("b", "2026-02-01", -180000),
      txn("c", "2026-03-01", -180000),
    ]);
    expect(stats).not.toBeNull();
    expect(stats!.cadence).toBe("monthly");
    expect(stats!.amountCentsStddev).toBe(0);
    expect(stats!.amountCentsAvg).toBe(-180000);
    // Charges on the 1st. Gaps 31 + 28 → mean 29.5, inside the calendar-month
    // band, so the anchor is one calendar month on and keeps the 1st. The old
    // round(median 29.5) = 30-day walk anchored it on 2026-03-31 — a bill that
    // has only ever landed on the 1st, expected on the 31st.
    expect(stats!.nextExpectedOn).toBe("2026-04-01");
  });

  /**
   * The shape this model could not express until `anchor_day` existed, kept as a
   * regression pin. A bill on the LAST day of each month has no single ISO date
   * meaning "the 31st": the anchor one month past 2027-01-31 is 2027-02-28, and
   * a walk indexing off that stored anchor sat on the 28th — three days early in
   * every long month, forever.
   *
   * Both halves are asserted below, because the difference between them IS the
   * feature: carrying the anchor day recovers the 31st, and dropping it
   * reproduces the old defect exactly.
   */
  test("a month-end bill recovers its day from the anchor, and loses it without", () => {
    const stats = analyzeGroup([
      txn("a", "2026-08-31", -210900),
      txn("b", "2026-09-30", -210900),
      txn("c", "2026-10-31", -210900),
      txn("d", "2026-11-30", -210900),
      txn("e", "2026-12-31", -210900),
      txn("f", "2027-01-31", -210900),
    ]);
    expect(stats!.cadence).toBe("monthly");
    // detection reads the day from all six postings, not from the newest one
    expect(stats!.anchorDay).toBe(31);
    // the stored anchor is still February's clamp — that part is unavoidable
    expect(stats!.nextExpectedOn).toBe("2027-02-28");

    const base = {
      id: "eom",
      name: "Rent",
      kind: "bill" as const,
      cadence: stats!.cadence,
      intervalDaysAvg: stats!.intervalDaysAvg,
      nextExpectedOn: stats!.nextExpectedOn,
      nextExpectedAmountCents: stats!.nextExpectedAmountCents,
    };
    const dates = (s: typeof base & { anchorDay?: number | null }) =>
      projectOccurrences(s, "2027-02-01", "2027-05-31").map((o) => o.date);

    // WITH the anchor day: every month lands on its own last day
    expect(dates({ ...base, anchorDay: stats!.anchorDay })).toEqual([
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);

    // WITHOUT it: the clamp is inherited and never let go — the old defect
    expect(dates(base)).toEqual(["2027-02-28", "2027-03-28", "2027-04-28", "2027-05-28"]);
  });

  test("a monthly group outside the calendar band keeps the day-stepped anchor", () => {
    // 28-day gaps are FOUR-WEEKLY: the charge really does walk backwards through
    // the month, so reading it as "the 1st of each month" would be an invention.
    // fitCadence still buckets it monthly (median 28 is inside 28–33), which is
    // exactly why the projection guard has to be two-sided.
    const stats = analyzeGroup([
      txn("a", "2026-01-01", -1000),
      txn("b", "2026-01-29", -1000),
      txn("c", "2026-02-26", -1000),
    ]);
    expect(stats!.cadence).toBe("monthly");
    expect(stats!.intervalDaysAvg).toBe(28);
    expect(stats!.nextExpectedOn).toBe("2026-03-26");
  });

  test("stores every stat the UI needs to show the math", () => {
    const stats = analyzeGroup([
      txn("a", "2026-01-05", -5000),
      txn("b", "2026-01-12", -5200),
      txn("c", "2026-01-19", -4800),
      txn("d", "2026-01-26", -5000),
    ]);
    expect(stats).toMatchObject({
      cadence: "weekly",
      medianGapDays: 7,
      intervalDaysAvg: 7,
      toleranceDays: 2,
      amountCentsAvg: -5000,
      nextExpectedOn: "2026-02-02",
      nextExpectedAmountCents: -5000,
      lastMatchedOn: "2026-01-26",
    });
    expect(stats!.confidence).toBeGreaterThan(0.5);
  });
});

describe("projectOccurrences", () => {
  const series = {
    id: "s1",
    name: "Payroll",
    kind: "income" as const,
    cadence: "weekly" as const,
    intervalDaysAvg: 7,
    nextExpectedOn: "2026-07-09",
    nextExpectedAmountCents: 80000,
  };

  const lease = {
    id: "lease",
    name: "Car lease",
    kind: "bill" as const,
    cadence: "monthly" as const,
    intervalDaysAvg: 30,
    nextExpectedOn: "2026-09-11",
    nextExpectedAmountCents: -55989,
    userEndsOn: "2028-08-11",
  };

  test("userEndsOn stops the projection — a 24-payment lease is not monthly forever", () => {
    // the car lease shape: without an end it projects past its final payment and
    // every long-range forecast silently over-counts
    const short = { ...lease, nextExpectedOn: "2026-07-11", userEndsOn: "2026-09-11" };
    const occ = projectOccurrences(short, "2026-07-01", "2026-12-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-11", "2026-08-11", "2026-09-11"]);
  });

  /**
   * The real ledger's lease: 24 payments from 2026-09-11 with a user end on
   * 2028-08-11. No test in the suite projected a monthly series past ~2 months
   * before this one, which is why day stepping's drift — a full ten days over
   * two years — never showed up in a single assertion.
   */
  test("a two-year monthly commitment lands on its own end date, not ten days early", () => {
    const occ = projectOccurrences(lease, "2026-09-01", "2029-12-31");
    expect(occ).toHaveLength(24);
    expect(occ[0]!.date).toBe("2026-09-11");
    expect(occ.at(-1)!.date).toBe("2028-08-11");
    // every single payment on the 11th — the day the lease is actually billed
    expect(occ.every((o) => o.date.endsWith("-11"))).toBe(true);
  });

  test("a 31-day month never holds two charges of a monthly series", () => {
    // 2027-12 is the first month day stepping double-bills the rent: 12-01 AND
    // 12-31, projecting $4,571.40 against a $2,109 budget.
    const rent = {
      ...lease,
      name: "Rent",
      nextExpectedOn: "2026-08-08",
      nextExpectedAmountCents: -228570,
      userEndsOn: null,
    };
    const occ = projectOccurrences(rent, "2027-12-01", "2027-12-31");
    expect(occ.map((o) => o.date)).toEqual(["2027-12-08"]);
  });

  test("a monthly series never disappears from a short month", () => {
    // The mirror of the double-billed December, and the worse of the two: a
    // 30-day walk from 2026-01-30 lands on 2026-03-01, so February holds NO
    // rent at all and $2,285.70 of committed money vanishes from that period.
    const rent = { ...lease, name: "Rent", nextExpectedOn: "2026-01-30", nextExpectedAmountCents: -228570, userEndsOn: null };
    const feb = projectOccurrences(rent, "2026-02-01", "2026-02-28");
    expect(feb.map((o) => o.date)).toEqual(["2026-02-28"]);
  });

  test("a month-end anchor clamps into February WITHOUT losing the 31st after", () => {
    // the trap in iterative stepping: 01-31 → 02-28 → 03-28 loses the day-of-
    // month for good. Every date is measured from the anchor, so it comes back.
    const eom = { ...lease, nextExpectedOn: "2026-01-31", userEndsOn: null };
    const occ = projectOccurrences(eom, "2026-01-01", "2026-06-30");
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
  });

  test("a monthly series outside the calendar band still walks in days", () => {
    // 53.25 days is a real stored value on the ledger (Rocket Money Premium).
    // Nothing about it is a calendar month, and pretending otherwise would
    // silently halve the interval.
    const drifting = { ...lease, intervalDaysAvg: 53.25, nextExpectedOn: "2026-09-11", userEndsOn: null };
    const occ = projectOccurrences(drifting, "2026-09-01", "2026-12-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-09-11", "2026-11-03", "2026-12-26"]);
  });

  test("a null userEndsOn stays open-ended", () => {
    const occ = projectOccurrences({ ...series, userEndsOn: null }, "2026-07-08", "2026-07-31");
    expect(occ).toHaveLength(4);
  });

  test("a weekly series contributes every expected date inside the window", () => {
    const occ = projectOccurrences(series, "2026-07-08", "2026-07-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-09", "2026-07-16", "2026-07-23", "2026-07-30"]);
    expect(occ.every((o) => o.amountCents === 80000)).toBe(true);
  });

  test("overdue expected dates roll forward instead of projecting the past", () => {
    const occ = projectOccurrences({ ...series, nextExpectedOn: "2026-07-01" }, "2026-07-08", "2026-07-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"]);
  });

  test("a series without next-expected data projects nothing", () => {
    expect(projectOccurrences({ ...series, nextExpectedOn: null }, "2026-07-08", "2026-07-31")).toEqual([]);
  });

  test("staleness supplied by the caller rides onto every occurrence", () => {
    const staleness = seriesStaleness({ ...series, userCadence: null, userNextExpectedOn: null, userAmountCents: null, lastMatchedOn: "2026-06-16" }, "2026-07-08");
    const occ = projectOccurrences({ ...series, staleness }, "2026-07-08", "2026-07-31");
    expect(occ).toHaveLength(4);
    expect(occ.every((o) => o.staleness === staleness)).toBe(true);
  });

  test("a caller that supplies none gets none — undefined never reads as fresh", () => {
    const occ = projectOccurrences(series, "2026-07-08", "2026-07-31");
    expect(occ.every((o) => o.staleness === undefined)).toBe(true);
  });
});

/**
 * Item 13a, as revised by the owner on 2026-08-17.
 *
 * The old rule was that `upcomingOccurrences` and `forecast.ts` keep every
 * detected|confirmed series and DISCLOSE how old its evidence is, leaving only
 * recurring-calendar.ts to resolve lateness by omission. In practice that put
 * `UBER *ONE` in the Upcoming list as a bill due next week wearing a "last seen
 * 449d ago" chip — a label apologising for a prediction that should not have
 * been made. Owner, verbatim: *"why would you keep the uber one if it was last
 * seen 449 days ago its clearly not recurring anymore"*.
 *
 * Staleness is still MEASURED and still travels on every occurrence (the chip
 * is right for a series that is merely late). What changed is that a series
 * whose evidence has fully run out is no longer forecast at all.
 */
describe("lapsedSeriesShouldStopForecasting", () => {
  test("money OUT stops being forecast once its evidence runs out", () => {
    expect(lapsedSeriesShouldStopForecasting("subscription")).toBe(true);
    expect(lapsedSeriesShouldStopForecasting("bill")).toBe(true);
  });

  test("money IN does not — irregular is how the owner is actually paid", () => {
    // ~$1,046/wk in cash, arriving in lumps weeks apart (pass 28). A quiet
    // stretch is import lag, not a lost job.
    expect(lapsedSeriesShouldStopForecasting("income")).toBe(false);
  });

  test("transfer and other follow the money-out rule", () => {
    expect(lapsedSeriesShouldStopForecasting("transfer")).toBe(true);
    expect(lapsedSeriesShouldStopForecasting("other")).toBe(true);
  });
});

describe("seriesStaleness", () => {
  const overrides = (
    over: Partial<SeriesOverrides & { lastMatchedOn: string | null }> = {},
  ): SeriesOverrides & { lastMatchedOn: string | null } => ({
    cadence: "weekly",
    userCadence: null,
    intervalDaysAvg: 7,
    nextExpectedOn: null,
    userNextExpectedOn: null,
    nextExpectedAmountCents: null,
    userAmountCents: null,
    lastMatchedOn: "2026-07-01",
    ...over,
  });

  test("a weekly series inside 1.5 intervals plus grace is fresh", () => {
    // weekly: step 7 → 7 × 1.5 + 2 grace = 12.5 days of tolerance
    expect(seriesStaleness(overrides({ lastMatchedOn: "2026-06-30" }), "2026-07-08")).toEqual({
      lastMatchedOn: "2026-06-30",
      daysSinceLastMatch: 8,
      stepDays: 7,
      toleranceDays: 12.5,
      isStale: false,
    });
  });

  test("the owner's 22-day cash-job gap reads stale but keeps every number", () => {
    const s = seriesStaleness(overrides({ lastMatchedOn: "2026-06-16" }), "2026-07-08");
    expect(s.daysSinceLastMatch).toBe(22);
    expect(s.isStale).toBe(true);
    // the point of the disclosure: the reader is told the age, not denied the row
    expect(s.stepDays).toBe(7);
    expect(s.toleranceDays).toBe(12.5);
  });

  test("the tolerance boundary is inclusive — exactly at it is not yet stale", () => {
    const monthly = overrides({ cadence: "monthly", intervalDaysAvg: 30 }); // 30 × 1.5 + 3 = 48
    expect(seriesStaleness({ ...monthly, lastMatchedOn: "2026-05-21" }, "2026-07-08").isStale).toBe(false);
    expect(seriesStaleness({ ...monthly, lastMatchedOn: "2026-05-20" }, "2026-07-08").isStale).toBe(true);
  });

  test("a series nothing has ever matched is stale, not silently fresh", () => {
    const s = seriesStaleness(overrides({ lastMatchedOn: null }), "2026-07-08");
    expect(s.daysSinceLastMatch).toBeNull();
    expect(s.lastMatchedOn).toBeNull();
    expect(s.isStale).toBe(true);
  });

  test("a cadence override judges lateness by its nominal step, not the old gap", () => {
    const s = seriesStaleness(
      overrides({ cadence: "monthly", userCadence: "weekly", intervalDaysAvg: 30, lastMatchedOn: "2026-06-25" }),
      "2026-07-08",
    );
    expect(s.stepDays).toBe(7); // weekly nominal, NOT the detected 30
    expect(s.toleranceDays).toBe(12.5);
    expect(s.isStale).toBe(true);
  });

  test("a series without interval stats falls back to its cadence nominal", () => {
    const s = seriesStaleness(overrides({ cadence: "annual", intervalDaysAvg: null }), "2026-07-08");
    expect(s.stepDays).toBe(365);
    expect(s.toleranceDays).toBe(365 * 1.5 + 14);
    expect(s.isStale).toBe(false);
  });

  test("isSeriesActive is exactly status-live AND not stale — they cannot drift", () => {
    for (const lastMatchedOn of ["2026-07-08", "2026-06-30", "2026-06-25", "2026-06-16", null]) {
      const s = overrides({ lastMatchedOn });
      const stale = seriesStaleness(s, "2026-07-08").isStale;
      expect(isSeriesActive({ ...s, status: "confirmed" }, "2026-07-08")).toBe(!stale);
      expect(isSeriesActive({ ...s, status: "detected" }, "2026-07-08")).toBe(!stale);
      // status still overrules: a dismissed series is never active, fresh or not
      expect(isSeriesActive({ ...s, status: "dismissed" }, "2026-07-08")).toBe(false);
      expect(isSeriesActive({ ...s, status: "ended" }, "2026-07-08")).toBe(false);
    }
  });

  /*
   * 🔴 /recurring's All tab filed the owner's weekly pay and five never-billed
   * commitments under "INACTIVE", each with a Next date on its own row and each
   * forecast one tab over. The word is chosen by the evidence now, through the
   * same kind gate the forecast applies. Killed by mutation: dropping the
   * never-billed branch, and dropping the kind gate (which files a late
   * paycheque as lapsed).
   */
  test("seriesEvidence names never-billed, late and lapsed by the gates the forecast uses", () => {
    const base = {
      cadence: "monthly" as const,
      userCadence: null,
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-08-01",
      userNextExpectedOn: null,
      nextExpectedAmountCents: -5000,
      userAmountCents: null,
      status: "confirmed" as const,
    };
    const today = "2026-07-08";
    expect(seriesEvidence({ ...base, kind: "bill", lastMatchedOn: null }, today)).toBe("never-billed");
    expect(seriesEvidence({ ...base, kind: "bill", lastMatchedOn: "2026-07-05" }, today)).toBe("active");
    // 74 days quiet: past the 1.5-cycle staleness bar, short of the 3-cycle lapse bar
    expect(seriesEvidence({ ...base, kind: "bill", lastMatchedOn: "2026-04-25" }, today)).toBe("running-late");
    // 157 days quiet: a bill this quiet is no longer forecast …
    expect(seriesEvidence({ ...base, kind: "bill", lastMatchedOn: "2026-02-01" }, today)).toBe("lapsed");
    // … and a paycheque this quiet is late, never lapsed — money in does not stop
    expect(seriesEvidence({ ...base, kind: "income", lastMatchedOn: "2026-02-01" }, today)).toBe("running-late");
    // the same gate the forecast reads, not a second copy of it
    expect(seriesHasLapsed({ ...base, lastMatchedOn: "2026-02-01" }, today)).toBe(true);
    expect(lapsedSeriesShouldStopForecasting("income")).toBe(false);
  });
});

/* ── synthetic corpus (Phase 6 fixed targets) ─────────────────────────── */

const KNOWN_SERIES_NAMES = [
  "Employer (cash)", // weekly cash salary via the seeded ATM rule
  "MONTHLY RENT PAYMENT", // exact monthly, description-fallback grouping
  "Netflix", // monthly subscription via the seeded merchant map
  "ONLINE TRANSFER TO SAVINGS REF", // biweekly transfer, outflow leg
  "ONLINE TRANSFER FROM CHECKING REF", // biweekly transfer, inflow leg
] as const;

const NOISE_WORDS = [
  "ZALVO", "MIRKET", "PLOVEN", "QUARNIX", "VELTIS", "DORNAB", "SELVIK",
  "TRUMBO", "HALVYON", "GRELDA", "OSMIRE", "FENWIP", "LUBROK", "TINDER0",
  "VARNISH9", "KOLPUT", "WREXIS", "YONDEL", "BLIMVER", "SORNAK",
] as const;

describe("a live series absorbs its own charges", () => {
  let dir: string;
  let bundle: DbBundle;
  let cardA: string;
  let cardB: string;
  let seq = 0;

  function insertTxn(accountId: string, postedOn: string, amountCents: number, raw: string): string {
    seq += 1;
    return bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: normalizeDescription(raw),
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: seq }),
      })
      .returning({ id: transactions.id })
      .get().id;
  }

  const seriesFor = (id: string) =>
    bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.recurringSeriesId;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-absorb-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    cardA = createAccount(bundle.db, { institutionId: chase.id, name: "Card A", type: "credit" });
    cardB = createAccount(bundle.db, { institutionId: chase.id, name: "Card B", type: "credit" });
    seq = 0;
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Three charges that detect into one series, plus a later one to absorb. */
  function buildDetected(): { seriesId: string } {
    for (const day of ["2026-04-10", "2026-05-10", "2026-06-10"]) {
      insertTxn(cardA, day, -5000, "BREEZELINE 866-290-5400 MA");
    }
    detectRecurringSeries(bundle.db, TODAY);
    const s = bundle.db.select().from(recurringSeries).all();
    expect(s).toHaveLength(1);
    return { seriesId: s[0]!.id };
  }

  test("a later charge on ANOTHER account still joins the series", () => {
    // The measured case: PURA VIDA's six untagged rows sit on Chase Sapphire
    // while its series lives on Venture X. The descriptor group key carries the
    // account, so the same merchant on a second card is a stranger to its own
    // series — and with an irregular gap the group cannot form a series of its
    // own either, so the rows simply stay untagged forever.
    const { seriesId } = buildDetected();
    const later = insertTxn(cardB, "2026-07-01", -5000, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(later)).toBe(seriesId);
  });

  test("a SINGLE later charge joins, though it could never form a series alone", () => {
    // One row is below MIN_OCCURRENCES, so the group loop skips it outright —
    // which is why a confirmed bill could not absorb its own new charges. The
    // real Breezeline charge of 2026-08-10 landed on the exact expected day for
    // the exact expected amount and stayed untagged; running detection against a
    // backup copy of the live database tagged zero new rows.
    const { seriesId } = buildDetected();
    const later = insertTxn(cardA, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(later)).toBe(seriesId);
  });

  test("a CONFIRMED series absorbs too — the owner already vouched for it", () => {
    const { seriesId } = buildDetected();
    setSeriesStatus(bundle.db, seriesId, "confirmed");
    const later = insertTxn(cardA, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(later)).toBe(seriesId);
  });

  test.each([["dismissed"], ["ended"]] as const)(
    "a %s series absorbs nothing — neither should be quietly growing",
    (status) => {
      /*
       * On cardB deliberately, so ABSORPTION is the only path that could reach
       * the row. The pre-existing group loop still sinks a same-account group of
       * ≥3 into a dismissed or ended series whatever this test says, and that
       * behaviour is load-bearing: without it the group would form a NEW series
       * on the next run and resurrect the very pattern the owner dismissed.
       * Absorption never creates a series, so declining to feed them here costs
       * nothing and cannot resurrect anything.
       */
      const { seriesId } = buildDetected();
      setSeriesStatus(bundle.db, seriesId, status);
      const later = insertTxn(cardB, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");

      detectRecurringSeries(bundle.db, TODAY);
      expect(seriesFor(later)).toBeNull();
    },
  );

  test("a DIFFERENT descriptor is never absorbed, however alike it looks", () => {
    // The real FPL case: the tagged row reads "ORIG CO NAME:FPL DIRECT DEBIT…"
    // and the untagged one "FPL DIRECT DEBIT ELEC PYMT PPD ID:…". A human can
    // see they are the same bill; the ledger cannot, and guessing is how a wrong
    // tag corrupts the calendar, the budget tail and the overdue detector at
    // once. An untagged row is honest.
    buildDetected();
    const other = insertTxn(cardA, "2026-07-06", -5000, "BREEZELINE REACHPLATFORM MOBILE");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(other)).toBeNull();
  });

  test("a row the USER attached is never re-tagged", () => {
    const { seriesId } = buildDetected();
    const mine = insertTxn(cardA, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: null, seriesLinkSource: "user" })
      .where(eq(transactions.id, mine))
      .run();

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(mine)).toBeNull();
  });

  test("an ambiguous descriptor is left alone rather than guessed at", () => {
    // Two live series carrying the same descriptor cannot both be right, and
    // picking one would be inventing a link.
    const { seriesId } = buildDetected();
    const twinId = bundle.db
      .insert(recurringSeries)
      .values({ name: "Twin", accountId: cardB, kind: "bill", cadence: "monthly", status: "confirmed" })
      .returning({ id: recurringSeries.id })
      .get().id;
    const claimed = insertTxn(cardB, "2026-03-10", -5000, "BREEZELINE 866-290-5400 MA");
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: twinId, seriesLinkSource: "detected" })
      .where(eq(transactions.id, claimed))
      .run();
    const later = insertTxn(cardB, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(later)).toBeNull();
    // …and neither existing link is disturbed.
    expect(seriesFor(claimed)).toBe(twinId);
    expect(bundle.db.select().from(recurringSeries).all().map((s) => s.id)).toContain(seriesId);
  });

  test("a DETECTED series refuses a charge that breaks its own stability bar", () => {
    /*
     * The defect absorption shipped with. "PURA VIDA" and "YA-FIT" are places
     * the owner eats; each had four charges that happened to cost about the
     * same, which squeaked under AMOUNT_STABILITY_CV_MAX. Absorbing seven more
     * took their amount CV to 0.672 and 0.463 — three times the gate — and
     * nothing re-ran it, so the app kept calling them subscriptions on worse
     * evidence than it started with. Owner: "you cant say doordash is recurring
     * . its not a fixed subsription its just me getting food."
     */
    const { seriesId } = buildDetected(); // three charges at -5000
    const wild = insertTxn(cardB, "2026-07-06", -42000, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(wild)).toBeNull();
    // …and the series it refused is untouched, not damaged.
    expect(
      bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get()!.status,
    ).toBe("detected");
  });

  test("a CONFIRMED series absorbs anyway — a gate must not overrule a human", () => {
    // The owner's rent runs an amount CV of 0.326 and FPL is a utility bill that
    // changes every month. Both are confirmed, and a statistical bar that
    // silently overrode his answer would be the app arguing with him.
    const { seriesId } = buildDetected();
    setSeriesStatus(bundle.db, seriesId, "confirmed");
    const wild = insertTxn(cardB, "2026-07-06", -42000, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(wild)).toBe(seriesId);
  });

  test("a detected series still takes a charge that keeps it stable", () => {
    const { seriesId } = buildDetected();
    const normal = insertTxn(cardB, "2026-07-06", -5100, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(normal)).toBe(seriesId);
  });

  test("running detection twice changes nothing the second time", () => {
    // §4.3's idempotency promise, which an absorption pass could easily break.
    //
    // Asserted on the STATE, not on `summary.taggedTransactions`: that counter
    // is `UPDATE … .changes`, which SQLite reports for a row whose value did not
    // move, so it is non-zero on any re-run and always has been. The contract
    // that matters is that no row's series changed.
    const { seriesId } = buildDetected();
    const later = insertTxn(cardB, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");
    const snapshot = () =>
      bundle.db
        .select({ id: transactions.id, seriesId: transactions.recurringSeriesId })
        .from(transactions)
        .all()
        .map((r) => `${r.id}:${r.seriesId ?? "-"}`)
        .sort();

    detectRecurringSeries(bundle.db, TODAY);
    const after = snapshot();
    expect(seriesFor(later)).toBe(seriesId);

    detectRecurringSeries(bundle.db, TODAY);
    expect(snapshot()).toEqual(after);
    expect(bundle.db.select().from(recurringSeries).all()).toHaveLength(1);
  });

  /*
   * The import path calls the same rule with a scope: only the rows an upload
   * inserted, promoted or restored may be claimed (owner, 2026-09-14). The OWNER
   * of a descriptor is still read from the whole ledger — Breezeline owns its
   * text through rows linked months ago, none of them in the upload.
   */
  test("a scoped absorption claims only its candidates, and still reads owners from the whole ledger", () => {
    const { seriesId } = buildDetected();
    const inScope = insertTxn(cardB, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");
    const outOfScope = insertTxn(cardA, "2026-07-01", -5000, "BREEZELINE 866-290-5400 MA");

    const result = bundle.db.transaction((tx) =>
      absorbIntoLiveSeries(tx, TODAY, loadRecomputeCtx(bundle.db), new Set([inScope])),
    );

    expect(seriesFor(inScope)).toBe(seriesId);
    expect(seriesFor(outOfScope)).toBeNull();
    expect(result.tagged).toBe(1);
    expect([...result.touched]).toEqual([seriesId]);
    // …and it settles what it grew, as detection always did
    expect(
      bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get()!.lastMatchedOn,
    ).toBe("2026-07-06");
  });

  test("an empty scope claims nothing, however absorbable the ledger is", () => {
    buildDetected();
    const later = insertTxn(cardA, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");

    const result = bundle.db.transaction((tx) =>
      absorbIntoLiveSeries(tx, TODAY, loadRecomputeCtx(bundle.db), new Set()),
    );

    expect(seriesFor(later)).toBeNull();
    expect(result.tagged).toBe(0);
    // the control: unscoped, the same row IS absorbable — so the scope did it
    detectRecurringSeries(bundle.db, TODAY);
    expect(seriesFor(later)).not.toBeNull();
  });

  test("absorption resettles the series' stats over its FULL tagged set", () => {
    // A row tagged without recomputing would leave last_matched_on and the
    // amount statistics describing a set the series no longer has — pass 60's
    // defect, in a new place.
    const { seriesId } = buildDetected();
    insertTxn(cardA, "2026-07-06", -5000, "BREEZELINE 866-290-5400 MA");

    detectRecurringSeries(bundle.db, TODAY);
    const s = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get()!;
    expect(s.lastMatchedOn).toBe("2026-07-06");
  });
});

describe("detection on the synthetic corpus", () => {
  let dir: string;
  let bundle: DbBundle;
  let checkingId: string;
  let savingsId: string;
  let cardId: string;
  let seq = 0;

  function insertTxn(accountId: string, postedOn: string, amountCents: number, rawDescription: string): string {
    seq += 1;
    return bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription,
        normalizedDescription: normalizeDescription(rawDescription),
        // seq salts the hash so intentionally-identical corpus rows coexist
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: seq }),
      })
      .returning({ id: transactions.id })
      .get().id;
  }

  /**
   * 6 months of known series + ~30 deterministic noise one-offs:
   * - weekly income, Thursdays, ±3% amount jitter (2026-01-01 is a Thursday)
   * - exact monthly rent on the 1st
   * - monthly $15.49 subscription on the 15th
   * - biweekly $200.00 transfer (both legs)
   * - 20 unique-description one-offs + 10 same-description random visits
   */
  function buildCorpus(): void {
    const rng = mulberry32(1337);

    for (let i = 0; i < 26; i++) {
      const jitter = 1 + (rng() * 0.06 - 0.03);
      insertTxn(checkingId, addDays("2026-01-01", i * 7), Math.round(80000 * jitter), "ATM CASH DEPOSIT NEW YORK");
    }

    for (const day of ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]) {
      insertTxn(checkingId, day, -180000, "MONTHLY RENT PAYMENT");
    }

    for (const day of ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"]) {
      insertTxn(cardId, day, -1549, "NETFLIX.COM NETFLIX.COM CA");
    }

    for (let i = 0; i < 13; i++) {
      const day = addDays("2026-01-02", i * 14);
      insertTxn(checkingId, day, -20000, "ONLINE TRANSFER TO SAVINGS REF 1234567");
      insertTxn(savingsId, day, 20000, "ONLINE TRANSFER FROM CHECKING REF 1234567");
    }

    for (const word of NOISE_WORDS) {
      const day = addDays("2026-01-01", Math.floor(rng() * 181));
      const amount = -Math.round(500 + rng() * 14500);
      insertTxn(cardId, day, amount, `POS PURCHASE ${word} LLC`);
    }
    for (let i = 0; i < 10; i++) {
      const day = addDays("2026-01-01", Math.floor(rng() * 181));
      const amount = -Math.round(500 + rng() * 9500);
      insertTxn(cardId, day, amount, "CORNER COFFEE SHOP");
    }

    categorizeAll(bundle.db);
    detectTransfers(bundle.db);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rec-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    savingsId = createAccount(bundle.db, { institutionId: chase.id, name: "Savings", type: "savings" });
    cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    buildCorpus();
    detectRecurringSeries(bundle.db, TODAY);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function allSeries() {
    return bundle.db.select().from(recurringSeries).all();
  }

  function seriesByName(name: string) {
    const row = allSeries().find((s) => s.name === name);
    if (!row) throw new Error(`series not detected: ${name}`);
    return row;
  }

  test("precision ≥ 95% and recall ≥ 90% against the known series", () => {
    const detected = allSeries();
    const known = new Set<string>(KNOWN_SERIES_NAMES);
    const truePositives = detected.filter((s) => known.has(s.name)).length;
    const precision = truePositives / detected.length;
    const recall = truePositives / KNOWN_SERIES_NAMES.length;
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  test("exact next expected date and amount on the noiseless monthly rent", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    expect(rent.cadence).toBe("monthly");
    // Six charges, every one on the 1st. gaps 31,28,31,30,31 → mean 30.2, inside
    // the calendar band → 2026-06-01 + one month. The day-stepped anchor was
    // 2026-07-02, a bill that has never once landed on the 2nd.
    expect(rent.nextExpectedOn).toBe("2026-07-01");
    expect(rent.nextExpectedAmountCents).toBe(-180000);
    expect(rent.amountCentsStddev).toBe(0);
    expect(rent.kind).toBe("bill");
    expect(rent.accountId).toBe(checkingId);
    expect(rent.merchantId).toBeNull();
  });

  test("weekly cash salary detects as income via the synthetic merchant", () => {
    const salary = seriesByName("Employer (cash)");
    expect(salary.cadence).toBe("weekly");
    expect(salary.kind).toBe("income");
    expect(salary.merchantId).not.toBeNull();
    // last deposit 2026-06-25, median gap 7
    expect(salary.nextExpectedOn).toBe("2026-07-02");
    expect(salary.nextExpectedAmountCents).toBeGreaterThan(76000);
    expect(salary.nextExpectedAmountCents).toBeLessThan(84000);
    expect(salary.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("merchant under Subscriptions detects as a subscription", () => {
    const netflix = seriesByName("Netflix");
    expect(netflix.kind).toBe("subscription");
    expect(netflix.cadence).toBe("monthly");
    // charges on the 15th; the 30/31-day walk anchored it on the 16th
    expect(netflix.nextExpectedOn).toBe("2026-07-15");
    expect(netflix.nextExpectedAmountCents).toBe(-1549);
  });

  test("both transfer legs detect as biweekly transfer kind — never income", () => {
    const out = seriesByName("ONLINE TRANSFER TO SAVINGS REF");
    const inn = seriesByName("ONLINE TRANSFER FROM CHECKING REF");
    expect(out.cadence).toBe("biweekly");
    expect(inn.cadence).toBe("biweekly");
    expect(out.kind).toBe("transfer");
    // the inflow leg has mean > 0 but its category kind is transfer
    expect(inn.kind).toBe("transfer");
  });

  test("matched transactions are tagged with their series id", () => {
    const salary = seriesByName("Employer (cash)");
    const tagged = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringSeriesId, salary.id))
      .all();
    expect(tagged).toHaveLength(26);
  });

  test("re-running detection never duplicates series", () => {
    const before = allSeries().length;
    const summary = detectRecurringSeries(bundle.db, TODAY);
    expect(allSeries().length).toBe(before);
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(before);
  });

  test("a dismissed series stays dismissed on re-run while stats refresh", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    setSeriesStatus(bundle.db, rent.id, "dismissed");
    insertTxn(checkingId, "2026-07-01", -180000, "MONTHLY RENT PAYMENT");

    detectRecurringSeries(bundle.db, TODAY);
    const after = seriesByName("MONTHLY RENT PAYMENT");
    expect(after.id).toBe(rent.id);
    expect(after.status).toBe("dismissed");
    expect(after.lastMatchedOn).toBe("2026-07-01");
    // gaps now 31,28,31,30,31,30 → median 30.5 → round 31 → Aug 1
    expect(after.nextExpectedOn).toBe("2026-08-01");
  });

  test("a confirmed series stays confirmed on re-run while stats refresh", () => {
    const netflix = seriesByName("Netflix");
    setSeriesStatus(bundle.db, netflix.id, "confirmed");
    insertTxn(cardId, "2026-07-15", -1549, "NETFLIX.COM NETFLIX.COM CA");
    categorizeAll(bundle.db); // assign the merchant to the new row

    detectRecurringSeries(bundle.db, "2026-07-20");
    const after = seriesByName("Netflix");
    expect(after.id).toBe(netflix.id);
    expect(after.status).toBe("confirmed");
    expect(after.lastMatchedOn).toBe("2026-07-15");
    expect(after.nextExpectedOn).toBe("2026-08-15");
  });

  test("upcoming occurrences are windowed, sorted, and skip dismissed series", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    setSeriesStatus(bundle.db, rent.id, "dismissed");

    const upcoming = upcomingOccurrences(bundle.db, TODAY, 30);
    expect(upcoming.length).toBeGreaterThan(0);
    expect(upcoming.some((o) => o.name === "MONTHLY RENT PAYMENT")).toBe(false);
    expect(upcoming.some((o) => o.name === "Netflix" && o.date === "2026-07-15")).toBe(true);
    const dates = upcoming.map((o) => o.date);
    expect([...dates].sort()).toEqual(dates);
    /*
     * ⛔ `addDays(TODAY, 29)`, not 30. `windowDays` counts days and today is
     * the FIRST of them, so a 30-day window's last legal date is day thirty.
     *
     * 🔴 This read `<= addDays(TODAY, 30)` — an assertion true of BOTH the
     * 30-day window and the 31-day one that shipped, so it could never have
     * caught the defect it sits next to. Its e2e twin was tightened when that
     * defect was fixed; this one was left behind.
     *
     * ⚠️ Tightening it adds no coverage on its own, and that was MEASURED
     * rather than assumed: with the 31-day mutant applied this test passes
     * either way, because no series in this fixture ever projects onto the
     * extra day. The boundary is pinned two tests below, by a series moved onto
     * it deliberately. This is corrected because a bound that misstates the
     * contract misleads the next reader, not because it catches anything.
     */
    const windowEnd = addDays(TODAY, 29);
    expect(dates.every((d) => d >= TODAY && d <= windowEnd)).toBe(true);
  });

  /* ── the window's far edge, pinned to a single day ──────────────────────
     🔴 `windowDays` used to end at `today + windowDays`, which is one day too
     many. Measured on the real ledger at today = 2026-09-01, the "Upcoming 30
     days" list showed `Flamingo South Beach (rent)` on BOTH 2026-09-01 and
     2026-10-01, and `Rent utilities & fees` likewise — a reader would take that
     as owing rent twice in a month.

     ⚠️ Only a monthly bill anchored on today's own day-of-month can show it,
     which is why no fixture caught it: every `TODAY` in this repo (the 8th, the
     24th) is a day no fixture bill is anchored on. The assertion that existed
     used `d <= addDays(TODAY, 30)`, which stays true either way. */

  /** Points Netflix (monthly, fresh) at an exact date. */
  function netflixDue(on: string): void {
    bundle.db
      .update(recurringSeries)
      .set({ nextExpectedOn: on, userNextExpectedOn: null })
      .where(eq(recurringSeries.id, seriesByName("Netflix").id))
      .run();
  }

  test("the last day of an N-day window is day N-1, and it is included", () => {
    netflixDue(addDays(TODAY, 29));
    const dates = upcomingOccurrences(bundle.db, TODAY, 30)
      .filter((o) => o.name === "Netflix")
      .map((o) => o.date);
    expect(dates).toEqual([addDays(TODAY, 29)]);
  });

  test("day N is outside it", () => {
    netflixDue(addDays(TODAY, 30));
    const hit = upcomingOccurrences(bundle.db, TODAY, 30).some((o) => o.name === "Netflix");
    expect(hit).toBe(false);
  });

  /**
   * The symptom itself: a monthly bill anchored on TODAY appears once in a
   * 30-day window, not twice. Under the old bound the window spanned 31 days and
   * caught the next month's charge as well.
   */
  test("a monthly bill due today appears ONCE in a 30-day window", () => {
    netflixDue(TODAY);
    const dates = upcomingOccurrences(bundle.db, TODAY, 30)
      .filter((o) => o.name === "Netflix")
      .map((o) => o.date);
    expect(dates).toEqual([TODAY]);
  });

  test("a series whose evidence has run out is not forecast at all", () => {
    // the UBER *ONE shape: monthly, last charged far beyond its own tolerance.
    // It used to appear as a bill due next week with a staleness chip attached.
    const netflix = seriesByName("Netflix");
    bundle.db
      .update(recurringSeries)
      .set({ lastMatchedOn: "2025-05-25" })
      .where(eq(recurringSeries.id, netflix.id))
      .run();

    expect(upcomingOccurrences(bundle.db, TODAY, 30).some((o) => o.name === "Netflix")).toBe(false);
  });

  test("but a series that has NEVER posted still is — it has not stopped, it has not started", () => {
    // The car lease the owner registered for 2026-09-11 has no postings by
    // definition. Gating on `isSeriesActive` instead would delete $559.89/month
    // of real commitment to remove $4.99 of dead Uber.
    const netflix = seriesByName("Netflix");
    bundle.db
      .update(recurringSeries)
      .set({ lastMatchedOn: null })
      .where(eq(recurringSeries.id, netflix.id))
      .run();

    expect(upcomingOccurrences(bundle.db, TODAY, 30).some((o) => o.name === "Netflix")).toBe(true);
  });

  test("a fresh series' occurrences carry staleness that says so", () => {
    // Netflix last charged 2026-06-15, monthly → 23 days against ~48 of tolerance
    const netflix = upcomingOccurrences(bundle.db, TODAY, 30).filter((o) => o.name === "Netflix");
    expect(netflix.length).toBeGreaterThan(0);
    expect(netflix[0]!.staleness).toMatchObject({
      lastMatchedOn: "2026-06-15",
      daysSinceLastMatch: 23,
      isStale: false,
    });
  });

  // THE regression guard for item 13a: the owner's weekly cash job runs weeks
  // behind on deposit/import lag. Filtering the upcoming list by isSeriesActive
  // would delete ~$1,046/wk of income he is still earning. It stays, marked.
  test("a stale income series is still projected, carrying how old its evidence is", () => {
    const later = "2026-08-01"; // 37 days after the last cash deposit (2026-06-25)
    const salary = upcomingOccurrences(bundle.db, later, 30).filter((o) => o.name === "Employer (cash)");

    expect(salary.length).toBeGreaterThan(0);
    expect(salary.every((o) => o.amountCents > 0)).toBe(true);
    expect(salary[0]!.staleness).toMatchObject({
      lastMatchedOn: "2026-06-25",
      daysSinceLastMatch: 37,
      isStale: true,
    });
    // every occurrence of the series is marked, not just the first
    expect(salary.every((o) => o.staleness?.isStale === true)).toBe(true);
  });

  test("setSeriesStatus rejects unknown ids", () => {
    expect(() => setSeriesStatus(bundle.db, "nope", "confirmed")).toThrow(/Unknown recurring series/);
  });

  // detection ran at TODAY and stored dates around July 2026; reading the list
  // 13 months later is exactly the stale-suggestion case (real data: UBER *ONE)
  test("a stale stored next-expected is listed rolled forward, never as a past date", () => {
    const later = "2027-08-08";
    const listed = listSeries(bundle.db, later);

    const live = listed.filter((s) => s.status === "detected" || s.status === "confirmed");
    expect(live.length).toBeGreaterThan(0);
    for (const s of live) {
      if (!s.nextExpectedOn) continue;
      expect(s.nextExpectedOn >= later).toBe(true);
    }

    const netflix = listed.find((s) => s.name === "Netflix")!;
    // stored 2026-07-15, 13 calendar months on is the first 15th not in the past
    expect(netflix.storedNextExpectedOn).toBe("2026-07-15");
    expect(netflix.nextExpectedOn).toBe("2027-08-15");
  });

  /*
   * 🔴 "posted avg" WAS NOT THE AVERAGE OF THE POSTINGS. It printed
   * `recurring_series.amount_cents_avg` — the detector's seed, written when the
   * series was created and never recomputed as rows are attached afterwards.
   *
   * Measured on the owner's ledger 2026-09-04, `/recurring?tab=all`:
   *
   *   Flamingo South Beach (rent)  "4 matched"  posted avg -$2,285.70
   *      the four linked charges are -$2,237.11, -$2,285.70, -$1,100.00 and
   *      -$1,334.80 — a mean of -$1,739.40. The printed figure is one of them.
   *   Cash job (weekly pay)        "2 matched"  posted avg +$1,046.00
   *      the two deposits sum to $1,447.00 — a mean of $723.50. The printed
   *      figure matches neither deposit nor their mean.
   *
   * `AllSeriesView` already knew the seed was unreliable and guarded only the
   * zero-matched case ("a never-billed series has no average, whatever its
   * stored seed says"). A figure whose whole subject is what these charges
   * actually averaged has to be measured from them.
   */
  test("postedAvgCents is measured from the linked rows, not from the detector's seed", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    bundle.db
      .update(recurringSeries)
      .set({ amountCentsAvg: -999_99 })
      .where(eq(recurringSeries.id, rent.id))
      .run();

    const listed = listSeries(bundle.db, TODAY).find((s) => s.id === rent.id)!;
    expect(listed.amountCentsAvg).toBe(-999_99); // the seed is still reported, unchanged
    expect(listed.postedAvgCents).not.toBe(-999_99);
    expect(listed.postedAvgCents).toBe(Math.round(-180_000));
  });

  test("a series with nothing linked has no posted average at all", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: null })
      .where(eq(transactions.recurringSeriesId, rent.id))
      .run();

    const listed = listSeries(bundle.db, TODAY).find((s) => s.id === rent.id)!;
    expect(listed.matchedCount).toBe(0);
    expect(listed.postedAvgCents).toBeNull();
  });

  test("a dismissed series keeps its stored date — rolling it would invent a charge", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    setSeriesStatus(bundle.db, rent.id, "dismissed");

    const listed = listSeries(bundle.db, "2027-08-08").find((s) => s.id === rent.id)!;
    expect(listed.nextExpectedOn).toBe("2026-07-01");
    expect(listed.storedNextExpectedOn).toBe("2026-07-01");
  });
});

describe("seriesHasLapsed", () => {
  const base = {
    cadence: "monthly" as const,
    userCadence: null,
    intervalDaysAvg: 30,
    nextExpectedOn: "2026-07-16",
    userNextExpectedOn: null,
    nextExpectedAmountCents: -499,
    userAmountCents: null,
  };

  test("a series that posted and then went quiet past its tolerance has lapsed", () => {
    // UBER *ONE: 446 days against a 49-day tolerance
    expect(seriesHasLapsed({ ...base, lastMatchedOn: "2025-05-25" }, "2026-08-14")).toBe(true);
  });

  test("a series still posting within tolerance has not", () => {
    expect(seriesHasLapsed({ ...base, lastMatchedOn: "2026-07-16" }, "2026-08-14")).toBe(false);
  });

  /**
   * The distinction from isSeriesActive, and the reason this predicate exists:
   * a commitment registered before its first charge has no postings at all.
   */
  test("a series that has NEVER posted has not lapsed — it has not started", () => {
    const commitment = { ...base, lastMatchedOn: null };
    expect(seriesHasLapsed(commitment, "2026-08-14")).toBe(false);
    // while isSeriesActive, correctly, calls the same row inactive
    expect(isSeriesActive({ ...commitment, status: "confirmed" as const }, "2026-08-14")).toBe(false);
  });

  /**
   * 🔴 THE regression this predicate shipped. `Flamingo South Beach (rent)` last
   * posted 2026-07-08 — 49 days against the old 48-day tolerance, ONE day over —
   * so the forecast dropped it and the runway card reported committed bills of
   * $782.41 a month against a real $3,068.11. The largest bill in the ledger
   * vanished for being a day late.
   *
   * Statements arrive monthly and land on their own dates, so `lastMatchedOn`
   * trails reality by up to a full cycle purely because the evidence is not
   * imported yet. A bill one cycle quiet is late, not cancelled.
   */
  test("a monthly bill one cycle quiet is late, not lapsed — statements arrive monthly", () => {
    // the rent's exact shape on 2026-08-26: 49 days quiet, ~1.6 cycles
    expect(seriesHasLapsed({ ...base, lastMatchedOn: "2026-07-08" }, "2026-08-26")).toBe(false);
    // and FPL's, which was one day behind it
    expect(seriesHasLapsed({ ...base, lastMatchedOn: "2026-07-10" }, "2026-08-26")).toBe(false);
  });

  test("a bill that has missed several cycles has genuinely stopped", () => {
    // DIRECT PAYMENT HOFFMAN: 230 days quiet, ~7.5 cycles — he moved
    expect(seriesHasLapsed({ ...base, lastMatchedOn: "2026-01-08" }, "2026-08-26")).toBe(true);
    // CHATGPT SUBSCRIPTION: 841 days, ~27.6 cycles
    expect(seriesHasLapsed({ ...base, lastMatchedOn: "2024-05-07" }, "2026-08-26")).toBe(true);
  });

  /**
   * ⛔ The two limits must stay apart. `isSeriesActive` answers "is there recent
   * evidence?" about the past, where 1.5 cycles is fair; `seriesHasLapsed`
   * answers "should I keep predicting this?", where being wrong deletes a real
   * bill from a budget. Collapsing them back to one number is what caused the
   * regression above, so the divergence is pinned rather than left implicit.
   */
  test("the forecast gate is looser than the active/inactive split, deliberately", () => {
    const oneCycleQuiet = { ...base, lastMatchedOn: "2026-07-08" };
    expect(isSeriesActive({ ...oneCycleQuiet, status: "confirmed" as const }, "2026-08-26")).toBe(false);
    expect(seriesHasLapsed(oneCycleQuiet, "2026-08-26")).toBe(false);
  });
});

describe("rollForwardNextExpected", () => {
  const eff = { cadence: "monthly" as const, intervalDaysAvg: 30, nextExpectedOn: "2026-07-16", nextExpectedAmountCents: -1549, anchorDay: null, userEndsOn: null };

  test("a future stored date is returned untouched", () => {
    expect(rollForwardNextExpected(eff, "2026-07-08")).toBe("2026-07-16");
  });

  test("today itself is not past — the date is due, not stale", () => {
    expect(rollForwardNextExpected(eff, "2026-07-16")).toBe("2026-07-16");
  });

  test("an overdue date steps by whole intervals to the first non-past occurrence", () => {
    // one calendar month lands exactly on today, which is due rather than past.
    // The 30-day walk overshot to 2026-09-14 and skipped the charge entirely.
    expect(rollForwardNextExpected(eff, "2026-08-16")).toBe("2026-08-16");
    // and a year and a bit behind still resolves in one hop, on the 16th
    expect(rollForwardNextExpected(eff, "2027-09-01")).toBe("2027-09-16");
  });

  test("a stale month-end anchor rolls to a real date, clamped when it must", () => {
    const eom = { ...eff, nextExpectedOn: "2026-01-31" };
    expect(rollForwardNextExpected(eom, "2026-02-15")).toBe("2026-02-28");
    // and the 31st survives the clamp — the next long month gets it back
    expect(rollForwardNextExpected(eom, "2026-03-01")).toBe("2026-03-31");
  });

  test("a monthly series outside the calendar band rolls forward in days", () => {
    const drifting = { ...eff, intervalDaysAvg: 53.25 };
    // 31 days stale, step 53 → one hop
    expect(rollForwardNextExpected(drifting, "2026-08-16")).toBe("2026-09-07");
  });

  test("no interval stats falls back to the cadence's nominal step", () => {
    // 15 days stale, weekly nominal 7 → 3 steps
    expect(rollForwardNextExpected({ ...eff, intervalDaysAvg: null, cadence: "weekly" }, "2026-07-31")).toBe("2026-08-06");
  });

  test("a series without a next-expected date stays null", () => {
    expect(rollForwardNextExpected({ ...eff, nextExpectedOn: null }, "2026-07-08")).toBeNull();
  });

  /*
   * 🔴 A COMMITMENT THAT IS OVER HAS NO NEXT DATE, and this function was the
   * one read path that did not know it.
   *
   * `projectOccurrences` clamps its walk at `userEndsOn` — "a 24-payment lease
   * is not monthly forever". This stepped from the anchor with no end test at
   * all, so /recurring's "Next" column published a date for a series whose own
   * occurrence list on the same page was empty.
   *
   * Measured on the real ledger, two series:
   *   Car insurance (ends 2027-01-11) at today = 2027-02-20 → "next 2027-03-11",
   *     zero occurrences in the following 400 days.
   *   Car lease (ends 2028-08-15) at today = 2028-10-01 → "next 2028-10-15",
   *     zero occurrences in the following 400 days.
   *
   * ⚠️ `subscriptions-card` already had the test, at the CALL SITE — the third
   * surface asking one question, and the only one answering it. Held there, two
   * places had to agree about a date; held here, none do.
   */
  describe("a commitment that has ended has no next date", () => {
    const ending = { ...eff, nextExpectedOn: "2026-07-16", userEndsOn: "2026-09-16" };

    test("the last occurrence is still the next one, on its own day", () => {
      expect(rollForwardNextExpected(ending, "2026-09-16")).toBe("2026-09-16");
      expect(rollForwardNextExpected(ending, "2026-09-01")).toBe("2026-09-16");
    });

    test("the day after the end there is nothing left", () => {
      expect(rollForwardNextExpected(ending, "2026-09-17")).toBeNull();
      expect(rollForwardNextExpected(ending, "2027-03-01")).toBeNull();
    });

    test("no end at all still rolls forever", () => {
      expect(rollForwardNextExpected({ ...eff, userEndsOn: null }, "2027-09-01")).toBe("2027-09-16");
      expect(rollForwardNextExpected(eff, "2027-09-01")).toBe("2027-09-16");
    });

    /**
     * ⭐ The agreement is the point: `projectOccurrences` and this function are
     * two ways to ask "when next?", so they are checked against each other
     * rather than against a hand-written date.
     */
    test("agrees with projectOccurrences, which owns the same rule", () => {
      const projectable = { ...ending, id: "s1", name: "Ending", kind: "bill" as const, nextExpectedAmountCents: -1549 };
      for (const today of ["2026-08-01", "2026-09-15", "2026-09-16", "2026-09-17", "2026-12-31"]) {
        const projected = projectOccurrences(projectable, today, "2099-12-31")[0]?.date ?? null;
        expect(rollForwardNextExpected(ending, today), `at ${today}`).toBe(projected);
      }
    });
  });
});
