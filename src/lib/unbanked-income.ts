/** What a surface knows about the paydays that passed this month with nothing banked. */
export interface UnbankedIncomeReading {
  occurrenceCount: number;
  /** of those, the paydays dated on days every landing account has been read through */
  checkedOccurrenceCount: number;
  /** the frontier the other paydays fall after; null when a landing account has not been read */
  checkedThrough: string | null;
}

const NOT_READ = "the ledger has not read every account that pay could land in";

/**
 * The sentence naming the passed paydays nobody has looked for yet — or null
 * when every one of them fell on a day the ledger has read, so the surface's
 * own "with no deposit" sentence is already true.
 *
 * 🔴 THE CALENDAR IS NOT THE RECORD, on the two surfaces that still asked it.
 * Measured on the owner's ledger 2026-09-15, /budgets said "2 paydays worth
 * $2,094.00 already passed this month with no deposit against them" and
 * /recurring called the same two "Cash pay that never reaches a bank", while
 * Chase Checking — the only account that pay lands in — had been read through
 * Aug 12. /spending said, of the same Sep 3 and Sep 10, "all of it after Wed,
 * Aug 12, 2026, which nothing has imported yet". These are its words, so the
 * three surfaces say one thing.
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
  const readPart =
    checked === 0 ? null : `${checked} ${checked === 1 ? "falls on a day" : "fall on days"} already read, with no deposit`;
  const other = unread === 1 ? "the other one" : `the other ${unread}`;

  if (r.checkedThrough === null) {
    return readPart === null
      ? `The ledger has not read every account that pay could land in, so it cannot say whether any of it arrived.`
      : `${readPart}; for ${other}, ${NOT_READ}.`;
  }

  const after = `after ${formatDay(r.checkedThrough)}, which nothing has imported yet`;
  if (readPart === null) {
    return unread === 1
      ? `It falls ${after} — so the ledger has not looked for its deposit.`
      : `They all fall ${after} — so the ledger has not looked for their deposits.`;
  }
  return `${readPart}; ${other} ${unread === 1 ? "falls" : "fall"} ${after}.`;
}
