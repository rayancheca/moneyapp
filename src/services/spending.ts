import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { LIVE_ROW, transactions } from "@/db/schema/transactions";
import { compareDates, diffDays, monthKey, periodBounds } from "@/lib/dates";
import { humanizeDescriptionKey, strippedDescriptionKey } from "@/lib/description-key";
// the stored `normalizedDescription` column IS normalizeDescription(raw)
// (manual-transactions.ts:148), so recomputing it here reproduces the value
// topMerchants groups on — activeTxnsInRange doesn't select that column
import { normalizeDescription } from "@/lib/normalize";
import { comparePeriods, type PeriodComparison } from "@/lib/compared-windows";
import {
  daysNotImportedYet,
  emptyPeriodCopy,
  emptyPeriodReason,
  unreachedKind,
  type UnreachedKind,
} from "@/lib/empty-period";
import { subBuckets, type ResolvedPeriod } from "@/lib/period";
import { alignByIndex, projectPace } from "@/lib/projection";
import { allocationsFor } from "@/lib/transaction-splits";
import { NO_MERCHANT, OTHER_SERIES_KEY, UNCATEGORIZED_SERIES_KEY } from "@/lib/ledger-href";
import { outsidePortfolioCashAccountIds } from "./accounts";
import {
  activeTxnsInRange,
  agentsCostBucket,
  isAgentsCostCategoryRow,
  isAgentsIncomeCategoryRow,
  isHisUnfiledSpending,
  isIncome,
  ledgerHref,
  loadCategoryIndex,
  spendingBucket,
  type CategoryIndex,
  type DateRange,
} from "./analytics";
import { spendingCoverageThrough } from "./movers-card";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
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
 * is money in). Income is positive amounts in income-kind categories, off the
 * agent's cash account (`isIncome` — owner decision 2026-09-28), and spending is
 * off it too (`spendingBucket` — owner decision 2026-10-02).
 * (Per-category breakdown in analytics.ts stays netted — a separate view.)
 */

const TOP_SPENDING_SERIES = 7;

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

