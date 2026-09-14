/**
 * Projection engine — the shared, pure math behind "predictions everywhere"
 * (North Star #2, Pillar 1). Every chart and stat gets an estimate companion
 * answering "what should this be?", GENERALIZED from the three forward-looking
 * formulas that already exist in the app:
 *   - Engine A  budgets.ts `projectSpend`  (spent-to-date + recurring tail +
 *               linearly-extrapolated variable remainder) — the most general.
 *   - Engine B  forecast.ts `variableComponents` ((trailing-avg + trend) × remaining/total).
 *   - Engine C  spending.ts `computePace`  (actual ÷ elapsed-fraction) — the special case.
 * This module lifts the PURE math out so every surface can share one honest,
 * unit-tested engine. Everything here is DB-free and clock-free: callers pass
 * `today` (never `todayIso()` — that would leak the real clock into client code
 * and break the pinned-clock e2e determinism, per dates.ts's server-only rule).
 *
 * HONESTY DOCTRINE (non-negotiable — this is what separates us from a toy):
 *   1. A projection is ALWAYS distinguishable from actuals. `ProjectionPoint`
 *      carries `complete:false` on every estimated day so the chart draws it
 *      dashed (the same convention as price-series.ts's carried tail and
 *      scrub-series.ts's `soft` line).
 *   2. Every projection states its method + basis on demand — see `basis`,
 *      mirroring forecast.ts's "the components ARE the math" visible-math rule.
 *   3. NEVER predict what can't be honestly predicted. There is deliberately NO
 *      price/market-movement method here: for investments you project
 *      CONTRIBUTIONS/DCA and compare to prior periods, never a fabricated price
 *      path (consistent with the pass-13 carry-forward, which repeats the last
 *      close flat + dashed rather than inventing a trend).
 *   4. Low-confidence projections (thin data / high variance / far extrapolation)
 *      carry a lower `confidence` so the UI can render them fainter and say so —
 *      never a false-precision number.
 *
 * Money is INTEGER CENTS everywhere; every extrapolation rounds to an integer
 * before it leaves this module (formatCents asserts an integer input).
 */

import { addDays, compareDates, diffDays } from "./dates";

/** A day-keyed value point. `complete:false` = estimated/projected → drawn dashed. */
export interface ProjectionPoint {
  /** ISO 'YYYY-MM-DD' */
  day: string;
  valueCents: number;
  /** false ONLY on projected/estimated days (a solid anchor stays true) */
  complete: boolean;
}

/** The six projection methods (the registry the UI can offer as a "method" pick). */
export type ProjectionMethod =
  | "pace"
  | "trailingAverage"
  | "priorPeriod"
  | "recurringDriven"
  | "runRate"
  | "budgetTarget";

/** Human-facing metadata for each method (for a method picker / basis label). */
export const PROJECTION_METHOD_LABEL: Record<ProjectionMethod, string> = {
  pace: "At this pace",
  trailingAverage: "Typical (recent average)",
  priorPeriod: "Same period previously",
  recurringDriven: "Expected recurring",
  runRate: "Run rate (linear)",
  budgetTarget: "Budget target",
};

/** The uniform scalar result every method returns. Series live in the builders below. */
export interface Projection {
  method: ProjectionMethod;
  /** projected end-of-window total, integer cents (caller's sign convention) */
  expectedTotalCents: number;
  /** a target/budget reference line, integer cents; null when the method has none */
  targetCents: number | null;
  /** visible-math explanation of how this number was produced (honesty doctrine #2) */
  basis: string;
  /** 0..1 — low ⇒ render fainter + say so (honesty doctrine #4) */
  confidence: number;
}

/** How far through a window `today` sits — the shared "today tick" math. */
export interface PeriodProgress {
  /** inclusive day count of [from, to], always ≥ 1 */
  totalDays: number;
  /** inclusive days [from, min(today, to)]; 0 when the window is entirely in the future */
  elapsedDays: number;
  /** totalDays − elapsedDays, ≥ 0 */
  remainingDays: number;
  /** elapsedDays / totalDays, 0..1 */
  elapsedFraction: number;
  /** today ∈ [from, to] */
  isCurrent: boolean;
  /** today > to (the window is fully in the past → the "projection" is the actual) */
  isPast: boolean;
  /** today < from (the window has not begun) */
  isFuture: boolean;
}

