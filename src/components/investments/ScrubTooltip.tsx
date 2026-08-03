import { coverageLabel } from "@/lib/coverage-label";
import { formatDayLong } from "@/lib/format-date";
import { formatCentsSigned } from "@/lib/money";

/**
 * The vivid net-worth chart's floating readout (§7.1). Recharts calls the
 * `<Tooltip content>` with `{ active, payload, label }`; ScrubChart injects the
 * window baseline + value formatter via closure. Pure presentation — a portalled
 * HTML card (not SVG) so it can use the design-system surface, shadow, and the
 * `fade-rise` entrance. Only rendered on pointer (non-touch) hover; on touch the
 * header swap is the readout instead (the finger covers the point).
 */

export interface VividChartRow {
  day: string;
  /** 1D intraday only: the server-formatted label for this point's instant.
   *  `day` then holds an instant, which formatDayLong correctly refuses. */
  atLabel?: string;
  lineValue: number | null;
  fillValue: number | null;
  /** every account covered that day */
  complete: boolean;
  /** the prior day's value, for the day-over-day delta; null at the window start */
  prevValue: number | null;
  /** accounts with no coverage that day — named so "partial" says exactly which */
  missingAccounts?: string[];
  /** accounts WITH coverage that day — lets an early day say "only Chase ····3522" */
  coveredAccountNames?: string[];
  /** signed in-flight correction on this day (docs/inflight-dips.md): positive =
   *  money in transit added back, negative = a removed transfer double-post */
  inTransitCents?: number;
}

interface TooltipPayloadEntry {
  payload?: VividChartRow;
  value?: number | null;
}

interface ScrubTooltipProps {
  active?: boolean;
  payload?: readonly TooltipPayloadEntry[];
  /** window-start value the Δ measures from */
  baselineCents: number | null;
  /** whether the window-start point is fully covered (gates the honest %) */
  baselineComplete: boolean;
  formatValue: (cents: number) => string;
  /** overlay lines' values on this day (dashboard view modes) — color-dotted rows */
  overlayRows?: readonly { key: string; label: string; color: string; valueCents: number | null }[];
  /** amount-owed frame: a positive delta is debt GROWING (bad) → flip tone/arrow */
  owedFrame?: boolean;
}

export function ScrubTooltip({
  active,
  payload,
  baselineCents,
  baselineComplete,
  formatValue,
  overlayRows,
  owedFrame = false,
}: ScrubTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row || row.lineValue === null) return null;

  const value = row.lineValue;
  const deltaStart = baselineCents === null ? null : value - baselineCents;
  // an honest % needs both ends fully covered and a non-zero base (matches the
  // header's suppression rule so the card never states a fabricated percentage)
  const pct =
    deltaStart !== null && baselineCents !== null && baselineCents !== 0 && row.complete && baselineComplete
      ? (deltaStart / Math.abs(baselineCents)) * 100
      : null;
  const dayOverDay = row.prevValue === null ? null : value - row.prevValue;
  // owed frame: a positive delta is debt GROWING — bad — so "good" is a shrink.
  // `gainSign` is +1 in the asset frame, −1 in the owed frame; a delta times it
  // being >0 means the change was good (green ▲), <0 bad (red ▼).
  const gainSign = owedFrame ? -1 : 1;
  const toneOf = (d: number | null): string =>
    d === null || d === 0 ? "text-ink-muted" : d * gainSign > 0 ? "text-positive" : "text-negative";
  const arrowOf = (d: number | null): string => (d === null || d === 0 ? "•" : d > 0 ? "▲" : "▼");
  const deltaTone = toneOf(deltaStart);
  const arrow = arrowOf(deltaStart);
  // partial days: name whichever list is more concise (covered vs missing)
  const coverage = coverageLabel(row.coveredAccountNames ?? [], row.missingAccounts ?? []);

  return (
    <div className="animate-fade-rise w-[200px] rounded-lg border border-line bg-surface-raised px-3 py-2 shadow-(--shadow-overlay)">
      <p className="text-[11px] text-ink-muted">{row.atLabel ?? formatDayLong(row.day)}</p>
      <p className="figures mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{formatValue(value)}</p>
      {deltaStart !== null && (
        <div className="mt-1">
          {/* value+% on one line; the qualifier on its own micro-line so a long
              delta never orphans a word inside the fixed-width card */}
          <p className={`figures text-xs font-medium ${deltaTone}`}>
            <span aria-hidden>{arrow} </span>
            {formatCentsSigned(deltaStart)}
            {pct !== null && <span> ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)</span>}
          </p>
          <p className="text-[10px] text-ink-faint">since window start</p>
        </div>
      )}
      {dayOverDay !== null && dayOverDay !== 0 && (
        <p className="figures mt-1 text-[11px] text-ink-faint">
          {formatCentsSigned(dayOverDay)} vs prev day
        </p>
      )}
      {!row.complete && (
        <p className="mt-1 text-[11px] text-warning">
          ● Partial
          {coverage && (
            <span className="text-ink-faint"> · {coverage.kind} {coverage.text}</span>
          )}
        </p>
      )}
      {(row.inTransitCents ?? 0) !== 0 && (
        <p className="mt-1 text-[11px] text-ink-faint">
          {row.inTransitCents! > 0
            ? `⇄ Includes ${formatValue(row.inTransitCents!)} in transit`
            : `⇄ Excludes ${formatValue(-row.inTransitCents!)} posted in two accounts`}
        </p>
      )}
      {overlayRows && overlayRows.length > 0 && (
        <div className="mt-1 border-t border-line pt-1">
          {overlayRows.map((o) => (
            <p key={o.key} className="figures flex items-center gap-1.5 text-[11px] text-ink-muted">
              <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: o.color }} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              <span>{o.valueCents === null ? "—" : formatValue(o.valueCents)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
