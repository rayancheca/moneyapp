"use client";

import { useCallback } from "react";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { scrubValueText } from "@/lib/scrub";
import { ScrubChart, type Accent, type ScrubMark, type ScrubPoint, type ScrubSummary } from "./ScrubChart";

/**
 * The holding chart (ux-overhaul-plan §6.4): a plain price history (no flows —
 * a single security's return over a window IS its price change), with trade
 * marks and an average-cost reference line from the rebuilt timeline. Reuses the
 * ScrubChart; the return here is the simple endpoint price change.
 */

interface HoldingChartPanelProps {
  /** `complete: false` on days carried forward past the last quoted close (dashed) */
  priceSeries: { day: string; closeCents: number; complete: boolean }[];
  today: string;
  marks: ScrubMark[];
  avgCostCents: number | null;
  symbol: string;
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

export function HoldingChartPanel({ priceSeries, today, marks, avgCostCents, symbol }: HoldingChartPanelProps) {
  const points: ScrubPoint[] = priceSeries.map((p) => ({
    day: p.day,
    valueCents: p.closeCents,
    complete: p.complete,
  }));

  const summarize = useCallback((startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
    const start = slice[startIdx]!.valueCents ?? 0;
    const end = slice[endIdx]!.valueCents ?? 0;
    const deltaCents = end - start;
    return { day: slice[endIdx]!.day, valueCents: end, deltaCents, deltaPct: start !== 0 ? (deltaCents / start) * 100 : null };
  }, []);

  const valueText = useCallback(
    (summary: ScrubSummary): string =>
      scrubValueText(formatDayLong(summary.day), formatCents(summary.valueCents), summary.deltaPct),
    [],
  );

  return (
    <ScrubChart
      points={points}
      today={today}
      summarize={summarize}
      accentOf={accentOf}
      valueText={valueText}
      formatValue={formatCents}
      marks={marks}
      refLine={avgCostCents !== null ? { cents: avgCostCents, label: "Avg cost" } : null}
      ariaLabel={`${symbol} price over time — scrub to inspect a day`}
      renderHeader={(summary, scrubbing, range) => {
        const accent = accentOf(summary);
        const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
        const context = scrubbing ? formatDayLong(summary.day) : range === "ALL" ? "all time" : range;
        return (
          <header className="mb-1">
            <div className="text-2xl font-semibold tracking-tight sm:text-3xl">
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
            </p>
          </header>
        );
      }}
    />
  );
}