// ── small pure helpers ─────────────────────────────────────────────────────
// (No branchy helpers: confidence is clamped with Math.min/Math.max so every
//  line stays reachable through the public API — the src/lib 100% gate.)

/** clamp to [0,1] and round to 2 decimals — stable, comparable confidence */
function confidenceOf(x: number): number {
  return Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── the shared window/progress math ─────────────────────────────────────────

/**
 * Elapsed / total / remaining day counts for an inclusive [from, to] window as
 * of `today`. Mirrors the identical convention used across budgets/forecast/
 * spending: totalDays = diffDays(from,to)+1, elapsedDays = diffDays(from,ref)+1
 * (both inclusive), clamped so a `today` outside the window is handled honestly.
 */
export function periodProgress(from: string, to: string, today: string): PeriodProgress {
  const totalDays = Math.max(1, diffDays(from, to) + 1);
  const isFuture = compareDates(today, from) < 0;
  const isPast = compareDates(today, to) > 0;
  const isCurrent = !isFuture && !isPast;
  const cappedToday = isPast ? to : today;
  const elapsedDays = isFuture ? 0 : Math.min(totalDays, diffDays(from, cappedToday) + 1);
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const elapsedFraction = elapsedDays / totalDays;
  return { totalDays, elapsedDays, remainingDays, elapsedFraction, isCurrent, isPast, isFuture };
}

// ── method: pace (Engine A/C unified) ───────────────────────────────────────

export interface PaceInput {
  from: string;
  to: string;
  today: string;
  /** actual to-date total over [from, min(today,to)], integer cents (magnitude) */
  actualToDateCents: number;
  /**
   * portion of actual-to-date that is RECURRING money, excluded from variable
   * extrapolation — rows a series drawn as recurring owns (services/recurring-link
   * `linkIsRecurring`), not every row with a link: a DISMISSED series' rows are
   * everyday spending and belong in the pace.
   */
  recurringPostedCents?: number;
  /** future recurring occurrences already expected in (today, to], integer cents */
  expectedTailCents?: number;
  /**
   * floor the projection at a committed full-period actual (a large future-dated
   * non-recurring charge is a fact, not an estimate). Defaults to actualToDateCents.
   */
  floorCents?: number;
}

/**
 * Extrapolate the CURRENT window's actuals to its end — "at this pace, $Y".
 * Generalizes budgets.ts::projectSpend: only the VARIABLE part (actual −
 * recurring-posted) is extrapolated linearly by remaining/elapsed days; the
 * recurring tail is added once from its own occurrences, so a bill is never
 * double-counted with its own future occurrence. With no recurring inputs this
 * reduces to `actual ÷ elapsedFraction` (Engine C).
 */
export function projectPace(input: PaceInput): Projection {
  const { from, to, today, actualToDateCents } = input;
  const recurringPosted = input.recurringPostedCents ?? 0;
  const expectedTail = input.expectedTailCents ?? 0;
  const prog = periodProgress(from, to, today);

  const variablePosted = actualToDateCents - recurringPosted;
  const variableRemainder =
    prog.elapsedDays > 0 && variablePosted > 0
      ? Math.round((variablePosted * prog.remainingDays) / prog.elapsedDays)
      : 0;

  const floor = input.floorCents ?? actualToDateCents;
  const expected = Math.max(floor, actualToDateCents + expectedTail + variableRemainder);

  const tailNote = expectedTail !== 0 ? `, +${expectedTail}¢ expected recurring` : "";
  return {
    method: "pace",
    expectedTotalCents: expected,
    targetCents: null,
    basis: `pace from ${prog.elapsedDays} of ${prog.totalDays} day${prog.totalDays === 1 ? "" : "s"} elapsed${tailNote}`,
    // early in a period a pace is shaky; a fully-elapsed window is essentially actual.
    confidence: prog.isFuture ? 0 : confidenceOf(0.35 + 0.65 * prog.elapsedFraction),
  };
}

// ── method: trailingAverage (Engine B) ──────────────────────────────────────

/**
 * The trailing pace of a lumpy series: its mean, and how far a trend may move
 * that mean.
 *
 * ⛔ **A trend may move the projection by at most ONE TYPICAL MONTH.** The
 * nudge used to be `(newest − oldest) / 2` with nothing bounding it, and on a
 * category that fires a few times a year that is not a trend estimator — it is
 * a two-point slope that ignores the middle period entirely and is unbounded in
 * both directions.
 *
 * Measured on the owner's `Travel` bucket, 2026-08-31: nineteen of twenty-three
 * months carry spend, the median of those is about $131, and the all-time mean
 * is $332.84 — but July 2026 holds $2,448.88, of which $2,374.89 is TWO flight
 * bookings and the rest is $2-$17 parking. The trailing three months are
 * $15.75, $590.24, $2,448.88, so the mean is $1,018.29, the raw nudge is
 * $1,216.57, and the projection came out at $2,234.86: the nudge more than
 * DOUBLED the average, off one month that was two discrete purchases.
 *
 * ## ⛔ ONLY THE UPWARD NUDGE IS CAPPED, and that asymmetry is the whole rule
 *
 * The downward direction is already bounded, by the `Math.max(0, …)` floor
 * below: a category that collapses to nothing projects nothing, which is the
 * correct answer — it stopped. Capping downward as well BREAKS that. A window
 * of [$600, $0, $0] has a median of $0, so a symmetric cap is a cap of zero, it
 * kills the −$300 slope, and the estimate comes back as the $200 mean: a
 * cancelled habit that keeps costing money on the forecast forever. That is the
 * same defect class as the dead landlord and the 449-day Uber One, arriving
 * through the arithmetic instead of through the lapse rule.
 *
 * Upward has no such floor. Nothing bounds `(newest − oldest) / 2` from above,
 * so one big month becomes a permanent monthly rate.
 *
 * ## Why the median, measured rather than chosen
 *
 * Backtested over 36 months and 19 root buckets on the real ledger, scoring the
 * absolute error of the MONTHLY TOTAL — the figure the card actually publishes:
 *
 *   | rule                        | MAE total | MAE/cat |  over | under | dead-category |
 *   |-----------------------------|----------:|--------:|------:|------:|--------------:|
 *   | ± median (symmetric)        |    $1,194 |  $2,707 |  $512 |  $682 |  ⛔ $200.00   |
 *   | **up-only median**          |    $1,239 |  $2,630 |  $427 |  $812 |  ✅ $0.00     |
 *   | ± ½·mean                    |    $1,250 |  $2,708 |  $557 |  $694 |  ⛔ $100.00   |
 *   | no trend at all             |    $1,290 |  $2,623 |  $547 |  $743 |  ⛔ $200.00   |
 *   | up-only mean                |    $1,320 |  $2,823 |  $591 |  $729 |  ✅ $0.00     |
 *   | raw trend (the old rule)    |    $1,372 |  $2,918 |  $675 |  $697 |  ✅ $0.00     |
 *
 * Against the old rule the chosen one is 10% better on the published figure,
 * 10% better per category, and over-predicts 37% less ($427 against $675). It
 * gives back $115/month of under-prediction for that, which is the honest cost
 * and worth naming. It is stable across halves of the window ($1,196 then
 * $1,282, against the old rule's $1,377 and $1,368), so it is not fitted to a
 * recent stretch.
 *
 * The symmetric variant scores 4% better still and is rejected anyway: an
 * aggregate score does not buy the right to tell someone a habit they quit is
 * still costing them $200 a month.
 *
 * ⚠️ A single month of spend in three now gets NO upward nudge, because the
 * median of [$0, $0, $50] is $0. That is deliberate and it matches what the
 * INCOME side of this app already does — `projectOngoingIncome` requires a
 * bucket in ≥2 of 3 months and applies no upward trend at all. One month is
 * thin evidence in both directions.
 *
 * ⚠️ `Math.abs` on the cap is load-bearing. A bucket whose refunds outweigh its
 * spend has a NEGATIVE median, and a negative cap turns `Math.min(lim, t)` into
 * a rule that FORCES the trend negative rather than bounding it.
 */
export interface TrailingPace {
  /** mean of the window */
  averageCents: number;
  /** `(newest − oldest) / 2`, before the cap */
  rawTrendCents: number;
  /** the nudge actually applied — a RISING `rawTrendCents` capped at `typicalCents` */
  trendCents: number;
  /** the median of the window: what one ordinary period looks like */
  typicalCents: number;
  /** `max(0, average + trend)`, rounded — never a negative typical */
  expectedCents: number;
  /**
   * The same figure UNROUNDED, for callers that scale it before presenting it.
   *
   * ⚠️ Rounding to the cent and then multiplying by `remaining/total` is not the
   * same as multiplying and then rounding, and `variableComponents` does the
   * second — it always did, and this field exists so that adopting the shared
   * rule did not quietly change a published number by a cent alongside it.
   */
  expectedExactCents: number;
  /** the cap bound: the slope was rising and bigger than one ordinary period */
  trendWasCapped: boolean;
}

/** Median of a copy — never sorts the caller's array. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function trailingPace(
  totals: readonly number[],
  applyTrend: boolean = true,
): TrailingPace {
  const n = totals.length;
  const averageCents = mean(totals);
  const typicalCents = median(totals);
  const rawTrendCents = applyTrend && n >= 2 ? (totals[n - 1]! - totals[0]!) / 2 : 0;
  // upward only — the zero floor below already bounds a falling series, and
  // capping that direction too would keep a stopped category alive
  const trendCents = Math.min(Math.abs(typicalCents), rawTrendCents);
  return {
    averageCents,
    rawTrendCents,
    trendCents,
    typicalCents,
    expectedCents: Math.max(0, Math.round(averageCents + trendCents)),
    expectedExactCents: Math.max(0, averageCents + trendCents),
    trendWasCapped: trendCents !== rawTrendCents,
  };
}

export interface TrailingAverageInput {
  /** per prior full period, oldest → newest, integer cents (magnitude) */
  trailingTotalsCents: readonly number[];
  /** apply the (newest − oldest)/2 trend nudge (forecast.ts). Default true. */
  applyTrend?: boolean;
}

