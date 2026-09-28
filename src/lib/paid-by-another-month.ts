import { compareDates } from "./dates";
import { formatDayLong } from "./format-date";
import { formatCents } from "./money";

/** The platform's own list — "A and B", "A, B, and C" — rather than a hand-rolled join. */
const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** The fourth leg of `incomeExpectation`, as the header reads it. */
export interface PaidByAnotherMonth {
  cents: number;
  occurrences: number;
  /** the `posted_on` of each deposit that paid one of them, oldest first */
  deposits: readonly string[];
}

/**
 * The sentence naming the paydays in this month that money from ANOTHER month
 * paid — the fourth figure beside "in so far", "still expected" and "already
 * passed", or null when there are none (a surface prints no sentence about
 * nothing).
 *
 * ⚖️ His answer to §6A 29: a figure of its own, "$1,141.92 paid early, in
 * September", so the four add up to what the month note says the month is
 * scheduled to pay. Without it his Thursday Oct 1, paid by the deposit of Wed
 * Sep 30, was named by nothing on /budgets once Oct 1 had passed.
 *
 * ⛔ The deposit is NAMED, by day, for the reason the recurring calendar names
 * it on the same payday ("paid by the deposit of Sep 30, 2026"): the claim is
 * then checkable — the reader can go to that day and find the row.
 *
 * ⛔ "Early" only when every deposit landed before the month began. A deposit
 * after the month can pay one of its paydays only once the month is over, and
 * calling that early would state the reverse of what happened.
 */
export function paidByAnotherMonthNote(paid: PaidByAnotherMonth, monthStart: string): string | null {
  if (paid.occurrences === 0) return null;
  const one = paid.occurrences === 1;
  const early = paid.deposits.every((d) => compareDates(d, monthStart) < 0);
  const deposits = `${paid.deposits.length === 1 ? "deposit" : "deposits"} of ${LIST.format(paid.deposits.map(formatDayLong))}`;
  return (
    `${one ? "1 payday" : `${paid.occurrences} paydays`} worth ${formatCents(paid.cents)} ` +
    `${one ? "was" : "were"} paid ${early ? "early, " : ""}by the ${deposits} — money that landed ` +
    `${early ? "before this month began" : "in another month"}, so ${one ? "it is" : "they are"} counted in ` +
    "neither figure above."
  );
}
