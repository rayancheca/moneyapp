/**
 * How strongly a calendar day is tinted by the money that lands on it.
 *
 * The tint is what makes the month readable before a figure is parsed: heavy
 * outgoing days are deep and warm, quiet ones pale, money-in green. It is also
 * the one surface in this app that is generated at paint time from continuous
 * data, so its contrast cannot be checked by looking at a stylesheet — which is
 * exactly why the percentage lives here, as a number a test can reach, instead
 * of inline in the component.
 *
 * The ceiling is not taste. `calendar-heat.test` mixes the strongest tint this
 * function can return into the card surface and measures every foreground that
 * sits on a day cell against WCAG AA, in both themes. Raising `HEAT_RANGE_PCT`
 * without re-running it is how a legible grid becomes an unreadable one — the
 * first version of this shipped at 14% and dropped `--ink-faint` to 4.03:1 in
 * the dark theme, which the test caught and a screenshot never would have.
 *
 * ⚠️ `--ink-faint` is deliberately NOT on a tinted cell any more. It was the
 * binding foreground at every percentage — it is the app's dimmest AA-passing
 * ink, chosen against the three PLAIN surfaces, and it has nothing left to give
 * once a tone is mixed under it. The two places the cell used it (the "+N"
 * overflow count and the `unsettled` glyph) now take `--ink-muted`, which frees
 * the tint to be twice as strong as it could otherwise have been. The binding
 * constraint after that is the amount against its own hue — a red figure on a
 * red-tinted cell — which is why the ceiling is 12% and not more.
 *
 * Pure: no React, no DOM, no `Date`, no `Math.random`.
 */

/** Every day with activity is tinted at least this much, so it reads as raised. */
export const HEAT_BASE_PCT = 3;
/** …and the month's heaviest day reaches HEAT_BASE_PCT + this. */
export const HEAT_RANGE_PCT = 9;

/**
 * @param weight 0..1, the day's magnitude against the month's heaviest — already
 *               √-scaled by `dayWeight`, so the low end is separated rather than
 *               crushed against the floor.
 */
export function heatMixPercent(weight: number): number {
  const clamped = Math.min(1, Math.max(0, weight));
  return HEAT_BASE_PCT + HEAT_RANGE_PCT * clamped;
}
