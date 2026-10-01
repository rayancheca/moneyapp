import type { SeriesKind } from "@/db/schema/recurring";
import { seriesIsIncomeOrSpending } from "./series-kind";

/**
 * The month as a RUNNING TOTAL — what the recurring schedule does to his money
 * between the 1st and the 31st.
 *
 * The grid answers "what happens on the 10th". It cannot answer "am I ahead or
 * behind by the 20th", because that is a question about accumulation and a grid
 * has no accumulating axis — its second dimension is weeks. The owner's
 * complaint was that he could *"barely understand"* the calendar, and this is
 * the piece that was missing rather than badly drawn: seven columns of isolated
 * events, and nowhere the month adds up.
 *
 * So the strip above the grid carries the cumulative net, day by day, on one
 * continuous horizontal axis. Rent leaving on the 9th is a cliff; a payday on
 * the 27th is a step back up; the closing figure is where the month lands.
 *
 * Pure geometry, in normalized 0..1 space so the renderer owns every pixel: no
 * React, no DOM, no `Date`, no `Math.random`.
 */

export interface MonthFlowEntry {
  /** net-worth-signed: negative leaves, positive arrives */
  amountCents: number;
  /**
   * Whether this is a POSTED transaction rather than an expected occurrence.
   *
   * Load-bearing, and added after looking at the first version on real data.
   * That one split the line at TODAY and drew everything behind it solid — so
   * August 2026 showed a confident line climbing to +$3,141 while the footer
   * directly beneath it read "SETTLED $0.00". Every one of those paydays was an
   * unbanked cash occurrence that has not reached the ledger. A line that says
   * money arrived because the date has passed is the same error as a calendar
   * that says a bill was missed because a charge is absent.
   */
  settled: boolean;
}

/**
 * What one calendar mark adds to the two running totals: a mark that settled
 * adds what it settled to both, one that has not adds its expected amount to
 * the scheduled line only.
 *
 * ⛔ ONE READING, shared with the footer under the strip: `settledCents` is the
 * figure the month's Settled total sums, so the posted line ends on it by
 * construction rather than by a second rule that happens to agree.
 *
 * 🔴 The strip read the mark's AMOUNT on both lines, which counted pay twice
 * wherever a deposit paid a payday drawn on another day. A payday chip paid by
 * a lump in the same month added its week to "as scheduled" while the lump's
 * row added the same money again. Measured on a copy of his ledger 2026-10-01:
 * September 2026 — Sep 3, 10 and 17 chipped "paid by the deposit of Sep 23"
 * beside that $4,567.68 row — put $9,135.36 of pay, eight weeks, into the
 * "as scheduled" figure of a month with four paydays.
 *
 * ⚖️ AND A TRANSFER ADDS NOTHING, posted or expected: money moving between his own accounts is never income or
 * spending (`seriesIsIncomeOrSpending`, the rule the forecast card's net applies). The grid still draws its mark —
 * a real scheduled movement — and the Day Sheet says "$0.00 counted on this day" under its amount.
 *
 * 🔴 Read whole, a one-legged transfer series (the card autopay out of checking, no PAYMENT THANK YOU imported to
 * cancel it) put its whole amount into "as scheduled" directly under a card whose net left it out: the synthetic
 * Chase autopay beside a $1,800.00 rent read -$2,793.02 on August's strip under a card reading -$1,800.00.
 */
export function flowEntryOf(mark: {
  kind: SeriesKind;
  amountCents: number;
  settledCents: number | null;
}): MonthFlowEntry {
  const settled = mark.settledCents !== null;
  if (!seriesIsIncomeOrSpending(mark.kind)) return { amountCents: 0, settled };
  return mark.settledCents === null
    ? { amountCents: mark.amountCents, settled: false }
    : { amountCents: mark.settledCents, settled: true };
}

export interface MonthFlowPoint {
  /** 1-based day of month */
  day: number;
  iso: string;
  /** running total of EVERYTHING the schedule says, through this day */
  scheduledCents: number;
  /** running total of what has actually POSTED, through this day */
  settledCents: number;
  /** 0 at the left edge, 1 at the right */
  x: number;
  /** 0 at the TOP (SVG convention), 1 at the bottom */
  yScheduled: number;
  ySettled: number;
  /** on or after `today` — the part of the line that is still a forecast */
  isFuture: boolean;
}

