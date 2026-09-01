import { describe, expect, test } from "vitest";
import {
  CADENCE_NOMINAL_DAYS,
  CALENDAR_MONTH_GAP_MAX,
  CALENDAR_MONTH_GAP_MIN,
  deriveAnchorDay,
  FIRST_CLAMPABLE_DAY,
  stepFrom,
  stepPlan,
  stepsToReach,
} from "./recurring-step";
import { addDays } from "./dates";

describe("stepPlan", () => {
  test("a monthly series inside the band walks by calendar months", () => {
    // every live monthly series on the real ledger: 30.0 – 30.69
    for (const gap of [30, 30.5, 30.69, 29.5]) {
      expect(stepPlan("monthly", gap)).toMatchObject({ calendarMonths: true });
    }
  });

  test("the band is inclusive at both ends", () => {
    expect(stepPlan("monthly", CALENDAR_MONTH_GAP_MIN).calendarMonths).toBe(true);
    expect(stepPlan("monthly", CALENDAR_MONTH_GAP_MAX).calendarMonths).toBe(true);
  });

  test("a four-weekly series is BELOW the band and keeps day stepping", () => {
    // 28 days really does walk backwards through the month; fitCadence still
    // buckets it "monthly", which is why the low side has to be guarded too
    expect(stepPlan("monthly", 28)).toEqual({ calendarMonths: false, stepDays: 28, stepMonths: 1, anchorDay: null });
    // and a raw average that merely ROUNDS into the band is still outside it:
    // no calendar-monthly series can average under 29.5 days
    expect(stepPlan("monthly", 28.6).calendarMonths).toBe(false);
  });

  test("a long-gap series is ABOVE the band — where every dangerous row sits", () => {
    // Rocket Money Premium's stored 53.25, and the 33 that fitCadence admits
    expect(stepPlan("monthly", 53.25)).toEqual({ calendarMonths: false, stepDays: 53, stepMonths: 1, anchorDay: null });
    expect(stepPlan("monthly", 33).calendarMonths).toBe(false);
  });

  test("no other cadence is read as calendar months, whatever its gap", () => {
    for (const cadence of ["weekly", "biweekly", "semimonthly", "quarterly", "annual"] as const) {
      expect(stepPlan(cadence, 30).calendarMonths).toBe(false);
    }
  });

  test("a missing interval falls back to the cadence nominal", () => {
    // monthly's nominal 30 is inside the band — "monthly" with no measured gap
    // means a calendar month, which is what the word means
    expect(stepPlan("monthly", null)).toEqual({ calendarMonths: true, stepDays: 30, stepMonths: 1, anchorDay: null });
    expect(stepPlan("weekly", null)).toEqual({ calendarMonths: false, stepDays: 7, stepMonths: 1, anchorDay: null });
    expect(stepPlan("annual", null).stepDays).toBe(CADENCE_NOMINAL_DAYS.annual);
  });

  test("a non-positive measured gap floors at one day, never zero", () => {
    // a zero step would make a projection walk forever
    expect(stepPlan("weekly", 0).stepDays).toBe(1);
    expect(stepPlan("weekly", -4).stepDays).toBe(1);
  });
});

describe("deriveAnchorDay", () => {
  test("a month-end bill is read as the 31st, from postings that never all say 31", () => {
    // the whole point: not one of these dates is the 31st in February, and the
    // series has no other way to say "the last day"
    expect(deriveAnchorDay(["2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"])).toBe(31);
  });

  test("a February-only view of a month-end series still resolves", () => {
    expect(deriveAnchorDay(["2027-01-31", "2027-02-28"])).toBe(31);
  });

  test("a 30th bill is read as the 30th even though February clamped it", () => {
    // 2027-02-28 is that month's last day, so it is explained by the schedule
    expect(deriveAnchorDay(["2027-01-30", "2027-02-28", "2027-03-30"])).toBe(30);
  });

  test("a 29th bill survives a non-leap February", () => {
    expect(deriveAnchorDay(["2027-01-29", "2027-02-28", "2027-03-29"])).toBe(29);
  });

  /**
   * The guard that keeps this from making things worse. Rocket Money really
   * posts across days 15..24 on the live ledger; inventing a modal day for it
   * would move a projection that is currently correct within tolerance.
   */
  test("a wandering series gets no anchor at all", () => {
    expect(deriveAnchorDay(["2026-05-19", "2026-06-17", "2026-07-24", "2026-08-15"])).toBeNull();
  });

  test("a day the calendar can never clamp is left alone", () => {
    for (let day = 1; day < FIRST_CLAMPABLE_DAY; day++) {
      const d = String(day).padStart(2, "0");
      expect(deriveAnchorDay([`2027-01-${d}`, `2027-02-${d}`, `2027-03-${d}`])).toBeNull();
    }
  });

  test("one stray late posting does not invent a month-end schedule", () => {
    // 15, 15, 31 — the 31 is real but the others are neither 31 nor month-end
    expect(deriveAnchorDay(["2027-01-15", "2027-02-15", "2027-03-31"])).toBeNull();
  });

  test("no postings, no anchor", () => {
    expect(deriveAnchorDay([])).toBeNull();
  });

  test("a series seen only in 30-day months claims the 30th, not month-end", () => {
    // Apr/Jun/Sep are all last-day here, but reading 31 would be over-claiming:
    // nothing observed rules out a plain 30th bill
    expect(deriveAnchorDay(["2027-04-30", "2027-06-30", "2027-09-30"])).toBe(30);
  });
});

