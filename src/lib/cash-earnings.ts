import type { Cadence, RatePeriod } from "@/db/schema/recurring";
import { addDays, compareDates } from "./dates";
import { daysThatBanked } from "./posted-average";
import { stepFrom, stepPlan, stepsToReach } from "./recurring-step";
import { rateOn } from "./series-kind";

/**
 * Earned versus banked, for pay that arrives as physical cash.
 *
 * The problem is not that the ledger cannot see cash income — measured on the
 * real database 2026-08-21, it sees it perfectly well whenever a deposit lands
 * and is tagged: June 2026 recorded $1,447.00 of `Income > Salary` from two ATM
 * cash deposits, both linked to the confirmed "Cash job (weekly pay)" series.
 * Every ATM deposit in the ledger is already classified, by hand, by the owner.
 *
 * The problem is TIMING. Cash is earned continuously and deposited in lumps, so
 * a monthly income figure is a record of when he walked to an ATM, not of what
 * he earned. The same ledger shows zero cash income after 2026-06-05 while a
 * hand-entered anchor put $5,000 of physical cash on `Cash on Hand` by
 * 2026-08-03 — money that was plainly earned and never banked.
 *
 * So this module computes three numbers and refuses to collapse them into one:
 * what a CONFIRMED schedule implies was earned, what actually reached a bank,
 * and the difference. It reports; it does not conclude.
 *
 * ⛔ What it must never be read as saying. A positive `unbankedCents` is NOT a
 * claim that the money exists somewhere. It is the arithmetic difference between
 * two known quantities, and it has at least three innocent explanations that
 * this module cannot distinguish between:
 *
 *   - the cash is held, undeposited (the `Cash on Hand` float);
 *   - the cash was spent directly, never touching a bank;
 *   - the series has quietly ended and the schedule is now fiction.
 *
 * `basis` exists so a caller cannot show the number without showing which of
 * those is in play, and `series-stale` exists to make the third one loud. This
 * is the same doctrine as `budgetVerdict`: the reading and the meaning of the
 * reading come out of one call, so they cannot drift apart.
 *
 * ⛔ It never writes, and it never back-fills. There is a standing instruction
 * not to reconstruct `Cash on Hand` history before 2026-08-03, and an estimate
 * that turned into rows would be exactly the fabricated-plug failure of pass 59.
 */

/**
 * Pay periods of silence before a confirmed series is called stale.
 *
 * Three, not one: he banks in lumps, so a single skipped week is his ordinary
 * rhythm and flagging it would cry wolf on the common case. Three consecutive
 * missed periods is the point at which "he hasn't been to an ATM" stops being
 * the most economical explanation.
 *
 * ⚠️ That reasoning is the cash job's. Since 2026-09-23 his pay is weekly ACH
 * payroll into Wells Fargo; the bar stands, but no sentence may restate the
 * reason as a fact about him ("you bank in lumps") — the dashboard's income
 * card did, of payroll, until 2026-10-07.
 */
export const STALE_PERIODS = 3;

/**
 * A confirmed pay schedule. Structurally a subset of `recurring_series`,
 * restated here so `lib` keeps not importing from `services` — the idiom
 * `budget-verdict` and `section-notes` already follow.
 *
 * `startedOn` and `endedOn` bound the series' LIFE. They are what stops a May
 * window borrowing June's schedule, which matters on this ledger specifically:
 * Fordham's payroll ran to 2026-05-13 and the cash job began the following
 * month, so the two must not bleed into each other.
 */
export interface PaySeries {
  cadence: Cadence;
  /** measured average gap, or null to fall back to the cadence's nominal step */
  intervalDaysAvg: number | null;
  /**
   * The day of the month a calendar-stepped schedule lands on — its proven day (`deriveAnchorDay`), else its anchor's
   * own (`walkDayOfMonth`). ⛔ Not `startedOn`'s day: the first payday is the anchor's rhythm walked back
   * (`firstPaydayOn`), and walked into a short month it may have been clamped.
   */
  anchorDay: number | null;
  /** what one pay period is worth NOW, in cents (`seriesAmountCents`); positive for income */
  amountCents: number;
  /**
   * ⚖️ What a pay period was worth before now — dated past periods (owner decision 2026-10-08, §6A 55); each payday
   * is implied at its own day's rate (`rateOn`). Null = the rate has never changed. Required, so a caller that forgot
   * it cannot price his cash weeks at the payroll rate in silence.
   */
  amountHistory: readonly RatePeriod[] | null;
  /**
   * The schedule's first payday — also the walk's anchor. ⚖️ The day every reader of its paydays opens on
   * (`firstPaydayOn`, §6A 55 step B), so this walk names the paydays the settlement, the calendar and /budgets draw.
   */
  startedOn: string;
  /** last day it was in force, or null while it is still running */
  endedOn: string | null;
}

