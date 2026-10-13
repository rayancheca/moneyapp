import { formatCents } from "@/lib/money";

/**
 * How far the ledger has READ a bill that came due and that no posting covers — the split every arrears sentence is
 * said through.
 *
 * ⛔ ONE SPLIT, EVERY SURFACE. "Not posted" is a negative claim, so it may be made only of the part of the arrears on
 * days a statement has covered: on each account the bill posts to NOW (his decision 62, 2026-10-12), CHECKED to its
 * last statement balance — the day its "running late" chip measures to (`dueDayReadings` over
 * `silenceMeasuredThroughBySeries`) — through the due day AND its grace, the days a payment may still post on (⚖️ his
 * decision 60, 2026-10-08, `dueDayIsRead`; `arrearsReadCents`, carried by `arrearsThisMonth`). The rest is "no
 * statement has covered it yet" — ⚖️ staleness between uploads is normal, never a warning (his words 2026-08-05; the
 * class approved 2026-10-07).
 *
 * ⚖️ His decision 65 (2026-10-12): the words name what the quiet waits for. 🔴 They said "no import has covered it yet"
 * while the reading waited for a checked balance (since deafb5e): with Wells Fargo's rows imported through Oct 21 and
 * its balances checked only through Sep 24, at Oct 25 the rent's page said no import had covered Oct 1 — seventeen
 * days inside what was imported (not-posted-on-landing-accounts.test.ts).
 *
 * 🔴 The runway learned this on 2026-10-07 and the bill's own page did not. On a copy of his ledger 2026-10-08,
 * `/recurring/<Flamingo South Beach (rent)>` read "Already due, and not posted" in warning colour over Oct 1 — rent
 * posts from Wells Fargo, read through Sep 24 — while the runway said "A further $2,291.21 came due earlier this month
 * and no import has covered it yet." So did `/recurring`'s Next column ("Oct 1 — not posted"), `/categories/<Housing>`
 * and the math table ("came due Oct 1 and has not posted"): four surfaces, one bill, the runway's half of the rule.
 */
export interface ArrearsReading {
  /** what came due and no posting covers, as a positive money-out magnitude */
  owedCents: number;
  /** of `owedCents`, the part on days no checked statement has reached — the rest has been read */
  unreadCents: number;
  /**
   * Of `unreadCents`, the part NO STATEMENT keeps unread: its accounts are read through today — archived or a cash
   * wallet, which nothing will ever be imported for, or checked to the day (`DueDayReading.readsToToday`) — so all it
   * waits for is the days a payment has to post, still to come. Absent: none of it.
   */
  inGraceCents?: number;
}

export type ArrearsKind = "read" | "unread" | "mixed";

export interface ArrearsSplit {
  readCents: number;
  unreadCents: number;
  /** of `unreadCents`, the part only its days to post keep unread (`ArrearsReading.inGraceCents`) */
  inGraceCents: number;
  kind: ArrearsKind;
}

/** The read and unread halves, clamped: never more unread than is owed, never less than nothing. */
export function arrearsSplit({ owedCents, unreadCents, inGraceCents = 0 }: ArrearsReading): ArrearsSplit {
  const owed = Math.max(0, owedCents);
  const unread = Math.min(owed, Math.max(0, unreadCents));
  const read = owed - unread;
  return {
    readCents: read,
    unreadCents: unread,
    inGraceCents: Math.min(unread, Math.max(0, inGraceCents)),
    kind: unread === 0 ? "read" : read === 0 ? "unread" : "mixed",
  };
}

/**
 * A bill's OWN arrears as the reading its page says them through — the "Already due" card (`alreadyDueWords`) and its
 * End dialog (`seriesEndInput`): `seriesDetail.overdue`, whose amount is signed money out.
 */
export function overdueReading(o: { amountCents: number; unreadCents: number; inGraceCents: number }): ArrearsReading {
  return { owedCents: -o.amountCents, unreadCents: o.unreadCents, inGraceCents: o.inGraceCents };
}

/** "no statement has covered <what> yet" — the unread half, said of "it", "them" or "the other $U". */
function noStatementHasCovered(what: string): string {
  return `no statement has covered ${what} yet`;
}

/** The words for the unread half — every arrears surface's, and the calendar's "?" of a due day (decision 65). */
export const NO_STATEMENT_YET = noStatementHasCovered("it");

/**
 * What a rolling budget subtracts before it banks a closed period — said of BOTH halves, because it subtracts both:
 * all of the period's `budgetOverdue`, read or not. The whole sentence, so no surface adds a reason the carry does
 * not bear out.
 *
 * 🔴 It said "Bills that came due and never posted are subtracted" — the one definition left saying "never posted",
 * where his words are "not posted" (decisions 60 and 65), and a negative claim no surface may make of an unread day.
 *
 * 🔴 …and it ended "so a missing statement cannot bank itself as savings" (review of 8f9f408): `carryInto` banked a
 * closed period's plan less what was FOUND in it, so a period no statement had covered banked all of it. On his ledger
 * copy 2026-10-12 Cash & ATM banked $130.00 and Fees $15.00 from a September with no row and no day read, Travel
 * $70.00 from one read through Sep 2. ⚖️ Decision 67 (2026-10-13): such a period banks nothing until its statements
 * land — and the clause is said by that rule, its own cause (`lib/rollover-held-back::ROLLOVER_WAITS`), not here.
 */
