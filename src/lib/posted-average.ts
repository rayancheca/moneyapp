import type { SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import { compareDates } from "./dates";
import { spreadSampleCents, type PaydayReading, type ReadableRow } from "./per-payday";
import { currentRatePeriod, ratePeriodOf, type RateSchedule } from "./series-kind";

/**
 * WHAT A SERIES' POSTINGS AVERAGED, AND THEIR SPREAD — the figure "posted avg" names and the ± it carries. ONE reading
 * for every surface that prints it: the series page's Per charge (`seriesDetail`), the All tab's "posted avg"
 * (`listSeries`) and the amount popover's "The ledger's own average of what actually posted" (provenance). Each feeds
 * it through `services/posted-average`, so the three can only name one figure.
 *
 * ⚖️ A pay series read per payday (`readsPerPayday`) averages what a PAYDAY paid, over the rate era in force now
 * (owner decisions 2026-10-08, §6A 55): each row as the calendar holds it to the expectation (`spreadSampleCents` — a
 * lump as one week; never a part of a payday's pay, nor money that paid no payday), and only the rows held to the
 * CURRENT rate (`PaydayReading.ratePeriod`), because a dated rate change is not a change in what a week pays.
 *
 * A series with a schedule of charges (`readsPerOccurrence`) averages what each OCCURRENCE was paid: the rows of one
 * payment are one sample. Any other series averages its rows as they posted.
 *
 * 🔴 Measured on a copy of his ledger 2026-10-08: the raw mean of his four deposits — Jun 4's $1,047.00 cash week,
 * Jun 5's $400.00, the Sep 23 lump of $4,567.68 and Sep 24's $1,141.92 — is $1,789.15, an amount no payday ever paid.
 * His page printed "posted avg +$1,789.15 ± 1881.46" under "+$1,141.92", the All tab "posted avg +$1,789.15", and the
 * popover "⚠️ The ledger's own average of what actually posted is $1,789.15, which is not what you set."
 *
 * 🔴 …and the same of a bill, 2026-10-12: the rent's page and the All tab printed "posted avg -$1,849.76 ± $583.58"
 * under "-$2,109.00", though every month he paid MORE — Jun 16's one payment, posted by his card as -$1,100.00
 * and -$1,334.80, counted as two charges. Per payment it is -$2,312.20 ± $85.27.
 */
export interface PostedAverage {
  /** the samples' mean, to the cent — null with no sample */
  avgCents: number | null;
  /** their SAMPLE standard deviation — null under two samples: with one there is nothing to vary */
  stddevCents: number | null;
}

/**
 * How a series' rows become samples — `services/posted-average` picks it: per payday (`readsPerPayday`, with the
 * series' per-payday reading, `paydayReadings`), per occurrence (`readsPerOccurrence`), or each row as it posted.
 */
export type PostedReading =
  | { readonly per: "payday"; readonly readings: ReadonlyMap<string, PaydayReading> }
  | { readonly per: "occurrence" }
  | { readonly per: "row" };

/**
 * Whether a series' rows are read per occurrence: a series with a schedule of charges — every kind but money in,
 * live or ended — and not one he dismissed.
 *
 * ⛔ Money in keeps the pay rule (§6A 55, untouched): per payday while it is paid (`readsPerPayday`), as it posted once
 * it ends. ⛔ A dismissed series has no occurrence to pay — he said it is not recurring — and its rows are purchases:
 * measured on a copy of his ledger 2026-10-12, CC Vending's three of Nov 11, 2024 ($2.40, $2.60, $2.65).
 */
export function readsPerOccurrence(s: { kind: SeriesKind; status: SeriesStatus }): boolean {
  return s.kind !== "income" && s.status !== "dismissed";
}

/** The reading, from a series' active rows (`PostedReading`). */
export function postedAverage(
  rows: readonly ReadableRow[],
  reading: PostedReading,
  schedule: Pick<RateSchedule, "amountHistory">,
): PostedAverage {
  const samples =
    reading.per === "payday"
      ? perPaydaySamples(rows, reading.readings, schedule)
      : reading.per === "occurrence"
        ? occurrencesOf(rows).map((o) => o.amountCents)
        : rows.map((r) => r.amountCents);
  if (samples.length === 0) return { avgCents: null, stddevCents: null };
  const mean = samples.reduce((a, c) => a + c, 0) / samples.length;
  if (samples.length < 2) return { avgCents: Math.round(mean), stddevCents: null };
  const variance = samples.reduce((a, c) => a + (c - mean) ** 2, 0) / (samples.length - 1);
  return { avgCents: Math.round(mean), stddevCents: Math.round(Math.sqrt(variance)) };
}

/** What each payday of the rate era in force now paid — the calendar's spread samples, held to today's rate. */
function perPaydaySamples(
  rows: readonly ReadableRow[],
  readings: ReadonlyMap<string, PaydayReading>,
  schedule: Pick<RateSchedule, "amountHistory">,
): number[] {
  const now = currentRatePeriod(schedule);
  return rows.flatMap((r) => {
    const reading = readings.get(r.id);
    // a row with no reading is held on its own day, as `expectedCentsOf` holds it
    if ((reading?.ratePeriod ?? ratePeriodOf(schedule, r.postedOn)) !== now) return [];
    const sample = spreadSampleCents(r.amountCents, reading);
    return sample === null ? [] : [sample];
  });
}

/** One payment of a series read per occurrence: its day, what it paid, and how many rows the bank posted it as. */
export interface Occurrence {
  postedOn: string;
  amountCents: number;
  /** the rows of that day — 1 for a payment posted whole; his card posted Jun 16's rent as 2 */
  postings: number;
}

/**
 * What each payment paid, oldest first: a day's rows summed — one payment the bank posted as several, as his card
 * posted Jun 16's rent as two. A row of another day is another payment, however near. The samples of the posted
 * average (`readsPerOccurrence`), and — through `SeriesPostedAverage.occurrences` — what the popover's sentence counts
 * and ranges and what the series page's Amount history draws, so neither can count a payment the average does not.
 *
 * ⚠️ Not the series' tolerance either side, the reach the calendar gives a payment of a due day (`paymentFor`): the
 * calendar pays a due day with ONE posting, and walks due days only from the anchor forward — the rent's from Sep 1, so
 * no due day of the calendar's is paid by Jun 16 at all. 🔴 Read as rows within the tolerance of a payment's first,
 * separate charges became one: on the e2e fixture after "Detect now", Chipotle's visits of Sep 19 and 21, 2025 (and
 * four more pairs) and Sweetgreen's lunches of Jan 20, 21 and 22, 2026 — each one sample of two or three meals.
 */
export function occurrencesOf(rows: readonly Pick<ReadableRow, "postedOn" | "amountCents">[]): Occurrence[] {
  const byDay = new Map<string, Occurrence>();
  for (const r of rows) {
    const o = byDay.get(r.postedOn);
    byDay.set(
      r.postedOn,
      o === undefined
        ? { postedOn: r.postedOn, amountCents: r.amountCents, postings: 1 }
        : { ...o, amountCents: o.amountCents + r.amountCents, postings: o.postings + 1 },
    );
  }
  return [...byDay.values()].sort((a, b) => compareDates(a.postedOn, b.postedOn));
}

/**
 * "posted as 2" — a payment the bank posted as several rows, said where it is counted as one: the popover's "(5
 * tagged postings: Jun 16's posted as 2)" and the Amount history's "one payment, posted as 2". Null for a payment
 * posted whole, which says nothing new.
 */
export function postedAsWord(o: Pick<Occurrence, "postings">): string | null {
  return o.postings > 1 ? `posted as ${o.postings}` : null;
}
