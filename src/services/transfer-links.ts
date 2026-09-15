import { and, eq, gte, inArray, isNull, lte, ne, notInArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { addDays, diffDays } from "@/lib/dates";
import { investmentSideAccountIds } from "./accounts";
import type { BulkResult, UndoFields } from "./bulk-edit";
import { hasSplits } from "./transaction-splits";

/**
 * Manual transfer pairing (S5 of "nothing read-only"): the user links two
 * specific transactions as the two legs of one transfer — the human override
 * for what detectTransfers couldn't pair (unequal amounts from wire fees,
 * date drift beyond ±4 days, missing descriptor hints). Follows the
 * detector's conventions exactly: group key = the outflow leg's id, category
 * by the accounts' types, both legs leave the review queue. Every mutation
 * returns a lossless UndoPatch (bulk-edit's applyUndoPatch restores it).
 *
 * It also owns the two pieces every OTHER transfer path needs: what category a
 * transfer belongs in (transferCategoryResolver) and how a group sheds a leg it
 * no longer holds (staleTransferLegs / detachTransferLegs).
 */

const CANDIDATE_WINDOW_DAYS = 14;
const CANDIDATE_LIMIT = 8;

function categoryIdByPath(db: AppDatabase, path: string): string {
  const [parentName, subName] = path.split(" > ");
  const parent = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) throw new Error(`Missing category ${parentName}`);
  if (!subName) return parent.id;
  const sub = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get();
  if (!sub) throw new Error(`Missing category ${path}`);
  return sub.id;
}

/**
 * ONE meaning for "Transfer". Analytics keys off a category's KIND, so a row
 * carrying only a transfer_group_id — with no Transfers category — still
 * counts as spending. Every path that marks a transfer therefore resolves its
 * category here: the pair-linker with both legs' accounts, the bulk and
 * single-row toggles with the one account they know.
 *
 * Returns a resolver, not an id, because a bulk mark asks per row: the account
 * table and the Transfers categories are read ONCE, so marking a thousand rows
 * costs the same lookups as marking one.
 */
export type TransferCategoryResolver = (accountIds: readonly string[]) => string;

export function transferCategoryResolver(db: AppDatabase): TransferCategoryResolver {
  const accountTypes = new Map(db.select().from(accounts).all().map((r) => [r.id, r.type]));
  // investment SIDE, not type: the P0.1 settlement-cash sibling receives the
  // contributions now, and a manual mark must label them like the detector would
  const investmentSide = investmentSideAccountIds(db);
  const byPath = new Map<string, string>();
  const resolvePath = (path: string): string => {
    const cached = byPath.get(path);
    if (cached !== undefined) return cached;
    const id = categoryIdByPath(db, path);
    byPath.set(path, id);
    return id;
  };
  return (accountIds) => {
    if (accountIds.some((id) => accountTypes.get(id) === "credit")) {
      return resolvePath("Transfers > Credit Card Payment");
    }
    if (accountIds.some((id) => investmentSide.has(id))) {
      return resolvePath("Transfers > Investment Contribution");
    }
    return resolvePath("Transfers > Internal Transfer");
  };
}

/** Single-shot form of transferCategoryResolver, for one-row callers. */
export function transferCategoryIdFor(db: AppDatabase, accountIds: readonly string[]): string {
  return transferCategoryResolver(db)(accountIds);
}

/**
 * Every transfer-KIND category id. A row already carrying one already reads as
 * a transfer to analytics, and whatever labelled it — the detector, or
 * linkTransferPair with BOTH legs in hand — knew more than a one-account guess
 * can: re-stamping would downgrade "Credit Card Payment" to "Internal
 * Transfer". Callers marking a transfer use this to stamp only what is unmarked.
 */
export function transferKindCategoryIds(db: AppDatabase): Set<string> {
  return new Set(
    db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.kind, "transfer"))
      .all()
      .map((r) => r.id),
  );
}

/** A row still pointing at a transfer group it is no longer part of. */
export interface StaleTransferLeg {
  id: string;
  transferGroupId: string | null;
}

/**
 * Rows still pointing at `groupId` that are NOT among `keepIds` — a stale
 * counterpart left behind by a single-row Transfer-checkbox clear, or by a leg
 * that was deleted out from under its partner. Read them BEFORE mutating so
 * the caller can capture a lossless undo, then hand them to detachTransferLegs
 * inside its write transaction.
 *
 * Split in two on purpose: the read must see the pre-mutation state while the
 * write belongs in the caller's transaction.
 */
export function staleTransferLegs(
  db: AppDatabase,
  groupId: string,
  keepIds: readonly string[] = [],
): StaleTransferLeg[] {
  const stillLinked = and(
    eq(transactions.transferGroupId, groupId),
    ne(transactions.status, "superseded"),
  );
  return db
    .select({ id: transactions.id, transferGroupId: transactions.transferGroupId })
    .from(transactions)
    .where(keepIds.length === 0 ? stillLinked : and(stillLinked, notInArray(transactions.id, [...keepIds])))
    .all();
}

