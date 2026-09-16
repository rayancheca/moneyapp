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

/** Each lost leg claims one candidate: same account, posted day and amount first, then transaction day and amount. */
function claim(lost: readonly Kept[], candidates: readonly Row[], taken: Set<string>): Map<string, Row> | null {
  const claimed = new Map<string, Row>();
  const lenses: ((k: Kept, r: Row) => boolean)[] = [
    (k, r) => k.postedOn === r.postedOn,
    (k, r) => k.transactedOn !== null && k.transactedOn === r.transactedOn,
  ];
  for (const leg of lost) {
    let winner: Row | undefined;
    for (const sameDay of lenses) {
      winner = candidates
        .filter((r) => !taken.has(r.id) && r.accountId === leg.accountId && r.amountCents === leg.amountCents && sameDay(leg, r))
        .sort(
          (a, b) =>
            descriptionScore(b.normalizedDescription, leg.normalizedDescription) -
              descriptionScore(a.normalizedDescription, leg.normalizedDescription) || a.id.localeCompare(b.id),
        )[0];
      if (winner) break;
    }
    if (!winner) return null;
    taken.add(winner.id);
    claimed.set(leg.id, winner);
  }
  return claimed;
}

/**
 * Links each kept transfer again once every leg it lost is among `candidateIds` (rows an import just wrote, not yet in
 * a transfer). A transfer whose staying leg is gone, retired or linked again since is forgotten: the owner moved on.
 * The group is keyed as every transfer path keys it — by its one outflow, else by the first returning leg — and a
 * returning leg takes back the category the pair gave it. Returns the ids linked. Call it before categorization and
 * transfer detection, which would otherwise read the returning legs as unpaired rows.
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
      const claimed = claim(lost, candidates, new Set(taken));
      if (claimed === null) continue;
      for (const row of claimed.values()) taken.add(row.id);
      const members = [...(staying as Row[]), ...claimed.values()];
      const outflows = members.filter((m) => m.amountCents < 0);
      const key = outflows.length === 1 ? outflows[0]!.id : [...claimed.values()][0]!.id;
      for (const member of staying as Row[]) {
        tx.update(transactions).set({ transferGroupId: key, needsReview: false }).where(eq(transactions.id, member.id)).run();
      }
      for (const leg of lost) {
        const row = claimed.get(leg.id)!;
        const pairCategory =
          leg.categoryId !== null && categoryIds.has(leg.categoryId) && leg.categorizationSource !== null && PAIR_SOURCES.has(leg.categorizationSource);
        tx.update(transactions)
          .set({
            transferGroupId: key,
            needsReview: false,
            ...(pairCategory
              ? { categoryId: leg.categoryId, categorizationSource: leg.categorizationSource, categorizationConfidence: leg.categorizationConfidence }
              : {}),
          })
          .where(eq(transactions.id, row.id))
          .run();
      }
      linked.push(...members.map((m) => m.id));
      forget();
    }
  });
  return linked;
}