export type CashEarningsBasis =
  /** nothing is confirmed, so nothing is implied — deposits still count */
  | "no-series"
  /** the schedule is confirmed and deposits are arriving against it */
  | "series-live"
  /** confirmed, but silent for `STALE_PERIODS` periods or more */
  | "series-stale";

export interface CashEarningsInput {
  series: PaySeries | null;
  /**
   * Deposits ATTRIBUTED to the series — on the real ledger, the rows carrying
   * `recurring_series_id` that are its pay days' (`payDayRows`: the rows
   * settlement reads, never his spending linked to it). Order does not matter. Passing every inbound row
   * instead would count his mother's cash as wages, which is precisely the
   * mistake the 2026-07-21 rows were rescued from.
   *
   * Money out too — a return or a clawback is negative. ⚖️ But only a DAY that nets to money in banked anything
   * (`daysThatBanked`, his decision 75, 2026-10-13), and `bankedCents` is those days' nets: a payroll and its same-day
   * return pay no payday today and are no pay arriving, and money out on a day of its own takes nothing off.
   */
  banked: readonly { postedOn: string; amountCents: number }[];
  /** window, inclusive at both ends */
  from: string;
  to: string;
  /**
   * The day the reading is taken; nothing after it is ever counted — and
   * nothing dated ON it is earned until a deposit for it lands, because the
   * day is still running. Unless `todayIsComplete` says otherwise.
   */
  today: string;
  /**
   * `today` is a day the records have been read THROUGH, not the day still
   * running — the income card's "as of the day the ledger stops looking"
   * reading. A payday dated on such a day with no deposit has been checked
   * and missed, so it counts as passed. Default false.
   */
  todayIsComplete?: boolean;
  /**
   * The paydays a deposit PAID — the settlement's `settledBy`, early or late — which are never silent: the calendar
   * draws them paid (`periodsSinceBanked`). Absent, none is known to be, and every payday since the last day that
   * banked counts: a reading that names no silence may ask without the settlement (`cashEarningsReadings` passes it
   * whenever it walks one).
   */
  settledPaydays?: ReadonlySet<string>;
}

export interface CashEarnings {
  /** which of the three worlds the numbers below live in — always read it */
  basis: CashEarningsBasis;
  /** what the confirmed schedule implies was earned inside the window */
  impliedCents: number;
  /** what actually reached a bank inside the window — the days that banked there, each its net (`daysThatBanked`) */
  bankedCents: number;
  /**
   * `impliedCents − bankedCents`. Positive means earned-but-not-banked;
   * NEGATIVE means he banked more than the window earned, which happens
   * constantly because he deposits in lumps. Deliberately not clamped: flooring
   * it at zero would hide exactly the lump it is there to show.
   */
  unbankedCents: number;
  /** whole pay periods of the window that have actually elapsed */
  periodsCovered: number;
  /**
   * The span `periodsCovered` actually covers — the first and last covered
   * payday, or null when none is. NOT the window: a window that opens before
   * the job began is bounded by the job, and a line that names the window over
   * a count bounded by the series says something false about both.
   */
  firstPeriodOn: string | null;
  lastPeriodOn: string | null;
  /** the most recent day at or before `today` whose attributed rows banked money (`daysThatBanked`), or null */
  lastBankedOn: string | null;
  /**
   * THE SILENCE: whole pay periods from `silenceFrom` — after `lastBankedOn`, or from the series' first payday when
   * nothing banked — through the last one passed, less those a deposit paid (`settledPaydays`)
   */
  periodsSinceBanked: number;
  /**
   * …and those it left out: the silence's paydays a deposit paid, oldest first — EARLY, every one, as each falls after
   * the last day that banked and nothing after today has arrived. A sentence counting the silence "since the last
   * deposit" names them (`paidEarlyAside`). Empty when no settlement was given.
   */
  silencePaidEarly: readonly string[];
}

