import type { Cadence } from "@/db/schema/recurring";
import { BUDGET_JARGON } from "./jargon";
import { formatCents } from "./money";

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

export type IncomeBasisKind = "levelled" | "calendar";

export interface IncomeBasisInput {
  /**
   * Every live income series' annualised monthly rate, summed. Zero or less
   * means there was nothing to level — the only thing that selects `calendar`.
   */
  levelledCents: number;
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
   * chose the figure. The two arithmetics have nothing in common, and a single
   * tooltip covering both could only manage it by being vague about whichever
   * one is actually on screen (`budgetVerdict`'s rule, for the same reason).
   */
  explanation: string;
  /**
   * `cents − scheduledCents`. POSITIVE when this month pays less than the
   * annualised rate, which is the common case. Always zero under `calendar`,
   * where there is no rate to differ from.
   */
  monthDeltaCents: number;
  /**
   * How this calendar month sits against the annualised figure, already
   * formatted — the `SectionNote.body` convention. Null under `calendar`: with
   * nothing levelled there is no plan for the month to be under or over, and a
   * note would be describing something the page is not doing.
   */
  monthNote: string | null;
}

/**
 * The month sentence.
 *
 * Every branch here renders on the real ledger within one year — four-payday
 * months eight times, five-payday months four times — and the zero branch is
 * what a quarterly or annual income series reads in the months it does not pay.
 *
 * ⛔ May not contain "expected income", "left to allocate" or "Over-allocated
 * by": all three are matched by exact-count locators on this same page, and a
 * tooltip or a note repeating one turns an unrelated assertion red. See
 * `RESERVED_JARGON_PHRASES`.
 */
function monthNoteOf(scheduledCents: number, occurrences: number, deltaCents: number): string {
  if (occurrences === 0) {
    // "0 paydays fall in this month, scheduled at $0.00" reads as a broken
    // schedule. It is not — an annual series pays in one month of twelve.
    return "No payday falls in this month; the figure above spreads a year of pay evenly across twelve.";
  }
  const lead = `${occurrences} ${occurrences === 1 ? "payday falls" : "paydays fall"} in this month, scheduled at ${formatCents(scheduledCents)}`;
  if (deltaCents === 0) return `${lead} — exactly the annualised figure above.`;
  const direction = deltaCents > 0 ? "under" : "over";
  return `${lead} — ${formatCents(Math.abs(deltaCents))} ${direction} the annualised figure above.`;
}

export function incomeBasis({
  levelledCents,
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
      explanation: BUDGET_JARGON.expectedIncomeMeasured,
      monthDeltaCents: 0,
      monthNote: null,
    };
  }
  const monthDeltaCents = levelledCents - scheduledCents;
  return {
    kind: "levelled",
    cents: levelledCents,
    explanation: BUDGET_JARGON.expectedIncomeLevelled,
    monthDeltaCents,
    monthNote: monthNoteOf(scheduledCents, scheduledOccurrences, monthDeltaCents),
  };
}
