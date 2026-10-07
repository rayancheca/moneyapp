import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import { recurringSeries, type Cadence } from "@/db/schema/recurring";
import { transactions, type CategorizationSource } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { deriveAnchorDay, stepFrom, stepPlan } from "@/lib/recurring-step";
import { loadCategoryIndex } from "./analytics";
import { applyUndoPatch, type UndoFields, type UndoPatch } from "./bulk-edit";
import {
  analyzeGroup,
  loadRecomputeCtx,
  recomputeSeriesStats,
  resolveMergeTarget,
} from "./recurring";
import { seriesCategoryIds } from "./series-category";
import { splitTxnIdsIn } from "./transaction-splits";

/**
 * User-owned recurring-series link actions (ux-overhaul-plan §4.2/§4.3). Each
 * stamps series_link_source='user' on the rows it touches and settles every
 * affected series' stats through recomputeSeriesStats, so a later detection run
 * finds the stored stats already equal to what it would compute — and changes
 * nothing. All work happens in one synchronous transaction.
 */

export interface AttachResult {
  attached: number;
  /** lossless inverse — restores each row's prior series AND link ownership, and the category of a row it filed */
  undo: UndoPatch;
}

/** A row's filing columns as they stood before a hand link — what its undo restores. */
interface FilingBefore {
  readonly id: string;
  readonly categoryId: string | null;
  readonly categorizationSource: CategorizationSource | null;
  readonly categorizationConfidence: number | null;
}

/**
 * Owner decision 2026-10-07 (§6A 47): linking a row to a series BY HAND files a row not filed yet under that series'
 * category; a row already filed keeps its own. Writes the filing and returns each filed row's prior columns, keyed by
 * id, for the caller's undo. Call it BEFORE the link is written: the series' category is the one it has when he acts.
 *
 * - The series' category is `seriesCategoryIds` — the ONE answer every surface names a series by (§6A 39): his
 *   `user_category_id` first, else the category its filed rows sit in. A series named by none, or only by the system
 *   "Uncategorized", files nothing: the row stays unfiled rather than being filed as unfiled.
 * - "Not filed" is `CategoryIndex.isUncategorized`: NULL or the system "Uncategorized" — one set (2026-09-03).
 * - Stamped `categorization_source = 'user'` with confidence 1, as every hand categorization is: attaching is his
 *   act, and filing follows the category he set. `needs_review` is NOT touched: duplicate review shares that flag,
 *   and linking a row to a series answers no duplicate question.
 * - A split row is skipped: its category is driven by its parts (as `bulkApply` skips it).
 *
 * 🔴 Why: his first lease payment and the $1,000.00 insurance prepayment were attached by hand to "Car lease" and
 * "Car insurance" (Car › Lease, Car › Car Insurance) and stayed Uncategorized — September's /spending read $1,695.04
 * Uncategorized and no Car, and the Car budget missed both.
 *
 * ⛔ Only a link that is his: detection's links (absorption, first posting, a created series' members) file nothing.
 */
function fileUnfiledUnderSeries(
  tx: AppDatabase,
  seriesId: string,
  rows: readonly FilingBefore[],
): Map<string, UndoFields> {
  const filedBefore = new Map<string, UndoFields>();
  const idx = loadCategoryIndex(tx);
  const unfiled = rows.filter((r) => idx.isUncategorized(r.categoryId));
  if (unfiled.length === 0) return filedBefore;
  const named = seriesCategoryIds(tx, idx, [seriesId]).get(seriesId);
  if (named === undefined || idx.isUncategorized(named)) return filedBefore;
  const split = splitTxnIdsIn(tx, unfiled.map((r) => r.id));
  const toFile = unfiled.filter((r) => !split.has(r.id));
  if (toFile.length === 0) return filedBefore;

  tx.update(transactions)
    .set({ categoryId: named, categorizationSource: "user", categorizationConfidence: 1 })
    .where(inArray(transactions.id, toFile.map((r) => r.id)))
    .run();
  for (const r of toFile) {
    filedBefore.set(r.id, {
      categoryId: r.categoryId,
      categorizationSource: r.categorizationSource,
      categorizationConfidence: r.categorizationConfidence,
    });
  }
  return filedBefore;
}

/**
 * Attaches transactions to a series by hand (a user-owned link). A row not filed yet is filed under the series'
 * category (`fileUnfiledUnderSeries`, §6A 47); the undo puts that back too.
 */
