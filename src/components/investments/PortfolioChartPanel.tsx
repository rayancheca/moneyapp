"use client";

import { useCallback, type ReactNode } from "react";
import { ChartFocus } from "@/components/charts/ChartFocus";
import { isTableLens, LENS_DIMENSION, LENS_LABELS } from "@/components/charts/chart-lens";
import { ScrubTable } from "@/components/charts/ScrubTable";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { viewHrefQuery, type ViewState } from "@/lib/view-state";
import { DEFAULT_BENCHMARK } from "@/lib/benchmark-symbol";
import { carriedFromDay } from "@/lib/price-series";
import { formatDayLong } from "@/lib/format-date";
import { sessionSummarize, type SessionChartView } from "@/lib/intraday-axis";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { ChartRange } from "@/lib/chart-range";
import { SessionNote } from "./SessionNote";
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
  /** today's intraday session, already windowed and labelled by the RSC; null
   *  when nothing has ticked yet (the 1D note then says so and offers to load) */
  session?: SessionChartView | null;
  /** how many held symbols carried a price into the session — stated rather than
   *  implied, so a partly-priced book cannot read as full coverage */
  pricedSymbols?: number;
  /** newest stored close (`PortfolioOverview.asOf`) — see `sinceCloseClause` */
  closeOn?: string | null;
  totalSymbols?: number;
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
  session,
  pricedSymbols = 0,
  closeOn = null,
  totalSymbols = 0,
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
  // the chart⇄table lens — orthogonal to view/unit: the table shows whichever
  // metric those two select, so neither switcher becomes a no-op in table mode
  const isTable = isTableLens(state);

  // the RETURN line: cumulative flow-adjusted P/L (deposits removed), aligned 1:1
  // with the value series so the same range slicing + scrub applies — plus the
  // benchmark overlay, stats, decomposition, and flow-adjusted window summarize
  const {
    returnPoints,
    statsFor,
    benchmarkCompare,
    benchmarkTotalPct,
    benchmarkSinceDay,
    replayCompare,
    replaySummary,
    youSwatchClass,
    decomposition,
    summarize,
  } = useReturnViewModel(returnDays, isReturns, isPercent, benchmark, today);
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

  /*
   * 🔴 The spoken readout dated a CARRIED day as if it were measured. The value
   * line is extended flat to today when prices have not been refreshed
   * (`carryForwardTo`), and a sighted reader is told so three ways — the tail is
   * dashed, the hover chip reads "● Partial", the page banner names the close it
   * is holding. The `<figcaption className="sr-only">` said only
   * "Wed, Sep 2, 2026: $107,097.05, up 30.0%". `NetWorthChartPanel`'s own
   * valueText has named its incomplete days since it shipped; this one now does
   * too, out of the same helper so the two charts cannot drift.
   */
  const valueText = useCallback(
    (summary: ScrubSummary): string => {
      const base = scrubValueText(
        summary.atLabel ?? formatDayLong(summary.day),
        heroText(summary),
        isPercent ? null : summary.deltaPct,
      );
      const heldFrom = carriedFromDay(chartPoints, summary.day);
      return heldFrom === null
        ? base
        : `${base} — carried forward from the close on ${formatDayLong(heldFrom)}`;
    },
    [chartPoints, heroText, isPercent],
  );

  // ONE header for both lenses — the table's readout IS the chart's readout
  const renderHeader = useCallback(
    (
      summary: ScrubSummary,
      scrubbing: boolean,
      range: ChartRange,
      customWindow: { start: string; end: string } | null,
    ) => {
      /*
       * 🔴 THE ARROW BELONGS TO THE FIGURE IT PRECEDES, and in the Return · $
       * view that figure is the PERCENTAGE while `accentOf` reads the dollars.
       * Measured 2026-09-04, the default view of three of twelve holdings:
       *
       *     +$6,023.43                              ETH
       *     ▲ (-29.72% time-weighted) · your return · since Thu, Oct 16, 2025
       *
       *     +$4,468.50                              MSFT
       *     ▲ (-5.95% time-weighted) · …
       *
       *     -$215.13                                GLD
       *     ▼ (+0.29% time-weighted) · …
       *
       * — an up arrow, in green, immediately before a negative percentage with
       * nothing between them, and the mirror of it on GLD. The two measures
       * really do disagree in direction (money made against a time-weighted
       * rate), which is the whole reason this page prints both; the arrow has to
       * say which one it is pointing at.
       *
       * ⛔ `accentOf` still colours the CHART, which plots the hero. Only this
       * line's arrow and tone follow the secondary.
       */
      const secondaryCents = isReturns && !isPercent ? summary.deltaPct : summary.deltaCents;
      const accent: Accent =
        secondaryCents === null || secondaryCents === 0
          ? accentOf(summary)
          : secondaryCents > 0
            ? "gain"
            : "loss";
      const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
      const context = scrubbing
        ? (summary.atLabel ?? formatDayLong(summary.day))
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
        <header className="mb-1">
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
    },
    [isReturns, isPercent, heroText],
  );

  const formatValue = isPercent ? pctFromScaled : isReturns ? formatCentsSigned : formatCents;

  return (
    <ChartFocus
      label="Portfolio"
      defaultRange={defaultRange ?? "ALL"}
      cardClassName="relative"
      // /investments already PARSED ?range= (page.tsx) and then never heard the
      // pill again — every server-fed panel below stayed frozen at "today"
      // while the chart moved. Naming the param is what closes that loop.
      rangeParam="range"
      renderPanel={(opts) => {
        /**
         * The session is deliberately confined to the VALUE view. `returnPoints`
         * is a flow-adjusted DAILY series with a different y-meaning and its own
         * benchmark overlay; giving it intraday points would need a second,
         * flow-adjusted grid. So Return+1D keeps today's sanctioned two-point
         * behaviour — unchanged, not regressed.
         */
        const intraday = isReturns ? null : (session ?? null);
        const show1D = opts.activeRange === "1D" && !isReturns;
        /**
         * The flow-adjusted summarize cannot describe a session, and it fails
         * SILENTLY: it selects days with `d.day >= from`, and an instant sorts
         * after the bare day, so it matched nothing and the header read
         * "$0.00 (+0.00%)" over a line that had visibly moved. Swap it for the
         * plain value delta whenever the session is what is actually drawn.
         */
        const sessionActive = opts.activeRange === "1D" && !isReturns && (intraday?.points.length ?? 0) >= 2;
        const summarizeFn = sessionActive ? sessionSummarize : summarize;
        return (
        // rendered INSIDE renderPanel so the focus modal gets the same lens
        <div>
          {/* Always rendered (unlike the returns-only controls it hosts) so the
              lens switcher never vanishes on a one-day portfolio — and so the
              pr-9 clearance for ChartFocus's top-right focus button is
              unconditional, which is why renderHeader no longer carries it.
              flex-wrap protects the four-control return view on narrow screens. */}
          <div className="mb-3 flex flex-wrap items-center justify-end gap-2 pr-9">
            {canShowReturns && isReturns && !isTable && (
              <BenchmarkPicker value={benchmarkSymbol} hrefFor={hrefForBenchmark} hasData={benchmark != null} />
            )}
            {canShowReturns && isReturns && (
              <ViewSwitcher
                dimension={unitDim}
                value={state[unitDim.key] ?? "dollar"}
                onSelect={(v) => setView(unitDim.key, v)}
                labels={PORTFOLIO_UNIT_LABELS}
                ariaLabel="Return unit"
              />
            )}
            {canShowReturns && (
              <ViewSwitcher
                dimension={viewDim}
                value={isReturns ? "returns" : "value"}
                onSelect={(v) => setView(viewDim.key, v)}
                labels={PORTFOLIO_VIEW_LABELS}
                ariaLabel="Portfolio chart view"
              />
            )}
            <ViewSwitcher
              dimension={LENS_DIMENSION}
              value={isTable ? "table" : "chart"}
              onSelect={(v) => setView(LENS_DIMENSION.key, v)}
              labels={LENS_LABELS}
              ariaLabel="Portfolio lens"
            />
          </div>
          {/* the legends describe overlay LINES, which the table doesn't draw */}
          {!isTable && benchmarkCompare && (
            <BenchmarkLegend
              label={benchmark!.label}
              totalPct={benchmarkTotalPct}
              sinceDay={benchmarkSinceDay}
              youSwatchClass={youSwatchClass}
            />
          )}
          {!isTable && replayCompare && replaySummary && (
            <ReplayLegend
              label={benchmark!.label}
              end={replaySummary}
              sinceDay={returnDays[0]!.day}
              youSwatchClass={youSwatchClass}
            />
          )}
          {isTable ? (
            <ScrubTable
              points={chartPoints}
              today={today}
              range={opts.activeRange}
              onRangeChange={opts.onRangeChange}
              summarize={summarizeFn}
              renderHeader={renderHeader}
              formatValue={formatValue}
              valueHeader={isReturns ? "Return" : "Value"}
              subject={isReturns ? "Portfolio return by day" : "Portfolio value by day"}
              emptyState="No portfolio history yet."
              session={intraday}
            />
          ) : (
            <ScrubChart
              points={chartPoints}
              today={today}
              defaultRange={defaultRange}
              activeRange={opts.activeRange}
              onRangeChange={opts.onRangeChange}
              heightClass={opts.heightClass}
              summarize={summarizeFn}
              accentOf={accentOf}
              valueText={valueText}
              formatValue={formatValue}
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
              renderHeader={renderHeader}
              session={intraday}
            />
          )}
          {show1D && (
            <SessionNote
              session={intraday}
              pricedSymbols={pricedSymbols}
              totalSymbols={totalSymbols}
              closeOn={closeOn}
              today={today}
            />
          )}
          {(() => {
            // the strip is measured over the range the header names — see statsFor
            const stats = statsFor(opts.activeRange);
            return stats && (stats.bestDay || stats.worstDay) ? (
              <ReturnStatsList stats={stats} isPercent={isPercent} />
            ) : null;
          })()}
          {decomposition && <DecompositionBar decomposition={decomposition} />}
          {footer}
        </div>
        );
      }}
    />
  );
}