describe("stepFrom", () => {
  const calendar = stepPlan("monthly", 30);
  const days = stepPlan("weekly", 7);

  test("step 0 is the anchor itself under either model", () => {
    expect(stepFrom("2026-08-08", calendar, 0)).toBe("2026-08-08");
    expect(stepFrom("2026-08-08", days, 0)).toBe("2026-08-08");
  });

  test("the calendar model keeps the day-of-month", () => {
    expect(stepFrom("2026-09-11", calendar, 23)).toBe("2028-08-11");
  });

  test("the day model multiplies out the fixed step", () => {
    expect(stepFrom("2026-07-09", days, 3)).toBe("2026-07-30");
  });
});

describe("stepsToReach", () => {
  const calendar = stepPlan("monthly", 30);
  const days = stepPlan("weekly", 7);

  test("an anchor already on or after the boundary needs no steps", () => {
    expect(stepsToReach("2026-09-11", calendar, "2026-08-14")).toBe(0);
    expect(stepsToReach("2026-07-09", days, "2026-07-09")).toBe(0);
    expect(stepsToReach("2026-07-09", days, "2026-07-01")).toBe(0);
  });

  test("the day model rounds up to a whole number of steps", () => {
    expect(stepsToReach("2026-07-09", days, "2026-07-10")).toBe(1);
    expect(stepsToReach("2026-07-09", days, "2026-07-16")).toBe(1);
    expect(stepsToReach("2026-07-09", days, "2026-07-17")).toBe(2);
  });

  test("the calendar model counts months, not days", () => {
    // a 30-day walk from 2025-06-25 reaches 2026-08-02; thirteen calendar months
    // reach 2026-07-25 and fourteen reach 2026-08-25 — the charge is NOT due yet
    expect(stepsToReach("2025-06-25", calendar, "2026-08-14")).toBe(14);
    expect(stepFrom("2025-06-25", calendar, 14)).toBe("2026-08-25");
  });
});

describe("a month-end series, anchored on the clamp", () => {
  const monthEnd = stepPlan("monthly", 30, 31);
  const plain = stepPlan("monthly", 30);
  // what detection stores after a February charge — the value that used to
  // poison every month after it
  const anchor = "2027-02-28";

  test("the anchor day survives February instead of being inherited from it", () => {
    expect(stepFrom(anchor, monthEnd, 1)).toBe("2027-03-31");
    expect(stepFrom(anchor, monthEnd, 2)).toBe("2027-04-30");
    expect(stepFrom(anchor, monthEnd, 3)).toBe("2027-05-31");
    // the defect this replaces: without an anchor day it sits on the 28th forever
    expect(stepFrom(anchor, plain, 1)).toBe("2027-03-28");
    expect(stepFrom(anchor, plain, 3)).toBe("2027-05-28");
  });

  test("step 0 is still the anchor, clamped into its own short month", () => {
    expect(stepFrom(anchor, monthEnd, 0)).toBe("2027-02-28");
  });

  test("it re-clamps every February rather than drifting once and staying", () => {
    const feb = stepFrom("2027-01-31", monthEnd, 1);
    expect(feb).toBe("2027-02-28");
    // 2028 is a leap year, and the walk indexes off the anchor either way
    expect(stepFrom("2027-01-31", monthEnd, 13)).toBe("2028-02-29");
  });

  /**
   * The reason `stepsToReach` calls `stepFrom` instead of re-deriving the date.
   * The step-1 occurrence is 2027-03-31; a boundary of 2027-03-30 is BEFORE it,
   * so one step is enough. Month arithmetic that clamped to the 28th would
   * answer 2 and step straight over a real charge.
   */
  test("stepsToReach cannot disagree with stepFrom about a boundary", () => {
    expect(stepsToReach(anchor, monthEnd, "2027-03-30")).toBe(1);
    expect(stepFrom(anchor, monthEnd, 1)).toBe("2027-03-31");
    expect(stepsToReach(anchor, monthEnd, "2027-04-01")).toBe(2);
  });

  test("every step lands on or after the boundary it was asked for", () => {
    for (const boundary of ["2027-02-28", "2027-03-01", "2027-03-31", "2027-04-01", "2029-12-15"]) {
      const n = stepsToReach(anchor, monthEnd, boundary);
      expect(stepFrom(anchor, monthEnd, n) >= boundary).toBe(true);
      if (n > 0) expect(stepFrom(anchor, monthEnd, n - 1) < boundary).toBe(true);
    }
  });

  test("day stepping refuses to carry an anchor day it would silently ignore", () => {
    expect(stepPlan("monthly", 53.25, 31).anchorDay).toBeNull();
    expect(stepPlan("weekly", 7, 31).anchorDay).toBeNull();
  });
});

