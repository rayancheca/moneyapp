import { describe, expect, test } from "vitest";
import {
  cashEarnings,
  STALE_PERIODS,
  type CashEarningsInput,
  type PaySeries,
} from "./cash-earnings";

const WEEKLY: PaySeries = {
  cadence: "weekly",
  intervalDaysAvg: 7,
  anchorDay: null,
  amountCents: 104_600,
  startedOn: "2026-06-04",
  endedOn: null,
};

const read = (over: Partial<CashEarningsInput> = {}) =>
  cashEarnings({
    series: WEEKLY,
    banked: [],
    from: "2026-06-01",
    to: "2026-06-30",
    today: "2026-06-30",
    ...over,
  });

describe("cashEarnings — the basis", () => {
  test("without a confirmed series it estimates nothing at all", () => {
    // The whole point of the module is that a cash job leaves no bank trail. If
    // nobody has confirmed the schedule, there is no evidence to reason from and
    // inventing a rate would be exactly the fabrication the ledger forbids.
    const r = read({ series: null });
    expect(r.basis).toBe("no-series");
    expect(r.impliedCents).toBe(0);
    expect(r.unbankedCents).toBe(0);
    expect(r.periodsCovered).toBe(0);
  });

  test("a series banking on schedule reads live", () => {
    const r = read({
      banked: [
        { postedOn: "2026-06-04", amountCents: 104_700 },
        { postedOn: "2026-06-11", amountCents: 104_600 },
        { postedOn: "2026-06-18", amountCents: 104_600 },
        { postedOn: "2026-06-25", amountCents: 104_600 },
      ],
    });
    expect(r.basis).toBe("series-live");
    expect(r.periodsSinceBanked).toBe(0);
  });

  test("a confirmed series with nothing banked for periods on end reads stale", () => {
    // The real ledger on 2026-08-21: the last cash-job deposit posted 2026-06-05
    // and the series has been confirmed-but-silent ever since. That is either
    // eleven weeks of undeposited pay or a job that ended, and the module must
    // not pick one — it reports the silence and names how long it has run.
    const r = read({
      banked: [{ postedOn: "2026-06-05", amountCents: 40_000 }],
      from: "2026-06-01",
      to: "2026-08-21",
      today: "2026-08-21",
    });
    expect(r.basis).toBe("series-stale");
    expect(r.periodsSinceBanked).toBeGreaterThanOrEqual(STALE_PERIODS);
  });

  test("staleness is counted in pay periods, never in days", () => {
    // "eleven weeks with no pay" is a fact about the schedule; "77 days" is a
    // fact about the calendar. Only the first tells you a payment was missed.
    const r = read({
      banked: [{ postedOn: "2026-06-04", amountCents: 104_600 }],
      to: "2026-06-25",
      today: "2026-06-25",
    });
    expect(r.periodsSinceBanked).toBe(3);
  });
});

describe("cashEarnings — what the schedule implies", () => {
  test("counts the series' own occurrences inside the window", () => {
    // June 2026 holds occurrences on the 4th, 11th, 18th and 25th.
    expect(read().periodsCovered).toBe(4);
    expect(read().impliedCents).toBe(4 * 104_600);
  });

  test("never counts a pay period that has not happened yet", () => {
    // Asked on the 12th, the window still runs to the 30th — but the 18th and
    // the 25th have not been earned. Claiming them would be the same defect the
    // pace chart avoids: money projected into a period still running.
    const r = read({ today: "2026-06-12" });
    expect(r.periodsCovered).toBe(2);
    expect(r.impliedCents).toBe(2 * 104_600);
  });

  test("implies nothing before the series started", () => {
    // Fordham's payroll ran until 2026-05-13 and the cash job began in June.
    // A May window must not borrow June's schedule.
    const r = read({ from: "2026-05-01", to: "2026-05-31", today: "2026-06-30" });
    expect(r.periodsCovered).toBe(0);
    expect(r.impliedCents).toBe(0);
  });

  test("implies nothing after the series ended", () => {
    const r = read({
      series: { ...WEEKLY, endedOn: "2026-06-11" },
      to: "2026-06-30",
      today: "2026-06-30",
    });
    // only the 4th and the 11th fall inside the series' life
    expect(r.periodsCovered).toBe(2);
  });

  test("clips both ends at once when the window straddles the whole life", () => {
    const r = read({
      series: { ...WEEKLY, startedOn: "2026-06-04", endedOn: "2026-06-18" },
      from: "2026-01-01",
      to: "2026-12-31",
      today: "2026-12-31",
    });
    expect(r.periodsCovered).toBe(3);
  });

  test("a MONTHLY series implies nothing in the months before it started", () => {
    // The weekly case above is not enough on its own: it exercises the day
    // branch of `stepsToReach`, and the calendar branch reaches the same answer
    // by a different route (`calendarMonthsBetween` floors at zero, so the walk
    // cannot step behind its anchor). Both routes are pinned here so a change to
    // either one has a test that sees it.
    const r = read({
      series: {
        cadence: "monthly",
        intervalDaysAvg: 30.4,
        anchorDay: null,
        amountCents: 400_000,
        startedOn: "2026-06-15",
        endedOn: null,
      },
      from: "2026-01-01",
      to: "2026-12-31",
      today: "2026-12-31",
    });
    // June through December, and not one month before
    expect(r.periodsCovered).toBe(7);
  });

  test("a window entirely outside the series life is zero, not negative", () => {
    const r = read({ from: "2026-01-01", to: "2026-01-31", today: "2026-06-30" });
    expect(r.periodsCovered).toBe(0);
    expect(r.impliedCents).toBe(0);
    expect(r.unbankedCents).toBe(0);
  });

  test("a monthly series steps by the calendar, not by 30 days", () => {
    // Reuses `stepPlan`, so a monthly cash arrangement lands on its day-of-month
    // rather than walking backwards through the year.
    const r = read({
      series: {
        cadence: "monthly",
        intervalDaysAvg: 30.4,
        anchorDay: null,
        amountCents: 400_000,
        startedOn: "2026-01-15",
        endedOn: null,
      },
      from: "2026-01-01",
      to: "2026-12-31",
      today: "2026-12-31",
    });
    expect(r.periodsCovered).toBe(12);
  });
});

