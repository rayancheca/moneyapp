import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { unimportedTransferLegs } from "@/db/schema/unimported-transfer-legs";
import { descriptionScore } from "@/lib/description-score";
import { parsedFromFile } from "./attached-rows";

/**
 * A transfer an un-import takes apart, linked again when the lines it lost are imported again
 * (`unimported_transfer_legs`).
 *
 * 🔴 Un-importing a statement unlinked the partner of every transfer leg it deleted (`legsLeftAloneBy`), and a
 * re-import of the same bytes never linked the pair again: detection pairs only what it can prove, and the owner links
 * by hand exactly the pairs it cannot. The returning leg also lost the transfer category the pair gave it, so a card
 * payment counted as spending. Measured on a copy of the real ledger, 2026-09-16: a round trip of
 * 20260812-statements-3522-.pdf lost 7 pairs (Venture X $11,476.31, Chase Sapphire $1,300.00 and $199.56, Robinhood
 * Cash $1,320.00, …) and put $12,975.87 of July card payments into "Uncategorized" spending.
 *
 * The transfer is kept by its old group: each leg the un-import deletes by its content (the columns an import matches a
 * line by, and the category the pair gave it), each leg that stays by its row. A transfer that keeps two legs outside
 * the file is still a transfer and is not kept.
 *
 * 🔴 …and a leg kept by its row was lost with its own file. The first un-import unlinks the partner, so un-importing
 * the partner's file found it in no transfer and kept nothing, and the next import found the kept row gone and dropped
 * the record. Measured on a copy of the real ledger, 2026-09-16: un-importing 20260812-statements-3522-.pdf and
 * Statement_082026_4208.pdf, then importing both again, took two-leg groups 757 -> 755 and left Chase Checking's
 * $11,476.31 and $115.17 Venture X payments uncategorized. A kept leg whose row an un-import deletes is kept by its
 * content from then on, and a leg that comes back before the others waits by its row.
 */

const GROUP_CHUNK = 500;
/** a category the pair gave its leg: set by the owner's link, or by detection's */
const PAIR_SOURCES = new Set(["user", "transfer_detect"]);

type Row = typeof transactions.$inferSelect;

function liveLegs(tx: AppDatabase, groupIds: readonly string[]): Row[] {
  const legs: Row[] = [];
  for (let i = 0; i < groupIds.length; i += GROUP_CHUNK) {
    legs.push(
      ...tx
        .select()
        .from(transactions)
        .where(and(inArray(transactions.transferGroupId, groupIds.slice(i, i + GROUP_CHUNK)), ne(transactions.status, "superseded")))
        .all(),
    );
  }
  return legs;
}

/**
 * Keeps each transfer the un-import of `importFileId` takes apart. Call it inside the un-import's transaction, after
 * the rows filed by hand are detached and before any partner is unlinked or any row deleted — the rows naming the
 * groups are still there to be read.
 */
export function rememberTransfersTakenApart(tx: AppDatabase, importFileId: string): void {
  keepStayingLegsByContent(tx, importFileId);
  const doomed = tx
    .select({ id: transactions.id, groupId: transactions.transferGroupId })
    .from(transactions)
    .where(and(parsedFromFile(importFileId), ne(transactions.status, "superseded"), isNotNull(transactions.transferGroupId)))
    .all();
  if (doomed.length === 0) return;
  const doomedIds = new Set(doomed.map((d) => d.id));
  const byGroup = new Map<string, Row[]>();
  for (const leg of liveLegs(tx, [...new Set(doomed.map((d) => d.groupId!))])) {
    byGroup.set(leg.transferGroupId!, [...(byGroup.get(leg.transferGroupId!) ?? []), leg]);
  }
  for (const [groupId, legs] of byGroup) {
    const staying = legs.filter((l) => !doomedIds.has(l.id));
    if (staying.length >= 2) continue;
    tx.insert(unimportedTransferLegs)
      .values(
        legs.map((l) => ({
          transferGroupId: groupId,
          transactionId: doomedIds.has(l.id) ? null : l.id,
          accountId: l.accountId,
          postedOn: l.postedOn,
          transactedOn: l.transactedOn,
          amountCents: l.amountCents,
          normalizedDescription: l.normalizedDescription,
          categoryId: doomedIds.has(l.id) ? l.categoryId : null,
          categorizationSource: doomedIds.has(l.id) ? l.categorizationSource : null,
          categorizationConfidence: doomedIds.has(l.id) ? l.categorizationConfidence : null,
        })),
      )
      .run();
  }
}

