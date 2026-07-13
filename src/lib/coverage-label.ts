/**
 * Honest, concise phrasing for a partial-coverage day on the net-worth chart.
 *
 * A partial day (not every active account has data) was previously always
 * annotated with the *missing* accounts — but early in the history only one or
 * two accounts existed, so a 2022 point listed seven missing accounts as noise.
 * When far fewer accounts are covered than missing, naming the covered ones
 * ("only Chase ····3522") is clearer and shorter; otherwise name the missing
 * ones ("no Robinhood Crypto, Venture X"). Pure presentation logic, shared by
 * the tooltip, the chart header, the hero, and the aria description.
 */

/** "SoFi Savings, Discover" or "SoFi Savings, Discover +2 more" — a compact, capped list. */
export function formatNameList(names: readonly string[], max = 2): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

export interface CoverageLabel {
  /** the display verb — canonical across EVERY surface (chip, header, hero, aria)
   *  so the wording can't drift: "only" names the few covered accounts,
   *  "missing" names the (fewer) uncovered ones. Render as `{kind} {text}`. */
  kind: "only" | "missing";
  /** the capped, formatted name list */
  text: string;
}

/**
 * Choose the most concise honest phrasing for a partial day. Returns null when
 * there is nothing to say (the day is fully covered). Ties and "few missing"
 * both keep the default direction (name the missing). The returned `kind` is the
 * literal word to render, so all surfaces stay word-for-word consistent.
 */
export function coverageLabel(
  covered: readonly string[],
  missing: readonly string[],
  max = 2,
): CoverageLabel | null {
  if (missing.length === 0) return null;
  if (covered.length > 0 && covered.length < missing.length) {
    return { kind: "only", text: formatNameList(covered, max) };
  }
  return { kind: "missing", text: formatNameList(missing, max) };
}