/** Detach them — link-only, so the undo rows carry transferGroupId and nothing else. */
export function detachTransferLegs(db: AppDatabase, legs: readonly StaleTransferLeg[]): void {
  for (const leg of legs) {
    db.update(transactions).set({ transferGroupId: null }).where(eq(transactions.id, leg.id)).run();
  }
}

/** The lossless inverse of detachTransferLegs (bulk-edit's applyUndoPatch restores it). */
export function detachUndoRows(legs: readonly StaleTransferLeg[]): BulkResult["undo"]["rows"] {
  return legs.map((leg) => ({ id: leg.id, prev: { transferGroupId: leg.transferGroupId } }));
}

/** Where a transfer leg sits and what it moved — all a group's SHAPE needs. */
export interface TransferLegShape {
  accountId: string;
  amountCents: number;
}

/**
 * A CANCELLED transfer: one group of exactly two legs, both in ONE account,
 * whose amounts cancel. The money left an account and came back to it, so it
 * moved nothing between accounts — it is not a departure, not an arrival from
 * nowhere, and not a pair the flow failed to resolve.
 *
 * The real one: Chase Checking, 2026-03-02, "Payment to Chase card ending in
 * 9805 03/02" −$115.00 and "Payment to Chase card ending in 9805 Cancelled"
 * +$115.00, both printed by the bank's CSV, recorded as one group on the
 * owner's answer of 2026-09-15.
 *
 * ⛔ Nothing in the app MAKES this shape — `linkTransferPair` and
 * `detectTransfers` both refuse two legs in one account — so a group like it
 * was written on purpose, and this is the one definition every reader asks.
 * Two zero legs cancel nothing; a fee or a partial return is not a
 * cancellation either, because something stayed out.
 */
export function isCancelledTransfer(legs: readonly TransferLegShape[]): boolean {
  if (legs.length !== 2) return false;
  const [a, b] = legs as readonly [TransferLegShape, TransferLegShape];
  return a.accountId === b.accountId && a.amountCents !== 0 && a.amountCents === -b.amountCents;
}

/**
 * Of `groupIds`, the cancelled transfers, each with the cents that went out and
 * came back. Reads every LIVE leg of each group — a superseded row never moved
 * money, the membership rule `staleTransferLegs` uses — so a caller holding one
 * month still sees a cancellation whose return posted in the next.
 */
export function cancelledTransfers(db: AppDatabase, groupIds: Iterable<string>): Map<string, number> {
  const ids = [...new Set(groupIds)];
  if (ids.length === 0) return new Map();
  const legs = db
    .select({ groupId: transactions.transferGroupId, accountId: transactions.accountId, amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(inArray(transactions.transferGroupId, ids), ne(transactions.status, "superseded")))
    .all();
  const byGroup = new Map<string, TransferLegShape[]>();
  for (const { groupId, accountId, amountCents } of legs) {
    if (groupId === null) continue; // the IN list already excludes these; narrows the type
    byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), { accountId, amountCents }]);
  }
  return new Map(
    [...byGroup]
      .filter(([, group]) => isCancelledTransfer(group))
      .map(([groupId, group]) => [groupId, Math.abs(group[0]!.amountCents)] as const),
  );
}

function prevOf(row: typeof transactions.$inferSelect): UndoFields {
  return {
    transferGroupId: row.transferGroupId,
    categoryId: row.categoryId,
    categorizationSource: row.categorizationSource,
    categorizationConfidence: row.categorizationConfidence,
    needsReview: row.needsReview,
  };
}

/** Pair two transactions as one transfer. The negative leg keys the group. */
export function linkTransferPair(db: AppDatabase, aId: string, bId: string): BulkResult {
  if (aId === bId) throw new Error("Pick two different transactions");
  const rows = db
    .select()
    .from(transactions)
    .where(inArray(transactions.id, [aId, bId]))
    .all();
  if (rows.length !== 2) throw new Error("Unknown transaction");
  const [a, b] = rows as [typeof rows[0], typeof rows[0]];
  for (const leg of [a, b]) {
    if (leg.status !== "active") throw new Error("Only active transactions can be linked");
    if (leg.transferGroupId !== null) throw new Error("One of these is already part of a transfer — unlink it first");
    // a split transaction can't be a transfer leg — its parts would be stranded
    if (hasSplits(db, leg.id)) throw new Error("One of these is split — remove the split before linking it as a transfer");
  }
  if (a.accountId === b.accountId) throw new Error("A transfer moves money between two different accounts");
  // explicit one-negative/one-positive — a zero-amount leg must never pass
  const outflow = a.amountCents < 0 ? a : b.amountCents < 0 ? b : null;
  const inflow = a.amountCents > 0 ? a : b.amountCents > 0 ? b : null;
  if (!outflow || !inflow) throw new Error("A transfer needs one outflow and one inflow");

  const groupId = outflow.id; // detector convention: the outflow leg keys the group
  const category = transferCategoryResolver(db)([a.accountId, b.accountId]);

  // a single-row Transfer-checkbox clear can leave a stale counterpart still
  // pointing at this outflow's id — detach it here (link-only, lossless undo)
  // so the re-minted group holds EXACTLY the two chosen legs
  const staleLegs = staleTransferLegs(db, groupId, [a.id, b.id]);

  const undo = {
    rows: [...[a, b].map((r) => ({ id: r.id, prev: prevOf(r) })), ...detachUndoRows(staleLegs)],
  };
  db.transaction((tx) => {
    detachTransferLegs(tx, staleLegs);
    for (const leg of [a, b]) {
      tx.update(transactions)
        .set({
          transferGroupId: groupId,
          categoryId: category,
          categorizationSource: "user",
          categorizationConfidence: 1,
          needsReview: false,
        })
        .where(eq(transactions.id, leg.id))
        .run();
    }
  });
  return { affected: 2 + staleLegs.length, undo };
}

