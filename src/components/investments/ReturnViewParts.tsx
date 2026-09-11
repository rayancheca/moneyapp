"use client";

import { useCallback, useMemo } from "react";
import { replayEnd, type ReplayEnd, type ReplayPoint } from "@/lib/benchmark-replay";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { formatDayLong } from "@/lib/format-date";
import type { ChartRange } from "@/lib/chart-range";
import {
  aggregateReturn,
  cumulativeReturns,
  dailyReturns,
  decomposeValue,
  returnStatsInWindow,
  type CumulativeReturnPoint,
  type PortfolioDay,
  type ReturnDayStat,
  type ReturnStats,
  type ValueDecomposition,
} from "@/lib/portfolio-returns";
import type { ScrubPoint, ScrubSummary } from "./ScrubChart";

/**
 * The shared model + fragments behind every flow-adjusted Return view (NS#2 +
 * Robinhood-parity item 1). PortfolioChartPanel and HoldingChartPanel render
 * the same deposit-stripped line, benchmark overlay, best/worst/drawdown stats,
 * and contributions-vs-gains decomposition — this is the single implementation
 * both consume, so the two views can never drift apart. Markup is verbatim from
 * the shipped portfolio hero (byte-identical DOM).
 */

/** the plotted % line stores TWR as basis-points-in-cents (pct × 100) so it rides
 *  ScrubChart's integer-cents machinery; this formats it back to a percentage. */
