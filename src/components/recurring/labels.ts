import {
  arrearsAlarms,
  arrearsClause,
  arrearsSplit,
  DAYS_TO_POST_NOT_OVER,
  NO_STATEMENT_YET,
  NOT_POSTED,
  unreadWaitsOnDaysToPost,
  type ArrearsReading,
} from "@/lib/arrears-reading";
import { addCalendarMonths, compareDates, diffDays, isoWeekday } from "@/lib/dates";
import { endsInsideHorizon } from "@/lib/committed";
import { dayWindowLabel } from "@/lib/period";
import { wholeToleranceDays } from "@/lib/recurring-step";
import { formatCents } from "@/lib/money";
import type { CarriedGrace, UnsettledReason } from "@/lib/occurrence-verdict";
import { carrierWord } from "@/lib/billed-with";
import { ONE_CHARGE_WORD } from "@/lib/one-charge";
import type { PerPayday } from "@/lib/per-payday";
import { projectedEvidence, SERIES_EVIDENCE_LABEL, seriesEvidenceTone, seriesPostingWords } from "@/lib/series-evidence";
import type { Cadence, SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import type { ForecastComponent } from "@/services/forecast";
import type { SeriesOccurrence, SeriesStaleness } from "@/services/recurring";
import type { AttachResult, HandFiling, MergeResult } from "@/services/recurring-links";

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
 *
 * ⛔ …and "charged" only of a series that DID: one nothing ever matched (`neverPosted`) was expected, whatever its kind
 * — so an over sentence must say which (`{ posted }`, no default). 🔴 Review of 49cc98f: from Nov 12 the Nov 11
 * balance's page read "charged once on Nov 11, about $72.74" over "Linked transactions · 0" — a charge the bank never
 * made (his ledger copy, 2026-10-12); a never-billed Gym given an end read "charged monthly, about $100.00".
 */
export function seriesVerb(kind: SeriesKind, over: false | { posted: boolean } = false): string {
  // both tenses are the evidence notes' own (`seriesPostingWords`) — one table of deposit, transfer, payment and
  // charge, so an `other` series pays and paid as its "Per payment" says
  const words = seriesPostingWords(kind);
  if (over) return over.posted ? words.past : "was expected";
  return words.present;
}

/**
 * The word the cadence sentence puts before its account: "into" the account money lands in, "from" the one it leaves.
 *
 * 🔴 It was "from" for every kind, and his pay's page read "deposits weekly on Thursdays, about $1,141.92 from Wells
 * Fargo Everyday Checking." — the account that pay lands IN (a copy of his ledger, 2026-10-13). A bill, a subscription
 * and any other payment leave from their account. A transfer series is ONE leg of a move between his own accounts —
 * the autopay out of checking, or the card's own payment into the card (`classifyKind`) — so its amount's sign says
 * which (`seriesAmountCents`: net-worth-signed). With no amount to read a sign from, the kind decides.
 */
export function seriesAccountWord(kind: SeriesKind, amountCents: number | null): "into" | "from" {
  if (kind === "income") return "into";
  return kind === "transfer" && amountCents !== null && amountCents > 0 ? "into" : "from";
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
 * The marker's tone — the series page's badge's, for the word both read (`seriesEvidenceTone` of `projectedEvidence`):
 * one state, one tone. A bill the bank has not charged yet is NOT a warning — the calendar's Day Sheet already says so
 * ("nothing is late about a bill the bank has not charged yet") — and the Upcoming list badged the car lease in
 * warning amber on the morning of its first payment. 🔴 …while the series page badged "Never billed" in amber
 * beside this neutral chip (review of 2026-10-08).
 */
export function staleMarkTone(s: SeriesStaleness): "warning" | "neutral" {
  return seriesEvidenceTone(projectedEvidence(s));
}

/**
 * Late in the only sense that warns: it has charged, and its evidence ran past tolerance on days the ledger has
 * checked. ⛔ Never billed is not late (above), and neither is awaiting statements (`seriesStaleness`): 🔴 his pay
 * read "last seen 14d ago" in amber for a payday on a day Wells Fargo had not been checked through (2026-10-08).
 *
 * ⛔ The All tab's own word for the series (`projectedEvidence`), never a second split of the staleness flags here —
 * so the footer, the band and the All tab cannot file one series under two words.
 */
function staleIsLate(s: SeriesStaleness): boolean {
  return projectedEvidence(s) === "running-late";
}

/** Past tolerance today, not by its accounts' checked day: it cannot be called late yet (`seriesStaleness`). */
function staleIsAwaiting(s: SeriesStaleness): boolean {
  return projectedEvidence(s) === "awaiting-statements";
}

/** Nothing — its own or its carrier's — has ever matched it: it rests on the schedule alone. */
function staleIsNeverBilled(s: SeriesStaleness): boolean {
  return projectedEvidence(s) === "never-billed";
}

/**
 * Does a line's chip and footer disclose its evidence — late, never billed or awaiting statements? Off the word
 * (`projectedEvidence`), never the flags: a schedule its end has closed is still `isStale` when it never posted, and
 * none of it — nothing more is expected of it. ONE predicate for the chip (`StaleMark`) and every footer's entries.
 * 🔴 Review of 49cc98f: Nov 12–30 the Nov 11 balance's line wore "never billed" and the footer said "expected about
 * every 30 days … still projected" of it, over the All tab's "Ended — nothing more forecast" (his ledger copy).
 */
export function staleIsDisclosed(s: SeriesStaleness): boolean {
  return staleIsLate(s) || staleIsNeverBilled(s) || staleIsAwaiting(s);
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
  const never = entries.some((e) => staleIsNeverBilled(e.staleness));
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
  /* ⚖️ A schedule of ONE charge is expected once, on its day (§6A 56) — the cadence slot's "once · Nov 11". 🔴 It read
     "expected about every 30 days" of the Nov 11 balance in /recurring's Upcoming footer (his ledger copy,
     2026-10-13). */
  const expects =
    typeof s.oneChargeOn === "string"
      ? `expected ${ONE_CHARGE_WORD} on ${longDate(s.oneChargeOn)}`
      : `expected about every ${Math.round(s.stepDays)} days`;
  if (s.lastMatchedOn === null || s.daysSinceLastMatch === null) {
    // in its siblings' words ("nothing has matched since"), true of a deposit as of a charge — 🔴 it said "no charge"
    // of every series, a hand-registered pay included (review of 2026-10-08)
    return `${expects}, but nothing has ever matched it — still projected, on the schedule alone`;
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
  /*
   * ⚖️ Late is past tolerance on READ days (§6A 57), so a late import is "awaiting statements" above, never this. Why it
   * is still projected is what fcdd51b re-documented `LAPSED_MISS_LIMIT` by: a read statement without the posting does
   * not yet prove the series stopped. 🔴 It said "a late import looks exactly like a cancelled series" — the reason the
   * read days had already retired, over a series whose days had been read (review of the 10-12/13 batches).
   */
  return (
    `${expects}, but nothing has matched since ${longDate(s.lastMatchedOn)} — ${s.daysSinceLastMatch} days, past ` +
    `the ${wholeToleranceDays(s.toleranceDays)}-day tolerance. Still projected: statements read without a match are ` +
    `not yet proof it stopped — one paid from another account, or posted under a description not linked to it, reads ` +
    `the same — so this says which numbers rest on old evidence rather than dropping them.`
  );
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
export function stalePartLabel(side: StaleSide): string | null {
  const parts = staleParts(side);
  return parts.length === 0 ? null : parts.map((p) => p.text).join(" · ");
}

/** What `staleParts` reads of one side of the band — `ForecastSplitSide` (lib/forecast-split), structurally. */
interface StaleSide {
  fixedCents: number;
  fixedStaleCents: number;
  fixedStaleCount: number;
  fixedNeverChargedCents: number;
  fixedNeverChargedCount: number;
}

/** One part of the band's label: its words, and the evidence word they say — its tone and the footer's word for it. */
export interface StalePart {
  evidence: "running-late" | "never-billed";
  text: string;
}

/**
 * The band's label in its parts, each with the word it says (`stalePartLabel` joins them) — so the band can wear each
 * part in that word's tone (`seriesEvidenceTone`) and point it at the footer's word for it (`staleFooterWord`).
 *
 * 🔴 One state, one tone (review of 481e357): the chip and the series page's badge called never billed quiet, and the
 * band wore it in amber under 'see "running late", below' — on his ledger copy at today = 2026-10-12, "$468.86 of it
 * never billed" over October's money out and "$172.74 of it never billed" over November's, above a footer with nothing
 * running late in it.
 */
export function staleParts(side: StaleSide): StalePart[] {
  if (side.fixedStaleCount === 0 || side.fixedStaleCents === 0) return [];
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
  const part = (evidence: StalePart["evidence"], cents: number, phrase: string): StalePart => ({
    evidence,
    text: cents === whole ? `all of it ${phrase}` : `${formatCents(cents)} of it ${phrase}`,
  });
  if (never === 0) return [part("running-late", late, "running late")];
  if (late === 0) return [part("never-billed", never, "never billed")];
  // both, and each named with its own figure — a reader can add them up
  return [
    part("running-late", late, "running late"),
    { evidence: "never-billed", text: `${formatCents(never)} never billed` },
  ];
}

/**
 * The words the disclosure footer counts each state in — "1 series IS RUNNING LATE, 2 have NEVER BEEN BILLED" — and
 * so the word the band's tooltip sends the reader to find there ('see "never been billed", below'). ONE spelling:
 * 🔴 the band titled never-billed money 'see "running late", below' over a footer that held nothing running late
 * (review of 481e357).
 */
const STALE_FOOTER_WORD: Record<"running-late" | "never-billed" | "awaiting-statements", string> = {
  "running-late": "running late",
  "never-billed": "never been billed",
  "awaiting-statements": "awaiting statements",
};

export function staleFooterWord(evidence: keyof typeof STALE_FOOTER_WORD): string {
  return STALE_FOOTER_WORD[evidence];
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
  // each counted under its All-tab word (`projectedEvidence`), never as what is left over from the other two
  const late = entries.filter((e) => staleIsLate(e.staleness)).length;
  const never = entries.filter((e) => staleIsNeverBilled(e.staleness)).length;
  const awaiting = entries.filter((e) => staleIsAwaiting(e.staleness)).length;
  // the first clause carries the noun: "1 series is running late and 2 have never been billed"
  const clauses = [
    { n: late, verb: (n: number) => `${n === 1 ? "is" : "are"} ${STALE_FOOTER_WORD["running-late"]}` },
    { n: never, verb: (n: number) => `${n === 1 ? "has" : "have"} ${STALE_FOOTER_WORD["never-billed"]}` },
    { n: awaiting, verb: (n: number) => `${n === 1 ? "is" : "are"} ${STALE_FOOTER_WORD["awaiting-statements"]}` },
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
 *
 * 🔴 `not_imported` read "not imported yet" — false, since a due day is read only with its grace (`dueDayIsRead`), of
 * a day an import HAS reached short of it: the e2e fixture's Meal Kit, due Jul 5 on a card imported through Jul 5.
 * ⚖️ His decision 60 (2026-10-08): until then the runway's unread words, shared, so the calendar's "?" and every
 * arrears surface say one thing of one due day — ⚖️ since his decision 65 (2026-10-12) "no statement has covered it
 * yet" (`NO_STATEMENT_YET`): the day is read to each account's last CHECKED statement balance (`dueDayReadings`), so
 * "no import" was false of a day the imported rows had passed.
 *
 * …and of a PAYDAY after the day its pay's accounts are checked through (`paydayIsRead`), where every pay sentence
 * says "the ledger has not looked for its deposit". "Not banked yet" is said only of a day someone looked at. 🔴 It
 * was said of every passed payday: his Oct 1 and Oct 8 (ledger copy, 2026-10-12), after Sep 24.
 *
 * …and of a day whose accounts are read through today — an archived card, a cash wallet — still inside its days to
 * post, the arrears' words for the same money (`DAYS_TO_POST_NOT_OVER`). 🔴 It read "no import has covered it yet" of
 * an import that will never come (review of the 2026-10-08 batch).
 */
const UNSETTLED_REASON_WORD: Record<UnsettledReason, string> = {
  not_imported: NO_STATEMENT_YET,
  in_grace: DAYS_TO_POST_NOT_OVER,
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
    if (o.staleness === undefined || !staleIsDisclosed(o.staleness) || bySeries.has(o.seriesId)) continue;
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
    // ⛔ the chip's predicate (`staleIsDisclosed`): a line whose schedule has ended is no footer's
    if (c.staleness === undefined || !staleIsDisclosed(c.staleness) || seen.has(c.label)) continue;
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
 *
 * ⛔ "Not posted" only of what the ledger has READ — the runway's split (`arrearsSplit`). 🔴 On a copy of his ledger
 * 2026-10-08 this read "Oct 1 — not posted" in warning colour under rent and its utilities, here and under
 * `/categories/<Housing>`, of a day no import had reached; the runway beside it said "no import has covered it yet".
 * ⚖️ Staleness between uploads is never a warning (his words 2026-08-05), so the unread note is quiet: `warning` is
 * false only when none of it has been read (`arrearsAlarms`).
 */
export function overdueNote(
  date: string,
  occurrenceCount: number,
  reading: ArrearsReading,
): { text: string; warning: boolean } {
  const more = occurrenceCount > 1 ? ` and ${occurrenceCount - 1} more` : "";
  const text = `${shortDate(date)}${more} — ${arrearsClause(reading, NOT_POSTED)}`;
  return { text, warning: arrearsAlarms(reading) };
}

/**
 * The bill's own page, under "Already due": its heading, the sentence under it, and whether it is a warning.
 *
 * 🔴 `/recurring/<Flamingo South Beach (rent)>` on a copy of his ledger 2026-10-08 read "Already due, and not posted"
 * in warning colour, "Inside this calendar month, with no posting within 3 days of it", over Oct 1 — rent posts from
 * Wells Fargo, read through Sep 24, so no import had covered the day. The runway on the same ledger: "A further
 * $2,291.21 came due earlier this month and no import has covered it yet." ⛔ The runway's split (`arrearsSplit`), not
 * a second one: "not posted" and the warning only for what the ledger has read; ⚖️ the rest is quiet — staleness
 * between uploads is normal, never a warning (his words 2026-08-05).
 *
 * 🔴 …AND THE READ BODY VOUCHED FOR DAYS NO IMPORT HAD REACHED. A due day counted as read once the imports reached the
 * day ITSELF, while a posting up to `toleranceDays` after it still pays it — so with the account imported through the
 * due day, "with no posting within 3 days of it" was a claim about the three days after, unread (review of 2e6c74b,
 * 2026-10-08; the e2e fixture's Meal Kit, due Jul 5 on a card imported through Jul 5, said it of Jul 6–8).
 *
 * ⚖️ His decision 60 (2026-10-08): a due day is read once the records reach it PLUS its grace (`dueDayIsRead`), so the
 * read body says what the rule checked — they reach `graceDays` past it and hold no posting within them — and the
 * unread body, which includes a day they reached short of its grace, says how far they must reach. `graceDays` is the
 * grace the read half waited for (`ArrearsSeries.graceDays`).
 *
 * ⚖️ His decision 65 (2026-10-12): the records are each account's CHECKED statements (`dueDayReadings`), and every body
 * says "statements". 🔴 "No import reaches 3 days past it yet" was said of the rent's Oct 1 with Wells Fargo's rows
 * imported through Oct 21 — its balances checked only through Sep 24 (not-posted-on-landing-accounts.test.ts).
 *
 * 🔴 …AND THE READ BODY WAS AWKWARD AND SAID "it" OF EVERY BILL: "Inside this calendar month, and the statements,
 * which reach 3 days past it, hold no posting within 3 days of it." A weekly bill owes the month's arrears on two to
 * five due days (`occurrenceCount`, the card's own "and N more"), each read the same way (`dueDayIsRead`) — so the
 * read and unread bodies say it of each: "Both due days are inside this calendar month, and the statements reach
 * 3 days past each with no posting within 3 days of either." A mix is several by construction and says "a due day".
 *
 * …and where no statement keeps the unread half unread — its accounts read through today, an archived card or a cash
 * wallet — the heading and the body say its days to post are not over (`unreadWaitsOnDaysToPost`), never how far a
 * statement must reach. 🔴 They said "no import reaches 3 days past it yet" of an import that will never come (review
 * of the 2026-10-08 batch).
 *
 * The forecast and this month's budget count all of it whichever way it reads — both say so.
 *
 * ⚖️ …and billed inside another's payment (§6A 59) with windows of two widths (`carried`), "no posting" names each: a
 * posting of its own within its own days, a payment of its carrier's within the carrier's (`paymentFor`). 🔴 One
 * figure, the wider, stood for both (review of 44eb3e7): with the rent's 5 days and the utilities' own 3, their page
 * read "hold no posting within 5 days of it" beside a posting of their own four days off the day, which paid them
 * nothing. Of the same width — his rent and utilities, both 3 — one figure is true of both, and stays.
 */
export function alreadyDueWords(
  reading: ArrearsReading,
  graceDays: number,
  occurrenceCount: number,
  carried: CarriedGrace | null,
): { heading: string; body: string; warning: boolean } {
  const split = arrearsSplit(reading);
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  // the due days the bodies speak of: one ("it"), both, or all n of them
  const n = Math.max(1, occurrenceCount);
  const one = n === 1;
  const lead = one
    ? "Inside this calendar month"
    : `${n === 2 ? "Both" : `All ${n}`} due days are inside this calendar month`;
  const all = one ? "it" : n === 2 ? "both" : `all ${n}`;
  const any = one ? "it" : n === 2 ? "either" : "any of them";
  const ofDay = (grace: number, day: string) => (grace === 0 ? `on ${day}` : `within ${days(grace)} of ${day}`);
  // "no posting …" of a due day — of its own days and its carrier's when the two differ (`carried`)
  const noPostingOf = (day: string) =>
    carried === null || carried.ownDays === carried.carrierDays
      ? ofDay(graceDays, day)
      : `of its own ${ofDay(carried.ownDays, day)}, and none of ${carrierWord(carried.carrierName)}'s payments ` +
        ofDay(carried.carrierDays, day);
  const within = noPostingOf(any);
  const counted = `The forecast counts ${all}, and so does this month's budget.`;
  const warning = arrearsAlarms(reading);
  // ⚖️ unread only for days to post still to come — its accounts read through today: said so, never "no statement"
  const waitsOnDays = unreadWaitsOnDaysToPost(split);
  if (split.kind === "read") {
    const onTheDay = one ? "its day" : n === 2 ? "both" : "all of them";
    const reach = graceDays === 0 ? onTheDay : `${days(graceDays)} past ${one ? "it" : "each"}`;
    return {
      heading: "Already due, and not posted",
      body: `${lead}, and the statements reach ${reach} with no posting ${within}. ${counted}`,
      warning,
    };
  }
  if (split.kind === "unread") {
    const short = graceDays === 0 ? (one ? "its day" : any) : `${days(graceDays)} past ${any}`;
    const toPost =
      graceDays === 0
        ? one
          ? "its day, the day a payment has to post, is"
          : "their days, the days a payment has to post, are"
        : `the ${days(graceDays)} past ${one ? "it" : "each"} a payment has to post are`;
    return {
      heading: `Already due — ${arrearsClause(reading, NOT_POSTED)}`,
      body: waitsOnDays
        ? `${lead}, and ${toPost} not over yet, so ${all} may still post. ${counted}`
        : `${lead}, and no statement reaches ${short} yet — the days a payment has to post — so ${all} may well ` +
          `have posted. ${counted}`,
      warning,
    };
  }
  const pastADueDay = graceDays === 0 ? "a due day" : `${days(graceDays)} past a due day`;
  // said of that one due day
  const withinIt = noPostingOf("it");
  const rest = waitsOnDays ? DAYS_TO_POST_NOT_OVER : "no statement reaches that far yet";
  return {
    heading: `Already due: ${arrearsClause(reading, NOT_POSTED)}`,
    body:
      `Inside this calendar month. Where the statements reach ${pastADueDay}, they hold no posting ${withinIt}; for ` +
      `the rest, ${rest}. The forecast counts all of it, and so does this month's budget.`,
    warning,
  };
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
 * stop inside those twelve months; it stopped before them.
 *
 * ⛔ …and such a series has NO figure to qualify: `annualizedCentsOf` is null for every end before today (a schedule
 * its end has closed is not forecast — `scheduleHasEnded`), and both printers print this only under a figure. So it is
 * silent. 🔴 It kept a sentence for that case — "a year this series no longer bills — it stopped on …" — that 0af5689
 * made unreachable when it took the "~$0.00/yr" away, under a comment promising Car insurance would reach it on
 * 2027-01-12, the day its figure reads "—" (review of the 10-12/13 batches; the grid in recurring.test.ts is the proof).
 */
export function annualizedCaveat(endsOn: string | null, today: string): string | null {
  const end = annualizedEnd(endsOn, today);
  if (end === null) return null;
  return `the twelve months from today — this one stops on ${longDate(end)}, inside them`;
}

/**
 * The ONE gate both annualized qualifiers read: does the series stop inside the twelve months from today — on or after
 * today, before they are out? Its end day then, else null: the figure needs no qualifying, or there is none.
 */
function annualizedEnd(endsOn: string | null, today: string): string | null {
  if (endsOn === null) return null;
  // stopped already: no year ahead of it, so no figure under which to say so (above)
  if (compareDates(endsOn, today) < 0) return null;
  return endsInsideHorizon(endsOn, addCalendarMonths(today, MONTHS_IN_YEAR)) ? endsOn : null;
}

/**
 * `annualizedCaveat`'s short form, for a table cell: "ends Jan 11, 2027".
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
  return end === null ? null : `ends ${longDate(end)}`;
}

/**
 * The series page's end badge: "Ends Jan 11, 2027" while a date is still to come, and once its schedule has ended —
 * the All tab's "Ended", the card's "Its schedule has ended — every date it holds has come" — "Ended" with the day it
 * RAN OUT (`scheduleRanOutOn`), its last date on or before the end.
 *
 * ⛔ ONE TENSE FOR ONE FACT, off the fact the card states, never the end day alone. 🔴 The tense read the end day: an
 * end between two due days — Car insurance ending Jan 5, 2027, its last date Dec 11 — read "Ends Jan 5, 2027" from
 * Dec 12 beside "Its schedule has ended" (review of the 10-12/13 batches). "Ended Jan 5" would name a day to come, so
 * the day is the one it ran out — and stays that day after the end has passed, never jumping to the end on Jan 6.
 * Where the two are one day (the Nov 11 balance, Car insurance's Jan 11) it reads as it did.
 *
 * ⚠️ No day it ran out and no date to step from: the end day's tense.
 *
 * ⛔ …and an anchor TYPED past its end, whose rhythm's last day before the end is still ahead (`scheduleRanOutOn`; a
 * detected anchor past its end ran out on its last charge, or on the end when that charge settled after it), holds no
 * date: the card says "Its schedule has ended" (`scheduleEnded`, the evidence's `schedule-ended`). 🔴 The badge took
 * the end day's tense and read "Ends Jan 11, 2027" beside it (review of the late-lapse batch; his ledger copy
 * 2026-10-13, Car insurance's anchor typed Feb 11). It ended, before the end it names: "Ended before Jan 11, 2027".
 */
export function seriesEndBadge(endsOn: string, ranOutOn: string | null, today: string, scheduleEnded: boolean): string {
  const ended = SERIES_EVIDENCE_LABEL["schedule-ended"];
  if (ranOutOn !== null) return `${ended} ${longDate(ranOutOn)}`;
  if (compareDates(endsOn, today) < 0) return `${ended} ${longDate(endsOn)}`;
  return `${scheduleEnded ? `${ended} before` : "Ends"} ${longDate(endsOn)}`;
}

/**
 * What the Annualized slot prints around its figure — "~$715.16/yr", a year at today's amounts (`annualizedCentsOf`) —
 * and, for a schedule of ONE charge (`oneChargeOn`), that charge: "once · $72.74". Null when the series carries no
 * year: the slot's "—".
 *
 * ⚖️ Owner decision 2026-10-08 (§6A 56): one charge reads as one charge wherever a cadence prints. 🔴 The Nov 11
 * balance read "Annualized ~$72.74/yr — the twelve months from today — this one stops on Nov 11, 2026, inside them"
 * on its page, "~$72.74/yr ends Nov 11, 2026" on the All tab and "Leaving the forecast ~$72.74 / yr" in its End dialog,
 * beside "Once" (his ledger copy, 2026-10-13). ⛔ `once` is the ONE gate for a year's qualifiers (`annualizedCaveat`,
 * `annualizedEndNote`): they print only under a year. The End dialog's line is this figure (`seriesEndInput`).
 *
 * The charge itself, never the year's sum: a one charge more than a year out projects nothing inside the year, and
 * "once · $0.00" would be false of it.
 */
export function annualizedFigure(s: {
  annualizedCents: number | null;
  oneChargeOn: string | null;
  nextExpectedAmountCents: number | null;
}): { lead: string; cents: number; tail: string; once: boolean } | null {
  if (s.annualizedCents === null) return null;
  if (s.oneChargeOn === null || s.nextExpectedAmountCents === null) {
    return { lead: "~", cents: s.annualizedCents, tail: "/yr", once: false };
  }
  return { lead: `${ONE_CHARGE_WORD} · `, cents: Math.abs(s.nextExpectedAmountCents), tail: "", once: true };
}

/**
 * A lump of pay, as the calendar's cell, its Day Sheet and the series page's
 * history all name it — "4 paydays at $1,141.92 each" — so the deposit's own
 * amount never stands unexplained beside a one-week expectation.
 *
 * ⛔ A day of several deposits is read per payday as ONE (`lib/per-payday`), and
 * the words say whose money the figure is — "5 paydays at $1,141.92 each, with
 * the day's other deposit" — or a $4,567.68 lump would read as five weeks' pay.
 *
 * ⚖️ …and a day read at its NET (`PerPayday.returns`, decision 75) says so — "1 payday at $641.92, net of the day's
 * return" — or a $1,141.92 deposit would stand beside $641.92 with nothing to say why.
 */
export function perPaydayWord(p: PerPayday): string {
  const each =
    p.paydays === 1 ? `1 payday at ${formatCents(p.cents)}` : `${p.paydays} paydays at ${formatCents(p.cents)} each`;
  const others = (p.deposits ?? 1) - 1;
  const returns = p.returns ?? 0;
  const withOthers = others < 1 ? "" : `, with the day's ${others === 1 ? "other deposit" : `${others} other deposits`}`;
  const net = returns < 1 ? "" : `, net of the day's ${returns === 1 ? "return" : `${returns} returns`}`;
  return `${each}${withOthers}${net}`;
}

/** ⚖️ A deposit whose money paid no payday says so (§6A 55b) — `lib/per-payday`'s one phrase, where it is explained. */
export { TOWARD_NO_PAYDAY } from "@/lib/per-payday";

/**
 * ⚖️ Owner decision 2026-10-08 (§6A 54): the merge confirmation's last sentence — how many of the source's rows are not
 * filed yet and the category the merge files them under, said BEFORE he presses (a merge has no undo button). Null
 * when the merge files nothing: the confirmation then reads as it always has.
 */
export function mergeFilingClause(filing: HandFiling | null): string | null {
  return filing === null ? null : `${filing.count} not filed yet will be filed under ${filing.categoryPath}.`;
}

/**
 * A hand link's toast — `lead` says what it linked, and the one clause after it what it filed: "· 2 filed under Car >
 * Lease" (§6A 47 attach, §6A 54 merge). It reads the action's own result, so a page cannot report the link and leave
 * the filing out; with nothing filed, the toast reads as it always has.
 *
 * 🔴 Review of §6A 54 (2026-10-08): the merge's toast named what it filed, while attaching — the same rule — said only
 * "2 attached", and the row moved to its series' category with nothing on the page saying so.
 */
export function filedToastTitle(lead: string, { filed }: { readonly filed: HandFiling | null }): string {
  return filed === null ? lead : `${lead} · ${filed.count} filed under ${filed.categoryPath}`;
}

/** The merge's toast — what moved, then what the merge filed (`filedToastTitle`), from the merge's own result. */
export function mergedToastTitle(name: string, result: Pick<MergeResult, "relinked" | "filed">): string {
  return filedToastTitle(`${name} merged in · ${result.relinked} moved`, result);
}

/** The series page's attach toast — how many it attached, then what attaching filed (`filedToastTitle`). */
export function attachedToastTitle(result: Pick<AttachResult, "attached" | "filed">): string {
  return filedToastTitle(`${result.attached} attached`, result);
}
