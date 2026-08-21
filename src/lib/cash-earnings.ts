import type { Cadence } from "@/db/schema/recurring";
import { addDays, compareDates } from "./dates";
import { stepFrom, stepPlan, stepsToReach } from "./recurring-step";

/**
 * Earned versus banked, for pay that arrives as physical cash.
 *
 * The problem is not that the ledger cannot see cash income — measured on the
 * real database 2026-08-21, it sees it perfectly well whenever a deposit lands
 * and is tagged: June 2026 recorded $1,447.00 of `Income > Salary` from two ATM
 * cash deposits, both linked to the confirmed "Cash job (weekly pay)" series.
 * Every ATM deposit in the ledger is already classified, by hand, by the owner.
 *
 * The problem is TIMING. Cash is earned continuously and deposited in lumps, so
 * a monthly income figure is a record of when he walked to an ATM, not of what
 * he earned. The same ledger shows zero cash income after 2026-06-05 while a
 * hand-entered anchor put $5,000 of physical cash on `Cash on Hand` by
 * 2026-08-03 — money that was plainly earned and never banked.
 *
 * So this module computes three numbers and refuses to collapse them into one:
 * what a CONFIRMED schedule implies was earned, what actually reached a bank,
 * and the difference. It reports; it does not conclude.
 *
 * ⛔ What it must never be read as saying. A positive `unbankedCents` is NOT a
 * claim that the money exists somewhere. It is the arithmetic difference between
 * two known quantities, and it has at least three innocent explanations that
 * this module cannot distinguish between:
 *
 *   - the cash is held, undeposited (the `Cash on Hand` float);
 *   - the cash was spent directly, never touching a bank;
 *   - the series has quietly ended and the schedule is now fiction.
 *
 * `basis` exists so a caller cannot show the number without showing which of
 * those is in play, and `series-stale` exists to make the third one loud. This
 * is the same doctrine as `budgetVerdict`: the reading and the meaning of the
 * reading come out of one call, so they cannot drift apart.
 *
 * ⛔ It never writes, and it never back-fills. There is a standing instruction
 * not to reconstruct `Cash on Hand` history before 2026-08-03, and an estimate
 * that turned into rows would be exactly the fabricated-plug failure of pass 59.
 */

/**
 * Pay periods of silence before a confirmed series is called stale.
 *
 * Three, not one: he banks in lumps, so a single skipped week is his ordinary
 * rhythm and flagging it would cry wolf on the common case. Three consecutive
 * missed periods is the point at which "he hasn't been to an ATM" stops being
 * the most economical explanation.
 */
export const STALE_PERIODS = 3;

/**
 * A confirmed pay schedule. Structurally a subset of `recurring_series`,
 * restated here so `lib` keeps not importing from `services` — the idiom
 * `budget-verdict` and `section-notes` already follow.
 *
 * `startedOn` and `endedOn` bound the series' LIFE. They are what stops a May
 * window borrowing June's schedule, which matters on this ledger specifically:
 * Fordham's payroll ran to 2026-05-13 and the cash job began the following
 * month, so the two must not bleed into each other.
 */
export interface PaySeries {
  cadence: Cadence;
  /** measured average gap, or null to fall back to the cadence's nominal step */
  intervalDaysAvg: number | null;
  /** true day-of-month when the postings prove one; see `deriveAnchorDay` */
  anchorDay: number | null;
  /** what one pay period is worth, in cents; positive for income */
  amountCents: number;
  /** first day the schedule was in force — also the walk's anchor */
  startedOn: string;
  /** last day it was in force, or null while it is still running */
  endedOn: string | null;
}

export type CashEarningsBasis =
  /** nothing is confirmed, so nothing is implied — deposits still count */
  | "no-series"
  /** the schedule is confirmed and deposits are arriving against it */
  | "series-live"
  /** confirmed, but silent for `STALE_PERIODS` periods or more */
  | "series-stale";

export interface CashEarningsInput {
  series: PaySeries | null;
  /**
   * Deposits ATTRIBUTED to the series — on the real ledger, the rows carrying
   * `recurring_series_id`. Order does not matter. Passing every inbound row
   * instead would count his mother's cash as wages, which is precisely the
   * mistake the 2026-07-21 rows were rescued from.
   */
  banked: readonly { postedOn: string; amountCents: number }[];
  /** window, inclusive at both ends */
  from: string;
  to: string;
  /** the day the reading is taken; nothing after it is ever counted */
  today: string;
}

export interface CashEarnings {
  /** which of the three worlds the numbers below live in — always read it */
  basis: CashEarningsBasis;
  /** what the confirmed schedule implies was earned inside the window */
  impliedCents: number;
  /** what actually reached a bank inside the window */
  bankedCents: number;
  /**
   * `impliedCents − bankedCents`. Positive means earned-but-not-banked;
   * NEGATIVE means he banked more than the window earned, which happens
   * constantly because he deposits in lumps. Deliberately not clamped: flooring
   * it at zero would hide exactly the lump it is there to show.
   */
  unbankedCents: number;
  /** whole pay periods of the window that have actually elapsed */
  periodsCovered: number;
  /** most recent attributed deposit at or before `today`, or null */
  lastBankedOn: string | null;
  /** whole pay periods since `lastBankedOn`, or since the series started */
  periodsSinceBanked: number;
}

