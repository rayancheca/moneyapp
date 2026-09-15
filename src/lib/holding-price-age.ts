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
 * The newest close any of these holdings was quoted on; null when none is
 * priced. An unpriced row is neither the newest close nor a reason to doubt it.
 *
 * The page note's gate (`holdingPriceSectionNotes`) and the 1D note's "since the
 * close on …" (`sinceCloseClause`) read it. 🔴 The second was handed
 * `PortfolioOverview.asOf` instead — the series' newest day, which
 * `rebuildInvestmentHistory` carries to today whatever the newest close.
 * Measured on the real ledger, Tue 2026-09-15: every held close is Mon Sep 14,
 * and /investments' 1D note read "this is the change within today's own close".
 */
export function newestQuotedOn(rows: readonly { quotedOn: string | null }[]): string | null {
  return rows.reduce<string | null>(
    (newest, r) => (r.quotedOn !== null && (newest === null || r.quotedOn > newest) ? r.quotedOn : newest),
    null,
  );
}

/** The sub-line printed under a price — under one row's, or under the column's. */
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

/** Where a holdings table prints price age: on the column, or on the rows. */
export interface PriceColumnAge {
  /** under the "Price" column header — the close date that describes EVERY priced row */
  readonly header: HoldingPriceAge | null;
  /** under one row's price — only when the header cannot speak for it */
  readonly row: (quotedOn: string | null) => HoldingPriceAge | null;
}

/**
 * Decide, for a whole holdings table at once, WHERE price age gets stated.
 *
 * The rule is one sentence: **a fact about every row belongs to the column, and
 * a fact about one row belongs to that row.**
 *
 *   every priced row shares one close → the COLUMN HEADER carries the date
 *   the rows disagree                 → each stale ROW carries its own
 *
 * Both surfaces are returned from this one call for the reason pass 50
 * established for the budget verdict: two independent gates over the same facts
 * drift, and the two failure modes here are opposite and both bad. If both
 * spoke, the owner's ten holdings would print one date eleven times. If neither
 * spoke — which is what pass 56 shipped, because the per-row gate suppressed
 * itself precisely when every row agreed and left the fact to a page note the
 * account-detail page does not even have — then a uniformly stale portfolio
 * discloses its age nowhere near the numbers. Returning both from one branch
 * makes "both" and "neither" unrepresentable rather than merely untested.
 *
 * This supersedes the `priceDatesDiffer` gate. That predicate answered "may the
 * rows speak?", which is the right question only if the rows are the only place
 * that can. The column header is the better place: it is adjacent to the very
 * numbers it qualifies, it costs one line instead of ten, and it is always on.
 *
 * A close dated today is silent in both positions — `holdingPriceAge` decides
 * that, once, so the header and the rows share the definition of stale with
 * each other AND with `holdingPriceSectionNotes`.
 *
 * Unpriced rows are excluded from the shared-date test rather than defeating
 * it: a holding with no close already prints "no price" in this very cell, and
 * letting it count as a disagreement would turn one unpriced row into a reason
 * to date every other one individually.
 */
export function priceColumnAge(
  rows: readonly { quotedOn: string | null }[],
  today: string,
  daysBetween: (from: string, to: string) => number,
  formatDay: (iso: string) => string,
): PriceColumnAge {
  const age = (quotedOn: string | null): HoldingPriceAge | null =>
    holdingPriceAge(quotedOn, today, daysBetween, formatDay);

  const dates = new Set(rows.map((r) => r.quotedOn).filter((d): d is string => d !== null));
  const shared = dates.size === 1 ? [...dates][0]! : null;

  return shared === null
    ? { header: null, row: age }
    : { header: age(shared), row: () => null };
}
