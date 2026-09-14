import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addCalendarMonths, addDays, compareDates, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { forecastSplit } from "@/lib/forecast-split";
import { projectOngoingIncome } from "@/lib/income-forecast";
import { trailingPace } from "@/lib/projection";
import { formatDayShortIn } from "@/lib/format-date";
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
import { overdueForSeries, unbankedIncomeForSeries } from "./arrears";
import { activeSplitsInRange } from "./transaction-splits";
import { linkIsNotRecurring, seriesIdsNotDrawnAsRecurring } from "./recurring-link";

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
 * FULL months of active expense spending excluding the rows a recurring series
 * owns (`linkIsNotRecurring` — a DISMISSED series owns none), plus a trend
 * adjustment capped at one typical (median) month and floored at
 * zero, scaled by remaining days / days in month. The pace itself is
 * `projection.ts::trailingPace` — shared with /spending and /budgets, so one
 * category cannot be projected two ways. Uncategorized negative amounts form an
 * explicit "Uncategorized" bucket — never hidden.
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
 * its own category. Shared by variableComponents and variableIncomeComponents.
 *
 * A row a live series owns is excluded — it forecasts via FIXED — and so is one
 * an ENDED series owns: that bill stopped, and its history is not a pace.
 *
 * 🔴 NOT "every row with a link". A row linked to a DISMISSED series was
 * excluded too, by `isNull(recurringSeriesId)`, while the fixed leg projects
 * only live series — so it was counted in NEITHER. The owner dismissed those
 * series because they are not recurring ("i just go eat there often"); on the
 * real ledger 2026-09-14 that was 17 rows, $242.72 of June–August spend
 * (YA-FIT, PURA VIDA, a non-Chase ATM) left out of the trailing BASE that
 * September's pace is built from. The projection itself moved far less —
 * projected spending −$6,641.66 → −$6,666.33, i.e. $24.67 — because the base is
 * a three-month average plus a trend, prorated to the 17 days left; and Weed's
 * line FELL (−$8.49 → −$3.06), since its $57.50 posted in June, the oldest
 * trailing month, and steepens the downward trend.
 * `linkIsNotRecurring` asks `seriesDrawsAsRecurring`, not the link.
 *
 * `notDrawn` is read once per forecast by the exported entry points: it cannot
 * change inside one call, and a page 24 months ahead reaches this function 50
 * times (measured 2026-09-14: 245 statements, where 195 ran before the read).
 */
function nonRecurringAllocations(
  db: AppDatabase,
  from: string,
  to: string,
  notDrawn: ReadonlySet<string>,
): TrailingAllocation[] {
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
        linkIsNotRecurring(notDrawn),
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

/** One internally consistent reading of a month: net === income + spend. */
export interface ForecastTotals {
  incomeCents: number;
  spendCents: number;
  netCents: number;
  eomCashCents: number;
  eomNetWorthCents: number;
}

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
  /**
   * The SCHEDULE alone: money the owner has agreed to pay and pay the deposits
   * he is due, with no trailing pace in it at all.
   *
   * ⛔ This is the headline the card shows, at the owner's instruction and over
   * my stated objection — recorded here because a future reader will otherwise
   * "fix" it back. His words: *"projected income is 1047*4 a month. projected
   * spend is the actual monthlies i have you so around 3.5k"*. For September
   * 2026 that is **+$4,188.00** and **−$3,567.60**, netting **+$620.40**.
   *
   * ⭐ It is also the figure the calendar strip DIRECTLY BELOW the card has been
   * printing all along — "as scheduled +$620.40" — so before this change the two
   * halves of one screen disagreed about the same month by $7,417.48, and the
   * one the eye lands on first was the one with the pace baked in.
   *
   * ⚠️ What it is NOT: a prediction of his balance. Groceries, petrol and
   * restaurants are real money leaving a real account, and they are not in this
   * number. `projected*Cents` above still carries them, the card still shows
   * them on their own row, and `eomCashCents` here is what the month ends at IF
   * nothing discretionary happens — which is never. Read the two together or
   * neither.
   */
  committed: ForecastTotals;
  components: ForecastComponent[];
  /**
   * Paydays that already passed this month with nothing banked against them —
   * REPORTED, never projected.
   *
   * 🔴 The reason the card needs it. Spending's arrears ARE a component
   * (`arrearsComponents`) and income's deliberately are not, for the reason
   * `fixedComponents` argues at length: cash pay that never reaches a bank
   * cannot be counted as arriving. So the schedule the strip below the card
   * draws and the schedule the card sums are two different sets of days.
   *
   * Measured 2026-09-04, the day after a Thursday payday: the card read
   * "PROJECTED NET -$426.60" over a month strip on the same screen reading
   * "as scheduled +$620.40" — $1,047.00 apart, and the class comment on
   * `committed` says in so many words that the whole point of that headline was
   * to stop those two halves disagreeing.
   */
  unbankedIncome: { totalCents: number; occurrenceCount: number; names: string[] };
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
        /* ⛔ a raw ISO date mid-sentence. The tooltip on this same row says
           "since Jul 5, 2026" and the list below it "Sep 11"; this cell said
           "2026-09-11". 10 of 24 rows carried one. */
        detail: `${occurrences.length} × ${formatCents(perOccurrence)} (${CADENCE_LABEL[series.cadence] ?? series.cadence}), next ${formatDayShortIn(occurrences[0]!.date, today)}`,
        staleness,
      },
    });
  }
  return components
    .sort((a, b) => compareDates(a.firstDate, b.firstDate) || a.component.label.localeCompare(b.component.label))
    .map((c) => c.component);
}

