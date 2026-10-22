import { nothingFoundSoFar } from "./budget-coverage";
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
 *
 * ⚖️ …and decision 64 (2026-10-12): a window with no spending found and not one elapsed day read by spending's day
 * (`CashFlow.spendingUnaccounted`) has no figure to floor. The tile dashes "Free to spend" and prints "nothing found so
 * far — spending imported through Jun 20" under it; the readout prints those words in place of both figures. 🔴 Review
 * of 1042f71 (today 2026-07-08, checking read through Jun 20, payroll found on Jul 3): the tile dashed while the
 * readout printed "On pace for at least $0.00 … at least $0.00 so far" — "true of every month there has ever been",
 * as the tile's own comment says of it.
 */

export interface PaceReadout {
  /**
   * "~$3,066.54", or "at least $3,066.54" when the window is read only in part; null where nothing is paced — no
   * projection, or no spending found past spending's day
   */
  projected: string | null;
  /**
   * "$1,431.05 so far", or "at least $1,431.05 so far" — or the tile's words under its dash where no spending was found
   * past spending's day: "nothing found so far — spending imported through Jun 20"
   */
  soFar: string;
  /** why the two above are lower bounds — the period proof's line; null when it is read in full, or nothing was found */
  partlyRead: string | null;
}

export function paceReadout(input: {
  /** the period's projected spend (`SpendingProjection.projectedSpendCents`) — null where it has none */
  projectedCents: number | null;
  actualToDateCents: number;
  /** the window's days read only in part, and their line (`SpendingProjection.pacePartlyRead`) */
  partlyRead: { uncoveredDays: number; line: string } | null;
  /**
   * `CashFlow.spendingUnaccounted` — "spending imported through Jun 20" where the window holds no spending and not one
   * elapsed day is read by that day: the fact the dashboard tile dashes with (`SpendingPace.spendingNotFound`)
   */
  spendingUnaccounted: string | null;
}): PaceReadout {
  // ⛔ the fact names the day, and every elapsed day is past it: "8 days of this period unaccounted" would repeat it
  if (input.spendingUnaccounted !== null) {
    return { projected: null, soFar: nothingFoundSoFar(input.spendingUnaccounted), partlyRead: null };
  }
  const lowerBound = input.partlyRead !== null;
  const projected = input.projectedCents === null ? null : formatCents(input.projectedCents);
  return {
    // the "~" marks an estimate; a lower bound is a stronger and different mark
    projected: projected === null ? null : lowerBound ? `at least ${projected}` : `~${projected}`,
    soFar: `${lowerBound ? "at least " : ""}${formatCents(input.actualToDateCents)} so far`,
    partlyRead: input.partlyRead?.line ?? null,
  };
}

/**
 * How far below the axis the cash-flow chart draws its dashed "typical pace" line (`PaceInfo.avgPerBucketCents`), or
 * null where it draws none: a period with no pace, and ⚖️ decision 64's window — no spending found past spending's day
 * (`CashFlow.spendingUnaccounted`), where the readout above it prints the tile's words in place of every figure.
 *
 * 🔴 Review of 4d799b6 (twin of the e2e fixture at 2026-07-08, checking read through Jun 20): the readout said "Nothing
 * found so far — spending imported through Jun 20" while the chart under it drew the amber pace at $0 — 0 because
 * nothing was found, not because nothing was spent. ⛔ The readout's own test (`spendingUnaccounted`), so the line and
 * the words cannot disagree about whether there is a figure.
 */
export function typicalPaceCents(input: {
  pace: { avgPerBucketCents: number } | null;
  spendingUnaccounted: string | null;
}): number | null {
  if (input.pace === null || input.spendingUnaccounted !== null) return null;
  return input.pace.avgPerBucketCents;
}
