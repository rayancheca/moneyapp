/**
 * The words that open a sentence naming the largest of `count` things — "The largest is", "The largest move is" — and,
 * when there is only ONE, the words for it alone: "It is", or "The move is" with a noun.
 *
 * 🔴 One has no largest. The fees card read "Since Dec 2022, 1 charge is filed on Fees itself … The largest is $0.15"
 * on his dashboard (a copy of his ledger, 2026-10-13), and its fix (f63b011) stayed in the fees card: the Subscriptions
 * card still printed "The largest is <name>" over one lapsed line, and /spending's chart description "The largest move
 * is …" over "1 category moved". Every sentence that names the largest of a count opens with these words.
 *
 * `noun` is for a sentence whose subject would be unclear as "it" — the fees card's one charge beside a credit, which
 * "it" would read as both rows.
 */
export function largestLead(count: number, noun?: string): string {
  if (count > 1) return noun === undefined ? "The largest is" : `The largest ${noun} is`;
  return noun === undefined ? "It is" : `The ${noun} is`;
}