const EMPTY: CashEarnings = {
  basis: "no-series",
  impliedCents: 0,
  bankedCents: 0,
  unbankedCents: 0,
  periodsCovered: 0,
  firstPeriodOn: null,
  lastPeriodOn: null,
  lastBankedOn: null,
  periodsSinceBanked: 0,
  silencePaidEarly: [],
};

/** The earlier of two dates. */
const earlierOf = (a: string, b: string): string => (compareDates(a, b) <= 0 ? a : b);

/**
 * How many of the series' own occurrences land in `[from, to]`.
 *
 * Every date decision here goes through `stepPlan`/`stepFrom`/`stepsToReach`
 * rather than being re-derived locally. That is pass 54's lesson stated as
 * code: two functions that must agree about a date must not both compute it.
 * The practical payoff is that a monthly cash arrangement steps by the calendar
 * and keeps its day-of-month, exactly as the recurring projection does.
 */
interface CoveredPeriods {
  count: number;
  /** what the covered occurrences are worth together, each at its own day's rate */
  cents: number;
  /** the first covered occurrence's own date, or null when none is covered */
  firstOn: string | null;
  /** the last covered occurrence's own date, or null when none is covered */
  lastOn: string | null;
}

/** The series' walk inside `[from, to]`: its plan and the first and last step that land there (`last < first`: none). */
function stepsInside(series: PaySeries, from: string, to: string) {
  const plan = stepPlan(series.cadence, series.intervalDaysAvg, series.anchorDay);
  const first = stepsToReach(series.startedOn, plan, from);
  // `stepsToReach` lands on or AFTER `to`; when it overshoots, the last
  // occurrence inside the window is the step before it.
  const reach = stepsToReach(series.startedOn, plan, to);
  const last = compareDates(stepFrom(series.startedOn, plan, reach), to) <= 0 ? reach : reach - 1;
  return { plan, first, last };
}

/** The series' own occurrence DATES in `[from, to]`, oldest first — the steps `occurrencesBetween` counts. */
function occurrenceDaysBetween(series: PaySeries, from: string, to: string): string[] {
  if (compareDates(from, to) > 0) return [];
  const { plan, first, last } = stepsInside(series, from, to);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => stepFrom(series.startedOn, plan, first + i));
}

function occurrencesBetween(series: PaySeries, from: string, to: string): CoveredPeriods {
  // Belt and braces, and named as such: the `Math.max(0, …)` below already
  // returns 0 for an inverted window, because `stepsToReach` is monotonic in its
  // boundary and so `first` can never come out below `last` when `from > to`.
  // This states the precondition at the boundary rather than leaving a caller
  // error to be absorbed silently three lines further down.
  if (compareDates(from, to) > 0) return { count: 0, cents: 0, firstOn: null, lastOn: null };
  const { plan, first, last } = stepsInside(series, from, to);
  const count = Math.max(0, last - first + 1);
  /*
   * The DATES of the endpoints, not just how many there are, because the count
   * alone cannot say what it counted. A window opening before the job began is
   * bounded by `startedOn` (see the note in `cashEarnings` about the missing
   * clamp), so "13 paydays" over a six-month window is right and reads as wrong
   * until the line can name Jun 4 – Aug 27. Same walk, same plan — the span is
   * read off the very steps that were counted rather than re-derived.
   */
  if (count === 0) return { count: 0, cents: 0, firstOn: null, lastOn: null };
  /*
   * ⚖️ Each covered payday at its OWN day's rate (§6A 55), read off the same steps that were counted — the recurring
   * projection's rule (`rateOn`), never a second copy. 🔴 `count × amount` priced his twelve cash weeks at the
   * $1,141.92 set on Sep 22: Earned vs banked implied $20,554.56, $1,139.04 more than he was ever owed.
   */
  const schedule = { nextExpectedAmountCents: series.amountCents, amountHistory: series.amountHistory };
  let cents = 0;
  // never null: the rate now is a number, so every day has one
  for (let i = first; i <= last; i++) cents += rateOn(schedule, stepFrom(series.startedOn, plan, i))!;
  return {
    count,
    cents,
    firstOn: stepFrom(series.startedOn, plan, first),
    lastOn: stepFrom(series.startedOn, plan, last),
  };
}

