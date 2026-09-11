import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";
import type { SeriesEvidence } from "@/lib/series-evidence";
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
import { addCalendarMonths, addDays, compareDates, diffDays, todayIso } from "@/lib/dates";
import {
  CADENCE_NOMINAL_DAYS,
  deriveAnchorDay,
  stepFrom,
  stepPlan,
  stepsToReach,
} from "@/lib/recurring-step";

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
  /** the billed day-of-month when the calendar can clamp it; see deriveAnchorDay */
  anchorDay: number | null;
}

/**
 * Pure statistics for one candidate group (exported for unit testing).
 * Returns null when the group is not a series: too few occurrences, median
 * gap outside every cadence bucket, or unstable amounts.
 */
/**
 * Is this set of amounts stable enough to be one recurring charge?
 *
 * Population stddev over |mean| at or under `AMOUNT_STABILITY_CV_MAX`, or every
 * amount identical. Extracted from `analyzeGroup` so the absorption pass can
 * hold a detected series to the SAME bar that admitted it — two copies of this
 * rule would be two rules, and the second one would eventually drift looser.
 */
export function amountsAreStable(amounts: readonly number[]): boolean {
  if (amounts.length === 0) return true;
  if (amounts.every((a) => a === amounts[0])) return true;
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (mean === 0) return false;
  return populationStddev(amounts) / Math.abs(mean) <= AMOUNT_STABILITY_CV_MAX;
}

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
  if (!amountsAreStable(amounts)) return null;
  const cv = allIdentical ? 0 : stddev / Math.abs(mean);

  const toleranceDays = CADENCE_TOLERANCE_DAYS[cadence];
  const gapConsistency =
    gaps.filter((g) => Math.abs(g - medianGap) <= toleranceDays).length / gaps.length;
  const amountScore = 1 - cv / AMOUNT_STABILITY_CV_MAX;
  const confidence = Math.round((0.5 * gapConsistency + 0.5 * amountScore) * 100) / 100;

  const last = sorted.at(-1)!;
  const intervalDaysAvg = Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 100) / 100;
  // read from EVERY posting, never from `last`: on a month-end series `last` is
  // itself the clamped value, so it is the one date that cannot reveal the day
  const anchorDay = deriveAnchorDay(sorted.map((t) => t.postedOn));
  const plan = stepPlan(cadence, intervalDaysAvg, anchorDay);
  return {
    cadence,
    medianGapDays: medianGap,
    intervalDaysAvg,
    amountCentsAvg: Math.round(mean),
    amountCentsStddev: Math.round(stddev * 100) / 100,
    toleranceDays,
    confidence,
    // The anchor has to be laid down by the SAME model the projection walks, or
    // the two disagree permanently: under day stepping a one-day-early anchor is
    // self-correcting noise, but a calendar walk repeats it every single month.
    // So the plan is built from the interval this call is about to STORE — the
    // exact value projectOccurrences will read back.
    nextExpectedOn: plan.calendarMonths
      ? stepFrom(last.postedOn, plan, 1)
      : addDays(last.postedOn, Math.round(medianGap)),
    nextExpectedAmountCents: Math.round(mean),
    lastMatchedOn: last.postedOn,
    anchorDay,
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

  /*
   * `lastMatchedOn` is settled FIRST and unconditionally, because it is not a
   * statistic. Everything else here is measured over the set — a cadence, an
   * average, a stddev — and genuinely needs MIN_OCCURRENCES points before it
   * means anything. This one is `max(postedOn)` of the linked rows, exact for
   * one row and exact for none.
   *
   * Bundling it into the all-or-nothing early return below left a series
   * asserting that pay arrived on a day with nothing linked to it. Measured on
   * the live ledger 2026-08-21: "Cash job (weekly pay)" carried
   * `last_matched_on = 2026-07-06` after the row once matched there was
   * re-categorised to `Transfers > Internal Transfer` and unlinked, and nothing
   * revisited it. `seriesStaleness` reads this column, so the app believed pay
   * was 46 days old while the evidence said 77. Unlinking EVERY row was worse
   * still — the date simply stayed, describing a set that no longer existed.
   *
   * The thin-evidence guard keeps everything it was actually protecting: a
   * cadence, an anchor and a next-expected date measured over two points are
   * guesses, and they stay frozen at their last good values.
   */
  const lastMatchedOn = rows.reduce<string | null>(
    (latest, r) => (latest === null || compareDates(r.postedOn, latest) > 0 ? r.postedOn : latest),
    null,
  );

  const stats = analyzeGroup(rows);
  if (!stats) {
    tx.update(recurringSeries)
      .set({ lastMatchedOn })
      .where(eq(recurringSeries.id, seriesId))
      .run();
    return;
  }
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
      anchorDay: stats.anchorDay,
      nextExpectedAmountCents: stats.nextExpectedAmountCents,
      confidence: stats.confidence,
      lastMatchedOn,
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
            anchorDay: stats.anchorDay,
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

    /*
     * ── Absorption ───────────────────────────────────────────────────────
     * A live series takes an untagged row whose descriptor it has already been
     * tagged with, at ANY group size and on ANY account.
     *
     * The loop above resolves a group to a series by merchant id, or by
     * (account, name) for a descriptor group. Both keys fail in ways the real
     * ledger runs into constantly, and the docstring's promise that "an existing
     * series just absorbs another occurrence of an already-known pattern" was
     * simply not true underneath them:
     *
     *  - **The account is part of the descriptor key.** PURA VIDA's series lives
     *    on Venture X; six of its charges are on Chase Sapphire. They form their
     *    own group, match no series, and — being irregular — cannot pass
     *    `analyzeGroup` to become one either, so they stay untagged forever.
     *  - **Hand-created series carry no merchant id.** Breezeline and FPL were
     *    registered by the owner, so a merchant-keyed group of their charges
     *    finds nothing to attach to.
     *  - **A single new charge is under MIN_OCCURRENCES**, so the group loop
     *    skips it before the `existing` branch is ever consulted. The real
     *    Breezeline charge of 2026-08-10 arrived on the exact expected day for
     *    the exact expected amount; running detection against a backup of the
     *    live database tagged zero new rows.
     *
     * ⚠️ The match is EXACT normalized-description equality with a row already
     * tagged to that series, and the descriptor must belong to exactly one live
     * series. Nothing fuzzy, because pass 33 shipped a dedupe fix that matched
     * on (day, amount) with no description check and silently deleted real
     * charges. This pass only ever writes a series id onto a row that had NONE —
     * it never moves a link, never clears one, and never touches a row the user
     * owns — so the worst case is one extra row on a series that already carries
     * that exact descriptor.
     *
     * ⚠️ Read INSIDE the transaction rather than from `activeTxns`, which was
     * captured before the group loop ran and does not know what it just tagged.
     *
     * detected|confirmed only. A dismissed series is the owner saying "not
     * recurring" and an ended one is over; neither should be quietly growing.
     * Absorption never CREATES a series, so declining to feed them cannot
     * resurrect a pattern under a new identity.
     */
    const liveSeriesIds = new Set(
      tx
        .select({ id: recurringSeries.id, status: recurringSeries.status })
        .from(recurringSeries)
        .all()
        .filter((r) => r.status === "detected" || r.status === "confirmed")
        .map((r) => r.id),
    );

    const rows = tx
      .select({
        id: transactions.id,
        seriesId: transactions.recurringSeriesId,
        description: transactions.normalizedDescription,
        linkSource: transactions.seriesLinkSource,
        amountCents: transactions.amountCents,
      })
      .from(transactions)
      .where(and(eq(transactions.status, "active"), lte(transactions.postedOn, today)))
      .all();

    // descriptor → the one live series carrying it; null once two disagree,
    // because picking between them would be inventing a link.
    const ownerOf = new Map<string, string | null>();
    for (const r of rows) {
      if (!r.seriesId || !liveSeriesIds.has(r.seriesId) || r.description === "") continue;
      const seen = ownerOf.get(r.description);
      if (seen === undefined) ownerOf.set(r.description, r.seriesId);
      else if (seen !== r.seriesId) ownerOf.set(r.description, null);
    }

    const absorbBySeries = new Map<string, string[]>();
    for (const r of rows) {
      if (r.seriesId !== null || r.linkSource === "user" || r.description === "") continue;
      const seriesId = ownerOf.get(r.description);
      if (!seriesId) continue;
      const list = absorbBySeries.get(seriesId);
      if (list) list.push(r.id);
      else absorbBySeries.set(seriesId, [r.id]);
    }

    /*
     * ⚠️ A DETECTED series must still pass the bar that admitted it.
     *
     * Absorption's first version did not check, and it corrupted two series the
     * day it shipped. "PURA VIDA BAY ROAD MIAMI BEACH" and "YA-FIT Smoothie Bar"
     * are a café and a smoothie bar the owner visits often; each had four
     * charges that happened to cost similar amounts, which squeaked under
     * `AMOUNT_STABILITY_CV_MAX`. Absorbing seven more took their amount CV to
     * 0.672 and 0.463 — three times the gate — and nothing re-ran it, so the app
     * went on calling them subscriptions with worse evidence than it started
     * with. Owner: *"the smoothie bat and pura vida are not recurring i just go
     * eat there often ... you cant say doordash is recurring . its not a fixed
     * subsription its just me getting food."*
     *
     * The check is CV over the series' FULL tagged set including the candidates,
     * because that is the set the series would then be claiming to describe.
     *
     * CONFIRMED series are exempt, and that is the whole point of the split: the
     * owner has vouched for them, and several are legitimately variable — his
     * rent runs a CV of 0.326 and FPL is a utility bill that changes every
     * month. A statistical gate must never override a human's answer; it only
     * holds a DETECTOR to its own standard.
     */
    const amountsBySeries = new Map<string, number[]>();
    for (const r of rows) {
      if (!r.seriesId) continue;
      const list = amountsBySeries.get(r.seriesId);
      if (list) list.push(r.amountCents);
      else amountsBySeries.set(r.seriesId, [r.amountCents]);
    }
    const statusById = new Map(
      tx
        .select({ id: recurringSeries.id, status: recurringSeries.status })
        .from(recurringSeries)
        .all()
        .map((r) => [r.id, r.status] as const),
    );
    const amountById = new Map(rows.map((r) => [r.id, r.amountCents] as const));

    for (const [seriesId, ids] of absorbBySeries) {
      if (statusById.get(seriesId) === "detected") {
        const merged = [
          ...(amountsBySeries.get(seriesId) ?? []),
          ...ids.map((id) => amountById.get(id) ?? 0),
        ];
        if (!amountsAreStable(merged)) continue;
      }
      summary.taggedTransactions += tagGroup(tx, ids, seriesId);
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
  status: Extract<SeriesStatus, "confirmed" | "dismissed" | "ended">,
): void {
  const series = db
    .select({ mergedIntoId: recurringSeries.mergedIntoId })
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .get();
  if (!series) throw new Error(`Unknown recurring series ${seriesId}`);
  // A merged-away series owns zero rows (they moved to the target) but keeps its
  // detected stats. Re-confirming it would resurrect it into the forecast/calendar
  // with phantom money that double-books the target's charges (§4.3). It is dead.
  if (status === "confirmed" && series.mergedIntoId !== null) {
    throw new Error("Cannot re-confirm a merged series");
  }
  db.update(recurringSeries).set({ status }).where(eq(recurringSeries.id, seriesId)).run();
}

export interface SeriesView {
  id: string;
  name: string;
  merchantName: string | null;
  accountId: string | null;
  kind: SeriesKind;
  /** effective cadence (user override first) */
  cadence: Cadence;
  intervalDaysAvg: number | null;
  amountCentsAvg: number | null;
  amountCentsStddev: number | null;
  toleranceDays: number;
  /**
   * effective next-expected (user override first), rolled forward past a stale
   * stored value so a live series never lists a "next" date in the past
   */
  nextExpectedOn: string | null;
  /** the stored (un-rolled) effective next-expected — what the detector last wrote */
  storedNextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  status: SeriesStatus;
  confidence: number | null;
  lastMatchedOn: string | null;
  matchedCount: number;
  /** derived: within cadence+grace of its last charge (§4.1 Active/Inactive) */
  isActive: boolean;
  /** what the evidence says, in the word every surface uses — `isActive` is its first case */
  evidence: SeriesEvidence;
  /** effective per-occurrence amount × occurrences/year (magnitude) */
  annualizedCents: number | null;
  /**
   * The MEAN of the linked active rows — null when nothing is linked.
   *
   * 🔴 `amountCentsAvg` above is the detector's SEED: written when the series
   * was created and never recomputed as rows are attached afterwards.
   * `/recurring?tab=all` printed it under the words "posted avg" on
   * 2026-09-04, where it was wrong about two of the three series that showed
   * it — Flamingo South Beach (rent) read "4 matched · posted avg -$2,285.70"
   * of four charges averaging -$1,739.40, and Cash job (weekly pay) read
   * "2 matched · posted avg +$1,046.00" of two deposits averaging +$723.50, a
   * figure matching neither deposit nor their mean.
   *
   * The seed stays on `amountCentsAvg` — the detector's own record of what it
   * saw — and anything claiming to be the average of the postings reads this.
   */
  postedAvgCents: number | null;
}

/** the span an "annualized" figure covers — twelve months from today */
const ANNUALIZED_MONTHS = 12;

/**
 * What this series will actually cost in the twelve months from `today`.
 *
 * 🔴 THIS WAS `|amount| × a per-year occurrence count`, WITH NO HORIZON TERM —
 * so a bounded contract was billed twelve times however few payments it has
 * left. On the real ledger, 2026-09-11, `Car insurance` (ends 2027-01-11, five
 * payments to go, a six-payment policy):
 *
 *     /recurring?tab=all        Annualized  $4,337.88   (12 × $361.49)
 *     /recurring/<id>           "…is the 3rd largest of your 13 scheduled
 *                                commitments, by what they cost in a year, at
 *                                $4,337.88" · "9.6% of what they cost in a year"
 *     /  (Runway, The car)      $1,807.45 over the next 12 months  ← right
 *
 * $4,337.88 is twelve payments of a contract with five left in the window and
 * six in total — not an alternate basis, a false statement about a bounded
 * commitment. And it set a RANK and a SHARE that nothing else on the page
 * agreed with.
 *
 * ⛔ THE RULE WAS ALREADY WRITTEN AND CALLED TWICE — TO DESCRIBE THE PROBLEM,
 * NEVER TO COMPUTE THE FIGURE. `endsInsideHorizon` gates the committed book's
 * shortfall line and `annualizedCaveat`'s prose ("this one stops on Jan 11,
 * 2027, inside them"), so the page carried a caveat about a number that had not
 * read it. Projecting the occurrences answers both at once.
 *
 * ⚠️ Measured against `committedBook`'s own twelve-month total for all 13 live
 * commitments: identical on the twelve that outlive the window, and only
 * `Car insurance` moves — $4,337.88 → $1,807.45, the figure the dashboard has
 * been printing all along.
 */
export function annualizedCentsOf(series: ProjectableSeries, today: string): number | null {
  if (series.nextExpectedAmountCents === null) return null;
  const occurrences = projectOccurrences(series, today, addCalendarMonths(today, ANNUALIZED_MONTHS));
  return occurrences.reduce((sum, o) => sum + Math.abs(o.amountCents), 0);
}

const STATUS_ORDER: Record<SeriesStatus, number> = { confirmed: 0, detected: 1, dismissed: 2, ended: 3 };

export function listSeries(db: AppDatabase, today: string = todayIso()): SeriesView[] {
  const rows = db
    .select({
      series: recurringSeries,
      merchantName: merchants.canonicalName,
    })
    .from(recurringSeries)
    .leftJoin(merchants, eq(recurringSeries.merchantId, merchants.id))
    .all();

  const tagged = db
    .select({ recurringSeriesId: transactions.recurringSeriesId, amountCents: transactions.amountCents })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all();
  const countBySeries = new Map<string, number>();
  const sumBySeries = new Map<string, number>();
  for (const t of tagged) {
    if (!t.recurringSeriesId) continue;
    countBySeries.set(t.recurringSeriesId, (countBySeries.get(t.recurringSeriesId) ?? 0) + 1);
    sumBySeries.set(t.recurringSeriesId, (sumBySeries.get(t.recurringSeriesId) ?? 0) + t.amountCents);
  }

  return rows
    .map(({ series: s, merchantName }) => {
      const eff = effectiveSeries(s);
      // Show the same date the forecast projects: rolled forward off a stale
      // stored value. Only for the statuses the forecast actually projects —
      // rolling a dismissed/ended series forward would invent a future charge.
      const isProjected = s.status === "detected" || s.status === "confirmed";
      const nextExpectedOn = isProjected ? rollForwardNextExpected(eff, today) : eff.nextExpectedOn;
      return {
        id: s.id,
        name: s.name,
        merchantName,
        accountId: s.accountId,
        kind: s.kind,
        cadence: eff.cadence,
        intervalDaysAvg: s.intervalDaysAvg,
        amountCentsAvg: s.amountCentsAvg,
        amountCentsStddev: s.amountCentsStddev,
        toleranceDays: s.toleranceDays,
        nextExpectedOn,
        storedNextExpectedOn: eff.nextExpectedOn,
        nextExpectedAmountCents: eff.nextExpectedAmountCents,
        status: s.status,
        confidence: s.confidence,
        lastMatchedOn: s.lastMatchedOn,
        matchedCount: countBySeries.get(s.id) ?? 0,
        postedAvgCents: countBySeries.get(s.id)
          ? Math.round(sumBySeries.get(s.id)! / countBySeries.get(s.id)!)
          : null,
        isActive: isSeriesActive(s, today),
        evidence: seriesEvidence(s, today),
        annualizedCents: annualizedCentsOf(toProjectable(s), today),
      } satisfies SeriesView;
    })
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
  /**
   * The day-of-month the series is really billed on, for a calendar-stepped
   * cadence — null when the cadence steps in DAYS (weekly, biweekly), where
   * nothing clamps and `date`'s own day is already the truth.
   *
   * ⛔ It exists because `date` alone cannot answer whether an occurrence is
   * inside a window of whole calendar months. February clamps the 28th, 29th,
   * 30th and 31st onto ONE date, and those four series need different answers
   * at the boundary — see `MonthHorizon` in `lib/committed`.
   */
  anchorDayOfMonth: number | null;
  /**
   * How old the evidence behind this projection is, when the caller supplied
   * it (see toProjectable). Undefined means "not measured here", never "fresh".
   */
  staleness?: SeriesStaleness;
}

/**
 * How late a series' evidence is running. Carried alongside a projection so the
 * read path can DISCLOSE staleness instead of resolving it by exclusion: the
 * owner's weekly cash job routinely sits ~3 weeks behind on deposit/import lag,
 * so filtering stale series out of the forecast would delete real income, while
 * projecting a dead subscription with no note hides the doubt. Computed with
 * exactly the arithmetic isSeriesActive splits on, so the two cannot disagree.
 */
export interface SeriesStaleness {
  /** newest matched charge, or null when nothing has ever matched the series */
  lastMatchedOn: string | null;
  /** days from lastMatchedOn to today; null when there is nothing to measure */
  daysSinceLastMatch: number | null;
  /** the effective step: user cadence → nominal, else the detected average gap */
  stepDays: number;
  /** step × INACTIVE_MISS_LIMIT + cadence grace — past this the evidence is late */
  toleranceDays: number;
  /** true once the evidence is older than toleranceDays, or absent entirely */
  isStale: boolean;
}

interface ProjectableSeries {
  id: string;
  name: string;
  kind: SeriesKind;
  cadence: Cadence;
  intervalDaysAvg: number | null;
  nextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  /** billed day-of-month when the calendar can clamp it; see deriveAnchorDay */
  anchorDay?: number | null;
  /** last day this series can occur; null = open-ended */
  userEndsOn?: string | null;
  /** copied onto every occurrence this series projects */
  staleness?: SeriesStaleness;
}

/** The user-override columns that shadow detection's values (§4.4). */
export interface SeriesOverrides {
  cadence: Cadence;
  userCadence: Cadence | null;
  intervalDaysAvg: number | null;
  nextExpectedOn: string | null;
  userNextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  userAmountCents: number | null;
  /** last day the series can occur; null = open-ended */
  userEndsOn?: string | null;
  /** detected billed day-of-month, 29..31; optional so older callers still typecheck */
  anchorDay?: number | null;
}

/** Effective values the UI and forecast read: user override first, else detected. */
export interface EffectiveSeries {
  cadence: Cadence;
  intervalDaysAvg: number | null;
  nextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  anchorDay: number | null;
  /**
   * Last day the series can occur; null = open-ended. Carried HERE, beside the
   * anchor and the cadence, because a projection needs all four — a caller that
   * had to remember to apply the end separately is a caller that can forget,
   * and one did. See `rollForwardNextExpected`.
   *
   * ⛔ REQUIRED, not optional. Optional would leave exactly the hole this field
   * was added to close: an `EffectiveSeries` built without the key gets
   * `undefined`, skips the end test, and projects a commitment that is over —
   * silently, and only for whoever forgot. `null` is the way to say
   * "open-ended", and it has to be said.
   */
  userEndsOn: string | null;
}

export function effectiveSeries(s: SeriesOverrides): EffectiveSeries {
  return {
    cadence: s.userCadence ?? s.cadence,
    // a user cadence override abandons the detected interval — step by the
    // override's nominal cadence length instead of the old detected gap
    intervalDaysAvg: s.userCadence ? null : s.intervalDaysAvg,
    nextExpectedOn: s.userNextExpectedOn ?? s.nextExpectedOn,
    nextExpectedAmountCents: s.userAmountCents ?? s.nextExpectedAmountCents,
    // A user-set date IS the day-of-month, so the detected anchor must yield to
    // it — otherwise picking the 15th on a month-end series would be silently
    // re-dayed to the 31st and the override would look ignored. Same shape as
    // the cadence override abandoning the detected interval, just above.
    anchorDay: s.userNextExpectedOn ? null : (s.anchorDay ?? null),
    userEndsOn: s.userEndsOn ?? null,
  };
}

/**
 * Maps a series row (with overrides) to the effective projection input.
 * `staleness` is opt-in: a caller that means to disclose the age of the
 * evidence passes it, and it rides along onto every projected occurrence.
 */
export function toProjectable(
  s: SeriesOverrides & { id: string; name: string; kind: SeriesKind },
  staleness?: SeriesStaleness,
): ProjectableSeries {
  const eff = effectiveSeries(s);
  return { id: s.id, name: s.name, kind: s.kind, ...eff, userEndsOn: s.userEndsOn ?? null, staleness };
}

const INACTIVE_MISS_LIMIT = 1.5;

/**
 * How many cycles a money-out series may miss before a forecast STOPS carrying
 * it — a deliberately looser bar than `INACTIVE_MISS_LIMIT`, because the two
 * decisions cost opposite things when they are wrong.
 *
 * 🔴 At 1.5 they were the same number, and it published a false answer on the
 * owner's own dashboard: `Flamingo South Beach (rent)` last posted 2026-07-08,
 * 49 days against a 48-day tolerance — ONE day over — so `upcomingOccurrences`
 * dropped it and the runway card reported "Committed bills come to $782.41 a
 * month" while the real figure including rent is $3,068.11. The largest bill in
 * the ledger vanished from the forecast for being a day late, and nothing on
 * the card said so. `FPL (electricity)` sat at 47 of 48 and would have gone the
 * same way the next morning.
 *
 * ⚠️ The cause is structural, not a one-off. Statements arrive MONTHLY and each
 * lands on its own date (docs: statement cadence), so `last_matched_on` trails
 * reality by up to a full cycle simply because the evidence has not been
 * imported yet. A limit of 1.5 cycles therefore condemns any monthly bill whose
 * statement is a fortnight late — which is most of them, most of the time.
 *
 * Three is the smallest limit that survives that lag with room to spare: one
 * cycle of import lag plus two genuinely missed charges. It is not fitted to
 * the data, but it does separate it cleanly — measured 2026-08-26, the dead
 * series sit at 7.5, 25.3, 26.0 and 27.6 cycles while every live one is under
 * 1.7, so nothing lands anywhere near the boundary.
 *
 * ⛔ `isSeriesActive` deliberately does NOT use this. "Is there recent
 * evidence?" is a question about the past and 1.5 cycles is a fair answer;
 * "should I keep predicting this?" is a question about the future, and being
 * wrong there deletes a real bill from a budget. Being too eager to call
 * something dead is the expensive mistake, so only the forecast gate moves.
 */
const LAPSED_MISS_LIMIT = 3;

/** The forecast's own, looser bar — see `LAPSED_MISS_LIMIT`. */
function lapsedToleranceDays(staleness: SeriesStaleness): number {
  // reconstructed from the same step the staleness used, so the two tolerances
  // can only ever differ by their miss limit and never by their cadence maths
  const grace = staleness.toleranceDays - staleness.stepDays * INACTIVE_MISS_LIMIT;
  return staleness.stepDays * LAPSED_MISS_LIMIT + grace;
}

/**
 * How late a series is, measured against the same threshold the Active/Inactive
 * split uses. Status plays no part — a dismissed series can still be perfectly
 * fresh, and freshness is what this reports.
 */
export function seriesStaleness(
  s: SeriesOverrides & { lastMatchedOn: string | null },
  today: string = todayIso(),
): SeriesStaleness {
  // Deliberately NOT stepPlan(): this measures how old the EVIDENCE is, which
  // is a span of days whatever calendar the series bills on. The projection's
  // step and this tolerance answer different questions and are allowed to
  // differ — for a calendar-monthly series they no longer name the same number.
  const cadence = s.userCadence ?? s.cadence;
  const stepDays = s.userCadence ? CADENCE_NOMINAL_DAYS[cadence] : s.intervalDaysAvg ?? CADENCE_NOMINAL_DAYS[cadence];
  const toleranceDays = stepDays * INACTIVE_MISS_LIMIT + CADENCE_TOLERANCE_DAYS[cadence];
  const daysSinceLastMatch = s.lastMatchedOn ? diffDays(s.lastMatchedOn, today) : null;
  return {
    lastMatchedOn: s.lastMatchedOn,
    daysSinceLastMatch,
    stepDays,
    toleranceDays,
    isStale: daysSinceLastMatch === null || daysSinceLastMatch > toleranceDays,
  };
}

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
  return !seriesStaleness(s, today).isStale;
}

