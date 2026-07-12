/**
 * Scrub-index math for the ScrubChart keyboard slider + pointer hairline
 * (ux-overhaul-plan §6.3). Pure (no DOM) so the index arithmetic and the
 * screen-reader value text are unit-tested to 100%. The chart owns a scrub
 * index into its point array; these helpers move and describe it.
 */

/** Clamp an index into a series of `length` points (empty series → -1). */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  if (index > length - 1) return length - 1;
  return index;
}

/**
 * Keyboard scrub for a `role="slider"` wrapper. ArrowRight/ArrowLeft step one
 * day, ArrowUp/ArrowDown step a week, Home/End jump to the ends. Returns the new
 * clamped index, or null when the key is not a scrub key (so the handler can let
 * it through).
 */
export function stepScrubIndex(current: number, key: string, length: number): number | null {
  if (length <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clampIndex(current + (key === "ArrowUp" ? 7 : 1), length);
    case "ArrowLeft":
    case "ArrowDown":
      return clampIndex(current - (key === "ArrowDown" ? 7 : 1), length);
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

/**
 * Map a 0..1 position along the plot to the nearest point index. A ratio outside
 * [0,1] clamps to an end. Empty series → -1.
 */
export function ratioToIndex(ratio: number, length: number): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return Math.round(clamped * (length - 1));
}

/**
 * The `aria-valuetext` a screen reader announces on scrub, e.g.
 * "Jul 8, 2026: $48,210, up 1.2%". Date and value are pre-formatted by the
 * caller (locale-deterministic lib helpers); changePct null drops the change
 * clause (the baseline point).
 */
export function scrubValueText(
  dateLabel: string,
  valueLabel: string,
  changePct: number | null,
): string {
  if (changePct === null) return `${dateLabel}: ${valueLabel}`;
  const magnitude = Math.abs(changePct).toFixed(1);
  const direction = changePct > 0 ? "up" : changePct < 0 ? "down" : "unchanged";
  const clause = direction === "unchanged" ? "unchanged" : `${direction} ${magnitude}%`;
  return `${dateLabel}: ${valueLabel}, ${clause}`;
}
