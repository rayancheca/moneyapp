/**
 * COMMITTED versus VARIABLE, for a month the forecast has already projected.
 *
 * The forecast card published one spending number. On the owner's own ledger
 * for September 2026 that number is **$11,765.34**, and he read it against an
 * expectation of "3-5k" and concluded the app disagreed with him. It did not:
 * **$3,567.60** of it is rent, fees, the lease, insurance, the gym, FPL and the
 * internet — money already agreed to — and **$8,197.74** is a trailing pace
 * extrapolated from his own last three months. He was right about his bills.
 * The card just never said which half was which.
 *
 * ## ⛔ This module decides NOTHING about the forecast
 *
 * It does not choose which series are live, which have lapsed, how the trailing
 * pace is computed, or what a month's window is. `services/forecast` owns every
 * one of those and has the lapse rule, the calendar stepping and the chained
 * end-of-month arithmetic to prove it. This is a partition of the array that
 * function already returned, and nothing more. Duplicating any of the decisions
 * would create a second answer to a question that already has one — the defect
 * that put a previous landlord in the forecast for seven months, because
 * `seriesHasLapsed` existed and only two of its three callers used it.
 *
 * ## The identity, and why it holds by arithmetic rather than by test
 *
 * `services/forecast` derives its published totals by summing the components by
 * SIGN: income is every component above zero, spending every component below.
 * This module partitions the same array by sign FIRST and by `kind` second, so
 *
 *     income.totalCents   === forecast.projectedIncomeCents
 *     spending.totalCents === forecast.projectedSpendCents
 *
 * are not approximations that happen to agree — they are the same sum with the
 * addends grouped differently, and no rounding enters because every term is an
 * integer count of cents. A test asserts it anyway, on the real component
 * shapes, because "guaranteed by construction" is a claim about code that can
 * be edited.
 *
 * ⚠️ Signs are NET-WORTH SIGNED throughout, as everywhere else in the app:
 * `spending.totalCents` is NEGATIVE. It is not flipped to a magnitude here,
 * because the card renders it straight through `<Money flow>` beside the
 * headline it must match, and a module that silently changed the sign would
 * make the two disagree in the one place a reader compares them.
 */

/** Where a projected figure came from. Mirrors `ForecastComponent["kind"]`. */
export type ForecastComponentKind = "fixed" | "variable";

/**
 * The shape this module needs from a forecast component. Structurally a subset
 * of `ForecastComponent`, restated so `lib` keeps not importing from `services`
 * — the idiom `committed`, `cash-earnings` and `section-notes` already follow.
 */
export interface SplittableComponent {
  kind: ForecastComponentKind;
  /** net-worth signed: income positive, spending negative */
  cents: number;
  /**
   * Fixed components only: the series' evidence is past its own tolerance.
   * Absent on variable components, which have no series behind them — read a
   * missing value as "not stale", never as "unknown".
   */
  isStale?: boolean;
  /**
   * Fixed components only: no charge has EVER matched the series. Absent reads
   * as "it has charged", never as "unknown", the same as `isStale`.
   *
   * ⛔ A subset of `isStale`, not a sibling of it. `seriesStaleness` calls a
   * never-charged series stale — correctly, because both mean the projection
   * rests on something other than a recent charge — but "running late" is only
   * true of the half that has charged before. Measured on the real ledger,
   * September's committed money out was $1,402.60 "running late" of which
   * $1,338.74 had never been billed, and three of those four bills were not
   * due yet.
   */
  neverCharged?: boolean;
}

