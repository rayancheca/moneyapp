import { and, asc, eq, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { withPreMutationTransaction } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import type { CategoryKind } from "@/db/schema/categories";
import { recurringSeries, type Cadence, type SeriesKind } from "@/db/schema/recurring";
import { transactions, type CategorizationSource } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { deriveAnchorDay, stepFrom, stepPlan } from "@/lib/recurring-step";
import { formatCategoryPath } from "@/lib/category-path";
import { loadCategoryIndex, uncategorizedWhere, type CategoryIndex } from "./analytics";
import { applyUndoPatch, type UndoFields, type UndoPatch } from "./bulk-edit";
import { clearReviewIfSettled } from "./duplicate-lifecycle";
import { notUserOwned } from "./merchants";
import {
  analyzeGroup,
  loadRecomputeCtx,
  recomputeSeriesStats,
  resolveMergeTarget,
  type RecomputeCtx,
  type Tx,
} from "./recurring";
import { seriesCategoryIds } from "./series-category";
import { splitTxnIdsIn } from "./transaction-splits";

/**
 * User-owned recurring-series link actions (ux-overhaul-plan §4.2/§4.3). Each
 * stamps series_link_source='user' on the rows it touches and settles every
 * affected series' stats through recomputeSeriesStats, so a later detection run
 * finds the stored stats already equal to what it would compute — and changes
 * nothing. All work happens in one synchronous transaction.
 *
 * …and the filing rule they share with linking at import (`fileImportedLinks`),
 * which writes no link: it files what an import linked to a series he confirmed.
 */

/**
 * What a hand link filed (§6A 47 attach, §6A 54 merge): the series' category — printed as every surface prints a
 * category path — and how many rows not filed yet went under it. One shape for every hand link, so each toast names
 * its filing in the same words.
 */
export interface HandFiling {
  readonly categoryId: string;
  readonly categoryPath: string;
  readonly count: number;
}

export interface AttachResult {
  attached: number;
  /** lossless inverse — restores each row's prior series AND link ownership, and the category of a row it filed */
  undo: UndoPatch;
  /** the rows attaching filed under the series' category; null when it filed none */
  filed: HandFiling | null;
}

/** A row's filing columns as they stood before a hand link — what its undo restores — and the money it moves. */
interface FilingBefore {
  readonly id: string;
  readonly amountCents: number;
  readonly categoryId: string | null;
  readonly categorizationSource: CategorizationSource | null;
  readonly categorizationConfidence: number | null;
  readonly needsReview: boolean;
}

/**
 * Whether a row moving `amountCents` may be filed under a series of `seriesKind` named by a category of (top-level)
 * `categoryKind`. ⛔ Filing must never take money out of every figure:
 * - transfer-kind (series or category): a Transfers row with no partner leaves spending as an unpaired departure;
 * - money out onto income (series or category): analytics counts only money in on an Income row, so it vanishes;
 * - money in onto a bill or subscription: not a charge of that bill.
 */
function holdsMoney(seriesKind: SeriesKind, categoryKind: CategoryKind, amountCents: number): boolean {
  if (seriesKind === "transfer" || categoryKind === "transfer") return false;
  if ((seriesKind === "income" || categoryKind === "income") && amountCents <= 0) return false;
  if ((seriesKind === "bill" || seriesKind === "subscription") && amountCents >= 0) return false;
  return true;
}

/** What a hand link files: the series' category and the rows not filed yet it may hold (`planFiling`). */
interface FilingPlan {
  readonly categoryId: string;
  readonly rows: readonly FilingBefore[];
}

/** A filing plan and what it says it files — the one reading the write and the sentence about it both take. */
interface PlannedFiling {
  readonly plan: FilingPlan;
  readonly filing: HandFiling;
}

/** The series' half of the filing rule: the category it files under and the money it can hold. */
interface FilingTarget {
  readonly categoryId: string;
  readonly seriesKind: SeriesKind;
  readonly categoryKind: CategoryKind;
}

/** The series' half: null for a series named by no category, or only by the system "Uncategorized". */
function filingTargetOf(db: AppDatabase, idx: CategoryIndex, seriesId: string): FilingTarget | null {
  const series = db
    .select({ kind: recurringSeries.kind })
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .get();
  if (series === undefined) return null;
  return targetNamedBy(idx, seriesCategoryIds(db, idx, [seriesId]).get(seriesId), series.kind);
}

/** …from the category a series is named by (`seriesCategoryIds`) and its kind — one reading for every filing link. */
function targetNamedBy(idx: CategoryIndex, named: string | undefined, seriesKind: SeriesKind): FilingTarget | null {
  if (named === undefined || idx.isUncategorized(named)) return null;
  return { categoryId: named, seriesKind, categoryKind: idx.topLevelOf(named).kind };
}

/** The rows' half: of `rows`, those not filed yet that `target` can hold — never a split row. */
function rowsToFile(
  db: AppDatabase,
  idx: CategoryIndex,
  target: FilingTarget,
  rows: readonly FilingBefore[],
): FilingBefore[] {
  const unfiled = rows.filter((r) => idx.isUncategorized(r.categoryId));
  if (unfiled.length === 0) return [];
  const split = splitTxnIdsIn(db, unfiled.map((r) => r.id));
  return unfiled.filter((r) => !split.has(r.id) && holdsMoney(target.seriesKind, target.categoryKind, r.amountCents));
}

/** Filing `rows` under `target`, and what that files — null for no row to file. One shape for attach and merge. */
function plannedFiling(idx: CategoryIndex, target: FilingTarget, rows: readonly FilingBefore[]): PlannedFiling | null {
  if (rows.length === 0) return null;
  const { categoryId } = target;
  return {
    plan: { categoryId, rows },
    filing: { categoryId, categoryPath: categoryPathOf(idx, categoryId), count: rows.length },
  };
}

/**
 * Owner decision 2026-10-07 (§6A 47): linking a row to a series BY HAND files a row not filed yet under that series'
 * category; a row already filed keeps its own. ⚖️ 2026-10-08 (§6A 54): merging a series in is the same act for every
 * row it moves (`mergeFilings`). Returns what linking `rows` to `seriesId` would file, or null for nothing; it writes
 * nothing (`writeFiling` does). Read it BEFORE the link is written: the series' category is the one it has when he
 * acts.
 *
 * - The series' category is `seriesCategoryIds` — the ONE answer every surface names a series by (§6A 39): his
 *   `user_category_id` first, else the category its filed rows sit in. A series named by none, or only by the system
 *   "Uncategorized", files nothing: the row stays unfiled rather than being filed as unfiled.
 * - "Not filed" is `CategoryIndex.isUncategorized`: NULL or the system "Uncategorized" — one set (2026-09-03).
 * - Only money the series can hold (`holdsMoney`): never a transfer, never money out onto income, never money in
 *   onto a bill. Such a row is linked but stays unfiled.
 * - A split row is skipped: its category is driven by its parts (as `bulkApply` skips it).
 *
 * 🔴 Why: his first lease payment and the $1,000.00 insurance prepayment were attached by hand to "Car lease" and
 * "Car insurance" (Car › Lease, Car › Car Insurance) and stayed Uncategorized — September's /spending read $1,695.04
 * Uncategorized and no Car, and the Car budget missed both.
 *
 * ⛔ Only a link that is his — or an import's to a series he CONFIRMED (`fileImportedLinks`, ⚖️ default built, not
 * asked, 2026-10-29). Detection's links (Detect now's groups and its whole-ledger absorption, a created series'
 * members) and an import's link to a series he never confirmed file nothing: a detected series is the detector's
 * guess — PURA VIDA and YA-FIT were "subscriptions" by its count and are a café and a smoothie bar he eats at often
 * (`absorbIntoLiveSeries`) — so filing by one would move his money into a category nobody chose; and Detect now reaches
 * history nobody has looked at (his rule, 2026-09-14) with no report to name what it filed, where an import's trial
 * names its filing before --confirm (`importFilingLine`).
 */
function planFiling(db: AppDatabase, seriesId: string, rows: readonly FilingBefore[]): PlannedFiling | null {
  const idx = loadCategoryIndex(db);
  if (!rows.some((r) => idx.isUncategorized(r.categoryId))) return null;
  const target = filingTargetOf(db, idx, seriesId);
  if (target === null) return null;
  return plannedFiling(idx, target, rowsToFile(db, idx, target, rows));
}

/**
 * Who files: his own link as his — source 'user', as every hand categorization writes it — and an import's link to a
 * series he confirmed as `confirmed_series`, an engine's source, so his own filings stay his: a rule or a merchant
 * mapping he applies later may re-file the import's (`notUserOwned`), never his.
 */
type FilingSource = Extract<CategorizationSource, "user" | "confirmed_series">;

/**
 * Writes a filing plan as every hand categorization writes it (`bulkApply`, `setTransactionCategory`): source 'user'
 * (`FilingSource`: the import's link writes its own), confidence 1, `needs_review` cleared — linking is his act, and
 * filing follows the category he set. But the flag is cleared through `clearReviewIfSettled`, so a row still in an
 * open duplicate pair keeps it: filing a row answers no duplicate question. Returns each filed row's prior columns,
 * keyed by id, for an attach's undo (which restores the flag with the rest); a merge has no undo — its restore point
 * holds them — and neither has an import's filing: import-statements takes its restore point before it writes.
 */
function writeFiling(
  tx: AppDatabase,
  plan: FilingPlan | null,
  source: FilingSource = "user",
): Map<string, UndoFields> {
  const filedBefore = new Map<string, UndoFields>();
  if (plan === null) return filedBefore;
  tx.update(transactions)
    .set({ categoryId: plan.categoryId, categorizationSource: source, categorizationConfidence: 1 })
    .where(inArray(transactions.id, plan.rows.map((r) => r.id)))
    .run();
  clearReviewIfSettled(tx, plan.rows.filter((r) => r.needsReview).map((r) => r.id));
  for (const r of plan.rows) {
    filedBefore.set(r.id, {
      categoryId: r.categoryId,
      categorizationSource: r.categorizationSource,
      categorizationConfidence: r.categorizationConfidence,
      needsReview: r.needsReview,
    });
  }
  return filedBefore;
}

/**
 * Files `rows` as linking them to `seriesId` by hand files them (`planFiling`); returns their prior columns, for the
 * undo, and what it filed, for the toast — as a merge returns its own (`MergeResult.filed`).
 */
function fileUnfiledUnderSeries(
  tx: AppDatabase,
  seriesId: string,
  rows: readonly FilingBefore[],
): { filedBefore: Map<string, UndoFields>; filed: HandFiling | null } {
  const planned = planFiling(tx, seriesId, rows);
  return { filedBefore: writeFiling(tx, planned?.plan ?? null), filed: planned?.filing ?? null };
}

/**
 * ⚖️ default built, not asked (2026-10-29): what linking at import filed under one series he confirmed — a hand
 * filing's shape (`HandFiling`) with the series it filed for and the very rows, oldest first, so the import's report
 * names it (`importFilingLine`) and the trial prints it before --confirm.
 */
export interface ImportFiling extends HandFiling {
  readonly seriesId: string;
  readonly seriesName: string;
  readonly transactionIds: readonly string[];
}

/** A series he confirmed, as linking at import files under it: its name and the filing rule's series half. */
interface ConfirmedTarget extends FilingTarget {
  readonly seriesName: string;
}

/**
 * Every series he CONFIRMED that names a category to file under, keyed by id, in name order — `status = 'confirmed'`,
 * the one word that tells his series from the detector's: he pressed Confirm, made it recurring, or registered it.
 * ⛔ Read BEFORE linking at import writes a link (`linkRowsMadeActive`), as an attach reads the category before his link
 * (`planFiling`): a row the import links that is filed elsewhere would otherwise vote on the very category the series
 * files its unfiled rows under (`seriesCategoryIds` counts filed rows).
 */
export function importFilingTargets(db: AppDatabase): ReadonlyMap<string, ConfirmedTarget> {
  const idx = loadCategoryIndex(db);
  const named = seriesCategoryIds(db, idx);
  const confirmed = db
    .select({ id: recurringSeries.id, name: recurringSeries.name, kind: recurringSeries.kind })
    .from(recurringSeries)
    .where(eq(recurringSeries.status, "confirmed"))
    .orderBy(asc(recurringSeries.name), asc(recurringSeries.id))
    .all();
  return new Map(
    confirmed.flatMap((s) => {
      const target = targetNamedBy(idx, named.get(s.id), s.kind);
      return target === null ? [] : [[s.id, { ...target, seriesName: s.name }] as const];
    }),
  );
}

/**
 * ⚖️ default built, not asked (2026-10-29). Owner context: he does nothing by hand (2026-09-14: "im not attaching shit
 * by hand") — an import must land his pay attached AND filed. Of the rows an import-path operation made active
 * (`scope`), those now linked to a series he confirmed are filed as his own attach files them (§6A 47, `rowsToFile`:
 * not filed yet, never a split, never money the series cannot hold) under the category each had before the import
 * linked anything (`importFilingTargets`) — with two fences an engine needs that his own act does not: never a row
 * whose filing is his (`notUserOwned`: his own "Uncategorized" is his answer), never a leg of a transfer. Written as
 * the import's (`confirmed_series`); each series it filed under has its stats settled again, since the kind they derive
 * reads the rows' categories (`classifyKind`); and what it filed comes back one per series, for the report.
 *
 * A row in scope that arrives already linked — the carry of the read a re-read replaces, a link an un-import gave back
 * — is filed too: the import's filing never travels with a re-read (`engineCategoryCarry` leaves it out, as it leaves
 * every category an engine of the import derives again), so here is where the row that replaces it is filed again.
 *
 * 🔴 Measured on his ledger copy 2026-10-30, a trial of the Wells Fargo statement Sep 25 → Oct 26 on the copy from
 * before that import: the four +$1,141.92 payroll deposits and the off-cycle +$200.00 landed attached to "It America
 * LLC (weekly pay)" and filed nowhere, so settlement (`payDayRows`, which reads rows filed under Income) paid none of
 * their paydays — Earned vs banked read $7,156.60 of $23,983.20 (30%), "5 paydays have passed since the last deposit
 * on Sep 24" — until a guarded script filed them by hand (scripts/file-wells-fargo-october-2026-10-29.ts).
 */
export function fileImportedLinks(
  tx: Tx,
  targets: ReadonlyMap<string, ConfirmedTarget>,
  scope: ReadonlySet<string>,
  today: string,
  ctx: RecomputeCtx,
): ImportFiling[] {
  if (targets.size === 0 || scope.size === 0) return [];
  const idx = loadCategoryIndex(tx);
  const linked = tx
    .select({
      seriesId: transactions.recurringSeriesId,
      id: transactions.id,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      categorizationSource: transactions.categorizationSource,
      categorizationConfidence: transactions.categorizationConfidence,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        inArray(transactions.recurringSeriesId, [...targets.keys()]),
        uncategorizedWhere(idx),
        notUserOwned(),
        isNull(transactions.transferGroupId),
      ),
    )
    .orderBy(asc(transactions.postedOn), asc(transactions.id))
    .all()
    // the scope narrows which rows may be FILED, as it narrows which may be linked (`absorbIntoLiveSeries`)
    .filter((r) => scope.has(r.id));
  const filed: ImportFiling[] = [];
  for (const [seriesId, { seriesName, ...target }] of targets) {
    const rows = rowsToFile(tx, idx, target, linked.filter((r) => r.seriesId === seriesId));
    const planned = plannedFiling(idx, target, rows);
    if (planned === null) continue;
    writeFiling(tx, planned.plan, "confirmed_series");
    recomputeSeriesStats(tx, seriesId, today, ctx);
    filed.push({ ...planned.filing, seriesId, seriesName, transactionIds: planned.plan.rows.map((r) => r.id) });
  }
  return filed;
}

/**
 * Attaches transactions to a series by hand (a user-owned link). A row not filed yet is filed under the series'
 * category (`fileUnfiledUnderSeries`, §6A 47); the undo puts that back too, and `filed` says what it filed.
 */
export function attachTransactions(
  db: AppDatabase,
  seriesId: string,
  transactionIds: readonly string[],
  today: string = todayIso(),
): AttachResult {
  if (transactionIds.length === 0) return { attached: 0, undo: { rows: [] }, filed: null };
  const ctx = loadRecomputeCtx(db);
  let attached = 0;
  let filed: HandFiling | null = null;
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
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        categorizationSource: transactions.categorizationSource,
        categorizationConfidence: transactions.categorizationConfidence,
        needsReview: transactions.needsReview,
      })
      .from(transactions)
      .where(and(inArray(transactions.id, [...transactionIds]), eq(transactions.status, "active")))
      .all();
    // filed against the TARGET's category, before the link moves any row onto it
    const filing = fileUnfiledUnderSeries(tx, target, rows);
    const { filedBefore } = filing;
    filed = filing.filed;
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
  return { attached, undo, filed };
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
  /** the rows the merge filed under the target's category; null when it filed none */
  filed: HandFiling | null;
}