export function periodTotals(db: AppDatabase, range: DateRange): PeriodTotals {
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  let earnedCents = 0;
  let spentCents = 0;
  let refundsCents = 0;
  for (const txn of activeTxnsInRange(db, range.from, range.to)) {
    if (spendingBucket(idx, agentsCash, txn)) {
      // gross: only outflows are "spent"; a credit in an expense category is a refund
      if (txn.amountCents < 0) spentCents += -txn.amountCents;
      else refundsCents += txn.amountCents;
      continue;
    }
    if (isIncome(idx, agentsCash, txn)) earnedCents += txn.amountCents;
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
  /**
   * Null when the four figures above are a measurement; otherwise which world
   * the bucket sits in — it has not happened, it is before the records begin, or
   * nothing has been imported for it (`unreachedKind`). A bucket the ledger opens
   * or stops inside is a figure, and so is one holding a posted row.
   *
   * 🔴 S11. Every bucket was a zero shell with nothing said about coverage, and
   * the table lens printed each one. Measured 2026-09-14 on the owner's ledger:
   * `?period=2026-09&cash=table` rows 13–30 and `?period=2022-08&cash=table`
   * rows 1–24 read "$0.00 $0.00 $0.00", and `?period=2026` did the same of Oct,
   * Nov and Dec.
   *
   * ⛔ ADDITIVE: the figures stay zero. `computePace`, the dashboard's pace tile
   * and the graph's running totals read them, and a null in any of those would
   * move a number nobody asked to move. The tile's staircase and the graph's
   * lines read THIS field to stop drawing (`plottedRunningTotals`); no figure
   * either prints changes.
   */
  unreached: UnreachedKind | null;
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

/**
 * The ledger's own first day — what "All time" starts from.
 *
 * `resolvePeriod` is pure and only knows `today`, so a surface with database
 * access passes this in; without it "All time" falls back to a constant floor
 * and would draw years of empty axis before the first transaction.
 *
 * Null when the ledger is empty, in which case the caller keeps the floor.
 */
export function ledgerFirstDay(db: AppDatabase): string | null {
  const row = db
    .select({ day: sql<string | null>`MIN(${transactions.postedOn})` })
    .from(transactions)
    .where(inArray(transactions.status, [...LIVE_ROW]))
    .get();
  return row?.day ?? null;
}

export function cashFlowByPeriod(db: AppDatabase, period: ResolvedPeriod, today: string): CashFlow {
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const colorOf = categoryColors(db);
  const buckets = subBuckets(period);
  const byMonth = (buckets[0]?.key.length ?? 10) === 7;
  const bucketIndex = new Map(buckets.map((b, i) => [b.key, i]));
  const rows = activeTxnsInRange(db, period.from, period.to);

  // coverage is decided once the rows are classified — see the return below
  const shells: Omit<CashFlowBucket, "unreached">[] = buckets.map((b) => ({
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
    const sb = spendingBucket(idx, agentsCash, txn);
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
    } else if (isIncome(idx, agentsCash, txn)) {
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
  if (rankedSpend.length > topKeys.size) spendingSeries.push({ key: OTHER_SERIES_KEY, label: "Other", categoryId: null, hue: null });
  if (spendTotals.has("∅")) spendingSeries.push({ key: UNCATEGORIZED_SERIES_KEY, label: "Uncategorized", categoryId: null, hue: null });

  const incomeSeries: CashFlowSeries[] = [...incomeTotals.entries()]
    .sort((a, b) => b[1].cents - a[1].cents || a[1].name.localeCompare(b[1].name))
    .map(([id, v]) => ({ key: id, label: v.name, categoryId: id, hue: colorOf.get(id) ?? null }));

  for (const c of classified) {
    const shell = shells[c.bucket]!;
    if (c.kind === "spend") {
      const seriesKey = c.catKey === "∅" ? UNCATEGORIZED_SERIES_KEY : topKeys.has(c.catKey) ? c.catKey : OTHER_SERIES_KEY;
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

  /*
   * Whether each bucket's zero is a measurement — both ends of the ledger, future
   * first (`unreachedKind`). ⛔ Data wins: a bucket holding a classified row is a
   * figure even after today, because that row is already in its bars, in the
   * totals and in the projection's floor.
   */
  const opens = ledgerOpens(db);
  const reaches = ledgerReaches(db);
  const holdsRows = new Set(classified.map((c) => c.bucket));
  const reached: CashFlowBucket[] = shells.map((s, i) => ({
    ...s,
    unreached: holdsRows.has(i)
      ? null
      : unreachedKind({ from: s.from, to: s.to, today, ledgerOpens: opens, ledgerReaches: reaches }),
  }));

  return { buckets: reached, incomeSeries, spendingSeries, totals, pace };
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
  /**
   * Elapsed days of the period no import reaches (`daysNotImportedYet`, the
   * dashboard tile's arithmetic). Above zero, the pace and its to-date figure are
   * LOWER BOUNDS and the readout says "at least". Null unless in progress.
   */
  paceUncoveredDays: number | null;
  /** the comparable prior period — the "last {period}" total + per-bucket ghost; null when it had no spend */
  prior: {
    label: string;
    /** prior period GROSS spend total, integer cents */
    spentCents: number;
    /**
     * The prior period's own buckets aligned BY INDEX — `aligned[i]` is that
     * period's bucket i (its day 20 under this window's day 20), and `null`
     * where it has no bucket i.
     *
     * 🔴 This was a nearest-fraction RESAMPLE, and all three of its consumers
     * read it as per-bucket truth: the table printed it in a cell under a
     * column headed by a month name, the graph summed it, and the chart's
     * tooltip printed it as a dollar figure. A resample duplicates and drops
     * source buckets, so it neither names a day nor sums to `spentCents`.
     */
    aligned: (number | null)[];
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
 * is the comparison's prior window, whose gross spend curve becomes the ghost —
 * and ONLY when the comparison is whole (`lib/compared-windows`).
 */
export function spendingProjection(
  db: AppDatabase,
  period: ResolvedPeriod,
  today: string,
  currentPace: PaceInfo | null,
  fullPeriodSpentCents: number,
  /**
   * The page's one answer to "may this period be set against the one before
   * it". /spending computes it once and hands it to every lens that states a
   * change; the default asks the same question for a caller that has not.
   */
  comparison: PeriodComparison = periodComparison(db, period, today),
): SpendingProjection {
  let projectedSpendCents: number | null = null;
  let paceBasis: string | null = null;
  let paceConfidence: number | null = null;
  let paceUncoveredDays: number | null = null;
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
    paceUncoveredDays = daysNotImportedYet({
      from: period.from,
      to: period.to,
      today,
      ledgerOpens: ledgerOpens(db),
      ledgerReaches: ledgerReaches(db),
    });
  }

  /*
   * The comparable prior period — the ghost + "last {period}" total.
   *
   * 🔴 Its only guard was `spentCents > 0`: EMPTINESS, not coverage. A prior
   * window the ledger holds part of drew as a whole one — `?period=2023` read
   * "$4,528.51 in 2022" over a 2022 the ledger holds Aug 25 – Dec 31 of, and
   * `?period=2022-09&cash=table` headed a column "Spent, August 2022" over
   * $0.00 rows for Aug 1–24, days before the ledger opens. The emptiness guard
   * stays: a covered prior window with nothing in it still draws no flat zero.
   */
  let prior: SpendingProjection["prior"] = null;
  if (comparison.kind === "whole") {
    const prevFlow = cashFlowByPeriod(db, comparison.priorPeriod, today);
    if (prevFlow.totals.spentCents > 0) {
      prior = {
        label: comparison.prior.label,
        spentCents: prevFlow.totals.spentCents,
        aligned: alignByIndex(
          prevFlow.buckets.map((b) => b.spendingCents),
          subBuckets(period).length,
        ),
      };
    }
  }

  return { projectedSpendCents, paceBasis, paceConfidence, paceUncoveredDays, prior };
}

/**
 * Whether this period may be set against the one before it, and over which
 * days, fed from the ledger — `lib/compared-windows` owns the rule and its
 * sentences. The opening edge is the first active row; the closing edge is the
 * last day every account you spend from has been imported through, the same day
 * the dashboard's "What changed" card names (`spendingCoverageThrough`).
 */
export function periodComparison(db: AppDatabase, period: ResolvedPeriod, today: string): PeriodComparison {
  return comparePeriods({
    period,
    today,
    importedThrough: spendingCoverageThrough(db, today),
    ledgerOpens: ledgerOpens(db),
  });
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
  /**
   * Credits landing in an EXPENSE category — returns. Neither spending (the
   * comment on the loop says why) nor income, and until this existed a day
   * whose only row was one had nothing at all to report.
   */
  refundedCents: number;
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
  // the day's spent and earned bars are the Spent and Income cards' populations, read one day at a time
  const agentsCash = outsidePortfolioCashAccountIds(db);
  interface Cell {
    spentCents: number;
    incomeCents: number;
    refundedCents: number;
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
    refundedCents: 0,
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
    const bucket = spendingBucket(idx, agentsCash, txn);
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
    } else if (isIncome(idx, agentsCash, txn)) {
      cell.incomeCents += txn.amountCents;
    } else if (bucket) {
      // a credit in an expense category: the return the branch above skips
      cell.refundedCents += txn.amountCents;
    }
    byDay.set(txn.postedOn, cell);
  }

  const days: HeatDay[] = [...byDay.entries()]
    .map(([iso, c]) => ({
      iso,
      spentCents: c.spentCents,
      incomeCents: c.incomeCents,
      refundedCents: c.refundedCents,
      txnCount: c.txnIds.size,
      topCategories: topEntries(c.categories),
      topMerchants: topNamed([...c.merchants.values()]),
    }))
    .sort((a, b) => a.iso.localeCompare(b.iso));
  const maxOutflowCents = days.reduce((m, d) => Math.max(m, d.spentCents), 0);
  const maxInflowCents = days.reduce((m, d) => Math.max(m, d.incomeCents), 0);
  return { monthKey: month, days, maxOutflowCents, maxInflowCents };
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
  const agentsCash = outsidePortfolioCashAccountIds(db);
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
      /*
       * ⚖️ A category page's merchants are his, as its figure is (`spendingTransactions`): the agent's cash is left out
       * of an expense subtree, either sign (`isAgentsCostCategoryRow`, owner decision 2026-10-02). 🔴 /categories/<Fees>
       * listed "Robinhood Gold" — the agent's Gold fee — among the merchants of a total that no longer counted it.
       */
      const portion = allocs
        .filter((a) => a.categoryId !== null && subtreeIds.has(a.categoryId))
        .filter((a) => !isAgentsCostCategoryRow(idx, agentsCash, { ...a, accountId: r.accountId }))
        .reduce((sum, a) => sum + a.amountCents, 0);
      if (portion !== 0) out.push({ ...r, amountCents: portion });
    } else {
      // the SPENDING portion (both signs — refunds net within a merchant, the
      // established topMerchants semantics): a split mixing an expense part with
      // a non-spending part (Transfers/Income) reports only the expense
      // allocation, so these widgets reconcile with the split-aware Spent total.
      // For an unsplit / all-expense row this equals the full amount, unchanged.
      // ⛔ `spendingBucket` itself, both signs — a part is spending by the rule /spending's Spent is, so none on the
      // agent's cash is (owner decision 2026-10-02); this file kept a copy that never asked whose account.
      const spendCents = allocs
        .filter(
          (a) =>
            spendingBucket(idx, agentsCash, {
              accountId: r.accountId,
              categoryId: a.categoryId,
              amountCents: a.amountCents,
            }) !== null,
        )
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
  /** the filtered LEDGER for this group — every row behind the figure */
  href: string;
  /**
   * The merchant's own page, or null for a stripped-key group that has no
   * merchant record to have a page.
   *
   * Separate from `href` rather than replacing it: a test in spending.test.ts
   * follows `href` through the real ledger filter layer and asserts the row
   * count it returns, which is a guarantee worth keeping. The card renders the
   * two as sibling links so neither is nested inside the other.
   */
  profileHref: string | null;
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
    /** an unlinked group's identity — its ledger link filters by exactly this (`key=`) */
    strippedKey: string | null;
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
        strippedKey: null,
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
      strippedKey,
    };
    groups.set(key, { ...g, spentCents: g.spentCents + out, txnCount: g.txnCount + 1 });
  }

  /*
   * 🔴 THE LINK MUST CARRY THE SCOPE THE FIGURE WAS COMPUTED UNDER. These
   * numbers come from `spendingRowsInRange` — SPENDING rows only, and on a
   * category page only that category's subtree — while the href carried the
   * merchant and the window alone. Measured 2026-09-11 across `/spending` and
   * every category page for ten months: **34 of 497 rows disagreed with the
   * list their own link opens.**
   *
   *     /spending?period=2026-05   "Zelle · 1 transaction · $1,495.00"
   *                                 → 23 rows (14 Internal Transfer, 8
   *                                   Reimbursements, 1 Rent)
   *     /categories/<Weed>?period=2026-07
   *                                "Vape N Smoke Shop · 5 txns · $113.70"
   *                                 → 13 rows summing $335.68, the rest Shopping
   *
   * The type's own docstring calls this href "the filtered LEDGER for this
   * group — every row behind the figure", and the Honesty card on the same page
   * already passes its own filter and reconciles exactly.
   */
  const drillCategory = opts.categoryId ?? "spending";

  const entries: MerchantEntry[] = [...groups.values()]
    .sort((a, b) => b.spentCents - a.spentCents || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((g) => ({
      kind: g.kind,
      id: g.id,
      name: g.name,
      spentCents: g.spentCents,
      txnCount: g.txnCount,
      profileHref: g.kind === "merchant" ? `/merchants/${g.id!}` : null,
      href:
        g.kind === "merchant"
          ? ledgerHref({ category: drillCategory, merchant: g.id!, from: range.from, to: range.to })
          : ledgerHref({
              category: drillCategory,
              // ⛔ this group IS "rows with no merchant" (the loop above skips
              // every row that has one), and the link said only "rows whose
              // text looks like this". On the real ledger 2026-09-11
              // "LA PISCINE MIAMI BEACH · 26 transactions · unlinked · $730.15"
              // opened 29 rows / $857.06 — three of them LINKED rows sharing
              // the description. 33 of 616 rendered unlinked rows over-matched.
              merchant: NO_MERCHANT,
              // ⛔ …and rows whose descriptor strips to THIS key. The link carried
              // the longest literal run found in every member row, and a LIKE over
              // that run matched every row CONTAINING it: on the real ledger
              // 2026-09-14, /categories/<Fees>?period=2023 "FOREIGN EXCH RT ADJ FEE
              // IBERIA MADRID CARD 7782 · 1 transaction" opened 16 rows, and 43 of
              // 1,074 rendered unlinked rows over-matched. (Linking the derived NAME
              // instead had opened an empty ledger — no row contains a stripped key.)
              key: g.strippedKey!,
              from: range.from,
              to: range.to,
            }),
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
  const agentsCash = outsidePortfolioCashAccountIds(db);
  let uncatSpent = 0;
  let uncatCount = 0;
  for (const txn of activeTxnsInRange(db, range.from, range.to)) {
    /*
     * ⚖️ HIS unfiled money out — `spendingBucket`'s own leg, as the Uncategorized row of the category table and the
     * Spent card count it: what leaves the agent's cash unfiled is not his spending (owner decision 2026-10-05). 🔴 This
     * kept its own copy — NULL and negative — so it would have gone on charging him the agent's rows.
     */
    if (isHisUnfiledSpending(idx, agentsCash, txn)) {
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

// ── The empty state ──────────────────────────────────────────────────

/**
 * How many transactions in a window are the AGENT'S spending or income — the rows `spendingBucket` and `isIncome`
 * leave out for whose they are, and only those: what its account paid in an expense category or unfiled
 * (`agentsCostBucket`), and any row of an income category on its cash, either sign (`isAgentsIncomeCategoryRow`) —
 * what it was paid, and a clawback of it, which lowers "Agent's income" on the bridge and at the pace (owner decision
 * 2026-10-06, §6A 43). Its transfers are not among them — the $26.64 he funded it with is a transfer, which /spending's
 * empty state already says it does not count.
 *
 * 🔴 It asked the credits alone (`isAgentsIncome`), so a day holding only the agent's clawback read a measured zero and
 * never said the agent's money was left out.
 *
 * `categoryId` narrows it to one category's subtree — the rows `/categories/<id>` leaves out of its own
 * (`spendingTransactions`): the agent's in an income or expense category, and none in a page that lists every account
 * (a transfer, the system "Uncategorized", whose rows arrive unfiled).
 */
export function agentsMoneyRowCount(db: AppDatabase, range: DateRange, scope: { categoryId?: string } = {}): number {
  const agentsCash = outsidePortfolioCashAccountIds(db);
  if (agentsCash.size === 0) return 0;
  const idx = loadCategoryIndex(db);
  const subtree = scope.categoryId === undefined ? null : new Set(idx.subtreeIds(scope.categoryId));
  const ids = activeTxnsInRange(db, range.from, range.to)
    .filter((t) => subtree === null || (t.categoryId !== null && subtree.has(t.categoryId)))
    .filter((t) => agentsCostBucket(idx, agentsCash, t) !== null || isAgentsIncomeCategoryRow(idx, agentsCash, t))
    // distinct transactions — a split row arrives as one part-row per part
    .map((t) => t.id);
  return new Set(ids).size;
}

/** What `/spending` and `/categories/<id>` hand their empty state: the window's world and how to name its days. */
interface EmptyCopyOpts {
  today: string;
  /** the period's own name — "September 2026" */
  label: string;
  ledgerOpens: string | null;
  ledgerReaches: string | null;
  formatDay: (iso: string) => string;
}

function emptyReasonFor(range: DateRange, opts: EmptyCopyOpts) {
  return emptyPeriodReason({
    from: range.from,
    to: range.to,
    today: opts.today,
    ledgerOpens: opts.ledgerOpens,
    ledgerReaches: opts.ledgerReaches,
  });
}

/**
 * /spending's empty state: which world its window is in (`emptyPeriodReason`) and the words for it, with the two
 * clauses this page alone can offer — his own Uncategorized bucket, which the page prints when there is one, and the
 * agent's money, said to be left out when the window holds some.
 *
 * ⚖️ What the agent's own account pays or is paid is none of his spending or income (owner decisions 2026-09-28,
 * 2026-10-02, 2026-10-05), so a window holding only the agent's money comes here. 🔴 Composed on the page, it read
 * "Uncategorized outflows would show up above, as their own explicit bucket" over a day whose only outflow was the
 * agent's unfiled ACH withdrawal — which shows up nowhere — and said nothing of it.
 */
export function spendingEmptyCopy(
  db: AppDatabase,
  range: DateRange,
  opts: EmptyCopyOpts,
): { title: string; description: string } {
  return emptyPeriodCopy(emptyReasonFor(range, opts), opts.label, opts.ledgerReaches, opts.formatDay, {
    uncategorizedBucket: true,
    ledgerOpens: opts.ledgerOpens,
    agentsMoney: agentsMoneyRowCount(db, range) > 0,
  });
}

/**
 * `/categories/<id>`'s empty state: `spendingEmptyCopy`'s, asked of one category — no Uncategorized bucket, which the
 * page does not print, and the agent's money said to be left out where the window holds some IN THIS CATEGORY
 * (`agentsMoneyRowCount`'s `categoryId`), the rows the page's own list leaves out for whose they are.
 *
 * 🔴 The page composed the copy itself, without the flag: a Bank Fees day holding only the agent's Gold fee read "a
 * measured zero" and said nothing of it (owner decisions 2026-10-02, 2026-10-06; §6A 34, §6A 43).
 */
export function categoryEmptyCopy(
  db: AppDatabase,
  categoryId: string,
  range: DateRange,
  opts: EmptyCopyOpts,
): { title: string; description: string } {
  return emptyPeriodCopy(emptyReasonFor(range, opts), opts.label, opts.ledgerReaches, opts.formatDay, {
    ledgerOpens: opts.ledgerOpens,
    agentsMoney: agentsMoneyRowCount(db, range, { categoryId }) > 0,
  });
}
