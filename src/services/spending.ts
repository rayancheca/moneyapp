import { and, eq, gte, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { compareDates, diffDays, monthKey, periodBounds } from "@/lib/dates";
import { humanizeDescriptionKey, strippedDescriptionKey } from "@/lib/description-key";
// the stored `normalizedDescription` column IS normalizeDescription(raw)
// (manual-transactions.ts:148), so recomputing it here reproduces the value
// topMerchants groups on — activeTxnsInRange doesn't select that column
import { normalizeDescription } from "@/lib/normalize";
import { resolvePeriod, stepPeriodParams, subBuckets, type ResolvedPeriod } from "@/lib/period";
import { projectPace, reindexByPosition } from "@/lib/projection";
import { allocationsFor } from "@/lib/transaction-splits";
import {
  activeTxnsInRange,
  ledgerHref,
  loadCategoryIndex,
  spendingBucket,
  type AnalyticsTxn,
  type CategoryIndex,
  type DateRange,
} from "./analytics";
import { activeSplitsInRange } from "./transaction-splits";

/**
 * Spending-tab aggregates (ux-overhaul-plan §5.5). Every function shares the
 * analytics classification (spendingBucket / income-kind positives) so the
 * StatCards, the mirrored cash-flow chart, the heatmap, and every drill-down
 * reconcile to the same rows the ledger shows — a displayed number is always a
 * visitable list. No schema change.
 *
 * Sign convention: "Spent" is GROSS money out — only expense-category DEBITS
 * (and uncategorized outflows) count, matching period-activity.ts. A positive
 * amount in an expense category (a refund / statement credit / miscategorized
 * inflow) is NOT spending and never nets the outflow down — it is surfaced as
 * `refundsCents` so a big cross-period credit can't drag "Spent" nonsensically
 * negative. Net still reconciles: netCents = earned + refunds − spent (a refund
 * is money in). Income is positive amounts in income-kind categories.
 * (Per-category breakdown in analytics.ts stays netted — a separate view.)
 */

const TOP_SPENDING_SERIES = 7;
const OTHER_KEY = "__other";
const UNCAT_KEY = "__uncat";

export type { DateRange };

// ── Period totals (the StatCards) ────────────────────────────────────

export interface PeriodTotals {
  /** income (money in) over the period, positive */
  earnedCents: number;
  /** GROSS spending (expense-category debits + uncategorized outflows), positive, always ≥ 0 */
  spentCents: number;
  /** refunds/credits in expense categories over the period, positive — money back, not spending */
  refundsCents: number;
  /** true net cash flow: earned + refunds − spent (can be negative) */
  netCents: number;
  /** net ÷ earned as a percentage, or null when there was no income */
  savingsRatePct: number | null;
}

function isIncome(idx: CategoryIndex, txn: AnalyticsTxn): boolean {
  return (
    txn.categoryId !== null &&
    txn.amountCents > 0 &&
    idx.topLevelOf(txn.categoryId).kind === "income"
  );
}

export function periodTotals(db: AppDatabase, range: DateRange): PeriodTotals {
  const idx = loadCategoryIndex(db);
  let earnedCents = 0;
  let spentCents = 0;
  let refundsCents = 0;
  for (const txn of activeTxnsInRange(db, range.from, range.to)) {
    if (spendingBucket(idx, txn)) {
      // gross: only outflows are "spent"; a credit in an expense category is a refund
      if (txn.amountCents < 0) spentCents += -txn.amountCents;
      else refundsCents += txn.amountCents;
      continue;
    }
    if (isIncome(idx, txn)) earnedCents += txn.amountCents;
  }
  const netCents = earnedCents + refundsCents - spentCents;
  return {
    earnedCents,
    spentCents,
    refundsCents,
    netCents,
    savingsRatePct: earnedCents > 0 ? Math.round((netCents / earnedCents) * 1000) / 10 : null,
  };
}

// ── Combined cash-flow (mirrored bars + net line + pace) ─────────────

export interface CashFlowSeries {
  key: string;
  label: string;
  /** category id, or null for the Other / Uncategorized aggregates */
  categoryId: string | null;
  /** category hue name (categories.color), null for neutral aggregates */
  hue: string | null;
}

export interface CashFlowBucket {
  key: string;
  label: string;
  from: string;
  to: string;
  /** income series key → cents (positive, above axis) */
  income: Record<string, number>;
  /** spending series key → cents (positive magnitude, below axis) */
  spending: Record<string, number>;
  incomeCents: number;
  /** GROSS spending (debits only) for the bucket */
  spendingCents: number;
  /** refunds/credits in expense categories for the bucket, positive */
  refundsCents: number;
  /** income + refunds − spending for the bucket */
  netCents: number;
}

export interface PaceInfo {
  /** fraction of the period elapsed as of today, 0..1 */
  elapsedFraction: number;
  /** spending from the period start through today */
  actualToDateCents: number;
  /** linear projection of the full-period spend */
  projectedCents: number;
  /** typical spend per elapsed bucket — the dotted "ideal pace" reference */
  avgPerBucketCents: number;
}

export interface CashFlow {
  buckets: CashFlowBucket[];
  incomeSeries: CashFlowSeries[];
  spendingSeries: CashFlowSeries[];
  totals: PeriodTotals;
  /** present only for the in-progress period */
  pace: PaceInfo | null;
}

function categoryColors(db: AppDatabase): Map<string, string | null> {
  return new Map(
    db.select({ id: categories.id, color: categories.color }).from(categories).all().map((c) => [c.id, c.color]),
  );
}

/** month buckets have 7-char keys ("YYYY-MM"); day buckets have 10-char ISO keys. */
function bucketKeyFor(postedOn: string, byMonth: boolean): string {
  return byMonth ? monthKey(postedOn) : postedOn;
}

export function cashFlowByPeriod(db: AppDatabase, period: ResolvedPeriod, today: string): CashFlow {
  const idx = loadCategoryIndex(db);
  const colorOf = categoryColors(db);
  const buckets = subBuckets(period);
  const byMonth = (buckets[0]?.key.length ?? 10) === 7;
  const bucketIndex = new Map(buckets.map((b, i) => [b.key, i]));
  const rows = activeTxnsInRange(db, period.from, period.to);

  const shells: CashFlowBucket[] = buckets.map((b) => ({
    key: b.key,
    label: b.label,
    from: b.from,
    to: b.to,
    income: {},
    spending: {},
    incomeCents: 0,
    spendingCents: 0,
    refundsCents: 0,
    netCents: 0,
  }));

  interface Classified {
    bucket: number;
    kind: "spend" | "income" | "refund";
    /** spending: top-level id or "∅"; income: subcategory id */
    catKey: string;
    name: string;
    /** spending magnitude (positive), income amount (positive), or refund (positive) */
    cents: number;
  }
  const classified: Classified[] = [];
  const spendTotals = new Map<string, { name: string; cents: number }>();
  const incomeTotals = new Map<string, { name: string; cents: number }>();
  let earnedCents = 0;
  let spentCents = 0;
  let refundsCents = 0;
  let actualToDateCents = 0;

  for (const txn of rows) {
    const bucket = bucketIndex.get(bucketKeyFor(txn.postedOn, byMonth));
    if (bucket === undefined) continue;
    const sb = spendingBucket(idx, txn);
    if (sb) {
      // gross: only outflows are spending; a credit in an expense category is a refund
      if (txn.amountCents >= 0) {
        refundsCents += txn.amountCents;
        classified.push({ bucket, kind: "refund", catKey: sb.categoryId ?? "∅", name: sb.categoryName, cents: txn.amountCents });
        continue;
      }
      const out = -txn.amountCents;
      spentCents += out;
      if (compareDates(txn.postedOn, today) <= 0) actualToDateCents += out;
      const catKey = sb.categoryId ?? "∅";
      const total = spendTotals.get(catKey) ?? { name: sb.categoryName, cents: 0 };
      spendTotals.set(catKey, { name: sb.categoryName, cents: total.cents + out });
      classified.push({ bucket, kind: "spend", catKey, name: sb.categoryName, cents: out });
    } else if (isIncome(idx, txn)) {
      const node = idx.byId.get(txn.categoryId!)!;
      earnedCents += txn.amountCents;
      const total = incomeTotals.get(node.id) ?? { name: node.name, cents: 0 };
      incomeTotals.set(node.id, { name: node.name, cents: total.cents + txn.amountCents });
      classified.push({ bucket, kind: "income", catKey: node.id, name: node.name, cents: txn.amountCents });
    }
  }

  // spending series: top N by total + Other + Uncategorized (always explicit)
  const rankedSpend = [...spendTotals.entries()]
    .filter(([k]) => k !== "∅")
    .sort((a, b) => b[1].cents - a[1].cents || a[1].name.localeCompare(b[1].name));
  const topKeys = new Set(rankedSpend.slice(0, TOP_SPENDING_SERIES).map(([k]) => k));
  const spendingSeries: CashFlowSeries[] = rankedSpend
    .filter(([k]) => topKeys.has(k))
    .map(([k, v]) => ({ key: k, label: v.name, categoryId: k, hue: colorOf.get(k) ?? null }));
  if (rankedSpend.length > topKeys.size) spendingSeries.push({ key: OTHER_KEY, label: "Other", categoryId: null, hue: null });
  if (spendTotals.has("∅")) spendingSeries.push({ key: UNCAT_KEY, label: "Uncategorized", categoryId: null, hue: null });

  const incomeSeries: CashFlowSeries[] = [...incomeTotals.entries()]
    .sort((a, b) => b[1].cents - a[1].cents || a[1].name.localeCompare(b[1].name))
    .map(([id, v]) => ({ key: id, label: v.name, categoryId: id, hue: colorOf.get(id) ?? null }));

  for (const c of classified) {
    const shell = shells[c.bucket]!;
    if (c.kind === "spend") {
      const seriesKey = c.catKey === "∅" ? UNCAT_KEY : topKeys.has(c.catKey) ? c.catKey : OTHER_KEY;
      shell.spending[seriesKey] = (shell.spending[seriesKey] ?? 0) + c.cents;
      shell.spendingCents += c.cents;
      shell.netCents -= c.cents;
    } else if (c.kind === "refund") {
      // a refund is money in — it lifts net but is NOT charted as spending
      shell.refundsCents += c.cents;
      shell.netCents += c.cents;
    } else {
      shell.income[c.catKey] = (shell.income[c.catKey] ?? 0) + c.cents;
      shell.incomeCents += c.cents;
      shell.netCents += c.cents;
    }
  }

  const netCents = earnedCents + refundsCents - spentCents;
  const totals: PeriodTotals = {
    earnedCents,
    spentCents,
    refundsCents,
    netCents,
    savingsRatePct: earnedCents > 0 ? Math.round((netCents / earnedCents) * 1000) / 10 : null,
  };
  const pace = period.isCurrent ? computePace(period, buckets, actualToDateCents, today) : null;

  return { buckets: shells, incomeSeries, spendingSeries, totals, pace };
}

function computePace(
  period: ResolvedPeriod,
  buckets: readonly { from: string }[],
  actualToDateCents: number,
  today: string,
): PaceInfo {
  const totalDays = diffDays(period.from, period.to) + 1;
  const cappedToday = compareDates(today, period.to) > 0 ? period.to : today;
  const elapsedDays = Math.min(totalDays, Math.max(1, diffDays(period.from, cappedToday) + 1));
  const elapsedFraction = elapsedDays / totalDays;
  const elapsedBuckets = buckets.filter((b) => compareDates(b.from, today) <= 0).length || 1;
  return {
    elapsedFraction,
    actualToDateCents,
    projectedCents: elapsedFraction > 0 ? Math.round(actualToDateCents / elapsedFraction) : 0,
    avgPerBucketCents: Math.round(actualToDateCents / elapsedBuckets),
  };
}

// ── Projection overlay (North Star #2, Pillar 1) ─────────────────────

/**
 * The estimate companion for the cash-flow chart: "you've spent $X; at this
 * pace $Y by period-end; last period you spent $Z." The math is the shared,
 * unit-tested projection engine (`@/lib/projection`) — this is the DB-coupled
 * wiring only. Honest by construction: the pace figure carries its visible-math
 * `basis` + a `confidence` the UI renders fainter when thin; the prior period is
 * a historical fact drawn as a faint ghost, never dressed up as a forecast.
 */
export interface SpendingProjection {
  /** projected full-period GROSS spend at the current pace; null unless the period is in progress */
  projectedSpendCents: number | null;
  /** the pace method's visible-math basis (e.g. "pace from 8 of 31 days elapsed"); null unless in progress */
  paceBasis: string | null;
  /** 0..1 pace confidence — low ⇒ render fainter + say so; null unless in progress */
  paceConfidence: number | null;
  /** the comparable prior period — the "last {period}" total + per-bucket ghost; null when it had no spend */
  prior: {
    label: string;
    /** prior period GROSS spend total, integer cents */
    spentCents: number;
    /** prior gross spend per bucket, re-indexed to the CURRENT bucket count so it overlays 1:1 */
    ghost: number[];
  } | null;
}

/**
 * Build the projection overlay for a period. `currentPace` is the already-
 * computed pace from `cashFlowByPeriod` (its `actualToDateCents` is the pace
 * basis) — passed in so we don't re-scan the current period. `fullPeriodSpentCents`
 * is the whole-period GROSS spend (`cashFlow.totals.spentCents`), used to FLOOR
 * the projection: a period can contain future-dated-but-active charges (posted
 * after today, still ≤ period end) that the bars + StatCards already show, so the
 * pace estimate must never read below what's already committed. The prior period
 * is the same window one step earlier (`stepPeriodParams(period, -1)`), whose
 * gross spend curve becomes the ghost.
 */
export function spendingProjection(
  db: AppDatabase,
  period: ResolvedPeriod,
  today: string,
  currentPace: PaceInfo | null,
  fullPeriodSpentCents: number,
): SpendingProjection {
  let projectedSpendCents: number | null = null;
  let paceBasis: string | null = null;
  let paceConfidence: number | null = null;
  // pace only means something for an in-progress period (a past period is done —
  // its "projection" would just be its actual, so we don't fabricate one).
  if (period.isCurrent && currentPace) {
    const proj = projectPace({
      from: period.from,
      to: period.to,
      today,
      actualToDateCents: currentPace.actualToDateCents,
      // never project below the full-period spend already booked + displayed
      // (mirrors budgets.ts's Math.max(spent, forecast)).
      floorCents: fullPeriodSpentCents,
    });
    projectedSpendCents = proj.expectedTotalCents;
    paceBasis = proj.basis;
    paceConfidence = proj.confidence;
  }

  // the comparable prior period — the ghost + "last {period}" total
  const prevPeriod = resolvePeriod(stepPeriodParams(period, -1), today);
  const prevFlow = cashFlowByPeriod(db, prevPeriod, today);
  const bucketCount = subBuckets(period).length;
  const prior =
    prevFlow.totals.spentCents > 0
      ? {
          label: prevPeriod.label,
          spentCents: prevFlow.totals.spentCents,
          ghost: reindexByPosition(
            prevFlow.buckets.map((b) => b.spendingCents),
            bucketCount,
          ),
        }
      : null;

  return { projectedSpendCents, paceBasis, paceConfidence, prior };
}

/**
 * The exact ledger link behind a clicked chart segment. A real category (income
 * or spending) drills to that category + bucket window; the Uncategorized
 * aggregate drills to the category-less bucket rows; Other (an aggregate of
 * many small categories) drills to the whole bucket window.
 */
export function cashFlowSegmentHref(
  seriesKey: string,
  categoryId: string | null,
  bucket: DateRange,
  /** 'in' for income segments (positive-only), so the drill matches the bar */
  flow?: "in" | "out",
): string {
  // Uncategorized spending is negatives-only → drill to outflows so it reconciles
  if (seriesKey === UNCAT_KEY) return ledgerHref({ category: null, from: bucket.from, to: bucket.to, flow: "out" });
  // Other is an aggregate of many small categories with no single exact filter —
  // it is not clickable in the chart, so this path is unused; kept honest anyway.
  if (seriesKey === OTHER_KEY) return ledgerHref({ from: bucket.from, to: bucket.to });
  return ledgerHref({ category: categoryId ?? undefined, from: bucket.from, to: bucket.to, flow });
}

// ── Day-level heatmap ────────────────────────────────────────────────

/** A named slice of a day's spending — a category or a merchant. */
export interface HeatDayEntry {
  name: string;
  /** positive money out attributed to this name */
  cents: number;
}

export interface HeatDay {
  iso: string;
  /** gross money out this day, positive */
  spentCents: number;
  /** gross money in this day, positive */
  incomeCents: number;
  /** how many spending rows make up spentCents (income and refunds are not rows) */
  txnCount: number;
  /** where the money went, biggest first — top-level categories, at most 3 */
  topCategories: HeatDayEntry[];
  /** who it went to, biggest first — merchant name, or the raw descriptor when
   *  the row carries no merchant link — at most 3 */
  topMerchants: HeatDayEntry[];
}

/** Biggest first, capped — the day cell and its sheet stay readable. */
const TOP_PER_DAY = 3;
function topEntries(totals: Map<string, number>): HeatDayEntry[] {
  return topNamed([...totals.entries()].map(([name, cents]) => ({ name, cents })));
}

function topNamed(entries: HeatDayEntry[]): HeatDayEntry[] {
  return [...entries].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name)).slice(0, TOP_PER_DAY);
}

