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
 * CURRENT rate (`PaydayReading.ratePeriod`), because a dated rate change is not a change in what a week pays. Any
 * other series averages its rows as they posted.
 *
 * 🔴 Measured on a copy of his ledger 2026-10-08: the raw mean of his four deposits — Jun 4's $1,047.00 cash week,
 * Jun 5's $400.00, the Sep 23 lump of $4,567.68 and Sep 24's $1,141.92 — is $1,789.15, an amount no payday ever paid.
 * His page printed "posted avg +$1,789.15 ± 1881.46" under "+$1,141.92", the All tab "posted avg +$1,789.15", and the
 * popover "⚠️ The ledger's own average of what actually posted is $1,789.15, which is not what you set."
 */
export interface PostedAverage {
  /** the samples' mean, to the cent — null with no sample */
  avgCents: number | null;
  /** their SAMPLE standard deviation — null under two samples: with one there is nothing to vary */
  stddevCents: number | null;
}

/**
 * The reading, from a series' active rows: `readings` is the series' per-payday reading (`paydayReadings`) when it is
 * read per payday, null when its rows are read as they posted.
 */
export function postedAverage(
  rows: readonly ReadableRow[],
  readings: ReadonlyMap<string, PaydayReading> | null,
  schedule: Pick<RateSchedule, "amountHistory">,
): PostedAverage {
  const samples = readings === null ? rows.map((r) => r.amountCents) : perPaydaySamples(rows, readings, schedule);
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
