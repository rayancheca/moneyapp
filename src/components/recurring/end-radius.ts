import type { BlastRadiusLine } from "@/components/ui/blast-radius";
import { arrearsClause } from "@/lib/arrears-reading";
import type { SeriesDetail } from "@/services/recurring-detail";
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
 *
 * 🔴 …AND IT SAID "not imported" WHATEVER THE LEDGER HAD READ. The page handed
 * this the arrears' amount, date and count and dropped how far the ledger had
 * read them, so where an import HAD covered the due day the card three cards
 * below said "Already due, and not posted" in warning colour while this said
 * "Already due this month, not imported" — false of a day that was imported
 * (review of 2e6c74b, 2026-10-08; Netflix due Jul 1, its card read through
 * Jul 5). ⛔ The card's split, the runway's (`arrearsClause`), built from the
 * page's data in one place (`seriesEndInput`).
 */
export interface SeriesEndInput {
  /** a year at today's amounts, or null when the series cannot carry one */
  annualizedCents: number | null;
  /** arrears magnitude — 0 when nothing is late; disjoint from the tail below */
  overdueCents: number;
  /** of `overdueCents`, the part on days no import has reached (`ArrearsReading.unreadCents`) */
  overdueUnreadCents: number;
  overdueOn: string | null;
  /** how many occurrences the arrears covers (the page's own "and N more") */
  overdueCount: number;
  /** the next occurrence's day, or null when nothing more is projected */
  nextChargeOn: string | null;
  /** last day the series can occur; null = open-ended */
  endsOn: string | null;
  linkedCount: number;
}

/** The page's own data as the dialog's input — every field from the figure the page itself prints. */
export function seriesEndInput(
  data: Pick<SeriesDetail, "annualizedCents" | "overdue" | "nextExpected" | "endsOn" | "linkedTxns">,
): SeriesEndInput {
  return {
    annualizedCents: data.annualizedCents,
    overdueCents: Math.abs(data.overdue?.amountCents ?? 0),
    overdueUnreadCents: data.overdue?.unreadCents ?? 0,
    overdueOn: data.overdue?.date ?? null,
    overdueCount: data.overdue?.occurrenceCount ?? 0,
    nextChargeOn: data.nextExpected[0]?.date ?? null,
    endsOn: data.endsOn,
    linkedCount: data.linkedTxns.length,
  };
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
  const reading = { owedCents: input.overdueCents, unreadCents: input.overdueUnreadCents };
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
    // past first, then future — the order `budgetDeactivateLines` reads in; "not posted" only of read days
    ...(input.overdueCents > 0
      ? [{ label: `Already due this month, ${arrearsClause(reading, "not posted")}`, value: overdueValue }]
      : []),
    { label: "Upcoming charges off the calendar", value: upcomingValue(input) },
    {
      label: "Linked transactions kept",
      value: `${input.linkedCount} ${input.linkedCount === 1 ? "transaction" : "transactions"}`,
    },
  ];
}