/**
 * The "you typically spend $X per period" number — the mean of the last N full
 * periods, nudged by a simple linear trend, floored at zero (never a negative
 * typical). Confidence falls as the trailing totals scatter (coefficient of
 * variation), so a lumpy history reads fainter.
 */
export function projectTrailingAverage(input: TrailingAverageInput): Projection {
  const totals = input.trailingTotalsCents;
  const n = totals.length;
  const applyTrend = input.applyTrend !== false;
  // ONE definition of the pace, shared with forecast.ts's variableComponents —
  // which used to re-derive this same nudge inline, so the recurring card and
  // /spending could disagree about the very same category.
  const pace = trailingPace(totals, applyTrend);
  const avg = pace.averageCents;
  const trend = pace.trendCents;
  const expected = pace.expectedCents;

  // coefficient of variation → confidence: a lumpy history reads fainter.
  let cv = 1;
  if (n >= 1 && avg !== 0) {
    const variance = totals.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
    cv = Math.sqrt(variance) / Math.abs(avg);
  }
  // no data ⇒ no confidence; a single point is thin; ≥2 scores by scatter.
  const confidence = n === 0 ? 0 : n < 2 ? 0.4 : confidenceOf(1 - cv);

  // sign-aware trend note so a declining history reads "− trend N¢", never "+ trend −N¢".
  const roundedTrend = Math.round(trend);
  const capNote = pace.trendWasCapped ? " (capped)" : "";
  const trendNote = roundedTrend !== 0 ? ` ${roundedTrend > 0 ? "+" : "-"} trend ${Math.abs(roundedTrend)}¢${capNote}` : "";
  return {
    method: "trailingAverage",
    expectedTotalCents: expected,
    targetCents: null,
    basis: n === 0 ? "no prior periods" : `avg of last ${n} period${n === 1 ? "" : "s"}${trendNote}`,
    confidence,
  };
}