export const pctFromScaled = (scaledCents: number): string => `${(scaledCents / 100).toFixed(2)}%`;
export const signedPct = (p: number): string => `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;

export interface ReturnBenchmark {
  label: string;
  /** cumulative % aligned 1:1 to the returnDays series */
  pct: (number | null)[];
  /** "what if these flows had bought the benchmark" — aligned 1:1 (item 3) */
  replay?: ReplayPoint[];
}

export interface ReturnViewModel {
  returnLine: CumulativeReturnPoint[];
  /** the plottable return series: $ = cumGain cents, % = TWR × 100 */
  returnPoints: ScrubPoint[];
  /** best/worst day + max drawdown (only when the return view is active) */
  /**
   * The stats strip for a given range — see the docstring on `statsFor` in
   * `useReturnViewModel`. A callback because the active range lives inside
   * `ChartFocus`'s render prop.
   */
  statsFor: (range: ChartRange) => ReturnStats | null;
  /** benchmark overlay on the % line's scale, or undefined when hidden */
  benchmarkCompare: { byDay: Record<string, number | null>; label: string } | undefined;
  benchmarkTotalPct: number | null;
  /** the benchmark's first PRICED day — its cumulative % is measured since here,
   *  which can be LATER than the You line's baseline (2y backfill cap); the legend
   *  names this day instead of claiming "all time". null when the benchmark has no data. */
  benchmarkSinceDay: string | null;
  /** the flow-replay overlay on the $ return line's scale (gain vs gain) */
  replayCompare: { byDay: Record<string, number | null>; label: string } | undefined;
  /** "you'd have $X, Δ $Y" — the replay's ending point vs the actual NAV */
  replaySummary: ReplayEnd | null;
  /** legend swatch for the "You" line, matching the series' own gain/loss accent */
  youSwatchClass: string;
  decomposition: ValueDecomposition | null;
  /** flow-adjusted window return — a mid-window buy never inflates the number */
  summarize: (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]) => ScrubSummary;
}

/**
 * Everything a Return view derives from its PortfolioDay series. The summarize
 * is view-independent (the header shows the SAME honest window return whichever
 * line is drawn); the benchmark only materializes in % framing (a fair %-vs-%
 * read — a $ benchmark would need an assumed matching investment).
 */
export function useReturnViewModel(
  returnDays: readonly PortfolioDay[],
  isReturns: boolean,
  isPercent: boolean,
  benchmark: ReturnBenchmark | null | undefined,
  /** the day the ranges count back from — see `statsFor` */
  today: string,
): ReturnViewModel {
  const returnLine = useMemo(() => cumulativeReturns(returnDays), [returnDays]);
  const returnPoints = useMemo<ScrubPoint[]>(
    () =>
      returnLine.map((p) => ({
        day: p.day,
        valueCents: isPercent ? Math.round(p.cumTwrPct * 100) : p.cumGainCents,
      })),
    [returnLine, isPercent],
  );

  /**
   * The best/worst/drawdown strip, over the days the header's range draws —
   * `returnStatsInWindow` carries the measurement and the reason.
   *
   * ⛔ A CALLBACK, not a value: the active range lives inside `ChartFocus`'s
   * render prop and this hook runs above it. Taking the range as an argument is
   * what lets the strip and the chart read the same one.
   *
   * ⚠️ RANGE only. A drag window is `ScrubChart`'s uncontrolled internal state
   * on these two panels, and the header the strip sits under names the range.
   */
  const statsFor = useCallback(
    (range: ChartRange): ReturnStats | null =>
      isReturns ? returnStatsInWindow(returnDays, today, range) : null,
    [isReturns, returnDays, today],
  );

  const benchmarkCompare = useMemo(() => {
    if (!isPercent || !benchmark) return undefined;
    const byDay: Record<string, number | null> = {};
    returnLine.forEach((p, i) => {
      const v = benchmark.pct[i];
      byDay[p.day] = v === null || v === undefined ? null : Math.round(v * 100);
    });
    return { byDay, label: benchmark.label };
  }, [isPercent, benchmark, returnLine]);
  const benchmarkTotalPct = useMemo(() => {
    if (!benchmark) return null;
    for (let i = benchmark.pct.length - 1; i >= 0; i -= 1) {
      const v = benchmark.pct[i];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }, [benchmark]);
  // the benchmark's baseline day — its % is rebased to its FIRST available close,
  // which (via the 2y backfill cap) can start later than the You line's window.
  const benchmarkSinceDay = useMemo(() => {
    if (!benchmark) return null;
    for (let i = 0; i < benchmark.pct.length; i += 1) {
      const v = benchmark.pct[i];
      if (v !== null && v !== undefined) return returnLine[i]?.day ?? null;
    }
    return null;
  }, [benchmark, returnLine]);

  // "what if these flows had bought the benchmark": the replay's cumulative
  // GAIN rides the $ return line's scale — a money-weighted, flow-identical
  // comparison ($-framing only; the % view carries the buy-and-hold TWR overlay)
  const replayCompare = useMemo(() => {
    if (!isReturns || isPercent || !benchmark?.replay) return undefined;
    const byDay: Record<string, number | null> = {};
    for (const p of benchmark.replay) byDay[p.day] = p.gainCents;
    return { byDay, label: `${benchmark.label} replay` };
  }, [isReturns, isPercent, benchmark]);
  const replaySummary = useMemo(
    () => (benchmark?.replay ? replayEnd(benchmark.replay, returnDays) : null),
    [benchmark, returnDays],
  );

  // the legends' "You" swatch tracks the series' own gain/loss accent (a losing
  // holding draws a red line — a green key would mislabel it)
  const youSwatchClass =
    (returnLine.length > 0 ? returnLine[returnLine.length - 1]!.cumGainCents : 0) >= 0
      ? "bg-positive"
      : "bg-negative";

  // contributions vs returns: Value = the capital you put in + the market's P/L
  // (netContributed + gains == value exactly). The pure lib keeps gross vs net
  // honest once sells exist — sale proceeds are NOT negative contributions.
  const decomposition = useMemo<ValueDecomposition | null>(
    () => (isReturns ? decomposeValue(returnDays) : null),
    [isReturns, returnDays],
  );

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

  return {
    returnLine,
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
  };
}

/** "You / {benchmark} replay: you'd have $X · ahead/behind by $Y · since {day}" —
 *  the $ return view's counterfactual legend. A SIMULATION of the recorded flows
 *  at daily closes, from the series' own baseline day (named, never "all time");
 *  a withdrawal the benchmark couldn't have funded is called out, never hidden. */
export function ReplayLegend({
  label,
  end,
  sinceDay,
  youSwatchClass,
}: {
  label: string;
  end: ReplayEnd;
  /** the replay's baseline (the series' first day) — names the basis window */
  sinceDay: string;
  /** matches the drawn line's gain/loss accent (never a green key on a red line) */
  youSwatchClass: string;
}) {
  const ahead = end.deltaVsActualCents >= 0;
  return (
    <p className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`inline-block h-0.5 w-4 rounded ${youSwatchClass}`} /> You
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-ink-faint" />
        {label} replay
      </span>
      <span className="figures">
        you&rsquo;d have {formatCents(end.valueCents)}
        <span className="font-normal">
          {" "}
          · {formatCents(Math.abs(end.deltaVsActualCents))} {ahead ? "ahead of" : "behind"} you
          {end.shortfallCents > 0 &&
            ` · couldn't fund ${formatCents(end.shortfallCents)} of your withdrawals`}{" "}
          · since {formatDayLong(sinceDay)} · simulated at daily closes
        </span>
      </span>
    </p>
  );
}

/** "You / {benchmark} +X% since {day}" line-color legend above the % return chart.
 *  The benchmark's % is rebased to its first PRICED day (`sinceDay`), which the
 *  2-year backfill cap can push LATER than the You line's window — so the legend
 *  names that basis day instead of claiming "all time" (which would be literally
 *  false and read as a same-window comparison it is not). */
export function BenchmarkLegend({
  label,
  totalPct,
  sinceDay,
  youSwatchClass,
}: {
  label: string;
  totalPct: number | null;
  /** the benchmark's first-priced day; names the basis window (never "all time") */
  sinceDay: string | null;
  /** matches the drawn line's gain/loss accent (never a green key on a red line) */
  youSwatchClass: string;
}) {
  return (
    <p className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`inline-block h-0.5 w-4 rounded ${youSwatchClass}`} /> You
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-ink-faint" />
        {label}
        {totalPct !== null && (
          <span className="figures">
            {" "}
            {signedPct(totalPct)}{" "}
            <span className="font-normal">
              {sinceDay ? `since ${formatDayLong(sinceDay)}` : "all time"}
            </span>
          </span>
        )}
      </span>
    </p>
  );
}