/**
 * Should a lapsed series stop being FORECAST, or only be marked late?
 *
 * It depends on which way the money goes, and the two answers are opposites.
 *
 * **Money out stops.** A subscription that has not charged in 449 days is
 * cancelled, and listing it as a bill due next week is a prediction no chip can
 * rescue. Owner, on seeing exactly that: *"why would you keep the uber one if it
 * was last seen 449 days ago its clearly not recurring anymore"*.
 *
 * **Money in does not.** The owner is paid in cash from a job whose deposits are
 * irregular by nature — pass 28 measured ~$1,046/wk of real earnings arriving in
 * lumps weeks apart. A quiet stretch there is import lag or a slow month, not a
 * lost job, and dropping it would delete his entire income forecast to remove
 * $4.99 of dead Uber. It stays, marked stale, which is what the staleness chip
 * is actually for.
 *
 * `transfer` and `other` follow the money-out rule: neither is income, and a
 * dead one is as untrustworthy as a dead subscription.
 */
export function lapsedSeriesShouldStopForecasting(kind: SeriesKind): boolean {
  return kind !== "income";
}

/**
 * A series whose EVIDENCE has run out: it posted before, and its newest posting
 * is older than its own tolerance. UBER *ONE last charged 446 days ago against a
 * 49-day tolerance and was still projecting $4.99 a month into Travel.
 *
 * ⚠️ Deliberately NOT `isSeriesActive`, which also calls a NEVER-posted series
 * inactive. That is the right answer to "is there evidence for this?" and the
 * wrong gate for a projection: a commitment the owner registered has no postings
 * yet by definition — the car lease signed for 2026-09-11 posts nothing until
 * next month's statement — and `userCategoryId` exists precisely so it still
 * reaches its budget. Gating a forecast on `isSeriesActive` would delete
 * $559.89/month of real lease from the Car budget to remove $4.99 of dead Uber.
 *
 * Lapsed means "it stopped", which only a series that once started can do.
 */