export function cashEarnings({
  series,
  banked,
  from,
  to,
  today,
  todayIsComplete = false,
  settledPaydays = new Set<string>(),
}: CashEarningsInput): CashEarnings {
  /*
   * Nothing after today is earned or banked yet, whatever the window says. This
   * is the same refusal the pace chart makes: a period still running has not
   * paid, and counting it would turn a schedule into a promise.
   */
  const end = earlierOf(to, today);

  /*
   * ⛔ AND TODAY ITSELF IS NOT EARNED UNTIL IT IS PAID. A payday dated today is
   * still to come — the upcoming strip lists it, `/recurring` schedules it, and
   * `committedBook` gives the forward leg every occurrence dated today. This
   * walk counted it as earned AND as passed: on 2026-09-03, a Thursday, the
   * owner's card read "14 paydays, Jun 4 – Sep 3 … $13,211.00 never reached a
   * bank" and "13 paydays have passed since Jun 5 with no deposit", three
   * centimetres from a strip saying "Sep 3 · Cash job · +$1,047.00". Today's
   * pay had not passed. It had not happened.
   *
   * The one thing that moves today's occurrence into the earned column is a
   * deposit attributed to the series and dated today: then the money is banked,
   * and the payday it answers to is counted with it, so the gap cannot read as
   * a backlog clearing on the very day the pay arrived on time. `banked` here is
   * only ever the rows the owner attributed to this schedule, so the test is
   * the attribution and not a guess about amounts.
   *
   * ⚠️ The other reader of this function asks it "as of the day the records
   * stop" (`income-card`'s checked silence). THAT day is complete — every
   * deposit on it is in the records — so a payday dated on it with nothing
   * banked has been checked and missed, and `todayIsComplete` says so. Found
   * by its tests the moment this rule landed: a cut-off on a Thursday lost the
   * Thursday.
   *
   * ⚖️ A day that BANKED money (`daysThatBanked`, his decision 75, 2026-10-13): a deposit returned the same day landed
   * nothing, so its payday is still to come, as the calendar draws it. 🔴 Any row dated today counted, money out too.
   */
  const bankedDays = daysThatBanked(banked.filter((b) => compareDates(b.postedOn, today) <= 0));
  const paidToday = bankedDays.some((b) => b.postedOn === today);
  const earnedThrough = paidToday || todayIsComplete ? today : addDays(today, -1);
  const scheduleEnd = earlierOf(to, earnedThrough);

  /*
   * ⚖️ What reached a bank is the DAYS THAT BANKED inside the window, each its net (`daysThatBanked`, his decision 75,
   * 2026-10-13) — the days settlement pays a payday by and every Income figure counts: a payroll returned the same day
   * banked its net, and money going back on a LATER day — a day netting below $0.00 — banks nothing and takes nothing
   * off here. ⛔ A reading that knows its frontier reads it on by the one rule (`moneyOutOfWindow`,
   * `cashEarningsReadings` with `withChecked`): it nets money that paid no read payday, and is named on its day where it
   * cannot — never taken off a paid payday. 🔴 Every row in the window was summed: with a Salary-filed -$1,141.92 on
   * Sep 25, the day after Sep 24's payroll, settlement still paid Sep 24 and September's Income stayed $6,177.88 while
   * this banked $4,567.68 of September, not $5,709.60 — /spending's September note read $1,141.92 never reached a
   * bank, and the dashboard's card $12,258.92, not $11,117.00, for a payday the calendar drew paid (review of d75;
   * hypothetical: no money out is linked to his pay, measured on his ledger copy 2026-10-21).
   */
  const bankedCents = bankedDays
    .filter((d) => compareDates(d.postedOn, from) >= 0 && compareDates(d.postedOn, end) <= 0)
    .reduce((sum, d) => sum + d.amountCents, 0);

  // `lastBankedOn` answers "when did pay last arrive", which is a question about
  // the series rather than about the window — a June window must still know
  // that nothing has landed since, so this looks at every attributed deposit up
  // to today, not only the ones inside `[from, to]`. ⚖️ A day that BANKED money (decision 75): money out is no pay
  // arriving, nor a payroll and its same-day return. 🔴 Any row counted — a return's own day read as the last pay.
  const lastBankedOn = bankedDays.at(-1)?.postedOn ?? null;

  if (series === null) {
    return { ...EMPTY, bankedCents, lastBankedOn };
  }

  /*
   * There is deliberately NO `max(from, startedOn)` clamp here, and it is worth
   * saying why, because the obvious reading is that one is missing.
   *
   * `occurrencesBetween` anchors its walk on `startedOn`, and neither branch of
   * `stepsToReach` can return a negative step: the day branch returns 0 for a
   * boundary at or before the anchor, and the calendar branch is floored at 0
   * inside `calendarMonthsBetween`. So a window opening before the series began
   * already yields nothing, and a clamp would be a line that silently does
   * nothing — measured by mutation on 2026-08-21, removing it changed no test.
   *
   * ⚠️ That makes this module's correctness depend on a property of
   * `recurring-step`/`dates` rather than on a guard of its own. If
   * `calendarMonthsBetween` ever stops flooring at zero, a year-long window
   * would start counting paydays from before the job existed, and the clamp
   * comes back with a test that can finally fail without it.
   */
  const liveTo = series.endedOn === null ? scheduleEnd : earlierOf(scheduleEnd, series.endedOn);
  const covered = occurrencesBetween(series, from, liveTo);
  const periodsCovered = covered.count;
  const impliedCents = covered.cents;

  /*
   * Silence is measured in pay periods, not days: "three missed paydays" is a
   * fact about the schedule, while "21 days" is a fact about the calendar and
   * says nothing about whether a payment was skipped. Counted from the last
   * deposit when there is one and from the series' start when there is not, so
   * a series that has never paid is stale rather than invisible.
   *
   * STRICTLY AFTER the last deposit (`silenceFrom` is the day after it) — not
   * the window from it minus one. The two agree only when the deposit landed
   * exactly on a payday, and on the real ledger it did not: the last attributed
   * deposit posted 2026-06-05 while the schedule pays on Thursdays, so the walk
   * already skips to 06-11 and subtracting one then deletes a genuinely missed
   * payday. Measured 2026-08-21 — the honest answer is eleven, the subtraction
   * said ten.
   *
   * ⚖️ …and a MISSED payday: one a deposit paid — early or late, the settlement's
   * `settledBy` — is no part of it, as the calendar draws it paid. ⚖️ Default
   * built, not asked (2026-10-21): the count is the paydays no deposit paid, the
   * one /budgets' "already passed" counts. 🔴 Review of 27ca437: with Wed Sep 30's
   * payroll paying Thu Oct 1 early and Wells Fargo read through Oct 2, Earned vs
   * banked said "1 falls on a day already checked, with no deposit" of Oct 1
   * (his ledger copy 2026-10-21, the Sep 30 row inserted). ⛔ The ones it leaves
   * out are named (`silencePaidEarly`): 🔴 review of 337baa7 — the card then read
   * "2 paydays have passed since the last deposit on Sep 30" with three passed.
   */
  const silent = occurrenceDaysBetween(series, silenceFrom(lastBankedOn, series.startedOn), earnedThrough);
  const silencePaidEarly = silent.filter((day) => settledPaydays.has(day));
  const periodsSinceBanked = silent.length - silencePaidEarly.length;

  return {
    basis: periodsSinceBanked >= STALE_PERIODS ? "series-stale" : "series-live",
    impliedCents,
    bankedCents,
    unbankedCents: impliedCents - bankedCents,
    periodsCovered,
    firstPeriodOn: covered.firstOn,
    lastPeriodOn: covered.lastOn,
    lastBankedOn,
    periodsSinceBanked,
    silencePaidEarly,
  };
}

