import { and, eq, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays } from "@/lib/dates";
import {
  effectiveSeries,
  projectOccurrences,
  recomputeSeriesStats,
  toProjectable,
  type AbsorptionResult,
  type RecomputeCtx,
  type Tx,
} from "./recurring";

/**
 * FIRST POSTING — the first charge of a commitment the owner registered and
 * that has never posted.
 *
 * Absorption links a charge by its description, and a commitment that has
 * never posted owns no description yet — so its first charge could never link,
 * and would read "not posted" beside its own posting until somebody attached it
 * by hand. Measured 2026-09-14: Car lease ($695.04, the 15th), Gym ($100.00,
 * the 22nd), Parking ($368.86 quarterly, the 20th) and Rent utilities & fees
 * ($182.21, the 1st) are confirmed with ZERO linked rows, and arrears already
 * carried Rent utilities & fees' Sep 1 charge as $182.21 owed. The owner:
 * *"im not attaching shit by hand … the gym and parking as well i told you the
 * dates and prices."* He did: the amount and the schedule ARE the identity.
 *
 * ⛔ PASS 33 WARNING. A dedupe fix once matched rows on (day, amount) with no
 * description check and silently DELETED real charges. This rule matches on
 * (day, amount) too, so it is fenced on every side:
 *
 *  - it only writes a series id onto a row that had NONE — it never moves a
 *    link, never clears one, and never deletes or re-statuses anything;
 *  - it never touches a row the user owns (`series_link_source = 'user'`,
 *    which is also how a detach is remembered);
 *  - it requires uniqueness on BOTH sides: the row is the only candidate the
 *    series has anywhere in the ledger, and the series is the only claimant
 *    the row has. Anything ambiguous links nothing.
 *
 * The match, all of it required:
 *
 *  - the series is `confirmed`, has no active linked row, is not income or a
 *    transfer, and has an effective amount and a next date (user first);
 *  - the row is active, untagged, not user-owned, not in a transfer group, and
 *    posted on or before today;
 *  - the amount equals the effective amount EXACTLY, sign included;
 *  - the row posted within the series' own `toleranceDays` of one of the
 *    occurrences `projectOccurrences` walks. That walk only steps FORWARD from
 *    the schedule's next date (`stepsToReach` never goes below step 0), so a
 *    commitment registered as starting on the 15th cannot claim a charge a
 *    month earlier — the same arbiter arrears and the calendar use;
 *  - a series with an `account_id` only claims rows on that account;
 *  - the amount IS an identity: no other row in the ledger — any status but a
 *    retired re-parse twin, any link, any date, transfers included — carries
 *    that exact amount (on the series' account, when it names one).
 *    🔴 Without it, uniqueness was counted only among the rows imported SO FAR,
 *    and statements for different accounts land on different days — so the
 *    order they arrived in decided the link. Gym ($100.00, the 22nd, no
 *    account) took whichever lone $100.00 row landed first, and once a wrong
 *    row was linked the real charge could never link: the series posted, and
 *    absorption only knew the wrong description. Back-tested at 766cf74 on a
 *    copy of the real ledger, 2026-09-14, walking Gym's 22nd over every month
 *    2023-03 … 2026-08 with no scope: 6 of 42 months claimed a row that is not
 *    a gym charge — an ATM withdrawal (2023-04-24), a Coinbase buy
 *    (2025-01-21), a Philip Morris share buy (2025-04-22), two Zelle payments
 *    (2025-07-22, 2026-06-22) and the Anthropic subscription (2026-08-24).
 *    $100.00 is on 185 active rows; the other registered amounts — $695.04,
 *    $368.86, $182.21, $72.74 — are on none, and the same back-test claims
 *    nothing for them. So Gym links nothing by amount until the owner names the
 *    account it bills to, and only if that account has no other $100.00 row.
 *    ⚠️ What this does NOT close: an amount the ledger has never carried can
 *    still be claimed by a stranger that lands inside the tolerance before the
 *    real charge does. Requiring every account to be imported through the
 *    window first would close it, but a row waiting for coverage would never be
 *    in a later upload's scope, so nothing would ever link;
 *  - no OTHER live series — one that already posts included — expects that
 *    same amount within its tolerance of that day, by the same forward walk.
 *    A bill that already posts, whose next charge arrives under a new
 *    descriptor, is exactly the charge a newcomer at the same price must not
 *    take: absorption cannot see it, and this rule must not guess.
 *
 * ⛔ `candidateIds` limits what may be WRITTEN, never what counts as a rival: a
 * matching row already sitting in history makes the series ambiguous even when
 * only the new one is in scope.
 */

type SeriesRow = typeof recurringSeries.$inferSelect;

interface CandidateRow {
  id: string;
  accountId: string;
  postedOn: string;
  amountCents: number;
}

/** One link the rule would write. */
export interface FirstPostingLink {
  seriesId: string;
  transactionId: string;
}

/**
 * Does `s` expect exactly this charge — this amount, on this account, within
 * its own tolerance of one of its projected occurrences?
 */
