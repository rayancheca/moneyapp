"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_RANGES, rangeLabel, rangeStartDay, type ChartRange } from "@/lib/chart-range";
import {
  compactMoney,
  dateAxisTicks,
  niceLinearTicks,
  windowExtremes,
  type WindowExtremes,
} from "@/lib/chart-axis";
import { compareDates } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { clampIndex, ratioToIndex, stepScrubIndex } from "@/lib/scrub";
import {
  firstCompleteDay,
  hasPartialCoverage,
  netWorthChartSeries,
  splitCoverageSeries,
} from "@/lib/scrub-series";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { ScrubTooltip, type VividChartRow } from "./ScrubTooltip";

/**
 * The reusable scrub chart (ux-overhaul-plan §6.3): range pills, a press/drag
 * hairline that swaps the header to the scrubbed point, keyboard scrub as a
 * `role="slider"`, a dotted period-start baseline, optional trade marks + a
 * reference line. Daily granularity, stated honestly. The consumer owns the
 * return math via `summarize`.
 *
 * Opt-in richer mode (dashboard net worth, §7.1): `showAxes` renders visible
 * nice-number Y ticks + adaptive calendar X ticks + gridlines; `selectable`
 * turns drag into a range-zoom (with hover-to-inspect and a custom-window Reset)
 * plus From/To inputs; `showExtremes` marks the window peak and trough.
 *
 * `vivid` (net worth only) layers the premium look on top: a lit gradient-stroke
 * line with a soft glow, a gradient area fill, a one-time draw-on reveal, a
 * floating tooltip card on hover, a pulsing "today" dot, an animated active dot,
 * and a calm shaded band (instead of a dashed line) for estimated early history.
 * All four flags default off, so the portfolio/holding/account charts are
 * byte-identical to before.
 */

export interface ScrubPoint {
  day: string;
  /** cents; null = no data that day (partial coverage) — the line breaks */
  valueCents: number | null;
  /**
   * false = a partial/estimated day (net worth: not every account covered;
   * balance: a carried/unverified basis) → drawn dashed. Defaults to true
   * (solid). Omitted entirely by the portfolio/holding charts, which are exact.
   */
  complete?: boolean;
}

export interface ScrubMark {
  day: string;
  valueCents: number;
  kind: "buy" | "sell";
}

export interface ScrubSummary {
  day: string;
  valueCents: number;
  /** change from the window start to this point */
  deltaCents: number;
  deltaPct: number | null;
}

export type Accent = "gain" | "loss" | "flat";

interface ScrubChartProps {
  /** the full series (ascending); the chart slices it per range pill / window */
  points: readonly ScrubPoint[];
  today: string;
  /** window return from slice[startIdx] to slice[endIdx], inclusive */
  summarize: (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]) => ScrubSummary;
  accentOf: (summary: ScrubSummary) => Accent;
  valueText: (summary: ScrubSummary, scrubbing: boolean) => string;
  formatValue: (cents: number) => string;
  renderHeader: (
    summary: ScrubSummary,
    scrubbing: boolean,
    range: ChartRange,
    customWindow: { start: string; end: string } | null,
  ) => ReactNode;
  ariaLabel: string;
  marks?: readonly ScrubMark[];
  refLine?: { cents: number; label: string } | null;
  defaultRange?: ChartRange;
  heightClass?: string;
  /** visible nice-number Y axis + adaptive calendar X axis + gridlines */
  showAxes?: boolean;
  /** drag-to-zoom a custom date window, hover-to-inspect, From/To inputs, Reset */
  selectable?: boolean;
  /** mark the window's peak + trough */
  showExtremes?: boolean;
  /** premium net-worth visuals: glow line, gradient fill, reveal, tooltip, live dot */
  vivid?: boolean;
}

const ACCENT_STROKE: Record<Accent, string> = {
  gain: "var(--positive)",
  loss: "var(--negative)",
  flat: "var(--ink-muted)",
};