/** What the merge confirmation told him it would file, sent with his press (§6A 54): the category and the count. */
export interface ShownFiling {
  readonly categoryId: string;
  readonly count: number;
}

/**
 * What a merge says when it would file other than the confirmation showed — and it then writes nothing. The page
 * re-reads on it, so the confirmation he reads again names what the merge files now.
 */
export const MERGE_FILING_CHANGED =
  "Nothing was merged — what it would file has changed since you opened it. Read it again before you merge.";

/**
 * Whether the merge files what he was shown: the same category and the same count — or nothing, as he was told. The
 * category by id: one renamed in between is still the category he chose.
 */
function filesAsShown(shown: ShownFiling | null, filing: HandFiling | null): boolean {
  if (shown === null || filing === null) return shown === filing;
  return shown.categoryId === filing.categoryId && shown.count === filing.count;
}

/** A category's path as every surface prints it (`formatCategoryPath`); an unknown id throws. */
function categoryPathOf(idx: CategoryIndex, id: string): string {
  const node = idx.byId.get(id);
  if (node === undefined) throw new Error(`Unknown category ${id}`);
  return formatCategoryPath(node.parentId === null ? null : idx.byId.get(node.parentId)?.name, node.name);
}

/** The rows merging `sourceIds` moves: their ACTIVE rows — the one set the merge relinks and files. */
function movedByMerge(sourceIds: readonly string[]): SQL {
  return and(inArray(transactions.recurringSeriesId, [...sourceIds]), eq(transactions.status, "active"))!;
}

