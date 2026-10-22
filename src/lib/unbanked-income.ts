/**
 * How far the accounts the passed paydays' pay lands in have been checked.
 *
 * ⛔ Three answers, not a nullable day. Several schedules checked through
 * different days have no one day every unchecked payday falls after, and
 * neither null ("nothing checked") nor the earliest day says that truthfully.
 */
export type UnbankedFrontier =
  /** an account the pay could land in has no checked record — or nothing passed unpaid */
  | { kind: "unchecked" }
  /** every account the pay lands in has been checked through this one day */
  | { kind: "day"; through: string }
  /** schedules whose accounts were checked through different days */
  | { kind: "per-schedule" };

/** What a surface knows about the paydays that passed this month with nothing banked. */
export interface UnbankedIncomeReading {
  occurrenceCount: number;
  /** of those, the paydays dated on days every landing account has been checked through */
  checkedOccurrenceCount: number;
  /** how far the accounts the other paydays land in have been checked */
  frontier: UnbankedFrontier;
}

/**
 * What the frontier day IS, for every sentence that names one.
 *
 * 🔴 The day is `earliestVerified` over `accountCoverage`'s `verifiedThrough`:
 * the last day a balance chain closes, NOT the last day anything was imported.
 * Three surfaces called it the day "which nothing has imported yet". On the e2e
 * ledger after "Detect now", Capital One 360 Checking is checked through May 31
 * while its rows run to Jun 15 and its statement to Jul 5, and /budgets and
 * /recurring printed "It falls after Sun, May 31, 2026, which nothing has
 * imported yet"; /spending?period=2026-07 said the same of Chase Total Checking,
 * checked through Jun 30 with rows to Jul 4 (measured 2026-09-15). On the
 * owner's ledger the two days coincide, which is why it read true there.
 *
 * One phrase, so /budgets, /recurring, /spending and the dashboard's income
 * card name the same day the same way.
 */
export const LAST_CHECKED_DAY = "the last day every account that pay lands in has been checked through";

/** What a sentence says of pay whose landing accounts are not all checked — `LAST_CHECKED_DAY`'s counterpart. */
export const NOT_CHECKED = "the ledger has not checked every account that pay could land in";

/**
 * Where pay can land that no frontier speaks for — one of the explanations of an unbanked difference, in the dashboard
 * card's caveat ("payroll can land in …") and /spending's note for a stale schedule ("paid into …").
 *
 * ⚖️ Default built, not asked (2026-10-21): since Aug 27, 2026 his pay is payroll by ACH (decision 55), and a payroll
 * moved to an account the ledger does not read is as quiet as pay never paid. 🔴 Review of 619ceb4 (MEDIUM): the card
 * named it while /spending's note beside it, of the same silence, listed only cash and an ended schedule.
 */
export const ACCOUNT_NOT_READ = "an account the ledger does not read";

/**
 * What the quiet of a payday after `LAST_CHECKED_DAY` waits for — "the ledger has not looked for its deposit", or
 * "…their deposits" of several: the forecast's note, the pay series' own page, /budgets, the dashboard, /spending's
 * cash-earnings note — and of one payday, the calendar's reason (`not_looked_for`).
 *
 * ⚖️ His decision 65 (2026-10-12): the words name what the quiet waits for — a checked statement balance, not an
 * import. 🔴 /spending's note listed "or it has not been imported yet" among the explanations of paydays past the
 * checked day, while the e2e fixture's Chase Total Checking is checked through Jun 30 with rows imported to Jul 4.
 */
export function notLookedForDeposits(paydays: number): string {
  return paydays === 1 ? "the ledger has not looked for its deposit" : "the ledger has not looked for their deposits";
}

/** "A and B", "A, B, and C" — the platform's list, as /spending's notes join their paydays. */
const AND_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Why a checked payday no deposit settled is not banked yet (`paydaysNotBankedYet`): "Sep 3's days to land run past
 * Sat, Sep 5, 2026, the last day every account that pay lands in has been checked through", or "the days to land of
 * Aug 27 and Sep 3 run past …" of several — /spending's shortfall note, and (`payNotBankedYet`) Earned vs banked's
 * stale verdict and /spending's note for a stale schedule, each with its own day format.
 *
 * ⛔ One sentence for all three. 🔴 Review of 4b98f77: the verdict said "4 of them fall on days the records already
 * cover, through Sep 5 — so the pay did not reach a bank" of Sep 3 one line under "$1,000.00 … — so it is not banked
 * yet".
 *
 * ⚖️ "Days to land" — default built, not asked (2026-10-21; he said "no more questions"): no decision of his chose
 * the phrase (review of c02a4b0). Kept over the bills' "the days a payment has to post are not over yet"
 * (`DAYS_TO_POST_NOT_OVER`, the same idea for a due day) because every pay sentence's verb is "lands" — the clause it
 * runs into is `LAST_CHECKED_DAY`, "every account that pay lands in" — and "days to post" would put two verbs for one
 * deposit in one sentence. The series page's "the N-day tolerance" is the same number.
 */
