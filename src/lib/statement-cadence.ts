import { addCalendarMonths, addDays, compareDates, diffDays, periodBounds } from "./dates";
import { formatDayShort } from "./format-date";

/**
 * When the next statement is due, derived from the account's OWN statement
 * history rather than from an assumption that everything is monthly.
 *
 * Every close date this reads is a fact printed on a statement, so the rhythm
 * is measured, not configured: four of the real ledger's accounts close on the
 * LAST DAY of the month (SoFi ×2, Robinhood Cash, Robinhood Crypto), three
 * close on a fixed day-of-month (Discover the 2nd, Chase Sapphire the 2nd,
 * Venture X the 14th), and Chase Checking wanders across the 10th–13th because
 * its cycle lands on a business day.
 *
 * ⛔ This is a PULL REMINDER, not a defect report. An account going quiet
 * between monthly downloads is the normal state of this ledger — the app has
 * always been right to keep projecting through it. What was missing is the
 * flip side: nothing said which statement is now sitting on the bank's website
 * waiting to be fetched.
 */

/** The evidence bar for calling a rhythm — the same one recurring detection uses. */
export const MIN_CLOSES = 3;

/** A gap between closes inside this band reads as a monthly cycle. */
export const MONTHLY_GAP_MIN = 26;
export const MONTHLY_GAP_MAX = 35;

/**
 * Only the most recent year of closes decides the rhythm.
 *
 * A cycle CHANGES, and old closes then describe an account that no longer
 * exists. Measured: Discover's 28 closes run from 2023-11-18, and it has billed
 * on the 18th, then the 2nd, and — since Capital One took the portfolio over —
 * the 9th. The median across all of them is **the 14th**, a day the account has
 * never once closed on, carrying a 13-day tolerance to span the two clusters.
 * Twelve closes is one year: long enough to be a rhythm, short enough that a
 * changed cycle takes over within a year instead of never.
 */
export const RECENT_CLOSES = 12;

/**
 * One day for the bank to publish. A close date is when the cycle ENDS; the PDF
 * appears shortly after, and no statement in the archive records when it became
 * downloadable, so this is the smallest honest allowance rather than a measured
 * lag. It rides on top of the observed wander, never instead of it.
 */
export const PUBLISH_SLACK_DAYS = 1;

/**
 * A missed-statement count stops here. A dormant account can be years behind,
 * and walking it close by close would be a loop bounded only by the calendar;
 * past three years the exact number stops being the useful part of the message.
 */
export const MAX_TRACKED_CLOSES = 36;

export type StatementRhythm =
  /** every observed close is its own month's last day */
  | { readonly kind: "month-end" }
  /** closes on (or within tolerance of) the same day each month */
  | { readonly kind: "day-of-month"; readonly day: number }
  /** regular, but not monthly — a quarterly or annual statement */
  | { readonly kind: "every-n-days"; readonly days: number }
  /** too few closes, or no rhythm worth predicting from */
  | { readonly kind: "unknown" };

export interface StatementCadence {
  readonly rhythm: StatementRhythm;
  /** observed wander in the close date, plus PUBLISH_SLACK_DAYS */
  readonly toleranceDays: number;
  /** how many closes the rhythm was measured from */
  readonly closes: number;
}

export type PullStatus =
  /** no rhythm to predict from — the app says so rather than guessing */
  | "unknown"
  /** the next close has not happened yet */
  | "waiting"
  /** one close has passed: a statement should be downloadable */
  | "due"
  /** two or more have passed */
  | "behind";

export interface StatementPull {
  readonly cadence: StatementCadence;
  readonly lastCloseOn: string | null;
  readonly daysSinceLastClose: number | null;
  /** the next close date the rhythm predicts; null when the rhythm is unknown */
  readonly expectedOn: string | null;
  /** expected closes already past (capped at MAX_TRACKED_CLOSES) */
  readonly closesDue: number;
  /** true once closesDue hit the cap — the count is a floor, not a measurement */
  readonly capped: boolean;
  readonly status: PullStatus;
  /** days since the FIRST unpulled close became available; 0 when none is */
  readonly daysLate: number;
}

function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

