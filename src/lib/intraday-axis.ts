/**
 * ISO-8601 UTC instant → display label for the 1D view, and the whole
 * already-windowed session the chart draws instead of deriving one.
 *
 * WHY THIS FILE EXISTS AT ALL. `format-date.ts` turns 'YYYY-MM-DD' into text
 * with fixed name arrays and epoch-day math, and needs no timezone policy: a day
 * string carries no zone, so the same input yields the same output everywhere.
 * An INSTANT does not have that property. Rendering one as "9:30 AM" is a
 * choice of zone, and if that choice is left implicit it is made by whatever
 * machine happens to run the code.
 *
 * That failure mode is not hypothetical here and it is not visible locally: the
 * developer's machine resolves to America/New_York, the same zone a US market
 * axis wants. A host-dependent label therefore renders CORRECTLY on this box,
 * passes every visual baseline, and renders "1:35 PM" instead of "9:35 AM" the
 * first time it runs under a UTC runner. Measured, same code, only TZ changed:
 * 9:35 AM / 1:35 PM / 3:35 PM / 7:05 PM for New York / UTC / Berlin / Kolkata.
 *
 * So BOTH the zone and the locale are pinned explicitly below. That makes these
 * functions pure in the sense format-date.ts's header demands — same input, same
 * output, on any host — which is what licenses a client component to call them
 * and what makes SSR and hydration agree by construction. Verified across
 * TZ=UTC, Asia/Kolkata and Europe/Berlin: identical output.
 *
 * A FIXED UTC OFFSET IS NOT AN ACCEPTABLE SHORTCUT. 09:30 in New York is 13:30Z
 * in summer and 14:30Z in winter. Because `price_intraday` keeps only a couple
 * of sessions, an offset bug would be invisible in development until the DST
 * boundary, then wrong every winter. The IANA database already encodes the rule;
 * `Intl` reads it.
 *
 * Pure: no clock, no DB, no fetch, no ambient state.
 */

import { formatDayLong, formatDayShort } from "./format-date";
import type { DateTick } from "./chart-axis";

/** The market clock the axis is drawn in. A module constant, NOT an env var:
 *  Next.js inlines only NEXT_PUBLIC_* into client bundles, so an env read would
 *  be live on the server and undefined in the browser — reproducing the exact
 *  SSR/hydration split this file exists to prevent (see dates.ts's contract). */
const SESSION_TZ = "America/New_York";

/** Stated in the caption, because a time with no zone is a half-truth. */
export const SESSION_TZ_LABEL = "ET";

const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: SESSION_TZ,
  hour: "numeric",
  minute: "2-digit",
});

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: SESSION_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Instants are stored as `quoted_at`, always a full UTC ISO-8601 string. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class InstantParseError extends Error {
  constructor(value: string) {
    super(`Invalid ISO instant: ${JSON.stringify(value)}`);
    this.name = "InstantParseError";
  }
}

function asDate(at: string): Date {
  if (!INSTANT_RE.test(at)) throw new InstantParseError(at);
  return new Date(at);
}

/** "9:30 AM" — in the market's zone, never the host's. */
export function sessionTimeLabel(at: string): string {
  return TIME_FMT.format(asDate(at));
}

/**
 * The calendar day this instant falls on IN THE MARKET'S ZONE, as 'YYYY-MM-DD'.
 * Not the same as `at.slice(0, 10)`: 2026-07-31T00:00:00Z is July 30th in New
 * York. That difference is exactly why the axis has to ask.
 */
export function sessionDayOf(at: string): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of DATE_FMT.formatToParts(asDate(at))) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** A point on the intraday line. `day` holds the INSTANT (it is the chart's
 *  category identity); `atLabel` is the human reading of that instant. */
export interface SessionPoint {
  day: string;
  valueCents: number;
  atLabel: string;
}

export interface SessionChartView {
  /** already windowed — one session IS the window, so nothing derives it */
  points: SessionPoint[];
  /** same shape dateAxisTicks returns, so the chart's tick plumbing is untouched */
  ticks: DateTick[];
  /** true when the line provably starts at the previous close rather than at the
   *  first print, so the caption can say which baseline the delta is against */
  opensAtPrevClose: boolean;
  fromLabel: string;
  toLabel: string;
}

/**
 * How many labels fit across the plot at the narrowest supported width (440px,
 * the owner's own phone).
 *
 * A date-prefixed label ("Jul 30 8:00 PM") is about twice the width of a bare
 * one ("8:00 PM"), so a session that spans two ET days gets fewer of them.
 * Measured at 440px: six prefixed labels run together into an unreadable smear.
 */
const TARGET_TICKS = 6;
const TARGET_TICKS_PREFIXED = 4;

/**
 * How far in from each end the outermost tick sits, as a fraction of the series.
 *
 * recharts centres a tick label on its category, and the first category sits
 * ~6px from the plot's left edge — so a label wider than ~12px loses its left
 * half off the side of the chart. A daily axis gets away with it ("Jul 1" is
 * narrow); an intraday one does not, and "Prev close" rendered as "v close".
 *
 * Insetting is the cheap fix. The alternative — a custom tick component that
 * anchors the end labels inward — would change the shared XAxis that all six
 * daily surfaces render, and move 143 visual baselines to solve a problem only
 * this view has. Nothing is lost by it: the session's true start and end are
 * stated in words by the caption right below the chart.
 */
const EDGE_INSET = 0.06;