export interface SpendHeatmap {
  monthKey: string;
  /** only days with activity — the grid defaults the rest to zero */
  days: HeatDay[];
  /** largest single-day outflow */
  maxOutflowCents: number;
  /** largest single-day inflow. The cells scale the spent AND earned bars by the
   *  larger of the two, so a longer bar always means more money — two
   *  independently-normalised scales would let a small income out-draw a big spend. */
  maxInflowCents: number;
}

export function dailySpendHeatmap(db: AppDatabase, month: string): SpendHeatmap {
  const from = `${month}-01`;
  const to = periodBounds(from, "monthly").end;
  const idx = loadCategoryIndex(db);
  interface Cell {
    spentCents: number;
    incomeCents: number;
    /** distinct PARENT transaction ids — a split explodes into one row per part,
     *  so counting rows would over-count one purchase as several and diverge from
     *  the plain /transactions list the day sheet links to */
    txnIds: Set<string>;
    categories: Map<string, number>;
    /** grouping key → { name, cents }; the key is namespaced by kind so a
     *  merchant's canonical name can never silently merge with an unlinked row
     *  that happens to read the same */
    merchants: Map<string, { name: string; cents: number }>;
  }
  const newCell = (): Cell => ({
    spentCents: 0,
    incomeCents: 0,
    txnIds: new Set(),
    categories: new Map(),
    merchants: new Map(),
  });
  const byDay = new Map<string, Cell>();
  // one small lookup for the whole month; unlinked rows fall back to their own
  // descriptor, the same "name it honestly or name the raw string" rule
  // topMerchants follows
  const merchantName = new Map(
    db.select({ id: merchants.id, name: merchants.canonicalName }).from(merchants).all().map((m) => [m.id, m.name]),
  );

  for (const txn of activeTxnsInRange(db, from, to)) {
    const cell = byDay.get(txn.postedOn) ?? newCell();
    const bucket = spendingBucket(idx, txn);
    // gross: a refund (positive in an expense category) is not a day's spending
    if (bucket && txn.amountCents < 0) {
      const out = -txn.amountCents;
      cell.spentCents += out;
      cell.txnIds.add(txn.id);
      cell.categories.set(bucket.categoryName, (cell.categories.get(bucket.categoryName) ?? 0) + out);
      // group + name unlinked rows the SAME way topMerchants does (the card right
      // beside this one), or the two disagree about one payee on one page: the
      // stripped key collapses per-swipe store numbers, dates and amounts
      const linked = txn.merchantId ? merchantName.get(txn.merchantId) : undefined;
      const strippedKey = linked ? null : strippedDescriptionKey(normalizeDescription(txn.rawDescription));
      const key = linked ? `m:${txn.merchantId}` : `k:${strippedKey}`;
      const name = linked ?? humanizeDescriptionKey(strippedKey!);
      const entry = cell.merchants.get(key) ?? { name, cents: 0 };
      entry.cents += out;
      cell.merchants.set(key, entry);
    } else if (isIncome(idx, txn)) {
      cell.incomeCents += txn.amountCents;
    }
    byDay.set(txn.postedOn, cell);
  }

  const days: HeatDay[] = [...byDay.entries()]
    .map(([iso, c]) => ({
      iso,
      spentCents: c.spentCents,
      incomeCents: c.incomeCents,
      txnCount: c.txnIds.size,
      topCategories: topEntries(c.categories),
      topMerchants: topNamed([...c.merchants.values()]),
    }))
    .sort((a, b) => a.iso.localeCompare(b.iso));
  const maxOutflowCents = days.reduce((m, d) => Math.max(m, d.spentCents), 0);
  const maxInflowCents = days.reduce((m, d) => Math.max(m, d.incomeCents), 0);
  return { monthKey: month, days, maxOutflowCents, maxInflowCents };
}

