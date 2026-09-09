"use client";

import { useCallback, useMemo } from "react";
import { Icon } from "@/components/shell/Icon";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { DAILY_SERIES_RANGES, type ChartRange } from "@/lib/chart-range";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { scrubValueText } from "@/lib/scrub";
import type { NetWorthPoint } from "@/services/derivation";
import { useDashboardWindowProps } from "@/components/dashboard/DashboardWindowContext";
import {
  ScrubChart,
  type Accent,
  type ScrubPoint,
  type ScrubSummary,
} from "@/components/investments/ScrubChart";
import {
  coveragePhrase,
  formatNameList,
  openAccountsPhrase,
  openingLabel,
  sharedCoverageChange,
} from "@/lib/coverage-label";

/**
 * Net worth adoption of the ScrubChart (ux-overhaul-plan §7.1). The Stage-4
 * chart already breaks the line on `complete: false`; here every day carries a
 * total but some are partial-coverage — so we thread `complete` through, the
 * chart draws those spans dashed, and the scrub announces the coverage so the
 * honesty is spoken, not just drawn. The window return is a plain value delta
 * (net worth has no flows to adjust for).
 *
 * WHICH partial, though: a day before an account opened says "9/10 accounts open
 * · Cash on Hand opens Aug 3, 2026" in the faint tone, and only a day no
 * statement covers keeps the warning ("no statement for Discover on this date").
 * The percentage is measured over the accounts both window ends cover and names
 * what it dropped — see lib/coverage-label, which owns both rules.
 */

/** dashboard points carry the in-flight correction (docs/inflight-dips.md);
 *  standalone renders without it stay byte-identical (the field is optional) */
type PanelPoint = NetWorthPoint & { inTransitCents?: number };