export function attachTransactions(
  db: AppDatabase,
  seriesId: string,
  transactionIds: readonly string[],
  today: string = todayIso(),
): AttachResult {
  if (transactionIds.length === 0) return { attached: 0, undo: { rows: [] } };
  const ctx = loadRecomputeCtx(db);
  let attached = 0;
  const undo: UndoPatch = { rows: [] };
  db.transaction((tx) => {
    const mergedById = new Map(
      tx
        .select({ id: recurringSeries.id, mergedIntoId: recurringSeries.mergedIntoId })
        .from(recurringSeries)
        .all()
        .map((s) => [s.id, s.mergedIntoId]),
    );
    if (!mergedById.has(seriesId)) throw new Error(`Unknown recurring series ${seriesId}`);
    // attach to the LIVE series — a merged-away id routes to its target so rows
    // never strand on a dead (ended) series (mirrors mergeSeries/detection)
    const target = resolveMergeTarget(seriesId, mergedById);

    // capture the series these rows are leaving (stats settle) AND each row's
    // prior link state (lossless undo — ownership must not drift to 'user')
    const rows = tx
      .select({
        id: transactions.id,
        recurringSeriesId: transactions.recurringSeriesId,
        seriesLinkSource: transactions.seriesLinkSource,
        categoryId: transactions.categoryId,
        categorizationSource: transactions.categorizationSource,
        categorizationConfidence: transactions.categorizationConfidence,
      })
      .from(transactions)
      .where(and(inArray(transactions.id, [...transactionIds]), eq(transactions.status, "active")))
      .all();
    // filed against the TARGET's category, before the link moves any row onto it
    const filedBefore = fileUnfiledUnderSeries(tx, target, rows);
    undo.rows = rows.map((r) => ({
      id: r.id,
      prev: {
        recurringSeriesId: r.recurringSeriesId,
        seriesLinkSource: r.seriesLinkSource,
        ...filedBefore.get(r.id),
      },
    }));
    const formerSeriesIds = new Set(
      rows
        .map((r) => r.recurringSeriesId)
        .filter((x): x is string => x !== null && x !== target),
    );

    const res = tx
      .update(transactions)
      .set({ recurringSeriesId: target, seriesLinkSource: "user" })
      .where(and(inArray(transactions.id, [...transactionIds]), eq(transactions.status, "active")))
      .run();
    attached = res.changes;

    recomputeSeriesStats(tx, target, today, ctx);
    for (const former of formerSeriesIds) recomputeSeriesStats(tx, former, today, ctx);
  });
  return { attached, undo };
}

export interface DetachResult {
  formerSeriesId: string | null;
  /** lossless inverse — restores the prior series AND link ownership */
  undo: UndoPatch;
}

/** Unlinks a transaction from its series (a user-owned decision). */
export function detachTransaction(
  db: AppDatabase,
  transactionId: string,
  today: string = todayIso(),
): DetachResult {
  const ctx = loadRecomputeCtx(db);
  let formerSeriesId: string | null = null;
  const undo: UndoPatch = { rows: [] };
  db.transaction((tx) => {
    const row = tx
      .select({
        id: transactions.id,
        recurringSeriesId: transactions.recurringSeriesId,
        seriesLinkSource: transactions.seriesLinkSource,
      })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get();
    if (!row) throw new Error(`Unknown transaction ${transactionId}`);
    formerSeriesId = row.recurringSeriesId;
    undo.rows = [
      { id: row.id, prev: { recurringSeriesId: row.recurringSeriesId, seriesLinkSource: row.seriesLinkSource } },
    ];
    tx.update(transactions)
      .set({ recurringSeriesId: null, seriesLinkSource: "user" })
      .where(eq(transactions.id, transactionId))
      .run();
    if (formerSeriesId) recomputeSeriesStats(tx, formerSeriesId, today, ctx);
  });
  return { formerSeriesId, undo };
}

export interface MergeResult {
  relinked: number;
  targetId: string;
}

/**
 * Merges `sourceId` INTO `targetId`: the source's active occurrences relink to
 * the (live) target as user-owned links, the source becomes `ended` with
 * mergedIntoId=target, and the target's stats re-derive over the union. Detection
 * later forward-maps the source's identity to the target and never resurrects it.
 */
