"use client";

import { useCallback, useMemo } from "react";
import { ChartFocus } from "@/components/charts/ChartFocus";
import { isTableLens, LENS_DIMENSION, LENS_LABELS } from "@/components/charts/chart-lens";
import { ScrubTable, type ScrubTableRow } from "@/components/charts/ScrubTable";
import type { Column } from "@/components/ui/DataTable";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { viewHrefQuery, type ViewState } from "@/lib/view-state";
import { DEFAULT_BENCHMARK } from "@/lib/benchmark-symbol";
import type { ChartRange } from "@/lib/chart-range";
import { carriedFromDay } from "@/lib/price-series";
import { formatDayLong } from "@/lib/format-date";
import { type SessionChartView } from "@/lib/intraday-axis";
import { SessionNote } from "./SessionNote";
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
  /** this holding's own intraday session in per-share cents, already windowed
   *  and labelled by the RSC; null when it has not ticked today */
  session?: SessionChartView | null;
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
  session,
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
  // the chart⇄table lens — orthogonal to view/unit (the table shows whichever
  // metric those select). Deliberately NOT folded into resetRangeKey or the
  // ScrubChart key below: both must stay a pure function of isReturns, or a
  // lens toggle would silently reset the range pill / drop the drag window.
  const isTable = isTableLens(state);

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
      /*
       * 🔴 "+$4,468.50, down 5.9%" — the dollars are the window's flow-adjusted
       * gain and the percentage is its TIME-WEIGHTED return, and they can point
       * opposite ways: MSFT on 2026-09-03 was $4,468.50 up on money mostly put
       * in at lower prices, over a span in which the price itself fell 5.95%.
       * Both true; unnamed, they read as one figure contradicting itself. In
       * the return-$ lens the percentage is named; in the price lens it IS the
       * price change and needs no name.
       */
      const base = isReturns
        ? `${scrubValueText(summary.atLabel ?? formatDayLong(summary.day), heroText(summary), null)}${
            !isPercent && summary.deltaPct !== null ? `, ${signedPct(summary.deltaPct)} time-weighted` : ""
          }`
        : scrubValueText(summary.atLabel ?? formatDayLong(summary.day), heroText(summary), summary.deltaPct);
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
      const accent = accentOf(summary);
      const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
      // the return baseline is the first day the position was held AND
      // priced — earlier appreciation is not measured, so never say "all
      // time"; name the basis day instead
      const context = scrubbing
        ? (summary.atLabel ?? formatDayLong(summary.day))
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
              ? `(${signedPct(summary.deltaPct)} time-weighted)`
              : "";
      return (
        <header className="mb-1">
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
    },
    [isReturns, isPercent, heroText, returnDays],
  );

  // the price chart pins buy/sell marks on the line; the table names them in a
  // column so a trade day is as visible in rows as it is on the plot
  const markByDay = useMemo(() => new Map(marks.map((m) => [m.day, m.kind] as const)), [marks]);
  const tradeColumn = useMemo<Column<ScrubTableRow>[]>(
    () => [
      {
        key: "trade",
        header: "Trade",
        render: (r) => {
          const kind = markByDay.get(r.point.day);
          return kind ? (
            <span className={kind === "buy" ? "text-positive" : "text-negative"}>
              {kind === "buy" ? "Buy" : "Sell"}
            </span>
          ) : (
            <span className="text-ink-faint">—</span>
          );
        },
      },
    ],
    [markByDay],
  );

  const formatValue = isPercent ? pctFromScaled : isReturns ? formatCentsSigned : formatCents;

  return (
    <ChartFocus
      label="Holding"
      defaultRange="ALL"
      cardClassName="relative"
      resetRangeKey={isReturns ? "returns" : "price"}
      renderPanel={(opts) => {
        // same restriction as the portfolio panel: the session is per-SHARE
        // cents, which is what the PRICE view's y-axis already means; the
        // flow-adjusted return series is a different quantity entirely
        const intraday = isReturns ? null : (session ?? null);
        const show1D = opts.activeRange === "1D" && !isReturns;
        const sessionActive = show1D && (intraday?.points.length ?? 0) >= 2;
        return (
        // rendered INSIDE renderPanel so the focus modal gets the same lens
        <div>
          {/* Always rendered (unlike the returns-only controls it hosts) so the
              lens switcher never vanishes on a thin holding — and so the pr-9
              clearance for ChartFocus's top-right focus button is unconditional,
              which is why renderHeader no longer carries it. flex-wrap protects
              the four-control return view on narrow screens. */}
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
                labels={HOLDING_VIEW_LABELS}
                ariaLabel="Holding chart view"
              />
            )}
            <ViewSwitcher
              dimension={LENS_DIMENSION}
              value={isTable ? "table" : "chart"}
              onSelect={(v) => setView(LENS_DIMENSION.key, v)}
              labels={LENS_LABELS}
              ariaLabel="Holding lens"
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
              // the price/return series are not day-aligned; the range is reset
              // by ChartFocus's resetRangeKey on a view switch, same as the chart
              points={chartPoints}
              today={today}
              range={opts.activeRange}
              onRangeChange={opts.onRangeChange}
              summarize={summarize}
              renderHeader={renderHeader}
              formatValue={formatValue}
              valueHeader={isReturns ? "Return" : "Close"}
              subject={isReturns ? `${symbol} return by day` : `${symbol} close by day`}
              {...(isReturns ? {} : { extraColumns: tradeColumn })}
              emptyState="No price history yet."
              session={intraday}
            />
          ) : (
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
              formatValue={formatValue}
              {...(isPercent ? { formatExtreme: pctFromScaled } : {})}
              {...(compareLine ? { compareLine } : {})}
              showExtremes={isReturns}
              showAxes
              selectable
              marks={isReturns ? [] : marks}
              // Avg cost joins the y-domain, and over ONE session that ruins the
              // scale: a $150 basis against a $245 price stretches the axis to
              // $100–$250 and squashes the day's whole 3.5% move into the top
              // sliver of the plot. It is a long-run reference; a day view is not
              // the run it references.
              refLine={
                !isReturns && !sessionActive && avgCostCents !== null
                  ? { cents: avgCostCents, label: "Avg cost" }
                  : null
              }
              ariaLabel={
                isReturns
                  ? `${symbol} return over time — scrub to inspect a day`
                  : `${symbol} price over time — scrub to inspect a day`
              }
              renderHeader={renderHeader}
              session={intraday}
            />
          )}
          {show1D && (
            <SessionNote session={intraday} pricedSymbols={1} totalSymbols={1} />
          )}
          {stats && (stats.bestDay || stats.worstDay) && <ReturnStatsList stats={stats} isPercent={isPercent} />}
          {decomposition && <DecompositionBar decomposition={decomposition} />}
        </div>
        );
      }}
    />
  );
}
