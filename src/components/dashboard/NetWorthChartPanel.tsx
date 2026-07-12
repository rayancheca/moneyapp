"use client";

import { useCallback, useMemo } from "react";
import { Icon } from "@/components/shell/Icon";
import type { ChartRange } from "@/lib/chart-range";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { scrubValueText } from "@/lib/scrub";
import type { NetWorthPoint } from "@/services/derivation";
import {
  ScrubChart,
  type Accent,
  type ScrubPoint,
  type ScrubSummary,
} from "@/components/investments/ScrubChart";

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
  const scrubPoints: ScrubPoint[] = useMemo(
    () => points.map((p) => ({ day: p.day, valueCents: p.totalCents, complete: p.complete })),
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
        ? `${base} — partial, ${cov.coveredAccounts} of ${cov.totalAccounts} accounts covered`
        : base;
    },
    [coverageByDay],
  );

  return (
    <ScrubChart
      points={scrubPoints}
      today={today}
      defaultRange={defaultRange}
      summarize={summarize}
      accentOf={accentOf}
      valueText={valueText}
      formatValue={formatCents}
      ariaLabel="Net worth over time — scrub to inspect a day"
      heightClass="h-56 sm:h-64"
      renderHeader={(summary, scrubbing, range) => {
        const accent = accentOf(summary);
        const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
        const context = scrubbing ? formatDayLong(summary.day) : range === "ALL" ? "all time" : range;
        const cov = coverageByDay.get(summary.day);
        return (
          <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            {scrubbing && (
              <span className="figures text-ink">{formatCents(summary.valueCents)}</span>
            )}
            <span className={`figures ${ACCENT_TEXT[accent]}`}>
              <span aria-hidden>{arrow} </span>
              {formatCentsSigned(summary.deltaCents)}
              {summary.deltaPct !== null && (
                <span> ({summary.deltaPct >= 0 ? "+" : ""}{summary.deltaPct.toFixed(1)}%)</span>
              )}
            </span>
            <span className="font-normal text-ink-faint">· {context}</span>
            {cov && !cov.complete && (
              <span className="font-normal text-warning">· partial {cov.coveredAccounts}/{cov.totalAccounts}</span>
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
