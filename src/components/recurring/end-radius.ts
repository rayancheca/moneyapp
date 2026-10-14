import type { BlastRadiusLine } from "@/components/ui/blast-radius";
import type { SeriesKind } from "@/db/schema/recurring";
import { arrearsClause, NOT_POSTED } from "@/lib/arrears-reading";
import { ONE_CHARGE_WORD } from "@/lib/one-charge";
import {
  seriesDrawsAsRecurring,
  seriesIsProjected,
  seriesPostingWords,
  type SeriesStatusForCopy,
} from "@/lib/series-evidence";
import type { SeriesDetail } from "@/services/recurring-detail";
import { annualizedFigure, longDate } from "./labels";

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
 *
 * 🔴 …AND IT CALLED HIS PAY'S DEPOSITS CHARGES. On a copy of his ledger (2026-10-12) asked about 2026-11-12, his pay's
 * dialog (It America LLC, weekly) read "Upcoming charges off the calendar: every charge from Nov 12, 2026 on" over
 * "Nothing is deleted — the charges stay in your ledger" (review of 49cc98f, item (4)'s sweep). What it loses and
 * keeps is worded by its kind (`seriesPostingWords`), as the page's "Nothing expected" card is; a bill's lines read
 * as before.
 */
export interface SeriesEndInput {
  /** what it posts — the lines say charges, deposits, transfers or payments as the page's card does (`seriesPostingWords`) */
  kind: SeriesKind;
  /**
   * Ending it marks its linked rows recurring — they are not now: a status not drawn as recurring (dismissed) with rows
   * linked to it. See `endDrawsAsRecurring`.
   */
  drawnAsRecurringByEnding: boolean;
  /**
   * A year at today's amounts — or, of a schedule of one charge (`oneChargeOn`), that charge (`annualizedFigure`, the
   * page's Annualized slot) — or null when the series cannot carry one
   */
  annualizedCents: number | null;
  /** arrears magnitude — 0 when nothing is late; disjoint from the tail below */
  overdueCents: number;
  /** of `overdueCents`, the part on days no checked statement has reached (`ArrearsReading.unreadCents`) */
  overdueUnreadCents: number;
  /** of `overdueUnreadCents`, the part no statement keeps unread (`ArrearsReading.inGraceCents`) */
  overdueInGraceCents: number;
  overdueOn: string | null;
  /** how many occurrences the arrears covers (the page's own "and N more") */
  overdueCount: number;
  /** the next occurrence's day, or null when nothing more is projected */
  nextChargeOn: string | null;
  /**
   * The day of its ONE charge when its whole schedule holds one (`SeriesDetail.oneChargeOn`), else null. ⚖️ §6A 56
   * (2026-10-08): it is upcoming "once on Nov 11, 2026", as its page's "charges once on Nov 11" — 🔴 not "every charge
   * from Nov 11, 2026 to Nov 11, 2026" (review of 7a3c702, the balance's dialog on his ledger copy 2026-10-13).
   */
  oneChargeOn: string | null;
  /** last day the series can occur; null = open-ended */
  endsOn: string | null;
  linkedCount: number;
}

/**
 * Does ending it mark its rows recurring — rows linked to a status not drawn as recurring? Ended is drawn, dismissed is
 * not (`seriesDrawsAsRecurring`), so ending a dismissed series puts its rows back: marked recurring in the ledger
 * (`ledger-rows`), drawn on the recurring calendar (`RECURRING_HISTORY_STATUSES`), and out of his recent pace — the
 * forecast's, `/spending`'s and every budget's (`seriesIdsNotDrawnAsRecurring`). ONE predicate for the headline and the
 * kept line, so the dialog cannot say it in one and not the other.
 */
function endDrawsAsRecurring(status: SeriesStatusForCopy, linkedCount: number): boolean {
  return !seriesDrawsAsRecurring(status) && linkedCount > 0;
}

/** The page's own data as the dialog's input — every field from the figure the page itself prints. */
export function seriesEndInput(
  data: Pick<
    SeriesDetail,
    | "kind"
    | "status"
    | "annualizedCents"
    | "nextExpectedAmountCents"
    | "overdue"
    | "nextExpected"
    | "oneChargeOn"
    | "endsOn"
    | "linkedTxns"
  >,
): SeriesEndInput {
  return {
    kind: data.kind,
    drawnAsRecurringByEnding: endDrawsAsRecurring(data.status, data.linkedTxns.length),
    // the page's own Annualized figure — its one charge, of a schedule of one (§6A 56)
    annualizedCents: annualizedFigure(data)?.cents ?? null,
    overdueCents: Math.abs(data.overdue?.amountCents ?? 0),
    overdueUnreadCents: data.overdue?.unreadCents ?? 0,
    overdueInGraceCents: data.overdue?.inGraceCents ?? 0,
    overdueOn: data.overdue?.date ?? null,
    overdueCount: data.overdue?.occurrenceCount ?? 0,
    nextChargeOn: data.nextExpected[0]?.date ?? null,
    oneChargeOn: data.oneChargeOn,
    endsOn: data.endsOn,
    linkedCount: data.linkedTxns.length,
  };
}

/**
 * The dialog's headline — what ending takes out, true of the lines under it.
 *
 * 🔴 It said "<name> stops being expected: it leaves the forecast, the recurring calendar, and every budget's expected
 * tail." of every series, a LAPSED one too — whose lines show nothing leaving: no "Leaving the forecast" (its page
 * carries no year, `seriesIsForecast`), no arrears, "Upcoming charges off the calendar · none scheduled". The forecast
 * had let it go already, and so had the calendar and every budget's tail (`hasStoppedForecasting`). ⛔ The predicate
 * the page's "Nothing expected" card and cadence sentence ask (`seriesIsProjected`), so the three cannot disagree.
 *
 * 🔴 …AND IT SAID ENDING A DISMISSED SERIES "TAKES NOTHING OUT", when ending one puts things back (review of 8f9f408,
 * 2026-10-13): its rows are marked recurring again, drawn on the recurring calendar and taken out of his recent pace
 * (`endDrawsAsRecurring`). On his ledger copy 2026-10-12 all ten dismissed series with rows said it — and ending
 * PURA VIDA BAY ROAD MIAMI BEACH moves October's projected spending by -$7.33, YA-FIT Smoothie Bar's by -$10.73. One
 * with no rows has nothing to put back, and is out of the three like a lapsed one.
 *
 * 🔴 …AND IT PUT PAY IN A BUDGET'S TAIL. `budgetTail` keeps money out alone (`o.amountCents < 0`), so money in —
 * pay, an `other` credit, a transfer in — was never in one: on his ledger copy 2026-10-12 It America LLC (weekly pay)
 * "stops being expected: it leaves the forecast, the recurring calendar, and every budget's expected tail". The sign is
 * the amount the forecast projects (`nextExpectedAmountCents`, `effectiveSeries`).
 *
 * 🔴 …AND THEN IT LEFT OUT WHAT PAY IS IN (review of 17ff00a): "It America LLC (weekly pay) stops being expected: it
 * leaves the forecast and the recurring calendar." Pay is the monthly income /budgets grades against and the runway
 * counts on (`incomeExpectation`), and a confirmed one is a line of the dashboard's Earned vs banked. Ended on a copy of
 * his ledger 2026-10-12: "Budgeted $X of $4,948.32 expected income" became "…of $0.00", the runway went from "2.6
 * months of cash" to "1.0 months of cash", and Earned vs banked went with its one line. ⛔ Both from the readers' own
 * rules (`SeriesDetail.isHisPay`, `onEarnedVsBanked`); the agent's income is in neither, and its dialog names neither.
 */
export type SeriesEndSubject = Pick<
  SeriesDetail,
  "name" | "status" | "evidence" | "kind" | "nextExpectedAmountCents" | "isHisPay" | "onEarnedVsBanked"
> & {
  linkedTxns: readonly unknown[];
};

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** What a series is in while it is expected: the budgets' tail for money out (`budgetTail`), his income for his pay. */
function expectedIn(data: SeriesEndSubject): string[] {
  const always = ["the forecast", "the recurring calendar"];
  if ((data.nextExpectedAmountCents ?? 0) < 0) return [...always, "every budget's expected tail"];
  if (!data.isHisPay) return always;
  return [
    ...always,
    "the monthly income your budgets and runway count on",
    ...(data.onEarnedVsBanked ? ["its line on Earned vs banked"] : []),
  ];
}

export function seriesEndHeadline(data: SeriesEndSubject): string {
  const where = expectedIn(data);
  if (seriesIsProjected(data.status, data.evidence)) {
    return `${data.name} stops being expected: it leaves ${LIST.format(where)}.`;
  }
  if (endDrawsAsRecurring(data.status, data.linkedTxns.length)) {
    return (
      `Ending ${data.name} takes back "not recurring": nothing is expected from it either way, but its ` +
      `${seriesPostingWords(data.kind).postings} count as recurring — marked in your ledger, drawn on the recurring ` +
      "calendar and left out of your recent pace."
    );
  }
  // no serial comma before the clause that follows — as the sentence has always read
  const out = where.length < 3 ? LIST.format(where) : `${where.slice(0, -1).join(", ")} and ${where.at(-1)}`;
  return `${data.name} is already out of ${out}, so ending it takes nothing out of them.`;
}

/** What survives — the rows, in what the series posts (`seriesPostingWords`), as the card under the dialog says them. */
export function seriesEndReassurance(kind: SeriesKind): string {
  return (
    `Nothing is deleted — the ${seriesPostingWords(kind).postings} stay in your ledger, and Confirm brings the series ` +
    "back if it starts again."
  );
}

/** The upcoming clause — a span, never a count off a capped preview; a schedule of one charge, its day (§6A 56). */
function upcomingValue(input: SeriesEndInput): string {
  if (input.nextChargeOn === null) return "none scheduled";
  if (input.oneChargeOn !== null) return `${ONE_CHARGE_WORD} on ${longDate(input.oneChargeOn)}`;
  const every = `every ${seriesPostingWords(input.kind).posting} from ${longDate(input.nextChargeOn)}`;
  return input.endsOn === null ? `${every} on` : `${every} to ${longDate(input.endsOn)}`;
}

export function seriesEndLines(
  input: SeriesEndInput,
  formatCents: (cents: number) => string,
): BlastRadiusLine[] {
  const { postings } = seriesPostingWords(input.kind);
  const overdueValue =
    input.overdueCount > 1
      ? `${formatCents(input.overdueCents)} across ${input.overdueCount} ${postings}`
      : formatCents(input.overdueCents);
  const reading = {
    owedCents: input.overdueCents,
    unreadCents: input.overdueUnreadCents,
    inGraceCents: input.overdueInGraceCents,
  };
  return [
    ...(input.annualizedCents !== null
      ? [
          {
            label: "Leaving the forecast",
            // ⚖️ §6A 56: one charge leaves as that charge — 🔴 "~$72.74 / yr" under "once on Nov 11, 2026" (his
            // ledger copy, 2026-10-13)
            value:
              input.oneChargeOn === null
                ? `~${formatCents(input.annualizedCents)} / yr`
                : `~${formatCents(input.annualizedCents)}, its one ${seriesPostingWords(input.kind).posting}`,
            irreversible: true,
          },
        ]
      : []),
    // past first, then future — the order `budgetDeactivateLines` reads in; "not posted" only of read days
    ...(input.overdueCents > 0
      ? [{ label: `Already due this month, ${arrearsClause(reading, NOT_POSTED)}`, value: overdueValue }]
      : []),
    { label: `Upcoming ${postings} off the calendar`, value: upcomingValue(input) },
    {
      // what ending ADDS, where it adds anything — the headline's `endDrawsAsRecurring`
      label: input.drawnAsRecurringByEnding ? "Linked transactions kept, counted as recurring" : "Linked transactions kept",
      value: `${input.linkedCount} ${input.linkedCount === 1 ? "transaction" : "transactions"}`,
    },
  ];
}
