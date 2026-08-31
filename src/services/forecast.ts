import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addCalendarMonths, addDays, compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { projectOngoingIncome } from "@/lib/income-forecast";
import { formatCents } from "@/lib/money";
import { allocationsFor } from "@/lib/transaction-splits";
import { latestBalances } from "./derivation";
import { latestBridgedNetWorthCents } from "./in-flight";
import {
  projectOccurrences,
  seriesStaleness,
  toProjectable,
  type SeriesOccurrence,
  type SeriesStaleness,
  lapsedSeriesShouldStopForecasting,
  seriesHasLapsed,
} from "./recurring";
import { activeSplitsInRange } from "./transaction-splits";

/**
 * Current-month forecast (master-plan Phase 6) — every number traceable:
 * the components array IS the math, and it sums exactly to the totals.
 *
 * FIXED: each live (detected|confirmed) series projects every remaining
 * occurrence in the month. Transfer-kind series are excluded — the analytics
 * semantics are authoritative (transfers are never income or spending), and
 * counting both legs would double-book cash that never leaves the household.
 * A series whose evidence has gone stale still projects and carries its
 * `staleness` for the UI to show: dropping it would quietly delete real
 * income (the owner's weekly cash job lags on deposits), and including it
 * unmarked would quietly assert a dead subscription is alive.
 *
 * VARIABLE: per top-level expense bucket, trailing average of the last 3
 * FULL months of active expense spending excluding recurring-tagged rows,
 * plus a simple trend adjustment ((newest − oldest)/2, clamped at zero),
 * scaled by remaining days / days in month. Uncategorized negative amounts
 * form an explicit "Uncategorized" bucket — never hidden.
 */

const TRAILING_FULL_MONTHS = 3;

/** One category allocation of a trailing transaction (a split part, or a whole row). */
interface TrailingAllocation {
  postedOn: string;
  amountCents: number;
  categoryId: string | null;
}

/**
 * Non-recurring active transactions over [from,to], exploded into per-category
 * allocations so the trailing spend/income forecasts count each split part in
 * its own category (recurring-tagged rows are excluded — they forecast via
 * FIXED). Shared by variableComponents and variableIncomeComponents.
 */
function nonRecurringAllocations(db: AppDatabase, from: string, to: string): TrailingAllocation[] {
  const rows = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.recurringSeriesId),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();
  const splits = activeSplitsInRange(db, from, to);
  const out: TrailingAllocation[] = [];
  for (const r of rows) {
    for (const a of allocationsFor(r.categoryId, r.amountCents, splits.get(r.id) ?? [])) {
      out.push({ postedOn: r.postedOn, amountCents: a.amountCents, categoryId: a.categoryId });
    }
  }
  return out;
}

export interface ForecastComponent {
  label: string;
  kind: "fixed" | "variable";
  /** net-worth-signed: income positive, spending negative */
  cents: number;
  detail: string;
  /**
   * Fixed components only: how old the series' evidence is. Present on every
   * fixed component (fresh ones included, with isStale false) so the UI never
   * has to guess whether "no staleness" means "fresh" or "not measured".
   * Variable components have no series behind them and carry none.
   */
  staleness?: SeriesStaleness;
}

/**
 * Which month a projection is ABOUT, and how to read it.
 *
 * - `current` — the running month: what has already happened plus what remains.
 * - `future`  — a whole month still ahead, projected end to end.
 *
 * A PAST month has no third value on purpose: `forecastForMonth` returns null
 * for one. A month that has finished is not a forecast, and dressing what
 * actually posted up as a projection would be the app claiming to predict
 * something it can simply read.
 */
export type ForecastBasis = "current" | "future";

export interface MonthForecast {
  today: string;
  /** the month this projects, `YYYY-MM` */
  monthKey: string;
  basis: ForecastBasis;
  monthStart: string;
  monthEnd: string;
  daysInMonth: number;
  /** today through month end, inclusive */
  remainingDays: number;
  projectedIncomeCents: number;
  projectedSpendCents: number;
  projectedNetCents: number;
  projectedEomCashCents: number;
  projectedEomNetWorthCents: number;
  components: ForecastComponent[];
}

interface MonthWindow {
  start: string;
  end: string;
  key: string;
}

