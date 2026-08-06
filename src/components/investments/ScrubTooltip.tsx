import {
  coveragePhrase,
  formatNameList,
  openingLabel,
  sharedCoverageChange,
  type AccountOpening,
  type DayCoverage,
} from "@/lib/coverage-label";
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
  /** those accounts' own balances, aligned to the names above — the % compares
   *  only the accounts this day and the window start BOTH cover */
  coveredCents?: number[];
  /** uncovered accounts whose history starts later — not a defect */
  notYetOpen?: AccountOpening[];
  /** uncovered accounts that were already open — the real hole */
  gapAccounts?: string[];
  /** how many accounts exist, so a partial % can name its scope */
  totalAccounts?: number;
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
  /** the window-start point's coverage — which accounts its total can see. It
   *  decides whether an honest % exists and what it is measured over. */
  baselineCoverage: DayCoverage;
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
  baselineCoverage,
  formatValue,
  overlayRows,
  owedFrame = false,
}: ScrubTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row || row.lineValue === null) return null;

  const value = row.lineValue;
  const deltaStart = baselineCents === null ? null : value - baselineCents;
  // an honest % compares the accounts BOTH ends cover, and names the ones it had
  // to drop — the same single rule the header uses, so the card and the headline
  // can never state two different percentages of the same window
  const change =
    baselineCents === null
      ? { pct: null, scope: null, deltaCents: null }
      : sharedCoverageChange({ cents: baselineCents, coverage: baselineCoverage }, { cents: value, coverage: row });
  const pct = deltaStart === null ? null : change.pct;
  // print the dollar change over the SAME accounts as the percentage — pairing a
  // shared-scope % with an all-account $ makes the two contradict each other
  const deltaShown = pct === null ? deltaStart : (change.deltaCents ?? deltaStart);
  const dayOverDay = row.prevValue === null ? null : value - row.prevValue;
  // owed frame: a positive delta is debt GROWING — bad — so "good" is a shrink.
  // `gainSign` is +1 in the asset frame, −1 in the owed frame; a delta times it
  // being >0 means the change was good (green ▲), <0 bad (red ▼).
  const gainSign = owedFrame ? -1 : 1;
  const toneOf = (d: number | null): string =>
    d === null || d === 0 ? "text-ink-muted" : d * gainSign > 0 ? "text-positive" : "text-negative";
  const arrowOf = (d: number | null): string => (d === null || d === 0 ? "•" : d > 0 ? "▲" : "▼");
  // tone and arrow follow the figure actually printed, so a shared-scope delta
  // that moved the other way cannot show a green ▲ over a negative number
  const deltaTone = toneOf(deltaShown);
  const arrow = arrowOf(deltaShown);
  // a partial day has two possible causes and only one of them is a defect:
  // accounts that had not opened yet (neutral) vs a day no statement covers
  const notYetOpen = row.notYetOpen ?? [];
  const gapAccounts = row.gapAccounts ?? [];
  const opening = notYetOpen.length > 0 ? openingLabel(row.coveredAccountNames ?? [], notYetOpen) : null;
  // "9/10 accounts open · Cash on Hand opens Aug 3, 2026" — the count is of the
  // accounts that EXISTED that day, and it is dropped on a series that never
  // said how many there are rather than guessed at
  const openLine =
    notYetOpen.length === 0
      ? null
      : [
          row.totalAccounts === undefined
            ? null
            : `${row.totalAccounts - notYetOpen.length}/${row.totalAccounts} accounts open`,
          opening ? coveragePhrase(opening) : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ");

  return (
    <div className="animate-fade-rise w-[200px] rounded-lg border border-line bg-surface-raised px-3 py-2 shadow-(--shadow-overlay)">
      <p className="text-[11px] text-ink-muted">{row.atLabel ?? formatDayLong(row.day)}</p>
      <p className="figures mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{formatValue(value)}</p>
      {deltaShown !== null && (
        <div className="mt-1">
          {/* value+% on one line; the qualifier on its own micro-line so a long
              delta never orphans a word inside the fixed-width card */}
          <p className={`figures text-xs font-medium ${deltaTone}`}>
            <span aria-hidden>{arrow} </span>
            {formatCentsSigned(deltaShown)}
            {pct !== null && <span> ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)</span>}
          </p>
          {/* the scope of the % lives on the qualifier line: the card is 200px
              wide, so "excl. Cash on Hand, opened Aug 3, 2026" cannot ride
              beside the number — but it must never be dropped either */}
          <p className="text-[10px] text-ink-faint">
            since window start{pct !== null && change.scope ? ` · ${change.scope}` : ""}
          </p>
        </div>
      )}
      {dayOverDay !== null && dayOverDay !== 0 && (
        <p className="figures mt-1 text-[11px] text-ink-faint">
          {formatCentsSigned(dayOverDay)} vs prev day
        </p>
      )}
      {/* pre-start: nothing is lost, so no dot and no warning colour */}
      {openLine && <p className="mt-1 text-[11px] text-ink-faint">{openLine}</p>}
      {gapAccounts.length > 0 && (
        <p className="mt-1 text-[11px] text-warning">
          ● No data
          <span className="text-ink-faint"> · {formatNameList(gapAccounts)}</span>
        </p>
      )}
      {/* a series that flags a day partial without naming a cause (no coverage
          detail at all) keeps the blunt old chip — silence would be worse */}
      {!row.complete && notYetOpen.length === 0 && gapAccounts.length === 0 && (
        <p className="mt-1 text-[11px] text-warning">● Partial</p>
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
