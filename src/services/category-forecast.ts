import { and, asc, eq, gte, inArray, isNull, lte, notExists } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { budgets } from "@/db/schema/budgets";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { monthLabel } from "@/lib/calendar-math";
import { addDays, compareDates, monthKey, periodBounds, todayIso, type PeriodBounds } from "@/lib/dates";
import {
  combineCategoryForecast,
  seasonallyAdjust,
  type CategoryForecast,
} from "@/lib/category-forecast";
import { projectRecurringDriven, projectTrailingAverage } from "@/lib/projection";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { loadCategoryIndex, offAgentsCash, recurringSeriesIdsForSubtree, type CategoryIndex } from "./analytics";
import { listBudgetableCategories } from "./budgets";
import { isUpfrontCarRow, upfrontCarRule, type UpfrontCarRule } from "./car-upfront";
import { silenceMeasuredThroughBySeries } from "./cash-earnings";
import { trailingFullMonths } from "./forecast";
import { hasStoppedForecasting, projectOccurrences, toProjectable } from "./recurring";
import { linkIsNotRecurring, seriesIdsNotDrawnAsRecurring } from "./recurring-link";

/**
 * The PREDICTION service (user ask: "I want actual predictions on everything ·
 * real budgets"). For a category, it forecasts the NEXT full month's spend by
 * composing two evidenced parts via the pure engine (lib/category-forecast +
 * projection):
 *   - RECURRING baseline — the category's own recurring series, projected into
 *     next month (the bills you actually have).
 *   - DISCRETIONARY estimate — the non-recurring subtree spend's recent trend,
 *     nudged by the same month one year earlier (a seasonality signal).
 * This is a genuine forward forecast, NOT the trailing-average DESCRIPTION that
 * budget-suggest produces — and every number it returns carries its method +
 * basis + confidence, so the UI never shows a bare predicted figure.
 *
 * DB-coupled but thin: all the math lives in the pure libs; this module only
 * gathers occurrences, trailing history, and the seasonal prior, then composes.
 */

/** Trailing complete months of discretionary history that feed the trend. */
export const PREDICT_TRAILING_MONTHS = 3;

/** A predicted budget under this earns no budget (noise), cents. */
export const PREDICTED_BUDGET_FLOOR_CENTS = 2_000;
/** Round the seeded budget UP to this granularity so a clean prediction never
 *  reads instantly "over budget", cents. */
export const BUDGET_ROUND_TO_CENTS = 1_000;

export interface CategoryPrediction {
  categoryId: string;
  /** the (top-level) category display name */
  label: string;
  forecast: CategoryForecast;
  /** the target period this predicts, e.g. "August 2026" */
  periodLabel: string;
  targetStart: string;
  targetEnd: string;
  /** whether the same-period-last-year blend ACTUALLY moved the discretionary
   *  estimate (not merely whether an anchor was in coverage) — the UI's honest
   *  trigger for the "seasonally adjusted" label. */
  seasonalApplied: boolean;
}

interface PredictContext {
  index: CategoryIndex;
  /** earliest active transaction date, or null when the ledger is empty */
  earliestDate: string | null;
  /** active (detected|confirmed) recurring series rows, for per-subtree projection */
  activeSeries: (typeof recurringSeries.$inferSelect)[];
  /** series whose still-tagged rows are not recurring money
   *  (`seriesIdsNotDrawnAsRecurring` — the dismissed ones): false positives whose
   *  spend is really variable, so it falls BACK into the discretionary trend
   *  (they are never projected as a recurring baseline) — all but a Car row dated
   *  before the lease starts, which is the car's up-front money (`upfrontCar`). */
  notDrawnAsRecurring: ReadonlySet<string>;
  /** `outsidePortfolioCashAccountIds` — the agent's cash, whose costs are not his spending (`spendingBucket`) */
  agentsCash: readonly string[];
  /**
   * `upfrontCarRule` — the rows the car card spreads over the lease, which no trend projects (§6A 48): Car rows dated
   * before the lease starts and no bill (§6A 52). A repair after it is discretionary like any spend. Null with no car.
   */
  upfrontCar: UpfrontCarRule | null;
  /** the day a lapsed series is measured against */
  today: string;
  /** `silenceMeasuredThroughBySeries` — the day each series' lapse is measured to (§6A 57) */
  checkedThrough: (seriesId: string) => string | null;
  target: PeriodBounds;
  targetLabel: string;
  months: { start: string; end: string; key: string }[];
  /** same-month-last-year bounds, or null when that month predates the data */
  seasonal: { start: string; end: string } | null;
}

