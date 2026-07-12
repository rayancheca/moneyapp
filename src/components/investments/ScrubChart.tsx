"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Area,
  ComposedChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_RANGES, rangeLabel, rangeStartDay, type ChartRange } from "@/lib/chart-range";
import { compareDates } from "@/lib/dates";
import { clampIndex, ratioToIndex, stepScrubIndex } from "@/lib/scrub";

/**
 * The reusable scrub chart (ux-overhaul-plan §6.3): range pills, a press/drag
 * hairline that swaps the header to the scrubbed point, keyboard scrub as a
 * `role="slider"` (arrows move the hairline, `aria-valuetext` announces the
 * point), a dotted period-start baseline, optional trade marks + a reference
 * line (avg cost). Daily granularity, stated honestly — no fake intraday. The
 * consumer owns the return math via `summarize`, so the same chart drives the
 * flow-adjusted portfolio and a plain price-history holding page.
 */

export interface ScrubPoint {
  day: string;
  /** cents; null = no data that day (partial coverage) — the line breaks */
  valueCents: number | null;
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
  /** the full series (ascending); the chart slices it per range pill */
  points: readonly ScrubPoint[];
  today: string;
  /** window return from slice[startIdx] to slice[endIdx], inclusive */
  summarize: (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]) => ScrubSummary;
  accentOf: (summary: ScrubSummary) => Accent;
  valueText: (summary: ScrubSummary, scrubbing: boolean) => string;
  formatValue: (cents: number) => string;
  renderHeader: (summary: ScrubSummary, scrubbing: boolean, range: ChartRange) => ReactNode;
  ariaLabel: string;
  marks?: readonly ScrubMark[];
  refLine?: { cents: number; label: string } | null;
  defaultRange?: ChartRange;
  heightClass?: string;
}

const ACCENT_STROKE: Record<Accent, string> = {
  gain: "var(--positive)",
  loss: "var(--negative)",
  flat: "var(--ink-muted)",
};

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
}: ScrubChartProps) {
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const gradientId = useId();
  const plotRef = useRef<HTMLDivElement>(null);

  const slice = useMemo(() => {
    const start = rangeStartDay(range, today);
    const windowed = start ? points.filter((p) => compareDates(p.day, start) >= 0) : points.slice();
    // a too-short trailing window (data older than the range) falls back to ALL
    // so a pill never lands on an empty chart
    return windowed.length >= 2 ? windowed : points.slice();
  }, [points, range, today]);

  const lastIdx = slice.length - 1;
  const effectiveIdx = scrubIndex === null ? lastIdx : clampIndex(scrubIndex, slice.length);
  const scrubbing = scrubIndex !== null;

  const summary = useMemo(
    () => (slice.length >= 2 ? summarize(0, effectiveIdx, slice) : null),
    [slice, effectiveIdx, summarize],
  );
  const accent: Accent = summary ? accentOf(summary) : "flat";
  const stroke = ACCENT_STROKE[accent];

  const chartData = slice.map((p) => ({ day: p.day, v: p.valueCents }));
  const baselineCents = slice[0]?.valueCents ?? null;
  const domain = useMemo(() => yDomain(slice, marks, refLine, baselineCents), [slice, marks, refLine, baselineCents]);

  function setFromClientX(clientX: number): void {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setScrubIndex(ratioToIndex((clientX - rect.left) / rect.width, slice.length));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const next = stepScrubIndex(effectiveIdx, event.key, slice.length);
    if (next === null) return;
    event.preventDefault();
    setScrubIndex(next);
  }

  if (slice.length < 2 || !summary) {
    return <p className="py-10 text-center text-sm text-ink-muted">Not enough history to chart yet.</p>;
  }

  const scrubDay = slice[effectiveIdx]!.day;

  return (
    <figure className="m-0">
      {renderHeader(summary, scrubbing, range)}

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
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromClientX(e.clientX);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setScrubIndex(null); // release snaps the header back to the range summary
        }}
        onPointerCancel={() => setScrubIndex(null)}
        className={`${heightClass} touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="day" hide />
            <YAxis domain={domain} hide />
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
            <Area
              type="monotone"
              dataKey="v"
              stroke={stroke}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              connectNulls={false}
              dot={false}
              activeDot={false}
            />
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
            {scrubbing && (
              <ReferenceLine x={scrubDay} stroke="var(--ink-muted)" strokeWidth={1} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <RangePills range={range} onChange={(r) => { setRange(r); setScrubIndex(null); }} />
      {/* deterministic scrubbed value for tests + a visible caption echo */}
      <figcaption className="sr-only">{valueText(summary, scrubbing)}</figcaption>
    </figure>
  );
}

function RangePills({ range, onChange }: { range: ChartRange; onChange: (r: ChartRange) => void }) {
  return (
    <div role="group" aria-label="Chart range" className="mt-3 flex flex-wrap gap-1.5">
      {CHART_RANGES.map((r) => {
        const active = r === range;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            aria-label={rangeLabel(r)}
            onClick={() => onChange(r)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors duration-(--duration-fast) ${
              active
                ? "bg-accent-soft text-accent"
                : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
            }`}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}

/** Y domain covering the line, marks, reference line, and baseline with headroom. */
function yDomain(
  slice: readonly ScrubPoint[],
  marks: readonly ScrubMark[] | undefined,
  refLine: { cents: number } | null | undefined,
  baselineCents: number | null,
): [number, number] {
  const values: number[] = [];
  for (const p of slice) if (p.valueCents !== null) values.push(p.valueCents);
  for (const m of marks ?? []) values.push(m.valueCents);
  if (refLine) values.push(refLine.cents);
  if (baselineCents !== null) values.push(baselineCents);
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1, (max - min) * 0.06);
  return [min - pad, max + pad];
}