/** Evenly spaced indices, inset from both ends; deduped so a short session
 *  cannot emit the same tick twice. */
function sampleIndices(n: number, target: number): number[] {
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const inset = Math.ceil(n * EDGE_INSET);
  const lo = inset;
  const hi = n - 1 - inset;
  const out: number[] = [];
  for (let k = 0; k < target; k++) out.push(lo + Math.round((k * (hi - lo)) / (target - 1)));
  return [...new Set(out)];
}

const PREV_CLOSE_LABEL = "Previous close";
const PREV_CLOSE_TICK = "Prev close";

/**
 * Turn one day's grid into everything the chart needs to draw it.
 *
 * THE PREPENDED ANCHOR IS THE POINT OF THIS FUNCTION. `intradayPortfolioGrid`
 * builds its time axis from the union of instants that actually ticked, so for
 * an equities-only book the first grid point is the OPENING print — the
 * overnight gap is simply not drawn, and "the day's move" silently means "the
 * move since the open". Measured: a book whose prior close was $200 and which
 * opened at $210 produced a first point of $210.
 *
 * So when a prior close is known and the session does not already begin at
 * midnight UTC, one synthetic point is prepended at the day's start carrying the
 * previous close. That makes slice[0] the previous close — which is also what
 * ScrubChart already draws as its dotted baseline reference line, so the
 * "previous close" line every broker shows comes for free — and makes the
 * header delta mean "since yesterday's close", the only baseline a day view can
 * honestly claim.
 *
 * When there is no prior close the anchor is omitted rather than invented, and
 * `opensAtPrevClose` is false so the caption says "measured from the first
 * print" instead of implying a baseline that does not exist.
 */
export function sessionView(
  day: string,
  grid: readonly { at: string; valueCents: number }[],
  priorCloseCents: number | null,
): SessionChartView | null {
  if (grid.length === 0) return null;

  const dayStart = `${day}T00:00:00.000Z`;
  const opensAtPrevClose = priorCloseCents !== null && grid[0]!.at > dayStart;

  // The multi-day test runs over the REAL ticks only. The synthetic anchor sits
  // at midnight UTC, which is the previous EVENING in New York, so including it
  // would make every ordinary equities session look like it spanned two days.
  const firstRealDay = sessionDayOf(grid[0]!.at);
  const spansDays = firstRealDay !== sessionDayOf(grid[grid.length - 1]!.at);

  const labelFor = (at: string): string => {
    const time = sessionTimeLabel(at);
    // A crypto book's session is a UTC day, which in ET begins at 8:00 PM the
    // previous evening. Prefixing the date is the only way the axis cannot be
    // misread as one continuous clock.
    return spansDays ? `${formatDayShort(sessionDayOf(at))} ${time}` : time;
  };

  const points: SessionPoint[] = grid.map((p) => ({
    day: p.at,
    valueCents: p.valueCents,
    atLabel: `${formatDayLong(sessionDayOf(p.at))} · ${sessionTimeLabel(p.at)}`,
  }));

  if (opensAtPrevClose) {
    points.unshift({ day: dayStart, valueCents: priorCloseCents, atLabel: PREV_CLOSE_LABEL });
  }

  const target = spansDays ? TARGET_TICKS_PREFIXED : TARGET_TICKS;
  const ticks: DateTick[] = sampleIndices(points.length, target).map((i) => {
    const p = points[i]!;
    return {
      day: p.day,
      label: opensAtPrevClose && i === 0 ? PREV_CLOSE_TICK : labelFor(p.day),
    };
  });

  return {
    points,
    ticks,
    opensAtPrevClose,
    // date-prefixed on a two-ET-day session, exactly like the axis: a caption
    // reading "8:00 PM – 7:55 PM" describes a span that appears to run backwards
    fromLabel: labelFor(grid[0]!.at),
    toLabel: labelFor(grid[grid.length - 1]!.at),
  };
}

interface SummarizablePoint {
  day: string;
  valueCents: number | null;
}

/**
 * The window summary for ONE session: a plain value delta between two indices.
 *
 * The portfolio's daily summary is deliberately flow-adjusted — it compounds
 * per-day returns out of `returnDays` so a mid-window deposit cannot masquerade
 * as a gain. That machinery cannot be pointed at a session, and the way it fails
 * is silent rather than loud: it selects its days with `d.day >= from`, and once
 * `from` is an INSTANT the string comparison makes `"2026-07-08"` sort BEFORE
 * `"2026-07-08T00:00:00.000Z"`, so the filter matches nothing, the aggregate is
 * empty, and the header confidently reports $0.00 (+0.00%) over a line that
 * visibly moved. No exception, no crash — just a wrong number.
 *
 * Within a single day there is nothing to flow-adjust anyway: cash flows are
 * recorded per DAY, so there is no instant to attribute one to. The honest
 * summary is the move from the window's first point — which, when a prior close
 * is known, is yesterday's close.
 */
export function sessionSummarize(
  startIdx: number,
  endIdx: number,
  slice: readonly SummarizablePoint[],
): { day: string; valueCents: number; deltaCents: number; deltaPct: number | null } {
  const start = slice[startIdx]?.valueCents ?? 0;
  const end = slice[endIdx]?.valueCents ?? 0;
  const deltaCents = end - start;
  return {
    day: slice[endIdx]?.day ?? "",
    valueCents: end,
    deltaCents,
    deltaPct: start === 0 ? null : (deltaCents / start) * 100,
  };
}