// ── method: priorPeriod (the ghost's headline) ──────────────────────────────

export interface PriorPeriodInput {
  /** the same window one period earlier, integer cents (magnitude) */
  priorTotalCents: number;
  /** e.g. "last month", "Q2 2026" — for the basis string */
  label?: string;
}

/**
 * "This is what I spent last {period}" — the same window one period earlier,
 * as-is. A historical fact (confidence 1); the UI renders it as a faint ghost
 * reference, never dressed up as a forecast of the current period.
 */
export function projectPriorPeriod(input: PriorPeriodInput): Projection {
  return {
    method: "priorPeriod",
    expectedTotalCents: input.priorTotalCents,
    targetCents: null,
    basis: `same period previously${input.label ? ` (${input.label})` : ""}`,
    confidence: 1,
  };
}

// ── method: recurringDriven (from recurring.ts occurrences) ──────────────────

export interface RecurringOccurrence {
  day: string;
  amountCents: number;
}

export interface RecurringDrivenInput {
  from: string;
  to: string;
  /** projected occurrences (from recurring.ts::projectOccurrences — passed in to stay DB-free) */
  occurrences: readonly RecurringOccurrence[];
}

/** Sum the projected recurring occurrences that fall within [from, to] (inclusive). */
export function sumOccurrencesInWindow(
  occurrences: readonly RecurringOccurrence[],
  from: string,
  to: string,
): { totalCents: number; count: number } {
  let totalCents = 0;
  let count = 0;
  for (const o of occurrences) {
    if (compareDates(o.day, from) < 0 || compareDates(o.day, to) > 0) continue;
    totalCents += o.amountCents;
    count += 1;
  }
  return { totalCents, count };
}

