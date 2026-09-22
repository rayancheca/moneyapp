import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { duplicateCandidates } from "@/db/schema/duplicate-candidates";
import { transactions } from "@/db/schema/transactions";
import { descriptionScore } from "@/lib/description-score";
import { duplicatePairKey } from "@/lib/hash";
import { formatCents } from "@/lib/money";

/**
 * Cross-source duplicate money, recorded as a PAIR the owner can act on —
 * never deleted, never auto-resolved.
 *
 * Two files can record the same charge: a card statement and a Spending Report
 * word it differently, and one prints the transaction date where the other
 * prints the post date. The importer dedupes most of these as they land
 * (IdentityPool in import/service.ts), but it cannot see rows that were
 * `quarantined` at the time — quarantined rows are deliberately left out of that
 * pool, because they affect no balance and a live incoming row must not vanish
 * against one. The bill for that choice comes due when the quarantine lifts:
 * the period returns to analytics holding a second copy of its own charges.
 *
 * These pairs are FLAGGED, never superseded by this module. A previous revision
 * picked a winner automatically and silently destroyed real charges (reverted in
 * 3e5a7fc): its only evidence was (day, amount), and this ledger holds 1,766
 * rows that collide on (account, day, amount) with a DIFFERENT merchant inside
 * a single file. Retiring a side is the owner's call, in resolveDuplicate, and
 * it is reversible.
 *
 * The pair goes to `duplicate_candidates` and only the boolean lands on the
 * rows. That split is the point of this table: fifteen code paths clear
 * `needs_review` — categorizing a row, confirming a cluster, linking a transfer,
 * the one-click "mark all reviewed" amnesty — and every one of them would
 * otherwise erase a double-count warning with nothing left to say it existed.
 */

/**
 * Money identity, mirroring `identityWeight` in import/service.ts: same
 * account, same amount, and both rows claim the SAME DAY — post-to-post, or
 * transaction-to-transaction when both carry one.
 *
 * Three looser rules were measured against the owner's real 9,827-row ledger
 * and every one of them invents duplicates out of ordinary repeat spending:
 *  - the "date ±1" of docs/schema.md §transactions pairs two distinct month-end
 *    ETH buys (0.003247 vs 0.003508 ETH, both $9.90, both normalizing to the
 *    same text) — 22 rows, mostly false;
 *  - cross-matching one row's post date against the other's transaction date
 *    chains consecutive $3.00 MTA fares, because each fare's post date IS the
 *    next fare's transaction date — 10 rows, mostly false;
 *  - dropping the description gate pairs a $4,000 Microsoft buy with a $4,000
 *    crypto cash settlement that landed the same day.
 * With every clause in place — including the reconciliation exemption below —
 * the rule fires on ZERO rows of the real ledger. That is the right answer, not
 * a weak one: it holds 0 quarantined rows and 0 gap periods, so there is no
 * detectable cross-source duplicate in it today. The one pair that survives
 * every OTHER clause is two real vending charges (see NOT_ALREADY_PROVEN).
 *
 * `IS NOT` rather than `!=` is load-bearing: 172 rows are hand-entered and
 * carry a NULL import_file_id, and `NULL != 'x'` is NULL, not true — the pass
 * this replaces was blind to every one of them. NULL-vs-NULL is correctly
 * false, so two hand-entered rows are not treated as two sources.
 *
 * ⛔ A shared POSTED day counts only where at least one side does not say which
 * day the charge was made. Every source that fills `transacted_on` fills it
 * with the real transaction, trade or activity day, so two records of one
 * charge never disagree about it: one that merely posts on another's day is the
 * next charge along. Measured on a copy of the real ledger, 2026-09-17: the
 * looser posted-day clause matched exactly one pair in 10,320 rows — Chase
 * Sapphire's CPI*CANTEEN VENDING −$1.25 made 07-08 against the −$1.25 made
 * 07-09, both posted 07-09, both real — and with this clause the rule matches
 * ZERO before `NOT_ALREADY_PROVEN` is applied at all. `identityWeight` in
 * import/service.ts refuses to absorb that same pair for the same reason.
 */
const IDENTITY_JOIN = sql`
      ON t1.account_id = t2.account_id
     AND t1.amount_cents = t2.amount_cents
     AND t1.id != t2.id
     AND t1.import_file_id IS NOT t2.import_file_id
     AND (
           (t1.transacted_on IS NOT NULL
            AND t2.transacted_on IS NOT NULL
            AND t1.transacted_on = t2.transacted_on)
        OR ((t1.transacted_on IS NULL OR t2.transacted_on IS NULL)
            AND t1.posted_on = t2.posted_on)
         )
`;

/**
 * Both sides must be in balance replay, which is `active` OR `excluded` —
 * NOT `active` alone. `excluded` hides a row from analytics but the money still
 * moves (derivation.ts REPLAY_STATUSES), so an excluded twin double-counts net
 * worth exactly as an active one does, and the owner would never see why.
 *
 * Rows already tied together as a transfer are the one same-amount pair that is
 * MEANT to exist twice, so they are exempt — as in the pass this replaces.
 */