type Kept = typeof unimportedTransferLegs.$inferSelect;

/**
 * A kept transfer names a leg that stayed by its row. When that row's file is un-imported, or retired by a re-read at
 * a new parser version, the leg is kept by its content instead, with its category — unless the row was retired or
 * linked elsewhere before, which ends the kept transfer (`relinkReturningTransfers` reads the same). Call it before
 * the rows are deleted or retired.
 */
export function keepStayingLegsByContent(tx: AppDatabase, importFileId: string): void {
  const kept = tx.select().from(unimportedTransferLegs).where(isNotNull(unimportedTransferLegs.transactionId)).all();
  if (kept.length === 0) return;
  const doomed = new Map(
    tx
      .select()
      .from(transactions)
      .where(parsedFromFile(importFileId))
      .all()
      .map((r) => [r.id, r] as const),
  );
  const ended = new Set<string>();
  for (const leg of kept) {
    const row = doomed.get(leg.transactionId!);
    if (row === undefined) continue;
    if (row.status === "superseded" || row.transferGroupId !== null) {
      ended.add(leg.transferGroupId);
      continue;
    }
    tx.update(unimportedTransferLegs)
      .set({
        transactionId: null,
        accountId: row.accountId,
        postedOn: row.postedOn,
        transactedOn: row.transactedOn,
        amountCents: row.amountCents,
        normalizedDescription: row.normalizedDescription,
        categoryId: row.categoryId,
        categorizationSource: row.categorizationSource,
        categorizationConfidence: row.categorizationConfidence,
      })
      .where(eq(unimportedTransferLegs.id, leg.id))
      .run();
  }
  for (const groupId of ended) tx.delete(unimportedTransferLegs).where(eq(unimportedTransferLegs.transferGroupId, groupId)).run();
}

/**
 * A kept transfer that waits by `fromId` waits by `toId` from now on: a re-read at a new parser version carried the
 * row's money, and everything on it, onto `toId` (`landCarry`, services/import/service.ts).
 *
 * 🔴 A leg waiting by its row is one that stayed when its partner's file was un-imported, and only a PARSED row's
 * record is kept by content when its file is re-read (`keepStayingLegsByContent`). A row filed by hand is not the
 * file's to retire, and a re-read that still prints its line moves it — marker, note, links — onto the row it writes,
 * leaving the record naming the retired row: importing the partner's statement again then forgot the transfer, and the
 * owner's hand-linked pair stayed apart.
 */
export function moveWaitingLeg(tx: AppDatabase, fromId: string, toId: string): void {
  tx.update(unimportedTransferLegs).set({ transactionId: toId }).where(eq(unimportedTransferLegs.transactionId, fromId)).run();
}

/**
 * Each lost leg claims one candidate: same account, posted day and amount first, then transaction day and amount. A leg
 * no candidate matches is left out of the result.
 */
function claim(lost: readonly Kept[], candidates: readonly Row[], taken: ReadonlySet<string>): Map<string, Row> {
  const held = new Set(taken);
  const claimed = new Map<string, Row>();
  const lenses: ((k: Kept, r: Row) => boolean)[] = [
    (k, r) => k.postedOn === r.postedOn,
    (k, r) => k.transactedOn !== null && k.transactedOn === r.transactedOn,
  ];
  for (const leg of lost) {
    let winner: Row | undefined;
    for (const sameDay of lenses) {
      winner = candidates
        .filter((r) => !held.has(r.id) && r.accountId === leg.accountId && r.amountCents === leg.amountCents && sameDay(leg, r))
        .sort(
          (a, b) =>
            descriptionScore(b.normalizedDescription, leg.normalizedDescription) -
              descriptionScore(a.normalizedDescription, leg.normalizedDescription) || a.id.localeCompare(b.id),
        )[0];
      if (winner) break;
    }
    if (!winner) continue;
    held.add(winner.id);
    claimed.set(leg.id, winner);
  }
  return claimed;
}

