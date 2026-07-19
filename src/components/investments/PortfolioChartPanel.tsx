"use client";

import { useCallback, type ReactNode } from "react";
import { ChartFocus } from "@/components/charts/ChartFocus";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { viewHrefQuery, type ViewState } from "@/lib/view-state";
import { DEFAULT_BENCHMARK } from "@/lib/benchmark-symbol";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { ChartRange } from "@/lib/chart-range";
import { type PortfolioDay } from "@/lib/portfolio-returns";
import { scrubValueText } from "@/lib/scrub";
import { BenchmarkPicker } from "./BenchmarkPicker";
import { ScrubChart, type Accent, type ScrubPoint, type ScrubSummary } from "./ScrubChart";
import {
  BenchmarkLegend,
  DecompositionBar,
  ReplayLegend,
  ReturnStatsList,
  pctFromScaled,
  signedPct,
  useReturnViewModel,
  type ReturnBenchmark,
} from "./ReturnViewParts";
import {
  INVESTMENTS_SURFACE,
  PORTFOLIO_UNIT_LABELS,
  PORTFOLIO_VIEW_LABELS,
  PORTFOLIO_VIEW_SPEC,
} from "./investments-view-spec";

/**
 * The portfolio hero (ux-overhaul-plan §6.3 + NS#2 Pillar 2): a big value that
 * swaps to the scrubbed point, a range/scrub delta in the period's gain/loss
 * accent, and the ScrubChart — with a Value ⇄ Return view switch and (in the
 * Return view) a $ ⇄ % unit switch, peak/trough marks, and best/worst-day +
 * drawdown stats. The return-view model (deposit-stripped line, benchmark
 * overlay, stats, decomposition, flow-adjusted window summarize) is the shared
 * ReturnViewParts implementation the holding chart consumes too, so the two
 * views can never drift apart.
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
  /** optional "you vs the market" benchmark: cumulative % aligned 1:1 to returnDays */
  benchmark?: ReturnBenchmark | null;
  /** the resolved benchmark SYMBOL (may lack data — the picker still shows it) */
  benchmarkSymbol: string;
  /** rendered below the chart in BOTH the inline card and the focus modal
   *  (the portfolio summary stats) — server-rendered, passed from the RSC so the
   *  stat block never enters the client bundle */
  footer?: ReactNode;
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
  benchmark,
  benchmarkSymbol,
  footer,
}: PortfolioChartPanelProps) {
  const { state, setView } = useViewState({
    surface: INVESTMENTS_SURFACE,
    spec: PORTFOLIO_VIEW_SPEC,
    state: viewState,
    basePath: "/investments",
    baseParams,
  });
  const viewDim = PORTFOLIO_VIEW_SPEC[0]!; // "view"
  const unitDim = PORTFOLIO_VIEW_SPEC[1]!; // "unit"
  // the return view needs at least two flow-adjusted days to draw a line; a
  // one-day portfolio coerces back to Value (mirrors HoldingChartPanel)
  const canShowReturns = returnDays.length >= 2;
  const isReturns = canShowReturns && (state[viewDim.key] ?? "value") === "returns";
  const isPercent = isReturns && state[unitDim.key] === "percent";

  // the RETURN line: cumulative flow-adjusted P/L (deposits removed), aligned 1:1
  // with the value series so the same range slicing + scrub applies — plus the
  // benchmark overlay, stats, decomposition, and flow-adjusted window summarize
  const {
    returnPoints,
    stats,
    benchmarkCompare,
    benchmarkTotalPct,
    benchmarkSinceDay,
    replayCompare,
    replaySummary,
    youSwatchClass,
    decomposition,
    summarize,
  } = useReturnViewModel(returnDays, isReturns, isPercent, benchmark);
  const chartPoints = isReturns ? returnPoints : points;
  // one overlay per framing: % → buy-and-hold TWR, $ → the flow-replay gains
  const compareLine = benchmarkCompare ?? replayCompare;

  // the picker's target href: keep the view dims + preserved params, swap the
  // bench param (dropped at the SPY default so shared links stay clean)
  const hrefForBenchmark = useCallback(
    (symbol: string): string => {
      const { bench: _bench, ...rest } = baseParams;
      const params = symbol === DEFAULT_BENCHMARK ? rest : { ...rest, bench: symbol };
      return `/investments${viewHrefQuery(PORTFOLIO_VIEW_SPEC, state, params)}`;
    },
    [baseParams, state],
  );

  // the hero number as a string: value ($), return-dollar (±$), or return-percent (±%)
  const heroText = useCallback(
    (summary: ScrubSummary): string => {
      if (!isReturns) return formatCents(summary.valueCents);
      if (isPercent) return summary.deltaPct === null ? "—" : signedPct(summary.deltaPct);
      return formatCentsSigned(summary.deltaCents);
    },
    [isReturns, isPercent],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string =>
      scrubValueText(formatDayLong(summary.day), heroText(summary), isPercent ? null : summary.deltaPct),
    [heroText, isPercent],
  );

  return (
    <ChartFocus
      label="Portfolio"
      defaultRange={defaultRange ?? "ALL"}
      cardClassName="relative"
      renderPanel={(opts) => (
    <div>
      {/* pr-9 keeps the right-aligned switchers clear of ChartFocus's top-right
          focus affordance; flex-wrap protects the three-control return view on
          narrow screens */}
      {canShowReturns && (
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2 pr-9">
          {isReturns && (
            <BenchmarkPicker value={benchmarkSymbol} hrefFor={hrefForBenchmark} hasData={benchmark != null} />
          )}
          {isReturns && (
            <ViewSwitcher
              dimension={unitDim}
              value={state[unitDim.key] ?? "dollar"}
              onSelect={(v) => setView(unitDim.key, v)}
              labels={PORTFOLIO_UNIT_LABELS}
              ariaLabel="Return unit"
            />
          )}
          <ViewSwitcher
            dimension={viewDim}
            value={isReturns ? "returns" : "value"}
            onSelect={(v) => setView(viewDim.key, v)}
            labels={PORTFOLIO_VIEW_LABELS}
            ariaLabel="Portfolio chart view"
          />
        </div>
      )}
      {benchmarkCompare && (
        <BenchmarkLegend
          label={benchmark!.label}
          totalPct={benchmarkTotalPct}
          sinceDay={benchmarkSinceDay}
          youSwatchClass={youSwatchClass}
        />
      )}
      {replayCompare && replaySummary && (
        <ReplayLegend
          label={benchmark!.label}
          end={replaySummary}
          sinceDay={returnDays[0]!.day}
          youSwatchClass={youSwatchClass}
        />
      )}
      <ScrubChart
        points={chartPoints}
        today={today}
        defaultRange={defaultRange}
        activeRange={opts.activeRange}
        onRangeChange={opts.onRangeChange}
        heightClass={opts.heightClass}
        summarize={summarize}
        accentOf={accentOf}
        valueText={valueText}
        formatValue={isPercent ? pctFromScaled : isReturns ? formatCentsSigned : formatCents}
        {...(isPercent ? { formatExtreme: pctFromScaled } : {})}
        {...(compareLine ? { compareLine } : {})}
        showExtremes={isReturns}
        showAxes
        selectable
        ariaLabel={
          isReturns
            ? "Portfolio return over time — scrub to inspect a day"
            : "Portfolio value over time — scrub to inspect a day"
        }
        renderHeader={(summary, scrubbing, range, customWindow) => {
          const accent = accentOf(summary);
          const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
          const context = scrubbing
            ? formatDayLong(summary.day)
            : customWindow
              ? `${customWindow.start} → ${customWindow.end}`
              : range === "ALL"
                ? "all time"
                : range;
          // the SECONDARY metric (whatever the hero isn't): value→±$ +(%); return-$→(%); return-%→±$
          const secondary =
            !isReturns
              ? `${formatCentsSigned(summary.deltaCents)}${summary.deltaPct !== null ? ` (${signedPct(summary.deltaPct)})` : ""}`
              : isPercent
                ? formatCentsSigned(summary.deltaCents)
                : summary.deltaPct !== null
                  ? `(${signedPct(summary.deltaPct)})`
                  : "";
          return (
            // pr-9 reserves clearance for ChartFocus's top-right focus button in
            // the no-switcher state (canShowReturns === false: this header is the
            // top element and would otherwise sit under the button)
            <header className="mb-1 pr-9">
              <div className="text-3xl font-semibold tracking-tight sm:text-4xl">
                <NumberRoll value={heroText(summary)} />
              </div>
              <p className={`mt-1 flex items-center gap-2 text-sm font-medium ${ACCENT_TEXT[accent]}`}>
                <span className="figures">
                  <span aria-hidden>{arrow} </span>
                  {secondary}
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
      {stats && (stats.bestDay || stats.worstDay) && <ReturnStatsList stats={stats} isPercent={isPercent} />}
      {decomposition && <DecompositionBar decomposition={decomposition} />}
      {footer}
    </div>
      )}
    />
  );
}