const BOTH_IN_REPLAY = sql`
    WHERE t1.status IN ('active', 'excluded')
      AND t2.status IN ('active', 'excluded')
      AND t1.transfer_group_id IS NULL
      AND t2.transfer_group_id IS NULL
`;

/**
 * The app already owns an exact duplicate detector, and it outranks every
 * heuristic here: reconciliation. `reconcileAccounts` sums EVERY row in an
 * account inside a period's date range — no import_file_id filter — and
 * compares it to the balances the statement itself prints. A period that comes
 * out `reconciled` has proved to the cent that the money in it is right, so a
 * pair inside one is two real charges, however alike they look.
 *
 * This is not hypothetical. The owner buys from one vending machine several
 * times a day; on 2026-07-08 a single file records three separate $1.25
 * charges. Two $1.25 charges on 2026-07-09 arrived from two different files and
 * look exactly like the duplicate this module hunts — and the period they sit
 * in reconciles, which proves both are real. That pair used to be the flagger's
 * only hit on the entire real ledger, caught here; the identity above now
 * refuses it outright, because the two files disagree about the day each charge
 * was made, and this clause is the general net rather than the one that
 * happened to save that pair.
 *
 * Guarding on t1 alone is deliberate and gives per-row precision: it asks "has
 * THIS row's own money been proved correct?". The join is symmetric, so the
 * other side is asked the same question when the pair is emitted the other way.
 *
 * `accepted` is pointedly NOT exempt — that is the owner overriding a gap he
 * could not explain, which is exactly where a double count hides.
 */
const NOT_ALREADY_PROVEN = sql`
      AND NOT EXISTS (
        SELECT 1 FROM statement_periods p
         WHERE p.account_id = t1.account_id
           AND p.reconciliation = 'reconciled'
           AND t1.posted_on BETWEEN p.period_start AND p.period_end
      )
`;

/**
 * better-sqlite3 binds one host parameter per id; SQLITE_MAX_VARIABLE_NUMBER is
 * 32766. Mirrors bulk-edit.ts's ID_SELECT_CHUNK for the same reason.
 */
const ID_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One emitted direction of the symmetric self-join: t1 paired with t2. */
interface CandidateRow {
  accountId: string;
  aId: string;
  aPostedOn: string;
  aTransactedOn: string | null;
  aAmountCents: number;
  aDescription: string;
  bId: string;
  bPostedOn: string;
  bTransactedOn: string | null;
  bAmountCents: number;
  bDescription: string;
}

/** The pair as it will be stored: ids in canonical order, with its content key. */
interface PendingPair {
  accountId: string;
  transactionIdA: string;
  transactionIdB: string;
  pairKey: string;
  reasonDetail: string;
}

/**
 * The sentence the owner reads in the duplicates queue. Facts only — the amount
 * and the day, which are exactly what the detector matched on — because the one
 * thing this module must never do is imply which side is wrong.
 */
function describePair(row: CandidateRow): string {
  const sameDay = row.aPostedOn === row.bPostedOn;
  const when = sameDay
    ? `on ${row.aPostedOn}`
    : `on ${row.aPostedOn} and ${row.bPostedOn}, both transacted ${row.aTransactedOn ?? ""}`;
  return `Two sources each recorded ${formatCents(Math.abs(row.aAmountCents))} ${when}.`;
}

/**
 * Canonical pair identity: uuidv7 ids are lowercase hex, so JS `<` and SQLite's
 * BINARY collation agree and the unique index actually dedupes. The self-join is
 * symmetric and emits every pair twice; ordering here is what collapses the two
 * directions into one row.
 */
function toPending(row: CandidateRow): PendingPair {
  const aFirst = row.aId < row.bId;
  const left = {
    postedOn: row.aPostedOn,
    transactedOn: row.aTransactedOn,
    amountCents: row.aAmountCents,
    normalizedDescription: row.aDescription,
  };
  const right = {
    postedOn: row.bPostedOn,
    transactedOn: row.bTransactedOn,
    amountCents: row.bAmountCents,
    normalizedDescription: row.bDescription,
  };
  return {
    accountId: row.accountId,
    transactionIdA: aFirst ? row.aId : row.bId,
    transactionIdB: aFirst ? row.bId : row.aId,
    pairKey: duplicatePairKey(row.accountId, left, right),
    reasonDetail: describePair(row),
  };
}

/**
 * Record every cross-source duplicate pair in `duplicate_candidates` and mark
 * both of its rows `needs_review`, so the duplicates queue can ask the owner
 * which copy is real — and still say WHY when it does.
 *
 * Scoped to the given accounts — every caller is settling a status change it
 * already knows the accounts for, and an unscoped self-join over the whole
 * ledger on every import would be pointless work.
 *
 * Returns the number of rows newly flagged; a row already flagged is not
 * counted again, so an idempotent re-run honestly reports nothing found.
 */
