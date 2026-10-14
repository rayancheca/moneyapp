import type { Cadence } from "@/db/schema/recurring";
import { monthKey } from "./dates";
import { BUDGET_JARGON } from "./jargon";
import { formatCents } from "./money";
import { resolvePeriod, withPeriod, type ResolvedPeriod } from "./period";
import { seriesListHref } from "./recurring-list";

/**
 * Which income figure a monthly budget should be graded against.
 *
 * The problem, measured on the real ledger 2026-08-21: the owner is paid
 * $1,047.00 a week and his budgets were sized from that at $1,047.00 × 52 ÷ 12
 * = $4,537.00 a month. `/budgets` graded them against the paydays that fall in
 * the CALENDAR month instead — four of them in eight months a year and five in
 * the other four — so the same unchanged plan read "over-allocated by $318.29"
 * for eight months and "$728.71 left to allocate" for four, and balanced only
 * across the year ($54,444.00 of income against $54,075.48 of budgets).
 *
 * Both numbers were right. Grading an annualised plan against a calendar month
 * is what was wrong: it compares a rate to a count. So the header grades against
 * the same annualised rate the budgets were built from, and the calendar month
 * is stated underneath rather than deleted — the month a budget is actually
 * lived in still matters, it is just not the yardstick.
 *
 * Owner's decision, 2026-08-21, with all three columns in front of him:
 * *"Annualise, name the month underneath."*
 *
 * ⛔ Deliberately NOT measured from the projection walk. Counting a weekly
 * series' occurrences across a rolling year yields 52 or 53 depending on which
 * weekday the year starts on, which would move the basis by roughly $87 from one
 * month to the next — a smaller version of exactly the swing this removes. The
 * counts below are the calendar convention payroll uses, they are the basis the
 * owner approved, and they are the basis `income-budget.ts` sized the budgets
 * from. One source, so the header and the budgets on it cannot disagree.
 */

/** How many times a cadence pays in a year, by the convention payroll uses. */
export const OCCURRENCES_PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

const MONTHS_PER_YEAR = 12;

/**
 * One month of a recurring amount, annualised.
 *
 * ⚠️ Not "how much of this lands in a month" — `weekly × 4` is four paydays a
 * month, which is eleven months of pay a year and quietly loses $4,188.00 at
 * this wage. Likewise `biweekly × 2` loses two whole paycheques.
 */
export function levelledMonthlyCents(amountCents: number, cadence: Cadence): number {
  return Math.round((amountCents * OCCURRENCES_PER_YEAR[cadence]) / MONTHS_PER_YEAR);
}

/**
 * Which rule produced the published figure.
 *
 * - `levelled`  the annualised rate — the ordinary case, and the one that holds
 *               still from month to month.
 * - `banked`    income already measured in this window came to MORE than the
 *               rate, so the measurement is published instead. The rate is a
 *               floor-not-a-ceiling on purpose: see `incomeBasis`.
 * - `calendar`  nothing could be levelled at all, so the reading the page had
 *               before any of this existed is published unchanged.
 */
export type IncomeBasisKind = "levelled" | "banked" | "calendar";

export interface IncomeBasisInput {
  /**
   * Every live income series' annualised monthly rate, summed. Zero or less
   * means there was nothing to level — the only thing that selects `calendar`.
   */
  levelledCents: number;
  /**
   * Income this window has ALREADY MEASURED. The floor under the rate, and
   * deliberately the posted figure rather than the projected one — see below.
   */
  postedCents: number;
  /** what the schedule says THIS calendar month pays */
  scheduledCents: number;
  /** the occurrences behind `scheduledCents`, from the same walk */
  scheduledOccurrences: number;
  /** the fallback figure when nothing can be levelled: posted plus still-due */
  measuredCents: number;
}

