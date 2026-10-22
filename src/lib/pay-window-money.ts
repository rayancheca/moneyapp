import { compareDates } from "./dates";
import { formatCents } from "./money";

/**
 * A pay window's money, as /spending's notes and Earned vs banked say it — the small part of `lib/pay-shortfall` its
 * WORDS need, apart from the settlement it reads. ⛔ Its own module so section-notes, which a client component imports
 * (CategoryRow, for `categoryCountLabel`), carries no settlement code to the browser. 🔴 b59ceb2 made section-notes
 * value-import `wentBackOutPhrase` from lib/pay-shortfall, which brought lib/payday-settlement and
 * lib/occurrence-verdict into CategoryRow's client graph (review of the pay-chain batch: weight, not a broken build).
 */

/** A day money went back out on, a day of its own (decision 75): the day's net, as money out — positive. */
export interface WentBackOut {
  postedOn: string;
  cents: number;
}

const centsOf = (parts: readonly { cents: number }[]): number => parts.reduce((sum, p) => sum + p.cents, 0);

/**
 * The window's OWN money: what it banked by the one rule (`moneyOutOfWindow`, `PayShortfall.bankedCents`) less what
 * paid another window's read payday (`paidAcross`) — that money is the other window's, named there paying its payday.
 * What the shortfall's subtraction reads (`payGap`), and what /spending's note for a stale schedule says "reached an
 * account" of the window's earnings. ⛔ One figure for both. 🔴 Review of 0c9bc8d (MEDIUM): the stale note read the
 * banked figure whole — on his ledger copy 2026-10-21 with Wed Sep 30's payroll paying Thu Oct 1, Wells Fargo read
 * through Fri Oct 23 and today Oct 30, Q3 said "only $6,851.52 reached an account" of $14,085.60, Sep 30's $1,141.92
 * among it, while Q4 named that deposit paying Oct 1 early and the live Q3 note said $8,376.00 never reached a bank.
 */
export function windowOwnCents(bankedCents: number, paidAcross: readonly { cents: number }[]): number {
  return bankedCents - centsOf(paidAcross);
}

/** "A and B", "A, B, and C" — the platform's list. */
const AND_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * "$1,141.92 went back out on Fri, Oct 2, 2026" — the days `moneyOutOfWindow` names, each whole, oldest first, every
 * day once: the one spelling /spending's notes and Earned vs banked print.
 */
export function wentBackOutPhrase(days: readonly WentBackOut[], formatDay: (iso: string) => string): string {
  const on = [...new Set(days.map((d) => d.postedOn))].sort(compareDates);
  return `${formatCents(centsOf(days))} went back out on ${AND_LIST.format(on.map(formatDay))}`;
}
