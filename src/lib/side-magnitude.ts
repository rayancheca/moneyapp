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

/**
 * What an account's headline figure is CALLED, and which figure it is.
 *
 * 🔴 `/accounts/<Chase Sapphire>` on 2026-09-04 printed
 *
 *     AMOUNT OWED
 *     -$82.72                     (in red)
 *
 * of a card that owes nothing — the bank owes HIM $82.72, and had since the
 * 09-02 statement. Every other surface already said so: the terrain reads
 * "Owed · in credit", the cards card "$82.72 in credit", the accounts table
 * "in credit — no share of the debt". The account's own page had the negative
 * and not the word, and painted it as a loss.
 *
 * ⛔ Only for a LIABILITY. An asset account with a negative balance is
 * overdrawn, which is a debt and not a credit, and it keeps the plain label —
 * `sideMagnitudeCents` refuses it a share for the same reason.
 */
export interface BalanceHeading {
  /** the heading over the figure */
  label: string;
  /**
   * The same subject as a NOUN PHRASE, for a sentence that has to name it —
   * "How the amount owed is proven".
   *
   * ⚠️ Not `label.toLowerCase()`. That is what the provenance popover was given
   * when this function replaced the inline ternary, and it produced "How amount
   * owed is proven" — which the accessible-name assertion in
   * `e2e/provenance.spec.ts` caught, and which is worse English than the
   * hard-coded string it replaced. The article belongs to the phrase.
   */
  subject: string;
  /** what to print — always the magnitude the label names */
  cents: number;
  /** true when the figure is money against the owner: a debt, or an overdraft */
  isAgainstYou: boolean;
}

export function balanceHeading(balanceCents: number, isLiability: boolean): BalanceHeading {
  if (!isLiability)
    return {
      label: "Balance",
      subject: "this balance",
      cents: balanceCents,
      isAgainstYou: balanceCents < 0,
    };
  /*
   * ⚠️ `|| 0` is the negative-zero guard, and it is not decorative: negating a
   * $0.00 balance gives `-0`, which formats as "-$0.00" — a card that owes
   * nothing, printed as owing a negative amount. `round1` in `AccountsTable`
   * carries the same guard for the same reason.
   */
  const owed = -balanceCents || 0;
  return owed < 0
    ? { label: "In credit", subject: "the credit", cents: -owed, isAgainstYou: false }
    : { label: "Amount owed", subject: "the amount owed", cents: owed, isAgainstYou: owed > 0 };
}
