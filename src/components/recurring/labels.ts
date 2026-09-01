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

/** The verb an editable cadence sentence opens with, by series kind. */
export function seriesVerb(kind: SeriesKind): string {
  return kind === "income" ? "deposits" : kind === "transfer" ? "moves" : "charges";
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
}): string | null {
  if (side.fixedStaleCount === 0 || side.fixedStaleCents === 0) return null;
  const stale = Math.abs(side.fixedStaleCents);
  return stale === Math.abs(side.fixedCents)
    ? "all of it running late"
    : `${formatCents(stale)} of it running late`;
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
export function staleSummaryLabel(entries: readonly StaleEntry[]): string {
  const never = entries.filter((e) => e.staleness.daysSinceLastMatch === null).length;
  const late = entries.length - never;
  const lateClause = `${late} ${late === 1 ? "series is" : "series are"} running late`;
  const neverClause = `${never} ${never === 1 ? "has" : "have"} never charged`;
  if (never === 0) return `${lateClause} — still projected`;
  if (late === 0) {
    return `${never} ${never === 1 ? "series has" : "series have"} never charged — still projected`;
  }
  return `${lateClause} and ${neverClause} — all still projected`;
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
 * Keyed by label because that is a fixed component's identity (one per series).
 * Order follows the components array, so the footer reads like the table.
 */
export function staleComponentEntries(components: readonly ForecastComponent[]): StaleEntry[] {
  const entries: StaleEntry[] = [];
  for (const c of components) {
    if (c.staleness?.isStale) entries.push({ key: c.label, name: c.label, staleness: c.staleness });
  }
  return entries;
}