/**
 * "Expected recurring: $X" — the sum of detected/confirmed recurring charges
 * projected into the window. Fairly reliable (they're evidenced series) but not
 * certain, so confidence sits below 1.
 */
export function projectRecurringDriven(input: RecurringDrivenInput): Projection {
  const { totalCents, count } = sumOccurrencesInWindow(input.occurrences, input.from, input.to);
  return {
    method: "recurringDriven",
    expectedTotalCents: totalCents,
    targetCents: null,
    basis: `${count} expected recurring charge${count === 1 ? "" : "s"}`,
    confidence: count === 0 ? 0 : 0.85,
  };
}

// ── method: runRate (linear extrapolation of a series) ───────────────────────

export interface RunRateInput {
  /** the actual series so far (ascending by day), integer cents; nulls ignored */
  series: readonly { day: string; valueCents: number | null }[];
  /** the window end to extrapolate to */
  to: string;
}

/**
 * Linear extrapolation of a running series to the window end — fits the slope
 * between the first and last real points and projects it forward. Used for
 * time-series (net worth, account balance) where a to-date total isn't the
 * right basis. Confidence falls the further we extrapolate beyond what we've
 * actually observed.
 */
export function projectRunRate(input: RunRateInput): Projection {
  const real = input.series.filter(
    (p): p is { day: string; valueCents: number } => p.valueCents !== null,
  );
  if (real.length < 2) {
    const only = real[0]?.valueCents ?? 0;
    return {
      method: "runRate",
      expectedTotalCents: only,
      targetCents: null,
      basis: "not enough points to fit a run rate",
      confidence: 0,
    };
  }
  const first = real[0]!;
  const last = real[real.length - 1]!;
  const observedSpan = diffDays(first.day, last.day);
  const extrapolateSpan = Math.max(0, diffDays(last.day, input.to));
  const slopePerDay = observedSpan > 0 ? (last.valueCents - first.valueCents) / observedSpan : 0;
  const expected = Math.round(last.valueCents + slopePerDay * extrapolateSpan);

  const total = observedSpan + extrapolateSpan;
  const confidence = total === 0 ? 0 : confidenceOf(observedSpan / total);
  return {
    method: "runRate",
    expectedTotalCents: expected,
    targetCents: null,
    basis: `linear run rate over ${real.length} points, extrapolated ${extrapolateSpan} day${extrapolateSpan === 1 ? "" : "s"}`,
    confidence,
  };
}

// ── method: budgetTarget (the set target line) ───────────────────────────────

