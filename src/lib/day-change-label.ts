/**
 * What to call the portfolio's day-change figure.
 *
 * The figure is always the flow-adjusted move from one covered day to the next
 * — never "today" unless the newest covered day IS today. Between price
 * refreshes it is neither: on the real ledger the newest close trailed today by
 * a week, so a header reading "Today" asserted that a move measured between
 * Aug 5 and Aug 6 happened on Aug 13, directly contradicting the price-age note
 * rendered a few elements above it.
 *
 * Extracted from the component deliberately. The e2e fixture is seeded priced
 * through its own fake today, so the stale branch — the only one that was ever
 * wrong — cannot render in any Playwright run, and a component-level assertion
 * would pass identically with or without the fix. Behaviour that no rendered
 * test can reach has to be pulled somewhere a unit test can execute it.
 */
export interface DayChangeLabel {
  /** the <dt> text */
  label: string;
  /** the dated sub-line, or null when the figure really is today's */
  interval: string | null;
}

export function dayChangeLabel(
  /** newest covered day (`PortfolioOverview.asOf`) */
  asOf: string | null,
  /** the day it is measured against (`PortfolioOverview.dayChangeVsDay`) */
  vsDay: string | null,
  today: string,
  formatDay: (iso: string) => string,
): DayChangeLabel {
  if (asOf !== null && asOf === today) return { label: "Today", interval: null };
  // No covered days at all, or a single one: there is no interval to name, and
  // naming a date the figure was not measured over would be worse than the
  // vaguer word. The figure itself is already 0 / "—" in that case.
  if (asOf === null || vsDay === null) return { label: "Day change", interval: null };
  return { label: "Last close", interval: `${formatDay(asOf)} vs ${formatDay(vsDay)}` };
}