/**
 * THE FIRST DAY of a schedule's silence — its paydays are those ON OR AFTER it (see `cashEarnings`): the day after the
 * last day that banked, or with none, the schedule's first payday itself (`startedOn`), which nothing banked either.
 * ⛔ One rule for the sentence's count (`periodsSinceBanked`) and the paydays it names not banked yet
 * (`silentPaydaysNotBankedYet`). 🔴 Review of 147f167 (MEDIUM): the second read no silence at all when nothing had
 * banked, so /spending's stale sentence named none of its paydays not banked yet, while the dashboard named Sep 3's.
 * 🔴 Review of c3b30fe (MEDIUM): both read strictly after the first payday too, so with a Thu Jun 4 payroll returned the
 * same day one /spending note counted "$15,000.00 … over Jun 4 – Sep 10" and then "14 expected paydays have passed",
 * while the card counted 15.
 */
export function silenceFrom(lastBankedOn: string | null, startedOn: string): string {
  return lastBankedOn === null ? startedOn : addDays(lastBankedOn, 1);
}

/** Earned vs banked's difference, and the part of it the ledger has looked for. */
export interface PayGap {
  /** implied − banked. POSITIVE means pay that did not reach a bank inside the window; negative, a surplus */
  gapCents: number;
  /**
   * Of a POSITIVE gap, the part that is pay for paydays after the day every account it lands in is checked through —
   * money the ledger has not looked for. Zero when the gap is not positive.
   */
  unreadGapCents: number;
  /** …and the rest of it, pay for READ paydays that no deposit inside the window banked. Zero unless positive. */
  readGapCents: number;
}