/** The last N full calendar months before the month containing `today`. */
export function trailingFullMonths(today: string, count: number): MonthWindow[] {
  const windows: MonthWindow[] = [];
  let cursorStart = periodBounds(today, "monthly").start;
  for (let i = 0; i < count; i++) {
    const prevEnd = addDays(cursorStart, -1);
    const bounds = periodBounds(prevEnd, "monthly");
    windows.unshift({ start: bounds.start, end: bounds.end, key: monthKey(prevEnd) });
    cursorStart = bounds.start;
  }
  return windows; // oldest → newest
}

const CADENCE_LABEL: Record<string, string> = {
  weekly: "weekly",
  biweekly: "biweekly",
  semimonthly: "semimonthly",
  monthly: "monthly",
  quarterly: "quarterly",
  annual: "annual",
};

/**
 * ⚠️ `today` and `from` are different things and both are needed.
 *
 * `from` bounds the OCCURRENCE window — for the running month that is today,
 * and for a future month it is that month's first day. `today` is what
 * staleness is measured against, and staleness is a fact about now: a series
 * last seen 87 days ago is 87 days stale whether you are looking at September
 * or at next June. Passing the window start to `seriesStaleness` would make
 * every commitment look fresher the further ahead you paged.
 */
function fixedComponents(
  db: AppDatabase,
  today: string,
  from: string,
  monthEnd: string,
): ForecastComponent[] {
  // status only — staleness is disclosed per component, never used to exclude
  const live = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all();

  const components: { component: ForecastComponent; firstDate: string }[] = [];
  for (const series of live) {
    if (series.kind === "transfer") continue;
    /*
     * ⛔ A series that STOPPED CHARGING is not a forecast, and this was the one
     * surface that had not been told.
     *
     * `budgets.ts` and `recurring-calendar.ts` both skip lapsed series already;
     * the forecast did not, so the three disagreed about which commitments are
     * alive. On the owner's own ledger that put **$1,779.49 a month** of a
     * previous landlord (`DIRECT PAYMENT HOFFMAN LL`, last charged 2026-01-08)
     * into every future month alongside his current rent, plus three 2024-era
     * subscriptions that have not charged in over two years.
     *
     * ⚠️ NOT the staleness bar, and the difference is the whole point.
     * `LAPSED_MISS_LIMIT` is 3 cycles where staleness is 1.5, and it exists
     * because those two decisions cost opposite things: dropping a bill whose
     * statement is a fortnight late is how rent once vanished from the runway
     * for being ONE DAY over. Three missed cycles is not a late statement.
     *
     * Staleness itself is still only DISCLOSED, never used to exclude — the
     * "N series are running late — still projected" note is the same as ever.
     *
     * ⛔ **MONEY-OUT ONLY**, which `LAPSED_MISS_LIMIT`'s own docstring says and
     * I did not read carefully enough the first time. Applying it to everything
     * dropped `Cash job (weekly pay)` — the owner's ONLY income series, whose
     * deposits have not been imported since July — and the September projection
     * fell from $4,233.69 of income to **$45.69**. That is not a forecast, it is
     * a false alarm.
     *
     * The asymmetry is real and it is the whole reason for the rule. A dead
     * outflow that keeps projecting overstates what you owe, which is
     * conservative. A live inflow dropped for want of an IMPORT understates what
     * you earn, and there is a whole disclosure elsewhere in this app
     * (cash-earnings) built on the fact that his pay arrives as cash and reaches
     * the ledger late or not at all. An income series going quiet is evidence
     * about the IMPORTS, not about the job.
     *
     * ⛔ Money-out is `lapsedSeriesShouldStopForecasting(kind)`, NOT the sign of
     * the amount, and this line used to test the sign. Four other callers —
     * `subscriptions-card`, `recurring-insights`, `recurring-calendar` and
     * `upcomingOccurrences` — already ask that function; this was a fifth
     * phrasing of a rule that has one home, which is the exact shape of the
     * defect that left a previous landlord in the forecast for seven months
     * while two of three callers already knew better.
     *
     * The two phrasings agree on every series in the ledger today — measured
     * 2026-08-31, all eighteen live ones have a sign matching their kind — so
     * this changes no published figure. They come apart where it costs most: an
     * `income` series whose stored amount is negative is DELETED by the sign
     * test and kept by the kind test, and that is the $4,233.69 → $45.69
     * collapse arriving by a different door.
     */
    if (lapsedSeriesShouldStopForecasting(series.kind) && seriesHasLapsed(series, today)) continue;
    // forecast reads user overrides first (§4.4): amount, cadence, next-expected
    const staleness = seriesStaleness(series, today);
    const occurrences: SeriesOccurrence[] = projectOccurrences(
      toProjectable(series, staleness),
      from,
      monthEnd,
    );
    if (occurrences.length === 0) continue;
    const perOccurrence = occurrences[0]!.amountCents;
    const cents = occurrences.length * perOccurrence;
    components.push({
      firstDate: occurrences[0]!.date,
      component: {
        label: series.name,
        kind: "fixed",
        cents,
        detail: `${occurrences.length} × ${formatCents(perOccurrence)} (${CADENCE_LABEL[series.cadence] ?? series.cadence}), next ${occurrences[0]!.date}`,
        staleness,
      },
    });
  }
  return components
    .sort((a, b) => compareDates(a.firstDate, b.firstDate) || a.component.label.localeCompare(b.component.label))
    .map((c) => c.component);
}

