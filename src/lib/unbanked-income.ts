/** What a surface knows about the paydays that passed this month with nothing banked. */
export interface UnbankedIncomeReading {
  occurrenceCount: number;
  /** of those, the paydays dated on days every landing account has been checked through */
  checkedOccurrenceCount: number;
  /** the frontier the other paydays fall after; null when a landing account has no checked record */
  checkedThrough: string | null;
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

const NOT_CHECKED = "the ledger has not checked every account that pay could land in";

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
 * those, and both have been false of this day on a real fixture.
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

  if (r.checkedThrough === null) {
    return checkedPart === null
      ? `The ledger has not checked every account that pay could land in, so it cannot say whether any of it arrived.`
      : `${checkedPart}; for ${other}, ${NOT_CHECKED}.`;
  }

  const after = `after ${formatDay(r.checkedThrough)}, ${LAST_CHECKED_DAY}`;
  if (checkedPart === null) {
    return unread === 1
      ? `It falls ${after} — so the ledger has not looked for its deposit.`
      : `They all fall ${after} — so the ledger has not looked for their deposits.`;
  }
  return `${checkedPart}; ${other} ${unread === 1 ? "falls" : "fall"} ${after}.`;
}
