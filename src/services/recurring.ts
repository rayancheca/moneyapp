import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import {
  recurringSeries,
  type Cadence,
  type SeriesKind,
  type SeriesStatus,
} from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates, diffDays, todayIso } from "@/lib/dates";

/**
 * A drizzle transaction handle. Detection and the user-link services
 * (recurring-links.ts) share `recomputeSeriesStats` inside one transaction, so
 * a series' stored statistics always settle to the exact value a fresh
 * detection run would compute — the invariant that makes attach/unlink/merge
 * survive the next `detectRecurringSeries` untouched (§4.3).
 */
export type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/**
 * Recurring-series detection (master-plan Phase 6): statistics, not a black
 * box. Every stat that drives a decision (median gap, amount mean/stddev,
 * confidence) is stored on recurring_series so the UI can show the math.
 *
 * Grouping: merchantId, falling back to (accountId, normalizedDescription)
 * for merchant-less rows (the cash-salary case is covered because the seeded
 * rule assigns the synthetic "Employer (cash)" merchant).
 */

export const MIN_OCCURRENCES = 3;

/** Population stddev/|mean| must stay under this for a stable amount. */
export const AMOUNT_STABILITY_CV_MAX = 0.2;

/** Median-gap buckets (days), fixed by the master plan. */
const CADENCE_BUCKETS: Record<Cadence, { min: number; max: number }> = {
  weekly: { min: 5, max: 9 },
  biweekly: { min: 12, max: 16 },
  semimonthly: { min: 14, max: 17 },
  monthly: { min: 28, max: 33 },
  quarterly: { min: 85, max: 97 },
  annual: { min: 350, max: 380 },
};

const CADENCE_TOLERANCE_DAYS: Record<Cadence, number> = {
  weekly: 2,
  biweekly: 3,
  semimonthly: 3,
  monthly: 3,
  quarterly: 7,
  annual: 14,
};

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("median of empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function populationStddev(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("stddev of empty list");
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Semimonthly discriminator: occurrences cluster on exactly two days-of-month
 * (e.g. 1st + 15th). Biweekly dates drift across the month, so they never
 * collapse to two clusters. Adjacent days (±1) merge into one cluster to
 * tolerate weekend/holiday posting shifts.
 */
export function isDayOfMonthBimodal(daysOfMonth: readonly number[]): boolean {
  const distinct = [...new Set(daysOfMonth)].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const d of distinct) {
    const last = clusters.at(-1);
    if (last && d - last.at(-1)! <= 1) last.push(d);
    else clusters.push([d]);
  }
  if (clusters.length !== 2) return false;
  // both clusters must recur — a single stray posting is not a mode
  const counts = clusters.map((c) =>
    daysOfMonth.filter((d) => c.includes(d)).length,
  );
  return counts.every((n) => n >= 2);
}

/**
 * Median inter-occurrence gap → cadence bucket. In the biweekly/semimonthly
 * overlap (14–16d) the day-of-month bimodality decides; when it is too close
 * to call, biweekly wins (master-plan Phase 6).
 */
export function fitCadence(medianGap: number, daysOfMonth: readonly number[]): Cadence | null {
  const inBucket = (c: Cadence) =>
    medianGap >= CADENCE_BUCKETS[c].min && medianGap <= CADENCE_BUCKETS[c].max;

  if (inBucket("weekly")) return "weekly";
  if (inBucket("monthly")) return "monthly";
  if (inBucket("quarterly")) return "quarterly";
  if (inBucket("annual")) return "annual";
  if (inBucket("semimonthly") && isDayOfMonthBimodal(daysOfMonth)) return "semimonthly";
  if (inBucket("biweekly")) return "biweekly"; // too close to call → prefer biweekly
  return null;
}

interface GroupTxn {
  id: string;
  accountId: string;
  postedOn: string;
  amountCents: number;
  merchantId: string | null;
  categoryId: string | null;
  normalizedDescription: string;
}