describe("cashEarnings — banked, and the gap between", () => {
  test("banks only the deposits inside the window", () => {
    const r = read({
      banked: [
        { postedOn: "2026-05-28", amountCents: 50_000 },
        { postedOn: "2026-06-04", amountCents: 104_700 },
        { postedOn: "2026-07-02", amountCents: 90_000 },
      ],
    });
    expect(r.bankedCents).toBe(104_700);
  });

  test("the gap is what the schedule implies minus what actually landed", () => {
    const r = read({
      banked: [
        { postedOn: "2026-06-04", amountCents: 104_700 },
        { postedOn: "2026-06-05", amountCents: 40_000 },
      ],
    });
    // four occurrences implied, $1,447.00 banked
    expect(r.impliedCents).toBe(418_400);
    expect(r.bankedCents).toBe(144_700);
    expect(r.unbankedCents).toBe(273_700);
  });

  test("banking MORE than the schedule implies reports a negative gap, not a clamp", () => {
    // He deposits in lumps. A month that banks two months of pay is real, and
    // silently flooring it at zero would hide exactly that.
    const r = read({ banked: [{ postedOn: "2026-06-04", amountCents: 900_000 }] });
    expect(r.unbankedCents).toBe(418_400 - 900_000);
    expect(r.unbankedCents).toBeLessThan(0);
  });

  test("deposits are counted even when no schedule is confirmed", () => {
    // What landed in a bank is a fact; only the estimate depends on the series.
    const r = read({
      series: null,
      banked: [{ postedOn: "2026-06-04", amountCents: 104_700 }],
    });
    expect(r.basis).toBe("no-series");
    expect(r.bankedCents).toBe(104_700);
    expect(r.unbankedCents).toBe(0);
    expect(r.lastBankedOn).toBe("2026-06-04");
  });

  test("lastBankedOn ignores deposits dated after today", () => {
    // A future-dated row must not make a silent series look like it just paid.
    const r = read({
      banked: [
        { postedOn: "2026-06-04", amountCents: 104_600 },
        { postedOn: "2026-06-29", amountCents: 104_600 },
      ],
      today: "2026-06-12",
    });
    expect(r.lastBankedOn).toBe("2026-06-04");
  });

  test("with a series and no deposits at all, silence is counted from the start", () => {
    const r = read({ to: "2026-06-30", today: "2026-06-30" });
    expect(r.lastBankedOn).toBeNull();
    expect(r.periodsSinceBanked).toBe(3);
    expect(r.basis).toBe("series-stale");
  });

  test("silence is counted from the SERIES start, not from the window start", () => {
    // Caught by mutation. Asked about August alone, with a series that began in
    // June and has never once paid, counting silence from the window start says
    // "3 missed paydays" — a number about August. The truth is twelve, and the
    // difference is the whole reason the reading exists: the question is how
    // long this schedule has been silent, not how long this month has.
    const r = read({
      banked: [],
      from: "2026-08-01",
      to: "2026-08-31",
      today: "2026-08-31",
    });
    expect(r.lastBankedOn).toBeNull();
    expect(r.periodsSinceBanked).toBe(12);
    expect(r.basis).toBe("series-stale");
  });

  test("unordered deposits give the same answer as sorted ones", () => {
    const rows = [
      { postedOn: "2026-06-18", amountCents: 104_600 },
      { postedOn: "2026-06-04", amountCents: 104_700 },
      { postedOn: "2026-06-11", amountCents: 104_600 },
    ];
    const forward = read({ banked: rows });
    const backward = read({ banked: [...rows].reverse() });
    expect(backward).toEqual(forward);
  });
});

describe("cashEarnings — the invariant", () => {
  test("implied always equals banked plus the gap", () => {
    // The one arithmetic promise the caller may rely on. Stated as a test so a
    // future rounding change cannot quietly break the three-number story a
    // reader is being shown.
    for (const today of ["2026-06-04", "2026-06-12", "2026-06-30", "2026-08-21"]) {
      const r = read({
        to: "2026-08-31",
        today,
        banked: [
          { postedOn: "2026-06-04", amountCents: 104_700 },
          { postedOn: "2026-06-05", amountCents: 40_000 },
        ],
      });
      expect(r.impliedCents).toBe(r.bankedCents + r.unbankedCents);
    }
  });

  test("an inverted window is empty rather than negative", () => {
    const r = read({ from: "2026-06-30", to: "2026-06-01" });
    expect(r.periodsCovered).toBe(0);
    expect(r.bankedCents).toBe(0);
  });
});
