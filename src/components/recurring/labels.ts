import { isoWeekday } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { Cadence, SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Semimonthly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

export const KIND_LABEL: Record<SeriesKind, string> = {
  income: "Income",
  bill: "Bill",
  subscription: "Subscription",
  transfer: "Transfer",
  other: "Other",
};

export const STATUS_LABEL: Record<SeriesStatus, string> = {
  detected: "Detected",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
  ended: "Ended",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "2026-07-01" → "July 2026" */
export function monthLabel(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  return `${MONTH_NAMES[month - 1]} ${isoDate.slice(0, 4)}`;
}

/** "2026-07-16" → "Jul 16" */
export function shortDate(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  return `${MONTH_NAMES[month - 1]!.slice(0, 3)} ${Number(isoDate.slice(8, 10))}`;
}

/** "2026-07-16" → "Jul 16, 2026" */
export function longDate(isoDate: string): string {
  return `${shortDate(isoDate)}, ${isoDate.slice(0, 4)}`;
}

/** 12 → "12th", 21 → "21st" — English ordinal for the cadence sentence. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** Day-of-month ("the 15th") from an ISO date, for the "around the" token. */
export function ordinalDayOf(isoDate: string): string {
  return ordinal(Number(isoDate.slice(8, 10)));
}

// isoWeekday is Monday-based (0=Mon … 6=Sun)
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Weekday name ("Friday") from an ISO date, for weekly/biweekly cadences. */
export function weekdayNameOf(isoDate: string): string {
  return WEEKDAY_NAMES[isoWeekday(isoDate)]!;
}

/** Cadences that recur on a fixed weekday rather than a fixed day-of-month. */
export function isWeekdayCadence(cadence: Cadence): boolean {
  return cadence === "weekly" || cadence === "biweekly";
}

/**
 * The schedule phrase for the cadence sentence — a weekly charge drifts across
 * the month, so day-of-month ("the 1st") is meaningless for it; weekday is the
 * stable descriptor. Monthly-family cadences keep the day-of-month.
 */
export function schedulePhrase(cadence: Cadence, nextExpectedOn: string): { connective: string; token: string } {
  return isWeekdayCadence(cadence)
    ? { connective: "on", token: `${weekdayNameOf(nextExpectedOn)}s` }
    : { connective: "around the", token: ordinalDayOf(nextExpectedOn) };
}

/**
 * The verb an editable cadence sentence opens with, by series kind — and by
 * whether the series is still running.
 *
 * 🔴 It was present tense for every status. Measured 2026-09-10: all 27 ended
 * or dismissed series read "charges monthly around the 8th, about $1,786.46
 * from Chase Checking" above their own "nothing more is expected from it".
 * `seriesIsOver` is the one place that decides, so the two sentences cannot
 * disagree about whether the series is over.
 *
 * ⛔ Past tense fixes the whole clause, not just the verb: "charged monthly
 * around the 8th" is true of a series that did, and stops the day-of-month —
 * read off a stale `next_expected_on` — reading as a date still to come.
 */
export function seriesVerb(kind: SeriesKind, over: boolean = false): string {
  if (kind === "income") return over ? "deposited" : "deposits";
  if (kind === "transfer") return over ? "moved" : "moves";
  return over ? "charged" : "charges";
}

/* ── staleness disclosure ──────────────────────────────────────────────────
   A stale series is still projected — see services/recurring.ts::upcomingOccurrences
   for why exclusion would be the dishonest option. These render the doubt. */

/** Terse age for the inline marker: "22d ago", "1d ago", "today". */
export function shortAgo(days: number): string {
  return days <= 0 ? "today" : `${days}d ago`;
}

/** The inline marker's text: "last seen 22d ago", or "never seen". */
export function staleLabel(s: SeriesStaleness): string {
  return s.daysSinceLastMatch === null ? "never seen" : `last seen ${shortAgo(s.daysSinceLastMatch)}`;
}

/**
 * The full disclosure: what the series expects, how old the newest matching
 * charge is, the threshold it passed, and that it is projected anyway. Used as
 * the marker's tooltip and as the footer's per-series line.
 */
export function stalenessSentence(s: SeriesStaleness): string {
  const expects = `expected about every ${Math.round(s.stepDays)} days`;
  if (s.lastMatchedOn === null || s.daysSinceLastMatch === null) {
    return `${expects}, but no charge has ever matched it — still projected, on the schedule alone`;
  }
  return `${expects}, but nothing has matched since ${longDate(s.lastMatchedOn)} — ${s.daysSinceLastMatch} days, past the ${Math.round(s.toleranceDays)}-day tolerance. Still projected: a late import looks exactly like a cancelled series, so this says which numbers rest on old evidence rather than dropping them.`;
}

/**
 * How much of one side's SCHEDULED money rests on evidence past tolerance,
 * phrased for the composition band. Null when none of it does — an always-on
 * "$0.00 running late" would train the eye to skip the one time it matters,
 * which is the same reason `StaleFooter` renders nothing when nothing is stale.
 *
 * ⛔ "all of it" is a separate sentence from the figure, and it earns its place
 * on this ledger: September's scheduled income is $4,188.00, every cent of it
 * from `Cash job (weekly pay)`, last matched 2026-06-05. Printing "$4,188.00
 * running late" beside a scheduled total of $4,188.00 makes the reader compare
 * two identical numbers to learn the thing that matters most about the card.
 *
 * ⚠️ Compares MAGNITUDES. The two figures are net-worth signed and always share
 * a sign within a side, so the comparison is safe either way — but writing it
 * on the magnitudes says out loud that this is a question about size, not about
 * direction.
 */
export function stalePartLabel(side: {
  fixedCents: number;
  fixedStaleCents: number;
  fixedStaleCount: number;
  fixedNeverChargedCents: number;
  fixedNeverChargedCount: number;
}): string | null {
  if (side.fixedStaleCount === 0 || side.fixedStaleCents === 0) return null;
  const stale = Math.abs(side.fixedStaleCents);
  const never = Math.abs(side.fixedNeverChargedCents);
  const late = stale - never;
  const whole = Math.abs(side.fixedCents);

  /*
   * 🔴 "$1,402.60 of it running late" over $1,338.74 that had never been
   * billed. Measured on the real ledger at today = 2026-09-01, September's
   * committed money out: $63.86 genuinely late (Amazon Prime, FPL) and
   * $1,338.74 never billed (car lease, car insurance, rent utilities, gym) —
   * and three of those four were not due yet. 95% of the money the card called
   * late had never been charged by a bank. The MONEY IN side on the same card
   * IS all late, so the two must be able to say different things.
   */
  const part = (cents: number, phrase: string): string =>
    cents === whole ? `all of it ${phrase}` : `${formatCents(cents)} of it ${phrase}`;
  if (never === 0) return part(late, "running late");
  if (late === 0) return part(never, "never billed");
  // both, and each named with its own figure — a reader can add them up
  return `${formatCents(late)} of it running late · ${formatCents(never)} never billed`;
}

/** One stale series, as the disclosure footer lists it. */
export interface StaleEntry {
  /** stable list key: a series id from the upcoming list, a label in the forecast */
  key: string;
  name: string;
  staleness: SeriesStaleness;
}

/**
 * What to call a set of stale entries in ONE summary line.
 *
 * ⛔ `isStale` covers two different facts — "the evidence is past tolerance" and
 * "there is no evidence at all" — and that union is right, because both mean the
 * projection rests on something other than a recent charge. What is not right is
 * calling them all LATE.
 *
 * 🔴 Measured on the real ledger at today = 2026-09-01 the footer read
 * "7 series are running late — still projected" over three that were and four
 * that had never charged: `Rent utilities & fees` (first due 2026-09-01),
 * `Car insurance` (2026-09-11), `Car lease` (2026-09-15) and `Gym`
 * (2026-09-22). Three of those are not late by any reading — they are due in
 * the FUTURE, and the lease's first payment was a fortnight away.
 *
 * The per-row text already distinguishes them — `stalenessSentence` has a
 * branch for each and the inline badge reads "never seen". Only the count that
 * stands over them did not.
 */
/**
 * 🔴 AND IT MUST NAME THE WINDOW IT COUNTED, because two of these sit on one
 * page over two different windows.
 *
 * Measured on the real ledger 2026-09-02, `/recurring` printed
 * "4 series are running late and **3** have never charged" over the September
 * forecast and "4 series are running late and **4** have never charged" under
 * the 30-day list, in the same words, a screen apart. Both were true: `Rent
 * utilities & fees` first falls due on 1 October, inside thirty days and
 * outside September. Nothing in either sentence said which set it had counted,
 * so the page contradicted itself about a fact a reader would take as one.
 *
 * The window leads the sentence rather than trailing it: "…and 3 have never
 * charged in September" would say they had never charged IN SEPTEMBER, which is
 * a different and weaker claim than the true one — they have never charged at
 * all.
 */
export function staleSummaryLabel(entries: readonly StaleEntry[], window: string): string {
  const never = entries.filter((e) => e.staleness.daysSinceLastMatch === null).length;
  const late = entries.length - never;
  const lateClause = `${late} ${late === 1 ? "series is" : "series are"} running late`;
  const neverClause = `${never} ${never === 1 ? "has" : "have"} never charged`;
  const body =
    never === 0
      ? `${lateClause} — still projected`
      : late === 0
        ? `${never} ${never === 1 ? "series has" : "series have"} never charged — still projected`
        : `${lateClause} and ${neverClause} — all still projected`;
  return `${window}, ${body}`;
}

/**
 * One entry per stale SERIES, not per occurrence — a weekly series contributes
 * four rows to a 30-day window and would otherwise be named four times. The
 * first occurrence wins; every occurrence of a series shares its staleness.
 */
export function staleOccurrenceEntries(occurrences: readonly SeriesOccurrence[]): StaleEntry[] {
  const bySeries = new Map<string, StaleEntry>();
  for (const o of occurrences) {
    if (!o.staleness?.isStale || bySeries.has(o.seriesId)) continue;
    bySeries.set(o.seriesId, { key: o.seriesId, name: o.name, staleness: o.staleness });
  }
  return [...bySeries.values()];
}

/**
 * The fixed forecast components still projecting on evidence past tolerance.
 * Keyed by label because that is a fixed component's identity, and DEDUPED on
 * it: since the forecast grew an arrears leg a single series can contribute two
 * components to one month — what came due on the 1st and never posted, and what
 * falls due again on the 8th. The footer counts SERIES, so one name is one
 * entry. Order follows the components array, so the footer reads like the table.
 */
export function staleComponentEntries(components: readonly ForecastComponent[]): StaleEntry[] {
  const entries: StaleEntry[] = [];
  const seen = new Set<string>();
  for (const c of components) {
    if (!c.staleness?.isStale || seen.has(c.label)) continue;
    seen.add(c.label);
    entries.push({ key: c.label, name: c.label, staleness: c.staleness });
  }
  return entries;
}

/**
 * What the table's Next column says about a charge that came due inside this
 * calendar month and that no posting covers.
 *
 * 🔴 `/recurring?tab=all` on 2026-09-04 said both of these on ONE screen:
 *
 *     the math table   "1 × -$2,109.00 (monthly), came due 2026-09-01 and has
 *                       not posted"
 *     the Next column  "Oct 1", under a section headed "Active — charged within
 *                       their cadence, and forecast"
 *
 * and the same for "Rent utilities & fees". `nextExpectedOn` walks FORWARD from
 * today by construction, so the backward half is invisible to it — the exact
 * defect the bill's own page had until 2026-09-04, one surface over. The date
 * comes from `overdueForSeries`, the same call the forecast, the runway, the
 * budgets header and `/recurring/<id>` all make.
 *
 * ⚠️ The Next date stays. October's charge is still coming; what was missing is
 * that September's never arrived.
 */
export function overdueNote(date: string, occurrenceCount: number): string {
  const more = occurrenceCount > 1 ? ` and ${occurrenceCount - 1} more` : "";
  return `${shortDate(date)}${more} — not posted`;
}

/**
 * Where the postings' SPREAD belongs when the headline is not their centre.
 *
 * 🔴 `Per charge` printed the FORECAST amount with the postings' sample sd
 * beside it — a ± around a number that is not what it measures. The forecast
 * amount is often entered by hand: measured on the owner's ledger 2026-09-08,
 * `/recurring/<Flamingo South Beach (rent)>` read "-$2,109.00 ± 610.65" over
 * four charges averaging -$1,739.40, `<Cash job (weekly pay)>` "+$1,047.00 ±
 * 457.50" over $400.00 and $1,047.00, and `<Breezeline (internet)>` "-$50.00 ±
 * 5.59" over three averaging -$46.77. A reader takes "1,047.00 ± 457.50" as a
 * range the charges fall in, and neither of those two does.
 *
 * ⛔ THE HEADLINE STAYS THE FORECAST FIGURE. It is what the forecast projects
 * and what ANNUALIZED is built from — the same reason the All tab keeps it. The
 * average is named UNDER it, carrying the ±, exactly as that tab already prints
 * the pair. Owner's decision, 2026-09-08.
 *
 * ⚠️ When the two agree there is only one number, so the ± stays attached to
 * the headline and no sub-line is drawn — a row repeating a figure it has just
 * printed is noise, and every fixture series is in this state.
 */
export interface PostedSpreadReading {
  /** the ± figure, already formatted to two places; null when there is none */
  text: string | null;
  /** true when the ± hangs off the headline because it IS the postings' mean */
  attachedToHeadline: boolean;
  /** the average to name on its own line, or null when there is nothing to add */
  avgLine: number | null;
}

export function postedSpreadReading(
  headlineCents: number | null,
  postedAvgCents: number | null,
  postedStddevCents: number | null,
): PostedSpreadReading {
  const text =
    postedStddevCents !== null && postedStddevCents > 0
      ? (postedStddevCents / 100).toFixed(2)
      : null;
  // nothing linked, or a headline that IS the measured centre: one number
  if (postedAvgCents === null || postedAvgCents === headlineCents) {
    return { text, attachedToHeadline: text !== null, avgLine: null };
  }
  return { text, attachedToHeadline: false, avgLine: postedAvgCents };
}