const UNCATEGORIZED_LABEL = "Uncategorized";

function variableComponents(
  db: AppDatabase,
  today: string,
  remainingDays: number,
  daysInMonth: number,
): ForecastComponent[] {
  const windows = trailingFullMonths(today, TRAILING_FULL_MONTHS);
  const rangeStart = windows[0]!.start;
  const rangeEnd = windows.at(-1)!.end;

  const categoryRows = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, kind: categories.kind })
    .from(categories)
    .all();
  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
  const rootOf = (categoryId: string) => {
    const cat = categoryById.get(categoryId);
    if (!cat) return null;
    return cat.parentId ? (categoryById.get(cat.parentId) ?? null) : cat;
  };

  // trailing spend EXCLUDES recurring-tagged rows — those live in FIXED
  const rows = nonRecurringAllocations(db, rangeStart, rangeEnd);

  // bucket → monthKey → net-worth-signed sum
  const buckets = new Map<string, Map<string, number>>();
  const add = (label: string, month: string, cents: number) => {
    const perMonth = buckets.get(label) ?? new Map<string, number>();
    perMonth.set(month, (perMonth.get(month) ?? 0) + cents);
    buckets.set(label, perMonth);
  };

  for (const t of rows) {
    if (t.categoryId === null) {
      // uncategorized negatives are an explicit spending bucket, never hidden
      if (t.amountCents < 0) add(UNCATEGORIZED_LABEL, monthKey(t.postedOn), t.amountCents);
      continue;
    }
    const root = rootOf(t.categoryId);
    if (!root || root.kind !== "expense") continue;
    add(root.name, monthKey(t.postedOn), t.amountCents);
  }

  const components: ForecastComponent[] = [];
  for (const [label, perMonth] of buckets) {
    // spend magnitudes per trailing month (outflow negative → positive spend)
    const spend = windows.map((w) => -(perMonth.get(w.key) ?? 0));
    const oldest = spend[0]!;
    const newest = spend.at(-1)!;
    const avg = spend.reduce((a, b) => a + b, 0) / spend.length;
    const trend = (newest - oldest) / 2;
    const monthlyEstimate = Math.max(0, avg + trend); // never project negative spend
    const projected = Math.round((monthlyEstimate * remainingDays) / daysInMonth);
    if (projected <= 0) continue;
    components.push({
      label,
      kind: "variable",
      cents: -projected,
      detail: `3-mo avg ${formatCents(Math.round(avg))} + trend ${formatCents(Math.round(trend))}, × ${remainingDays}/${daysInMonth} days`,
    });
  }

  return components.sort(
    (a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.label.localeCompare(b.label),
  );
}

/**
 * VARIABLE INCOME — the fix for a near-zero "projected income" when income is
 * real but IRREGULAR (a cash job, tutoring) rather than a detected series. Per
 * income subcategory, the trailing average of the last 3 FULL months of ONGOING
 * income, scaled by remaining days. Mirrors variableComponents (spending) but
 * with income honesty (see lib/income-forecast.ts): a bucket must appear in ≥2
 * trailing months (one-off refunds/aid never extrapolate) and there is NO upward
 * trend nudge. Series-tagged rows are excluded — they project via FIXED. Income
 * is a positive inflow, so only positive-amount income-kind rows contribute.
 */