/** The only fields the statistics need — analyzeGroup stays a pure function. */
export interface AnalyzableTxn {
  id: string;
  postedOn: string;
  amountCents: number;
}

export interface GroupStats {
  cadence: Cadence;
  medianGapDays: number;
  intervalDaysAvg: number;
  amountCentsAvg: number;
  amountCentsStddev: number;
  toleranceDays: number;
  confidence: number;
  nextExpectedOn: string;
  nextExpectedAmountCents: number;
  lastMatchedOn: string;
}

/**
 * Pure statistics for one candidate group (exported for unit testing).
 * Returns null when the group is not a series: too few occurrences, median
 * gap outside every cadence bucket, or unstable amounts.
 */
export function analyzeGroup(txns: readonly AnalyzableTxn[]): GroupStats | null {
  if (txns.length < MIN_OCCURRENCES) return null;
  const sorted = [...txns].sort(
    (a, b) => compareDates(a.postedOn, b.postedOn) || a.id.localeCompare(b.id),
  );

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(diffDays(sorted[i - 1]!.postedOn, sorted[i]!.postedOn));
  }
  const medianGap = median(gaps);
  const daysOfMonth = sorted.map((t) => Number(t.postedOn.slice(8, 10)));
  const cadence = fitCadence(medianGap, daysOfMonth);
  if (!cadence) return null;

  const amounts = sorted.map((t) => t.amountCents);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const stddev = populationStddev(amounts);
  const allIdentical = amounts.every((a) => a === amounts[0]);
  // stability: population stddev/|mean| ≤ 0.2, OR all amounts identical
  if (!allIdentical && (mean === 0 || stddev / Math.abs(mean) > AMOUNT_STABILITY_CV_MAX)) {
    return null;
  }
  const cv = allIdentical ? 0 : stddev / Math.abs(mean);

  const toleranceDays = CADENCE_TOLERANCE_DAYS[cadence];
  const gapConsistency =
    gaps.filter((g) => Math.abs(g - medianGap) <= toleranceDays).length / gaps.length;
  const amountScore = 1 - cv / AMOUNT_STABILITY_CV_MAX;
  const confidence = Math.round((0.5 * gapConsistency + 0.5 * amountScore) * 100) / 100;

  const last = sorted.at(-1)!;
  return {
    cadence,
    medianGapDays: medianGap,
    intervalDaysAvg: Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 100) / 100,
    amountCentsAvg: Math.round(mean),
    amountCentsStddev: Math.round(stddev * 100) / 100,
    toleranceDays,
    confidence,
    nextExpectedOn: addDays(last.postedOn, Math.round(medianGap)),
    nextExpectedAmountCents: Math.round(mean),
    lastMatchedOn: last.postedOn,
  };
}

export interface DetectionSummary {
  scannedGroups: number;
  created: number;
  updated: number;
  taggedTransactions: number;
}

interface CategoryInfo {
  kind: string;
  parentId: string | null;
  name: string;
}

/**
 * Series kind. The transfer check runs before the income check on purpose:
 * a recurring transfer's inflow leg (mean > 0) must never masquerade as
 * income — the analytics semantics excluding transfer kinds are authoritative.
 */
function classifyKind(
  txns: readonly { categoryId: string | null }[],
  meanCents: number,
  merchantDefaultRoot: string | null,
  categoryById: ReadonlyMap<string, CategoryInfo>,
): SeriesKind {
  const kindCounts = new Map<string, number>();
  for (const t of txns) {
    const cat = t.categoryId ? categoryById.get(t.categoryId) : undefined;
    if (!cat) continue;
    kindCounts.set(cat.kind, (kindCounts.get(cat.kind) ?? 0) + 1);
  }
  const modalKind = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (modalKind === "transfer") return "transfer";
  if (meanCents > 0) return "income";
  if (merchantDefaultRoot === "Subscriptions") return "subscription";
  return "bill";
}

