import type { Cadence } from "@/db/schema/recurring";
import {
  addCalendarMonths,
  addDays,
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
 * How many calendar months one step of a month-like cadence is, and the gap
 * band that cadence must measure inside before its dates are read as calendar
 * months at all. The bands are the same argument as the monthly one above,
 * scaled: wide enough to admit every real billing pattern, narrow enough that a
 * series billed some other way keeps day stepping.
 *
 * 🔴 `quarterly` and `annual` were deliberately EXCLUDED, on a premise that has
 * since been falsified by the ledger: "zero live series carry either". Four do
 * now — Chase Sapphire annual fee, Venture X annual fee, HBO Max and Parking —
 * and all four drift. Measured from their own stored anchors:
 *
 *   Chase Sapphire annual fee  2027-03-01 → 2028-02-29, 2029-02-28, 2030-02-28
 *   HBO Max                    2027-07-18 → 2028-07-17 … 2032-07-16
 *   Venture X annual fee       2027-01-16 → 2029-01-15 … 2032-01-15
 *   Parking (quarterly)        2026-10-20 → 2027-01-19, then 2027-10-19
 *
 * 365 days is not a year and 91 is not a quarter. The Chase fee is the one that
 * bites: it is anchored on the 1st, so a day of drift moves it into the
 * PREVIOUS month and $95.00 with it — Feb 2028's committed spend gains it and
 * March 2028's loses it, on a card the owner pages through month by month. Its
 * two real postings are 2025-03-02 and 2026-03-01, so March is where it belongs.
 */
export const CALENDAR_STEP_MONTHS: Partial<Record<Cadence, number>> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/** Inclusive average-gap band per calendar-stepped cadence. */
export const CALENDAR_GAP_BAND: Partial<Record<Cadence, readonly [number, number]>> = {
  monthly: [CALENDAR_MONTH_GAP_MIN, CALENDAR_MONTH_GAP_MAX],
  // a quarter is 90–92 days; the band admits a bill that wanders a few days
  quarterly: [85, 97],
  // a year is 365 or 366; the band admits an anniversary that slips a fortnight
  annual: [350, 380],
};

/** The calendar repeats its month lengths every four years, leap day included. */
const LEAP_CYCLE_MONTHS = 48;

/**
 * The shortest and longest ONE STEP of a cadence runs, in days. A day-shaped cadence steps its nominal days; a
 * calendar-stepped one (`CALENDAR_STEP_MONTHS`) steps calendar months, and those are no fixed count of days — a month
 * runs 28 to 31, a quarter 89 to 92, a year 365 or 366. Read off the calendar, from the 1st of every month of a leap
 * cycle, so no length here is typed. A four-weekly series is bucketed monthly and steps 28 days: inside the month.
 *
 * 🔴 `CADENCE_NOMINAL_DAYS` is one number per cadence, and 30 is not a month. /summary held a payroll's gaps to it
 * (2026-10-08), and a four-weekly payday banked a day late and then a day early — 26 days — was "deposited
 * irregularly", as was a payday on the 1st every February (Feb 2 to Feb 28).
 */
export function stepSpanDays(cadence: Cadence): readonly [number, number] {
  const stepMonths = CALENDAR_STEP_MONTHS[cadence];
  if (stepMonths === undefined) return [CADENCE_NOMINAL_DAYS[cadence], CADENCE_NOMINAL_DAYS[cadence]];
  const spans = Array.from({ length: LEAP_CYCLE_MONTHS }, (_, i) => {
    // any four years hold one February 29th; these hold 2024's
    const first = addCalendarMonths("2024-01-01", i);
    return diffDays(first, addCalendarMonths(first, stepMonths));
  });
  return [Math.min(...spans), Math.max(...spans)];
}

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
   * Calendar months per step: 1 monthly, 3 quarterly, 12 annual. Only read when
   * `calendarMonths` is true — a step of "one" is not the same thing as a step
   * of one MONTH once quarterly and annual are calendar-stepped too, and
   * leaving it implicit is how `stepFrom` and `stepsToReach` would come to
   * disagree about the size of a step.
   */
  readonly stepMonths: number;
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
 * ⛔ A cadence is calendar-stepped only when it has a `CALENDAR_STEP_MONTHS`
 * entry AND its measured gap sits inside that cadence's own band. Weekly,
 * biweekly and semimonthly stay on days because they genuinely are day-shaped;
 * a monthly series averaging 53 days is not being billed monthly whatever
 * bucket it fell into, and the band is what says so.
 */
export function stepPlan(
  cadence: Cadence,
  intervalDaysAvg: number | null,
  anchorDay: number | null = null,
): StepPlan {
  const gap = intervalDaysAvg ?? CADENCE_NOMINAL_DAYS[cadence];
  const stepMonths = CALENDAR_STEP_MONTHS[cadence];
  const band = CALENDAR_GAP_BAND[cadence];
  const calendarMonths =
    stepMonths !== undefined && band !== undefined && gap >= band[0] && gap <= band[1];
  return {
    calendarMonths,
    // a zero or negative measured gap would never terminate a projection walk
    stepDays: Math.max(1, Math.round(gap)),
    stepMonths: stepMonths ?? 1,
    // day stepping never reads it; carrying it there would be a value that
    // silently does nothing, which is worse than not having it
    anchorDay: calendarMonths ? anchorDay : null,
  };
}

/** The occurrence `steps` steps after `anchor`; step 0 is the anchor itself. */
export function stepFrom(anchor: string, plan: StepPlan, steps: number): string {
  if (!plan.calendarMonths) return addDays(anchor, steps * plan.stepDays);
  const hopped = addCalendarMonths(anchor, steps * plan.stepMonths);
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
  // ⛔ the floor stays: cash earnings walks from a series' first payday and relies on a boundary before it reaching
  // nothing (lib/cash-earnings, on the missing clamp). The walk BACK is `signedStepsToReach`'s, and only its.
  return Math.max(0, signedStepsToReach(anchor, plan, boundary));
}

/**
 * `stepsToReach` without its floor: the smallest step count whose occurrence lands on or after `boundary`, NEGATIVE
 * when the boundary lies before the anchor. One hop, never a walk, either way.
 *
 * ⚖️ ONE PAYDAY UNIVERSE (§6A 55, step B): a pay series' first payday is its anchor's rhythm walked BACK to its first
 * deposit (`firstPaydayOn`), and the projection opens there. 🔴 With only the floored count, every projection of his
 * pay began at detection's anchor, Jul 23, while Earned vs banked counted from his first deposit, Jun 4 — June's cash
 * week earned on one page and on no other.
 *
 * The calendar branch is `stepsToReach`'s argument unfloored: n = ⌈months ÷ step⌉ steps land in or after boundary's
 * month and n − 1 strictly before it, so the answer is n or n + 1, checked through `stepFrom`.
 */
export function signedStepsToReach(anchor: string, plan: StepPlan, boundary: string): number {
  // `+ 0`: Math.ceil(−0.4) is −0, and a step count of −0 is a value no caller should have to know about
  if (!plan.calendarMonths) return Math.ceil(diffDays(anchor, boundary) / plan.stepDays) + 0;
  const n = Math.ceil(signedCalendarMonths(anchor, boundary) / plan.stepMonths) + 0;
  return compareDates(stepFrom(anchor, plan, n), boundary) >= 0 ? n : n + 1;
}

/** Calendar months from `anchor`'s month to `boundary`'s — negative when the boundary's month is earlier. */
function signedCalendarMonths(anchor: string, boundary: string): number {
  const months = (day: string): number => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));
  return months(boundary) - months(anchor);
}