interface NetWorthChartPanelProps {
  points: readonly PanelPoint[];
  today: string;
  defaultRange?: ChartRange;
  /** override the chart height (the S8 focus modal renders it taller) */
  heightClass?: string;
  /** lift the range pills to a parent (ChartFocus shares one range between the
   * inline card and the focus modal) — optional, pass-through to ScrubChart */
  activeRange?: ChartRange;
  onRangeChange?: (range: ChartRange) => void;
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

export function NetWorthChartPanel({
  points,
  today,
  defaultRange = "1Y",
  heightClass = "h-64 sm:h-72",
  activeRange,
  onRangeChange,
}: NetWorthChartPanelProps) {
  const windowProps = useDashboardWindowProps();
  const scrubPoints: ScrubPoint[] = useMemo(
    () =>
      points.map((p) => ({
        day: p.day,
        valueCents: p.totalCents,
        complete: p.complete,
        missingAccounts: p.missingAccounts,
        coveredAccountNames: p.coveredAccountNames,
        coveredCents: p.coveredCents,
        notYetOpen: p.notYetOpen,
        gapAccounts: p.gapAccounts,
        totalAccounts: p.totalAccounts,
        inTransitCents: p.inTransitCents,
      })),
    [points],
  );
  const coverageByDay = useMemo(
    () => new Map(points.map((p) => [p.day, p] as const)),
    [points],
  );

  const summarize = useCallback(
    (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
      const startPoint = slice[startIdx]!;
      const endPoint = slice[endIdx]!;
      const start = startPoint.valueCents ?? 0;
      const end = endPoint.valueCents ?? 0;
      // A partial-coverage endpoint covers fewer accounts, so a % against the raw
      // totals would be a fabricated number (the "40k→3→90" artifact the graph
      // must never lie about). The fix is to compare like with like rather than
      // to say nothing: sharedCoverageChange measures only the accounts BOTH ends
      // cover and hands back the scope it measured, which the header prints next
      // to the number. A genuine interior gap still suppresses entirely.
      const change = sharedCoverageChange(
        { cents: start, coverage: startPoint },
        { cents: end, coverage: endPoint },
      );
      return {
        day: endPoint.day,
        valueCents: end,
        // the dollar figure must describe the SAME accounts as the percentage
        // beside it — otherwise dividing one by the other yields a third number
        // true of nothing, which is the fabricated-figure problem relocated
        // rather than fixed
        deltaCents: change.deltaCents ?? end - start,
        deltaPct: change.pct,
        deltaPctScope: change.scope,
      };
    },
    [],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string => {
      const base = scrubValueText(formatDayLong(summary.day), formatCents(summary.valueCents), summary.deltaPct);
      // a percentage measured over some of the accounts must SAY so out loud too,
      // or the spoken headline is the one place the number reads as the whole
      const scope = summary.deltaPct !== null && summary.deltaPctScope ? `, ${summary.deltaPctScope}` : "";
      const cov = coverageByDay.get(summary.day);
      // the in-flight note must be SPOKEN, not just drawn (docs/inflight-dips.md)
      const transit = cov?.inTransitCents ?? 0;
      const transitSuffix =
        transit > 0
          ? ` — includes ${formatCents(transit)} in transit`
          : transit < 0
            ? ` — excludes ${formatCents(-transit)} posted in two accounts`
            : "";
      if (!cov || cov.complete) return `${base}${scope}${transitSuffix}`;
      // untruncated (no "+N more") so the spoken description names every account
      const opening = openingLabel(cov.coveredAccountNames, cov.notYetOpen, Number.MAX_SAFE_INTEGER);
      // an account that had not opened yet is spoken as a fact about the calendar,
      // never as lost data — the missing statement below is the only defect here
      /* ⛔ `openAccountsPhrase`, not `total - notYetOpen`: an account holding
         nothing at all is in neither bucket, and counting it as open put this
         one ahead of its own covered total on 1,440 days. */
      const openPhrase = openAccountsPhrase(
        {
          totalAccounts: cov.totalAccounts,
          notYetOpenCount: cov.notYetOpen.length,
          emptyCount: cov.emptyAccounts.length,
        },
        "were open",
      );
      const openClause =
        openPhrase === null ? "" : ` — ${openPhrase}` + (opening ? `; ${coveragePhrase(opening)}` : "");
      const gapClause =
        cov.gapAccounts.length > 0
          ? ` — no statement covers ${formatNameList(cov.gapAccounts, Number.MAX_SAFE_INTEGER)} on this day`
          : "";
      return `${base}${scope}${openClause}${gapClause}${transitSuffix}`;
    },
    [coverageByDay],
  );

  // When wrapped in a DashboardWindowProvider, lift the brush/zoom window to the
  // shared history stack so back/forward + the linked activity panel can drive it
  // (dashboard-dynamic §1) — the shared hook makes every hero panel consistent.
  return (
    <ScrubChart
      {...windowProps}
      points={scrubPoints}
      today={today}
      defaultRange={defaultRange}
      activeRange={activeRange}
      ranges={DAILY_SERIES_RANGES}
      onRangeChange={onRangeChange}
      showAxes
      selectable
      showExtremes
      vivid
      summarize={summarize}
      accentOf={accentOf}
      valueText={valueText}
      formatValue={formatCents}
      ariaLabel="Net worth over time — scrub to inspect a day, drag to zoom a range"
      heightClass={heightClass}
      renderHeader={(summary, scrubbing, range, customWindow) => {
        const accent = accentOf(summary);
        const arrow = accent === "gain" ? "▲" : accent === "loss" ? "▼" : "•";
        const context = scrubbing
          ? formatDayLong(summary.day)
          : customWindow
            ? `${formatDayShort(customWindow.start)} – ${formatDayShort(customWindow.end)}`
            : range === "ALL"
              ? "all time"
              : range;
        const cov = coverageByDay.get(summary.day);
        const opening = cov && cov.notYetOpen.length > 0 ? openingLabel(cov.coveredAccountNames, cov.notYetOpen) : null;
        // spoken subtly whenever the summarized day is bridged — while
        // scrubbing that is the scrubbed day (on touch the header IS the
        // readout), and at rest it is the window's latest day, so an in-air
        // transfer covering today is explained without any interaction
        // (2026-07-18 adversarial review)
        const transit = cov?.inTransitCents ?? 0;
        return (
          <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            {scrubbing && (
              <NumberRoll value={formatCents(summary.valueCents)} className="text-ink" />
            )}
            <span className={`inline-flex items-center gap-1 ${ACCENT_TEXT[accent]}`}>
              <span aria-hidden>{arrow}</span>
              <NumberRoll value={formatCentsSigned(summary.deltaCents)} />
              {summary.deltaPct !== null && (
                // the scope rides INSIDE the parentheses, so the % and the set it
                // was measured over can never be read apart from each other
                <span className="figures">
                  ({summary.deltaPct >= 0 ? "+" : ""}{summary.deltaPct.toFixed(1)}%
                  {summary.deltaPctScope && (
                    <span className="font-normal text-ink-faint"> {summary.deltaPctScope}</span>
                  )}
                  )
                </span>
              )}
            </span>
            <span className="font-normal text-ink-faint">· {context}</span>
            {/* (a) the account had not opened yet — NOT a defect, so it reads as
                calendar fact in the same faint tone as the range context */}
            {cov && cov.notYetOpen.length > 0 && (
              <span className="font-normal text-ink-faint">
                · {cov.totalAccounts - cov.notYetOpen.length}/{cov.totalAccounts} accounts open
                {opening && <> · {coveragePhrase(opening)}</>}
              </span>
            )}
            {/* (b) a day inside the account's life that no statement covers —
                the real hole, and the only one that keeps the warning tone */}
            {cov && cov.gapAccounts.length > 0 && (
              <span className="font-normal text-warning">
                · no statement for {formatNameList(cov.gapAccounts)} on this date
              </span>
            )}
            {/* (c) covered, counted, and CHECKED BY NOTHING — the balance was
                replayed past the last anchor with nothing to land on. Distinct
                from (b): the money is not missing and the arithmetic has not
                failed, so it reads faint like the calendar fact above it rather
                than in the warning tone a real hole earns. Until this clause the
                series skipped only `gap`, so an unchecked total was drawn
                identically to a reconciled one. */}
            {cov && cov.unverifiedAccounts.length > 0 && cov.gapAccounts.length === 0 && (
              <span className="font-normal text-ink-faint">
                · nothing checks {formatNameList(cov.unverifiedAccounts)} on this date
              </span>
            )}
            {transit !== 0 && (
              <span className="font-normal text-ink-faint">
                · {transit > 0
                  ? `includes ${formatCents(transit)} in transit`
                  : `excludes ${formatCents(-transit)} posted twice`}
              </span>
            )}
            {scrubbing && (
              <span className="text-ink-faint" aria-hidden>
                <Icon name="search" className="size-3" />
              </span>
            )}
          </header>
        );
      }}
    />
  );
}
