"use client";

import { useCallback, useMemo } from "react";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { DAILY_SERIES_RANGES, type ChartRange } from "@/lib/chart-range";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { scrubValueText } from "@/lib/scrub";
import type { NetWorthPoint } from "@/services/derivation";
import { useDashboardWindowProps } from "@/components/dashboard/DashboardWindowContext";
import {
  ScrubChart,
  type Accent,
  type ScrubPoint,
  type ScrubSummary,
} from "@/components/investments/ScrubChart";
import { coverageLabel } from "@/lib/coverage-label";

/**
 * Net worth adoption of the ScrubChart (ux-overhaul-plan §7.1). The Stage-4
 * chart already breaks the line on `complete: false`; here every day carries a
 * total but some are partial-coverage — so we thread `complete` through, the
 * chart draws those spans dashed, and the scrub announces "partial · N/M
 * accounts" so the honesty is spoken, not just drawn. The window return is a
 * plain value delta (net worth has no flows to adjust for).
 */

/** dashboard points carry the in-flight correction (docs/inflight-dips.md);
 *  standalone renders without it stay byte-identical (the field is optional) */
type PanelPoint = NetWorthPoint & { inTransitCents?: number };

interface NetWorthChartPanelProps {
  points: readonly PanelPoint[];
  today: string;
  defaultRange?: ChartRange;
  /** override the chart height (the S8 focus modal renders it taller) */
  heightClass?: string;
  /** lift the range pills to a parent (ChartFocus shares one range between the
   * inline card and the focus modal) — optional, pass-through to ScrubChart */
  activeRange?: ChartRange;
  onRangeChange?: (range: ChartRange) => void;
}

function accentOf(summary: ScrubSummary): Accent {
  if (summary.deltaCents > 0) return "gain";
  if (summary.deltaCents < 0) return "loss";
  return "flat";
}

const ACCENT_TEXT: Record<Accent, string> = {
  gain: "text-positive",
  loss: "text-negative",
  flat: "text-ink-muted",
};

export function NetWorthChartPanel({
  points,
  today,
  defaultRange = "1Y",
  heightClass = "h-64 sm:h-72",
  activeRange,
  onRangeChange,
}: NetWorthChartPanelProps) {
  const windowProps = useDashboardWindowProps();
  const scrubPoints: ScrubPoint[] = useMemo(
    () =>
      points.map((p) => ({
        day: p.day,
        valueCents: p.totalCents,
        complete: p.complete,
        missingAccounts: p.missingAccounts,
        coveredAccountNames: p.coveredAccountNames,
        inTransitCents: p.inTransitCents,
      })),
    [points],
  );
  const coverageByDay = useMemo(
    () => new Map(points.map((p) => [p.day, p] as const)),
    [points],
  );

  const summarize = useCallback(
    (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
      const start = slice[startIdx]!.valueCents ?? 0;
      const end = slice[endIdx]!.valueCents ?? 0;
      const deltaCents = end - start;
      // A partial-coverage endpoint covers fewer accounts, so a % against it would
      // be a fabricated number (the "40k→3→90" artifact the graph must never lie
      // about). Suppress the % unless BOTH ends are complete — the honest delta
      // is still shown, just without an over/under-stated percentage.
      const comparable = slice[startIdx]!.complete !== false && slice[endIdx]!.complete !== false;
      const deltaPct = comparable && start !== 0 ? (deltaCents / Math.abs(start)) * 100 : null;
      return { day: slice[endIdx]!.day, valueCents: end, deltaCents, deltaPct };
    },
    [],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string => {
      const base = scrubValueText(formatDayLong(summary.day), formatCents(summary.valueCents), summary.deltaPct);
      const cov = coverageByDay.get(summary.day);
      // the in-flight note must be SPOKEN, not just drawn (docs/inflight-dips.md)
      const transit = cov?.inTransitCents ?? 0;
      const transitSuffix =
        transit > 0
          ? ` — includes ${formatCents(transit)} in transit`
          : transit < 0
            ? ` — excludes ${formatCents(-transit)} posted in two accounts`
            : "";
      if (!cov || cov.complete) return `${base}${transitSuffix}`;
      // untruncated (no "+N more") so the spoken description names every account
      const label = coverageLabel(cov.coveredAccountNames, cov.missingAccounts, Number.MAX_SAFE_INTEGER);
      // "; only X" / "; missing X" — no trailing "covered" (the base already said it)
      const suffix = label ? `; ${label.kind} ${label.text}` : "";
      return `${base} — partial, ${cov.coveredAccounts} of ${cov.totalAccounts} accounts covered${suffix}${transitSuffix}`;
    },
    [coverageByDay],
  );

  // When wrapped in a DashboardWindowProvider, lift the brush/zoom window to the
  // shared history stack so back/forward + the linked activity panel can drive it
  // (dashboard-dynamic §1) — the shared hook makes every hero panel consistent.
  return (
    <ScrubChart
      {...windowProps}
      points={scrubPoints}
      today={today}
      defaultRange={defaultRange}
      activeRange={activeRange}
      ranges={DAILY_SERIES_RANGES}
      onRangeChange={onRangeChange}
      showAxes
      selectable
      showExtremes
      vivid
      summarize={summarize}
      accentOf={accentOf}
      valueText={valueText}
      formatValue={formatCents}
      ariaLabel="Net worth over time — scrub to inspect a day, drag to zoom a range"
      heightClass={heightClass}
      renderHeader={(summary, scrubbing, range, customWindow) => {
        const accent = accentOf(summary);
        const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
        const context = scrubbing
          ? formatDayLong(summary.day)
          : customWindow
            ? `${formatDayShort(customWindow.start)} – ${formatDayShort(customWindow.end)}`
            : range === "ALL"
              ? "all time"
              : range;
        const cov = coverageByDay.get(summary.day);
        const covLabel = cov && !cov.complete ? coverageLabel(cov.coveredAccountNames, cov.missingAccounts) : null;
        // spoken subtly whenever the summarized day is bridged — while
        // scrubbing that is the scrubbed day (on touch the header IS the
        // readout), and at rest it is the window's latest day, so an in-air
        // transfer covering today is explained without any interaction
        // (2026-07-18 adversarial review)
        const transit = cov?.inTransitCents ?? 0;
        return (
          <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            {scrubbing && (
              <NumberRoll value={formatCents(summary.valueCents)} className="text-ink" />
            )}
            <span className={`inline-flex items-center gap-1 ${ACCENT_TEXT[accent]}`}>
              <span aria-hidden>{arrow}</span>
              <NumberRoll value={formatCentsSigned(summary.deltaCents)} />
              {summary.deltaPct !== null && (
                <span className="figures">({summary.deltaPct >= 0 ? "+" : ""}{summary.deltaPct.toFixed(1)}%)</span>
              )}
            </span>
            <span className="font-normal text-ink-faint">· {context}</span>
            {cov && !cov.complete && (
              <span className="font-normal text-warning">
                · partial {cov.coveredAccounts}/{cov.totalAccounts}
                {covLabel && (
                  <span className="text-ink-faint"> · {covLabel.kind} {covLabel.text}</span>
                )}
              </span>
            )}
            {transit !== 0 && (
              <span className="font-normal text-ink-faint">
                · {transit > 0
                  ? `includes ${formatCents(transit)} in transit`
                  : `excludes ${formatCents(-transit)} posted twice`}
              </span>
            )}
            {scrubbing && (
              <span className="text-ink-faint" aria-hidden>
                <Icon name="search" className="size-3" />
              </span>
            )}
          </header>
        );
      }}
    />
  );
}
