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
  returnStats,
  type PortfolioDay,
  type ReturnDayStat,
} from "@/lib/portfolio-returns";
import { scrubValueText } from "@/lib/scrub";
import { ScrubChart, type Accent, type ScrubPoint, type ScrubSummary } from "./ScrubChart";
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
 * drawdown stats.
 *
 * The window return is flow-adjusted — computed here from the PortfolioDay series
 * with the pure return lib (no server code in the client bundle), so a mid-window
 * buy never inflates the number. The RETURN view plots the cumulative flow-
 * adjusted line (deposits stripped, à la Robinhood): dollars = cumulative P/L,
 * percent = compounding TWR. The header math is identical to the value view, so
 * the views always agree.
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
  benchmark?: { label: string; pct: (number | null)[] } | null;
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

/** the plotted % line stores TWR as basis-points-in-cents (pct × 100) so it rides
 *  ScrubChart's integer-cents machinery; this formats it back to a percentage. */
const pctFromScaled = (scaledCents: number): string => `${(scaledCents / 100).toFixed(2)}%`;
const signedPct = (p: number): string => `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;

export function PortfolioChartPanel({
  points,
  returnDays,
  today,
  defaultRange,
  viewState,
  baseParams,
  benchmark,
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
  const active = state[viewDim.key] ?? "value";
  const isReturns = active === "returns";
  const isPercent = isReturns && state[unitDim.key] === "percent";

  // the RETURN line: cumulative flow-adjusted P/L (deposits removed), aligned 1:1
  // with the value series so the same range slicing + scrub applies. Dollar view
  // plots cumGain cents; percent view plots TWR × 100 (basis-points-in-cents).
  const returnLine = useMemo(() => cumulativeReturns(returnDays), [returnDays]);
  const returnPoints = useMemo<ScrubPoint[]>(
    () =>
      returnLine.map((p) => ({
        day: p.day,
        valueCents: isPercent ? Math.round(p.cumTwrPct * 100) : p.cumGainCents,
      })),
    [returnLine, isPercent],
  );
  const chartPoints = isReturns ? returnPoints : points;

  // best/worst day + worst drawdown (all-time) — the "cool stats" under the line
  const stats = useMemo(() => (isReturns ? returnStats(returnDays) : null), [isReturns, returnDays]);

  // "you vs the market": overlay the benchmark's cumulative % on the % line (fair
  // %-vs-% comparison — a $ benchmark needs an assumed matching investment, so we
  // only draw it in percent framing). Same scale as the % line (pct × 100).
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

  // contributions vs returns: Value = the capital you put in + the market's P/L.
  // contributed = the baseline NAV + every later net flow; gains = cumulative P/L;
  // the two sum to today's value — the literal "returns in relation to the value".
  const decomposition = useMemo(() => {
    if (!isReturns || returnLine.length === 0) return null;
    const first = returnLine[0]!;
    const last = returnLine.at(-1)!;
    const contributedCents = first.navCents + last.cumNetFlowCents;
    const gainsCents = last.cumGainCents;
    return { contributedCents, gainsCents, valueCents: last.navCents };
  }, [isReturns, returnLine]);

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

  const dayStat = (s: ReturnDayStat): string =>
    isPercent && s.pct !== null ? signedPct(s.pct) : formatCentsSigned(s.returnCents);

  return (
    <div>
      <div className="mb-3 flex items-center justify-end gap-2">
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
          value={active}
          onSelect={(v) => setView(viewDim.key, v)}
          labels={PORTFOLIO_VIEW_LABELS}
          ariaLabel="Portfolio chart view"
        />
      </div>
      {benchmarkCompare && (
        <p className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-positive" /> You
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-ink-faint" />
            {benchmark!.label}
            {benchmarkTotalPct !== null && <span className="figures"> {signedPct(benchmarkTotalPct)}</span>}
          </span>
        </p>
      )}
      <ScrubChart
        points={chartPoints}
        today={today}
        defaultRange={defaultRange}
        summarize={summarize}
        accentOf={accentOf}
        valueText={valueText}
        formatValue={isPercent ? pctFromScaled : isReturns ? formatCentsSigned : formatCents}
        {...(isPercent ? { formatExtreme: pctFromScaled } : {})}
        {...(benchmarkCompare ? { compareLine: benchmarkCompare } : {})}
        showExtremes={isReturns}
        ariaLabel={
          isReturns
            ? "Portfolio return over time — scrub to inspect a day"
            : "Portfolio value over time — scrub to inspect a day"
        }
        renderHeader={(summary, scrubbing, range) => {
          const accent = accentOf(summary);
          const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
          const context = scrubbing ? formatDayLong(summary.day) : range === "ALL" ? "all time" : range;
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
        }}
      />
      {stats && (stats.bestDay || stats.worstDay) && (
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
      )}
      {decomposition &&
        (() => {
          const gain = decomposition.gainsCents;
          const up = gain >= 0;
          const base = up ? decomposition.contributedCents : decomposition.valueCents;
          const extra = Math.abs(gain);
          const total = base + extra;
          const basePct = total > 0 ? (base / total) * 100 : 100;
          return (
            <div className="mt-4 border-t border-line pt-3">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-faint">
                  Value = contributions + market {up ? "gains" : "losses"}
                </span>
                <span className="figures font-medium">{formatCents(decomposition.valueCents)}</span>
              </div>
              <div
                className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-sunken"
                role="img"
                aria-label={`Of ${formatCents(decomposition.valueCents)}, ${formatCents(
                  decomposition.contributedCents,
                )} is contributed capital and ${formatCentsSigned(gain)} is market ${up ? "gains" : "losses"}.`}
              >
                <div className="bg-ink-muted" style={{ width: `${basePct}%` }} />
                <div className={up ? "bg-positive" : "bg-negative"} style={{ width: `${100 - basePct}%` }} />
              </div>
              <div className="mt-1.5 flex justify-between text-xs figures">
                <span className="text-ink-muted">Contributed {formatCents(decomposition.contributedCents)}</span>
                <span className={up ? "text-positive" : "text-negative"}>
                  Market {up ? "gains" : "losses"} {formatCentsSigned(gain)}
                </span>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
