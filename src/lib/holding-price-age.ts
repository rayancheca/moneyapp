/**
 * How old ONE holding's stored close is.
 *
 * /investments already discloses price staleness once, as a page-level note
 * (`holdingPriceSectionNotes` in ./section-notes.ts). That note is a single
 * sentence about the whole page, and it is gated on the NEWEST close: if any
 * one symbol was quoted today, the note goes silent — even when every other row
 * is a week old. That is correct for a one-sentence summary and it is precisely
 * the blind spot this module fills.
 *
 * ⚠️ So do NOT expect the note and these per-row dates to appear and disappear
 * together. They deliberately do not:
 *
 *   note   → gated on MAX(quotedOn) across the page   → one fresh row silences it
 *   row    → gated on THIS row's quotedOn             → says nothing about its neighbours
 *
 * The row date is what tells you WHICH holdings are stale, which a max-gated
 * sentence structurally cannot say. What the two DO share is the definition of
 * stale — `isStaleClose` below is the single predicate both call, so they can
 * never disagree about where the boundary is, only about which population they
 * apply it to.
 */

/**
 * Is a stored close older than today?
 *
 * `daysBetween` is injected rather than imported so this stays pure and
 * trivially testable, matching the existing `HoldingPriceNoteInput` contract.
 * A close dated in the FUTURE (a provider glitch, a bad backfill) is not stale
 * — it is not old, it is wrong, and reporting "-2 days ago" would be worse than
 * saying nothing.
 */
export function isStaleClose(
  quotedOn: string,
  today: string,
  daysBetween: (from: string, to: string) => number,
): boolean {
  return daysBetween(quotedOn, today) > 0;
}

/**
 * Do these holdings disagree about WHEN they were priced?
 *
 * This is the gate on printing per-row dates at all, and it is what keeps the
 * feature from becoming noise. When every holding carries the same close date —
 * the normal case, and the state of the owner's own portfolio today — the page
 * note already says so in one sentence ("Every position on this page still
 * carries its close from …"), and stamping that identical date onto all ten
 * rows would repeat it ten times in the one column that has to stay scannable.
 *
 * The rows earn their space only when they can say something the note cannot:
 * which holdings are behind, when they are not all behind together.
 *
 * Rows with no close at all are excluded — an unpriced holding already says
 * "no price" in this very cell, and letting it count as a disagreement would
 * turn every unpriced row into a reason to date all the others.
 */
export function priceDatesDiffer(rows: readonly { quotedOn: string | null }[]): boolean {
  const dates = new Set(rows.map((r) => r.quotedOn).filter((d): d is string => d !== null));
  return dates.size > 1;
}

/** The sub-line one holding row prints under its price. */
export interface HoldingPriceAge {
  /** visible text, e.g. "as of Aug 6" */
  text: string;
  /** the explanation behind it, for a title attribute */
  title: string;
}

/**
 * The price-age sub-line for one row, or null when there is nothing to say.
 *
 * Null in two cases, both of which are silence rather than a missing feature:
 *
 *   - `quotedOn === null` — the row has no close at all. That is the holdings
 *     table's own story and it already tells it, in the same cell, with a
 *     "no price" warning. Two labels for one condition is worse than one.
 *   - the close is not stale — a row quoted through today has no age to report,
 *     and stamping today's date on every row on a healthy day would be noise in
 *     the one column that has to stay scannable.
 *
 * The text is a DATE, never a word like "Today" or "Last close". Those belong
 * to the selection subtotal's bare label, which is bare precisely because a
 * selection can span rows quoted on different days. Per-row dates are the
 * disambiguation of that label, so they must not start competing with it.
 */
export function holdingPriceAge(
  quotedOn: string | null,
  today: string,
  daysBetween: (from: string, to: string) => number,
  formatDay: (iso: string) => string,
): HoldingPriceAge | null {
  if (quotedOn === null) return null;
  if (!isStaleClose(quotedOn, today, daysBetween)) return null;

  const days = daysBetween(quotedOn, today);
  return {
    text: `as of ${formatDay(quotedOn)}`,
    title:
      `Priced ${days} ${days === 1 ? "day" : "days"} ago. Market value here comes from a ` +
      `stored close, not a live quote — refresh prices to bring it up to date.`,
  };
}