export function mergeSeries(
  db: AppDatabase,
  sourceId: string,
  targetId: string,
  today: string = todayIso(),
): MergeResult {
  if (sourceId === targetId) throw new Error("Cannot merge a series into itself");
  const ctx = loadRecomputeCtx(db);
  let relinked = 0;
  let finalTarget = targetId;
  // A merge has no inverse: the source ends, its mergedIntoId is permanent, and
  // detection forward-maps its identity so it can never be resurrected. Rows
  // rejected inside the transaction leave a harmless spare restore point.
  withPreMutationSnapshot(db, "merge-series", () => {
    db.transaction((tx) => {
      const rows = tx
        .select({
          id: recurringSeries.id,
          status: recurringSeries.status,
          mergedIntoId: recurringSeries.mergedIntoId,
        })
        .from(recurringSeries)
        .all();
      const mergedById = new Map(rows.map((s) => [s.id, s.mergedIntoId]));
      const statusById = new Map(rows.map((s) => [s.id, s.status]));
      if (!mergedById.has(sourceId)) throw new Error(`Unknown recurring series ${sourceId}`);
      if (!mergedById.has(targetId)) throw new Error(`Unknown recurring series ${targetId}`);
      // A source that was already merged has no live occurrences to move; merging
      // it again would overwrite its mergedIntoId and split its history from its
      // future charges (an irreversible split-brain). Reject it.
      if (mergedById.get(sourceId) !== null || statusById.get(sourceId) === "ended") {
        throw new Error("Series has already been merged");
      }
      // the target may itself have been merged onward — follow to the live one
      finalTarget = resolveMergeTarget(targetId, mergedById);
      if (finalTarget === sourceId) throw new Error("Cannot merge a series into itself");
      // The target must be LIVE. Relinking onto a dismissed/ended series would move
      // the source's charges to a series the forecast/calendar/upcoming views all
      // exclude (status IN detected|confirmed) — the money would silently vanish.
      const targetStatus = statusById.get(finalTarget);
      if (targetStatus !== "detected" && targetStatus !== "confirmed") {
        throw new Error("Cannot merge into an inactive series");
      }

      const res = tx
        .update(transactions)
        .set({ recurringSeriesId: finalTarget, seriesLinkSource: "user" })
        .where(and(eq(transactions.recurringSeriesId, sourceId), eq(transactions.status, "active")))
        .run();
      relinked = res.changes;

      tx.update(recurringSeries)
        .set({ status: "ended", mergedIntoId: finalTarget })
        .where(eq(recurringSeries.id, sourceId))
        .run();
      recomputeSeriesStats(tx, finalTarget, today, ctx);
    });
  });
  return { relinked, targetId: finalTarget };
}

export interface CreateSeriesResult {
  /** created a new series, or attached to the identity's existing live series */
  mode: "created" | "attached";
  seriesId: string;
  name: string;
  /** rows now linked to the series by this call */
  linked: number;
  /** per-row prior link state — the lossless inverse of the links this call made */
  undo: UndoPatch;
}

/**
 * The thin-evidence fallback's cadence: the user asserted "recurring" and there
 * is not enough history to measure a gap, so the series is created `monthly`
 * with a null `intervalDaysAvg`.
 *
 * That combination makes stepPlan read it as CALENDAR monthly, so the anchor is
 * laid down by the same walk rather than by a 30-day hop: a charge seen on the
 * 31st would otherwise be anchored on the 2nd and, unlike under day stepping,
 * the calendar walk would repeat the 2nd every month for the life of the series
 * — `recomputeSeriesStats` cannot correct it, because it declines to write
 * anything while the evidence stays this thin (MIN_OCCURRENCES = 3, and
 * detection does not even link the second charge).
 *
 * The seed's day-of-month is also recorded as `anchor_day`, which closes the
 * residual this note used to carry. A seed on 2026-01-31 still STORES the clamp
 * 2026-02-28 — that part is unavoidable — but the walk no longer inherits it,
 * so the series returns to the 31st in March instead of sitting on the 28th
 * until three real charges re-derive it.
 *
 * One date is enough HERE, where it was not enough for detection: the user
 * typed this day on purpose. Below day 29 `deriveAnchorDay` declines anyway,
 * so a seed on the 28th is read as the 28th rather than guessed into month-end.
 */
const FALLBACK_CADENCE: Cadence = "monthly";