/** `/transactions?from=D&to=D` — the literal "tap any day" destination. */
export function dayLedgerHref(iso: string): string {
  return ledgerHref({ from: iso, to: iso });
}

// ── Spending rows (shared by top-merchants + largest) ────────────────

interface SpendRow {
  id: string;
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  normalizedDescription: string;
  merchantId: string | null;
  categoryId: string | null;
  accountName: string;
}

/** Whether one category allocation counts as spending (mirrors spendingBucket). */
function allocationIsSpending(idx: CategoryIndex, categoryId: string | null, amountCents: number): boolean {
  if (categoryId === null) return amountCents < 0; // uncategorized outflow
  return idx.topLevelOf(categoryId).kind === "expense";
}

/**
 * Active rows classified as spending, joined with account name — split-aware.
 *
 * WITHOUT `subtreeIds` (largest purchases / global merchants): one WHOLE-
 * transaction row per spend-like transaction (a transaction counts if any of
 * its allocations is spending), keeping "largest purchases" and merchant totals
 * at transaction granularity. WITH `subtreeIds` (a category page): one row per
 * transaction carrying only the PORTION allocated to that subtree, so a split
 * transaction contributes just its matching part to that category's merchants.
 */
function spendingRowsInRange(
  db: AppDatabase,
  idx: CategoryIndex,
  range: DateRange,
  subtreeIds?: ReadonlySet<string>,
): SpendRow[] {
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      rawDescription: transactions.rawDescription,
      normalizedDescription: transactions.normalizedDescription,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        eq(transactions.status, "active"),
        gte(transactions.postedOn, range.from),
        lte(transactions.postedOn, range.to),
      ),
    )
    .all();

  const splits = activeSplitsInRange(db, range.from, range.to);
  const out: SpendRow[] = [];
  for (const r of rows) {
    const allocs = allocationsFor(r.categoryId, r.amountCents, splits.get(r.id) ?? []);
    if (subtreeIds) {
      const portion = allocs
        .filter((a) => a.categoryId !== null && subtreeIds.has(a.categoryId))
        .reduce((sum, a) => sum + a.amountCents, 0);
      if (portion !== 0) out.push({ ...r, amountCents: portion });
    } else {
      // the SPENDING portion (both signs — refunds net within a merchant, the
      // established topMerchants semantics): a split mixing an expense part with
      // a non-spending part (Transfers/Income) reports only the expense
      // allocation, so these widgets reconcile with the split-aware Spent total.
      // For an unsplit / all-expense row this equals the full amount, unchanged.
      const spendCents = allocs
        .filter((a) => allocationIsSpending(idx, a.categoryId, a.amountCents))
        .reduce((sum, a) => sum + a.amountCents, 0);
      if (spendCents !== 0) out.push({ ...r, amountCents: spendCents });
    }
  }
  return out;
}