export function flagDuplicateCandidates(
  db: AppDatabase,
  accountIds: readonly string[],
): number {
  if (accountIds.length === 0) return 0;

  const pairs = new Map<string, PendingPair>();
  for (const part of chunk([...new Set(accountIds)], ID_CHUNK)) {
    const scope = sql`(${sql.join(part.map((id) => sql`${id}`), sql`, `)})`;
    const candidates = db.all<CandidateRow>(sql`
      SELECT t1.account_id            AS accountId,
             t1.id                    AS aId,
             t1.posted_on             AS aPostedOn,
             t1.transacted_on         AS aTransactedOn,
             t1.amount_cents          AS aAmountCents,
             t1.normalized_description AS aDescription,
             t2.id                    AS bId,
             t2.posted_on             AS bPostedOn,
             t2.transacted_on         AS bTransactedOn,
             t2.amount_cents          AS bAmountCents,
             t2.normalized_description AS bDescription
        FROM transactions t1
        JOIN transactions t2 ${IDENTITY_JOIN}
      ${BOTH_IN_REPLAY}
      ${NOT_ALREADY_PROVEN}
        AND t1.account_id IN ${scope}
    `);
    // The description gate runs in TypeScript against the SAME `descriptionScore`
    // that vetoes a takeover supersede, so a pair can never be confidently
    // superseded by one code path and judged unrelated by the other. The money
    // identity above has already cut the candidate set to a handful, so scoring
    // in JS costs nothing.
    for (const c of candidates) {
      // An EMPTY normalized description matches everything: "".includes("") and
      // `anything.includes("")` are both true, so descriptionScore returns 2 and
      // the gate stops gating. It is reachable — normalizeDescription strips
      // masked card numbers, "#nnn" store numbers and 5+ digit runs, so a raw
      // description that is only a reference number normalizes away entirely.
      // Such a row carries no evidence about WHAT it bought, so it can never be
      // the basis for telling the owner two charges are the same charge.
      if (c.aDescription === "" || c.bDescription === "") continue;
      if (descriptionScore(c.aDescription, c.bDescription) <= 0) continue;
      const pair = toPending(c);
      // NOT_ALREADY_PROVEN guards t1 alone — deliberately, for per-row precision
      // — so a pair whose OTHER side sits inside a reconciled period reaches
      // here from one direction only. Recording it is still right: a pair is two
      // rows, and showing one of them asks a question the owner cannot answer.
      // The proven side is protected where it matters instead — resolveDuplicate
      // refuses to retire a row whose own period reconciles.
      pairs.set(`${pair.transactionIdA}\x1f${pair.transactionIdB}`, pair);
    }
  }

  if (pairs.size === 0) return 0;

  const flagIds = new Set<string>();
  for (const pair of pairs.values()) {
    // The owner already answered this exact question. `pair_key` is content, not
    // ids, so the answer survives the unimport→re-import that gives these two
    // charges brand-new ids — which is the whole of the import-order dependence
    // this table was added to end. Re-asking would make the queue feel like it
    // never empties, and an owner who learns to dismiss a queue stops reading it.
    const dismissed = db
      .select({ id: duplicateCandidates.id })
      .from(duplicateCandidates)
      .where(
        and(
          eq(duplicateCandidates.pairKey, pair.pairKey),
          eq(duplicateCandidates.resolution, "dismissed"),
        ),
      )
      .get();
    if (dismissed) continue;

    const existing = db
      .select({ id: duplicateCandidates.id, resolution: duplicateCandidates.resolution })
      .from(duplicateCandidates)
      .where(
        and(
          eq(duplicateCandidates.transactionIdA, pair.transactionIdA),
          eq(duplicateCandidates.transactionIdB, pair.transactionIdB),
        ),
      )
      .get();
    if (existing === undefined) {
      db.insert(duplicateCandidates)
        .values({
          accountId: pair.accountId,
          transactionIdA: pair.transactionIdA,
          transactionIdB: pair.transactionIdB,
          pairKey: pair.pairKey,
          reason: "cross_source_same_day",
          reasonDetail: pair.reasonDetail,
        })
        .run();
    } else if (existing.resolution === "confirmed_duplicate") {
      // Already settled by retiring one side. BOTH_IN_REPLAY cannot see a
      // superseded row, so re-deriving this pair means the retired side came
      // back beside the side that was kept. (A copy unimportFile restores is
      // not that: its kept side is deleted, so no pair of two live ids names
      // it — duplicate-lifecycle.) The question is open again, and the stale
      // 'confirmed' verdict would otherwise hide it from the queue forever.
      db.update(duplicateCandidates)
        .set({ resolution: "unresolved", resolvedAt: null, retiredTransactionId: null })
        .where(eq(duplicateCandidates.id, existing.id))
        .run();
    }
    flagIds.add(pair.transactionIdA);
    flagIds.add(pair.transactionIdB);
  }

  if (flagIds.size === 0) return 0;

  let flagged = 0;
  for (const part of chunk([...flagIds], ID_CHUNK)) {
    const pending = db
      .select({ id: transactions.id, needsReview: transactions.needsReview })
      .from(transactions)
      .where(inArray(transactions.id, part))
      .all()
      .filter((r) => !r.needsReview)
      .map((r) => r.id);
    if (pending.length === 0) continue;
    db.update(transactions)
      .set({ needsReview: true })
      .where(inArray(transactions.id, pending))
      .run();
    flagged += pending.length;
  }
  return flagged;
}