export interface MonthFlow {
  points: MonthFlowPoint[];
  /** where zero sits on the same 0..1 axis as `y`, for the baseline rule */
  zeroY: number;
  /** the month's closing total as SCHEDULED */
  endCents: number;
  /** what has actually posted so far — the honest half of the pair */
  settledCents: number;
  /** the lowest and highest the running total gets — the axis, in cents */
  lowCents: number;
  highCents: number;
  /** the deepest point of the month, for the "lowest ebb" annotation */
  troughIndex: number;
  /**
   * False when nothing moves all month. The renderer draws NOTHING then rather
   * than a flat line across the middle: a horizontal rule at zero looks exactly
   * like a rendering failure, and pass 30 shipped a header reading "$0.00" over
   * a live session for want of this distinction.
   */
  hasMovement: boolean;
  /**
   * Index of the last point on or before today, or -1 when the whole month is
   * still ahead. The SETTLED line stops here — past today there is nothing to
   * have posted yet, so continuing it would draw a flat run that reads as "and
   * then nothing else arrived" rather than "and then we stop knowing".
   */
  lastSettledIndex: number;
  /**
   * True when the running total ever goes BELOW where the month started.
   *
   * The trough is only worth annotating when there is one. On a month that only
   * climbs, the lowest point is day 1 at zero — and the first version dutifully
   * printed "Lowest on Aug 1 at $0.00", which is both trivially true and
   * useless.
   */
  dips: boolean;
}

/**
 * A little headroom above and below the extremes so the line never touches the
 * strip's edges — a stroke drawn exactly on the boundary is half-clipped, and at
 * 1.5px that reads as a thinner segment rather than as an extreme.
 */
const PAD = 0.12;

/**
 * @param daysInMonth  how many days the month has (28–31)
 * @param monthKey     "YYYY-MM", used only to build each point's iso date
 * @param entriesByDay iso date → that day's entries, any of which may be absent
 * @param today        iso date; days on or after it are forecast
 */
export function monthFlow(
  daysInMonth: number,
  monthKey: string,
  entriesByDay: Readonly<Record<string, readonly MonthFlowEntry[]>>,
  today: string,
): MonthFlow {
  interface Raw {
    day: number;
    iso: string;
    scheduledCents: number;
    settledCents: number;
    x: number;
    isFuture: boolean;
  }

  const raw: Raw[] = [];
  let scheduled = 0;
  let settled = 0;
  let low = 0;
  let high = 0;
  let moved = false;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${monthKey}-${String(day).padStart(2, "0")}`;
    for (const e of entriesByDay[iso] ?? []) {
      scheduled += e.amountCents;
      if (e.settled) settled += e.amountCents;
      if (e.amountCents !== 0) moved = true;
    }
    const isFuture = iso >= today;
    // The axis has to hold BOTH series, or one of them clips.
    for (const v of isFuture ? [scheduled] : [scheduled, settled]) {
      if (v < low) low = v;
      if (v > high) high = v;
    }
    raw.push({
      day,
      iso,
      scheduledCents: scheduled,
      settledCents: settled,
      // Spread across the FULL width: the first point sits on the left edge and
      // the last on the right, so the strip's x-axis lines up with the reader's
      // sense of "start of month" to "end of month".
      x: daysInMonth === 1 ? 0 : (day - 1) / (daysInMonth - 1),
      isFuture,
    });
  }

  // Second pass for y: the axis is not known until every point is walked.
  const span = high - low;
  const toY = (cents: number): number =>
    span === 0 ? 0.5 : PAD + (1 - 2 * PAD) * (1 - (cents - low) / span);
  const points: MonthFlowPoint[] = raw.map((p) => ({
    ...p,
    yScheduled: toY(p.scheduledCents),
    ySettled: toY(p.settledCents),
  }));

  let troughIndex = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.scheduledCents < points[troughIndex]!.scheduledCents) troughIndex = i;
  }

  let lastSettledIndex = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (!points[i]!.isFuture) lastSettledIndex = i;
  }

  return {
    points,
    zeroY: toY(0),
    endCents: scheduled,
    settledCents: settled,
    lowCents: low,
    highCents: high,
    troughIndex,
    hasMovement: moved,
    lastSettledIndex,
    dips: low < 0,
  };
}

/** Which of a point's two running totals a line is drawing. */
export type FlowSeries = "scheduled" | "settled";

const yOf = (p: MonthFlowPoint, series: FlowSeries): number =>
  series === "settled" ? p.ySettled : p.yScheduled;

/** An SVG polyline `points` attribute over a `width`×`height` box. */
export function flowPolyline(
  points: readonly MonthFlowPoint[],
  width: number,
  height: number,
  series: FlowSeries = "scheduled",
): string {
  return points
    .map((p) => `${(p.x * width).toFixed(2)},${(yOf(p, series) * height).toFixed(2)}`)
    .join(" ");
}

/**
 * The same line closed down to the zero rule, so it can be filled.
 *
 * Closed to ZERO rather than to the bottom edge: the fill then means "distance
 * from where the month started", which is the quantity the line is about. A fill
 * dropped to the floor would shade the axis padding too and imply the month lost
 * more than it did.
 */
export function flowArea(
  points: readonly MonthFlowPoint[],
  zeroY: number,
  width: number,
  height: number,
  series: FlowSeries = "scheduled",
): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const base = (zeroY * height).toFixed(2);
  const line = points
    .map((p) => `L${(p.x * width).toFixed(2)},${(yOf(p, series) * height).toFixed(2)}`)
    .join("");
  return `M${(first.x * width).toFixed(2)},${base}${line}L${(last.x * width).toFixed(2)},${base}Z`;
}
