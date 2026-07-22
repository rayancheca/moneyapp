"use client";

import { useMemo, type ReactNode } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ChartRangePills } from "@/components/charts/ChartRangePills";
import { hasEstimatedDay, windowedPoints } from "@/lib/chart-window";
import { rangeLabel, type ChartRange } from "@/lib/chart-range";
import { formatDayLong } from "@/lib/format-date";
import type { ScrubPoint, ScrubSummary } from "@/components/investments/ScrubChart";

/**
 * The TABLE lens for a ScrubChart panel (chart-parity pass 23, roadmap #2) —
 * the same dataset, the same window, the same header, as rows.
 *
 * It cannot drift from the chart by construction: it slices with the SAME pure
 * `windowedPoints` the chart uses (including the <2-point fallback to the full
 * series), formats with the SAME `formatValue` function object, and renders the
 * panel's OWN `renderHeader` fed by the panel's OWN `summarize` — so the hero
 * value and delta above the rows are literally the numbers the chart just
 * showed. Only the drawing changes.
 *
 * The range pills come along (a table that respects a window it cannot change
 * is a dead end), and the caption states the window honestly — including when
 * the requested range held too little data and the full series is on screen
 * instead, which is the one case a naive caption would lie about.
 *
 * Note: a drag-zoom window belongs to the ScrubChart, which unmounts here, so
 * switching to the table drops a custom window back to the active range pill.
 * The range itself is owned by ChartFocus and survives the round trip.
 */

export interface ScrubTableRow {
  key: string;
  point: ScrubPoint;
}

interface ScrubTableProps {
  /** the FULL series — this slices it exactly like the chart does */
  points: readonly ScrubPoint[];
  today: string;
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  /** the panel's own window summarize — feeds the shared header */
  summarize: (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]) => ScrubSummary;
  /** the panel's own header renderer, so the readout is identical to the chart's */
  renderHeader: (
    summary: ScrubSummary,
    scrubbing: boolean,
    range: ChartRange,
    customWindow: { start: string; end: string } | null,
  ) => ReactNode;
  /** the panel's own value formatter ($ / signed $ / %) */
  formatValue: (cents: number) => string;
  /** header for the value column, e.g. "Balance" | "Value" | "Close" | "Return" */
  valueHeader: string;
  /** what these rows ARE, e.g. "Balance by day" — the caption's opening clause */
  subject: string;
  /** appended after Day + value (basis, trades) — must be data the chart states too */
  extraColumns?: readonly Column<ScrubTableRow>[];
  emptyState: string;
  /** the pill row's container classes, matching the chart's own spacing */
  pillsClassName?: string;
  /**
   * Set when the caller supplies its OWN completeness column (Balance names the
   * exact basis — estimated / carried forward / gap). Otherwise this table adds
   * a generic one automatically whenever the window holds an incomplete day.
   */
  ownsCompleteness?: boolean;
}

/**
 * `complete: false` is what the chart draws DASHED (a carried-forward close, a
 * day without full coverage). Printed in a table with no marker, those numbers
 * read as exact — the one way this lens could be less honest than the line it
 * replaces. So the column appears by itself, but only when there is actually an
 * incomplete day in the window: a wall of "exact" on an exact series is noise.
 */
const COMPLETENESS_COLUMN: Column<ScrubTableRow> = {
  key: "basis",
  header: "Basis",
  render: (r) => (
    <span className="text-ink-faint">{r.point.complete === false ? "carried forward" : "exact"}</span>
  ),
};

/** Newest first — the "show me the numbers" reading order; the caption says so. */
export function ScrubTable({
  points,
  today,
  range,
  onRangeChange,
  summarize,
  renderHeader,
  formatValue,
  valueHeader,
  subject,
  extraColumns,
  emptyState,
  pillsClassName = "mt-3 flex flex-wrap gap-1.5",
  ownsCompleteness = false,
}: ScrubTableProps) {
  const windowed = useMemo(() => windowedPoints(points, today, range), [points, today, range]);
  const visible = windowed.points;

  // the chart's own header, on the chart's own numbers (one summarize call over
  // the whole window — the same call the chart makes for its resting state)
  const summary = visible.length >= 2 ? summarize(0, visible.length - 1, visible) : null;

  const rows = useMemo<ScrubTableRow[]>(
    // newest first; the day alone is not a safe key (a series may repeat a day)
    () => visible.map((point, i) => ({ key: `${point.day}#${i}`, point })).reverse(),
    [visible],
  );

  // the chart dashes incomplete days; the table must say so, or the numbers
  // read as exact when the line never claimed they were
  const needsCompleteness = !ownsCompleteness && hasEstimatedDay(visible);

  const columns = useMemo<Column<ScrubTableRow>[]>(
    () => [
      // nowrap: the table already scrolls horizontally (DataTable), and a
      // 3-line-wrapped date at 320px is far worse than a scroll
      {
        key: "day",
        header: "Day",
        render: (r) => <span className="whitespace-nowrap">{formatDayLong(r.point.day)}</span>,
      },
      {
        key: "value",
        header: valueHeader,
        align: "right",
        render: (r) => (
          <span className="figures">
            {r.point.valueCents === null ? "—" : formatValue(r.point.valueCents)}
          </span>
        ),
      },
      ...(needsCompleteness ? [COMPLETENESS_COLUMN] : []),
      ...(extraColumns ?? []),
    ],
    [valueHeader, formatValue, extraColumns, needsCompleteness],
  );

  // NEVER caption a window the rows aren't showing: when the requested range
  // held fewer than two points the chart falls back to the whole series, and
  // saying "3 months" over all-time rows would be a lie (the pass-22 bug class).
  const caption = windowed.fellBack
    ? `${subject} — all ${visible.length} days, newest first (${rangeLabel(range)} holds too little data to chart).`
    : `${subject} — ${rangeLabel(range)}, ${visible.length} days, newest first.`;

  return (
    <div>
      {summary && renderHeader(summary, false, range, null)}
      <ChartRangePills active={range} onSelect={onRangeChange} className={pillsClassName} />
      <div className="mt-3">
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} caption={caption} emptyState={emptyState} />
      </div>
    </div>
  );
}