export function daysToLandRunPast(
  paydays: readonly string[],
  checkedThrough: string,
  formatPayday: (iso: string) => string,
  formatDay: (iso: string) => string,
): string {
  const toLand =
    paydays.length === 1
      ? `${formatPayday(paydays[0]!)}'s days to land`
      : `the days to land of ${AND_LIST.format(paydays.map(formatPayday))}`;
  return `${toLand} run past ${formatDay(checkedThrough)}, ${LAST_CHECKED_DAY}`;
}

/**
 * The same, as a verdict: "Sep 3's days to land run past …, the last day … — so its pay is not banked yet" — what a
 * stale schedule's quiet says of a checked payday still inside its days to land, on Earned vs banked and on /spending.
 */
export function payNotBankedYet(
  paydays: readonly string[],
  checkedThrough: string,
  formatPayday: (iso: string) => string,
  formatDay: (iso: string) => string,
): string {
  const whose = paydays.length === 1 ? "its" : "their";
  return `${daysToLandRunPast(paydays, checkedThrough, formatPayday, formatDay)} — so ${whose} pay is not banked yet`;
}

/**
 * " (not counting Oct 1, which was paid early)" — after "N paydays have passed since the last deposit on …", the
 * silence's paydays a deposit paid (`CashEarnings.silencePaidEarly`), which N leaves out; empty when there are none.
 * Earned vs banked's verdict and /spending's note for a stale schedule, each with its own day format.
 *
 * ⚖️ The count is the paydays no deposit paid (default built, not asked, 2026-10-21), and "early" is the word /budgets
 * and /spending give a payday paid before it (decisions 29/32). ⛔ Never "with no deposit" in its place: of a payday
 * past the checked day that is a claim about a day nobody has read (27ca437's V2). 🔴 Review of 337baa7 (MEDIUM): with
 * Wed Sep 30's payroll paying Thu Oct 1 early, the card read "2 paydays have passed since the last deposit on Sep 30"
 * with Oct 1, 8 and 15 passed, and /spending "4 expected paydays have passed since the last deposit on Wed, Sep 30,
 * 2026" with five Thursdays passed (his ledger copy 2026-10-21, the Sep 30 row inserted).
 */
export function paidEarlyAside(paydays: readonly string[], formatPayday: (iso: string) => string): string {
  if (paydays.length === 0) return "";
  const which = paydays.length === 1 ? "which was" : "which were";
  return ` (not counting ${AND_LIST.format(paydays.map(formatPayday))}, ${which} paid early)`;
}

/**
 * ⚖️ §6A 68 (2026-10-13): why a month's income prints "—" — not one day of it checked where the pay lands
 * (`IncomeExpectation.noIncomeDayRead`). The line under the dash on both surfaces that print one: Earned vs banked's
 * "Income recorded in Oct 2026 —", in place of "an empty month is what an unimported month looks like…" (which says
 * nothing of whether anyone has looked), and /budgets' "— in so far" (`IncomeSoFarNote`).
 *
 * ⛔ The only words for it — no spoken stand-in beside the dash. 🔴 Each surface also spoke a reason in the dash's
 * place, and his ledger copy 2026-10-21 read it twice on the dashboard ("Income recorded in Oct 2026 — no day of this
 * month checked yet in the accounts that pay lands in, so nothing is shown" over this note) and spliced into /budgets'
 * figures ("— in so far, what has come in so far is not shown, since …; $2,283.84 still expected") — to a screen
 * reader and in the page's text alike.
 */
export function noIncomeDayCheckedNote(month: string): string {
  return `Not one day of ${month} has been checked in the accounts that pay lands in, so nothing is shown.`;
}

/**
 * ⚖️ §6A 68 for ONE cash-flow bucket on /spending (2026-10-21, `CashFlowBucket.incomeUnread`): "the day has not been
 * checked in the accounts that pay lands in", or for a month "not one day of the month has been checked …" — the note
 * above, said of a bucket whose label names no month ("14", "Oct"). /spending's table says it under its dashes, its
 * chart's hover under the bucket's. 🔴 His ledger copy 2026-10-21: both printed "Income $0.00" for Oct 1 … Oct 14.
 */
