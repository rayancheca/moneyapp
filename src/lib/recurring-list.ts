/**
 * /recurring's All tab narrowed to the series a link names — the drill-down contract for a figure made of schedules:
 * a link opens exactly the rows behind its number. Written (`seriesListHref`) and read back (`namedSeriesOf`) here,
 * so neither the link nor the page spells the param alone. Pure, so the client tab strip can drop it too.
 *
 * 🔴 A rate summed from more than one pay schedule linked to a bare `/recurring?tab=all` — every series the ledger
 * lists, the bills among them and any schedule that stopped paying, beside the ones the rate is summed from (review
 * of the dashboard links, 2026-10-12). Latent on his ledger copy 2026-10-13: one schedule, It America LLC weekly pay,
 * whose own page the link opens; that bare list holds 14 series there, 13 of them bills and subscriptions.
 */

/** `?series=` — the ids of the series a link narrows the All tab to, comma-joined (a UUIDv7 holds no comma) */
export const SERIES_LIST_PARAM = "series";

/** the All tab with nothing narrowing it — where a narrowed tab's "Show all" goes */
export const ALL_SERIES_HREF = "/recurring?tab=all";

/** an id as the ledger writes one; anything else in the param is a typed or mangled URL, and narrows nothing */
const SERIES_ID = /^[0-9A-Za-z-]{1,64}$/;

/** The All tab, narrowed to these series, in the order given; naming none is the whole tab. */
export function seriesListHref(ids: readonly string[]): string {
  return ids.length === 0 ? ALL_SERIES_HREF : `${ALL_SERIES_HREF}&${SERIES_LIST_PARAM}=${ids.join(",")}`;
}

/**
 * Where a figure summed from series is checked: one series opens its own page, more than one the All tab narrowed to
 * exactly them (`seriesListHref`). ⛔ ONE rule for every such link — the earn row's schedules (`incomeBasisHref`), the
 * car card's lines and the subscriptions card's series. 🔴 Both cards' header links opened a bare `/recurring` over
 * figures summed from their series — on his ledger copy 2026-10-13 the Upcoming tab's every series, his pay among them
 * (review of the dashboard links).
 */
export function seriesBehindHref(ids: readonly string[]): string {
  return ids.length === 1 ? `/recurring/${ids[0]}` : seriesListHref(ids);
}

/** The series a `?series=` value names, or null when it names none — the whole tab. */
export function namedSeriesOf(value: string | null): ReadonlySet<string> | null {
  if (value === null) return null;
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => SERIES_ID.test(id));
  return ids.length === 0 ? null : new Set(ids);
}

/**
 * The All tab's own population — what its badge counts and what its sections can hold: every series not dismissed
 * and not ended. ⛔ One rule for the badge, the empty state and the narrowed count, so "2 of 14" counts the 14 the
 * badge beside it prints.
 */
export function isListedSeries(series: { status: string }): boolean {
  return series.status !== "dismissed" && series.status !== "ended";
}

/** How much of the All tab a link left on screen: `shown` of the tab's `of`. */
export interface SeriesNarrowing {
  shown: number;
  of: number;
}

export interface SeriesListed<T> {
  /** the rows the tab is handed */
  rows: T[];
  /** null when no link narrowed it */
  narrowed: SeriesNarrowing | null;
}

/** What the All tab lists for the series a link named (`namedSeriesOf`), or every series when it named none. */
export function seriesListed<T extends { id: string; status: string }>(
  series: readonly T[],
  named: ReadonlySet<string> | null,
): SeriesListed<T> {
  if (named === null) return { rows: [...series], narrowed: null };
  const rows = series.filter((s) => named.has(s.id));
  return {
    rows,
    narrowed: { shown: rows.filter(isListedSeries).length, of: series.filter(isListedSeries).length },
  };
}

/**
 * The line over a narrowed All tab. Every link that narrows it today stands over a figure (`seriesBehindHref`: the
 * earn row's schedules, the car and subscriptions cards' series), so the line names the figure rather than a filter.
 * ⛔ Never "Showing 0 of 14" over an empty tab.
 */
export function seriesFilterSentence({ shown, of }: SeriesNarrowing): string {
  return shown === 0
    ? "None of the series behind the figure you followed is listed any more."
    : `Showing ${shown} of ${of} series — the ones behind the figure you followed.`;
}
