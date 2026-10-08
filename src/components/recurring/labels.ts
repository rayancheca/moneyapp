import { addCalendarMonths, compareDates, diffDays, isoWeekday } from "@/lib/dates";
import { endsInsideHorizon } from "@/lib/committed";
import { dayWindowLabel } from "@/lib/period";
import { wholeToleranceDays } from "@/lib/recurring-step";
import { formatCents } from "@/lib/money";
import type { UnsettledReason } from "@/lib/occurrence-verdict";
import { ONE_CHARGE_WORD } from "@/lib/one-charge";
import type { PerPayday } from "@/lib/per-payday";
import { SERIES_EVIDENCE_LABEL } from "@/lib/series-evidence";
import type { Cadence, SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";
import type { MergeFiling, MergeResult } from "@/services/recurring-links";

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Semimonthly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

/**
 * The cadence slot's word — "Once" for a series whose whole schedule holds one charge (`oneChargeOn`, the day of it,
 * from `oneChargeDays`), and `CADENCE_LABEL` for every other.
 *
 * ⚖️ Owner decision 2026-10-08 (§6A 56). 🔴 The Nov 11 car-insurance balance — next and last day both Nov 11 — read
 * "Cadence Monthly" on its own page and "Monthly" in the All tab, because it is STORED monthly: a cadence is the step
 * the walk takes, and a schedule of one charge never takes one.
 */
export function cadenceLabel(cadence: Cadence, oneChargeOn: string | null): string {
  return oneChargeOn === null ? CADENCE_LABEL[cadence] : capitalize(ONE_CHARGE_WORD);
}

function capitalize(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

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

/**
 * "2026-07-16" → "Jul 16, 2026" — this surface's name for the app-wide rule.
 *
 * ⛔ DELEGATES, rather than spelling it a second time. `dayWindowLabel(d, d)` is
 * the one-ended case of the window rule six surfaces already read, and this
 * function produced the byte-identical string from its own arithmetic. One
 * batch of fixes used both names for one string; there is one implementation
 * now, and the 14 callers here keep the vocabulary their file owns.
 */
export function longDate(isoDate: string): string {
  return dayWindowLabel(isoDate, isoDate);
}

/**
 * A future date, named so it cannot be read as a past one — the year rides
 * along only when it differs from today's, the way every other label in this
 * app drops what repeats.
 *
 * 🔴 An ANNUAL commitment's "Next" is next year, and `shortDate` never prints a
 * year. Measured 2026-09-10 — all three annual series carry a 2027 date whose
 * day-and-month is EXACTLY the day they last charged in 2026:
 *
 *     Venture X annual fee    next 2027-01-16, last matched 2026-01-16
 *     Chase Sapphire annual   next 2027-03-01, last matched 2026-03-01
 *     HBO Max                 next 2027-07-18, last matched 2026-07-18
 *
 * so "Next: Jan 16" reads as 237 days AGO. Every other Next cell in the same
 * table ("Sep 11", "Oct 1", "Oct 8") really is this year, and nothing on the
 * row disambiguates.
 */
export function futureDateLabel(isoDate: string, today: string): string {
  return isoDate.slice(0, 4) === today.slice(0, 4) ? shortDate(isoDate) : longDate(isoDate);
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
 * `seriesIsProjected` is the one place that decides, so the two sentences
 * cannot disagree about whether the series is over — and a lapsed series, which
 * the forecast has let go, reads "charged" too (2026-10-08, Amazon Prime).
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

/**
 * The inline marker's text: "last seen 22d ago", or "never billed".
 *
 * 🔴 It said "never seen". Measured on the real ledger 2026-09-15, `/recurring`
 * badged Car lease, Gym and Rent utilities & fees "never seen" on the Upcoming
 * list and in the forecast's math table, while the calendar under the same
 * forecast card read "Car lease upcoming (scheduled, never billed)" and the All
 * tab filed them under "Never billed". The owner chose that word on 2026-09-14
 * — `SERIES_EVIDENCE_LABEL`, through `upcomingEvidenceWord`, not a third
 * spelling of it.
 */
export function staleLabel(s: SeriesStaleness): string {
  return s.daysSinceLastMatch === null
    ? SERIES_EVIDENCE_LABEL["never-billed"].toLowerCase()
    : `last seen ${shortAgo(s.daysSinceLastMatch)}`;
}

/**
 * The marker's tone. A bill the bank has not charged yet is NOT a warning —
 * the calendar's Day Sheet already says so ("nothing is late about a bill the
 * bank has not charged yet") — and the Upcoming list badged the car lease in
 * warning amber on the morning of its first payment.
 */
export function staleMarkTone(s: SeriesStaleness): "warning" | "neutral" {
  return staleIsLate(s) ? "warning" : "neutral";
}

/**
 * Late in the only sense that warns: it has charged, and its evidence ran past tolerance on days the ledger has
 * checked. ⛔ Never billed is not late (above), and neither is awaiting statements (`seriesStaleness`): 🔴 his pay
 * read "last seen 14d ago" in amber for a payday on a day Wells Fargo had not been checked through (2026-10-08).
 */
function staleIsLate(s: SeriesStaleness): boolean {
  return s.isStale && s.daysSinceLastMatch !== null;
}

/** Past tolerance today, not by its accounts' checked day: it cannot be called late yet (`seriesStaleness`). */
function staleIsAwaiting(s: SeriesStaleness): boolean {
  return s.awaitingStatements && s.daysSinceLastMatch !== null;
}

/** The footer is a warning only when at least one of its series is actually late. */
export function staleFooterIsWarning(entries: readonly StaleEntry[]): boolean {
  return entries.some((e) => staleIsLate(e.staleness));
}

/**
 * What the collapsed footer says it explains.
 *
 * 🔴 "why these numbers rest on old evidence", under "4 series are running late
 * and 3 have never charged" — measured on the real ledger 2026-09-15. A series
 * nothing has ever matched has no evidence to be OLD; `stalenessSentence` says
 * it is "still projected, on the schedule alone", and so does this.
 */
/**
 * 🔴 AND IT NAMES EVERY KIND THE LIST HOLDS. Awaiting statements reached its own words only when nothing else was in
 * the list: on his ledger copy (2026-10-08) the Upcoming footer read "3 series have never been billed and 3 have not
 * been looked for yet" over "why these numbers rest on the schedule alone" — false of the pay, FPL and Rocket Money,
 * which rest on Sep 24, Jul 28 and Jul 15 evidence.
 */
export function staleFooterHint(entries: readonly StaleEntry[]): string {
  const late = staleFooterIsWarning(entries);
  const never = entries.some((e) => e.staleness.daysSinceLastMatch === null);
  const awaiting = entries.some((e) => staleIsAwaiting(e.staleness));
  let rests: string | null = null;
  if (late && never) rests = "rest on old evidence or on the schedule alone";
  else if (late) rests = "rest on old evidence";
  else if (never) rests = "rest on the schedule alone";
  // ⛔ awaiting statements rests on nothing old — its tolerance runs out on unchecked days (`stalenessSentence`)
  if (rests === null) return "why these cannot be called late yet";
  return awaiting ? `why these numbers ${rests}, and why some cannot be called late yet` : `why these numbers ${rests}`;
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
  /*
   * ⛔ Awaiting statements: the age is a fact, "past the tolerance" is not a finding — the tolerance runs out on days
   * nobody has checked. The checked day is named, in the passed-payday sentence's words, with how much of the
   * tolerance it covers, so the claim can be checked.
   *
   * 🔴 It said "so the ledger has not looked for the next one yet", which is false once a statement covers the due day
   * but not the end of the grace: the real Breezeline row (2026-10-08 copy), due Oct 11, checked through Oct 13 — and
   * of his pay checked through Oct 2, beside a passed-payday sentence counting Oct 1 as read. And "its account" of a
   * series that posts to several. What is true on both sides of the due day: it cannot be called late yet.
   */
  if (s.awaitingStatements) {
    const tolerance = wholeToleranceDays(s.toleranceDays);
    const through = s.checkedThrough;
    // never below zero: a checked day before the last match covers none of the tolerance
    const checked =
      through === null || through === undefined
        ? "the ledger has not checked every account it posts to"
        : `${longDate(through)} is the last day every account it posts to has been checked through — ` +
          `${Math.max(0, diffDays(s.lastMatchedOn, through))} of the ${tolerance} days its tolerance allows`;
    return `${expects}, and nothing has matched since ${longDate(s.lastMatchedOn)} (${s.daysSinceLastMatch} days), but ${checked} — so it cannot be called late yet. Still projected.`;
  }
  return `${expects}, but nothing has matched since ${longDate(s.lastMatchedOn)} — ${s.daysSinceLastMatch} days, past the ${wholeToleranceDays(s.toleranceDays)}-day tolerance. Still projected: a late import looks exactly like a cancelled series, so this says which numbers rest on old evidence rather than dropping them.`;
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
 * branch for each and the inline badge reads "never billed" (`staleLabel`).
 * Only the count that stands over them did not.
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
 * been billed in September" would say they had never been billed IN SEPTEMBER,
 * which is a different and weaker claim than the true one — they have never
 * been billed at all.
 *
 * 🔴 AND IT SAYS IT IN THE BADGES' VERB. It read "…and 3 have never charged"
 * directly over rows badged "never billed" — measured on the real ledger
 * 2026-09-15, on the Upcoming list and under the forecast card, whose own
 * composition band says "never billed" too. The owner chose "billed" on
 * 2026-09-14 (`SERIES_EVIDENCE_LABEL["never-billed"]`); one card spelled one
 * fact two ways. "Never billed" is an adjective and this clause needs a verb,
 * so it is the same participle with the auxiliary it needs, not a third word.
 */
/**
 * 🔴 AND AWAITING STATEMENTS IS NOT LATE. "In October 2026, 4 series are running late" counted his pay, whose payday
 * falls after the last day Wells Fargo has been checked through, and Rocket Money, whose charge falls after Chase's
 * (his ledger, 2026-10-08). They are counted apart, in the badges' word (`SERIES_EVIDENCE_LABEL`), and never warn.
 */
export function staleSummaryLabel(entries: readonly StaleEntry[], window: string): string {
  const never = entries.filter((e) => e.staleness.daysSinceLastMatch === null).length;
  const awaiting = entries.filter((e) => staleIsAwaiting(e.staleness)).length;
  const late = entries.length - never - awaiting;
  // the first clause carries the noun: "1 series is running late and 2 have never been billed"
  const clauses = [
    { n: late, verb: (n: number) => (n === 1 ? "is running late" : "are running late") },
    { n: never, verb: (n: number) => (n === 1 ? "has never been billed" : "have never been billed") },
    { n: awaiting, verb: (n: number) => (n === 1 ? "is awaiting statements" : "are awaiting statements") },
  ]
    .filter((c) => c.n > 0)
    .map((c, i) => `${c.n} ${i === 0 ? "series " : ""}${c.verb(c.n)}`);
  const listed =
    clauses.length <= 1 ? (clauses[0] ?? "") : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
  return `${window}, ${listed} — ${clauses.length <= 1 ? "still projected" : "all still projected"}`;
}

/**
 * The word a FUTURE calendar entry carries about its series' evidence, after
 * its confidence: "Car lease upcoming (scheduled, never billed)". Null when the
 * evidence is fresh and there is nothing to say.
 *
 * 🔴 It said "evidence stale" for both kinds of series `seriesStaleness` calls
 * stale, and one of them has no evidence at all. Measured on the real ledger
 * 2026-09-14, `/recurring?tab=calendar` printed "Car lease upcoming (scheduled,
 * evidence stale) -$695.04" on the page that also said "3 have never charged"
 * and filed the lease under "Never billed". The owner chose the All tab's word
 * (2026-09-14) — `SERIES_EVIDENCE_LABEL`, not a third spelling of it.
 */
export function upcomingEvidenceWord(e: {
  isStale: boolean;
  neverBilled: boolean;
  billedWith: string | null;
}): string | null {
  /*
   * ⚖️ Paid inside another series' payment (§6A 59): whose postings its evidence is, first — "Rent utilities & fees
   * upcoming (scheduled, billed with the rent)". 🔴 It read "(scheduled, never billed)", paid inside every rent.
   */
  if (e.billedWith !== null) {
    if (e.neverBilled) return `${e.billedWith}, which has never been billed`;
    return e.isStale ? `${e.billedWith}, evidence stale` : e.billedWith;
  }
  if (e.neverBilled) return SERIES_EVIDENCE_LABEL["never-billed"].toLowerCase();
  return e.isStale ? "evidence stale" : null;
}

/**
 * Why a PAST occurrence could not be graded — the words beside the "?" so it
 * never reads as a shrug. The calendar's cell names and its Day Sheet both
 * print them, from the one reason `settledVerdict` returned with the state.
 *
 * 🔴 `schedule_unproven` read "due date not established". The check behind it,
 * `scheduleIsProven`, counts the charges linked to a series (one or two is too
 * few) and never asks where the date came from — so the word claimed more than
 * the check measured. Measured on the real ledger 2026-09-14: Car insurance's
 * Sep 11 read "not yet known (due date not established) -$361.49" over a date
 * the owner had typed by hand, with one charge linked by hand, while /budgets,
 * the forecast and the series page all said it "came due Sep 11".
 *
 * Both hazards the check exists for are "too few charges": a date extrapolated
 * from one posting (FPL, wrong by thirteen days) and a series that cannot absorb
 * its own next charge (Breezeline, two). Neither says the date is unknown. The
 * owner's decision, 2026-09-14: keep the check, fix the word.
 */
const UNSETTLED_REASON_WORD: Record<UnsettledReason, string> = {
  not_imported: "not imported yet",
  unbanked: "not banked yet",
  schedule_unproven: "too few charges to grade yet",
};

export function unsettledReasonWord(reason: UnsettledReason): string {
  return UNSETTLED_REASON_WORD[reason];
}

/**
 * One entry per stale SERIES, not per occurrence — a weekly series contributes
 * four rows to a 30-day window and would otherwise be named four times. The
 * first occurrence wins; every occurrence of a series shares its staleness.
 */
export function staleOccurrenceEntries(occurrences: readonly SeriesOccurrence[]): StaleEntry[] {
  const bySeries = new Map<string, StaleEntry>();
  for (const o of occurrences) {
    // ⛔ awaiting statements reaches the footer too, counted apart (`staleSummaryLabel`): the chip's why is reachable
    if (!(o.staleness?.isStale || o.staleness?.awaitingStatements) || bySeries.has(o.seriesId)) continue;
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
    if (!(c.staleness?.isStale || c.staleness?.awaitingStatements) || seen.has(c.label)) continue;
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
 *
 * ⛔ The average and its spread are ONE reading (`lib/posted-average`), the one the All tab and the popover name: a pay
 * series' is what a payday paid at the rate in force now. 🔴 Read raw, his pay page printed "posted avg +$1,789.15 ±
 * 1881.46" under "+$1,141.92" (a copy of his ledger, 2026-10-08) — the band a bare number beside money.
 */
export interface PostedSpreadReading {
  /** the band as it is printed, "± $583.58" — money, like the figures beside it; null when there is none */
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
  // 🔴 `toFixed(2)` printed "± 583.58" beside "-$1,849.76", and "± 1881.46" with no separator: the band is money too
  const text = postedStddevCents !== null && postedStddevCents > 0 ? `± ${formatCents(postedStddevCents)}` : null;
  // nothing linked, or a headline that IS the measured centre: one number
  if (postedAvgCents === null || postedAvgCents === headlineCents) {
    return { text, attachedToHeadline: text !== null, avgLine: null };
  }
  return { text, attachedToHeadline: false, avgLine: postedAvgCents };
}

/** A year is twelve months — the span `annualizedCentsOf` multiplies one charge out over. */
const MONTHS_IN_YEAR = 12;

/**
 * What qualifies an ANNUALIZED figure — and only when it needs qualifying.
 *
 * 🔴 The gate was `endsOn !== null`: the EXISTENCE of an end date, not an end
 * date inside the year being annualized. Measured on the real ledger
 * 2026-09-11, exactly two series carry one and the caveat was false on one of
 * them. `Car lease` ends 2028-08-15, 704 days out — it bills twelve times in
 * the twelve months from today for $8,340.48, the annualized figure to the
 * cent — and the page printed "a full year — this one is scheduled only to
 * 2028-08-15" over it. "Only" asserts a shortfall that does not exist, inches
 * under an insight ranking the same $8,340.48 as what it costs in a year with
 * no caveat at all. `Car insurance` (ends 2027-01-11) is the one it is for.
 *
 * ⛔ The predicate is `endsInsideHorizon`, the rule the committed book already
 * states — exclusive far end and all — so the two surfaces cannot disagree
 * about whether a commitment stops inside a window.
 *
 * ⚠️ Null is SILENCE, never "this one runs the whole year": a series that
 * outlives the window has nothing to disclose, and the header badge already
 * names its end date neutrally.
 *
 * ⛔ A WINDOW HAS TWO ENDS, and the first version of this checked only the far
 * one. `endsInsideHorizon` compares against `toExclusive` alone — the committed
 * book calls it with a window whose near end is `input.from`, this caller with
 * one whose near end is TODAY — so a series that had ALREADY stopped came back
 * "stops on Aug 1, 2026, inside them" of a window beginning Sep 11. It does not
 * stop inside those twelve months; it stopped before them, and the annualized
 * figure over them is not a partial year but a fiction. That case gets the
 * stronger sentence, not the weaker one. Not reachable today — both end-dated
 * series are in the future — but `Car insurance` reaches it on 2027-01-12.
 */
export function annualizedCaveat(endsOn: string | null, today: string): string | null {
  const end = annualizedEnd(endsOn, today);
  if (end === null) return null;
  return end.stopped
    ? `a year this series no longer bills — it stopped on ${longDate(end.endsOn)}`
    : `the twelve months from today — this one stops on ${longDate(end.endsOn)}, inside them`;
}

/**
 * The ONE gate both annualized qualifiers read: does the series stop before the
 * twelve months from today are out — and has it already stopped? Null when the
 * figure needs no qualifying.
 */
function annualizedEnd(endsOn: string | null, today: string): { endsOn: string; stopped: boolean } | null {
  if (endsOn === null) return null;
  if (compareDates(endsOn, today) < 0) return { endsOn, stopped: true };
  if (!endsInsideHorizon(endsOn, addCalendarMonths(today, MONTHS_IN_YEAR))) return null;
  return { endsOn, stopped: false };
}

/**
 * `annualizedCaveat`'s short form, for a table cell: "ends Jan 11, 2027", or
 * "ended Aug 1, 2026".
 *
 * 🔴 `/recurring?tab=all` printed "Car insurance | Monthly | -$357.58 |
 * ~$715.16/yr" and "Car insurance — Nov 11 balance … | Monthly | -$72.74 |
 * ~$72.74/yr" on 2026-09-15 with nothing on either row saying why a monthly
 * bill annualizes to two or one payments. The series' own page qualified both
 * figures; the row could not, because it had no end date.
 *
 * ⛔ SAME GATE as the long form (`annualizedEnd`), so a lease ending 2028 is
 * silent here exactly as it is there.
 */
export function annualizedEndNote(endsOn: string | null, today: string): string | null {
  const end = annualizedEnd(endsOn, today);
  if (end === null) return null;
  return `${end.stopped ? "ended" : "ends"} ${longDate(end.endsOn)}`;
}

/**
 * A lump of pay, as the calendar's cell, its Day Sheet and the series page's
 * history all name it — "4 paydays at $1,141.92 each" — so the deposit's own
 * amount never stands unexplained beside a one-week expectation.
 *
 * ⛔ A day of several deposits is read per payday as ONE (`lib/per-payday`), and
 * the words say whose money the figure is — "5 paydays at $1,141.92 each, with
 * the day's other deposit" — or a $4,567.68 lump would read as five weeks' pay.
 */
export function perPaydayWord(p: PerPayday): string {
  const each =
    p.paydays === 1 ? `1 payday at ${formatCents(p.cents)}` : `${p.paydays} paydays at ${formatCents(p.cents)} each`;
  const others = (p.deposits ?? 1) - 1;
  if (others < 1) return each;
  return `${each}, with the day's ${others === 1 ? "other deposit" : `${others} other deposits`}`;
}

/**
 * ⚖️ A DEPOSIT WHOSE MONEY PAID NO PAYDAY SAYS SO (`PaydayReading.towardNoPayday`, §6A 55b): its money pays nothing
 * past its own date plus the tolerance, so what is left of it after the paydays it reached answers no week — and is
 * graded against none. One phrase for the calendar's cell and Day Sheet and the series page's history, so the two
 * cannot word the same row two ways. 🔴 Before the reach bound June's $400.00 read "paid (toward the payday of Aug
 * 27, 2026)"; after it, the series page still graded the row "-$647.00" beside the calendar's "toward no payday".
 */
export const TOWARD_NO_PAYDAY = "toward no payday";

/**
 * ⚖️ Owner decision 2026-10-08 (§6A 54): the merge confirmation's last sentence — how many of the source's rows are not
 * filed yet and the category the merge files them under, said BEFORE he presses (a merge has no undo button). Null
 * when the merge files nothing: the confirmation then reads as it always has.
 */
export function mergeFilingClause(filing: MergeFiling | null): string | null {
  return filing === null ? null : `${filing.count} not filed yet will be filed under ${filing.categoryPath}.`;
}

/**
 * The merge's toast — what moved, and what the merge filed (§6A 54) in the same voice. It reads the merge's own result
 * whole, so the page cannot report the move and leave the filing out.
 */
export function mergedToastTitle(name: string, { relinked, filed }: Pick<MergeResult, "relinked" | "filed">): string {
  const moved = `${name} merged in · ${relinked} moved`;
  return filed === null ? moved : `${moved} · ${filed.count} filed under ${filed.categoryPath}`;
}