/**
 * Income subcategories that are event-driven windfalls / misc one-offs, NOT
 * ongoing earnings — never projected forward, even when they happen to cluster
 * across months (a tax refund + a security-deposit return + a merchant refund
 * can all land in the same 2-3 months without any of them recurring; the same
 * goes for "Other Income", the misc catch-all where gifts/settlements/stray
 * inflows land). The presence gate alone can't catch that, so these are
 * excluded by name — only the deliberate earning buckets (Salary, Tutoring,
 * Interest, Dividends) project.
 */
const EVENT_DRIVEN_INCOME = new Set([
  "Financial Aid",
  "Refunds & Reimbursements",
  "Other Income",
]);

function variableIncomeComponents(
  db: AppDatabase,
  today: string,
  remainingDays: number,
  daysInMonth: number,
): ForecastComponent[] {
  const windows = trailingFullMonths(today, TRAILING_FULL_MONTHS);
  const rangeStart = windows[0]!.start;
  const rangeEnd = windows.at(-1)!.end;

  const categoryRows = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, kind: categories.kind })
    .from(categories)
    .all();
  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
  // the income subcategory a row belongs to, or null when it isn't ongoing income-kind
  const incomeBucket = (categoryId: string): string | null => {
    const cat = categoryById.get(categoryId);
    if (!cat) return null;
    const root = cat.parentId ? (categoryById.get(cat.parentId) ?? null) : cat;
    if (!root || root.kind !== "income") return null;
    if (EVENT_DRIVEN_INCOME.has(cat.name)) return null;
    return cat.name;
  };

  // trailing income EXCLUDES recurring-tagged rows — those live in FIXED
  const rows = nonRecurringAllocations(db, rangeStart, rangeEnd);

  const buckets = new Map<string, Map<string, number>>();
  for (const t of rows) {
    if (t.categoryId === null || t.amountCents <= 0) continue; // income is a positive inflow
    const label = incomeBucket(t.categoryId);
    if (label === null) continue;
    const perMonth = buckets.get(label) ?? new Map<string, number>();
    const mk = monthKey(t.postedOn);
    perMonth.set(mk, (perMonth.get(mk) ?? 0) + t.amountCents);
    buckets.set(label, perMonth);
  }

  const trailing = [...buckets].map(([label, perMonth]) => ({
    label,
    monthlyTotalsCents: windows.map((w) => perMonth.get(w.key) ?? 0),
  }));

  return projectOngoingIncome(trailing)
    .map((e) => ({
      label: e.label,
      kind: "variable" as const,
      cents: Math.round((e.monthlyCents * remainingDays) / daysInMonth),
      detail: `${e.basis}, × ${remainingDays}/${daysInMonth} days`,
    }))
    .filter((c) => c.cents > 0);
}

/**
 * How far ahead the calendar may be paged and still get a projection.
 *
 * ⛔ A bound, not a preference. `projectedEomCashCents` for a future month is
 * CHAINED — it sums every intervening month's net — so an unbounded horizon is
 * an unbounded loop over the whole forecast machinery, one page-turn at a time.
 * Two years is well past the last payment of the longest commitment in the
 * ledger (a 24-payment lease), which is the point at which the projection stops
 * describing anything the app actually knows.
 */
export const FORECAST_HORIZON_MONTHS = 24;

/** `YYYY-MM` for the month `n` months after `key`. */
function addMonthKey(key: string, n: number): string {
  return monthKey(addCalendarMonths(`${key}-01`, n));
}

/** Whole months from `from` to `to` inclusive; negative when `to` is earlier. */
function monthsBetweenKeys(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * A whole month still ahead, projected end to end.
 *
 * ⛔ The difference from the running month is the WINDOW, not the arithmetic.
 * Here the whole month is remaining, so the variable pace is a full month's
 * worth rather than a prorated tail, and the fixed occurrences are the ones due
 * between the 1st and the last — not the ones left after today.
 */
function futureMonthParts(
  db: AppDatabase,
  today: string,
  key: string,
): { components: ForecastComponent[]; monthStart: string; monthEnd: string; daysInMonth: number; net: number } {
  const monthStart = `${key}-01`;
  const monthEnd = periodBounds(monthStart, "monthly").end;
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  const components = [
    ...fixedComponents(db, today, monthStart, monthEnd),
    // the whole month remains, so the trailing pace applies in full
    ...variableIncomeComponents(db, today, daysInMonth, daysInMonth),
    ...variableComponents(db, today, daysInMonth, daysInMonth),
  ];
  const income = components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const spend = components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);
  return { components, monthStart, monthEnd, daysInMonth, net: income + spend };
}