/**
 * ARREARS — what came due EARLIER THIS MONTH and that no posting covers.
 *
 * 🔴 Found by reading the running app on 2026-09-02, and it was a hole rather
 * than a decision: this module contained no notion of arrears at all. The fixed
 * leg of the running month opens on `today`, and the variable leg excludes
 * every row a recurring series owns (`linkIsNotRecurring`, so the pace cannot
 * double-count a bill). A bill that came due on the 1st and never posted was
 * therefore in NEITHER, and it left the projection entirely — measured on the
 * real ledger, September's projected spending was missing $2,291.21 of rent and
 * rent utilities, and EOM cash was overstated by exactly that. The same app
 * published the same $2,291.21 twice on other screens: `/budgets` as "due by
 * today and no import has covered them yet", and the runway card as "came due
 * earlier this month and never posted".
 *
 * It is wrong in both worlds, which is why it is not a judgement call. If the
 * bill has not been paid, it will be, and the month owes it. If it HAS been
 * paid but the statement has not been imported, then the cash balance this
 * projection starts from predates the payment — so the money still has to come
 * out of EOM cash.
 *
 * ⛔ THE TWO LEGS ABUT, NEVER OVERLAP. Forward is `[today, monthEnd]`; arrears
 * closes the day BEFORE today. A bill due today and unposted is not late — it
 * is DUE, and the forward leg already owns it. This is the same edge
 * `committedBook` pins, stated the same way, so the two cannot disagree about
 * the one day a month where they meet.
 *
 * ⛔ MONEY-OUT ONLY. `overdueForSeries` keeps only negative occurrences, which
 * is the same asymmetry `fixedComponents` argues at length: a payday that came
 * and went without a deposit is evidence about the IMPORTS, and projecting it
 * as still-to-come would inflate EOM cash on a ledger whose owner is paid in
 * cash.
 */
function arrearsComponents(db: AppDatabase, today: string, monthStart: string): ForecastComponent[] {
  // every live series the forecast would project; `overdueForSeries` applies the
  // money-out and lapsed rules itself, and transfers are never spending here
  const live = db
    .select()
    .from(recurringSeries)
    .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
    .all()
    .filter((s) => s.kind !== "transfer");
  const byId = new Map(live.map((s) => [s.id, s]));
  const late = overdueForSeries(db, new Set(byId.keys()), monthStart, addDays(today, -1));

  return late.series.map((s) => {
    const series = byId.get(s.id)!;
    /*
     * Exact, not an estimate: `projectOccurrences` gives every occurrence of one
     * series the same amount, so a window's total divides by its count with no
     * remainder. Stated because a division inside a money figure is exactly the
     * kind of line that earns a second look.
     */
    const perOccurrenceCents = -s.amountCents / s.occurrenceCount;
    return {
      label: s.name,
      kind: "fixed" as const,
      cents: -s.amountCents,
      detail: `${s.occurrenceCount} × ${formatCents(perOccurrenceCents)} (${CADENCE_LABEL[series.cadence] ?? series.cadence}), came due ${formatDayShortIn(s.nextDate, today)} and has not posted`,
      staleness: seriesStaleness(series, today),
    };
  });
}

const UNCATEGORIZED_LABEL = "Uncategorized";

