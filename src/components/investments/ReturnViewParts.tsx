"use client";

import { useCallback, useMemo } from "react";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { formatDayLong } from "@/lib/format-date";
import {
  aggregateReturn,
  cumulativeReturns,
  dailyReturns,
  decomposeValue,
  returnStats,
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
}

export interface ReturnViewModel {
  returnLine: CumulativeReturnPoint[];
  /** the plottable return series: $ = cumGain cents, % = TWR × 100 */
  returnPoints: ScrubPoint[];
  /** best/worst day + max drawdown (only when the return view is active) */
  stats: ReturnStats | null;
  /** benchmark overlay on the % line's scale, or undefined when hidden */
  benchmarkCompare: { byDay: Record<string, number | null>; label: string } | undefined;
  benchmarkTotalPct: number | null;
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

  const stats = useMemo(() => (isReturns ? returnStats(returnDays) : null), [isReturns, returnDays]);

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

  return { returnLine, returnPoints, stats, benchmarkCompare, benchmarkTotalPct, decomposition, summarize };
}

/** "You / {benchmark} +X%" line-color legend above the % return chart. */
export function BenchmarkLegend({ label, totalPct }: { label: string; totalPct: number | null }) {
  return (
    <p className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-positive" /> You
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-ink-faint" />
        {label}
        {totalPct !== null && (
          <span className="figures">
            {" "}
            {signedPct(totalPct)} <span className="font-normal">all time</span>
          </span>
        )}
      </span>
    </p>
  );
}

/** Best day / worst day / max drawdown — the stats strip under the return line. */
export function ReturnStatsList({ stats, isPercent }: { stats: ReturnStats; isPercent: boolean }) {
  const dayStat = (s: ReturnDayStat): string =>
    isPercent && s.pct !== null ? signedPct(s.pct) : formatCentsSigned(s.returnCents);
  return (
    <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-xs">
      <div>
        <dt className="text-ink-faint">Best day</dt>
        <dd className="mt-0.5 figures text-positive">
          {stats.bestDay ? dayStat(stats.bestDay) : "—"}
          {stats.bestDay && (
            <span className="text-ink-faint"> · {formatDayLong(stats.bestDay.day)}</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-ink-faint">Worst day</dt>
        <dd className="mt-0.5 figures text-negative">
          {stats.worstDay ? dayStat(stats.worstDay) : "—"}
          {stats.worstDay && (
            <span className="text-ink-faint"> · {formatDayLong(stats.worstDay.day)}</span>
          )}
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
