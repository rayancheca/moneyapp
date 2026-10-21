import { formatCents } from "./money";

/**
 * The cash-flow card's pace readout in words — graded by the line the dashboard's
 * pace tile prints over the same days.
 *
 * 🔴 S12. On 2026-09-14, newest imported row Sep 12, /spending?period=2026-09
 * printed "On pace for ~$3,066.54 spent this period · $1,431.05 so far", while
 * the dashboard tile that links to it printed "at least $1,431.05 spent · at
 * least $3,066.54 projected" and "2 days of September 2026 not imported yet".
 * Two surfaces grading one window graded it two ways, and the one that did not
 * say "at least" was the one a reader lands on to check the other.
 *
 * ⛔ The MATH is not touched. `computePace`/`projectPace` stay a straight-line
 * extrapolation of what has been imported — less the car's up-front money,
 * which is counted once and never extrapolated (owner decision 2026-10-07,
 * §6A 51) — and the tile reads the same `cashFlow.pace`. That is exactly why
 * the words must mark the figures as lower bounds whenever elapsed days are
 * missing from them.
 *
 * ⚖️ His decision 72 (2026-10-13): which days are missing is the period proof's count, and why is its line
 * (`allSpendPartlyRead`). 🔴 Measured on his ledger copy 2026-10-21: both surfaces counted the days NO account had
 * read and printed "7 days of October 2026 not imported yet", beside /spending's "spending imported through Aug 12 · 21
 * days of this period unaccounted" — Chase Checking and Wells Fargo had read no day of October. "Of this period" names
 * no window, so the phrase that had to learn what All time is "of" went with the count.
 */

export interface PaceReadout {
  /** "~$3,066.54", or "at least $3,066.54" when the window is read only in part */
  projected: string;
  /** "$1,431.05 so far", or "at least $1,431.05 so far" */
  soFar: string;
  /** why the two above are lower bounds — the period proof's line; null when it is read in full */
  partlyRead: string | null;
}

export function paceReadout(input: {
  projectedCents: number;
  actualToDateCents: number;
  /** the window's days read only in part, and their line (`SpendingProjection.pacePartlyRead`) */
  partlyRead: { uncoveredDays: number; line: string } | null;
}): PaceReadout {
  const lowerBound = input.partlyRead !== null;
  return {
    // the "~" marks an estimate; a lower bound is a stronger and different mark
    projected: lowerBound ? `at least ${formatCents(input.projectedCents)}` : `~${formatCents(input.projectedCents)}`,
    soFar: `${lowerBound ? "at least " : ""}${formatCents(input.actualToDateCents)} so far`,
    partlyRead: input.partlyRead?.line ?? null,
  };
}