/**
 * Best day / worst day / max drawdown — the stats strip under the return line.
 *
 * ⛔ THE SUPERLATIVE MUST BE THE EXTREME OF THE UNIT ON SCREEN. In "%" framing
 * this printed the biggest DOLLAR day's percentage: on 2026-09-11 /investments
 * read "Best day +5.27% · Wed, Aug 19, 2026" when the best percentage day was
 * +9.99% on Apr 9, 2025, and ETH's holding page understated its worst day as
 * −10.50% against a real −14.95%. Wrong on 11 of 32 holding pages. The date
 * beside the figure was the other ranking's date, so both halves were wrong at
 * once. `returnStats` ranks both ways now and the unit picks the race.
 */
export function ReturnStatsList({ stats, isPercent }: { stats: ReturnStats; isPercent: boolean }) {
  const dayStat = (s: ReturnDayStat): string =>
    isPercent && s.pct !== null ? signedPct(s.pct) : formatCentsSigned(s.returnCents);
  // a day with no prior NAV has no percentage to be ranked by; fall back to the
  // dollar extreme rather than printing "—" over a series that does have moves
  const best = (isPercent ? stats.bestDayPct : null) ?? stats.bestDay;
  const worst = (isPercent ? stats.worstDayPct : null) ?? stats.worstDay;
  return (
    <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-xs">
      <div>
        <dt className="text-ink-faint">Best day</dt>
        <dd className="mt-0.5 figures text-positive">
          {best ? dayStat(best) : "—"}
          {best && <span className="text-ink-faint"> · {formatDayLong(best.day)}</span>}
        </dd>
      </div>
      <div>
        <dt className="text-ink-faint">Worst day</dt>
        <dd className="mt-0.5 figures text-negative">
          {worst ? dayStat(worst) : "—"}
          {worst && <span className="text-ink-faint"> · {formatDayLong(worst.day)}</span>}
        </dd>
      </div>
      <div>
        <dt className="text-ink-faint">Max drawdown</dt>
        <dd className="mt-0.5 figures text-ink">
          {stats.maxDrawdownPct < 0 ? `${stats.maxDrawdownPct.toFixed(2)}%` : "0.00%"}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Value = contributed capital + market gains, as a reconciling stacked bar.
 * With no sells this renders exactly the shipped two-part read. Once sells
 * exist the left figure is honestly relabeled "Net contributed" (put in − taken
 * out, shown with both gross figures) — sale proceeds are not negative
 * contributions, and a trimmed winner can be running entirely on gains (net ≤ 0
 * → the bar is all gains; widths are clamped so it can never render broken).
 */
export function DecompositionBar({ decomposition }: { decomposition: ValueDecomposition }) {
  const { grossContributedCents, withdrawnCents, netContributedCents, gainsCents, valueCents } =
    decomposition;
  const up = gainsCents >= 0;
  const hasSells = withdrawnCents > 0;
  const base = Math.max(up ? netContributedCents : valueCents, 0);
  const extra = Math.abs(gainsCents);
  const total = base + extra;
  const basePct = total > 0 ? Math.min(100, Math.max(0, (base / total) * 100)) : 100;
  const contributedText = hasSells
    ? `${formatCentsSigned(netContributedCents)} is net contributed capital (put in ${formatCents(
        grossContributedCents,
      )}, sells took out ${formatCents(withdrawnCents)})`
    : `${formatCents(grossContributedCents)} is contributed capital`;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-ink-faint">
          Value = {hasSells ? "net contributed" : "contributions"} + market {up ? "gains" : "losses"}
        </span>
        <span className="figures font-medium">{formatCents(valueCents)}</span>
      </div>
      <div
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`Of ${formatCents(valueCents)}, ${contributedText} and ${formatCentsSigned(
          gainsCents,
        )} is market ${up ? "gains" : "losses"}.`}
      >
        <div className="bg-ink-muted" style={{ width: `${basePct}%` }} />
        <div className={up ? "bg-positive" : "bg-negative"} style={{ width: `${100 - basePct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs figures">
        <span className="text-ink-muted">
          {hasSells
            ? `Net contributed ${formatCentsSigned(netContributedCents)} · in ${formatCents(
                grossContributedCents,
              )} · out ${formatCents(withdrawnCents)}`
            : `Contributed ${formatCents(grossContributedCents)}`}
        </span>
        <span className={up ? "text-positive" : "text-negative"}>
          Market {up ? "gains" : "losses"} {formatCentsSigned(gainsCents)}
        </span>
      </div>
    </div>
  );
}
