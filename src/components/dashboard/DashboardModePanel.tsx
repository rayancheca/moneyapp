"use client";

import { useCallback, useMemo } from "react";
import { NumberRoll } from "@/components/ui/NumberRoll";
import type { ChartRange } from "@/lib/chart-range";
import { compareDates } from "@/lib/dates";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { BridgedDashboardSeries } from "@/lib/multi-series-bridge";
import { scrubValueText } from "@/lib/scrub";
import { useDashboardWindowProps } from "@/components/dashboard/DashboardWindowContext";
import {
  ScrubChart,
  type Accent,
  type OverlaySeries,
  type ScrubPoint,
  type ScrubSummary,
} from "@/components/investments/ScrubChart";

/**
 * The dashboard chart's non-combined view modes (pass-17 ask C): assets /
 * liabilities-owed / split / per-account lines, rendered through the same
 * ScrubChart the combined view uses. ONE series is the primary (it owns every
 * interaction invariant — scrub, drag-zoom, keyboard, pills, extremes, the
 * x-axis domain); the rest draw as coverage-honest colored overlays with a
 * legend. Because ScrubChart's axis comes from the primary, the primary MUST be
 * the LONGEST-history series (`primaryOf`) or an overlay with older days would
 * be silently clipped off the chart (2026-07-18 adversarial review). Rollup
 * modes span the full union already, so their series[0] is the natural primary;
 * accounts mode picks the oldest account.
 *
 * Honesty rules carried over: estimated days draw dashed; the owed frame
 * inverts the accent (debt going DOWN is the gain) — header, stroke, aria AND
 * tooltip; assets-mode days bridged by an in-flight float say so in the
 * header/aria/tooltip; per-account lines are never bridged (an individual
 * ledger honestly dipped while money moved). A window that opens before a
 * series' coverage measures its delta from the first COVERED day, never a
 * fabricated $0 baseline.
 */

interface DashboardModePanelProps {
  series: readonly BridgedDashboardSeries[];
  /** resolved CSS color per series key; the primary uses it in accounts mode */
  colorByKey: Record<string, string>;
  /** fix the primary line to its palette color (accounts mode) */
  colorPrimary?: boolean;
  /**
   * Choose the primary by longest history (accounts mode only): per-account
   * lines drop their own pre-history, so an older overlay would clip off the
   * primary-owned axis. Rollup modes span the full union axis regardless, so
   * they keep series[0] as primary (assets leads split — the intuitive frame).
   */
  pickLongestPrimary?: boolean;
  today: string;
  heightClass?: string;
  activeRange?: ChartRange;
  onRangeChange?: (range: ChartRange) => void;
}

/** the earliest covered day of a series (its first non-null point), or null. */
function firstCoveredDay(s: BridgedDashboardSeries): string | null {
  for (const p of s.points) if (p.valueCents !== null) return p.day;
  return null;
}

/**
 * The series that must own the x-axis: the one whose coverage starts earliest,
 * so every other (later-starting) series aligns inside its day range without
 * being clipped. Ties keep input order (assets before liabilities in split).
 */
function primaryOf(series: readonly BridgedDashboardSeries[]): BridgedDashboardSeries | undefined {
  let best: BridgedDashboardSeries | undefined;
  let bestDay: string | null = null;
  for (const s of series) {
    const day = firstCoveredDay(s);
    if (day === null) continue;
    if (bestDay === null || compareDates(day, bestDay) < 0) {
      best = s;
      bestDay = day;
    }
  }
  return best ?? series[0];
}

/** append the owed-frame cue unless the label already says it ("Amount owed") */
function frameLabel(s: Pick<BridgedDashboardSeries, "label" | "owedFrame">): string {
  return s.owedFrame && !/owed/i.test(s.label) ? `${s.label} (owed)` : s.label;
}

function toScrubPoints(s: BridgedDashboardSeries): ScrubPoint[] {
  return s.points.map((p) => ({
    day: p.day,
    valueCents: p.valueCents,
    complete: p.complete,
    inTransitCents: p.inTransitCents,
  }));
}

