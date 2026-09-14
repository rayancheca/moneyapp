import { formatCents } from "./money";

/**
 * The cash-flow card's pace readout in words — and the phrase it shares with the
 * dashboard's pace tile, which grades the same days.
 *
 * 🔴 S12. On 2026-09-14, newest imported row Sep 12, /spending?period=2026-09
 * printed "On pace for ~$3,066.54 spent this period · $1,431.05 so far", while
 * the dashboard tile that links to it printed "at least $1,431.05 spent · at
 * least $3,066.54 projected" and "2 days of September 2026 not imported yet".
 * Two surfaces grading one window graded it two ways, and the one that did not
 * say "at least" was the one a reader lands on to check the other.
 *
 * ⛔ The MATH is not touched. `computePace`/`projectPace` stay a straight-line
 * extrapolation of what has been imported — the tile reads the same
 * `cashFlow.pace` — which is exactly why the words must mark the figures as
 * lower bounds whenever elapsed days are missing from them.
 */

/** "2 days of September 2026 not imported yet" — the tile's words, in one place. */
export function notImportedYet(days: number, periodLabel: string): string {
  return `${days} ${days === 1 ? "day" : "days"} of ${periodLabel} not imported yet`;
}

export interface PaceReadout {
  /** "~$3,066.54", or "at least $3,066.54" when elapsed days are unimported */
  projected: string;
  /** "$1,431.05 so far", or "at least $1,431.05 so far" */
  soFar: string;
  /** why the two above are lower bounds — null when nothing elapsed is missing */
  notImported: string | null;
}

export function paceReadout(input: {
  projectedCents: number;
  actualToDateCents: number;
  /** elapsed days no import reaches (`daysNotImportedYet`) */
  uncoveredDays: number;
  periodLabel: string;
}): PaceReadout {
  const lowerBound = input.uncoveredDays > 0;
  return {
    // the "~" marks an estimate; a lower bound is a stronger and different mark
    projected: lowerBound ? `at least ${formatCents(input.projectedCents)}` : `~${formatCents(input.projectedCents)}`,
    soFar: `${lowerBound ? "at least " : ""}${formatCents(input.actualToDateCents)} so far`,
    notImported: lowerBound ? notImportedYet(input.uncoveredDays, input.periodLabel) : null,
  };
}
