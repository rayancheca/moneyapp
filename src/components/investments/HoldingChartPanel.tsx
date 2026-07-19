"use client";

import { useCallback, useMemo } from "react";
import { ChartFocus } from "@/components/charts/ChartFocus";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { viewHrefQuery, type ViewState } from "@/lib/view-state";
import { DEFAULT_BENCHMARK } from "@/lib/benchmark-symbol";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { type PortfolioDay } from "@/lib/portfolio-returns";
import { scrubValueText } from "@/lib/scrub";
import { BenchmarkPicker } from "./BenchmarkPicker";
import { ScrubChart, type Accent, type ScrubMark, type ScrubPoint, type ScrubSummary } from "./ScrubChart";
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
  HOLDING_SURFACE,
  HOLDING_VIEW_LABELS,
  HOLDING_VIEW_SPEC,
  PORTFOLIO_UNIT_LABELS,
} from "./investments-view-spec";

/**
 * The holding chart (ux-overhaul-plan §6.4 + Robinhood-parity item 1), now a
 * Price ⇄ Return switchable view mirroring the portfolio hero:
 *
 * - PRICE: the per-share close history with trade marks and the average-cost
 *   reference line (a single security's per-share story). Drag-select shows any
 *   window's price change in place.
 * - RETURN: the flow-adjusted return of YOUR position in it (deposits/buys
 *   stripped at daily closes) — $ is the DCA-weighted P/L, % is the TWR while
 *   held — with the benchmark overlay, peak/trough marks, best/worst-day +
 *   drawdown stats, and the contributions-vs-gains decomposition, all from the
 *   shared ReturnViewParts implementation the portfolio hero uses.
 */

interface HoldingChartPanelProps {
  /** `complete: false` on days carried forward past the last quoted close (dashed) */
  priceSeries: { day: string; closeCents: number; complete: boolean }[];
  today: string;
  marks: ScrubMark[];
  avgCostCents: number | null;
  symbol: string;
  /** flow-adjusted daily series for this holding (aggregated across accounts) */
  returnDays: PortfolioDay[];
  /** the RSC-resolved active view (URL > persisted > default) */
  viewState: ViewState;
  /** this holding's own route (the switcher navigates within it) */
  basePath: string;
  /** URL params to preserve across a view switch */
  baseParams: Record<string, string>;
  /** optional "you vs the market" benchmark: cumulative % aligned 1:1 to returnDays */
  benchmark?: ReturnBenchmark | null;
  /** the resolved benchmark SYMBOL (may lack data — the picker still shows it) */
  benchmarkSymbol: string;
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

export function HoldingChartPanel({
  priceSeries,
  today,
  marks,
  avgCostCents,
  symbol,
  returnDays,
  viewState,
  basePath,
  baseParams,
  benchmark,
  benchmarkSymbol,
}: HoldingChartPanelProps) {
  const { state, setView } = useViewState({
    surface: HOLDING_SURFACE,
    spec: HOLDING_VIEW_SPEC,
    state: viewState,
    basePath,
    baseParams,
  });
  const viewDim = HOLDING_VIEW_SPEC[0]!; // "view"
  const unitDim = HOLDING_VIEW_SPEC[1]!; // "unit"
  // the return view needs at least two flow-adjusted days to draw a line; a
  // thinner holding (priced yesterday, opened today) coerces back to Price
  const canShowReturns = returnDays.length >= 2;
  const isReturns = canShowReturns && (state[viewDim.key] ?? "value") === "returns";
  const isPercent = isReturns && state[unitDim.key] === "percent";

  const pricePoints: ScrubPoint[] = useMemo(
    () =>
      priceSeries.map((p) => ({
        day: p.day,
        valueCents: p.closeCents,
        complete: p.complete,
      })),
    [priceSeries],
  );

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
    summarize: summarizeReturn,
  } = useReturnViewModel(returnDays, isReturns, isPercent, benchmark);
  const chartPoints = isReturns ? returnPoints : pricePoints;
  // one overlay per framing: % → buy-and-hold TWR, $ → the flow-replay gains
  const compareLine = benchmarkCompare ?? replayCompare;

  // the picker's target href on THIS holding's route (bench dropped at the default)
  const hrefForBenchmark = useCallback(
    (symbol: string): string => {
      const { bench: _bench, ...rest } = baseParams;
      const params = symbol === DEFAULT_BENCHMARK ? rest : { ...rest, bench: symbol };
      return `${basePath}${viewHrefQuery(HOLDING_VIEW_SPEC, state, params)}`;
    },
    [baseParams, basePath, state],
  );

  // PRICE view: the window's per-share price change (a single security's price
  // change over a window IS its return per share). RETURN view: the flow-
  // adjusted window return of the position (from the shared model).
  const summarizePrice = useCallback(
    (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
      const start = slice[startIdx]!.valueCents ?? 0;
      const end = slice[endIdx]!.valueCents ?? 0;
      const deltaCents = end - start;
      return { day: slice[endIdx]!.day, valueCents: end, deltaCents, deltaPct: start !== 0 ? (deltaCents / start) * 100 : null };
    },
    [],
  );
  const summarize = isReturns ? summarizeReturn : summarizePrice;

  // the hero number as a string: price ($), return-dollar (±$), or return-percent (±%)
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
      label="Holding"
      defaultRange="ALL"
      cardClassName="relative"
      resetRangeKey={isReturns ? "returns" : "price"}
      renderPanel={(opts) => (
    <div>
      {/* pr-9 keeps the right-aligned switchers clear of ChartFocus's top-right
          focus affordance; flex-wrap protects the three-control return view */}
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
            labels={HOLDING_VIEW_LABELS}
            ariaLabel="Holding chart view"
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
        // the price and return series are NOT day-aligned (price carries to
        // today; returns end at the last close / final trade), so remount on a
        // view switch — a retained drag-window or range pill from the other
        // series would silently fall back to ALL data captioned as that window
        key={isReturns ? "returns" : "price"}
        points={chartPoints}
        today={today}
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
        marks={isReturns ? [] : marks}
        refLine={!isReturns && avgCostCents !== null ? { cents: avgCostCents, label: "Avg cost" } : null}
        ariaLabel={
          isReturns
            ? `${symbol} return over time — scrub to inspect a day`
            : `${symbol} price over time — scrub to inspect a day`
        }
        renderHeader={(summary, scrubbing, range, customWindow) => {
          const accent = accentOf(summary);
          const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
          // the return baseline is the first day the position was held AND
          // priced — earlier appreciation is not measured, so never say "all
          // time"; name the basis day instead
          const context = scrubbing
            ? formatDayLong(summary.day)
            : customWindow
              ? `${customWindow.start} → ${customWindow.end}`
              : range === "ALL"
                ? isReturns
                  ? `since ${formatDayLong(returnDays[0]!.day)}`
                  : "all time"
                : range;
          // the SECONDARY metric (whatever the hero isn't): price→±$ +(%); return-$→(%); return-%→±$
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
              <div className="text-2xl font-semibold tracking-tight sm:text-3xl">
                <NumberRoll value={heroText(summary)} />
              </div>
              <p className={`mt-1 flex items-center gap-2 text-sm font-medium ${ACCENT_TEXT[accent]}`}>
                <span className="figures">
                  <span aria-hidden>{arrow} </span>
                  {secondary}
                </span>
                <span className="font-normal text-ink-faint">
                  · {isReturns ? `your return · ${context} · at daily closes` : context}
                </span>
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
    </div>
      )}
    />
  );
}
