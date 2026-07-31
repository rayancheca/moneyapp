/**
 * Trackpad zoom + pan for the scrub charts, as index arithmetic.
 *
 * The charts already had drag-to-select-a-window; what was missing was the
 * gesture people actually reach for. Owner, 2026-07-31: *"make it so i can zoom
 * in when i use the trackpad and all that."*
 *
 * This is deliberately pure index maths over the series, NOT pixel maths, and it
 * emits the same `[startIdx, endIdx]` window the brush already produces — so
 * zooming reuses the existing custom-window path end to end (the header caption,
 * the From/To inputs, Reset, the table lens showing the chart's own window) and
 * introduces no second notion of "what is on screen".
 *
 * WHY THE ANCHOR MATTERS: a zoom that always keeps the window's centre feels
 * broken on a trackpad, because the thing under your fingers slides away. Both
 * functions take the cursor's position as a ratio and hold the point under it
 * fixed, which is what makes the gesture feel attached to the data.
 */

/** An inclusive window over a series, as indices into that series. */
export interface IndexWindow {
  startIdx: number;
  endIdx: number;
}

/**
 * Per wheel-delta-unit exponent. Chosen so a normal macOS pinch (which arrives
 * in deltaY units of roughly ±1–10 per frame) reads as a smooth continuous zoom
 * rather than a jump: e^(10 × 0.0035) ≈ 1.036, so ~3.6% per strong frame.
 */
export const ZOOM_SENSITIVITY = 0.0035;

/**
 * A wheel deltaY into a span multiplier. Exponential, not linear, so zooming out
 * and back in by the same gesture returns to the same span — a linear factor
 * drifts, and the drift is visible as a window that never comes back.
 *
 * Sign follows the platform: a trackpad pinch OPEN (zoom in) reports NEGATIVE
 * deltaY, giving a factor below 1, i.e. a shorter span. Do not "fix" this.
 */
export function zoomFactorFromWheel(deltaY: number): number {
  return Math.exp(deltaY * ZOOM_SENSITIVITY);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Scale the window about the point under `anchorRatio` (0 = its left edge,
 * 1 = its right edge).
 *
 * Every bound is a clamp rather than a conditional: a window can never invert,
 * never escape the series, and never shrink below two points — which is the
 * minimum the chart can draw a line through, and the same floor `applyWindow`
 * enforces. Keeping those as clamps rather than early returns means the caller
 * gets a usable window for ANY input instead of a refusal it has to handle.
 */
export function zoomIndexWindow(
  total: number,
  window: IndexWindow,
  anchorRatio: number,
  factor: number,
): IndexWindow {
  const maxIdx = Math.max(total - 1, 0);
  const maxSpan = Math.max(maxIdx, 1);
  const span = clamp(window.endIdx - window.startIdx, 1, maxSpan);
  const nextSpan = Math.round(clamp(span * factor, 1, maxSpan));
  const ratio = clamp(anchorRatio, 0, 1);
  const anchor = window.startIdx + ratio * span;
  const startIdx = clamp(Math.round(anchor - ratio * nextSpan), 0, Math.max(maxIdx - nextSpan, 0));
  return { startIdx, endIdx: Math.min(startIdx + nextSpan, maxIdx) };
}

/**
 * Slide the window by `deltaPoints` without changing its span, stopping at the
 * ends of the series. Span is preserved exactly (not re-derived from the clamped
 * start) so panning into a boundary parks against it instead of squashing the
 * window — a pan that silently zooms is the bug this shape prevents.
 */
export function panIndexWindow(
  total: number,
  window: IndexWindow,
  deltaPoints: number,
): IndexWindow {
  const maxIdx = Math.max(total - 1, 0);
  const span = clamp(window.endIdx - window.startIdx, 0, maxIdx);
  const startIdx = clamp(Math.round(window.startIdx + deltaPoints), 0, Math.max(maxIdx - span, 0));
  return { startIdx, endIdx: startIdx + span };
}

/**
 * How many points a horizontal wheel delta should pan, given the visible span
 * and the plot's pixel width. Scaled by span/width so the data tracks the
 * fingers at roughly 1:1 regardless of how far in the user is zoomed — a fixed
 * points-per-pixel would crawl when zoomed out and bolt when zoomed in.
 *
 * Falls back to one point per event when the width is unknown or degenerate, so
 * a pan before the plot has been measured still moves rather than doing nothing.
 */
export function panPointsFromWheel(deltaX: number, span: number, plotWidthPx: number): number {
  if (plotWidthPx <= 0) return Math.sign(deltaX);
  return (deltaX / plotWidthPx) * span;
}