/** Root category name for a category id (self when already a root). */
function rootCategoryName(
  categoryId: string | null,
  categoryById: ReadonlyMap<string, CategoryInfo>,
): string | null {
  if (!categoryId) return null;
  const cat = categoryById.get(categoryId);
  if (!cat) return null;
  if (!cat.parentId) return cat.name;
  return categoryById.get(cat.parentId)?.name ?? null;
}

export interface RecomputeCtx {
  categoryById: ReadonlyMap<string, CategoryInfo>;
  merchantById: ReadonlyMap<string, { canonicalName: string; defaultCategoryId: string | null }>;
}

/** The small lookup maps recompute and detection share (categories, merchants). */
export function loadRecomputeCtx(db: AppDatabase): RecomputeCtx {
  const categoryById = new Map<string, CategoryInfo>(
    db
      .select({ id: categories.id, kind: categories.kind, parentId: categories.parentId, name: categories.name })
      .from(categories)
      .all()
      .map((c) => [c.id, { kind: c.kind, parentId: c.parentId, name: c.name }]),
  );
  const merchantById = new Map(
    db
      .select({ id: merchants.id, canonicalName: merchants.canonicalName, defaultCategoryId: merchants.defaultCategoryId })
      .from(merchants)
      .all()
      .map((m) => [m.id, { canonicalName: m.canonicalName, defaultCategoryId: m.defaultCategoryId }]),
  );
  return { categoryById, merchantById };
}

/**
 * Re-derives a series' stored statistics from its FULL current set of active,
 * non-future tagged rows (recurring_series_id = seriesId) and writes the
 * detected stat columns. This is the single settling point shared by detection
 * (Phase B) and every user-link action (attach/unlink/merge) — so after any of
 * them the stored stats already equal what a fresh detection run would compute,
 * and detection therefore changes nothing (§4.3). Leaves the last good stats in
 * place when the set is now too small/unstable to analyze (stable across runs).
 */
export function recomputeSeriesStats(
  tx: Tx,
  seriesId: string,
  today: string,
  ctx: RecomputeCtx,
): void {
  const rows = tx
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.recurringSeriesId, seriesId),
        eq(transactions.status, "active"),
        lte(transactions.postedOn, today),
      ),
    )
    .all();
  const stats = analyzeGroup(rows);
  if (!stats) return;
  const series = tx.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!series) return;
  const merchantRoot = rootCategoryName(
    series.merchantId ? ctx.merchantById.get(series.merchantId)?.defaultCategoryId ?? null : null,
    ctx.categoryById,
  );
  const kind = classifyKind(rows, stats.amountCentsAvg, merchantRoot, ctx.categoryById);
  tx.update(recurringSeries)
    .set({
      kind,
      cadence: stats.cadence,
      intervalDaysAvg: stats.intervalDaysAvg,
      amountCentsAvg: stats.amountCentsAvg,
      amountCentsStddev: stats.amountCentsStddev,
      toleranceDays: stats.toleranceDays,
      nextExpectedOn: stats.nextExpectedOn,
      nextExpectedAmountCents: stats.nextExpectedAmountCents,
      confidence: stats.confidence,
      lastMatchedOn: stats.lastMatchedOn,
    })
    .where(eq(recurringSeries.id, seriesId))
    .run();
}

/** Follows a merge chain to the live target series (cycle-guarded). */
export function resolveMergeTarget(
  seriesId: string,
  mergedById: ReadonlyMap<string, string | null>,
): string {
  const seen = new Set<string>();
  let current = seriesId;
  while (!seen.has(current)) {
    seen.add(current);
    const next = mergedById.get(current);
    if (!next) return current;
    current = next;
  }
  return current; // cycle — stop where we started looping
}

