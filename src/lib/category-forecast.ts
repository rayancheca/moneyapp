/**
 * Per-category spend PREDICTION — the honest forecast that seeds real budgets
 * and lights up "what will I spend?" everywhere (North Star #2, the user's
 * explicit "I want actual predictions on everything · real budgets").
 *
 * This is a PREDICTION, not a description: a category's next-period spend is
 * split into two parts and composed —
 *   1. RECURRING baseline — the bills you actually have (from your recurring
 *      series, projected into the target period). High confidence: these are
 *      evidenced, dated charges, not a guess.
 *   2. DISCRETIONARY estimate — the variable remainder, from the recent trend
 *      (trailing-average + trend, NOT a flat average), optionally nudged by the
 *      same period one year earlier (a seasonality signal).
 * The total is their sum; confidence is dollar-weighted so a forecast dominated
 * by known bills reads more certain than one dominated by a lumpy estimate.
 *
 * HONESTY DOCTRINE (same as projection.ts, non-negotiable): every number states
 * its method + basis + confidence. A prediction is never a bare figure — it
 * carries where it came from, so the UI can label it and render low-confidence
 * estimates fainter. Money is INTEGER CENTS; every blend rounds to an integer.
 *
 * This module is PURE (no db, no clock): the service layer
 * (services/category-forecast.ts) gathers the recurring occurrences, the
 * trailing discretionary history, and the seasonal prior, then composes them
 * here via projection.ts's tested method registry.
 */

import { formatCents } from "./money";
import { PROJECTION_METHOD_LABEL, type Projection } from "./projection";

/**
 * The same-period-last-year anchor's weight in the discretionary blend; the
 * recent trend gets the rest (1 − weight). A single year-ago point is a real
 * seasonal signal but noisy (one sample), so it NUDGES the estimate rather than
 * dominating it. Kept modest and documented so the blend is defensible.
 */
export const SEASONAL_WEIGHT = 0.35;

/** trend and seasonal within this fraction → they corroborate (confidence up). */
const AGREE_DIVERGENCE = 0.25;
/** trend and seasonal more than this fraction apart → they conflict (confidence down). */
const CONFLICT_DIVERGENCE = 0.75;
/** confidence bump when the two signals corroborate. */
const SEASONAL_CONFIDENCE_BONUS = 0.1;
/** confidence multiplier when the two signals conflict. */
const CONFLICT_CONFIDENCE_FACTOR = 0.7;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** round to 2 decimals — stable, comparable confidence (mirrors projection.ts). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** A single labeled contributor to a category's forecast (for the visible math). */
export interface ForecastPart {
  key: "recurring" | "discretionary";
  label: string;
  /** magnitude, integer cents */
  cents: number;
  /** human method label (a PROJECTION_METHOD_LABEL value) */
  method: string;
  /** visible-math basis of this part */
  basis: string;
  /** 0..1 */
  confidence: number;
}

/** A composed per-category next-period spend prediction. */
export interface CategoryForecast {
  /** predicted spend for the period = recurring + discretionary, integer cents (magnitude) */
  expectedTotalCents: number;
  recurringCents: number;
  discretionaryCents: number;
  /** dollar-weighted overall confidence, 0..1 (2dp) */
  confidence: number;
  /** one-line composite basis */
  basis: string;
  /** the labeled contributors, in display order */
  parts: ForecastPart[];
}

/**
 * Blend a same-period-last-year seasonal anchor into a discretionary trailing-
 * average projection. Returns a NEW Projection; with no seasonal prior it
 * returns the input unchanged. The point estimate moves toward the year-ago
 * figure by SEASONAL_WEIGHT and never below zero; confidence rises when the two
 * signals corroborate and falls when they conflict (but a $0/$0 blend gains
 * nothing — there is nothing to be more or less certain about); the basis always
 * names the adjustment.
 */
export function seasonallyAdjust(
  discretionary: Projection,
  seasonalPriorCents: number | null,
): Projection {
  if (seasonalPriorCents === null) return discretionary;

  const trend = discretionary.expectedTotalCents;
  const seasonal = Math.max(0, seasonalPriorCents);
  const blended = Math.max(
    0,
    Math.round((1 - SEASONAL_WEIGHT) * trend + SEASONAL_WEIGHT * seasonal),
  );

  const denom = Math.max(1, Math.max(trend, seasonal));
  const divergence = Math.abs(trend - seasonal) / denom;
  let confidence = discretionary.confidence;
  if (blended > 0) {
    if (divergence <= AGREE_DIVERGENCE) {
      confidence = round2(clamp01(discretionary.confidence + SEASONAL_CONFIDENCE_BONUS));
    } else if (divergence >= CONFLICT_DIVERGENCE) {
      confidence = round2(discretionary.confidence * CONFLICT_CONFIDENCE_FACTOR);
    }
  }

  return {
    method: discretionary.method,
    expectedTotalCents: blended,
    targetCents: null,
    basis: `${discretionary.basis}, nudged toward ${formatCents(seasonal)} same period last year`,
    confidence,
  };
}

/**
 * Combine a recurring-driven projection (known bills) with a discretionary
 * projection (estimated variable spend) into one labeled per-category forecast.
 * The total is their sum; overall confidence is dollar-weighted (a forecast
 * dominated by known bills reads more certain than one dominated by estimate).
 * The recurring part is omitted when there is no recurring spend, so the visible
 * math never shows a "$0.00 expected recurring" noise row.
 */
export function combineCategoryForecast(
  recurring: Projection,
  discretionary: Projection,
): CategoryForecast {
  const recurringCents = recurring.expectedTotalCents;
  const discretionaryCents = discretionary.expectedTotalCents;
  const expectedTotalCents = recurringCents + discretionaryCents;

  const weightSum = recurringCents + discretionaryCents;
  const confidence =
    weightSum === 0
      ? 0
      : round2(
          (recurringCents * recurring.confidence + discretionaryCents * discretionary.confidence) /
            weightSum,
        );

  const parts: ForecastPart[] = [];
  if (recurringCents > 0) {
    parts.push({
      key: "recurring",
      label: "Expected recurring",
      cents: recurringCents,
      method: PROJECTION_METHOD_LABEL[recurring.method],
      basis: recurring.basis,
      confidence: recurring.confidence,
    });
  }
  parts.push({
    key: "discretionary",
    label: "Discretionary estimate",
    cents: discretionaryCents,
    method: PROJECTION_METHOD_LABEL[discretionary.method],
    basis: discretionary.basis,
    confidence: discretionary.confidence,
  });

  const basis =
    recurringCents > 0
      ? `${formatCents(recurringCents)} expected recurring + ${formatCents(discretionaryCents)} discretionary`
      : `${formatCents(discretionaryCents)} discretionary (no recurring bills)`;

  return { expectedTotalCents, recurringCents, discretionaryCents, confidence, basis, parts };
}
