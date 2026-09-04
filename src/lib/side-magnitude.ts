/**
 * How much an account contributes to its OWN side — the one rule, in one place.
 *
 * 🔴 Written after the same defect shipped twice. A liability's balance is
 * stored negative, so every surface that ranks or shares out a side reached for
 * `Math.abs`. That is right until a card goes into credit: a liability-type
 * account with a POSITIVE balance owes nothing, and the bank owes it. Measured
 * on the owner's ledger 2026-09-03, with Chase Sapphire $82.72 in credit against
 * Discover $557.62 and Venture X $367.99:
 *
 *     /accounts/<Discover>   "Discover is 55.3% of everything you owe"
 *     /accounts (table)      "55.3% of owed" · "36.5% of owed" · "8.2% of owed"
 *
 * — three shares of $1,008.33 when the two cards owed $925.61 between them, and
 * a slice of a debt handed to the card in credit. `account-insights` was fixed
 * on 2026-09-03 and this file exists because the table was not: one page said
 * 60.2% and another 55.3% of the same debt on the same day.
 *
 * Held is the POSITIVE part of an asset-side balance; owed is the NEGATIVE part
 * of a liability-side one. An account sitting on the wrong side of its own sign
 * contributes zero and takes no share — the same refusal a zero balance gets.
 *
 * ⛔ Not a formatter. `-balanceCents` is what a liability row PRINTS as "what
 * you owe" and it is legitimately negative for a card in credit; this is what a
 * liability row WEIGHS inside a total of debts, and that can only be zero or
 * more. Two questions, two answers, and clamping the display would erase a real
 * credit balance.
 */
export function sideMagnitudeCents(balanceCents: number | null, isLiability: boolean): number {
  if (balanceCents === null) return 0;
  return isLiability ? Math.max(0, -balanceCents) : Math.max(0, balanceCents);
}
