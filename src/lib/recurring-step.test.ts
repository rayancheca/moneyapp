import { describe, expect, test } from "vitest";
import {
  CADENCE_NOMINAL_DAYS,
  CALENDAR_MONTH_GAP_MAX,
  CALENDAR_MONTH_GAP_MIN,
  stepFrom,
  stepPlan,
  stepsToReach,
} from "./recurring-step";

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
    expect(stepPlan("monthly", 28)).toEqual({ calendarMonths: false, stepDays: 28 });
    // and a raw average that merely ROUNDS into the band is still outside it:
    // no calendar-monthly series can average under 29.5 days
    expect(stepPlan("monthly", 28.6).calendarMonths).toBe(false);
  });

  test("a long-gap series is ABOVE the band — where every dangerous row sits", () => {
    // Rocket Money Premium's stored 53.25, and the 33 that fitCadence admits
    expect(stepPlan("monthly", 53.25)).toEqual({ calendarMonths: false, stepDays: 53 });
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
    expect(stepPlan("monthly", null)).toEqual({ calendarMonths: true, stepDays: 30 });
    expect(stepPlan("weekly", null)).toEqual({ calendarMonths: false, stepDays: 7 });
    expect(stepPlan("annual", null).stepDays).toBe(CADENCE_NOMINAL_DAYS.annual);
  });

  test("a non-positive measured gap floors at one day, never zero", () => {
    // a zero step would make a projection walk forever
    expect(stepPlan("weekly", 0).stepDays).toBe(1);
    expect(stepPlan("weekly", -4).stepDays).toBe(1);
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