export function DashboardModePanel({
  series,
  colorByKey,
  colorPrimary = false,
  pickLongestPrimary = false,
  today,
  heightClass = "h-64 sm:h-72",
  activeRange,
  onRangeChange,
}: DashboardModePanelProps) {
  const windowProps = useDashboardWindowProps();
  const primary = useMemo(
    () => (pickLongestPrimary ? primaryOf(series) : (series[0] ?? primaryOf(series))),
    [series, pickLongestPrimary],
  );
  const scrubPoints = useMemo(() => (primary ? toScrubPoints(primary) : []), [primary]);
  const overlays: OverlaySeries[] = useMemo(
    () =>
      series
        .filter((s) => s.key !== primary?.key)
        .map((s) => ({
          key: s.key,
          label: frameLabel(s),
          color: colorByKey[s.key] ?? "var(--ink-muted)",
          points: toScrubPoints(s),
        })),
    [series, primary, colorByKey],
  );
  const transitByDay = useMemo(
    () => new Map((primary?.points ?? []).map((p) => [p.day, p.inTransitCents] as const)),
    [primary],
  );

  const owed = primary?.owedFrame ?? false;
  const accentOf = useCallback(
    (summary: ScrubSummary): Accent => {
      if (summary.deltaCents === 0) return "flat";
      // owed frame: the debt shrinking is the win
      const gained = owed ? summary.deltaCents < 0 : summary.deltaCents > 0;
      return gained ? "gain" : "loss";
    },
    [owed],
  );

  const summarize = useCallback(
    (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
      // measure from the first COVERED day at/after the window start — a rollup
      // built over the union axis is null before its coverage began (e.g. owed
      // has no value until the first liability opened), and coercing that null
      // to $0 would fabricate a delta equal to the whole current balance.
      let s = startIdx;
      while (s < endIdx && slice[s]!.valueCents === null) s++;
      const startPoint = slice[s]!;
      const start = startPoint.valueCents;
      const endPoint = slice[endIdx]!;
      const end = endPoint.valueCents ?? 0;
      const deltaCents = start === null ? 0 : end - start;
      // % suppressed unless BOTH measured ends are complete (a partial endpoint
      // would fabricate the percentage) and the base is non-zero
      const comparable = start !== null && startPoint.complete !== false && endPoint.complete !== false;
      const deltaPct = comparable && start !== 0 ? (deltaCents / Math.abs(start)) * 100 : null;
      return { day: endPoint.day, valueCents: end, deltaCents, deltaPct };
    },
    [],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string => {
      const base = scrubValueText(formatDayLong(summary.day), formatCents(summary.valueCents), summary.deltaPct);
      const framed = owed ? `${base} — amount owed` : base;
      const transit = transitByDay.get(summary.day) ?? 0;
      if (transit > 0) return `${framed} — includes ${formatCents(transit)} in transit`;
      if (transit < 0) return `${framed} — excludes ${formatCents(-transit)} posted in two accounts`;
      return framed;
    },
    [owed, transitByDay],
  );

  if (!primary || scrubPoints.length < 2) {
    return <p className="py-10 text-center text-sm text-ink-muted">Not enough history to chart yet.</p>;
  }

  const ACCENT_TEXT: Record<Accent, string> = {
    gain: "text-positive",
    loss: "text-negative",
    flat: "text-ink-muted",
  };

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted" aria-label="Chart legend">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded-full"
              style={{ background: colorPrimary ? (colorByKey[primary.key] ?? "var(--ink)") : "var(--ink)" }}
            />
            {frameLabel(primary)}
          </span>
          {overlays.map((o) => (
            <span key={o.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 rounded-full" style={{ background: o.color }} />
              {o.label}
            </span>
          ))}
        </div>
      )}
      <ScrubChart
        {...windowProps}
        points={scrubPoints}
        today={today}
        activeRange={activeRange}
        onRangeChange={onRangeChange}
        showAxes
        selectable
        showExtremes
        vivid
        overlays={overlays}
        owedFrame={owed}
        strokeColor={colorPrimary ? colorByKey[primary.key] : undefined}
        summarize={summarize}
        accentOf={accentOf}
        valueText={valueText}
        formatValue={formatCents}
        ariaLabel={`${primary.label} over time — scrub to inspect a day, drag to zoom a range`}
        heightClass={heightClass}
        renderHeader={(summary, scrubbing, range, customWindow) => {
          const accent = accentOf(summary);
          const arrow = summary.deltaCents > 0 ? "▲" : summary.deltaCents < 0 ? "▼" : "•";
          const context = scrubbing
            ? formatDayLong(summary.day)
            : customWindow
              ? `${formatDayShort(customWindow.start)} – ${formatDayShort(customWindow.end)}`
              : range === "ALL"
                ? "all time"
                : range;
          const transit = transitByDay.get(summary.day) ?? 0;
          return (
            <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
              {scrubbing && <NumberRoll value={formatCents(summary.valueCents)} className="text-ink" />}
              <span className={`inline-flex items-center gap-1 ${ACCENT_TEXT[accent]}`}>
                <span aria-hidden>{arrow}</span>
                <NumberRoll value={formatCentsSigned(summary.deltaCents)} />
                {summary.deltaPct !== null && (
                  <span className="figures">
                    ({summary.deltaPct >= 0 ? "+" : ""}
                    {summary.deltaPct.toFixed(1)}%)
                  </span>
                )}
              </span>
              <span className="font-normal text-ink-faint">
                · {frameLabel(primary)} · {context}
              </span>
              {transit !== 0 && (
                <span className="font-normal text-ink-faint">
                  · {transit > 0
                    ? `includes ${formatCents(transit)} in transit`
                    : `excludes ${formatCents(-transit)} posted twice`}
                </span>
              )}
            </header>
          );
        }}
      />
    </div>
  );
}