export interface ForecastSplitSide {
  /**
   * The part that comes from a recurring series: a commitment when money is
   * going out, a schedule when it is coming in. Net-worth signed.
   */
  fixedCents: number;
  /** The part extrapolated from the trailing pace. Net-worth signed. */
  variableCents: number;
  /** `fixedCents + variableCents` — the figure the card already publishes. */
  totalCents: number;
  /**
   * `|fixedCents| / |totalCents|`, in 0..1 — what the bar draws.
   *
   * NULL rather than 0 when the total is zero, and the distinction is the whole
   * reason it is nullable: a month with nothing projected has no composition at
   * all, and drawing it as "0% committed" would assert that everything expected
   * is discretionary. The last day of a month reaches this state routinely —
   * measured 2026-08-31, the running month projects $1.47 of income from a
   * single trailing component and no fixed occurrences remain.
   */
  fixedShare: number | null;
  /** components counted into `fixedCents` (zero-amount ones are not) */
  fixedCount: number;
  /** components counted into `variableCents` (zero-amount ones are not) */
  variableCount: number;
  /**
   * The part of `fixedCents` whose series has not posted inside its own
   * tolerance. Net-worth signed, like everything else here.
   *
   * ⛔ This exists because of ONE reading, and the reading is the whole reason
   * the split was worth building. September 2026 projects $4,233.69 of income,
   * of which $4,188.00 — 98.9% — is `Cash job (weekly pay)`, a series whose
   * newest matched deposit is 2026-06-05, eighty-seven days earlier. The owner
   * confirmed the job is still running and that he spends the cash without
   * banking it, so the number is not wrong; it is simply resting on two rows
   * from June. `fixedCents` alone cannot say that, and a projection that cannot
   * say it is asking to be believed.
   *
   * ⚠️ Stale is not lapsed and is never a reason to drop the money.
   * `services/forecast` already decided what to project; a lapsed money-out
   * series never reaches this module at all. This reports the age of what
   * survived that decision.
   */
  fixedStaleCents: number;
  /** how many of `fixedCount` are stale */
  fixedStaleCount: number;
  /**
   * The part of `fixedStaleCents` that has never charged at all — a SUBSET of
   * it, never a sibling. Net-worth signed, like everything else here.
   */
  fixedNeverChargedCents: number;
  /** how many of `fixedStaleCount` have never charged */
  fixedNeverChargedCount: number;
}

export interface ForecastSplit {
  income: ForecastSplitSide;
  spending: ForecastSplitSide;
}

const EMPTY_SIDE = (): ForecastSplitSide => ({
  fixedCents: 0,
  variableCents: 0,
  totalCents: 0,
  fixedShare: null,
  fixedCount: 0,
  variableCount: 0,
  fixedStaleCents: 0,
  fixedStaleCount: 0,
  fixedNeverChargedCents: 0,
  fixedNeverChargedCount: 0,
});

/**
 * Partitions a month's projected components into money in and money out, each
 * split by whether a series or the trailing pace produced it.
 *
 * ⚠️ A ZERO-amount component is counted into neither side and into neither
 * count. It moves no money, so it changes no total; giving it a count would
 * make the card offer to explain a line that says $0.00, which is the shape a
 * previous pass shipped as a 77.97px bar labelled "$0.00". `services/forecast`
 * already filters most of these out (`variableComponents` drops a projection of
 * zero, `variableIncomeComponents` requires a positive one), so this is a
 * boundary the caller currently never reaches — stated here because "the caller
 * happens not to" is not the same as "it cannot".
 */
export function forecastSplit(components: readonly SplittableComponent[]): ForecastSplit {
  const income = EMPTY_SIDE();
  const spending = EMPTY_SIDE();

  for (const c of components) {
    if (c.cents === 0) continue;
    // ⚠️ `> 0` and `>= 0` are indistinguishable here, and deliberately so: the
    // line above has already removed the only value that separates them.
    // Measured by mutation — relaxing this to `>= 0` changes no test — and
    // stated rather than tightened, because the zero-skip is the guard that
    // carries the meaning and a second one pretending to would just be noise.
    const side = c.cents > 0 ? income : spending;
    if (c.kind === "fixed") {
      side.fixedCents += c.cents;
      side.fixedCount += 1;
      if (c.isStale === true) {
        side.fixedStaleCents += c.cents;
        side.fixedStaleCount += 1;
        // inside the stale branch on purpose: a component that has charged
        // recently cannot be never-charged, and counting one outside would let
        // the subset exceed the set it is part of
        if (c.neverCharged === true) {
          side.fixedNeverChargedCents += c.cents;
          side.fixedNeverChargedCount += 1;
        }
      }
    } else {
      side.variableCents += c.cents;
      side.variableCount += 1;
    }
  }

  for (const side of [income, spending]) {
    side.totalCents = side.fixedCents + side.variableCents;
    side.fixedShare =
      side.totalCents === 0 ? null : Math.abs(side.fixedCents) / Math.abs(side.totalCents);
  }

  return { income, spending };
}