/**
 * The "Make recurring" button: promote a transaction into a CONFIRMED recurring
 * series. Identity follows detection's grouping exactly (merchant, else
 * account+normalized description), so detection later converges on this series
 * instead of duplicating it (§4.3):
 *   - identity already has a LIVE series (directly or via a merge chain) →
 *     attach the row there instead of duplicating;
 *   - identity's series is dismissed/ended → refuse with a revive hint (the
 *     user parked it; silently resurrecting would fight that decision);
 *   - otherwise create. Unlinked sibling rows join ONLY when the full set
 *     passes the same evidence bar detection uses (analyzeGroup); a thin
 *     pattern seeds a monthly series from the transaction alone — the user's
 *     assertion carries it, honestly marked by a null confidence.
 *
 * The SEED is always a member — even future-dated (a scheduled charge can't be
 * excluded from its own series; without this a phantom zero-member confirmed
 * series would project money while the clicked row stayed unlinked). Created
 * links are stamped `detected` ownership, NOT `user`: user-stamped rows leave
 * detection's grouping pool, which would stop the series from absorbing its
 * own future charges until three piled up. `detected` keeps absorption alive,
 * and the identity lookup guarantees re-grouping can only land on this series.
 */
export function createSeriesFromTransaction(
  db: AppDatabase,
  transactionId: string,
  today: string = todayIso(),
): CreateSeriesResult {
  const ctx = loadRecomputeCtx(db);
  let result: CreateSeriesResult | null = null;
  db.transaction((tx) => {
    const seed = tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        merchantId: transactions.merchantId,
        categoryId: transactions.categoryId,
        categorizationSource: transactions.categorizationSource,
        categorizationConfidence: transactions.categorizationConfidence,
        normalizedDescription: transactions.normalizedDescription,
        recurringSeriesId: transactions.recurringSeriesId,
        seriesLinkSource: transactions.seriesLinkSource,
        status: transactions.status,
      })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get();
    if (!seed) throw new Error(`Unknown transaction ${transactionId}`);
    if (seed.status !== "active") throw new Error("Only an active transaction can seed a series");
    if (seed.recurringSeriesId !== null) {
      throw new Error("This transaction already belongs to a recurring series");
    }
    if (!seed.merchantId && seed.normalizedDescription === "") {
      throw new Error("This transaction has no description to group by");
    }

    // detection's identity rule: merchant across accounts, else account+description
    const allSeries = tx.select().from(recurringSeries).all();
    const mergedById = new Map(allSeries.map((s) => [s.id, s.mergedIntoId]));
    const existing = seed.merchantId
      ? allSeries.find((s) => s.merchantId === seed.merchantId)
      : allSeries.find(
          (s) =>
            s.merchantId === null &&
            s.accountId === seed.accountId &&
            s.name === seed.normalizedDescription,
        );
    if (existing) {
      const targetId = resolveMergeTarget(existing.id, mergedById);
      const target = allSeries.find((s) => s.id === targetId)!;
      if (target.status !== "detected" && target.status !== "confirmed") {
        throw new Error(
          `A series for this pattern ("${target.name}") was dismissed or ended — revive it from the Recurring page instead`,
        );
      }
      // joining his row to a live series is his link — filed as an attach files it (§6A 47)
      const filedBefore = fileUnfiledUnderSeries(tx, targetId, [seed]);
      const undo: UndoPatch = {
        rows: [
          {
            id: seed.id,
            prev: { recurringSeriesId: null, seriesLinkSource: seed.seriesLinkSource, ...filedBefore.get(seed.id) },
          },
        ],
      };
      tx.update(transactions)
        .set({ recurringSeriesId: targetId, seriesLinkSource: "user" })
        .where(eq(transactions.id, seed.id))
        .run();
      recomputeSeriesStats(tx, targetId, today, ctx);
      result = { mode: "attached", seriesId: targetId, name: target.name, linked: 1, undo };
      return;
    }

    // unlinked siblings of the same identity (linked rows are never stolen)
    const siblingWhere = seed.merchantId
      ? eq(transactions.merchantId, seed.merchantId)
      : and(
          isNull(transactions.merchantId),
          eq(transactions.accountId, seed.accountId),
          eq(transactions.normalizedDescription, seed.normalizedDescription),
        );
    const group = tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        postedOn: transactions.postedOn,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        seriesLinkSource: transactions.seriesLinkSource,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, "active"),
          isNull(transactions.recurringSeriesId),
          lte(transactions.postedOn, today),
          siblingWhere,
        ),
      )
      .all();

    // the full set joins only when it passes detection's own evidence bar
    const stats = analyzeGroup(group);
    let members = stats ? group : group.filter((t) => t.id === seed.id);
    // the seed is ALWAYS a member — a future-dated seed falls outside the
    // ≤today sibling window but can't be excluded from its own series
    if (!members.some((t) => t.id === seed.id)) {
      members = [
        ...members,
        {
          id: seed.id,
          accountId: seed.accountId,
          postedOn: seed.postedOn,
          amountCents: seed.amountCents,
          categoryId: seed.categoryId,
          seriesLinkSource: seed.seriesLinkSource,
        },
      ];
    }
    const accountIds = new Set(members.map((t) => t.accountId));
    const name = seed.merchantId
      ? (ctx.merchantById.get(seed.merchantId)?.canonicalName ?? seed.normalizedDescription)
      : seed.normalizedDescription;
    const isTransferSeed = (() => {
      const cat = seed.categoryId ? ctx.categoryById.get(seed.categoryId) : undefined;
      const root = cat?.parentId ? ctx.categoryById.get(cat.parentId) : cat;
      return root?.kind === "transfer";
    })();

    const seriesId = tx
      .insert(recurringSeries)
      .values({
        name,
        merchantId: seed.merchantId,
        accountId: accountIds.size === 1 ? members[0]!.accountId : null,
        // user-asserted → confirmed; thin evidence stays honest via null confidence
        status: "confirmed",
        kind: isTransferSeed ? "transfer" : seed.amountCents > 0 ? "income" : "bill",
        cadence: FALLBACK_CADENCE,
        intervalDaysAvg: null,
        amountCentsAvg: seed.amountCents,
        toleranceDays: 3,
        nextExpectedOn: stepFrom(
          seed.postedOn,
          stepPlan(FALLBACK_CADENCE, null, deriveAnchorDay([seed.postedOn])),
          1,
        ),
        anchorDay: deriveAnchorDay([seed.postedOn]),
        nextExpectedAmountCents: seed.amountCents,
        confidence: null,
        lastMatchedOn: seed.postedOn,
      })
      .returning({ id: recurringSeries.id })
      .get().id;

    const undo: UndoPatch = {
      rows: members.map((t) => ({
        id: t.id,
        prev: { recurringSeriesId: null, seriesLinkSource: t.seriesLinkSource },
      })),
    };
    const res = tx
      .update(transactions)
      .set({ recurringSeriesId: seriesId, seriesLinkSource: "detected" })
      .where(inArray(transactions.id, members.map((t) => t.id)))
      .run();
    if (res.changes !== members.length) {
      throw new Error(`Series linking hit ${res.changes} rows, expected ${members.length}`);
    }
    // settle over the linked set — with real evidence this derives cadence,
    // amounts, next-expected, and kind exactly as detection would (§4.3)
    recomputeSeriesStats(tx, seriesId, today, ctx);
    result = { mode: "created", seriesId, name, linked: members.length, undo };
  });
  return result!;
}

