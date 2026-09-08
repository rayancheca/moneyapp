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
  // vaguer word. `PortfolioOverview.dayChangeCents` is null in this case, so
  // both surfaces render an em dash under this label rather than a figure.
  if (asOf === null || vsDay === null) return { label: "Day change", interval: null };
  return { label: "Last close", interval: `${formatDay(asOf)} vs ${formatDay(vsDay)}` };
}

/**
 * The same rule, compacted to ONE trailing phrase, for surfaces that render the
 * figure inline instead of under a `<dt>` — the dashboard teaser reads
 * "+$481.18 (+0.49%) <term>".
 *
 * It lives here rather than inline at the call site for the reason stated above:
 * the dashboard's teaser is built from a fixture priced through its own fake
 * today, so a rendered test can only ever exercise the "today" branch. The
 * branch that matters — a term naming two past dates — is reachable only from a
 * unit test, and this module is inside the 100%-coverage gate.
 */
export function dayChangeTerm(
  asOf: string | null,
  vsDay: string | null,
  today: string,
  formatDay: (iso: string) => string,
): string {
  const { label, interval } = dayChangeLabel(asOf, vsDay, today, formatDay);
  // the interval IS the phrase when there is one; the label is a heading and
  // only reads as a trailing phrase in lower case
  return interval ?? label.toLowerCase();
}

/**
 * WHEN a group total is as of — one date, or the span its parts were read
 * across.
 *
 * 🔴 A THIRD SURFACE ANSWERING WITH NO DATE AT ALL. `InstitutionGroup.totalCents`
 * is the sum of each child's own last covered day, so on the owner's ledger
 * 2026-09-08 Chase came to $3,090.32 from $3,007.60 last seen Aug 14 and $82.72
 * last seen Sep 3. The dashboard's card says so ("each as of its own last
 * covered day, 2026-08-14 – 2026-09-03") and `/accounts`' table lens says so
 * ("so this is not one moment, and every row prints its own") — and
 * `/accounts`' CARDS lens, the third reader of the same service, printed
 * "Chase · net of what you owe · $3,090.32" with no date anywhere on it. It had
 * already copied the sibling clause beside it; this one it left behind.
 *
 * ⚠️ `oldestAsOf` is null when every child with a balance shares one day, which
 * is the only case where a single date is honest — see its own docstring.
 * Returns "" when nothing has a balance, so the caller adds no separator.
 */
export function asOfSpanTerm(asOf: string | null, oldestAsOf: string | null): string {
  if (asOf === null) return "";
  return oldestAsOf
    ? `each as of its own last covered day, ${oldestAsOf} – ${asOf}`
    : `as of ${asOf}`;
}