/**
 * The day of the month every step of a calendar walk from `anchor` lands on: the day its postings proved
 * (`plan.anchorDay`), else the anchor's own. Null for day stepping, which has none.
 *
 * ⛔ A walk that OPENS somewhere other than its anchor reads its day from here, not from the date it opened on. His
 * first payday is the anchor's rhythm walked back (`firstPaydayOn`), and a monthly anchor on the 30th walked back to
 * February opens on the 28th — a walk stepping from that date alone would land every later payday on the 28th.
 */
export function walkDayOfMonth(anchor: string, plan: StepPlan): number | null {
  return plan.calendarMonths ? (plan.anchorDay ?? Number(anchor.slice(8, 10))) : null;
}

/**
 * A tolerance as a whole number of days a sentence can print — the FLOOR.
 *
 * 🔴 Staleness is `days > toleranceDays`, compared unrounded, and a detected
 * interval is rarely whole (27.33, 12.5). Rounding the tolerance for display
 * could print "13 days, past the 13-day tolerance" at 12.5, and rounding the gap
 * could print "0 days past its own tolerance" for a series that had lapsed. A
 * whole day count above a tolerance is always above its floor, so every surface
 * that prints one reads it from here.
 */
export function wholeToleranceDays(toleranceDays: number): number {
  return Math.floor(toleranceDays);
}