const EMPTY: CashEarnings = {
  basis: "no-series",
  impliedCents: 0,
  bankedCents: 0,
  unbankedCents: 0,
  periodsCovered: 0,
  lastBankedOn: null,
  periodsSinceBanked: 0,
};

/** The later of two dates. */
const laterOf = (a: string, b: string): string => (compareDates(a, b) >= 0 ? a : b);
/** The earlier of two dates. */
const earlierOf = (a: string, b: string): string => (compareDates(a, b) <= 0 ? a : b);

/**
 * How many of the series' own occurrences land in `[from, to]`.
 *
 * Every date decision here goes through `stepPlan`/`stepFrom`/`stepsToReach`
 * rather than being re-derived locally. That is pass 54's lesson stated as
 * code: two functions that must agree about a date must not both compute it.
 * The practical payoff is that a monthly cash arrangement steps by the calendar
 * and keeps its day-of-month, exactly as the recurring projection does.
 */
function occurrencesBetween(series: PaySeries, from: string, to: string): number {
  // Belt and braces, and named as such: the `Math.max(0, …)` below already
  // returns 0 for an inverted window, because `stepsToReach` is monotonic in its
  // boundary and so `first` can never come out below `last` when `from > to`.
  // This states the precondition at the boundary rather than leaving a caller
  // error to be absorbed silently three lines further down.
  if (compareDates(from, to) > 0) return 0;
  const plan = stepPlan(series.cadence, series.intervalDaysAvg, series.anchorDay);
  const first = stepsToReach(series.startedOn, plan, from);
  // `stepsToReach` lands on or AFTER `to`; when it overshoots, the last
  // occurrence inside the window is the step before it.
  const reach = stepsToReach(series.startedOn, plan, to);
  const last = compareDates(stepFrom(series.startedOn, plan, reach), to) <= 0 ? reach : reach - 1;
  return Math.max(0, last - first + 1);
}

export function cashEarnings({
  series,
  banked,
  from,
  to,
  today,
}: CashEarningsInput): CashEarnings {
  /*
   * Nothing after today is earned or banked yet, whatever the window says. This
   * is the same refusal the pace chart makes: a period still running has not
   * paid, and counting it would turn a schedule into a promise.
   */
  const end = earlierOf(to, today);

  const inWindow = banked.filter(
    (b) => compareDates(b.postedOn, from) >= 0 && compareDates(b.postedOn, end) <= 0,
  );
  const bankedCents = inWindow.reduce((sum, b) => sum + b.amountCents, 0);

  // `lastBankedOn` answers "when did pay last arrive", which is a question about
  // the series rather than about the window — a June window must still know
  // that nothing has landed since, so this looks at every attributed deposit up
  // to today, not only the ones inside `[from, to]`.
  const seen = banked.filter((b) => compareDates(b.postedOn, today) <= 0);
  const lastBankedOn = seen.reduce<string | null>(
    (latest, b) => (latest === null ? b.postedOn : laterOf(latest, b.postedOn)),
    null,
  );

  if (series === null) {
    return { ...EMPTY, bankedCents, lastBankedOn };
  }

  /*
   * There is deliberately NO `max(from, startedOn)` clamp here, and it is worth
   * saying why, because the obvious reading is that one is missing.
   *
   * `occurrencesBetween` anchors its walk on `startedOn`, and neither branch of
   * `stepsToReach` can return a negative step: the day branch returns 0 for a
   * boundary at or before the anchor, and the calendar branch is floored at 0
   * inside `calendarMonthsBetween`. So a window opening before the series began
   * already yields nothing, and a clamp would be a line that silently does
   * nothing — measured by mutation on 2026-08-21, removing it changed no test.
   *
   * ⚠️ That makes this module's correctness depend on a property of
   * `recurring-step`/`dates` rather than on a guard of its own. If
   * `calendarMonthsBetween` ever stops flooring at zero, a year-long window
   * would start counting paydays from before the job existed, and the clamp
   * comes back with a test that can finally fail without it.
   */
  const liveTo = series.endedOn === null ? end : earlierOf(end, series.endedOn);
  const periodsCovered = occurrencesBetween(series, from, liveTo);
  const impliedCents = periodsCovered * series.amountCents;

  /*
   * Silence is measured in pay periods, not days: "three missed paydays" is a
   * fact about the schedule, while "21 days" is a fact about the calendar and
   * says nothing about whether a payment was skipped. Counted from the last
   * deposit when there is one and from the series' start when there is not, so
   * a series that has never paid is stale rather than invisible.
   *
   * STRICTLY AFTER `silenceFrom`, via `addDays(…, 1)` — not the window from it
   * minus one. The two agree only when the deposit landed exactly on a payday,
   * and on the real ledger it did not: the last attributed deposit posted
   * 2026-06-05 while the schedule pays on Thursdays, so the walk already skips
   * to 06-11 and subtracting one then deletes a genuinely missed payday.
   * Measured 2026-08-21 — the honest answer is eleven, the subtraction said ten.
   */
  const silenceFrom = lastBankedOn ?? series.startedOn;
  const periodsSinceBanked = occurrencesBetween(series, addDays(silenceFrom, 1), today);

  return {
    basis: periodsSinceBanked >= STALE_PERIODS ? "series-stale" : "series-live",
    impliedCents,
    bankedCents,
    unbankedCents: impliedCents - bankedCents,
    periodsCovered,
    lastBankedOn,
    periodsSinceBanked,
  };
}
