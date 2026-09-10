import type { BlastRadiusLine } from "@/components/ui/blast-radius";
import { longDate } from "./labels";

/**
 * What ending a series actually costs — the lines under "End this series".
 *
 * 🔴 IT NAMED THE FUTURE AND NOT THE ARREARS. `budgetDeactivateLines` was
 * written for exactly this on `/budgets` — "⛔ `overdueCents` and
 * `expectedTailCents` are DISJOINT by construction … both are printed, never
 * added. Past first, then future" — and this second dialog, for the same
 * money, never learned it. Measured 2026-09-10, `/recurring/<Flamingo South
 * Beach (rent)>`:
 *
 *     Leaving the forecast              ~$25,308.00 / yr
 *     Upcoming charges off the calendar 3 charges
 *     Linked transactions kept          4 transactions
 *
 * The three charges are Oct 1, Nov 1 and Dec 1. The occurrence on the calendar
 * RIGHT NOW — Sep 1, $2,109.00, unsettled — is the one the same page shows
 * three cards below under "Already due, and not posted … The forecast counts
 * it, and so does this month's budget", and ending the series removes it too:
 * `recurring-calendar`'s `forecastRows` is filtered to detected|confirmed.
 * Five of the fourteen live series carry one today, $2,405.07 in all.
 *
 * 🔴 …AND "3 charges" WAS A PREVIEW CAP, NOT A MEASUREMENT.
 * `NEXT_EXPECTED_COUNT = 3` bounds the list `recurring-detail` returns, so an
 * open-ended monthly commitment reported "3 charges" whatever it really loses,
 * which for `Flamingo South Beach (rent)` is every rent charge there will ever
 * be. A blast radius that under-reports is the one thing it must not do. The
 * line names the span instead of counting a preview.
 */
export interface SeriesEndInput {
  /** a year at today's amounts, or null when the series cannot carry one */
  annualizedCents: number | null;
  /** arrears magnitude — 0 when nothing is late; disjoint from the tail below */
  overdueCents: number;
  overdueOn: string | null;
  /** how many occurrences the arrears covers (the page's own "and N more") */
  overdueCount: number;
  /** the next occurrence's day, or null when nothing more is projected */
  nextChargeOn: string | null;
  /** last day the series can occur; null = open-ended */
  endsOn: string | null;
  linkedCount: number;
}

/** The upcoming clause — a span, never a count off a capped preview. */
function upcomingValue(input: SeriesEndInput): string {
  if (input.nextChargeOn === null) return "none scheduled";
  const from = longDate(input.nextChargeOn);
  return input.endsOn === null
    ? `every charge from ${from} on`
    : `every charge from ${from} to ${longDate(input.endsOn)}`;
}

export function seriesEndLines(
  input: SeriesEndInput,
  formatCents: (cents: number) => string,
): BlastRadiusLine[] {
  const overdueValue =
    input.overdueCount > 1
      ? `${formatCents(input.overdueCents)} across ${input.overdueCount} charges`
      : formatCents(input.overdueCents);
  return [
    ...(input.annualizedCents !== null
      ? [
          {
            label: "Leaving the forecast",
            value: `~${formatCents(input.annualizedCents)} / yr`,
            irreversible: true,
          },
        ]
      : []),
    // past first, then future — the order `budgetDeactivateLines` reads in
    ...(input.overdueCents > 0
      ? [{ label: "Already due this month, not imported", value: overdueValue }]
      : []),
    { label: "Upcoming charges off the calendar", value: upcomingValue(input) },
    {
      label: "Linked transactions kept",
      value: `${input.linkedCount} ${input.linkedCount === 1 ? "transaction" : "transactions"}`,
    },
  ];
}
