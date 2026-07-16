"use client";

import { useCallback, useMemo } from "react";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { type ViewState } from "@/lib/view-state";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { ChartRange } from "@/lib/chart-range";
import {
  aggregateReturn,
  cumulativeReturns,
  dailyReturns,
  type PortfolioDay,
} from "@/lib/portfolio-returns";
import { scrubValueText } from "@/lib/scrub";
import { ScrubChart, type Accent, type ScrubPoint, type ScrubSummary } from "./ScrubChart";
import {
  INVESTMENTS_SURFACE,
  PORTFOLIO_VIEW_LABELS,
  PORTFOLIO_VIEW_SPEC,
} from "./investments-view-spec";

/**
 * The portfolio hero (ux-overhaul-plan §6.3 + NS#2 Pillar 2): a big value that
 * swaps to the scrubbed point, a range/scrub delta in the period's gain/loss
 * accent, and the ScrubChart — now with a Value ↔ Return view switch.
 *
 * The window return is flow-adjusted — computed here from the PortfolioDay series
 * with the pure return lib (no server code in the client bundle), so a mid-window
 * buy never inflates the number. The RETURN view plots the cumulative flow-
 * adjusted P/L line (deposits stripped, à la Robinhood) instead of raw value; the
 * header math is identical either way, so the two views always agree.
 */

interface PortfolioChartPanelProps {
  /** the value series (ascending), aligned 1:1 with returnDays by day */
  points: ScrubPoint[];
  /** flow-adjusted daily points for the return math */
  returnDays: PortfolioDay[];
  today: string;
  /** initial range pill (URL-driven, so both accent states are shareable) */
  defaultRange?: ChartRange;
  /** the RSC-resolved active view (URL > persisted > default) */
  viewState: ViewState;
  /** URL params to preserve across a view switch (the range) */
  baseParams: Record<string, string>;
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

export function PortfolioChartPanel({
  points,
  returnDays,
  today,
  defaultRange,
  viewState,
  baseParams,
}: PortfolioChartPanelProps) {
  const { state, setView } = useViewState({
    surface: INVESTMENTS_SURFACE,
    spec: PORTFOLIO_VIEW_SPEC,
    state: viewState,
    basePath: "/investments",
    baseParams,
  });
  const dim = PORTFOLIO_VIEW_SPEC[0]!; // "view"
  const active = state[dim.key] ?? "value";
  const isReturns = active === "returns";

  // the RETURN line: the cumulative flow-adjusted P/L series (deposits removed),
  // aligned 1:1 with the value series so the same range slicing + scrub applies.
  const returnPoints = useMemo<ScrubPoint[]>(
    () => cumulativeReturns(returnDays).map((p) => ({ day: p.day, valueCents: p.cumGainCents })),
    [returnDays],
  );
  const chartPoints = isReturns ? returnPoints : points;

  // window return: compound the flow-adjusted daily returns between the window's
  // first day (baseline) and the scrubbed/last day. View-independent — the header
  // shows the SAME honest window return whichever line is drawn.
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

  // the hero number: portfolio value (value view) or the window's return $ (return view)
  const heroCents = useCallback(
    (summary: ScrubSummary): number => (isReturns ? summary.deltaCents : summary.valueCents),
    [isReturns],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string =>
      scrubValueText(
        formatDayLong(summary.day),
        (isReturns ? formatCentsSigned : formatCents)(heroCents(summary)),
        summary.deltaPct,
      ),
    [isReturns, heroCents],
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-end">
        <ViewSwitcher
          dimension={dim}
          value={active}
          onSelect={(v) => setView(dim.key, v)}
          labels={PORTFOLIO_VIEW_LABELS}
          ariaLabel="Portfolio chart view"
        />
      </div>
      <ScrubChart
        points={chartPoints}
        today={today}
        defaultRange={defaultRange}
        summarize={summarize}
        accentOf={accentOf}
        valueText={valueText}
        formatValue={isReturns ? formatCentsSigned : formatCents}
        ariaLabel={
          isReturns
            ? "Portfolio return over time — scrub to inspect a day"
            : "Portfolio value over time — scrub to inspect a day"
        }
        renderHeader={(summary, scrubbing, range) => {
          const accent = accentOf(summary);
          const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
          const context = scrubbing ? formatDayLong(summary.day) : range === "ALL" ? "all time" : range;
          return (
            <header className="mb-1">
              <div className="text-3xl font-semibold tracking-tight sm:text-4xl">
                <NumberRoll value={(isReturns ? formatCentsSigned : formatCents)(heroCents(summary))} />
              </div>
              <p className={`mt-1 flex items-center gap-2 text-sm font-medium ${ACCENT_TEXT[accent]}`}>
                <span className="figures">
                  <span aria-hidden>{arrow} </span>
                  {!isReturns && <>{formatCentsSigned(summary.deltaCents)}</>}
                  {summary.deltaPct !== null && (
                    <span>
                      {isReturns ? "" : " "}({summary.deltaPct >= 0 ? "+" : ""}
                      {summary.deltaPct.toFixed(2)}%)
                    </span>
                  )}
                </span>
                <span className="font-normal text-ink-faint">· {isReturns ? `return · ${context}` : context}</span>
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
    </div>
  );
}
