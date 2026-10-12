import { addDays, diffDays } from "./dates";
import { nextCloseAfter, type StatementCadence, type StatementRhythm } from "./statement-cadence";

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
   * 30-day assumption would be a number nobody measured — and when an
   * every-n-days rhythm puts no close in it; never null on a monthly cycle,
   * where a window ends at a close (`closesWithin`).
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
 *
 * ⛔ `periods` are STATEMENTS — `statementsByAccount`'s rows, never a document that
 * printed no balances. A Chase Spending Report spans many cycles: the frontier
 * jumped to its end, so every statement missing under it read as covered, and a
 * hole after it opened on a day no statement closed (`closesWithin` walks from
 * that day). The review, 2026-10-08, on a copy of the owner's ledger. The one
 * exception is an opening statement that printed no OPENING (Robinhood's first):
 * a statement, so the walk starts from it and a month missing right after it is a
 * hole — Robinhood Agentic's July, lost when it was left out (the same day).
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
 * Half a monthly cycle. A step of a hole's walk is a close of its own only when it lands MORE than this
 * before `to` (`closesWithin`): a walk that sits off the real closes puts one step about a month before `to`
 * and the next about on it, and half a cycle each way is as far off as it may sit and still tell the two
 * apart. A step exactly half a cycle off is as near `to` as the close a month before it, and goes with `to`.
 *
 * 🔴 Strictly more, measured on his ledger copy 2026-10-12: Discover's move from the 18th to the 2nd puts a
 * walk on the 18th fifteen days before every close on the 2nd (May 18 → Jun 2), and counted on their own
 * those steps put 4 statements in a hole that holds 3. Dropping every run of one to eight statements of every
 * account makes 1,590 holes: counted on or before half a cycle, 25 miscount; walked to `to` plus the wander,
 * 13; this way 5 — all five shared with the wander walk, and none on a monthly cycle (three every-n-days
 * rhythms, two windows with no rhythm at all).
 */
const HALF_A_CYCLE_DAYS = 15;

/**
 * How many closes the rhythm puts inside a window.
 *
 * Walks the account's own rhythm from the day before the hole rather than
 * dividing the day count by an assumed month. A 63-day hole is two monthly
 * statements or one bi-monthly one, and only the rhythm knows which.
 *
 * ⛔ A hole is bounded by two CLOSES: the day before it ends the last statement
 * imported, and `to` ends the last one missing, because the next imported period
 * starts the day after it. So a day-of-month cycle is walked on the day of the
 * close that OPENED the hole — the cycle in force then, read from the hole itself.
 *
 * 🔴 Why the day comes from the hole: the walk stepped on today's day, which a
 * moved cycle makes wrong for every hole before the move. Measured by a second
 * reader on a copy of the owner's ledger, 2026-10-08: once Capital One's closes
 * on the 9th fill Discover's twelve-close window (the May 2027 import), its 2025
 * hole (Jul 2 → Sep 2, two statements on the 2nd) walked Jul 2 → Aug 9 → Sep 9,
 * past its end, and Missing statements read 4 for 5. Asking the cadence for the
 * old day instead (`rhythmOn`, 2026-10-08) worked only while the old closes were
 * still inside the window — a special case with an expiry date.
 *
 * ⛔ And on a monthly cycle `to` counts ITSELF: the walk counts only the closes it
 * puts more than HALF_A_CYCLE_DAYS before `to`, and the close at `to` is one more.
 * A walk on the opening close's day is as late, or as early, as that close was on
 * every step, so asking a step to land on `to` asks both ends of the hole to sit
 * on the same day — and they need not. 🔴 Three times it went wrong, each fixed
 * for its own case first:
 *
 *   - Chase Checking's cycle lands on the 10th–13th, and Sep 13 → Nov 10, 2022 is
 *     two statements: walked on the 13th the second step is Nov 13, three days
 *     past the end. Counting the rhythm's own days inside the window is wrong the
 *     other way — Dec 10, 2025 → Jan 13 is one statement, and the 11th falls in it
 *     twice. Removing each of its real statements, and each adjacent pair, the
 *     walk to `to` miscounted 30 of the 91 holes and counting the rhythm's days
 *     45, so the last step was given the cycle's wander past `to`.
 *   - Once a late close is no longer the newest, the trim drops it from the
 *     wander: given Capital One's Oct 9, Nov 9, a late Dec 13 and Jan 9 never
 *     imported, the hole Dec 14 → Jan 9 walked to Jan 13 and read no count. The
 *     floor that followed (75e4353) counted one where the walk found none…
 *   - …and with Feb 9 missing too, two still read one: Jan 13 counted, Feb 13 past
 *     Feb 9 + 2. Measured by the review on a copy of his ledger, 2026-10-12:
 *     "58 days, 1 statement" and "6 statements · 210 days" for 7, beside a
 *     schedule reading "closes around the 9th". A hole that ends at an EARLY close
 *     did the same — Oct 10 → Dec 5, holding Nov 9 and Dec 5, read one — and had
 *     before any of the three.
 *
 * As his ledger stands every hole reads as before, and so does the e2e fixture's.
 * Discover's real periods followed by a year of Capital One closes on the 9th, one
 * of them two to six days late or two to four early, with every run of one to
 * three of them dropped, make 2,880 holes, and every one counts what was dropped —
 * the wander walk miscounted 82 of them, and before its floor (75e4353) 154.
 *
 * An every-n-days rhythm is no such bound — 107 days measured across missing
 * monthly statements puts none in a 60-day hole that holds two — so it is walked
 * to `to` itself, and a hole it misses stays uncounted. Nor is its tolerance ever
 * given to the walk: a spread of GAPS, on an irregular account wide enough to
 * invent a statement in a window its rhythm puts none in.
 */
function closesWithin(from: string, to: string, cadence: StatementCadence): number | null {
  if (cadence.rhythm.kind === "unknown") return null;
  const opening = addDays(from, -1);
  if (cadence.rhythm.kind === "every-n-days") {
    const count = stepsThrough(cadence.rhythm, opening, to, MAX_CLOSES_PER_HOLE);
    return count === 0 ? null : count;
  }
  const rhythm: StatementRhythm =
    cadence.rhythm.kind === "day-of-month"
      ? { kind: "day-of-month", day: Number(opening.slice(8, 10)) }
      : cadence.rhythm;
  // the closes MORE than half a cycle before `to`, then `to`'s own — within the bound every walk keeps
  return stepsThrough(rhythm, opening, addDays(to, -HALF_A_CYCLE_DAYS - 1), MAX_CLOSES_PER_HOLE - 1) + 1;
}

/** How many steps of `rhythm` after `from` land on or before `last` — at most `cap` of them. */
function stepsThrough(rhythm: StatementRhythm, from: string, last: string, cap: number): number {
  let at: string | null = from;
  let count = 0;
  while (count < cap) {
    at = nextCloseAfter(rhythm, at);
    if (at === null || at > last) break;
    /*
     * ⚠️ No "did it advance?" guard here, deliberately. `statementCadence`
     * documents that its `every-n-days` step cannot round below 1 ("a zero
     * step, which nextCloseAfter would never advance past, is unreachable"),
     * both monthly arms step by calendar months, and `cap` (MAX_CLOSES_PER_HOLE
     * at most) bounds the loop regardless. A second guard for the same
     * impossibility would be a branch no input could reach.
     */
    count += 1;
  }
  return count;
}