/**
 * Detection job. Groups only the rows detection is allowed to own — rows the
 * user attached/unlinked (series_link_source='user') are sacrosanct and never
 * grouped, re-tagged, or untagged. Series are resolved by merchantId / (account,
 * name) and forward-mapped through any merge, so a merged-away identity routes
 * to the live target and is never resurrected. After tagging, each touched
 * series' stats settle via recomputeSeriesStats over its FULL tagged set — so a
 * merge target keeps the stats it derived over both merchants' occurrences, and
 * a second detection run after any user action changes nothing (§4.3).
 */
export function detectRecurringSeries(
  db: AppDatabase,
  today: string = todayIso(),
): DetectionSummary {
  const summary: DetectionSummary = { scannedGroups: 0, created: 0, updated: 0, taggedTransactions: 0 };

  // future-dated rows would poison the gap statistics
  const activeTxns = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      normalizedDescription: transactions.normalizedDescription,
      seriesLinkSource: transactions.seriesLinkSource,
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), lte(transactions.postedOn, today)))
    .orderBy(asc(transactions.postedOn))
    .all();

  const ctx = loadRecomputeCtx(db);
  const existingSeries = db.select().from(recurringSeries).all();
  const mergedById = new Map(existingSeries.map((s) => [s.id, s.mergedIntoId]));

  const groups = new Map<string, GroupTxn[]>();
  for (const t of activeTxns) {
    if (t.seriesLinkSource === "user") continue; // the user owns this row's link
    const key = t.merchantId
      ? `m:${t.merchantId}`
      : t.normalizedDescription !== ""
        ? `d:${t.accountId}\x1f${t.normalizedDescription}`
        : null;
    if (!key) continue; // empty descriptions would group unrelated rows
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const tagGroup = (tx: Tx, ids: readonly string[], seriesId: string): number =>
    tx
      .update(transactions)
      .set({ recurringSeriesId: seriesId, seriesLinkSource: "detected" })
      .where(inArray(transactions.id, [...ids]))
      .run().changes;

  db.transaction((tx) => {
    const touched = new Set<string>();
    for (const [key, txns] of groups) {
      const isMerchantGroup = key.startsWith("m:");
      const merchantId = isMerchantGroup ? txns[0]!.merchantId! : null;
      const merchant = merchantId ? ctx.merchantById.get(merchantId) : undefined;
      const name = merchant ? merchant.canonicalName : txns[0]!.normalizedDescription;
      const accountIds = new Set(txns.map((t) => t.accountId));
      const accountId = accountIds.size === 1 ? txns[0]!.accountId : null;

      const existing = isMerchantGroup
        ? existingSeries.find((s) => s.merchantId === merchantId)
        : existingSeries.find(
            (s) => s.merchantId === null && s.accountId === accountId && s.name === name,
          );

      // A merged-away identity forward-maps to its live target at ANY group
      // size — a single fresh charge of a merged merchant still attaches to the
      // target, and the source is never resurrected (§4.3).
      if (existing) {
        const target = resolveMergeTarget(existing.id, mergedById);
        if (target !== existing.id) {
          summary.taggedTransactions += tagGroup(tx, txns.map((t) => t.id), target);
          touched.add(target);
          continue;
        }
      }

      // A brand-new pattern needs the full evidence bar; an existing series just
      // absorbs another occurrence of an already-known pattern.
      if (txns.length < MIN_OCCURRENCES) continue;
      summary.scannedGroups += 1;
      const stats = analyzeGroup(txns);
      if (!stats) continue;

      let seriesId: string;
      if (existing) {
        seriesId = existing.id;
        summary.updated += 1;
      } else {
        const kind = classifyKind(
          txns,
          stats.amountCentsAvg,
          rootCategoryName(merchant?.defaultCategoryId ?? null, ctx.categoryById),
          ctx.categoryById,
        );
        seriesId = tx
          .insert(recurringSeries)
          .values({
            name,
            merchantId,
            accountId,
            status: "detected",
            kind,
            cadence: stats.cadence,
            intervalDaysAvg: stats.intervalDaysAvg,
            amountCentsAvg: stats.amountCentsAvg,
            amountCentsStddev: stats.amountCentsStddev,
            toleranceDays: stats.toleranceDays,
            nextExpectedOn: stats.nextExpectedOn,
            nextExpectedAmountCents: stats.nextExpectedAmountCents,
            confidence: stats.confidence,
            lastMatchedOn: stats.lastMatchedOn,
          })
          .returning({ id: recurringSeries.id })
          .get().id;
        summary.created += 1;
      }

      // group rows are all detection-owned by construction (user rows skipped)
      summary.taggedTransactions += tagGroup(tx, txns.map((t) => t.id), seriesId);
      touched.add(seriesId);
    }

    // settle each touched series' stats over its FULL tagged set (post-tag)
    for (const seriesId of touched) {
      recomputeSeriesStats(tx, seriesId, today, ctx);
    }
  });

  return summary;
}