export function seriesHasLapsed(
  s: SeriesOverrides & { lastMatchedOn: string | null },
  today: string = todayIso(),
): boolean {
  const staleness = seriesStaleness(s, today);
  if (staleness.lastMatchedOn === null || staleness.daysSinceLastMatch === null) return false;
  return staleness.daysSinceLastMatch > lapsedToleranceDays(staleness);
}

/**
 * The first non-past occurrence of a series, stepping from its effective
 * next_expected_on the same way projectOccurrences does. The stored column is
 * the detector's output as of its last run and goes stale between runs — the
 * READ path must never surface a date in the past as "next". Returns null when
 * the series has no expected date at all.
 *
 * 🔴 …and null when the series is OVER. `projectOccurrences` has always
 * clamped its walk at `userEndsOn` — "a 24-payment lease is not monthly
 * forever" — and this stepped from the anchor with no end test, so /recurring's
 * "Next" column published a date for a commitment whose own occurrence list on
 * the same page was empty. Measured on the real ledger: Car insurance (ends
 * 2027-01-11) reads "next 2027-03-11" at today = 2027-02-20, and Car lease
 * (ends 2028-08-15) reads "next 2028-10-15" at today = 2028-10-01, both with
 * zero occurrences in the following 400 days.
 *
 * ⚠️ `subscriptions-card` already applied the test at its CALL SITE. Held
 * there, two places had to agree about a date and only one did; held here,
 * none do.
 */
