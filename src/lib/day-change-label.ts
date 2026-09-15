import { dayWindowLabel } from "@/lib/period";

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

/** The two closes a per-holding day move is measured between. */
export interface ClosePair {
  /** the newest close's day */
  quotedOn: string | null;
  /** the close before it — null when there is only one */
  previousQuotedOn: string | null;
}

export interface ClosesDayChange {
  /** the heading over the whole set: the one pair every item shares, else no date */
  heading: DayChangeLabel;
  /** aligned with the items: each one's own phrase when the heading names no date, else null */
  terms: (string | null)[];
}

/**
 * What to call a SET of per-holding day moves — the movers strip, the holdings
 * subtotal, the dashboard's top mover — each measured between its OWN two
 * newest closes.
 *
 * 🔴 Those surfaces were handed `PortfolioOverview.asOf`/`dayChangeVsDay`: the
 * PORTFOLIO's two covered days, which its series carries past the newest close.
 * Measured on the real ledger, Tue 2026-09-15: "Top movers · Today" over COKE's
 * +5.77%, a move between Fri Sep 11's and Mon Sep 14's closes, beside a header
 * reading "Today $0.00" — while COKE's own page dated the same +5.77% "Last
 * close · Sep 14 vs Sep 11". Same rule, wrong pair of days.
 *
 * The heading names a date only when `dayChangeLabel` gives every measured item
 * the same name, the split `priceColumnAge` makes for price dates. When the
 * names differ — stocks beside a coin quoted over the weekend, read the next
 * day — no single name is true of the set, so the heading claims none and each
 * item carries its own. An item without two closes has no figure to date: it
 * neither defeats the shared name nor gets one.
 *
 * ⛔ The same NAME, not the same raw pair. The rule calls any pair whose newest
 * close is today "Today", whatever close came before it. Keyed on the raw pair,
 * the real ledger read on Mon 2026-09-14 — nine stocks closed Fri→Mon, ETH
 * Sun→Mon, each alone "Today" — lost "Today" off the subtotal and printed
 * "today" on every item instead. The name is spelled in ISO days here, not
 * with `formatDay`: `formatDayShort` prints no year, and two years' "Sep 14"
 * are not one close.
 */
export function closesDayChange(
  items: readonly ClosePair[],
  today: string,
  formatDay: (iso: string) => string,
): ClosesDayChange {
  const measured = (p: ClosePair): p is { quotedOn: string; previousQuotedOn: string } =>
    p.quotedOn !== null && p.previousQuotedOn !== null;
  const isoDay = (iso: string): string => iso;
  const names = new Set(
    items.filter(measured).map((p) => dayChangeTerm(p.quotedOn, p.previousQuotedOn, today, isoDay)),
  );
  if (names.size <= 1) {
    const shared = items.find(measured);
    return {
      heading: dayChangeLabel(shared?.quotedOn ?? null, shared?.previousQuotedOn ?? null, today, formatDay),
      terms: items.map(() => null),
    };
  }
  return {
    heading: dayChangeLabel(null, null, today, formatDay),
    terms: items.map((p) => (measured(p) ? dayChangeTerm(p.quotedOn, p.previousQuotedOn, today, formatDay) : null)),
  };
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
  /*
   * ⛔ `dayWindowLabel`, not the raw keys. `/accounts/<id>` printed this clause
   * on the SAME LINE as a formatted one — "since Aug 12 +$211.71 as of
   * 2026-09-11 · derived" — and `AccountsTable` says the identical fact one
   * lens away through `formatDayLong`. One fact, two spellings, one screen.
   * Measured 2026-09-11 across all 197 routes.
   */
  return oldestAsOf
    ? `each as of its own last covered day, ${dayWindowLabel(oldestAsOf, asOf)}`
    : `as of ${dayWindowLabel(asOf, asOf)}`;
}