export function setSeriesStatus(
  db: AppDatabase,
  seriesId: string,
  status: Extract<SeriesStatus, "confirmed" | "dismissed">,
): void {
  const result = db
    .update(recurringSeries)
    .set({ status })
    .where(eq(recurringSeries.id, seriesId))
    .run();
  if (result.changes === 0) throw new Error(`Unknown recurring series ${seriesId}`);
}

export interface SeriesView {
  id: string;
  name: string;
  merchantName: string | null;
  accountId: string | null;
  kind: SeriesKind;
  cadence: Cadence;
  intervalDaysAvg: number | null;
  amountCentsAvg: number | null;
  amountCentsStddev: number | null;
  toleranceDays: number;
  nextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  status: SeriesStatus;
  confidence: number | null;
  lastMatchedOn: string | null;
  matchedCount: number;
}

const STATUS_ORDER: Record<SeriesStatus, number> = { confirmed: 0, detected: 1, dismissed: 2, ended: 3 };

export function listSeries(db: AppDatabase): SeriesView[] {
  const rows = db
    .select({
      series: recurringSeries,
      merchantName: merchants.canonicalName,
    })
    .from(recurringSeries)
    .leftJoin(merchants, eq(recurringSeries.merchantId, merchants.id))
    .all();

  const tagged = db
    .select({ recurringSeriesId: transactions.recurringSeriesId })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all();
  const countBySeries = new Map<string, number>();
  for (const t of tagged) {
    if (!t.recurringSeriesId) continue;
    countBySeries.set(t.recurringSeriesId, (countBySeries.get(t.recurringSeriesId) ?? 0) + 1);
  }

  return rows
    .map(({ series: s, merchantName }) => ({
      id: s.id,
      name: s.name,
      merchantName,
      accountId: s.accountId,
      kind: s.kind,
      cadence: s.cadence,
      intervalDaysAvg: s.intervalDaysAvg,
      amountCentsAvg: s.amountCentsAvg,
      amountCentsStddev: s.amountCentsStddev,
      toleranceDays: s.toleranceDays,
      nextExpectedOn: s.nextExpectedOn,
      nextExpectedAmountCents: s.nextExpectedAmountCents,
      status: s.status,
      confidence: s.confidence,
      lastMatchedOn: s.lastMatchedOn,
      matchedCount: countBySeries.get(s.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        (a.nextExpectedOn ?? "9999-12-31").localeCompare(b.nextExpectedOn ?? "9999-12-31") ||
        a.name.localeCompare(b.name),
    );
}

export interface SeriesOccurrence {
  seriesId: string;
  name: string;
  kind: SeriesKind;
  cadence: Cadence;
  date: string;
  amountCents: number;
}

interface ProjectableSeries {
  id: string;
  name: string;
  kind: SeriesKind;
  cadence: Cadence;
  intervalDaysAvg: number | null;
  nextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
}

/** Nominal step when a series predates interval stats (should not happen). */
const CADENCE_NOMINAL_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  semimonthly: 15,
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

/** The user-override columns that shadow detection's values (§4.4). */
export interface SeriesOverrides {
  cadence: Cadence;
  userCadence: Cadence | null;
  intervalDaysAvg: number | null;
  nextExpectedOn: string | null;
  userNextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  userAmountCents: number | null;
}

/** Effective values the UI and forecast read: user override first, else detected. */
export interface EffectiveSeries {
  cadence: Cadence;
  intervalDaysAvg: number | null;
  nextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
}

export function effectiveSeries(s: SeriesOverrides): EffectiveSeries {
  return {
    cadence: s.userCadence ?? s.cadence,
    // a user cadence override abandons the detected interval — step by the
    // override's nominal cadence length instead of the old detected gap
    intervalDaysAvg: s.userCadence ? null : s.intervalDaysAvg,
    nextExpectedOn: s.userNextExpectedOn ?? s.nextExpectedOn,
    nextExpectedAmountCents: s.userAmountCents ?? s.nextExpectedAmountCents,
  };
}

/** Maps a series row (with overrides) to the effective projection input. */
export function toProjectable(
  s: SeriesOverrides & { id: string; name: string; kind: SeriesKind },
): ProjectableSeries {
  const eff = effectiveSeries(s);
  return { id: s.id, name: s.name, kind: s.kind, ...eff };
}

const INACTIVE_MISS_LIMIT = 1.5;

/**
 * Active/Inactive split for the "All" sub-view (§4.1): a detected/confirmed
 * series is inactive once its last charge is older than ~1.5 cadence intervals
 * plus grace — a new charge (re-detection updates lastMatchedOn) auto-restores
 * it. dismissed/ended series are never active.
 */
export function isSeriesActive(
  s: SeriesOverrides & { status: SeriesStatus; lastMatchedOn: string | null },
  today: string = todayIso(),
): boolean {
  if (s.status === "dismissed" || s.status === "ended") return false;
  if (!s.lastMatchedOn) return false;
  const cadence = s.userCadence ?? s.cadence;
  const step = s.userCadence ? CADENCE_NOMINAL_DAYS[cadence] : s.intervalDaysAvg ?? CADENCE_NOMINAL_DAYS[cadence];
  const grace = CADENCE_TOLERANCE_DAYS[cadence];
  return diffDays(s.lastMatchedOn, today) <= step * INACTIVE_MISS_LIMIT + grace;
}

/**
 * Projects a series' expected occurrences inside [from, to] (inclusive),
 * stepping from next_expected_on by the rounded average interval. Overdue
 * occurrences before `from` are skipped — they are actuals or misses, not
 * forecast (a weekly series can contribute several occurrences).
 */
export function projectOccurrences(
  series: ProjectableSeries,
  from: string,
  to: string,
): SeriesOccurrence[] {
  if (!series.nextExpectedOn || series.nextExpectedAmountCents === null) return [];
  const step = Math.max(1, Math.round(series.intervalDaysAvg ?? CADENCE_NOMINAL_DAYS[series.cadence]));

  let d = series.nextExpectedOn;
  while (compareDates(d, from) < 0) d = addDays(d, step);

  const occurrences: SeriesOccurrence[] = [];
  while (compareDates(d, to) <= 0) {
    occurrences.push({
      seriesId: series.id,
      name: series.name,
      kind: series.kind,
      cadence: series.cadence,
      date: d,
      amountCents: series.nextExpectedAmountCents,
    });
    d = addDays(d, step);
  }
  return occurrences;
}

/** All active (detected|confirmed) series' occurrences in the next N days. */
export function upcomingOccurrences(
  db: AppDatabase,
  today: string = todayIso(),
  windowDays = 30,
): SeriesOccurrence[] {
  const active = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();

  const to = addDays(today, windowDays);
  return active
    .flatMap((s) => projectOccurrences(toProjectable(s), today, to))
    .sort((a, b) => compareDates(a.date, b.date) || a.name.localeCompare(b.name));
}
