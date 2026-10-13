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
 * ⚖️ §6A 68 (2026-10-13): what /budgets' header SAYS where it prints "— in so far" — not one day of the month checked
 * where the pay lands (`IncomeExpectation.noIncomeDayRead`). A screen reader given the bare dash hears nothing, or "em
 * dash", where the figure was; the spoken line says why there is none, as a budget row's does under §6A 64.
 */
export const NO_INCOME_DAY_CHECKED =
  "no day of this month checked yet in the accounts that pay lands in, so nothing is shown";

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
 * One home for both surfaces, so /budgets and /recurring cannot word the same
 * two paydays differently.
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
  if (checkedPart === null) {
    return unread === 1
      ? `It falls ${after} — so the ledger has not looked for its deposit.`
      : `They all fall ${after} — so the ledger has not looked for their deposits.`;
  }
  return `${checkedPart}; ${other} ${unread === 1 ? "falls" : "fall"} ${after}.`;
}

/**
 * What /budgets says after the passed paydays when every one fell on a day the ledger has checked — the frontier
 * clause has nothing to add — and what the pay series' own page says then too.
 */
export const IMPORTS_NOT_EARNINGS =
  "That is evidence about what has been imported, not about whether the money was earned.";

/** How the forecast's note and a pay series' own page word the paydays that passed this month with no deposit. */
export interface PassedPaydaysWords {
  /** "1 payday", "2 paydays" — before the amount */
  count: string;
  /** after it: "already passed this month", with "with no deposit imported" only when the clause has nothing to say */
  passed: string;
  /** the paydays nobody has looked for (`unbankedIncomeFrontierClause`), or null when the ledger checked them all */
  unread: string | null;
  /** some payday fell on a day the ledger has checked and no deposit met it — the note's warning tone */
  warning: boolean;
}

/**
 * The forecast's sentence about this month's passed paydays, in the parts each surface lays out its own way: the
 * forecast's note runs them into one paragraph, the pay series' own page heads the list of its paydays with them.
 *
 * ⛔ One home for the words. 🔴 The pay series' page said nothing of Oct 1 or Oct 8 while the forecast named both (a
 * copy of his ledger, 2026-10-12); it says it now in these words, so the two cannot word the same Thursdays apart.
 */
export function passedPaydaysWords(r: UnbankedIncomeReading, formatDay: (iso: string) => string): PassedPaydaysWords {
  const unread = unbankedIncomeFrontierClause(r, formatDay);
  return {
    count: r.occurrenceCount === 1 ? "1 payday" : `${r.occurrenceCount} paydays`,
    passed: unread === null ? "already passed this month with no deposit imported" : "already passed this month",
    unread,
    warning: r.checkedOccurrenceCount > 0,
  };
}