/** The category a kept leg takes back when its line returns: the one the pair gave it, if that category still exists. */
function pairCategoryOf(leg: Kept, categoryIds: ReadonlySet<string>): Partial<Row> {
  const isPairs =
    leg.categoryId !== null && categoryIds.has(leg.categoryId) && leg.categorizationSource !== null && PAIR_SOURCES.has(leg.categorizationSource);
  return isPairs
    ? { categoryId: leg.categoryId, categorizationSource: leg.categorizationSource, categorizationConfidence: leg.categorizationConfidence }
    : {};
}

/**
 * Links each kept transfer again once every leg it lost is back among `candidateIds` (rows an import just wrote, not
 * yet in a transfer). A leg that comes back before the others takes back its category and waits by its row for them
 * (the files of a transfer's two legs, imported again one at a time). A transfer whose kept row is gone, retired or
 * linked again since is forgotten: the owner moved on. The group is keyed as every transfer path keys it — by its one
 * outflow, else by the first returning leg. Returns the ids linked. Call it before categorization and transfer
 * detection, which would otherwise read the returning legs as unpaired rows.
 */
export function relinkReturningTransfers(db: AppDatabase, candidateIds: readonly string[]): string[] {
  const kept = db.select().from(unimportedTransferLegs).all();
  if (kept.length === 0) return [];
  const candidates: Row[] = [];
  for (let i = 0; i < candidateIds.length; i += GROUP_CHUNK) {
    candidates.push(
      ...db
        .select()
        .from(transactions)
        .where(and(inArray(transactions.id, candidateIds.slice(i, i + GROUP_CHUNK)), ne(transactions.status, "superseded")))
        .all()
        .filter((r) => r.transferGroupId === null),
    );
  }
  const categoryIds = new Set(db.select({ id: categories.id }).from(categories).all().map((c) => c.id));
  const byGroup = new Map<string, Kept[]>();
  for (const k of kept) byGroup.set(k.transferGroupId, [...(byGroup.get(k.transferGroupId) ?? []), k]);
  const linked: string[] = [];
  const taken = new Set<string>();
  db.transaction((tx) => {
    for (const [groupId, legs] of byGroup) {
      const forget = () => tx.delete(unimportedTransferLegs).where(eq(unimportedTransferLegs.transferGroupId, groupId)).run();
      const staying = legs.flatMap((k) => {
        if (k.transactionId === null) return [];
        const row = tx.select().from(transactions).where(eq(transactions.id, k.transactionId)).get();
        return [row ?? null];
      });
      if (staying.some((r) => r === null || r.status === "superseded" || r.transferGroupId !== null)) {
        forget();
        continue;
      }
      if (candidates.length === 0) continue;
      const lost = legs.filter((k) => k.transactionId === null);
      const claimed = claim(lost, candidates, taken);
      if (claimed.size === 0) continue;
      for (const [legId, row] of claimed) {
        taken.add(row.id);
        const category = pairCategoryOf(legs.find((k) => k.id === legId)!, categoryIds);
        if (Object.keys(category).length > 0) tx.update(transactions).set(category).where(eq(transactions.id, row.id)).run();
      }
      if (claimed.size < lost.length) {
        // the others are still out: a returned leg waits by its row, its category given back already
        for (const [legId, row] of claimed) {
          tx.update(unimportedTransferLegs)
            .set({ transactionId: row.id, categoryId: null, categorizationSource: null, categorizationConfidence: null })
            .where(eq(unimportedTransferLegs.id, legId))
            .run();
        }
        continue;
      }
      const members = [...(staying as Row[]), ...claimed.values()];
      const outflows = members.filter((m) => m.amountCents < 0);
      const key = outflows.length === 1 ? outflows[0]!.id : [...claimed.values()][0]!.id;
      for (const member of members) {
        tx.update(transactions).set({ transferGroupId: key, needsReview: false }).where(eq(transactions.id, member.id)).run();
      }
      linked.push(...members.map((m) => m.id));
      forget();
    }
  });
  return linked;
}
