import type { Cadence } from "@/db/schema/recurring";
import { compareDates } from "@/lib/dates";
import { formatDayShortIn } from "@/lib/format-date";
import { stepFrom, stepPlan } from "@/lib/recurring-step";

/**
 * A series whose whole schedule holds ONE charge — and the words every cadence slot prints for it.
 *
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance — stored as monthly, next and last
 * day both 2026-11-11, -$72.74, never billed — reads as ONE CHARGE, "once · Nov 11", wherever a cadence is printed,
 * and comes out of the subscriptions card's monthly total. 🔴 It read "monthly · next Nov 11 · never billed" on
 * `/categories/<Car>`, "Monthly" on its own page, and sat in "$3,816.92 a month, still forecast" as $72.74 a month —
 * a charge that happens once, in a figure that says it happens every month.
 *
 * Kept client-safe, like `lib/series-evidence`: components label with it and never import the database. The service
 * that asks it of the ledger is `oneChargeDays` (services/recurring).
 */

/** What the question reads — an `EffectiveSeries`, structurally: override-first values. */
export interface OneChargeSchedule {
  cadence: Cadence;
  intervalDaysAvg: number | null;
  anchorDay: number | null;
  nextExpectedOn: string | null;
  userEndsOn: string | null;
}

/**
 * Does this schedule hold exactly one occurrence? Its next expected day IS its end day — the projection walk
 * (`projectOccurrences`, inclusive at the end) stops after one step — and no charge linked to it falls in a cycle
 * before that day's.
 *
 * ⛔ THE SECOND HALF IS WHAT KEEPS A MONTHLY BILL MONTHLY. The stored anchor moves: on the owner's ledger 2026-10-08
 * Car insurance's own next day already reads 2026-12-11, re-anchored past the months the $1,000 paid early, one step
 * short of its 2027-01-11 end. "Next day equals end day" alone would call a six-payment policy "once" the day its
 * anchor reached January. It has charged since August, so its schedule began long before that cycle.
 *
 * `firstMatchedOn` is the EARLIEST active charge linked to the series, null when nothing ever has. One on or before
 * the step before the day belongs to an earlier occurrence; one after it — on the day, or a few days early — IS the
 * one charge. ⚖️ So a posted one-off stays one charge (decided 2026-10-08): its schedule still held one, and it is
 * over — the walk stops at its end day, the subscriptions card counts it ended.
 */
export function isOneCharge(s: OneChargeSchedule, firstMatchedOn: string | null): boolean {
  if (s.userEndsOn === null || s.nextExpectedOn === null) return false;
  if (compareDates(s.nextExpectedOn, s.userEndsOn) !== 0) return false;
  if (firstMatchedOn === null) return true;
  // the same step the walk takes, taken once backwards — so a weekly one-off looks back a week, not a month
  const stepBefore = stepFrom(s.nextExpectedOn, stepPlan(s.cadence, s.intervalDaysAvg, s.anchorDay), -1);
  return compareDates(firstMatchedOn, stepBefore) > 0;
}

/** The cadence word for a one-charge series — in the slot `CADENCE_LABEL` fills for every other series. */
export const ONE_CHARGE_WORD = "once";

/**
 * "once · Nov 11" — what a cadence slot prints for a one-charge series when nothing beside it names the day; the
 * year rides along only when it is not `today`'s, as every other day in a sentence here does (`formatDayShortIn`).
 */
export function oneChargePhrase(day: string, today: string): string {
  return `${ONE_CHARGE_WORD} · ${formatDayShortIn(day, today)}`;
}
