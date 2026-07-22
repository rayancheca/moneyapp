"use client";

import { useCallback, useMemo } from "react";
import { ChartFocus } from "@/components/charts/ChartFocus";
import { isTableLens, LENS_DIMENSION, LENS_LABELS } from "@/components/charts/chart-lens";
import { ScrubTable, type ScrubTableRow } from "@/components/charts/ScrubTable";
import { Icon } from "@/components/shell/Icon";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import type { Column } from "@/components/ui/DataTable";
import { useViewState } from "@/hooks/useViewState";
import { ACCOUNT_SURFACE, ACCOUNT_VIEW_SPEC } from "./accounts-view-spec";
import type { ViewState } from "@/lib/view-state";
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
  /** the RSC-resolved active view (URL > persisted > default) */
  viewState: ViewState;
  /** this account's own route (the lens switcher navigates within it) */
  basePath: string;
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

/** stable identity so useViewState's setView doesn't churn every render */
const EMPTY_PARAMS: Record<string, string> = {};

export function BalanceChartPanel({
  points,
  today,
  defaultRange = "3M",
  viewState,
  basePath,
}: BalanceChartPanelProps) {
  const { state, setView } = useViewState({
    surface: ACCOUNT_SURFACE,
    spec: ACCOUNT_VIEW_SPEC,
    state: viewState,
    basePath,
    baseParams: EMPTY_PARAMS,
  });
  const isTable = isTableLens(state);
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

  // ONE header for both lenses — the table's readout is literally the chart's
  const renderHeader = useCallback(
    (summary: ScrubSummary, scrubbing: boolean, range: ChartRange) => {
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
    },
    [basisByDay],
  );

  // the chart draws estimated days dashed; the table must say so in words, or
  // the numbers read as exact when the line never claimed they were
  const basisColumn = useMemo<Column<ScrubTableRow>[]>(
    () => [
      {
        key: "basis",
        header: "Basis",
        render: (r) => {
          const phrase = BASIS_PHRASE[basisByDay.get(r.point.day) ?? "anchored"];
          return phrase ? (
            <span className="text-ink-faint">{phrase}</span>
          ) : (
            <span className="text-ink-faint">exact</span>
          );
        },
      },
    ],
    [basisByDay],
  );

  return (
    <ChartFocus
      label="Balance"
      defaultRange={defaultRange}
      cardClassName="relative"
      renderPanel={(opts) => (
        // rendered INSIDE renderPanel so the focus modal gets the same lens
        <div>
          {/* pr-9 clears ChartFocus's absolute top-right focus button */}
          <div className="mb-3 flex justify-end pr-9">
            <ViewSwitcher
              dimension={LENS_DIMENSION}
              value={isTable ? "table" : "chart"}
              onSelect={(v) => setView(LENS_DIMENSION.key, v)}
              labels={LENS_LABELS}
              // "…lens" everywhere: on the investments panels "…chart view" is
              // already taken by the Value⇄Return dimension, a different concept
              ariaLabel="Balance lens"
            />
          </div>
          {isTable ? (
            <ScrubTable
              points={scrubPoints}
              today={today}
              range={opts.activeRange}
              onRangeChange={opts.onRangeChange}
              summarize={summarize}
              renderHeader={renderHeader}
              formatValue={formatCents}
              valueHeader="Balance"
              subject="Balance by day"
              extraColumns={basisColumn}
              ownsCompleteness
              emptyState="No balance history yet."
            />
          ) : (
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
              renderHeader={renderHeader}
            />
          )}
        </div>
      )}
    />
  );
}