export function rollForwardNextExpected(eff: EffectiveSeries, today: string = todayIso()): string | null {
  if (!eff.nextExpectedOn) return null;
  const plan = stepPlan(eff.cadence, eff.intervalDaysAvg, eff.anchorDay);
  const next = stepFrom(eff.nextExpectedOn, plan, stepsToReach(eff.nextExpectedOn, plan, today));
  // inclusive: a series ends ON its end date, so that day's charge still happens
  if (eff.userEndsOn && compareDates(next, eff.userEndsOn) > 0) return null;
  return next;
}

/**
 * Projects a series' expected occurrences inside [from, to] (inclusive),
 * stepping from next_expected_on the way its cadence actually bills. Overdue
 * occurrences before `from` are skipped — they are actuals or misses, not
 * forecast (a weekly series can contribute several occurrences).
 *
 * Every date is measured from the ANCHOR by an index, never from the previous
 * result: month-end clamping is lossy, so an iterative walk would drag a
 * 31st-of-the-month series down to the 28th the first time it crossed February
 * and leave it there (see dates.ts::addCalendarMonths).
 */
export function projectOccurrences(
  series: ProjectableSeries,
  from: string,
  to: string,
): SeriesOccurrence[] {
  if (!series.nextExpectedOn || series.nextExpectedAmountCents === null) return [];
  const anchor = series.nextExpectedOn;
  const plan = stepPlan(series.cadence, series.intervalDaysAvg, series.anchorDay ?? null);

  // a commitment with a known end stops there — a 24-payment lease is not
  // "monthly forever", and projecting past its last payment silently inflates
  // every forecast that reaches beyond it
  const last = series.userEndsOn && compareDates(series.userEndsOn, to) < 0 ? series.userEndsOn : to;

  /*
   * The series' TRUE day-of-month, published so a caller can tell a clamped
   * occurrence from an unclamped one. `plan.anchorDay` when the postings proved
   * a clampable day; otherwise the anchor's own day, which is what every step
   * of this walk uses. Null for day-stepped cadences, which never clamp.
   *
   * ⚠️ It inherits `deriveAnchorDay`'s limit exactly: an anchor that was itself
   * clamped reports the clamped day. That is the same answer the walk already
   * gives, so this adds no new error — it exposes the one already there.
   */
  const anchorDayOfMonth = plan.calendarMonths
    ? (plan.anchorDay ?? Number(anchor.slice(8, 10)))
    : null;

  const occurrences: SeriesOccurrence[] = [];
  for (let i = stepsToReach(anchor, plan, from); ; i++) {
    const date = stepFrom(anchor, plan, i);
    if (compareDates(date, last) > 0) break;
    occurrences.push({
      seriesId: series.id,
      name: series.name,
      kind: series.kind,
      cadence: series.cadence,
      date,
      amountCents: series.nextExpectedAmountCents,
      anchorDayOfMonth,
      staleness: series.staleness,
    });
  }
  return occurrences;
}

