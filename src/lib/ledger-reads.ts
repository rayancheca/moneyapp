/**
 * The accounts the ledger reads, and the words every pay sentence says them in — its own module so the one rule's
 * words (`lib/unattached-match`'s `neverClauses`), which `lib/unbanked-income` imports, can say them too without a
 * cycle. `lib/unbanked-income` re-exports them, where every other reader imports them from.
 */

/**
 * Where pay can land that no frontier speaks for — one of the explanations of an unbanked difference, in the dashboard
 * card's caveat ("payroll can land in …"), /spending's note for a stale schedule ("paid into …") and the calendar
 * legend's "Not yet known" ("it may have been paid into …", `RECURRING_JARGON.notYetKnown`).
 *
 * ⚖️ Default built, not asked (2026-10-21): since Aug 27, 2026 his pay is payroll by ACH (decision 55), and a payroll
 * moved to an account the ledger does not read is as quiet as pay never paid. 🔴 Review of 619ceb4 (MEDIUM): the card
 * named it while /spending's note beside it, of the same silence, listed only cash and an ended schedule — and the
 * legend, of the same quiet marks, only cash (review of cc30142).
 */
export const ACCOUNT_NOT_READ = "an account the ledger does not read";

/**
 * `ACCOUNT_NOT_READ`'s counterpart: the accounts a sentence's "reached" is scoped to — /spending's note for a stale
 * schedule, "none of it reached an account the ledger reads", before its quiet's "paid into" the other; and every
 * sentence saying pay did not arrive (`NEVER_REACHED`, 2026-10-30).
 *
 * ⚖️ Default built, not asked (2026-10-29), the review's own wording. 🔴 Review of cc30142: "none of it reached an
 * account" beside "paid into an account the ledger does not read" — read literally, money that reached no account was
 * offered as paid into one.
 */
export const ACCOUNT_READ = "an account the ledger reads";

/**
 * What pay checked through its days to land with no deposit did: "never reached an account the ledger reads" —
 * Earned vs banked's difference and /spending's shortfall note (`neverClauses`), and the calendar's mark of the payday
 * (`never_banked`). ⛔ Every sentence saying pay did not arrive says it of `ACCOUNT_READ`, in its own verb: the
 * forecast's "Pay that never reaches …" (his pay's page and the dashboard's tile print it), the card's stale verdict
 * "so the pay did not reach …" and its headline "Nothing has reached …", /spending's "and none of it reached …". A
 * deposit the ledger read is still said to have "reached a bank": that claim is what the ledger saw, and only an
 * absence is scoped to where it looks.
 *
 * ⚖️ Default built, not asked (2026-10-30): the calendar's narrowing (87a440d0) carried to every other reader of the
 * same payday, beside the card's caveat and the legend's "paid into `ACCOUNT_NOT_READ`". 🔴 Review of 87a440d0
 * (MEDIUM): only the mark said it — on his ledger copy read Oct 30 the calendar drew Jun 11 – Aug 20 "never reached an
 * account the ledger reads" while the dashboard said "$10,917.00 of it never reached a bank" and /spending "$3,141.00
 * never reached a bank" (August) and "$8,376.00 never reached a bank" (Q3) of the same paydays; with Oct 22's payroll
 * superseded, the forecast's note over the calendar's grid said "Pay that never reaches a bank" of the Oct 22 its mark
 * called "never reached an account the ledger reads".
 */
export const NEVER_REACHED = `never reached ${ACCOUNT_READ}`;
