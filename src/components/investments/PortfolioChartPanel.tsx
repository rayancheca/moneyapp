"use client";

import { useCallback } from "react";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { ChartRange } from "@/lib/chart-range";
import { aggregateReturn, dailyReturns, type PortfolioDay } from "@/lib/portfolio-returns";
import { scrubValueText } from "@/lib/scrub";
import { ScrubChart, type Accent, type ScrubPoint, type ScrubSummary } from "./ScrubChart";

/**
 * The portfolio hero (ux-overhaul-plan §6.3): a big value that swaps to the
 * scrubbed point, a range/scrub delta in the period's gain/loss accent, and the
 * ScrubChart. The window return is flow-adjusted — computed here from the
 * PortfolioDay series with the pure return lib (no server code in the client
 * bundle), so a mid-window buy never inflates the number.
 */

interface PortfolioChartPanelProps {
  /** the value series (ascending), aligned 1:1 with returnDays by day */
  points: ScrubPoint[];
  /** flow-adjusted daily points for the return math */
  returnDays: PortfolioDay[];
  today: string;
  /** initial range pill (URL-driven, so both accent states are shareable) */
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

export function PortfolioChartPanel({ points, returnDays, today, defaultRange }: PortfolioChartPanelProps) {
  // window return: compound the flow-adjusted daily returns between the window's
  // first day (baseline) and the scrubbed/last day.
  const summarize = useCallback(
    (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
      const from = slice[startIdx]!.day;
      const to = slice[endIdx]!.day;
      const sub = returnDays.filter((d) => d.day >= from && d.day <= to);
      const agg = aggregateReturn(dailyReturns(sub));
      const valueCents = slice[endIdx]!.valueCents ?? agg.endNavCents;
      return { day: to, valueCents, deltaCents: agg.gainCents, deltaPct: agg.twrPct };
    },
    [returnDays],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string =>
      scrubValueText(formatDayLong(summary.day), formatCents(summary.valueCents), summary.deltaPct),
    [],
  );

  return (
    <ScrubChart
      points={points}
      today={today}
      defaultRange={defaultRange}
      summarize={summarize}
      accentOf={accentOf}
      valueText={valueText}
      formatValue={formatCents}
      ariaLabel="Portfolio value over time — scrub to inspect a day"
      renderHeader={(summary, scrubbing, range) => {
        const accent = accentOf(summary);
        const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
        const context = scrubbing ? formatDayLong(summary.day) : range === "ALL" ? "all time" : range;
        return (
          <header className="mb-1">
            <div className="text-3xl font-semibold tracking-tight sm:text-4xl">
              <NumberRoll value={formatCents(summary.valueCents)} />
            </div>
            <p className={`mt-1 flex items-center gap-2 text-sm font-medium ${ACCENT_TEXT[accent]}`}>
              <span className="figures">
                <span aria-hidden>{arrow} </span>
                {formatCentsSigned(summary.deltaCents)}
                {summary.deltaPct !== null && (
                  <span> ({summary.deltaPct >= 0 ? "+" : ""}{summary.deltaPct.toFixed(2)}%)</span>
                )}
              </span>
              <span className="font-normal text-ink-faint">· {context}</span>
              {scrubbing && (
                <span className="text-ink-faint" aria-hidden>
                  <Icon name="search" className="size-3" />
                </span>
              )}
            </p>
          </header>
        );
      }}
    />
  );
}