/** Minimum horizontal drag (px) that counts as a range-select rather than a tap. */
const SELECT_DRAG_PX = 6;
/** One-time draw-on reveal duration (vivid mode). */
const REVEAL_MS = 1100;

export function ScrubChart({
  points,
  today,
  summarize,
  accentOf,
  valueText,
  formatValue,
  renderHeader,
  ariaLabel,
  marks,
  refLine,
  defaultRange = "ALL",
  heightClass = "h-56 sm:h-64",
  showAxes = false,
  selectable = false,
  showExtremes = false,
  vivid = false,
}: ScrubChartProps) {
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const [customWindow, setCustomWindow] = useState<{ start: string; end: string } | null>(null);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ a: number; b: number } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pointerType, setPointerType] = useState<string>("mouse");
  const reduced = usePrefersReducedMotion();
  const gradientId = useId();
  const fillId = useId();
  const strokeId = useId();
  const glowId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ startIdx: number; startX: number; moved: boolean } | null>(null);

  const slice = useMemo(() => {
    let windowed: ScrubPoint[];
    if (customWindow) {
      windowed = points.filter(
        (p) => compareDates(p.day, customWindow.start) >= 0 && compareDates(p.day, customWindow.end) <= 0,
      );
    } else {
      const start = rangeStartDay(range, today);
      windowed = start ? points.filter((p) => compareDates(p.day, start) >= 0) : points.slice();
    }
    // a too-short window (data older than the range, or a hair-thin drag) falls
    // back to ALL so a pill/drag never lands on an empty chart
    return windowed.length >= 2 ? windowed : points.slice();
  }, [points, range, today, customWindow]);

  const lastIdx = slice.length - 1;
  const effectiveIdx = scrubIndex === null ? lastIdx : clampIndex(scrubIndex, slice.length);
  const scrubbing = scrubIndex !== null;

  const summary = useMemo(
    () => (slice.length >= 2 ? summarize(0, effectiveIdx, slice) : null),
    [slice, effectiveIdx, summarize],
  );
  const accent: Accent = summary ? accentOf(summary) : "flat";
  const stroke = ACCENT_STROKE[accent];

  const splitData = useMemo(() => splitCoverageSeries(slice), [slice]);
  const showSoft = hasPartialCoverage(slice);
  const baselineCents = slice[0]?.valueCents ?? null;
  const baselineComplete = slice[0]?.complete !== false;

  // vivid net-worth series: one continuous line, fill suppressed before coverage
  const boundaryDay = useMemo(() => (vivid ? firstCompleteDay(slice) : null), [vivid, slice]);
  const vividData = useMemo<VividChartRow[]>(() => {
    if (!vivid) return [];
    return netWorthChartSeries(slice).map((row, i) => ({
      ...row,
      complete: slice[i]?.complete !== false,
      prevValue: i > 0 ? (slice[i - 1]?.valueCents ?? null) : null,
    }));
  }, [vivid, slice]);
  // recharts infers one ChartData<T> from `data`; the two series shapes (vivid
  // two-key vs coverage-split) differ, so widen to a plain record array — every
  // series reads its own string dataKey, so the concrete shape is irrelevant here
  const chartData = (vivid ? vividData : splitData) as unknown as Record<string, unknown>[];

  const values = useMemo(() => collectValues(slice, marks, refLine, baselineCents), [slice, marks, refLine, baselineCents]);
  const niceY = useMemo(() => {
    if (!showAxes || values.length === 0) return null;
    let lo = Math.min(...values);
    const hi = Math.max(...values);
    // pull a near-zero floor (or a debt sign-flip) into view so a framed axis
    // never hides that the balance came close to $0
    if (lo > 0 && lo < hi * 0.15) lo = 0;
    return niceLinearTicks(lo, hi, vivid ? 4 : 5);
  }, [showAxes, values, vivid]);
  const domain: [number, number] = niceY ? niceY.domain : rawDomain(values);

  const xTicks = useMemo(
    () => (showAxes ? dateAxisTicks(slice.map((p) => p.day)) : []),
    [showAxes, slice],
  );
  const xLabelByDay = useMemo(() => new Map(xTicks.map((t) => [t.day, t.label] as const)), [xTicks]);

  const extremes: WindowExtremes | null = useMemo(
    () => (showExtremes ? windowExtremes(slice) : null),
    [showExtremes, slice],
  );

  function idxFromClientX(clientX: number): number {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return effectiveIdx;
    return ratioToIndex((clientX - rect.left) / rect.width, slice.length);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const next = stepScrubIndex(effectiveIdx, event.key, slice.length);
    if (next === null) return;
    event.preventDefault();
    setScrubIndex(next);
  }

  function selectRange(range: ChartRange): void {
    setRange(range);
    setCustomWindow(null);
    setScrubIndex(null);
    setSelection(null);
  }

  function applyWindow(startDay: string, endDay: string): void {
    const lo = compareDates(startDay, endDay) <= 0 ? startDay : endDay;
    const hi = compareDates(startDay, endDay) <= 0 ? endDay : startDay;
    setCustomWindow({ start: lo, end: hi });
    setScrubIndex(null);
    setSelection(null);
  }

  // ── pointer handlers ────────────────────────────────────────────────
  // Non-selectable charts keep the original press-drag-scrub. Selectable charts
  // add hover-to-inspect and drag-to-zoom: a press that stays put inspects (the
  // hairline), a press that DRAGS past a threshold selects a window to zoom into.
  // In vivid mode desktop hover is read by the floating Tooltip instead of the
  // header, so plain hover does not swap the header (the split the spec calls for).

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPointerType(e.pointerType);
    const idx = idxFromClientX(e.clientX);
    setScrubIndex(idx);
    if (selectable) {
      pressRef.current = { startIdx: idx, startX: e.clientX, moved: false };
      setSelection(null);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const capturing = e.currentTarget.hasPointerCapture(e.pointerId);
    if (!selectable) {
      if (capturing) setScrubIndex(idxFromClientX(e.clientX));
      return;
    }
    if (capturing) {
      const press = pressRef.current;
      if (!press) return;
      if (Math.abs(e.clientX - press.startX) > SELECT_DRAG_PX) press.moved = true;
      const idx = idxFromClientX(e.clientX);
      if (press.moved) {
        setSelection({ a: press.startIdx, b: idx });
        setScrubIndex(null); // a range is forming — hide the single-day hairline
      } else {
        setScrubIndex(idx);
      }
    } else if (!vivid) {
      // desktop hover: non-vivid inspects via the hairline; vivid leaves the
      // header alone and lets the floating Tooltip be the readout
      setScrubIndex(idxFromClientX(e.clientX));
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const press = pressRef.current;
    pressRef.current = null;
    if (selectable && press?.moved && selection) {
      const a = Math.min(selection.a, selection.b);
      const b = Math.max(selection.a, selection.b);
      if (b - a >= 1) applyWindow(slice[a]!.day, slice[b]!.day);
      else setSelection(null);
    }
    setScrubIndex(null); // release snaps the header back to the window summary
    setSelection(null);
  }

  function onPointerLeave(e: React.PointerEvent<HTMLDivElement>): void {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) setScrubIndex(null);
  }

  if (slice.length < 2 || !summary) {
    return <p className="py-10 text-center text-sm text-ink-muted">Not enough history to chart yet.</p>;
  }

  const scrubDay = slice[effectiveIdx]!.day;
  // label only CLEARLY-INTERIOR peaks/troughs: an extreme within a few percent
  // of either end crowds the axis labels in the corner (and a trough near $0 sits
  // right on the x-axis), so it keeps its dot but drops its text.
  const labelMargin = Math.max(2, Math.round(slice.length * 0.05));
  const interior = (day: string) => {
    const i = slice.findIndex((p) => p.day === day);
    return i > labelMargin && i < lastIdx - labelMargin;
  };
  const labelMax = extremes ? interior(extremes.max.day) : false;
  const labelMin = extremes ? interior(extremes.min.day) : false;
  const selDays =
    selection && slice[selection.a] && slice[selection.b]
      ? { x1: slice[Math.min(selection.a, selection.b)]!.day, x2: slice[Math.max(selection.a, selection.b)]!.day }
      : null;
  const seriesFirst = points[0]?.day;
  const seriesLast = points[points.length - 1]?.day;

  // vivid coverage annotation. The per-day fill (netWorthChartSeries fills only
  // `complete` days) already marks EVERY estimated day, so the band is just the
  // leading pre-coverage prefix; a whole-window band shows only when NO day in
  // view is complete (boundaryDay === null). An interior/trailing partial run
  // needs no band — its missing fill is the honest cue.
  const bandStart = slice[0]?.day;
  const boundaryIdx = boundaryDay ? slice.findIndex((p) => p.day === boundaryDay) : -1;
  const hasBoundaryBand = vivid && showSoft && !!boundaryDay && !!bandStart && boundaryDay !== bandStart;
  const wholeWindowPartial = vivid && showSoft && boundaryDay === null;
  // caption the prefix band only when it's wide enough to hold the label without
  // the text spilling past the boundary into the exact (filled) region
  const showBandLabel = hasBoundaryBand && lastIdx > 0 && boundaryIdx / lastIdx >= 0.18;

  // a perfectly-flat window draws a horizontal line whose objectBoundingBox glow
  // filter region collapses to 0 height (hiding the line), so drop the glow then
  const lineVals = slice.map((p) => p.valueCents).filter((v): v is number => v !== null);
  const lineFlat = lineVals.length > 0 && Math.min(...lineVals) === Math.max(...lineVals);

  // live "today" dot: only when the window truly ends at today and we're at rest
  const endsAtToday = slice[lastIdx]?.day === today;
  const lastRealValue = slice[lastIdx]?.valueCents ?? null;
  const showLiveDot = vivid && endsAtToday && !scrubbing && !customWindow && lastRealValue !== null;
  // the long ~1.2s delay is first-draw choreography; after the reveal (or under
  // reduced motion) the dot must reappear promptly on each scrub release
  const liveDelay = reduced || revealed ? "0ms" : `${REVEAL_MS + 120}ms`;

  const animateReveal = vivid && !reduced && !revealed;
  const showTooltip = vivid && pointerType !== "touch" && !selection;

  return (
    <figure className="m-0">
      {renderHeader(summary, scrubbing, range, customWindow)}

      <div
        ref={plotRef}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={lastIdx}
        aria-valuenow={effectiveIdx}
        aria-valuetext={valueText(summary, scrubbing)}
        onKeyDown={onKeyDown}
        onBlur={() => setScrubIndex(null)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={() => {
          pressRef.current = null;
          setScrubIndex(null);
          setSelection(null);
        }}
        className={`${heightClass} touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          selectable ? "cursor-crosshair" : ""
        }`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            accessibilityLayer={false}
            margin={showAxes ? { top: 8, right: 2, bottom: 2, left: 2 } : { top: 6, right: 0, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
              {vivid && (
                <>
                  <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={stroke} stopOpacity={0.26} />
                    <stop offset="45%" stopColor={stroke} stopOpacity={0.08} />
                    <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                  </linearGradient>
                  {/* 0% stop stays ≥0.8 so the oldest (leftmost) segment clears
                      the WCAG 3:1 non-text contrast floor on the light surface */}
                  <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={stroke} stopOpacity={0.8} />
                    <stop offset="70%" stopColor={stroke} stopOpacity={1} />
                    <stop offset="100%" stopColor={stroke} stopOpacity={1} />
                  </linearGradient>
                  <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%" filterUnits="objectBoundingBox">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="2.75" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </>
              )}
            </defs>
            {showAxes && (
              <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={vivid ? 0.4 : 0.6} />
            )}
            {showAxes ? (
              <XAxis
                dataKey="day"
                type="category"
                ticks={xTicks.map((t) => t.day)}
                tickFormatter={(d: string) => xLabelByDay.get(d) ?? ""}
                interval={0}
                tick={{ fontSize: vivid ? 11 : 10, fill: "var(--ink-faint)" }}
                tickLine={false}
                axisLine={false}
                height={16}
                padding={{ left: 6, right: 6 }}
              />
            ) : (
              <XAxis dataKey="day" hide />
            )}
            {showAxes && niceY ? (
              <YAxis
                orientation="right"
                domain={domain}
                ticks={niceY.ticks}
                tickFormatter={(v: number) => compactMoney(v)}
                tick={{ fontSize: vivid ? 11 : 10, fill: "var(--ink-faint)" }}
                tickLine={false}
                axisLine={false}
                width={vivid ? 44 : 40}
              />
            ) : (
              <YAxis domain={domain} hide />
            )}

            {/* vivid coverage band + boundary (replaces the dashed soft line) */}
            {hasBoundaryBand && (
              <>
                <ReferenceArea
                  x1={bandStart}
                  x2={boundaryDay!}
                  fill="var(--chart-band)"
                  strokeOpacity={0}
                  label={showBandLabel ? { value: "Partial coverage", position: "insideTopLeft", fontSize: 10, fill: "var(--ink-faint)" } : undefined}
                />
                {/* the estimated span carries no fill; the divider marks where every
                    account is covered, so the filled region to its right is exact */}
                <ReferenceLine x={boundaryDay!} stroke="var(--line-strong)" strokeDasharray="3 3" />
              </>
            )}
            {wholeWindowPartial && bandStart && (
              <ReferenceArea
                x1={bandStart}
                x2={slice[lastIdx]!.day}
                fill="var(--chart-band)"
                strokeOpacity={0}
                label={{ value: "Partial coverage", position: "insideTopLeft", fontSize: 10, fill: "var(--ink-faint)" }}
              />
            )}

            {baselineCents !== null && (
              <ReferenceLine y={baselineCents} stroke="var(--line-strong)" strokeDasharray="2 4" />
            )}
            {refLine && (
              <ReferenceLine
                y={refLine.cents}
                stroke="var(--ink-faint)"
                strokeDasharray="4 3"
                label={{ value: refLine.label, position: "insideTopLeft", fontSize: 10, fill: "var(--ink-faint)" }}
              />
            )}

            {vivid ? (
              <>
                <Area
                  type="monotone"
                  dataKey="fillValue"
                  stroke="none"
                  fill={`url(#${fillId})`}
                  isAnimationActive={animateReveal}
                  animationBegin={0}
                  animationDuration={REVEAL_MS}
                  animationEasing="ease-out"
                  connectNulls={false}
                  dot={false}
                  activeDot={false}
                />
                <Line
                  type="monotone"
                  dataKey="lineValue"
                  stroke={`url(#${strokeId})`}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter={lineFlat ? undefined : `url(#${glowId})`}
                  isAnimationActive={animateReveal}
                  animationBegin={120}
                  animationDuration={REVEAL_MS}
                  animationEasing="ease-out"
                  onAnimationEnd={() => setRevealed(true)}
                  connectNulls={false}
                  dot={false}
                  activeDot={<PulseDot accent={stroke} />}
                />
              </>
            ) : (
              <>
                <Area
                  type="monotone"
                  dataKey="solid"
                  stroke={stroke}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                  connectNulls={false}
                  dot={false}
                  activeDot={false}
                />
                {showSoft && (
                  <Area
                    type="monotone"
                    dataKey="soft"
                    stroke={stroke}
                    strokeWidth={1.75}
                    strokeDasharray="4 4"
                    strokeOpacity={0.6}
                    fill="none"
                    isAnimationActive={false}
                    connectNulls={false}
                    dot={false}
                    activeDot={false}
                  />
                )}
              </>
            )}

            {extremes && (
              <>
                <ReferenceDot
                  x={extremes.max.day}
                  y={extremes.max.cents}
                  r={vivid ? 2.5 : 3}
                  fill={vivid ? "none" : "var(--positive)"}
                  stroke={vivid ? "var(--ink-muted)" : "var(--surface-raised)"}
                  strokeWidth={1.5}
                  label={labelMax ? { value: `▲ ${compactMoney(extremes.max.cents)}`, position: "top", fontSize: 10, fill: "var(--ink-muted)" } : undefined}
                />
                <ReferenceDot
                  x={extremes.min.day}
                  y={extremes.min.cents}
                  r={vivid ? 2.5 : 3}
                  fill={vivid ? "none" : "var(--negative)"}
                  stroke={vivid ? "var(--ink-muted)" : "var(--surface-raised)"}
                  strokeWidth={1.5}
                  label={labelMin ? { value: `▼ ${compactMoney(extremes.min.cents)}`, position: "bottom", fontSize: 10, fill: "var(--ink-muted)" } : undefined}
                />
              </>
            )}
            {(marks ?? []).map((m, i) => (
              <ReferenceDot
                key={`${m.day}-${i}`}
                x={m.day}
                y={m.valueCents}
                r={3}
                fill={m.kind === "buy" ? "var(--positive)" : "var(--negative)"}
                stroke="var(--surface-raised)"
                strokeWidth={1.5}
              />
            ))}
            {showLiveDot && (
              <ReferenceDot
                x={slice[lastIdx]!.day}
                y={lastRealValue!}
                shape={<LiveDot accent={stroke} delay={liveDelay} reduced={reduced} />}
              />
            )}
            {selDays && (
              <ReferenceArea x1={selDays.x1} x2={selDays.x2} fill="var(--accent)" fillOpacity={0.12} stroke="var(--accent)" strokeOpacity={0.4} />
            )}
            {scrubbing && (
              <ReferenceLine x={scrubDay} stroke="var(--ink-muted)" strokeWidth={1} strokeDasharray={vivid ? "3 3" : undefined} />
            )}
            {showTooltip && (
              <Tooltip
                cursor={false}
                isAnimationActive={false}
                offset={12}
                wrapperStyle={{ outline: "none", pointerEvents: "none" }}
                content={(props) => (
                  <ScrubTooltip
                    active={props.active}
                    payload={props.payload as unknown as readonly { payload?: VividChartRow; value?: number | null }[]}
                    baselineCents={baselineCents}
                    baselineComplete={baselineComplete}
                    formatValue={formatValue}
                  />
                )}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {selectable ? (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Chart range" className="flex flex-wrap gap-1.5">
          {CHART_RANGES.map((r) => pill(r, customWindow ? null : range, selectRange, vivid))}
        </div>
        {customWindow && (
          <button
            type="button"
            onClick={() => selectRange(range)}
            className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent transition-colors duration-(--duration-fast) hover:bg-accent/15 active:scale-95"
          >
            {formatDayShort(customWindow.start)} – {formatDayShort(customWindow.end)} · Reset
          </button>
        )}
        {seriesFirst && seriesLast && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-ink-faint">
            <input
              type="date"
              aria-label="From date"
              value={customWindow?.start ?? slice[0]!.day}
              min={seriesFirst}
              max={customWindow?.end ?? slice[lastIdx]!.day}
              onChange={(e) => e.target.value && applyWindow(e.target.value, customWindow?.end ?? seriesLast)}
              className="figures rounded-md border border-line bg-surface-raised px-1.5 py-0.5 text-xs transition-colors duration-(--duration-fast) hover:border-line-strong focus:border-accent"
            />
            <span aria-hidden>–</span>
            <input
              type="date"
              aria-label="To date"
              value={customWindow?.end ?? slice[lastIdx]!.day}
              min={customWindow?.start ?? slice[0]!.day}
              max={seriesLast}
              onChange={(e) => e.target.value && applyWindow(customWindow?.start ?? seriesFirst, e.target.value)}
              className="figures rounded-md border border-line bg-surface-raised px-1.5 py-0.5 text-xs transition-colors duration-(--duration-fast) hover:border-line-strong focus:border-accent"
            />
          </div>
        )}
      </div>
      ) : (
        <div role="group" aria-label="Chart range" className="mt-3 flex flex-wrap gap-1.5">
          {CHART_RANGES.map((r) => pill(r, range, selectRange, vivid))}
        </div>
      )}
      {/* deterministic scrubbed value for tests + a visible caption echo */}
      <figcaption className="sr-only">{valueText(summary, scrubbing)}</figcaption>
    </figure>
  );
}

/** The animated active dot (vivid): a faint halo + a ring that pops on snap. */
function PulseDot({ cx, cy, accent }: { cx?: number; cy?: number; accent: string }) {
  if (cx == null || cy == null) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={9} fill={accent} opacity={0.18} />
      <circle
        cx={cx}
        cy={cy}
        r={3.5}
        fill="var(--surface-raised)"
        stroke={accent}
        strokeWidth={2}
        style={{ transformBox: "fill-box", transformOrigin: "center", animation: "land-snap var(--duration-fast) var(--ease-spring)" }}
      />
    </g>
  );
}

/**
 * The live "today" marker (vivid): a core dot under a slow pulsing halo. The
 * global reduced-motion CSS guard only zeroes animation-DURATION, so an infinite
 * pulse would keep looping (and rest on an invisible frame) for reduced-motion
 * users — so we drop the pulse class entirely and render a calm static ring then.
 */
function LiveDot({
  cx,
  cy,
  accent,
  delay,
  reduced,
}: {
  cx?: number;
  cy?: number;
  accent: string;
  delay: string;
  reduced: boolean;
}) {
  if (cx == null || cy == null) return null;
  return (
    <g className="animate-fade-rise" style={{ animationDelay: delay, animationFillMode: "both" }}>
      <circle
        cx={cx}
        cy={cy}
        r={4}
        fill="none"
        stroke={accent}
        strokeWidth={1.5}
        opacity={reduced ? 0.5 : undefined}
        className={reduced ? undefined : "animate-pulse-ring"}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      />
      <circle cx={cx} cy={cy} r={4} fill={accent} />
    </g>
  );
}

/** One range pill. `active` is the selected range (null under a custom window,
 * so no pill reads as pressed). `press` adds the vivid press-scale; the sibling
 * charts pass false so their pills stay byte-identical to before. */
function pill(r: ChartRange, active: ChartRange | null, onChange: (r: ChartRange) => void, press: boolean) {
  const isActive = r === active;
  return (
    <button
      key={r}
      type="button"
      aria-pressed={isActive}
      aria-label={rangeLabel(r)}
      onClick={() => onChange(r)}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors duration-(--duration-fast) ${press ? "active:scale-95 " : ""}${
        isActive ? "bg-accent-soft text-accent" : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
      }`}
    >
      {r}
    </button>
  );
}

/** Every value the y-scale must cover: the line, marks, reference line, baseline. */
function collectValues(
  slice: readonly ScrubPoint[],
  marks: readonly ScrubMark[] | undefined,
  refLine: { cents: number } | null | undefined,
  baselineCents: number | null,
): number[] {
  const values: number[] = [];
  for (const p of slice) if (p.valueCents !== null) values.push(p.valueCents);
  for (const m of marks ?? []) values.push(m.valueCents);
  if (refLine) values.push(refLine.cents);
  if (baselineCents !== null) values.push(baselineCents);
  return values;
}

/** The original padded domain (6% headroom) for the axis-less charts. */
function rawDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1, (max - min) * 0.06);
  return [min - pad, max + pad];
}