// ── Top merchants (merchant + stripped-key, coverage %) ──────────────

export interface MerchantEntry {
  kind: "merchant" | "unlinked";
  /** merchant id, or null for a stripped-key group */
  id: string | null;
  name: string;
  /** net money out for the group, positive */
  spentCents: number;
  txnCount: number;
  href: string;
}

export interface TopMerchants {
  entries: MerchantEntry[];
  /** share of spending rows that carry a merchant link, 0..100 */
  coveragePct: number;
  linkedCount: number;
  unlinkedCount: number;
}

export function topMerchants(
  db: AppDatabase,
  range: DateRange,
  limit = 8,
  opts: { categoryId?: string } = {},
): TopMerchants {
  const idx = loadCategoryIndex(db);
  const subtreeIds = opts.categoryId ? new Set(idx.subtreeIds(opts.categoryId)) : undefined;
  const rows = spendingRowsInRange(db, idx, range, subtreeIds);
  const merchantName = new Map(
    db.select({ id: merchants.id, name: merchants.canonicalName }).from(merchants).all().map((m) => [m.id, m.name]),
  );

  interface Group {
    kind: "merchant" | "unlinked";
    id: string | null;
    name: string;
    spentCents: number;
    txnCount: number;
    /** a representative descriptor for the unlinked-group search link */
    query: string | null;
  }
  const groups = new Map<string, Group>();
  let linkedCount = 0;

  for (const r of rows) {
    const out = -r.amountCents;
    if (r.merchantId) {
      linkedCount += 1;
      const key = `m:${r.merchantId}`;
      const g = groups.get(key) ?? {
        kind: "merchant" as const,
        id: r.merchantId,
        name: merchantName.get(r.merchantId) ?? "Unknown merchant",
        spentCents: 0,
        txnCount: 0,
        query: null,
      };
      groups.set(key, { ...g, spentCents: g.spentCents + out, txnCount: g.txnCount + 1 });
      continue;
    }
    const strippedKey = strippedDescriptionKey(r.normalizedDescription);
    if (strippedKey === "") continue; // nothing to group by — omit, don't invent
    const key = `k:${strippedKey}`;
    const label = humanizeDescriptionKey(strippedKey);
    const g = groups.get(key) ?? {
      kind: "unlinked" as const,
      id: null,
      name: label,
      spentCents: 0,
      txnCount: 0,
      query: label,
    };
    groups.set(key, { ...g, spentCents: g.spentCents + out, txnCount: g.txnCount + 1 });
  }

  const entries: MerchantEntry[] = [...groups.values()]
    .sort((a, b) => b.spentCents - a.spentCents || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((g) => ({
      kind: g.kind,
      id: g.id,
      name: g.name,
      spentCents: g.spentCents,
      txnCount: g.txnCount,
      href:
        g.kind === "merchant"
          ? ledgerHref({ merchant: g.id!, from: range.from, to: range.to })
          : ledgerHref({ q: g.query!, from: range.from, to: range.to }),
    }));

  const total = rows.length;
  return {
    entries,
    coveragePct: total === 0 ? 100 : Math.round((linkedCount / total) * 1000) / 10,
    linkedCount,
    unlinkedCount: total - linkedCount,
  };
}

// ── Largest purchases ────────────────────────────────────────────────

export interface LargestTxn {
  id: string;
  postedOn: string;
  rawDescription: string;
  amountCents: number;
  categoryId: string | null;
  merchantId: string | null;
  accountName: string;
}

export function largestTransactions(db: AppDatabase, range: DateRange, limit = 5): LargestTxn[] {
  const idx = loadCategoryIndex(db);
  return spendingRowsInRange(db, idx, range)
    .filter((r) => r.amountCents < 0) // actual outflows, not refunds
    .sort((a, b) => a.amountCents - b.amountCents || a.id.localeCompare(b.id)) // most negative first
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      postedOn: r.postedOn,
      rawDescription: r.rawDescription,
      amountCents: r.amountCents,
      categoryId: r.categoryId,
      merchantId: r.merchantId,
      accountName: r.accountName,
    }));
}

// ── Honesty buckets (Uncategorized + Excluded) ───────────────────────

export interface HonestyBuckets {
  uncategorized: { spentCents: number; txnCount: number; href: string };
  excluded: { txnCount: number; href: string };
}

export function honestyBuckets(db: AppDatabase, range: DateRange): HonestyBuckets {
  const idx = loadCategoryIndex(db);
  let uncatSpent = 0;
  let uncatCount = 0;
  for (const txn of activeTxnsInRange(db, range.from, range.to)) {
    if (txn.categoryId === null && txn.amountCents < 0) {
      uncatSpent += -txn.amountCents;
      uncatCount += 1;
    }
  }
  const excludedCount = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "excluded"),
        gte(transactions.postedOn, range.from),
        lte(transactions.postedOn, range.to),
      ),
    )
    .all().length;

  return {
    uncategorized: {
      spentCents: uncatSpent,
      txnCount: uncatCount,
      // negatives-only aggregate → outflow-scoped drill (drill-down contract)
      href: ledgerHref({ category: null, from: range.from, to: range.to, flow: "out" }),
    },
    excluded: {
      txnCount: excludedCount,
      href: ledgerHref({ view: "excluded", from: range.from, to: range.to }),
    },
  };
}