export interface IncomeBasis {
  kind: IncomeBasisKind;
  /** the figure budgets are graded against */
  cents: number;
  /**
   * What `cents` means, from `BUDGET_JARGON` — chosen by the SAME branch that
   * chose the figure. The three arithmetics have nothing in common, and a single
   * tooltip covering them could only manage it by being vague about whichever
   * one is actually on screen (`budgetVerdict`'s rule, for the same reason).
   */
  explanation: string;
  /**
   * What an over-allocated plan outran, as a clause following "Over-allocated
   * by $X —". Chosen here rather than written into the page for the reason
   * above: the page hard-coded "more than this month is expected to bring in"
   * while grading against a RATE, and in the four five-payday months a year the
   * month brought in more than the budgets, so the clause stated the reverse of
   * the note printed two lines beneath it.
   */
  overAllocatedClause: string;
  /**
   * `cents − scheduledCents` under `levelled`, and zero under every other kind,
   * where the published figure is not a rate for the month to differ from.
   * POSITIVE when this month pays less than the annualised rate, the common case.
   */
  monthDeltaCents: number;
  /**
   * How this calendar month sits, already formatted — the `SectionNote.body`
   * convention. Null under `calendar`: with nothing levelled there is no plan
   * for the month to be measured against, and a note would be describing
   * something the page is not doing.
   */
  monthNote: string | null;
}

/**
 * The month sentence.
 *
 * Every branch renders on the real ledger within one year — four-payday months
 * eight times, five-payday months four times — and the no-payday branch is what
 * a quarterly or annual income series reads in the months it does not pay.
 *
 * `compare` is false in the `banked` state, where the figure above is a
 * measurement: a sentence ending "under the annualised figure above" would be
 * describing something that is not there.
 *
 * ⛔ May not contain "expected income", "left to allocate" or "Over-allocated
 * by": all three are matched by exact-count locators on this same page, and a
 * tooltip or a note repeating one turns an unrelated assertion red. See
 * `RESERVED_JARGON_PHRASES`.
 */
function monthNoteOf(
  scheduledCents: number,
  occurrences: number,
  deltaCents: number,
  compare: boolean,
): string {
  if (occurrences === 0) {
    // "0 paydays fall in this month, scheduled at $0.00" reads as a broken
    // schedule. It is not — an annual series pays in one month of twelve.
    return "No payday falls in this month; the figure above spreads a year of pay evenly across twelve.";
  }
  const lead = `${occurrences} ${occurrences === 1 ? "payday falls" : "paydays fall"} in this month, scheduled at ${formatCents(scheduledCents)}`;
  if (!compare) return `${lead}.`;
  if (deltaCents === 0) return `${lead} — exactly the annualised figure above.`;
  const direction = deltaCents > 0 ? "under" : "over";
  return `${lead} — ${formatCents(Math.abs(deltaCents))} ${direction} the annualised figure above.`;
}

const OUTRAN_LEVELLED =
  "these budgets total more than a year of your pay comes to, spread evenly across twelve months";
const OUTRAN_BANKED = "these budgets total more than has come in over this window";
const OUTRAN_CALENDAR = "these budgets total more than this month is expected to bring in";

export function incomeBasis({
  levelledCents,
  postedCents,
  scheduledCents,
  scheduledOccurrences,
  measuredCents,
}: IncomeBasisInput): IncomeBasis {
  /*
   * Nothing to level: no live income series carries a positive amount. The page
   * keeps the reading it has always had — posted plus still-due, floored at what
   * the schedule says the whole window brings — because that is a measurement
   * and this module has no rate to replace it with.
   */
  if (levelledCents <= 0) {
    return {
      kind: "calendar",
      cents: measuredCents,
      explanation: BUDGET_JARGON.expectedIncomeCalendar,
      overAllocatedClause: OUTRAN_CALENDAR,
      monthDeltaCents: 0,
      monthNote: null,
    };
  }

  /*
   * ⛔ A RATE IS A FLOOR, NOT A CEILING — and this guard is the whole reason
   * that sentence is here.
   *
   * Reproduced against a seeded ledger while reviewing the change that
   * introduced the levelling: $5,000.00 of salary posts, the detector picks up
   * an INTEREST PAYMENT series worth fourteen cents a month, and the header
   * publishes **$0.14** of expected income over it — a measured near-zero
   * asserted on top of real, banked, reconciled money, with every budget on the
   * page reading over-allocated behind it. `max(posted + still-due, whole-period
   * forecast)` had been the guard against precisely that, and the levelled
   * branch dropped it.
   *
   * The floor is the POSTED figure and nothing else. Flooring on the schedule
   * (or on posted-plus-still-due, which contains it) would hand back the very
   * swing the levelling removes: a five-payday month schedules $5,235.00 against
   * a $4,537.00 rate and would raise the header four months a year for no reason
   * beyond where the weekdays fell. Posted money is a MEASUREMENT — it moves
   * when income really arrives, which is information rather than an artefact of
   * the calendar.
   */
  if (postedCents > levelledCents) {
    return {
      kind: "banked",
      cents: postedCents,
      explanation: BUDGET_JARGON.expectedIncomeBanked,
      overAllocatedClause: OUTRAN_BANKED,
      monthDeltaCents: 0,
      monthNote: monthNoteOf(scheduledCents, scheduledOccurrences, 0, false),
    };
  }

  const monthDeltaCents = levelledCents - scheduledCents;
  return {
    kind: "levelled",
    cents: levelledCents,
    explanation: BUDGET_JARGON.expectedIncomeLevelled,
    overAllocatedClause: OUTRAN_LEVELLED,
    monthDeltaCents,
    monthNote: monthNoteOf(scheduledCents, scheduledOccurrences, monthDeltaCents, true),
  };
}

