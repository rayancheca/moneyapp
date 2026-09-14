import { formatCents } from "./money";
import type { ResolvedPeriod } from "./period";

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

/**
 * What a count of unimported days is "of": the period's own label wherever that
 * label names a window a day can belong to.
 *
 * 🔴 /spending passed its pill label straight in, and on 2026-09-14 the readout
 * printed "2 days of All time not imported yet" and "2 days of 2026 to date not
 * imported yet". The phrase was written for the dashboard tile, whose label is
 * always a month. Year-to-date's days are days of its year; All time has no
 * name a day belongs to, so its count stands alone.
 */
export function paceWindowName(period: Pick<ResolvedPeriod, "granularity" | "label" | "from">): string | null {
  if (period.granularity === "all") return null;
  if (period.granularity === "ytd") return period.from.slice(0, 4);
  return period.label;
}

/** "2 days of September 2026 not imported yet" — the tile's words, in one place. */
export function notImportedYet(days: number, windowName: string | null): string {
  const count = `${days} ${days === 1 ? "day" : "days"}`;
  return windowName === null ? `${count} not imported yet` : `${count} of ${windowName} not imported yet`;
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
  /** what those days are "of" (`paceWindowName`) */
  windowName: string | null;
}): PaceReadout {
  const lowerBound = input.uncoveredDays > 0;
  return {
    // the "~" marks an estimate; a lower bound is a stronger and different mark
    projected: lowerBound ? `at least ${formatCents(input.projectedCents)}` : `~${formatCents(input.projectedCents)}`,
    soFar: `${lowerBound ? "at least " : ""}${formatCents(input.actualToDateCents)} so far`,
    notImported: lowerBound ? notImportedYet(input.uncoveredDays, input.windowName) : null,
  };
}
