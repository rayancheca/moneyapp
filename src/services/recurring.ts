import { and, asc, eq, inArray, lte } from "drizzle-orm";
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
  txns: readonly GroupTxn[],
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

/**
 * Detection job. Idempotent upsert keyed by merchantId (merchant groups) or
 * (accountId, name) (description-fallback groups). Re-runs preserve user
 * status — dismissed stays dismissed, confirmed stays confirmed; only the
 * statistics and next-expected fields refresh. Matched transactions are
 * tagged with recurringSeriesId inside the same synchronous transaction.
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
    })
    .from(transactions)
    .where(and(eq(transactions.status, "active"), lte(transactions.postedOn, today)))
    .orderBy(asc(transactions.postedOn))
    .all();

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
      .map((m) => [m.id, m]),
  );
  const existingSeries = db.select().from(recurringSeries).all();

  const groups = new Map<string, GroupTxn[]>();
  for (const t of activeTxns) {
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

  db.transaction((tx) => {
    for (const [key, txns] of groups) {
      if (txns.length < MIN_OCCURRENCES) continue;
      summary.scannedGroups += 1;

      const stats = analyzeGroup(txns);
      if (!stats) continue;

      const isMerchantGroup = key.startsWith("m:");
      const merchant = isMerchantGroup ? merchantById.get(txns[0]!.merchantId!) : undefined;
      const name = merchant ? merchant.canonicalName : txns[0]!.normalizedDescription;
      const accountIds = new Set(txns.map((t) => t.accountId));
      const accountId = accountIds.size === 1 ? txns[0]!.accountId : null;
      const kind = classifyKind(
        txns,
        stats.amountCentsAvg,
        rootCategoryName(merchant?.defaultCategoryId ?? null, categoryById),
        categoryById,
      );

      const existing = isMerchantGroup
        ? existingSeries.find((s) => s.merchantId === txns[0]!.merchantId)
        : existingSeries.find(
            (s) => s.merchantId === null && s.accountId === accountId && s.name === name,
          );

      const statColumns = {
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
      };

      let seriesId: string;
      if (existing) {
        // stats/next date only — user status is never overwritten on re-run
        tx.update(recurringSeries).set(statColumns).where(eq(recurringSeries.id, existing.id)).run();
        seriesId = existing.id;
        summary.updated += 1;
      } else {
        seriesId = tx
          .insert(recurringSeries)
          .values({
            name,
            merchantId: isMerchantGroup ? txns[0]!.merchantId : null,
            accountId,
            status: "detected",
            ...statColumns,
          })
          .returning({ id: recurringSeries.id })
          .get().id;
        summary.created += 1;
      }

      const result = tx
        .update(transactions)
        .set({ recurringSeriesId: seriesId })
        .where(
          inArray(
            transactions.id,
            txns.map((t) => t.id),
          ),
        )
        .run();
      summary.taggedTransactions += result.changes;
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
    .flatMap((s) => projectOccurrences(s, today, to))
    .sort((a, b) => compareDates(a.date, b.date) || a.name.localeCompare(b.name));
}
