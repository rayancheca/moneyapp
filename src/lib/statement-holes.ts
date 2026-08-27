import { addDays, diffDays } from "./dates";
import { nextCloseAfter, type StatementCadence } from "./statement-cadence";

/**
 * The statements an account never had — the other half of "did my upload work?".
 *
 * ⛔ This is a different question from coverage, and the difference is why it
 * needed building. `accountCoverage` asks whether the MONEY adds up, and on
 * this ledger it answers yes for every account: zero gap days, nothing broken.
 * Discover reads **VERIFIED**. And Discover is missing five statements — the
 * balance chain closes across them because an anchor on the far side pins it,
 * so the arithmetic is sound and the DOCUMENTS are not there.
 *
 * Both facts are true and neither implies the other:
 *
 *   - a verified account can be missing statements (the chain was bridged)
 *   - an account with every statement can still fail to close (a parser dropped
 *     rows, which is how pass 37 found 71 silently missing charges)
 *
 * So this reports holes between consecutive statement PERIODS, names the exact
 * window to go and fetch, and — where the account's own rhythm is known — how
 * many statements that window is.
 *
 * ⚠️ Neutral by construction. Statement staleness on this ledger is the normal
 * rhythm rather than a fault, and a panel that called five old holes a problem
 * would be wrong about how he actually works. It states what is absent; it does
 * not grade him for it.
 */

export interface StatementPeriodRef {
  /** inclusive first day of the period */
  readonly start: string;
  /** inclusive last day of the period */
  readonly end: string;
}

export interface StatementHole {
  /** first day no statement covers */
  readonly from: string;
  /** last day no statement covers */
  readonly to: string;
  /** whole days in the hole, both ends inclusive */
  readonly days: number;
  /**
   * How many statements the account's own rhythm says closed inside this
   * window. Null when the rhythm is unknown — a count invented from a flat
   * 30-day assumption would be a number nobody measured.
   */
  readonly closes: number | null;
}

/**
 * The most closes a single hole will be walked for.
 *
 * A cadence of `every-n-days: 1` (which `statementCadence` can return from
 * pathological data) over a four-year hole would otherwise walk 1,400 times.
 * The cap is a loop bound, not a display choice: a hole that hits it reports
 * the cap and its own day count, which is still true.
 */
export const MAX_CLOSES_PER_HOLE = 60;

/**
 * Periods that do not abut are a hole; periods that overlap are not.
 *
 * ⚠️ Abutting means `next.start === prev.end + 1 day`, which is how this app's
 * importers actually write them — Discover runs 2024-06-19→07-18 then
 * 07-19→08-18. Treating `next.start > prev.end` as the test would report a hole
 * between every consecutive pair.
 */
export function statementHoles(
  periods: readonly StatementPeriodRef[],
  cadence: StatementCadence,
): StatementHole[] {
  const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const holes: StatementHole[] = [];
  let covered: string | null = null;

  for (const period of sorted) {
    if (covered !== null && period.start > addDays(covered, 1)) {
      const from = addDays(covered, 1);
      const to = addDays(period.start, -1);
      holes.push({ from, to, days: diffDays(from, to) + 1, closes: closesWithin(from, to, cadence) });
    }
    // `covered` only ever moves FORWARD: an overlapping or nested period cannot
    // pull the frontier back and manufacture a hole behind itself
    if (covered === null || period.end > covered) covered = period.end;
  }
  return holes;
}

/**
 * How many closes the rhythm puts inside a window.
 *
 * Walks the account's own rhythm from the day before the hole rather than
 * dividing the day count by an assumed month. A 63-day hole is two monthly
 * statements or one bi-monthly one, and only the rhythm knows which.
 */
function closesWithin(from: string, to: string, cadence: StatementCadence): number | null {
  if (cadence.rhythm.kind === "unknown") return null;
  let at: string | null = addDays(from, -1);
  let count = 0;
  while (count < MAX_CLOSES_PER_HOLE) {
    at = nextCloseAfter(cadence.rhythm, at);
    if (at === null || at > to) break;
    /*
     * ⚠️ No "did it advance?" guard here, deliberately. `statementCadence`
     * documents that its `every-n-days` step cannot round below 1 ("a zero
     * step, which nextCloseAfter would never advance past, is unreachable"),
     * both monthly arms step by calendar months, and `MAX_CLOSES_PER_HOLE`
     * bounds the loop regardless. A second guard for the same impossibility
     * would be a branch no input could reach.
     */
    count += 1;
  }
  return count === 0 ? null : count;
}
