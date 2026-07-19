"use client";

import { useCallback, useMemo } from "react";
import { ChartFocus } from "@/components/charts/ChartFocus";
import { Icon } from "@/components/shell/Icon";
import type { ChartRange } from "@/lib/chart-range";
import { formatDayLong } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { scrubValueText } from "@/lib/scrub";
import type { BalanceBasis } from "@/db/schema/balances";
import {
  ScrubChart,
  type Accent,
  type ScrubPoint,
  type ScrubSummary,
} from "@/components/investments/ScrubChart";

/**
 * One account's balance history on the ScrubChart (ux-overhaul-plan §7.3). Exact
 * days (anchored / derived-from-transactions) draw solid; carried and unverified
 * days draw dashed — and the scrub SPEAKS the basis of the day it lands on, so
 * the "this level is estimated" honesty survives the move off the old
 * dual-Area BalanceChart. Values arrive already sign-adjusted (owed-frame for
 * liabilities), so a rising line = a rising displayed figure and the delta
 * accent reads correctly for both assets and debts.
 */

export interface BalancePanelPoint {
  day: string;
  /** display cents, already sign-adjusted by the caller (owed-frame for debts) */
  balanceCents: number;
  basis: BalanceBasis;
}

const BASIS_PHRASE: Record<BalanceBasis, string | null> = {
  anchored: null, // exact — no qualifier needed
  derived: null,
  derived_unverified: "estimated",
  carried: "carried forward",
  gap: "gap",
};

/** Exact days are solid; everything else is a dashed, estimated span. */
function isExact(basis: BalanceBasis): boolean {
  return basis === "anchored" || basis === "derived";
}

interface BalanceChartPanelProps {
  points: readonly BalancePanelPoint[];
  today: string;
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

export function BalanceChartPanel({ points, today, defaultRange = "3M" }: BalanceChartPanelProps) {
  const scrubPoints: ScrubPoint[] = useMemo(
    () => points.map((p) => ({ day: p.day, valueCents: p.balanceCents, complete: isExact(p.basis) })),
    [points],
  );
  const basisByDay = useMemo(() => new Map(points.map((p) => [p.day, p.basis] as const)), [points]);

  const summarize = useCallback(
    (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
      const start = slice[startIdx]!.valueCents ?? 0;
      const end = slice[endIdx]!.valueCents ?? 0;
      const deltaCents = end - start;
      const deltaPct = start !== 0 ? (deltaCents / Math.abs(start)) * 100 : null;
      return { day: slice[endIdx]!.day, valueCents: end, deltaCents, deltaPct };
    },
    [],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string => {
      const base = scrubValueText(formatDayLong(summary.day), formatCents(summary.valueCents), summary.deltaPct);
      const phrase = BASIS_PHRASE[basisByDay.get(summary.day) ?? "anchored"];
      return phrase ? `${base} — ${phrase}` : base;
    },
    [basisByDay],
  );

  return (
    <ChartFocus
      label="Balance"
      defaultRange={defaultRange}
      cardClassName="relative"
      renderPanel={(opts) => (
        <ScrubChart
      points={scrubPoints}
      today={today}
      defaultRange={defaultRange}
      activeRange={opts.activeRange}
      onRangeChange={opts.onRangeChange}
      summarize={summarize}
      accentOf={accentOf}
      valueText={valueText}
      formatValue={formatCents}
      showAxes
      selectable
      showExtremes
      ariaLabel="Balance over time — scrub to inspect a day"
      heightClass={opts.heightClass ?? "h-52 sm:h-60"}
      renderHeader={(summary, scrubbing, range) => {
        const accent = accentOf(summary);
        const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
        const context = scrubbing ? formatDayLong(summary.day) : range === "ALL" ? "all time" : range;
        const phrase = BASIS_PHRASE[basisByDay.get(summary.day) ?? "anchored"];
        return (
          <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            {scrubbing && <span className="figures text-ink">{formatCents(summary.valueCents)}</span>}
            <span className={`figures ${ACCENT_TEXT[accent]}`}>
              <span aria-hidden>{arrow} </span>
              {formatCentsSigned(summary.deltaCents)}
              {summary.deltaPct !== null && (
                <span> ({summary.deltaPct >= 0 ? "+" : ""}{summary.deltaPct.toFixed(1)}%)</span>
              )}
            </span>
            <span className="font-normal text-ink-faint">· {context}</span>
            {scrubbing && phrase && <span className="font-normal text-ink-faint">· {phrase}</span>}
            {scrubbing && (
              <span className="text-ink-faint" aria-hidden>
                <Icon name="search" className="size-3" />
              </span>
            )}
          </header>
        );
      }}
        />
      )}
    />
  );
}