/**
 * All live (detected|confirmed) series' occurrences in the next N days.
 *
 * ⛔ `windowDays` is a COUNT OF DAYS, and today is the first of them. The window
 * is `[today, today + windowDays - 1]`, so 30 days means thirty days.
 *
 * 🔴 It used to end at `today + windowDays`, which is thirty-ONE days, and the
 * extra day was visible: measured on the real ledger at today = 2026-09-01, the
 * "Upcoming 30 days" list on /recurring showed **`Flamingo South Beach (rent)`
 * twice** — 2026-09-01 and 2026-10-01 — along with `Rent utilities & fees`. A
 * reader would take that as owing rent twice in a month. The dashboard's "next
 * 14 days" widget had the same extra day.
 *
 * ⚠️ A monthly bill is the only shape that can show it, and only when its
 * anchor day equals today's. That is why it survived: every fixture in this repo
 * uses a `TODAY` (the 8th, the 24th) that no fixture bill is anchored on.
 *
 * ⚠️ A caller that already has an END DATE rather than a length must pass
 * `diffDays(today, end) + 1` — `committedBook` and `carCard` both do, and both
 * name it. Two functions that must agree about a date must not both compute it.
 *
 * Liveness here is STATUS ONLY, deliberately: a series whose evidence has gone
 * stale still projects, carrying its `staleness` so the reader is told how old
 * the evidence is. Filtering on isSeriesActive instead would silently delete
 * the owner's weekly cash income the moment a deposit posted late — the same
 * dishonesty the derivation layer avoids when it stamps a `gap` rather than
 * inventing a slope. recurring-calendar.ts may filter; it draws nothing rather
 * than asserting an amount, so omission there costs no information.
 */