function isMonthEnd(iso: string): boolean {
  return periodBounds(iso, "monthly").end === iso;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The largest deviation once the single worst HISTORICAL observation is
 * dropped. `deviations` must be in chronological order; the last element is the
 * newest close.
 *
 * A trimmed maximum, because one outlier is not a rhythm and the untrimmed
 * maximum lets it set the tolerance for every future month. Measured on the
 * real ledger: Chase Sapphire closed on the 2nd seven times and once on the
 * 10th, and the raw maximum would have held its reminder back eight days every
 * month thereafter. Below five observations there is not enough to trim.
 *
 * ⛔ THE NEWEST CLOSE IS NEVER THE ONE TRIMMED, and that is the whole
 * refinement. A permanent change of cycle looks EXACTLY like a single outlier
 * in the month it happens — it is one close in the wrong place — so trimming
 * the largest deviation blindly erases the only evidence that anything moved.
 *
 * 🔴 Measured on the real ledger: `Discover` is issued by Capital One now and
 * its August 2026 statement closed on the 9th after eleven closes on the 2nd.
 * The trim dropped that 7-day deviation, leaving `toleranceDays = 1` — removing
 * the newest close from the input entirely produced the IDENTICAL rhythm and
 * tolerance, which is what "contributes nothing" means. /imports then read
 * "Ready to pull" from 2026-09-03, six days before the statement exists, every
 * month until enough new closes move the median.
 *
 * ⚠️ The cost, stated: a genuinely one-off late close now holds the reminder
 * back by its own lateness — for exactly ONE cycle, until it stops being the
 * newest. The old rule's cost was six months of a wrong reminder for a real
 * change. A historical outlier is still trimmed, so the case this function was
 * written for is unaffected: Chase Sapphire keeps `toleranceDays = 9`.
 *
 * Never called with an empty list: every caller is past the MIN_CLOSES = 3 bar,
 * which leaves at least two gaps and three days-of-month, so trimming one still
 * leaves something to take a maximum of.
 */
function trimmedMaxDeviation(deviations: readonly number[]): number {
  const newest = deviations.at(-1)!;
  const older = [...deviations.slice(0, -1)].sort((a, b) => a - b);
  const kept = deviations.length >= 5 ? older.slice(0, -1) : older;
  return Math.max(newest, kept.at(-1) ?? 0);
}

/**
 * `closeDates` are the period-end dates of real statements, any order.
 * Duplicates and non-statement documents (a spending report covering
 * 2026-01-01 → 2026-07-10) must be filtered out by the caller — they are not
 * closes and would wreck the rhythm.
 */
export function statementCadence(closeDates: readonly string[]): StatementCadence {
  const ends = [...new Set(closeDates)].sort().slice(-RECENT_CLOSES);
  if (ends.length < MIN_CLOSES) {
    return { rhythm: { kind: "unknown" }, toleranceDays: PUBLISH_SLACK_DAYS, closes: ends.length };
  }

  const gaps: number[] = [];
  for (let i = 1; i < ends.length; i++) gaps.push(diffDays(ends[i - 1]!, ends[i]!));
  const medianGap = median(gaps);

  if (medianGap < MONTHLY_GAP_MIN || medianGap > MONTHLY_GAP_MAX) {
    // regular but not monthly, or not regular at all — a median gap is still the
    // best available prediction, and stating it lets the reader judge it
    // `ends` is deduped and ascending, so every gap is at least one day and the
    // median cannot round below 1 — a zero step, which nextCloseAfter would
    // never advance past, is unreachable rather than guarded against.
    const days = Math.round(medianGap);
    const spread = trimmedMaxDeviation(gaps.map((g) => Math.abs(g - medianGap)));
    return {
      rhythm: { kind: "every-n-days", days },
      toleranceDays: Math.round(spread) + PUBLISH_SLACK_DAYS,
      closes: ends.length,
    };
  }

  if (ends.every(isMonthEnd)) {
    // deterministic: the last day of a month needs no tolerance of its own
    return { rhythm: { kind: "month-end" }, toleranceDays: PUBLISH_SLACK_DAYS, closes: ends.length };
  }

  const days = ends.map(dayOfMonth);
  const day = Math.round(median(days));
  const spread = trimmedMaxDeviation(days.map((d) => Math.abs(d - day)));
  return {
    rhythm: { kind: "day-of-month", day },
    toleranceDays: spread + PUBLISH_SLACK_DAYS,
    closes: ends.length,
  };
}

function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * The first close after `after`, or null when there is no rhythm.
 *
 * The monthly arms step by CALENDAR months and never by 30 days, for the reason
 * pass 51 established: a day-stepped walk drags a month-end cycle off the end of
 * the month and eventually puts two closes in one 31-day month, or none in
 * February.
 */
export function nextCloseAfter(rhythm: StatementRhythm, after: string): string | null {
  switch (rhythm.kind) {
    case "unknown":
      return null;
    case "every-n-days":
      return addDays(after, rhythm.days);
    case "month-end":
      // the last day of the month AFTER this one, whatever length it is
      return periodBounds(addCalendarMonths(firstOfMonth(after), 1), "monthly").end;
    case "day-of-month": {
      const nextMonth = addCalendarMonths(firstOfMonth(after), 1);
      const lastDay = dayOfMonth(periodBounds(nextMonth, "monthly").end);
      return `${nextMonth.slice(0, 7)}-${String(Math.min(rhythm.day, lastDay)).padStart(2, "0")}`;
    }
  }
}

/**
 * The whole reminder for one account: what its rhythm is, when the next
 * statement closes, and how many have closed without being pulled.
 */
export function statementPull(
  closeDates: readonly string[],
  today: string,
): StatementPull {
  const cadence = statementCadence(closeDates);
  const ends = [...new Set(closeDates)].sort();
  const lastCloseOn = ends.at(-1) ?? null;
  const daysSinceLastClose = lastCloseOn ? diffDays(lastCloseOn, today) : null;

  if (!lastCloseOn || cadence.rhythm.kind === "unknown") {
    return {
      cadence,
      lastCloseOn,
      daysSinceLastClose,
      expectedOn: null,
      closesDue: 0,
      capped: false,
      status: "unknown",
      daysLate: 0,
    };
  }

  const expectedOn = nextCloseAfter(cadence.rhythm, lastCloseOn)!;
  let cursor = expectedOn;
  let closesDue = 0;
  let firstDue: string | null = null;
  // a close counts as pullable only once its own wander has elapsed too
  while (closesDue < MAX_TRACKED_CLOSES && compareDates(addDays(cursor, cadence.toleranceDays), today) <= 0) {
    closesDue += 1;
    firstDue ??= cursor;
    cursor = nextCloseAfter(cadence.rhythm, cursor)!;
  }

  return {
    cadence,
    lastCloseOn,
    daysSinceLastClose,
    expectedOn,
    closesDue,
    capped: closesDue === MAX_TRACKED_CLOSES,
    status: closesDue === 0 ? "waiting" : closesDue === 1 ? "due" : "behind",
    daysLate: firstDue ? diffDays(firstDue, today) : 0,
  };
}

/* ── the words ────────────────────────────────────────────────────────────
   Here rather than in the panel for the reason pass 50 established for the
   budget verdict: the e2e fixture renders `waiting` on every one of its seven
   accounts, so `due` and `behind` — the two states this whole feature exists
   for — cannot be exercised by any Playwright run. `src/lib/**` is under the
   100%-branch gate, which forces each of them to execute. The component keeps
   only its colours. */

function ordinalDay(day: number): string {
  const teen = day >= 11 && day <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "closes around the 2nd, from 12 statements" — the evidence, stated. */
export function rhythmPhrase(cadence: StatementCadence): string {
  const from = `from ${plural(cadence.closes, "statement")}`;
  switch (cadence.rhythm.kind) {
    case "month-end":
      return `closes on the last day of the month, ${from}`;
    case "day-of-month":
      return `closes around the ${ordinalDay(cadence.rhythm.day)}, ${from}`;
    case "every-n-days":
      return `closes about every ${plural(cadence.rhythm.days, "day")}, ${from}`;
    case "unknown":
      return cadence.closes === 0
        ? "no statements imported yet"
        : `only ${plural(cadence.closes, "statement")} — not enough to call a cycle`;
  }
}

/**
 * What is OUTSTANDING, with no history attached — the dashboard teaser's line,
 * and the second half of the full sentence below, so the two can never word the
 * same fact differently.
 *
 * null when nothing has closed. A quiet account makes no demand: silence between
 * monthly uploads is this ledger's normal state, and only a close that has
 * already HAPPENED is late — and then it is the statement that is late, not the
 * account. Nothing here ever says "overdue".
 */
export function pullDemand(pull: StatementPull): string | null {
  switch (pull.status) {
    case "unknown":
    case "waiting":
      return null;
    case "due":
      return `one closed ${plural(pull.daysLate, "day")} ago, not imported`;
    case "behind": {
      const count = pull.capped ? `${pull.closesDue}+` : String(pull.closesDue);
      return `${count} closed since, the oldest ${plural(pull.daysLate, "day")} ago`;
    }
  }
}

/** The full row on /imports: what we know, then what to do about it. */
export function pullSentence(pull: StatementPull): string {
  const since =
    pull.lastCloseOn === null || pull.daysSinceLastClose === null
      ? "nothing imported yet"
      : `last one closed ${formatDayShort(pull.lastCloseOn)}, ${plural(pull.daysSinceLastClose, "day")} ago`;

  const demand = pullDemand(pull);
  if (demand) return `${since} · ${demand}`;
  // expectedOn is non-null for every status except `unknown`
  return pull.status === "unknown" ? since : `${since} · next closes ${formatDayShort(pull.expectedOn!)}`;
}