export interface UndoCreationResult {
  unlinked: number;
  /** true when the series was already gone (a second Undo click is a no-op) */
  alreadyUndone: boolean;
}

/**
 * The lossless inverse of a just-created series: restore each linked row's
 * captured pre-creation link state (via the standard undo patch, so a prior
 * user detach-marker survives) and delete the series row. Tolerates a repeat
 * call (the series is already gone → no-op). Refuses when other series merged
 * into it (deletion would strand their forward-mapping) or when rows were
 * attached AFTER creation (those links aren't ours to destroy — detach first).
 */
export function undoSeriesCreation(
  db: AppDatabase,
  seriesId: string,
  undo: UndoPatch,
): UndoCreationResult {
  const series = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!series) return { unlinked: 0, alreadyUndone: true };
  const mergedInto = db
    .select({ id: recurringSeries.id })
    .from(recurringSeries)
    .where(eq(recurringSeries.mergedIntoId, seriesId))
    .all();
  if (mergedInto.length > 0) {
    throw new Error("Cannot undo — other series were merged into this one");
  }
  const unlinked = applyUndoPatch(db, undo);
  const remaining = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.recurringSeriesId, seriesId))
    .all();
  if (remaining.length > 0) {
    throw new Error("Rows were attached to this series since — detach them before undoing");
  }
  db.delete(recurringSeries).where(eq(recurringSeries.id, seriesId)).run();
  return { unlinked, alreadyUndone: false };
}