/** The next full calendar month after the month containing `today`. */
export function nextMonthBounds(today: string): PeriodBounds {
  const current = periodBounds(today, "monthly");
  return periodBounds(addDays(current.end, 1), "monthly");
}

/** The earliest active transaction date (coverage floor), or null if none. */
function earliestActiveTxnDate(db: AppDatabase): string | null {
  const row = db
    .select({ postedOn: transactions.postedOn })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .orderBy(asc(transactions.postedOn))
    .limit(1)
    .get();
  return row?.postedOn ?? null;
}

/** Non-recurring subtree spend over [from,to], clamped at $0 (a net-refund month
 *  is a $0 spend month — matches budget-suggest). Recurring-tagged rows are
 *  excluded so they are never double-counted with the recurring projection.
 *
 *  ⚖️ HIS spend: an expense row on the agent's cash is the agent's cost, either
 *  sign (`isAgentsCostCategoryRow`, owner decision 2026-10-02) — a split part
 *  posts where its row does. 🔴 The agent's Gold fee each month made Fees a
 *  $5.00-a-month habit of his in Predict budgets and /spending's forecast. */
function nonRecurringSubtreeSpend(
  db: AppDatabase,
  subtreeIds: readonly string[],
  from: string,
  to: string,
  /** series whose tagged rows FOLD BACK into discretionary — a dismissed series'
   *  rows are false positives whose spend is really variable and is not projected
   *  anywhere else. Untagged rows always count; rows tagged to a projected
   *  (detected/confirmed) or ended series stay excluded (no double-count / no
   *  stopped bill). The one rule `/recurring` and `/budgets` read too. */
  notDrawn: ReadonlySet<string>,
  agentsCash: readonly string[],
  /** `upfrontCarRule` — the car's up-front money is no habit (owner decision 2026-10-07, §6A 48) */
  upfrontCar: UpfrontCarRule | null,
): number {
  const notRecurring = linkIsNotRecurring(notDrawn);
  // split-aware: an unsplit row contributes its whole amount when its own
  // category is in the subtree; a split row contributes only the parts whose
  // category is in the subtree (its stale parent category is ignored).
  const unsplit = db
    .select({
      amountCents: transactions.amountCents,
      postedOn: transactions.postedOn,
      categoryId: transactions.categoryId,
      accountId: transactions.accountId,
      recurringSeriesId: transactions.recurringSeriesId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        notRecurring,
        offAgentsCash(agentsCash),
        inArray(transactions.categoryId, [...subtreeIds]),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
        notExists(
          db
            .select({ one: transactionSplits.id })
            .from(transactionSplits)
            .where(eq(transactionSplits.transactionId, transactions.id)),
        ),
      ),
    )
    .all();
  const splitParts = db
    .select({
      amountCents: transactionSplits.amountCents,
      postedOn: transactions.postedOn,
      categoryId: transactionSplits.categoryId,
      accountId: transactions.accountId,
      recurringSeriesId: transactions.recurringSeriesId,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.transferGroupId), // transfer-linked parts never count
        notRecurring,
        offAgentsCash(agentsCash),
        inArray(transactionSplits.categoryId, [...subtreeIds]),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();
  /*
   * ⚖️ The car's up-front money leaves the trend — the car card's own predicate, asked of each row and each part, so
   * /spending and "Predict budgets" agree with /recurring's pace. 🔴 On his ledger 2026-10-07 Car predicted $2,033.33
   * of November discretionary spending on top of the lease and the premium: the $6,100 down payment and deposit ÷ 3.
   */
  return Math.max(
    0,
    [...unsplit, ...splitParts]
      .filter((r) => !isUpfrontCarRow(upfrontCar, r))
      .reduce((sum, r) => sum - r.amountCents, 0),
  );
}

function buildContext(db: AppDatabase, today: string): PredictContext {
  const target = nextMonthBounds(today);
  const earliestDate = earliestActiveTxnDate(db);

  // same month one year before the TARGET month (day-01 → no Feb-29 hazard)
  const seasonalStartDate = `${Number(target.start.slice(0, 4)) - 1}${target.start.slice(4)}`;
  const seasonalBounds = periodBounds(seasonalStartDate, "monthly");
  // only offer the seasonal anchor when that whole month is inside coverage —
  // otherwise a $0 could mean "no data yet", not "spent nothing" (never fabricate)
  const seasonal =
    earliestDate !== null && compareDates(seasonalBounds.start, earliestDate) >= 0
      ? { start: seasonalBounds.start, end: seasonalBounds.end }
      : null;

  const index = loadCategoryIndex(db);
  const notDrawnAsRecurring = seriesIdsNotDrawnAsRecurring(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  return {
    index,
    earliestDate,
    activeSeries: db
      .select()
      .from(recurringSeries)
      .where(inArray(recurringSeries.status, ["detected", "confirmed"]))
      .all(),
    notDrawnAsRecurring,
    agentsCash: [...agentsCash],
    upfrontCar: upfrontCarRule(index, agentsCash, notDrawnAsRecurring),
    today,
    checkedThrough: silenceMeasuredThroughBySeries(db, today),
    target,
    targetLabel: monthLabel(monthKey(target.start)),
    months: trailingFullMonths(today, PREDICT_TRAILING_MONTHS),
    seasonal,
  };
}

function predictWith(
  db: AppDatabase,
  ctx: PredictContext,
  categoryId: string,
  label: string,
): CategoryPrediction {
  const subtree = ctx.index.subtreeIds(categoryId);
  /*
   * 🔴 THE SAME MEMBERSHIP /budgets AND THE CATEGORY PAGE READ. A private copy
   * found series only through posted rows and never read `user_category_id`,
   * so a commitment that has not charged yet forecast nothing: on the real
   * ledger 2026-09-14, /spending's October Car read "$361.49 expected
   * recurring" without the $695.04 lease, Transport "(no recurring bills)"
   * over $368.86 of parking, and Health had no line at all — $1,346.11 the
   * budget tail for the same categories projected. It also forecast a posted
   * series in the category its rows sit in after the owner moved it.
   */
  const subtreeSeriesIds = recurringSeriesIdsForSubtree(db, subtree);

  // 1. RECURRING baseline — this subtree's series projected into the target month.
  //    Money-out occurrences become positive-magnitude spend for the projection.
  const occurrences: { day: string; amountCents: number }[] = [];
  for (const series of ctx.activeSeries) {
    if (series.kind === "transfer") continue; // transfers are never spending
    // a series that stopped posting projects nothing — the gate budgetTail,
    // the month forecast and the calendar already apply (a never-posted
    // commitment has not lapsed: it has not started)
    if (hasStoppedForecasting(series, ctx.today, ctx.checkedThrough(series.id))) continue;
    if (!subtreeSeriesIds.has(series.id)) continue;
    for (const o of projectOccurrences(toProjectable(series), ctx.target.start, ctx.target.end)) {
      if (o.amountCents < 0) occurrences.push({ day: o.date, amountCents: -o.amountCents });
    }
  }
  const recurring = projectRecurringDriven({
    from: ctx.target.start,
    to: ctx.target.end,
    occurrences,
  });

  // 2. DISCRETIONARY estimate — the non-recurring trend, seasonally nudged. Rows
  //    tagged to a DISMISSED series (a false positive whose spend continues) are
  //    projected nowhere else, so they fold back into the trend here — otherwise
  //    they would vanish from the forecast entirely.
  //    ⛔ EVERY dismissed id, not this subtree's membership: a dismissed series
  //    the owner moved elsewhere is no longer a member here, yet its rows still
  //    sit here — and `nonRecurringSubtreeSpend` already scopes rows by subtree.
  const { notDrawnAsRecurring, agentsCash, upfrontCar } = ctx;
  const discretionaryHistory = ctx.months.map((m) =>
    nonRecurringSubtreeSpend(db, subtree, m.start, m.end, notDrawnAsRecurring, agentsCash, upfrontCar),
  );
  const seasonalPrior = ctx.seasonal
    ? nonRecurringSubtreeSpend(db, subtree, ctx.seasonal.start, ctx.seasonal.end, notDrawnAsRecurring, agentsCash, upfrontCar)
    : null;
  const discretionaryBase = projectTrailingAverage({ trailingTotalsCents: discretionaryHistory });
  const discretionary = seasonallyAdjust(discretionaryBase, seasonalPrior);
  // "seasonally adjusted" is honest only when the blend actually MOVED the
  // estimate — never merely because an anchor happened to be in coverage (a
  // recurring-only category with $0 discretionary blends $0→$0, moving nothing).
  const seasonalApplied =
    seasonalPrior !== null &&
    discretionary.expectedTotalCents !== discretionaryBase.expectedTotalCents;

  return {
    categoryId,
    label,
    forecast: combineCategoryForecast(recurring, discretionary),
    periodLabel: ctx.targetLabel,
    targetStart: ctx.target.start,
    targetEnd: ctx.target.end,
    seasonalApplied,
  };
}

/** Predict next month's spend for one category. */
export function predictCategory(
  db: AppDatabase,
  categoryId: string,
  label: string,
  today: string = todayIso(),
): CategoryPrediction {
  return predictWith(db, buildContext(db, today), categoryId, label);
}

/**
 * Predict next month's spend for every top-level expense category — the set the
 * budget seeding + the /spending predictions draw from. Sorted by predicted
 * amount (largest first). A context is built once and shared across categories.
 */
export function predictBudgetableCategories(
  db: AppDatabase,
  today: string = todayIso(),
): CategoryPrediction[] {
  const ctx = buildContext(db, today);
  return listBudgetableCategories(db)
    .filter((c) => c.depth === 0)
    .map((c) => predictWith(db, ctx, c.id, c.name))
    .sort((a, b) => b.forecast.expectedTotalCents - a.forecast.expectedTotalCents);
}

/** A next-month prediction turned into a proposable monthly budget. */
export interface PredictedBudget extends CategoryPrediction {
  /** the budget to create = predicted total rounded UP to the $10 granularity */
  amountCents: number;
}

/**
 * Predicted MONTHLY budgets for top-level expense categories that don't already
 * carry an active budget (user ask: "set my real budgets from those predictions").
 * Each amount is the category's next-month FORECAST — recurring bills + a
 * trend/seasonality-adjusted discretionary estimate — rounded UP to the nearest
 * $10, not a flat average of the past. Categories predicting below the noise
 * floor earn no budget. The full forecast (split + method + confidence + basis)
 * rides along so the UI can show exactly where each number comes from.
 */
export function predictBudgets(db: AppDatabase, today: string = todayIso()): PredictedBudget[] {
  const budgeted = new Set(
    db
      .select({ categoryId: budgets.categoryId })
      .from(budgets)
      .where(eq(budgets.isActive, true))
      .all()
      .map((b) => b.categoryId),
  );
  return predictBudgetableCategories(db, today)
    .filter((p) => !budgeted.has(p.categoryId) && p.forecast.expectedTotalCents >= PREDICTED_BUDGET_FLOOR_CENTS)
    .map((p) => ({
      ...p,
      amountCents: Math.ceil(p.forecast.expectedTotalCents / BUDGET_ROUND_TO_CENTS) * BUDGET_ROUND_TO_CENTS,
    }));
}
