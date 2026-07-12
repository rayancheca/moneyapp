/**
 * P/L-calendar cell encoding (ux-overhaul-plan §6.3 [MO]): hue carries the
 * direction (gain / loss), saturation carries the magnitude. Pure so the
 * bucketing is unit-tested; the calendar cell maps (direction, step) to a
 * design-token class. Magnitude is bucketed against a per-month scale so a quiet
 * month is not all one flat color and a loud month is not all max saturation.
 */

export type PnlDirection = "up" | "down" | "flat";

/** Direction of a signed daily P/L in cents. */
export function pnlDirection(cents: number): PnlDirection {
  if (cents > 0) return "up";
  if (cents < 0) return "down";
  return "flat";
}

/**
 * Magnitude bucket 0..4 for saturation. 0 is a flat/zero day; 1..4 scale the
 * absolute P/L against `scaleCents` (typically the month's largest move), so the
 * loudest day of the month sits at 4 and small days stay dim. A non-positive
 * scale (a month with no movement) collapses any non-zero day to step 1.
 */
export function intensityStep(magnitudeCents: number, scaleCents: number): 0 | 1 | 2 | 3 | 4 {
  const magnitude = Math.abs(magnitudeCents);
  if (magnitude === 0) return 0;
  if (scaleCents <= 0) return 1;
  const ratio = Math.min(1, magnitude / scaleCents);
  const step = Math.max(1, Math.ceil(ratio * 4));
  // ratio is clamped to 1 so ceil(ratio*4) ∈ [1,4]; the clamp keeps it in range
  return step as 1 | 2 | 3 | 4;
}
