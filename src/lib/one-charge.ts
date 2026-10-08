import type { Cadence } from "@/db/schema/recurring";
import { addDays, compareDates } from "@/lib/dates";
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

/**
 * What the question reads — an `EffectiveSeries`, structurally (override-first values), and the series' own stored
 * `toleranceDays`: how many days after its day a charge may settle and still be that day's (`absorbIntoLiveSeries` gives a
 * final charge the same days past the end).
 */
export interface OneChargeSchedule {
  cadence: Cadence;
  intervalDaysAvg: number | null;
  anchorDay: number | null;
  nextExpectedOn: string | null;
  userEndsOn: string | null;
  toleranceDays: number;
}

/**
 * Does this schedule hold exactly one occurrence? The projection walk (`projectOccurrences`, inclusive at the end)
 * finds one: the next expected day is on or before the end, and the step after it is past the end. The one charge
 * falls on the NEXT day — the end is only where the walk stops — and no charge linked to the series falls in a cycle
 * before that day's.
 *
 * 🔴 It read "next day = end day" (review of 8a4ac47). Not the same thing: the one charge's date token writes the next
 * day, and moved to Nov 8 the walk still found exactly one occurrence while this said monthly — so the card put the
 * $72.74 back into the monthly figure. `setSeriesOverrides` now moves the end with the day; this holds without it.
 *
 * ⛔ THE SECOND HALF IS WHAT KEEPS A MONTHLY BILL MONTHLY. The stored anchor moves: on the owner's ledger 2026-10-08
 * Car insurance's own next day already reads 2026-12-11, re-anchored past the months the $1,000 paid early, one step
 * short of its 2027-01-11 end. "One occurrence left" alone would call a six-payment policy "once" the day its anchor
 * reached January. It has charged since August, so its schedule began long before that cycle.
 *
 * `firstMatchedOn` is the EARLIEST charge the ledger knows of — the first active row linked to the series, or its own
 * `lastMatchedOn` when that is earlier (`oneChargeDays` reads both) — null when nothing ever charged. On or before the
 * step before plus the series' own `toleranceDays` it is that cycle's charge (or an earlier one's), so the schedule
 * held more than one; after it — on the day, late, or paid weeks early — it IS the one charge. ⚖️ A posted one-off
 * stays one charge (decided 2026-10-08): its schedule still held one, and it is over — the walk stops at its end day,
 * the subscriptions card counts it ended.
 *
 * 🔴 The cut-off was the step before's nominal day (review of 8a4ac47), and `posted_on` is the SETTLE date: his Car
 * insurance is due on the 11th and its first charge posted Aug 12, so as a two-payment policy (Aug + Sep 11) it read
 * "once · Sep 11". 🔴 It then moved to HALFWAY between the two days (review of 3044ea6), and his balance paid Oct 12–26
 * read monthly again — on a copy of his ledger a -$72.74 row posted 2026-10-20 put $72.74 a month back in the card's
 * headline. He has paid this insurer early before: the $1,000 on Sep 3 made this balance. Settle lag is days.
 *
 * ⚠️ What dates cannot tell apart: the one charge paid about a cycle early (the balance on or before Oct 14) and the
 * first charge of a two-payment schedule (Oct 11 + Nov 11), posted on time. This reads both as two, so a balance
 * paid that early and attached to it goes back into the card's monthly figure (a copy of his ledger, posted Oct 13:
 * $3,816.92) — the lesser mistake: the other one calls a monthly bill "once" and hides it from that figure.
 */
export function isOneCharge(s: OneChargeSchedule, firstMatchedOn: string | null): boolean {
  if (s.userEndsOn === null || s.nextExpectedOn === null) return false;
  // the same step the walk takes — so a weekly one-off looks back a week, not a month
  const plan = stepPlan(s.cadence, s.intervalDaysAvg, s.anchorDay);
  if (compareDates(s.nextExpectedOn, s.userEndsOn) > 0) return false;
  if (compareDates(stepFrom(s.nextExpectedOn, plan, 1), s.userEndsOn) <= 0) return false;
  if (firstMatchedOn === null) return true;
  const stepBeforeSettled = addDays(stepFrom(s.nextExpectedOn, plan, -1), s.toleranceDays);
  return compareDates(firstMatchedOn, stepBeforeSettled) > 0;
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