export const ROLLOVER_SUBTRACTS =
  `Bills that came due are subtracted whether they are not posted or ${noStatementHasCovered("them")}.`;

/**
 * ⚖️ The words for an unread half no statement keeps unread (`inGraceCents`) — in the words the bill's page already
 * says what a due day waits for in, "the days a payment has to post" (`alreadyDueWords`). No new verdict: quiet,
 * unsettled and unread exactly as "no statement has covered it yet" (`NO_STATEMENT_YET`) is; the words only.
 *
 * 🔴 An archived card's bill due Oct 6 read "no import has covered it yet" on Oct 8 (review of the 2026-10-08 batch),
 * on every surface that says it — of an import /imports will never ask for. Its account is read through today
 * (`silenceReadThrough`); all it waits for is its 3 days to post.
 */
export const DAYS_TO_POST_NOT_OVER = "the days a payment has to post are not over yet";

/**
 * Whether ALL of the unread half waits on its days to post alone — what every sentence of it says through, the bill's
 * page bodies too (`alreadyDueWords`). ⚠️ Only a sum of several bills can hold both kinds — one bill's accounts are
 * read through today or not — and a statement IS awaited for part of such a sum, so it keeps the statement's words:
 * true of that part, and quiet like the rest.
 */
export function unreadWaitsOnDaysToPost(split: ArrearsSplit): boolean {
  return split.unreadCents > 0 && split.inGraceCents === split.unreadCents;
}

/** What the unread words say it of: one bill ("it"), or several (/budgets' page note, "them"). */
export type ArrearsPronoun = "it" | "them";

/**
 * A mixed split in the runway's voice: "$R <notPosted>, and no statement has covered the other $U yet" — or, when it
 * waits on no statement, "…, and the days a payment has to post for the other $U are not over yet".
 */
export function splitClause(split: ArrearsSplit, notPosted: string): string {
  const read = formatCents(split.readCents);
  const unread = formatCents(split.unreadCents);
  if (unreadWaitsOnDaysToPost(split)) {
    return `${read} ${notPosted}, and the days a payment has to post for the other ${unread} are not over yet`;
  }
  return `${read} ${notPosted}, and ${noStatementHasCovered(`the other ${unread}`)}`;
}

/**
 * The split said as one clause: `notPosted` when all of it has been read, "no statement has covered it yet" when none
 * of it has — "the days a payment has to post are not over yet" when it waits on no statement — and both halves by
 * amount for a mix: the words after "Oct 1 —" in the Next column and after "Already due this month," in the End dialog
 * (`seriesEndLines`) and after "Due this period by today," in /budgets' (`budgetDeactivateLines`).
 */
export function arrearsClause(reading: ArrearsReading, notPosted: string, pronoun: ArrearsPronoun = "it"): string {
  const split = arrearsSplit(reading);
  if (split.kind === "read") return notPosted;
  if (split.kind === "unread") {
    if (unreadWaitsOnDaysToPost(split)) return DAYS_TO_POST_NOT_OVER;
    return noStatementHasCovered(pronoun);
  }
  return splitClause(split, notPosted);
}

/**
 * What follows a lead such as "came due Oct 1": " and <notPosted>", " and no statement has covered it yet", or
 * ": $R <notPosted>, and no statement has covered the other $U yet". `notPosted` is the surface's own word for the
 * read half ("never posted" on the runway, "has not posted" in the math table and /budgets' spoken row, "not posted"
 * on the row itself and its page note).
 */
export function arrearsTail(reading: ArrearsReading, notPosted: string, pronoun: ArrearsPronoun = "it"): string {
  const clause = arrearsClause(reading, notPosted, pronoun);
  return arrearsSplit(reading).kind === "mixed" ? `: ${clause}` : ` and ${clause}`;
}

/**
 * Whether a surface may sound its alarm — warning or negative tone — over these arrears: only when some of it fell on
 * days the ledger has read. ⚖️ Staleness between uploads is normal, never a warning (his words 2026-08-05).
 *
 * 🔴 The runway printed "A further $2,291.21 came due earlier this month and no import has covered it yet." in
 * `text-negative` on a copy of his ledger 2026-10-08, while the rent's page, `/recurring`'s Next column and
 * `/categories/<Housing>` said the same money quietly — each had decided its own tone. One rule: the bill's page
 * (`alreadyDueWords`), the Next column and the category list (`overdueNote`), the runway card, and /budgets' row.
 *
 * 🔴 …AND /BUDGETS WAS LEFT OUT OF THE ONE RULE. Its row printed "$2,291.21 expected by now, not imported" in
 * `text-warning` over the same unread rent the runway now said quietly — `budgetOverdue` never carried the split
 * (review of a132c57, 2026-10-08). It does now (`arrearsInWindow`), and the row's tone is this.
 */
export function arrearsAlarms(reading: ArrearsReading): boolean {
  return arrearsSplit(reading).readCents > 0;
}