export function upcomingOccurrences(
  db: AppDatabase,
  today: string = todayIso(),
  windowDays = 30,
): SeriesOccurrence[] {
  const live = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();

  // today is day ONE of the window — see the docstring's rent-twice measurement
  const to = addDays(today, windowDays - 1);
  return live
    // A series whose evidence has run out is not a forecast. UBER *ONE last
    // charged 2025-05-25 and was still listed as a bill due next week, wearing
    // a "last seen 449d ago" chip — a label on a prediction that should not
    // have been made. `seriesHasLapsed`, NOT `isSeriesActive`: the latter also
    // calls a NEVER-posted series inactive, which would delete the $559.89 car
    // lease and $361.49 insurance the owner registered for 2026-09-11 and that
    // have no postings yet by definition.
    .filter((s) => !(lapsedSeriesShouldStopForecasting(s.kind) && seriesHasLapsed(s, today)))
    .flatMap((s) => projectOccurrences(toProjectable(s, seriesStaleness(s, today)), today, to))
    .sort((a, b) => compareDates(a.date, b.date) || a.name.localeCompare(b.name));
}

/**
 * What the evidence says about a series, by the SAME gates the forecast uses.
 *
 * 🔴 `/recurring`'s All tab filed seven series under "INACTIVE" on 2026-09-03:
 * five hand-registered commitments the bank has never billed and the owner's
 * weekly pay — each with a "Next" date on its own row, each projected one tab
 * over. `isSeriesActive` is "fresh", and a series can fail to be fresh three
 * different ways: it has never charged (nothing to be stale from — the
 * subscriptions card says "never billed"), it is late but still forecast, or
 * it has lapsed and the forecast has let it go. Money in is late, never lapsed
 * (`lapsedSeriesShouldStopForecasting`), which is why this reuses that gate
 * rather than restating it.
 *
 * Only meaningful for a detected/confirmed series; a dismissed or ended one is
 * described by its status, and callers badge those separately.
 */
export function seriesEvidence(
  s: SeriesOverrides & { status: SeriesStatus; kind: SeriesKind; lastMatchedOn: string | null },
  today: string = todayIso(),
): SeriesEvidence {
  if (s.lastMatchedOn === null) return "never-billed";
  if (isSeriesActive(s, today)) return "active";
  return lapsedSeriesShouldStopForecasting(s.kind) && seriesHasLapsed(s, today) ? "lapsed" : "running-late";
}
