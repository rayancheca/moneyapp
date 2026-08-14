import type { Cadence } from "@/db/schema/recurring";
import { addCalendarMonths, addDays, calendarMonthsToReach, diffDays } from "./dates";

/**
 * How a recurring series walks forward in time — the ONE place that decision is
 * made, so a schedule's anchor, its projected occurrences and its rolled-forward
 * "next" can never disagree about where the charge lands.
 *
 * Most bills are billed by the CALENDAR: rent on the 8th, a lease on the 11th.
 * Stepping such a series by its measured average gap in days walks it backwards
 * through the month — the car lease's 24 payments land on 2028-08-01 instead of
 * 2028-08-11, and a December with 31 days eventually holds two rent charges
 * (measured: Housing projects $4,571.40 against a $2,109 budget on 2027-12-05).
 * So a monthly series steps by a calendar month and keeps its day-of-month.
 */

/** Nominal step when a series predates interval stats (should not happen). */
export const CADENCE_NOMINAL_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  semimonthly: 15,
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

/**
 * The average-gap band a series must sit in before its dates are read as
 * calendar months.
 *
 * TWO-SIDED on purpose. The obvious `>= 29` guard is one-sided and every
 * dangerous row in the real ledger is on the HIGH side: live monthly series
 * average 30.0–30.69 days, while non-live ones run to 53.25. A 28-day series is
 * four-weekly — it genuinely drifts through the month and must keep day
 * stepping — and nothing that averages 33+ days is being billed monthly at all,
 * whatever bucket its median fell into.
 *
 * The band is the raw average, not a rounded one: a true calendar-monthly
 * series cannot average less than 29.5 days (two consecutive 28-day gaps would
 * need February twice), so 28.6 is measurably not one even though it rounds
 * to 29.
 */
export const CALENDAR_MONTH_GAP_MIN = 29;
export const CALENDAR_MONTH_GAP_MAX = 32;

export interface StepPlan {
  /** occurrences land on the anchor's day-of-month, clamped into short months */
  readonly calendarMonths: boolean;
  /** the fixed day step, used only when `calendarMonths` is false */
  readonly stepDays: number;
}

/**
 * ⛔ Only `quarterly` and `annual` are deliberately left on day stepping among
 * the month-like cadences: zero live series carry either, their buckets are
 * wide (85–97 and 350–380 days), and a calendar model for them would be shipped
 * untested against real data.
 */
export function stepPlan(cadence: Cadence, intervalDaysAvg: number | null): StepPlan {
  const gap = intervalDaysAvg ?? CADENCE_NOMINAL_DAYS[cadence];
  const inBand = gap >= CALENDAR_MONTH_GAP_MIN && gap <= CALENDAR_MONTH_GAP_MAX;
  return {
    calendarMonths: cadence === "monthly" && inBand,
    // a zero or negative measured gap would never terminate a projection walk
    stepDays: Math.max(1, Math.round(gap)),
  };
}

/** The occurrence `steps` steps after `anchor`; step 0 is the anchor itself. */
export function stepFrom(anchor: string, plan: StepPlan, steps: number): string {
  return plan.calendarMonths
    ? addCalendarMonths(anchor, steps)
    : addDays(anchor, steps * plan.stepDays);
}

/**
 * The smallest step count whose occurrence lands on or after `boundary` — 0 when
 * the anchor is already there. One hop, never a walk: a stale stored anchor can
 * be years behind today.
 */
export function stepsToReach(anchor: string, plan: StepPlan, boundary: string): number {
  if (plan.calendarMonths) return calendarMonthsToReach(anchor, boundary);
  const behindDays = diffDays(anchor, boundary);
  if (behindDays <= 0) return 0;
  return Math.ceil(behindDays / plan.stepDays);
}