/**
 * ⛔ THE ONE SUBTRACTION behind "never reached a bank" — the dashboard's Earned vs banked (`income-card`) and
 * /spending's shortfall note (`payShortfall`) both read it here, so the two cannot drift.
 *
 * ⚖️ Decision 55 (approved with its measured figures): the dashboard's "$11,117.00 of it never reached a bank" is what
 * the paydays imply less EVERY attributed deposit inside the window — net, so money banked inside it that paid no
 * payday (his Fri Jun 5 $400.00, §6A 55b) reduces it. A deposit is a day that banked (`daysThatBanked`, decision 75).
 * 🔴 /spending ALL and YTD said "$11,517.00 never reached a bank" of the same nineteen paydays (review of a4b0fca, his
 * ledger copy 2026-10-13): a second definition, built from the settlement's unpaid weeks, $400.00 from the one he
 * approved.
 *
 * `unreadImpliedCents` is what the schedule implies past the checked day — every payday when nothing is checked —
 * and the unread part is capped at the gap: a deposit can bank an unread payday, never the other way round.
 */
export function payGap(impliedCents: number, bankedCents: number, unreadImpliedCents: number): PayGap {
  const gapCents = impliedCents - bankedCents;
  if (gapCents <= 0) return { gapCents, unreadGapCents: 0, readGapCents: 0 };
  const unreadGapCents = Math.min(gapCents, Math.max(0, unreadImpliedCents));
  return { gapCents, unreadGapCents, readGapCents: gapCents - unreadGapCents };
}

/** Pay for checked paydays that no deposit made up, as the words say it. */
export interface UnbankedSplit {
  /** for paydays no deposit settled whose days to land are not all checked yet (`paydayLandingIsRead`) */
  notBankedYetCents: number;
  /** the rest — checked through their days to land: "never reached a bank" */
  neverCents: number;
}

/**
 * ⛔ THE ONE SPLIT of checked pay no deposit made up — the dashboard's Earned vs banked (`income-card`, over `payGap`'s
 * read part) and /spending's shortfall note (`payShortfall`, over what no deposit inside the window or out made up).
 *
 * ⚖️ "Never reached a bank" only of a payday the ledger has checked through its days to land; one still inside them
 * that no deposit settled is "not banked yet", the forecast's words (`notProjectedSubject`). `inGraceCents` is what
 * those paydays come to, capped at the money no deposit made up — which is theirs first, as `payGap` gives the unread
 * part first: no deposit settled them, so none of the netted money (decision 55) can be said to have paid them.
 * 🔴 Review of 878c3d5: Thu Sep 3 checked through Sat Sep 5 read "Pay not banked yet" on the forecast and "$1,000.00
 * of it never reached a bank" on the dashboard.
 *
 * ⚖️ …past its days to land, "never reached a bank" of a PAYROLL-era payday too, though a later deposit can still pay
 * it (settlement walks back, as Sep 23's $4,567.68 paid Sep 3, 10 and 17) — default built, not asked (2026-10-21; he
 * said "no more questions"): decision 55's words, said as of the checked records and re-read on every load, so the
 * deposit that pays one moves it out of the figure the day it is imported. "Not banked yet" for every payday of an era
 * still paid would never say "never" of a payroll week months unpaid. Measured on his ledger copy 2026-10-21: no
 * payroll-era payday is unpaid through the checked Thu Sep 24 — the $11,117.00 is eleven cash weeks less June's $400.00.
 */
export function unbankedSplit(unbankedCents: number, inGraceCents: number): UnbankedSplit {
  const unbanked = Math.max(0, unbankedCents);
  const notBankedYetCents = Math.min(unbanked, Math.max(0, inGraceCents));
  return { notBankedYetCents, neverCents: unbanked - notBankedYetCents };
}
