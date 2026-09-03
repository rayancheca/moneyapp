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

/*
 * 🔴 The card printed "13 paydays in this window" directly under "Measured from
 * Mar 2026 to today" — and thirteen WEEKLY paydays cannot span twenty-six
 * weeks. Both halves were true: `occurrencesBetween` anchors its walk on the
 * series' own `startedOn`, so the count is bounded by the job's life rather
 * than by the window's. The window was named, the count's own span was not.
 *
 * So the line has to be able to say where its paydays actually run.
 */
describe("cashEarnings — the span the count covers", () => {
  test("a window that opens before the job began reports the JOB's span", () => {
    const r = read({ from: "2026-03-01", to: "2026-08-31", today: "2026-08-31" });
    // weekly from 2026-06-04: Jun 4 … Aug 27 is 13 Thursdays
    expect(r.periodsCovered).toBe(13);
    expect(r.firstPeriodOn).toBe("2026-06-04");
    expect(r.lastPeriodOn).toBe("2026-08-27");
  });

  test("a window that opens after the job began reports the WINDOW's span", () => {
    const r = read({ from: "2026-06-15", to: "2026-06-30", today: "2026-06-30" });
    expect(r.periodsCovered).toBe(2);
    expect(r.firstPeriodOn).toBe("2026-06-18");
    expect(r.lastPeriodOn).toBe("2026-06-25");
  });

  test("no covered payday means no span to name", () => {
    const r = read({ from: "2026-05-01", to: "2026-05-31", today: "2026-05-31" });
    expect(r.periodsCovered).toBe(0);
    expect(r.firstPeriodOn).toBeNull();
    expect(r.lastPeriodOn).toBeNull();
  });

  test("a single covered payday opens and closes the span on one day", () => {
    const r = read({ from: "2026-06-01", to: "2026-06-08", today: "2026-06-08" });
    expect(r.periodsCovered).toBe(1);
    expect(r.firstPeriodOn).toBe("2026-06-04");
    expect(r.lastPeriodOn).toBe("2026-06-04");
  });

  test("a series that ENDED closes its span on its own last payday, not the window's", () => {
    const r = read({
      series: { ...WEEKLY, endedOn: "2026-06-20" },
      from: "2026-06-01",
      to: "2026-06-30",
      today: "2026-06-30",
    });
    expect(r.periodsCovered).toBe(3);
    expect(r.lastPeriodOn).toBe("2026-06-18");
  });

  test("without a series there is no span", () => {
    const r = read({ series: null });
    expect(r.firstPeriodOn).toBeNull();
    expect(r.lastPeriodOn).toBeNull();
  });
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
    // Asked the day after the 25th's payday: a payday dated today has not
    // been missed yet (pinned below), and this test is about the unit.
    const r = read({
      banked: [{ postedOn: "2026-06-04", amountCents: 104_600 }],
      to: "2026-06-26",
      today: "2026-06-26",
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

  test("a deposit landing OFF the payday still counts every missed payday after it", () => {
    // The real ledger's own shape, and an off-by-one the whole suite missed
    // until the service was run against it. The schedule pays on Thursdays from
    // 2026-06-04; the last attributed deposit posted FRIDAY 2026-06-05. Every
    // Thursday from 06-11 to 08-20 was then missed — eleven of them. Counting
    // the window from 06-05 and subtracting one says ten, because the walk had
    // already skipped past 06-05 on its own and there was nothing to subtract.
    const r = read({
      banked: [{ postedOn: "2026-06-05", amountCents: 40_000 }],
      from: "2026-06-01",
      to: "2026-08-31",
      today: "2026-08-21",
    });
    expect(r.lastBankedOn).toBe("2026-06-05");
    expect(r.periodsSinceBanked).toBe(11);
  });

  test("a deposit landing ON the payday does not count itself as missed", () => {
    // The other half of the same rule: 2026-06-04 IS an occurrence, so silence
    // starts at the NEXT one. Both cases have to be pinned or the fix is a
    // coin-flip between two formulas that agree on exactly one of them.
    // Asked the day AFTER the 25th's payday: a payday dated today is not yet
    // passed (see the two tests below), and this test is about the 4th.
    const r = read({
      banked: [{ postedOn: "2026-06-04", amountCents: 104_600 }],
      to: "2026-06-26",
      today: "2026-06-26",
    });
    expect(r.periodsSinceBanked).toBe(3);
  });

  /*
   * ⛔ A PAYDAY DATED TODAY HAS NOT HAPPENED. Measured on the owner's card on
   * 2026-09-03, a Thursday: "14 paydays, Jun 4 – Sep 3 … 13 paydays have passed
   * since Jun 5 with no deposit", beside an upcoming strip listing that day's
   * pay as still to come. Today's occurrence is neither earned nor passed until
   * its money lands. Killed by mutation: counting the schedule through today
   * unconditionally fails the first; ignoring the deposit fails the second.
   */
  test("a payday dated today is neither earned nor passed while nothing has landed", () => {
    // 2026-06-25 is a Thursday — the 4th occurrence — and nothing has posted
    const r = read({ to: "2026-06-30", today: "2026-06-25" });
    expect(r.periodsCovered).toBe(3);
    expect(r.lastPeriodOn).toBe("2026-06-18");
    expect(r.impliedCents).toBe(3 * 104_600);
    // silence runs from the start: the 11th and the 18th have passed, the 25th has not
    expect(r.periodsSinceBanked).toBe(2);
  });

  test("a deposit dated today makes today's payday earned, banked and not silent", () => {
    const r = read({
      banked: [{ postedOn: "2026-06-25", amountCents: 104_600 }],
      to: "2026-06-30",
      today: "2026-06-25",
    });
    expect(r.periodsCovered).toBe(4);
    expect(r.lastPeriodOn).toBe("2026-06-25");
    expect(r.bankedCents).toBe(104_600);
    expect(r.unbankedCents).toBe(3 * 104_600);
    expect(r.periodsSinceBanked).toBe(0);
    expect(r.basis).toBe("series-live");
  });

  test("a day the records have been read THROUGH counts its own payday as passed", () => {
    // the income card's as-of reading: the ledger is verified through the 25th,
    // so a Thursday payday on the 25th with nothing banked was checked and missed
    const r = read({ to: "2026-06-30", today: "2026-06-25", todayIsComplete: true });
    expect(r.periodsCovered).toBe(4);
    expect(r.lastPeriodOn).toBe("2026-06-25");
    expect(r.periodsSinceBanked).toBe(3);
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