export interface BudgetTargetInput {
  /** the set budget/target for the window, integer cents */
  targetCents: number;
}

/**
 * The budget/target reference. Not a forecast of its own — it simply carries the
 * set target as both the reference line and the "expected" total (the target IS
 * the expectation for a budget), at confidence 1 (a set fact). A surface that
 * also wants "projected $Y vs budget $W" composes this with a separate
 * projectPace bundle, rather than conflating a live estimate with the fixed target.
 */
export function projectBudgetTarget(input: BudgetTargetInput): Projection {
  return {
    method: "budgetTarget",
    expectedTotalCents: input.targetCents,
    targetCents: input.targetCents,
    basis: "set budget target",
    confidence: 1,
  };
}

// ── series builders (the drawing layer) ──────────────────────────────────────

export interface ForwardSeriesInput {
  /** the last real (actual) day the solid line reaches */
  lastActualDay: string;
  /** the value at lastActualDay, integer cents */
  lastActualCents: number;
  /** the window end to project to */
  to: string;
  /** where the projection lands at `to`, integer cents */
  expectedTotalCents: number;
}

/**
 * A dashed forward continuation from the last real point to (to, expected),
 * one point per day, linearly interpolated. Returns the anchor point (solid,
 * complete:true) followed by the estimated tail (complete:false) so the chart
 * can draw one seamless dashed line that joins the solid series. Empty tail
 * (to ≤ lastActualDay) → just the anchor.
 */
export function buildForwardSeries(input: ForwardSeriesInput): ProjectionPoint[] {
  const { lastActualDay, lastActualCents, to, expectedTotalCents } = input;
  const out: ProjectionPoint[] = [{ day: lastActualDay, valueCents: lastActualCents, complete: true }];
  const span = diffDays(lastActualDay, to);
  if (span <= 0) return out;
  for (let k = 1; k <= span; k++) {
    const day = addDays(lastActualDay, k);
    const value = Math.round(lastActualCents + ((expectedTotalCents - lastActualCents) * k) / span);
    out.push({ day, valueCents: value, complete: false });
  }
  return out;
}

/**
 * The prior period's OWN bucket at the same offset — `null` where the prior
 * period has no such bucket. The rule for every surface that reads the ghost as
 * a FACT rather than drawing it as a shape: a table cell, a cumulative total, a
 * sentence naming a date.
 *
 * 🔴 A nearest-fraction RESAMPLE was the only rule, and all three of its
 * consumers read its output as per-bucket truth. Measured on the real ledger,
 * 2026-09-11:
 *
 *   - `/spending?period=YYYY-MM&cash=table` — the column headed
 *     `Spent, <prior month>` printed **610 of 1,539 cells (39.6%), across 41 of
 *     53 periods**, from a different calendar day than the day number beside it.
 *     `?period=2026-07` row "20" showed June 19's $1,984.89; June 20 was $89.71.
 *   - `/spending?period=YYYY-MM&cash=graph` — the dashed cumulative ghost summed
 *     the resampled series, so its last point disagreed with the page's own
 *     "$X in <prior month>" readout on **33 of 53 periods**: `?period=2023-03`
 *     ended at $2,943.05 against a stated $2,541.21.
 *
 * Aligning by index means "the same POSITION in the period": the same day of
 * the month for a calendar month, the same month for a year — and, for a
 * quarter, the same month-of-quarter (July beside April), not the same calendar
 * month, which no prior quarter has. That is what every surface claims, and the
 * resample is gone: it existed only to paper over a length mismatch this
 * handles honestly, by leaving a gap where the prior period has no bucket. A prior
 * period that is SHORTER leaves trailing `null`s (render "—", hold the running
 * total); one that is LONGER has a tail no bucket of this window can carry — a
 * cumulative caller must add it back at the last point, which is the only place
 * "by here" means "all of it". Empty input, or a non-positive length → empty.
 */
export function alignByIndex(
  values: readonly number[],
  targetLength: number,
): (number | null)[] {
  if (targetLength <= 0 || values.length === 0) return [];
  const out: (number | null)[] = [];
  for (let i = 0; i < targetLength; i++) out.push(i < values.length ? values[i]! : null);
  return out;
}