/**
 * The projection for ANY month the calendar can be paged to.
 *
 * Returns null for a month that has already ended: a finished month is not a
 * forecast, and the calendar beneath it already shows what actually posted.
 *
 * ⛔ **The end-of-month cash figure is CHAINED, and it has to be.** "What will
 * I have at the end of October" cannot be answered from October alone — it
 * depends on September. So a future month's `projectedEomCashCents` is today's
 * cash plus every intervening month's projected net, this one included. Showing
 * October's net against today's balance would be a number that is wrong by a
 * whole month and looks entirely reasonable.
 */
export function forecastForMonth(
  db: AppDatabase,
  key: string,
  today: string = todayIso(),
): MonthForecast | null {
  const current = monthKey(today);
  const ahead = monthsBetweenKeys(current, key);
  if (ahead < 0) return null;
  if (ahead > FORECAST_HORIZON_MONTHS) return null;
  if (ahead === 0) return forecastCurrentMonth(db, today);

  const parts = futureMonthParts(db, today, key);

  /*
   * The running month's own remainder starts the chain — the months between
   * are whole ones. `forecastCurrentMonth` is called once here rather than per
   * step; the loop below only needs each future month's NET.
   */
  let chainedNet = forecastCurrentMonth(db, today).projectedNetCents;
  for (let i = 1; i < ahead; i++) {
    chainedNet += futureMonthParts(db, today, addMonthKey(current, i)).net;
  }
  chainedNet += parts.net;

  const cashTypes = new Set(["checking", "savings"]);
  const activeAccounts = db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.isActive, true))
    .all();
  const balances = latestBalances(db);
  let cashCents = 0;
  for (const a of activeAccounts) {
    if (!cashTypes.has(a.type)) continue;
    cashCents += balances.get(a.id)?.balanceCents ?? 0;
  }

  const income = parts.components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const spend = parts.components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);

  return {
    today,
    monthKey: key,
    basis: "future",
    monthStart: parts.monthStart,
    monthEnd: parts.monthEnd,
    daysInMonth: parts.daysInMonth,
    // the whole month is ahead of today
    remainingDays: parts.daysInMonth,
    projectedIncomeCents: income,
    projectedSpendCents: spend,
    projectedNetCents: parts.net,
    projectedEomCashCents: cashCents + chainedNet,
    projectedEomNetWorthCents: latestBridgedNetWorthCents(db, balances) + chainedNet,
    components: parts.components,
  };
}

export function forecastCurrentMonth(db: AppDatabase, today: string = todayIso()): MonthForecast {
  const { start: monthStart, end: monthEnd } = periodBounds(today, "monthly");
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  const remainingDays = diffDays(today, monthEnd) + 1;

  const components = [
    ...fixedComponents(db, today, today, monthEnd),
    ...variableIncomeComponents(db, today, remainingDays, daysInMonth),
    ...variableComponents(db, today, remainingDays, daysInMonth),
  ];

  // the components ARE the math: totals derive from them, exactly
  const projectedIncomeCents = components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const projectedSpendCents = components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);
  const projectedNetCents = projectedIncomeCents + projectedSpendCents;

  const cashTypes = new Set(["checking", "savings"]);
  const activeAccounts = db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.isActive, true))
    .all();
  const balances = latestBalances(db);
  let cashCents = 0;
  for (const a of activeAccounts) {
    if (!cashTypes.has(a.type)) continue;
    cashCents += balances.get(a.id)?.balanceCents ?? 0;
  }

  // bridged, so the EOM projection starts from the same number the dashboard
  // headline shows (docs/inflight-dips.md — one source for "latest net worth").
  // Only the final point is wanted, so this reuses the `balances` map above
  // rather than rebuilding the whole 1,438-day curve to read its last element.
  const latestNetWorth = latestBridgedNetWorthCents(db, balances);

  return {
    today,
    monthKey: monthKey(today),
    basis: "current",
    monthStart,
    monthEnd,
    daysInMonth,
    remainingDays,
    projectedIncomeCents,
    projectedSpendCents,
    projectedNetCents,
    projectedEomCashCents: cashCents + projectedNetCents,
    projectedEomNetWorthCents: latestNetWorth + projectedNetCents,
    components,
  };
}