function expectsCharge(s: SeriesRow, row: CandidateRow): boolean {
  const eff = effectiveSeries(s);
  if (eff.nextExpectedAmountCents === null || eff.nextExpectedOn === null) return false;
  if (row.amountCents !== eff.nextExpectedAmountCents) return false;
  if (s.accountId !== null && s.accountId !== row.accountId) return false;
  // the window IS the tolerance, so any occurrence inside it is close enough
  return (
    projectOccurrences(toProjectable(s), addDays(row.postedOn, -s.toleranceDays), addDays(row.postedOn, s.toleranceDays))
      .length > 0
  );
}

/**
 * The links the rule WOULD write, reading through `tx` and writing nothing.
 * Omit `candidateIds` to ask it of every untagged row in the ledger.
 */
export function planFirstPostings(
  tx: Tx,
  today: string,
  candidateIds?: ReadonlySet<string>,
): FirstPostingLink[] {
  const live = tx
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();
  const posting = new Set(
    tx
      .selectDistinct({ id: transactions.recurringSeriesId })
      .from(transactions)
      .where(and(eq(transactions.status, "active"), isNotNull(transactions.recurringSeriesId)))
      .all()
      .map((r) => r.id),
  );
  const eligible = live.filter((s) => {
    const eff = effectiveSeries(s);
    return (
      s.status === "confirmed" &&
      s.kind !== "income" &&
      s.kind !== "transfer" &&
      !posting.has(s.id) &&
      eff.nextExpectedAmountCents !== null &&
      eff.nextExpectedOn !== null
    );
  });
  if (eligible.length === 0) return [];
  const eligibleIds = new Set(eligible.map((s) => s.id));
  const rivals = live.filter((s) => !eligibleIds.has(s.id));
  const amounts = [...new Set(eligible.map((s) => effectiveSeries(s).nextExpectedAmountCents!))];

  const candidates = tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      seriesLinkSource: transactions.seriesLinkSource,
      transferGroupId: transactions.transferGroupId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.recurringSeriesId),
        lte(transactions.postedOn, today),
        inArray(transactions.amountCents, [...new Set(eligible.map((s) => effectiveSeries(s).nextExpectedAmountCents!))]),
      ),
    )
    .all()
    .filter((r) => r.seriesLinkSource !== "user" && r.transferGroupId === null);

  // who claims what, over EVERY candidate in the ledger — the scope is applied
  // only at the end, so history can still make a match ambiguous
  const claimedBy = new Map<string, CandidateRow[]>();
  const claimantCount = new Map<string, number>();
  for (const row of candidates) {
    for (const s of eligible) {
      if (!expectsCharge(s, row)) continue;
      claimedBy.set(s.id, [...(claimedBy.get(s.id) ?? []), row]);
      claimantCount.set(row.id, (claimantCount.get(row.id) ?? 0) + 1);
    }
  }

  // every row the ledger holds at an eligible amount — any status but a retired
  // re-parse twin, any link, any date, transfers included — for the identity
  // fence below
  const atAmount = tx
    .select({ id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(ne(transactions.status, "superseded"), inArray(transactions.amountCents, amounts)))
    .all();
  const amountIdentifies = (s: SeriesRow, row: CandidateRow): boolean =>
    !atAmount.some(
      (other) =>
        other.id !== row.id &&
        other.amountCents === row.amountCents &&
        (s.accountId === null || other.accountId === s.accountId),
    );

  const links: FirstPostingLink[] = [];
  for (const s of eligible) {
    const rows = claimedBy.get(s.id) ?? [];
    if (rows.length !== 1) continue; // none, or two candidate rows
    const row = rows[0]!;
    if (claimantCount.get(row.id) !== 1) continue; // two commitments want it
    if (!amountIdentifies(s, row)) continue; // the ledger carries this amount elsewhere
    if (candidateIds && !candidateIds.has(row.id)) continue; // not this operation's row
    if (rivals.some((r) => expectsCharge(r, row))) continue; // another live series expects it
    links.push({ seriesId: s.id, transactionId: row.id });
  }
  return links;
}

/**
 * Writes `planFirstPostings`' links — a detection-owned link, NULL → value
 * only — and settles every series it gave a row. Call it AFTER absorption, so a
 * row a series already owns by description is never offered here.
 */
export function linkFirstPostings(
  tx: Tx,
  today: string,
  ctx: RecomputeCtx,
  candidateIds?: ReadonlySet<string>,
): AbsorptionResult {
  let tagged = 0;
  const touched = new Set<string>();
  for (const link of planFirstPostings(tx, today, candidateIds)) {
    const changes = tx
      .update(transactions)
      .set({ recurringSeriesId: link.seriesId, seriesLinkSource: "detected" })
      .where(and(eq(transactions.id, link.transactionId), isNull(transactions.recurringSeriesId)))
      .run().changes;
    if (changes === 0) continue;
    tagged += changes;
    touched.add(link.seriesId);
  }
  for (const seriesId of touched) recomputeSeriesStats(tx, seriesId, today, ctx);
  return { tagged, touched };
}