export function noIncomeDayCheckedOf(bucket: "day" | "month"): string {
  return bucket === "day"
    ? "the day has not been checked in the accounts that pay lands in"
    : "not one day of the month has been checked in the accounts that pay lands in";
}

/**
 * ⚖️ §6A 68 for a RUNNING total on /spending's graph lens (`runningIncomeUnread`): "not one day through 14 has been
 * checked in the accounts that pay lands in" — the note above, said of the days a "Through 14" hover sums. 🔴 His ledger
 * copy 2026-10-21: the hover read "Through 14 · Income $0.00 · Net −$1,603.00" over days Wells Fargo had not reached.
 */
export function noIncomeDayCheckedThrough(label: string): string {
  return `not one day through ${label} has been checked in the accounts that pay lands in`;
}

/**
 * The one day several schedules' landing accounts were checked through — each
 * schedule's own `earliestVerified` — when they share one.
 *
 * 🔴 NOT THE EARLIEST OF THEM. The reading used to reduce every schedule to its
 * earliest day, and one sentence then covered them all: with Chase checked
 * through Aug 12 and the account Tutoring lands in through Sep 4, it said "1
 * falls on a day already read, with no deposit; the other 3 fall after Wed, Aug
 * 12, 2026, which nothing has imported yet" — and the payday it called read was
 * Tutoring's Sep 3, after the day it named (measured 2026-09-15). A later
 * schedule's unchecked paydays fall after ITS day, not the earliest one.
 */
export function sharedFrontier(days: readonly (string | null)[]): UnbankedFrontier {
  const first = days[0];
  if (first === undefined || first === null || days.includes(null)) return { kind: "unchecked" };
  return days.every((d) => d === first) ? { kind: "day", through: first } : { kind: "per-schedule" };
}

/**
 * "It falls", "Both fall", "They all fall" — every one of `paydays` passed paydays, as the clause below opens.
 *
 * 🔴 Two read "They all fall after Thu, Sep 24, 2026" on the dashboard's Earned vs banked, /budgets' header, his pay's
 * page and the forecast's note (Oct 1 and Oct 8, a copy of his ledger, 2026-10-13). Two are both.
 */
function everyOneFalls(paydays: number): string {
  return paydays === 1 ? "It falls" : paydays === 2 ? "Both fall" : "They all fall";
}

/**
 * "the other one falls", "the other 3 fall" — the passed paydays after the ones a sentence has just named on checked
 * days: the clause below and Earned vs banked's stale verdict, one spelling (review of 0c9bc8d).
 */
export function theOtherFall(paydays: number): string {
  return paydays === 1 ? "the other one falls" : `the other ${paydays} fall`;
}

/**
 * The sentence naming the passed paydays nobody has looked for yet — or null
 * when every one of them fell on a day the ledger has checked, so the surface's
 * own "with no deposit" sentence is already true.
 *
 * 🔴 THE CALENDAR IS NOT THE RECORD, on the two surfaces that still asked it.
 * Measured on the owner's ledger 2026-09-15, /budgets said "2 paydays worth
 * $2,094.00 already passed this month with no deposit against them" and
 * /recurring called the same two "Cash pay that never reaches a bank", while
 * Chase Checking — the only account that pay lands in — had been checked
 * through Aug 12. /spending already scoped the same Sep 3 and Sep 10 to that
 * day; `LAST_CHECKED_DAY` is the phrase all three name it with.
 *
 * ⛔ "Checked", never "read" or "imported": the reading measured neither of
 * those, and both have been false of this day on a real fixture. And a day is
 * named only when every schedule shares it (`sharedFrontier`); otherwise the
 * sentence says the day differs by schedule rather than picking one.
 *
 * One home for every surface that names them — /budgets, the forecast on
 * /recurring and the pay series' own page (`passedPaydaysWords`) — so none can
 * word the same two paydays differently.
 */
export function unbankedIncomeFrontierClause(
  r: UnbankedIncomeReading,
  formatDay: (iso: string) => string,
): string | null {
  const unread = r.occurrenceCount - r.checkedOccurrenceCount;
  if (unread <= 0) return null;

  const checked = r.checkedOccurrenceCount;
  const checkedPart =
    checked === 0 ? null : `${checked} ${checked === 1 ? "falls on a day" : "fall on days"} already checked, with no deposit`;
  const other = unread === 1 ? "the other one" : `the other ${unread}`;

  if (r.frontier.kind === "unchecked") {
    return checkedPart === null
      ? `The ledger has not checked every account that pay could land in, so it cannot say whether any of it arrived.`
      : `${checkedPart}; for ${other}, ${NOT_CHECKED}.`;
  }

  const after =
    r.frontier.kind === "day"
      ? `after ${formatDay(r.frontier.through)}, ${LAST_CHECKED_DAY}`
      : `after the last day the accounts ${unread === 1 ? "its" : "their"} pay lands in have been checked through, which differs by schedule`;
  if (checkedPart === null) return `${everyOneFalls(unread)} ${after} — so ${notLookedForDeposits(unread)}.`;
  return `${checkedPart}; ${theOtherFall(unread)} ${after}.`;
}