/** Dissolve a transfer group — every leg reverts to an unlinked, uncategorized-by-this row. */
export function unlinkTransferGroup(db: AppDatabase, groupId: string): BulkResult {
  const rows = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.transferGroupId, groupId), ne(transactions.status, "superseded")))
    .all();
  if (rows.length === 0) throw new Error("Unknown transfer group");
  // capture ONLY the field this mutates — undoing an unlink must not clobber
  // category/review edits the user made in between
  const undo = { rows: rows.map((r) => ({ id: r.id, prev: { transferGroupId: r.transferGroupId } })) };
  db.transaction((tx) => {
    for (const row of rows) {
      // the row keeps its category — clearing the LINK must not fabricate an
      // uncategorized hole; the user can recategorize explicitly
      tx.update(transactions)
        .set({ transferGroupId: null })
        .where(eq(transactions.id, row.id))
        .run();
    }
  });
  return { affected: rows.length, undo };
}

export interface TransferCandidate {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  accountName: string;
  /** |amount(a)| − |amount(b)| in cents — 0 is a perfect mirror */
  amountDeltaCents: number;
  dayDelta: number;
}

/**
 * Counterpart candidates for manual pairing: opposite-signed active rows in
 * OTHER accounts within ±14 days, not already in a transfer, nearest amount
 * first. Wider than the detector's window on purpose — this is the human
 * override for what the heuristic missed.
 */
export function transferCandidates(db: AppDatabase, transactionId: string): TransferCandidate[] {
  const txn = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
  if (!txn) throw new Error("Unknown transaction");
  const from = addDays(txn.postedOn, -CANDIDATE_WINDOW_DAYS);
  const to = addDays(txn.postedOn, CANDIDATE_WINDOW_DAYS);
  const rows = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
      rawDescription: transactions.rawDescription,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.transferGroupId),
        ne(transactions.accountId, txn.accountId),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
        txn.amountCents < 0 ? gte(transactions.amountCents, 1) : lte(transactions.amountCents, -1),
      ),
    )
    .all();
  return rows
    .map((r) => ({
      id: r.id,
      postedOn: r.postedOn,
      amountCents: r.amountCents,
      description: r.normalizedDescription || r.rawDescription,
      accountName: r.accountName,
      amountDeltaCents: Math.abs(Math.abs(r.amountCents) - Math.abs(txn.amountCents)),
      dayDelta: Math.abs(diffDays(txn.postedOn, r.postedOn)),
    }))
    .sort((x, y) => x.amountDeltaCents - y.amountDeltaCents || x.dayDelta - y.dayDelta || x.id.localeCompare(y.id))
    .slice(0, CANDIDATE_LIMIT);
}

/** The other leg(s) of a row's transfer group — for the sheet's linked display. */
export function transferCounterparts(
  db: AppDatabase,
  transactionId: string,
): { groupId: string; legs: TransferCandidate[] } | null {
  const txn = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
  if (!txn || txn.transferGroupId === null) return null;
  const rows = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      normalizedDescription: transactions.normalizedDescription,
      rawDescription: transactions.rawDescription,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        eq(transactions.transferGroupId, txn.transferGroupId),
        ne(transactions.id, transactionId),
        ne(transactions.status, "superseded"),
      ),
    )
    .all();
  return {
    groupId: txn.transferGroupId,
    legs: rows.map((r) => ({
      id: r.id,
      postedOn: r.postedOn,
      amountCents: r.amountCents,
      description: r.normalizedDescription || r.rawDescription,
      accountName: r.accountName,
      amountDeltaCents: Math.abs(Math.abs(r.amountCents) - Math.abs(txn.amountCents)),
      dayDelta: Math.abs(diffDays(txn.postedOn, r.postedOn)),
    })),
  };
}