function variableComponents(
  db: AppDatabase,
  today: string,
  remainingDays: number,
  daysInMonth: number,
  notDrawn: ReadonlySet<string>,
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

  // trailing spend EXCLUDES the rows a series drawn as recurring owns
  // (`linkIsNotRecurring`): a live series' bills project via FIXED, an ended
  // series' stopped, and a dismissed series owns none — its rows are pace here
  const rows = nonRecurringAllocations(db, rangeStart, rangeEnd, notDrawn);

  // bucket → monthKey → net-worth-signed sum
  const buckets = new Map<string, Map<string, number>>();
  const add = (label: string, month: string, cents: number) => {
    const perMonth = buckets.get(label) ?? new Map<string, number>();
    perMonth.set(month, (perMonth.get(month) ?? 0) + cents);
    buckets.set(label, perMonth);
  };

  for (const t of rows) {
    if (t.categoryId === null || categoryById.get(t.categoryId)?.kind === "system") {
      // uncategorized negatives are an explicit spending bucket, never hidden —
      // and a row filed on the system "Uncategorized" category is uncategorized
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
    /*
     * ⛔ ONE definition of the pace, and it does not live here.
     *
     * This loop used to compute `(newest − oldest) / 2` itself, while
     * `projection.ts` — whose own header names "Engine B forecast.ts
     * variableComponents" as the formula it was written to absorb — computed
     * the same nudge for `/spending` and `/budgets`. Two implementations of one
     * rule, so the recurring card and the spending page could disagree about
     * the very same category. `trailingPace` is now the only place that
     * decides, and the cap it applies is measured rather than chosen: see its
     * docstring for the 36-month backtest.
     */
    const pace = trailingPace(spend);
    const projected = Math.round((pace.expectedExactCents * remainingDays) / daysInMonth);
    if (projected <= 0) continue;
    /*
     * The detail names the RAW slope as well as the applied one whenever they
     * differ. "+ trend $590.24" alone would be a number the reader cannot
     * reproduce from the three months in front of them, which is the opposite
     * of what the visible-math table is for.
     *
     * 🔴 …AND THE CAP HAS TO SAY WHAT IT IS WORTH. "capped at one typical
     * month" over "trend $0.00" is every clause true and the whole
     * unresolvable: the only monthly figure on the row is the 3-month AVERAGE,
     * the cap is the MEDIAN, and wherever those differ the reader's arithmetic
     * does not close. Measured on the owner's ledger 2026-09-10 — the note
     * renders twice on /recurring and BOTH are the zero-median case:
     *
     *     Car            3-mo avg $2,033.33 + trend $0.00
     *                      (slope $3,050.00, capped at one typical month)
     *     Uncategorized  3-mo avg $397.40 + trend $0.00
     *                      (slope $596.11, capped at one typical month)
     *
     * `Car`'s three trailing months are [$0.00, $0.00, $6,100.00], so one
     * typical month really is nothing — but a reader capping $3,050.00 at the
     * $2,033.33 in front of them gets $2,033.33, and the row says $0.00.
     *
     * ⛔ A capped trend IS the cap, so naming it costs no second figure: the
     * leading number is the one the clause is about, and the sentence now says
     * so instead of leaving the reader to guess which figure it meant.
     */
    const trendNote = pace.trendWasCapped
      ? `${formatCents(Math.round(pace.trendCents))} (one typical month, which the ${formatCents(Math.round(pace.rawTrendCents))} slope was capped to)`
      : formatCents(Math.round(pace.trendCents));
    components.push({
      label,
      kind: "variable",
      cents: -projected,
      detail: `3-mo avg ${formatCents(Math.round(pace.averageCents))} + trend ${trendNote}, × ${remainingDays}/${daysInMonth} days`,
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
 * trend nudge. Rows a series drawn as recurring owns are excluded
 * (`linkIsNotRecurring`) — a live series' deposits project via FIXED, an ended
 * one's stopped — while a DISMISSED series' deposits count here like any other.
 * Income is a positive inflow, so only positive-amount income-kind rows contribute.
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
  notDrawn: ReadonlySet<string>,
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

  // trailing income EXCLUDES the rows a series drawn as recurring owns
  // (`linkIsNotRecurring`): live deposits project via FIXED, an ended series'
  // stopped, and a dismissed series owns none — its deposits are pace here
  const rows = nonRecurringAllocations(db, rangeStart, rangeEnd, notDrawn);

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
  notDrawn: ReadonlySet<string>,
): {
  components: ForecastComponent[];
  monthStart: string;
  monthEnd: string;
  daysInMonth: number;
  net: number;
  committedNet: number;
} {
  const monthStart = `${key}-01`;
  const monthEnd = periodBounds(monthStart, "monthly").end;
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  const components = [
    ...fixedComponents(db, today, monthStart, monthEnd),
    // the whole month remains, so the trailing pace applies in full
    ...variableIncomeComponents(db, today, daysInMonth, daysInMonth, notDrawn),
    ...variableComponents(db, today, daysInMonth, daysInMonth, notDrawn),
  ];
  const income = components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const spend = components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);
  const split = forecastSplit(components);
  return {
    components,
    monthStart,
    monthEnd,
    daysInMonth,
    net: income + spend,
    committedNet: split.income.fixedCents + split.spending.fixedCents,
  };
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
  // ONE read for the whole chain: the set cannot change inside this call, and
  // every month below reaches the trailing pace twice (spend and income)
  const notDrawn = seriesIdsNotDrawnAsRecurring(db);
  if (ahead === 0) return currentMonthForecast(db, today, notDrawn);

  const parts = futureMonthParts(db, today, key, notDrawn);

  /*
   * The running month's own remainder starts the chain — the months between
   * are whole ones. The running month is forecast once here rather than per
   * step; the loop below only needs each future month's NET.
   */
  const running = currentMonthForecast(db, today, notDrawn);
  let chainedNet = running.projectedNetCents;
  /*
   * ⛔ The committed reading is chained SEPARATELY, never derived from the full
   * one. "Today's cash plus every month's committed net" and "the full chain
   * minus the pace" are the same number only when the pace is zero, and the
   * whole reason this figure exists is that it is not.
   */
  let chainedCommittedNet = running.committed.netCents;
  for (let i = 1; i < ahead; i++) {
    const between = futureMonthParts(db, today, addMonthKey(current, i), notDrawn);
    chainedNet += between.net;
    chainedCommittedNet += between.committedNet;
  }
  chainedNet += parts.net;
  chainedCommittedNet += parts.committedNet;

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
  const split = forecastSplit(parts.components);
  const netWorthCents = latestBridgedNetWorthCents(db, balances);

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
    projectedEomNetWorthCents: netWorthCents + chainedNet,
    committed: {
      incomeCents: split.income.fixedCents,
      spendCents: split.spending.fixedCents,
      netCents: parts.committedNet,
      eomCashCents: cashCents + chainedCommittedNet,
      eomNetWorthCents: netWorthCents + chainedCommittedNet,
    },
    components: parts.components,
    /*
     * A FUTURE month has no past inside it — every one of its paydays is still
     * to come, so there is nothing that has passed unbanked. Stated rather than
     * omitted: this field is a measurement, and an empty one is the answer here.
     */
    unbankedIncome: { totalCents: 0, occurrenceCount: 0, names: [] },
  };
}

export function forecastCurrentMonth(db: AppDatabase, today: string = todayIso()): MonthForecast {
  return currentMonthForecast(db, today, seriesIdsNotDrawnAsRecurring(db));
}

/** The running month, with the not-recurring series already read once (see `forecastForMonth`). */
function currentMonthForecast(db: AppDatabase, today: string, notDrawn: ReadonlySet<string>): MonthForecast {
  const { start: monthStart, end: monthEnd } = periodBounds(today, "monthly");
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  const remainingDays = diffDays(today, monthEnd) + 1;

  const components = [
    // arrears first: they are dated before every forward occurrence, and the
    // math table reads in the order this array is built
    ...arrearsComponents(db, today, monthStart),
    ...fixedComponents(db, today, today, monthEnd),
    ...variableIncomeComponents(db, today, remainingDays, daysInMonth, notDrawn),
    ...variableComponents(db, today, remainingDays, daysInMonth, notDrawn),
  ];

  /*
   * ⛔ Computed, never added. It is not in `components`, so the math table's
   * claim that its rows sum exactly to the projections above stays true.
   */
  const incomeSeriesIds = new Set(
    db
      .select({ id: recurringSeries.id })
      .from(recurringSeries)
      .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
      .all()
      .map((r) => r.id),
  );
  const unbanked = unbankedIncomeForSeries(db, incomeSeriesIds, monthStart, today);

  // the components ARE the math: totals derive from them, exactly
  const projectedIncomeCents = components.reduce((sum, c) => (c.cents > 0 ? sum + c.cents : sum), 0);
  const projectedSpendCents = components.reduce((sum, c) => (c.cents < 0 ? sum + c.cents : sum), 0);
  const projectedNetCents = projectedIncomeCents + projectedSpendCents;
  // the SCHEDULE alone — same array, partitioned; see MonthForecast.committed
  const committedSplit = forecastSplit(components);
  const committedNetCents =
    committedSplit.income.fixedCents + committedSplit.spending.fixedCents;

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
    committed: {
      incomeCents: committedSplit.income.fixedCents,
      spendCents: committedSplit.spending.fixedCents,
      netCents: committedNetCents,
      eomCashCents: cashCents + committedNetCents,
      eomNetWorthCents: latestNetWorth + committedNetCents,
    },
    components,
    unbankedIncome: {
      totalCents: unbanked.totalCents,
      occurrenceCount: unbanked.series.reduce((n, x) => n + x.occurrenceCount, 0),
      names: unbanked.series.map((x) => x.name),
    },
  };
}
