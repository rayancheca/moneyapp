import type { Cadence } from "@/db/schema/recurring";
import {
  addCalendarMonths,
  addDays,
  calendarMonthsBetween,
  compareDates,
  diffDays,
  isMonthEnd,
  withDayOfMonth,
} from "./dates";

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

/**
 * The lowest day-of-month the calendar can ever clamp. February is the only
 * short month that matters and its shortest length is 28, so a series anchored
 * on the 28th or below lands on its own day in every month of every year — and
 * an `anchorDay` for it would be inert by construction.
 */
export const FIRST_CLAMPABLE_DAY = 29;

export interface StepPlan {
  /** occurrences land on the anchor's day-of-month, clamped into short months */
  readonly calendarMonths: boolean;
  /** the fixed day step, used only when `calendarMonths` is false */
  readonly stepDays: number;
  /**
   * The series' TRUE day-of-month, when it is known to differ from whatever day
   * the stored anchor happens to carry. Null means "inherit the anchor's day",
   * which is the behaviour every series had before this existed.
   *
   * A single integer expresses month-end too: 31 clamps to the 28th in February
   * and the 30th in April, which IS a last-day-of-month schedule. What a single
   * integer cannot do is be *inferred from one date* — see `deriveAnchorDay`.
   */
  readonly anchorDay: number | null;
}

/**
 * The day-of-month a series is really billed on, read from ALL of its postings.
 *
 * The problem this solves: `next_expected_on` is one ISO date, and a date that
 * has been clamped is indistinguishable from one that has not. A month-end bill
 * posts 2027-02-28, the walk re-anchors there, and every later month lands on
 * the 28th — three days early in every long month, forever. Re-deriving from the
 * newest posting alone cannot fix it, because the newest posting is exactly the
 * value that was clamped.
 *
 * ⚠️ Deliberately returns null unless the postings PROVE a day the calendar can
 * clamp. Two guards make it inert rather than clever:
 *
 *   - below day 29 nothing clamps, so there is nothing to record;
 *   - every posting must sit on the candidate day OR be its month's last day
 *     (i.e. be explainable as that same schedule, clamped).
 *
 * A series that merely wanders — Rocket Money posts across days 15..24 — fails
 * both and keeps the behaviour it has today. Guessing a modal day for those
 * would trade a rare 3-day error for a common one, which is the trap pass 51
 * flagged when it filed this.
 */
export function deriveAnchorDay(postedOns: readonly string[]): number | null {
  if (postedOns.length === 0) return null;
  const days = postedOns.map((d) => Number(d.slice(8, 10)));
  const candidate = Math.max(...days);
  if (candidate < FIRST_CLAMPABLE_DAY) return null;
  const explained = postedOns.every((d, i) => days[i] === candidate || isMonthEnd(d));
  return explained ? candidate : null;
}

/**
 * ⛔ Only `quarterly` and `annual` are deliberately left on day stepping among
 * the month-like cadences: zero live series carry either, their buckets are
 * wide (85–97 and 350–380 days), and a calendar model for them would be shipped
 * untested against real data.
 */
export function stepPlan(
  cadence: Cadence,
  intervalDaysAvg: number | null,
  anchorDay: number | null = null,
): StepPlan {
  const gap = intervalDaysAvg ?? CADENCE_NOMINAL_DAYS[cadence];
  const inBand = gap >= CALENDAR_MONTH_GAP_MIN && gap <= CALENDAR_MONTH_GAP_MAX;
  const calendarMonths = cadence === "monthly" && inBand;
  return {
    calendarMonths,
    // a zero or negative measured gap would never terminate a projection walk
    stepDays: Math.max(1, Math.round(gap)),
    // day stepping never reads it; carrying it there would be a value that
    // silently does nothing, which is worse than not having it
    anchorDay: calendarMonths ? anchorDay : null,
  };
}

/** The occurrence `steps` steps after `anchor`; step 0 is the anchor itself. */
export function stepFrom(anchor: string, plan: StepPlan, steps: number): string {
  if (!plan.calendarMonths) return addDays(anchor, steps * plan.stepDays);
  const hopped = addCalendarMonths(anchor, steps);
  return plan.anchorDay === null ? hopped : withDayOfMonth(hopped, plan.anchorDay);
}

/**
 * The smallest step count whose occurrence lands on or after `boundary` — 0 when
 * the anchor is already there. One hop, never a walk: a stale stored anchor can
 * be years behind today.
 *
 * The calendar branch counts whole months and then CHECKS the answer against
 * `stepFrom`, rather than re-deriving the date itself. With an `anchorDay` the
 * two can differ by a day in either direction — anchored 2027-02-28 with
 * anchorDay 31, the step-1 occurrence is the 31st of March, not the 28th — and a
 * `stepsToReach` that disagreed with `stepFrom` would step straight over a real
 * charge at a period boundary. Same function, one source of truth.
 */
export function stepsToReach(anchor: string, plan: StepPlan, boundary: string): number {
  if (!plan.calendarMonths) {
    const behindDays = diffDays(anchor, boundary);
    if (behindDays <= 0) return 0;
    return Math.ceil(behindDays / plan.stepDays);
  }
  const n = calendarMonthsBetween(anchor, boundary);
  // only the day WITHIN the target month is in question, so the true answer is
  // n or n+1 — never a walk
  return compareDates(stepFrom(anchor, plan, n), boundary) >= 0 ? n : n + 1;
}