/**
 * Per source, what merging it into `targetId` files — absent for a source that files nothing. The target is followed
 * to its LIVE series, as the merge links there; its category is read before any row moves (`filingTargetOf`), and each
 * source's rows go through the attach rule's own row half (`rowsToFile`).
 */
function mergePlans(db: AppDatabase, targetId: string, sourceIds: readonly string[]): Map<string, PlannedFiling> {
  const out = new Map<string, PlannedFiling>();
  if (sourceIds.length === 0) return out;
  const mergedById = new Map(
    db
      .select({ id: recurringSeries.id, mergedIntoId: recurringSeries.mergedIntoId })
      .from(recurringSeries)
      .all()
      .map((s) => [s.id, s.mergedIntoId]),
  );
  const idx = loadCategoryIndex(db);
  const target = filingTargetOf(db, idx, resolveMergeTarget(targetId, mergedById));
  if (target === null) return out;
  const unfiled = db
    .select({
      seriesId: transactions.recurringSeriesId,
      id: transactions.id,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      categorizationSource: transactions.categorizationSource,
      categorizationConfidence: transactions.categorizationConfidence,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(and(movedByMerge(sourceIds), uncategorizedWhere(idx)))
    .all();
  for (const sourceId of sourceIds) {
    const rows = rowsToFile(db, idx, target, unfiled.filter((r) => r.seriesId === sourceId));
    const planned = plannedFiling(idx, target, rows);
    if (planned !== null) out.set(sourceId, planned);
  }
  return out;
}

/**
 * ⚖️ Owner decision 2026-10-08 (§6A 54): what merging each of `sourceIds` into `targetId` would file — the reading the
 * merge confirmation names BEFORE he presses ("N not filed yet will be filed under …"), and the one `mergeSeries`
 * writes by, so the sentence cannot promise a count the merge does not file. Absent for a source that files nothing.
 */
export function mergeFilings(
  db: AppDatabase,
  targetId: string,
  sourceIds: readonly string[],
): Map<string, HandFiling> {
  return new Map([...mergePlans(db, targetId, sourceIds)].map(([id, p]) => [id, p.filing]));
}

/**
 * The merge, read before it writes: its refusals, the LIVE target it links to, and what it files — throwing for a
 * merge it refuses. `shown` is what the confirmation named; a merge that would file anything else is refused
 * (`MERGE_FILING_CHANGED`). Undefined only for a caller with no confirmation (a script; a test of the mechanics) — the
 * page's action always sends it, its schema requires it.
 */
function readMerge(
  db: AppDatabase,
  sourceId: string,
  targetId: string,
  shown: ShownFiling | null | undefined,
): { finalTarget: string; planned: PlannedFiling | null } {
  const rows = db
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
  const finalTarget = resolveMergeTarget(targetId, mergedById);
  if (finalTarget === sourceId) throw new Error("Cannot merge a series into itself");
  // The target must be LIVE. Relinking onto a dismissed/ended series would move
  // the source's charges to a series the forecast/calendar/upcoming views all
  // exclude (status IN detected|confirmed) — the money would silently vanish.
  const targetStatus = statusById.get(finalTarget);
  if (targetStatus !== "detected" && targetStatus !== "confirmed") {
    throw new Error("Cannot merge into an inactive series");
  }
  // filed against the target's category BEFORE the relink moves the source's filed rows onto it
  const planned = mergePlans(db, finalTarget, [sourceId]).get(sourceId) ?? null;
  if (shown !== undefined && !filesAsShown(shown, planned?.filing ?? null)) throw new Error(MERGE_FILING_CHANGED);
  return { finalTarget, planned };
}

/**
 * Merges `sourceId` INTO `targetId`: the source's active occurrences relink to
 * the (live) target as user-owned links, the source becomes `ended` with
 * mergedIntoId=target, and the target's stats re-derive over the union. Detection
 * later forward-maps the source's identity to the target and never resurrects it.
 *
 * ⚖️ 2026-10-08 (§6A 54): a merge is his link for every row it moves, so a row not filed yet is filed under the
 * TARGET's category as attaching files it (`mergeFilings`, read before the relink). There is no undo button for a
 * merge; the restore point below holds every row as it was, filing included.
 *
 * ⚖️ 2026-10-08 (§6A 54): `shown` is what the confirmation told him it would file. 🔴 Review of §6A 54: the
 * confirmation was read when the page rendered and the merge re-read when he pressed, and nothing checked they still
 * agreed — a row filed or unfiled in another tab, or the target named by another category, and the merge filed what
 * he was never shown. It now refuses, writing nothing (`readMerge`).
 */
export function mergeSeries(
  db: AppDatabase,
  sourceId: string,
  targetId: string,
  today: string = todayIso(),
  shown?: ShownFiling | null,
): MergeResult {
  if (sourceId === targetId) throw new Error("Cannot merge a series into itself");
  // ⛔ A refused merge writes nothing — a spare restore point would push his oldest out of the twelve kept. Refused here
  // before the restore point is taken; read again inside the write below, the one reading the merge writes by, where a
  // refusal (a write landed while the restore point was taken) rolls back and takes the restore point back with it.
  readMerge(db, sourceId, targetId, shown);
  const ctx = loadRecomputeCtx(db);
  // A merge has no inverse: the source ends, its mergedIntoId is permanent, and
  // detection forward-maps its identity so it can never be resurrected.
  return withPreMutationTransaction(db, "merge-series", (tx) => {
    const read = readMerge(tx, sourceId, targetId, shown);
    const finalTarget = read.finalTarget;
    writeFiling(tx, read.planned?.plan ?? null);

    const res = tx
      .update(transactions)
      .set({ recurringSeriesId: finalTarget, seriesLinkSource: "user" })
      .where(movedByMerge([sourceId]))
      .run();

    tx.update(recurringSeries)
      .set({ status: "ended", mergedIntoId: finalTarget })
      .where(eq(recurringSeries.id, sourceId))
      .run();
    recomputeSeriesStats(tx, finalTarget, today, ctx);
    return { relinked: res.changes, targetId: finalTarget, filed: read.planned?.filing ?? null };
  });
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
  /** what joining a live series filed, as attaching files (§6A 47); null when it filed none — and when it created */
  filed: HandFiling | null;
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
        needsReview: transactions.needsReview,
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
      const { filedBefore, filed } = fileUnfiledUnderSeries(tx, targetId, [seed]);
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
      result = { mode: "attached", seriesId: targetId, name: target.name, linked: 1, undo, filed };
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
    result = { mode: "created", seriesId, name, linked: members.length, undo, filed: null };
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