/*
 * 🔴 365 IS NOT A YEAR AND 91 IS NOT A QUARTER.
 *
 * `quarterly` and `annual` were deliberately left on day stepping, on a premise
 * the ledger has since falsified: "zero live series carry either". Four do —
 * and all four drift. Measured from their own stored anchors under the shipped
 * plan:
 *
 *   Chase Sapphire annual fee  2027-03-01 → 2028-02-29, 2029-02-28, 2030-02-28
 *   HBO Max                    2027-07-18 → 2028-07-17 … 2032-07-16
 *   Venture X annual fee       2027-01-16 → 2029-01-15 … 2032-01-15
 *   Parking (quarterly)        2026-10-20 → 2027-01-19, then 2027-10-19
 *
 * The Chase fee is the one that bites: anchored on the 1st, a single day of
 * drift moves it into the PREVIOUS month and $95.00 with it — Feb 2028's
 * committed spend gains it and March 2028's loses it. Its two real postings are
 * 2025-03-02 and 2026-03-01.
 */
describe("quarterly and annual step by the calendar too", () => {
  test("an annual series lands on its own day every year, leap years included", () => {
    const plan = stepPlan("annual", 365, 1);
    expect(plan.calendarMonths).toBe(true);
    expect(plan.stepMonths).toBe(12);
    // 2028 is a leap year: 365 days from 2027-03-01 is 2028-02-29, a month early
    expect(stepFrom("2027-03-01", plan, 1)).toBe("2028-03-01");
    expect(stepFrom("2027-03-01", plan, 5)).toBe("2032-03-01");
  });

  test("a quarterly series lands on its own day every quarter", () => {
    const plan = stepPlan("quarterly", 91, 20);
    expect(plan.stepMonths).toBe(3);
    expect(stepFrom("2026-10-20", plan, 1)).toBe("2027-01-20");
    expect(stepFrom("2026-10-20", plan, 4)).toBe("2027-10-20");
  });

  test("a gap outside the cadence's own band keeps day stepping", () => {
    // an "annual" series billed every 200 days is not being billed annually
    expect(stepPlan("annual", 200).calendarMonths).toBe(false);
    // …nor is a "quarterly" one billed every 30
    expect(stepPlan("quarterly", 30).calendarMonths).toBe(false);
    // the edges of each band, both sides
    expect(stepPlan("annual", 350).calendarMonths).toBe(true);
    expect(stepPlan("annual", 349).calendarMonths).toBe(false);
    expect(stepPlan("annual", 380).calendarMonths).toBe(true);
    expect(stepPlan("annual", 381).calendarMonths).toBe(false);
    expect(stepPlan("quarterly", 85).calendarMonths).toBe(true);
    expect(stepPlan("quarterly", 84).calendarMonths).toBe(false);
    expect(stepPlan("quarterly", 97).calendarMonths).toBe(true);
    expect(stepPlan("quarterly", 98).calendarMonths).toBe(false);
  });

  test("weekly, biweekly and semimonthly are still day-shaped", () => {
    for (const c of ["weekly", "biweekly", "semimonthly"] as const) {
      expect(stepPlan(c, null).calendarMonths, c).toBe(false);
    }
  });

  /**
   * ⭐ `stepsToReach` counts whole STEPS, not whole months, and it is checked
   * against `stepFrom` rather than against a hand-written date — the two must
   * agree about the size of a step or a projection walks over a real charge.
   */
  test("stepsToReach counts steps, and agrees with stepFrom about every one", () => {
    for (const [cadence, gap, anchor] of [["annual", 365, "2027-03-01"], ["quarterly", 91, "2026-10-20"]] as const) {
      const plan = stepPlan(cadence, gap, Number(anchor.slice(8, 10)));
      for (let k = 0; k <= 8; k++) {
        const at = stepFrom(anchor, plan, k);
        expect(stepsToReach(anchor, plan, at), `${cadence} step ${k} lands on itself`).toBe(k);
        expect(stepsToReach(anchor, plan, addDays(at, -1)), `${cadence} the day before step ${k}`).toBe(k);
        if (k > 0) {
          expect(stepsToReach(anchor, plan, addDays(stepFrom(anchor, plan, k - 1), 1)), `${cadence} just after step ${k - 1}`).toBe(k);
        }
      }
    }
  });
});
