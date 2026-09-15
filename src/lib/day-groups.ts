/**
 * Day grouping for a ledger shown one slice at a time — the `/transactions`
 * pages, and the `/design/stage-0a` preview's first rows.
 *
 * ⛔ Not in `TransactionsLedger.tsx`, where these lived. That module is
 * `"use client"`, and a server page importing from it receives client
 * references rather than functions — which is how stage-0a came to carry its
 * own copy of `groupByDay`, one with no boundary argument at all.
 */

/** the two facts grouping reads off a row */
export interface DayRow {
  postedOn: string;
  amountCents: number;
}

export interface DayGroup<R extends DayRow = DayRow> {
  day: string;
  label: string;
  netCents: number;
  rows: R[];
  /** the day is cut by a page boundary — netCents covers THIS page's rows only */
  partial: boolean;
}

/** what the page boundary hides on either side of the rows we were handed */
export interface DayGroupBoundary {
  hiddenBefore?: boolean;
  hiddenAfter?: boolean;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

/**
 * Group consecutive rows by posted day. Rows arrive one PAGE at a time, so a day
 * split across a page boundary is only partly here — its subtotal would silently
 * omit the rest. The boundary-touching groups are flagged `partial` and the
 * header says so, rather than presenting a wrong day total as a fact.
 */
export function groupByDay<R extends DayRow>(rows: readonly R[], boundary: DayGroupBoundary = {}): DayGroup<R>[] {
  const groups: DayGroup<R>[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.day === row.postedOn) {
      last.rows.push(row);
      last.netCents += row.amountCents;
    } else {
      groups.push({
        day: row.postedOn,
        label: DAY_FORMAT.format(new Date(`${row.postedOn}T12:00:00`)),
        netCents: row.amountCents,
        rows: [row],
        partial: false,
      });
    }
  }
  const first = groups[0];
  const last = groups.at(-1);
  if (first && boundary.hiddenBefore) first.partial = true;
  if (last && boundary.hiddenAfter) last.partial = true;
  return groups;
}

/**
 * What the page boundary CUTS on either side of one page of rows.
 *
 * The offset has to come from `pageSize`, not from `rows.length`: they agree on
 * every page but the LAST, where a short page makes `page * rows.length`
 * collapse far below the total and flag the final day as cut when nothing
 * follows it (157 rows, page 4 of 4 holding 7 → 4 * 7 = 28 < 157 → a "partial"
 * tag on the last day of the ledger, which is the common case rather than an
 * edge one). Counting the rows actually consumed — `(page - 1) * pageSize +
 * rows.length` — is exact in both directions.
 *
 * 🔴 …AND "THERE ARE MORE ROWS" IS NOT "THIS DAY IS CUT". `hiddenBefore` was a
 * plain `page > 1` and `hiddenAfter` a plain "rows remain", so both edges were
 * flagged whenever a neighbouring page existed — whatever day it started on.
 * When a boundary lands exactly on a day change, neither day is cut and both
 * subtotals are exact, and the header called them "partial" anyway over a
 * tooltip asserting "This day is cut by the page boundary".
 *
 * Measured on the owner's ledger 2026-09-10, unfiltered: **31 of the 203 page
 * boundaries land on a day change, so 62 day headers carried the tag over a
 * subtotal that was complete.** Page 3 ends on 2026-07-30 and page 4 opens on
 * 2026-07-29 — all 21 of that day's rows are on page 4, its header reads
 * "+$3,948.91 · partial", and the ledger's own total for 2026-07-29 is
 * $3,948.91 to the cent.
 *
 * ⛔ The old docstring said the previous page's last day is "genuinely not
 * knowable from this page's rows" — true, and the wrong place to look. The
 * SERVER slices the page and can read the row on either side of the cut for the
 * price of two indexed lookups; `neighbourDays` is that measurement, and this
 * compares it with the days actually on the page. Knowable beats hedged, and a
 * hedge printed as a certainty is worse than either.
 */
export function pageBoundary({
  page,
  pageSize,
  rowsOnPage,
  totalMatching,
  firstDayOnPage,
  lastDayOnPage,
  previousDay,
  nextDay,
}: {
  page: number;
  pageSize: number;
  rowsOnPage: number;
  totalMatching: number;
  /** the days at this page's two ends — null when the page holds no rows */
  firstDayOnPage: string | null;
  lastDayOnPage: string | null;
  /** the day of the row immediately before/after this page, null when there is none */
  previousDay: string | null;
  nextDay: string | null;
}): DayGroupBoundary {
  const consumedBefore = (page - 1) * pageSize;
  return {
    hiddenBefore: consumedBefore > 0 && firstDayOnPage !== null && previousDay === firstDayOnPage,
    hiddenAfter:
      consumedBefore + rowsOnPage < totalMatching && lastDayOnPage !== null && nextDay === lastDayOnPage,
  };
}

/**
 * The first `pageSize` rows as day groups, for a surface that shows a fixed
 * number of rows and has no pager — page 1 of a ledger paged by `pageSize`, so
 * it takes that ledger's rule rather than a rule of its own.
 *
 * 🔴 `/design/stage-0a` fetched exactly 14 rows and could not know whether the
 * 15th continued the last day. Measured on the owner's ledger 2026-09-15: rows
 * 13–14 are the only 2026-08-25 rows shown and sum +99,938¢, so the header read
 * "+$999.38" with no tag; row 15 is also 2026-08-25, and the whole day — 5
 * active checking rows — nets −51,952¢.
 *
 * Hand it ONE ROW MORE than it shows. That row is page 2's first, and whether it
 * shares the last shown row's day is the whole question `pageBoundary` asks.
 */
export function groupFirstPageByDay<R extends DayRow>(fetched: readonly R[], pageSize: number): DayGroup<R>[] {
  const rows = fetched.slice(0, pageSize);
  return groupByDay(
    rows,
    pageBoundary({
      page: 1,
      pageSize,
      rowsOnPage: rows.length,
      totalMatching: fetched.length,
      firstDayOnPage: rows[0]?.postedOn ?? null,
      lastDayOnPage: rows.at(-1)?.postedOn ?? null,
      previousDay: null,
      nextDay: fetched[pageSize]?.postedOn ?? null,
    }),
  );
}
