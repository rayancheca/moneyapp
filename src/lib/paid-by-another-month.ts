import { compareDates } from "./dates";
import { formatDayLong } from "./format-date";
import { formatCents } from "./money";

/** The platform's own list — "A and B", "A, B, and C" — rather than a hand-rolled join. */
const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "deposit of Wed, Sep 30, 2026", "deposits of … and …" — named by day, so each can be found. */
const depositsOf = (deposits: readonly string[]): string =>
  `${deposits.length === 1 ? "deposit" : "deposits"} of ${LIST.format(deposits.map(formatDayLong))}`;

/** The fourth leg of `incomeExpectation`, as the header reads it. */
export interface PaidByAnotherMonth {
  /** the money those deposits put into this month's paydays — not the paydays' worth */
  cents: number;
  /** how many of this month's paydays it went into */
  occurrences: number;
  /** the `posted_on` of each deposit it came from, oldest first */
  deposits: readonly string[];
}

/**
 * The sentence naming the money from ANOTHER month that paid this month's
 * paydays — the fourth figure beside "in so far", "still expected" and "already
 * passed", or null when there is none (a surface prints no sentence about
 * nothing).
 *
 * ⚖️ His answer to §6A 29: a figure of its own, "$1,141.92 paid early, in
 * September", so the month adds up to what the month note says it is scheduled
 * to pay. Without it his Thursday Oct 1, paid by the deposit of Wed Sep 30, was
 * named by nothing on /budgets once Oct 1 had passed.
 *
 * ⛔ The deposit is NAMED, by day, for the reason the recurring calendar names
 * it on the same payday ("paid by the deposit of Sep 30, 2026"): the claim is
 * then checkable — the reader can go to that day and find the row.
 *
 * 🔴 And so the figure is the MONEY those rows put in, led by its amount. It
 * read "1 payday worth $1,141.92 was paid early, by the deposit of Wed, Sep 30"
 * of a row holding $1,100.00: the payday's worth, stated beside a deposit that
 * never carried it.
 *
 * ⛔ "Early" only when every deposit landed before the month began. A deposit
 * after the month can pay one of its paydays only once the month is over, and
 * calling that early would state the reverse of what happened.
 */
export function paidByAnotherMonthNote(paid: PaidByAnotherMonth, monthStart: string): string | null {
  if (paid.occurrences === 0) return null;
  const paydays = paid.occurrences === 1 ? "1 payday" : `${paid.occurrences} paydays`;
  const early = paid.deposits.every((d) => compareDates(d, monthStart) < 0);
  const landed = early ? "before this month began" : "in another month";
  return (
    `${formatCents(paid.cents)} toward ${paydays} this month was paid ${early ? "early, " : ""}by the ` +
    `${depositsOf(paid.deposits)} — money that landed ${landed}, so it is counted in neither figure above.`
  );
}

/** The mirror of the fourth leg, as the header reads it. */
export interface PaidForAnotherMonth {
  /** money in "in so far" that settlement spent on another month's paydays */
  cents: number;
  /** the `posted_on` of each deposit it came from, oldest first */
  deposits: readonly string[];
  /** the paydays outside this month it went to, oldest first */
  paydays: readonly string[];
}

/**
 * The sentence naming the money in "in so far" that paid ANOTHER month's
 * paydays, or null when all of it paid this month's.
 *
 * 🔴 The other half of the fourth figure, and the two cancel. Read Fri
 * 2026-10-02 with Wed Sep 30's lump paying Oct 1 and Thu Oct 1's deposit paying
 * Aug 27, the header printed "$1,141.92 in so far" beside the fourth figure's
 * $1,141.92 — a week over the five paydays October schedules — and nothing said
 * the week in so far was August's. Measured on a copy of his ledger
 * 2026-09-28, it is September's today: the deposit of Sep 24 paid Aug 20.
 *
 * ⛔ Deposit AND payday named, by day: the claim is a pairing, and the recurring
 * calendar draws the same payday "paid by the deposit of" the same day.
 */
export function paidForAnotherMonthNote(paid: PaidForAnotherMonth): string | null {
  if (paid.paydays.length === 0) return null;
  const paydays = paid.paydays.length === 1 ? "1 payday" : `${paid.paydays.length} paydays`;
  const days = LIST.format(paid.paydays.map(formatDayLong));
  return (
    `${formatCents(paid.cents)} of the money in so far, from the ${depositsOf(paid.deposits)}, went toward ` +
    `${paydays} outside this month (${days}) — so it is in the figure above but pays none of this month's ` +
    "paydays."
  );
}
