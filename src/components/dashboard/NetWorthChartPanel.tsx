"use client";

import { useCallback, useMemo } from "react";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import type { ChartRange } from "@/lib/chart-range";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { scrubValueText } from "@/lib/scrub";
import type { WindowSource } from "@/lib/window-history";
import type { NetWorthPoint } from "@/services/derivation";
import { useDashboardWindow } from "@/components/dashboard/DashboardWindowContext";
import {
  ScrubChart,
  type Accent,
  type ScrubPoint,
  type ScrubSummary,
} from "@/components/investments/ScrubChart";
import { formatMissingAccounts } from "@/components/investments/ScrubTooltip";

/**
 * Net worth adoption of the ScrubChart (ux-overhaul-plan §7.1). The Stage-4
 * chart already breaks the line on `complete: false`; here every day carries a
 * total but some are partial-coverage — so we thread `complete` through, the
 * chart draws those spans dashed, and the scrub announces "partial · N/M
 * accounts" so the honesty is spoken, not just drawn. The window return is a
 * plain value delta (net worth has no flows to adjust for).
 */

interface NetWorthChartPanelProps {
  points: readonly NetWorthPoint[];
  today: string;
  defaultRange?: ChartRange;
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

export function NetWorthChartPanel({ points, today, defaultRange = "1Y" }: NetWorthChartPanelProps) {
  const windowCtx = useDashboardWindow();
  const scrubPoints: ScrubPoint[] = useMemo(
    () =>
      points.map((p) => ({
        day: p.day,
        valueCents: p.totalCents,
        complete: p.complete,
        missingAccounts: p.missingAccounts,
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
      return cov && !cov.complete
        ? `${base} — partial, ${cov.coveredAccounts} of ${cov.totalAccounts} accounts covered${
            cov.missingAccounts.length > 0 ? `; missing ${cov.missingAccounts.join(", ")}` : ""
          }`
        : base;
    },
    [coverageByDay],
  );

  // When wrapped in a DashboardWindowProvider, lift the brush/zoom window to the
  // shared history stack so back/forward + the linked activity panel can drive it
  // (dashboard-dynamic §1). Rendered standalone (no provider) the chart stays
  // uncontrolled and byte-identical.
  const winStart = windowCtx?.current?.start ?? null;
  const winEnd = windowCtx?.current?.end ?? null;
  // keep a STABLE object identity while the window is unchanged — an inline object
  // literal would defeat ScrubChart's `slice` memo and recompute the whole series
  // on every parent re-render while zoomed
  const activeWindow = useMemo(
    () => (winStart && winEnd ? { start: winStart, end: winEnd } : null),
    [winStart, winEnd],
  );
  const windowProps = windowCtx
    ? {
        activeWindow,
        onWindowChange: (w: { start: string; end: string } | null, source: WindowSource) => {
          if (w) windowCtx.push(w, source);
          else windowCtx.reset();
        },
        history: {
          canGoBack: windowCtx.canGoBack,
          canGoForward: windowCtx.canGoForward,
          onBack: windowCtx.back,
          onForward: windowCtx.forward,
        },
      }
    : {};

  return (
    <ScrubChart
      {...windowProps}
      points={scrubPoints}
      today={today}
      defaultRange={defaultRange}
      showAxes
      selectable
      showExtremes
      vivid
      summarize={summarize}
      accentOf={accentOf}
      valueText={valueText}
      formatValue={formatCents}
      ariaLabel="Net worth over time — scrub to inspect a day, drag to zoom a range"
      heightClass="h-64 sm:h-72"
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
                {cov.missingAccounts.length > 0 && (
                  <span className="text-ink-faint"> · no {formatMissingAccounts(cov.missingAccounts)}</span>
                )}
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