export interface IncomeBasisHrefInput {
  kind: IncomeBasisKind;
  /** the series whose annualised rates `levelled` sums — `IncomeExpectation.levelledSeriesIds` */
  levelledSeriesIds: readonly string[];
  /** the window `banked` and `calendar` measured */
  window: ResolvedPeriod;
}

/**
 * Where the reader checks the income figure — chosen by the basis, because each one has a different thing behind it.
 *
 * - `levelled`  a RATE from the pay schedule(s): one schedule opens its own page, more than one the All tab narrowed
 *               to exactly them (`seriesListHref`), where each prints its cadence and amount beside the others.
 * - `banked`    money that landed in the window, and `calendar` that money plus the pay still due in it: both are
 *               the window's, so `/spending` for exactly that window — named, never a bare `/spending` leaning on
 *               the page's default, the shape `spendingHref` was built to retire.
 *
 * 🔴 Measured on his ledger copy 2026-10-12: "What you earn a month $4,948.32", levelled from the confirmed It America
 * LLC weekly pay, linked to a bare `/spending` — October, which reads "not imported yet": a month of deposits for a
 * figure that is no month's deposits at all. 🔴 …and more than one schedule opened a bare `/recurring?tab=all`:
 * every series the ledger lists — bills, and schedules that stopped paying — beside the ones summed (review,
 * 2026-10-12).
 */
export function incomeBasisHref({ kind, levelledSeriesIds, window }: IncomeBasisHrefInput): string {
  if (kind !== "levelled") return withPeriod("/spending", window);
  // a levelled figure has at least one series behind it (`levelledCents > 0`); naming none is the whole tab
  return levelledSeriesIds.length === 1 ? `/recurring/${levelledSeriesIds[0]}` : seriesListHref(levelledSeriesIds);
}

/** Where a surface's monthly income figure is checked, and the page it opens in a word. */
export interface IncomeLink {
  href: string;
  /** "Schedule" for a pay schedule's page or the list of them, "Spending" for the month on /spending */
  label: "Schedule" | "Spending";
}

/**
 * The link for the month's income figure — `incomeBasisHref` over `incomeExpectation`'s own basis and series, for the
 * calendar month that call was asked about (`monthStart`).
 *
 * ⛔ ONE LINK FOR EVERY SURFACE THAT PRINTS THE FIGURE: the runway's "What you earn a month" and the Earned vs banked
 * card's header. 🔴 The card's "Schedule →" opened a bare `/recurring` — Upcoming, a list of what is due — over the
 * same monthly basis the runway's row had just been pointed at its pay schedule for (review of 59de07f, 2026-10-12).
 * ⛔ …and the word follows the page: "Schedule →" over `/spending` would name a page it does not open.
 */
export function monthIncomeLink(
  expectation: { basis: { kind: IncomeBasisKind }; levelledSeriesIds: readonly string[] },
  monthStart: string,
  today: string,
): IncomeLink {
  const { kind } = expectation.basis;
  const window = resolvePeriod({ period: monthKey(monthStart) }, today);
  return {
    href: incomeBasisHref({ kind, levelledSeriesIds: expectation.levelledSeriesIds, window }),
    label: kind === "levelled" ? "Schedule" : "Spending",
  };
}