/**
 * What /budgets says after the passed paydays when every one fell on a day the ledger has checked — the frontier
 * clause has nothing to add. /budgets' alone: the pay series' own page says the forecast's sentence then
 * (`PassedPaydaysWords.notProjected`), as its doc always claimed. 🔴 It printed this one (review of cfb76fb).
 */
export const IMPORTS_NOT_EARNINGS =
  "That is evidence about what has been imported, not about whether the money was earned.";

/** What the forecast's note and a pay series' own page read of this month's passed paydays: the split, and its warning. */
export interface PassedPaydaysReading extends UnbankedIncomeReading {
  /**
   * Of the checked paydays, those whose DAYS TO LAND are checked too — the series' own tolerance after the payday, the
   * reach settlement's anchor clause gives a deposit (`UnbankedIncomeSeries.pastGraceOccurrenceCount`): no deposit can
   * still answer them on a day the ledger has not read. Only these are a warning.
   */
  pastGraceOccurrenceCount: number;
}

/** How the forecast's note and a pay series' own page word the paydays that passed this month with no deposit. */
export interface PassedPaydaysWords {
  /** "1 payday", "2 paydays" — before the amount */
  count: string;
  /** after it: "already passed this month", with "with no deposit imported" only when the clause has nothing to say */
  passed: string;
  /** the paydays nobody has looked for (`unbankedIncomeFrontierClause`), or null when the ledger checked them all */
  unread: string | null;
  /**
   * Why none of it is projected: "Pay that never reaches a bank cannot be projected as arriving" — the forecast's
   * sentence, and the pay page's when the clause has nothing to say. No full stop: the note runs on from it.
   */
  notProjected: string;
  /** some payday was checked through its days to land and no deposit met it — the note's warning tone */
  warning: boolean;
}

/**
 * What the paydays not projected are called, by what the ledger has read of them.
 *
 * ⚖️ "Pay", never "Cash pay": an app label, and since Aug 27, 2026 his pay is payroll by ACH into Wells Fargo
 * (decision 55). 🔴 The forecast said "Cash pay that never reaches a bank" of every checked payday with no deposit.
 * ⚖️ …and "never reaches a bank" only of a payday checked through its days to land (`pastGraceOccurrenceCount`). 🔴 A
 * Thursday checked through Friday read it, in warning colour, of a payroll that could still land on Sunday.
 */
function notProjectedSubject(r: PassedPaydaysReading): string {
  const unlooked = "Pay the ledger has not looked for";
  if (r.checkedOccurrenceCount === 0) return unlooked;
  const checked = r.pastGraceOccurrenceCount > 0 ? "Pay that never reaches a bank" : "Pay not banked yet";
  /*
   * ⚖️ Default built, not asked (2026-10-21): with paydays after the checked day among them, the subject names those
   * too, in its own words for them. 🔴 "Pay not banked yet cannot be projected as arriving" closed a note whose other
   * two paydays fall after the checked day — a claim about days nobody has read (review of the pay-words batch).
   */
  return r.checkedOccurrenceCount < r.occurrenceCount ? `${checked}, and ${unlooked.toLowerCase()},` : checked;
}

/**
 * The forecast's sentence about this month's passed paydays, in the parts each surface lays out its own way: the
 * forecast's note runs them into one paragraph, the pay series' own page heads the list of its paydays with them.
 *
 * ⛔ One home for the words. 🔴 The pay series' page said nothing of Oct 1 or Oct 8 while the forecast named both (a
 * copy of his ledger, 2026-10-12); it says it now in these words, so the two cannot word the same Thursdays apart.
 */
export function passedPaydaysWords(r: PassedPaydaysReading, formatDay: (iso: string) => string): PassedPaydaysWords {
  const unread = unbankedIncomeFrontierClause(r, formatDay);
  return {
    count: r.occurrenceCount === 1 ? "1 payday" : `${r.occurrenceCount} paydays`,
    passed: unread === null ? "already passed this month with no deposit imported" : "already passed this month",
    unread,
    notProjected: `${notProjectedSubject(r)} cannot be projected as arriving`,
    warning: r.pastGraceOccurrenceCount > 0,
  };
}
