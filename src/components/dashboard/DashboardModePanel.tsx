"use client";

import { useCallback, useMemo } from "react";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { DAILY_SERIES_RANGES, type ChartRange } from "@/lib/chart-range";
import { sharedCoverageChange } from "@/lib/coverage-label";
import { compareDates } from "@/lib/dates";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { magnitudeTiers } from "@/lib/magnitude-tiers";
import { formatCents, formatCentsSigned } from "@/lib/money";
import type { BridgedDashboardSeries } from "@/lib/multi-series-bridge";
import { balanceHeading } from "@/lib/side-magnitude";
import { scrubValueText } from "@/lib/scrub";
import { useDashboardWindowProps } from "@/components/dashboard/DashboardWindowContext";
import {
  ScrubChart,
  type Accent,
  type OverlaySeries,
  type ScrubPoint,
  type ScrubSummary,
} from "@/components/investments/ScrubChart";

/**
 * The dashboard chart's non-combined view modes (pass-17 ask C): assets /
 * liabilities-owed / split / per-account lines, rendered through the same
 * ScrubChart the combined view uses. ONE series is the primary (it owns every
 * interaction invariant — scrub, drag-zoom, keyboard, pills, extremes, the
 * x-axis domain); the rest draw as coverage-honest colored overlays with a
 * legend. Because ScrubChart's axis comes from the primary, the primary MUST be
 * the LONGEST-history series (`primaryOf`) or an overlay with older days would
 * be silently clipped off the chart (2026-07-18 adversarial review). Rollup
 * modes span the full union already, so their series[0] is the natural primary;
 * accounts mode picks the oldest account.
 *
 * Honesty rules carried over: estimated days draw dashed; the owed frame
 * inverts the accent (debt going DOWN is the gain) — header, stroke, aria AND
 * tooltip; assets-mode days bridged by an in-flight float say so in the
 * header/aria/tooltip; per-account lines are never bridged (an individual
 * ledger honestly dipped while money moved). A window that opens before a
 * series' coverage measures its delta from the first COVERED day, never a
 * fabricated $0 baseline.
 */

interface DashboardModePanelProps {
  series: readonly BridgedDashboardSeries[];
  /** resolved CSS color per series key; the primary uses it in accounts mode */
  colorByKey: Record<string, string>;
  /** fix the primary line to its palette color (accounts mode) */
  colorPrimary?: boolean;
  /**
   * Choose the primary by longest history (accounts mode only): per-account
   * lines drop their own pre-history, so an older overlay would clip off the
   * primary-owned axis. Rollup modes span the full union axis regardless, so
   * they keep series[0] as primary (assets leads split — the intuitive frame).
   */
  pickLongestPrimary?: boolean;
  today: string;
  heightClass?: string;
  activeRange?: ChartRange;
  onRangeChange?: (range: ChartRange) => void;
}

/** the earliest covered day of a series (its first non-null point), or null. */
function firstCoveredDay(s: BridgedDashboardSeries): string | null {
  for (const p of s.points) if (p.valueCents !== null) return p.day;
  return null;
}

/**
 * The series that must own the x-axis: the one whose coverage starts earliest,
 * so every other (later-starting) series aligns inside its day range without
 * being clipped. Ties keep input order (assets before liabilities in split).
 */
function primaryOf(series: readonly BridgedDashboardSeries[]): BridgedDashboardSeries | undefined {
  let best: BridgedDashboardSeries | undefined;
  let bestDay: string | null = null;
  for (const s of series) {
    const day = firstCoveredDay(s);
    if (day === null) continue;
    if (bestDay === null || compareDates(day, bestDay) < 0) {
      best = s;
      bestDay = day;
    }
  }
  return best ?? series[0];
}

/** append the owed-frame cue unless the label already says it ("Amount owed") */
function frameLabel(s: Pick<BridgedDashboardSeries, "label" | "owedFrame">): string {
  return s.owedFrame && !/owed/i.test(s.label) ? `${s.label} (owed)` : s.label;
}

function toScrubPoints(s: BridgedDashboardSeries): ScrubPoint[] {
  return s.points.map((p) => ({
    day: p.day,
    valueCents: p.valueCents,
    complete: p.complete,
    coveredAccountNames: p.coveredAccountNames,
    coveredCents: p.coveredCents,
    notYetOpen: p.notYetOpen,
    gapAccounts: p.gapAccounts,
    totalAccounts: p.totalAccounts,
    inTransitCents: p.inTransitCents,
  }));
}

export function DashboardModePanel({
  series,
  colorByKey,
  colorPrimary = false,
  pickLongestPrimary = false,
  today,
  heightClass = "h-64 sm:h-72",
  activeRange,
  onRangeChange,
}: DashboardModePanelProps) {
  const windowProps = useDashboardWindowProps();
  const primary = useMemo(
    () => (pickLongestPrimary ? primaryOf(series) : (series[0] ?? primaryOf(series))),
    [series, pickLongestPrimary],
  );
  const scrubPoints = useMemo(() => (primary ? toScrubPoints(primary) : []), [primary]);
  const overlays: OverlaySeries[] = useMemo(
    () =>
      series
        .filter((s) => s.key !== primary?.key)
        .map((s) => ({
          key: s.key,
          label: frameLabel(s),
          color: colorByKey[s.key] ?? "var(--ink-muted)",
          points: toScrubPoints(s),
        })),
    [series, primary, colorByKey],
  );
  const transitByDay = useMemo(
    () => new Map((primary?.points ?? []).map((p) => [p.day, p.inTransitCents] as const)),
    [primary],
  );

  /**
   * The lines this chart cannot show, named rather than left as a flat smear on
   * the baseline.
   *
   * ⚠️ MEASURED on the real ledger: the active accounts span **seven million to
   * one**, and at this chart's height five of ten draw under a single device
   * pixel — Robinhood Cash at $113.88 is 0.34px against Robinhood Brokerage's
   * $70,291.75. A reader cannot tell an empty account from one holding a hundred
   * dollars, and nothing on screen admitted it.
   *
   * Lines cannot be tiered the way bars can — two lines on two scales in one
   * frame is a dual axis, which is its own dishonesty. So the chart says which
   * series it is failing to show, and the reader can select those on their own
   * and get a frame scaled to them.
   */
  const tooSmallToSee = useMemo(() => {
    if (series.length < 2) return [];
    const latest = series.map((s) => {
      const covered = s.points.filter((p) => p.valueCents !== null);
      const cents = covered[covered.length - 1]?.valueCents ?? 0;
      /*
       * 🔴 This line is PROSE standing in for a line the reader cannot see, so
       * it cannot lean on the axis the way the chart does. In the owed frame a
       * card in credit is a negative, and the dashboard read "Chase Sapphire
       * (owed) -$82.72" of a card that owes nothing — while the cards card six
       * inches up, both accounts lenses and the account's own page all said
       * "$82.72 in credit". `balanceHeading` is the rule for exactly this and
       * this was the seventh surface to ask; see its docstring.
       *
       * ⚠️ Only for a series actually IN the owed frame. A negative asset is an
       * overdraft, which is a debt and keeps its minus.
       */
      const heading = s.owedFrame ? balanceHeading(-cents, true) : null;
      return {
        key: s.key,
        label: heading?.label === "In credit" ? `${s.label} in credit` : frameLabel(s),
        cents: heading?.label === "In credit" ? heading.cents : cents,
      };
    });
    const tiers = magnitudeTiers(latest);
    // tier 0 is what the shared axis can render; everything after it, plus what
    // is too small even to magnify, is what this frame cannot show
    const hidden = new Set([
      ...tiers.tiers.slice(1).flatMap((t) => t.keys),
      ...tiers.negligible,
    ]);
    return latest.filter((l) => hidden.has(l.key) && l.cents !== 0);
  }, [series]);

  const owed = primary?.owedFrame ?? false;
  const accentOf = useCallback(
    (summary: ScrubSummary): Accent => {
      if (summary.deltaCents === 0) return "flat";
      // owed frame: the debt shrinking is the win
      const gained = owed ? summary.deltaCents < 0 : summary.deltaCents > 0;
      return gained ? "gain" : "loss";
    },
    [owed],
  );

  const summarize = useCallback(
    (startIdx: number, endIdx: number, slice: readonly ScrubPoint[]): ScrubSummary => {
      // measure from the first COVERED day at/after the window start — a rollup
      // built over the union axis is null before its coverage began (e.g. owed
      // has no value until the first liability opened), and coercing that null
      // to $0 would fabricate a delta equal to the whole current balance.
      let s = startIdx;
      while (s < endIdx && slice[s]!.valueCents === null) s++;
      const startPoint = slice[s]!;
      const start = startPoint.valueCents;
      const endPoint = slice[endIdx]!;
      const end = endPoint.valueCents ?? 0;
      const rawDelta = start === null ? 0 : end - start;
      /*
       * The same rule the hero uses (lib/coverage-label): compare the accounts
       * BOTH endpoints cover, and name what was dropped. Suppressing whenever an
       * endpoint was partial is what made the headline % disappear from every
       * range once a new account opened.
       *
       * `complete` is NOT the input here. For a rollup it also goes false when a
       * covered member is merely an estimate, which is a reason to dash the line
       * and not a reason to refuse a percentage — the coverage fields answer the
       * narrower question. A genuine interior gap still suppresses, inside
       * sharedCoverageChange.
       */
      const change =
        start === null
          ? { pct: null, scope: null, deltaCents: null }
          : sharedCoverageChange({ cents: start, coverage: startPoint }, { cents: end, coverage: endPoint });
      return {
        day: endPoint.day,
        valueCents: end,
        // the dollar must cover the same accounts as the percentage beside it
        deltaCents: change.deltaCents ?? rawDelta,
        deltaPct: change.pct,
        deltaPctScope: change.scope,
      };
    },
    [],
  );

  const valueText = useCallback(
    (summary: ScrubSummary): string => {
      const base = scrubValueText(formatDayLong(summary.day), formatCents(summary.valueCents), summary.deltaPct);
      // the scope belongs in the spoken text too — a screen-reader user hearing
      // a bare percentage has no way to learn it excluded an account
      const scoped =
        summary.deltaPct !== null && summary.deltaPctScope ? `${base}, ${summary.deltaPctScope}` : base;
      const framed = owed ? `${scoped} — amount owed` : scoped;
      const transit = transitByDay.get(summary.day) ?? 0;
      if (transit > 0) return `${framed} — includes ${formatCents(transit)} in transit`;
      if (transit < 0) return `${framed} — excludes ${formatCents(-transit)} posted in two accounts`;
      return framed;
    },
    [owed, transitByDay],
  );

  if (!primary || scrubPoints.length < 2) {
    return <p className="py-10 text-center text-sm text-ink-muted">Not enough history to chart yet.</p>;
  }

  const ACCENT_TEXT: Record<Accent, string> = {
    gain: "text-positive",
    loss: "text-negative",
    flat: "text-ink-muted",
  };

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted" aria-label="Chart legend">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded-full"
              style={{ background: colorPrimary ? (colorByKey[primary.key] ?? "var(--ink)") : "var(--ink)" }}
            />
            {frameLabel(primary)}
          </span>
          {overlays.map((o) => (
            <span key={o.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 rounded-full" style={{ background: o.color }} />
              {o.label}
            </span>
          ))}
        </div>
      )}
      <ScrubChart
        {...windowProps}
        points={scrubPoints}
        today={today}
        activeRange={activeRange}
        ranges={DAILY_SERIES_RANGES}
        onRangeChange={onRangeChange}
        showAxes
        selectable
        showExtremes
        vivid
        overlays={overlays}
        owedFrame={owed}
        strokeColor={colorPrimary ? colorByKey[primary.key] : undefined}
        summarize={summarize}
        accentOf={accentOf}
        valueText={valueText}
        formatValue={formatCents}
        ariaLabel={`${primary.label} over time — scrub to inspect a day, drag to zoom a range`}
        heightClass={heightClass}
        renderHeader={(summary, scrubbing, range, customWindow) => {
          const accent = accentOf(summary);
          const arrow = summary.deltaCents > 0 ? "▲" : summary.deltaCents < 0 ? "▼" : "•";
          const context = scrubbing
            ? formatDayLong(summary.day)
            : customWindow
              ? `${formatDayShort(customWindow.start)} – ${formatDayShort(customWindow.end)}`
              : range === "ALL"
                ? "all time"
                : range;
          const transit = transitByDay.get(summary.day) ?? 0;
          return (
            <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
              {scrubbing && <NumberRoll value={formatCents(summary.valueCents)} className="text-ink" />}
              <span className={`inline-flex items-center gap-1 ${ACCENT_TEXT[accent]}`}>
                <span aria-hidden>{arrow}</span>
                <NumberRoll value={formatCentsSigned(summary.deltaCents)} />
                {summary.deltaPct !== null && (
                  <span className="figures">
                    ({summary.deltaPct >= 0 ? "+" : ""}
                    {summary.deltaPct.toFixed(1)}%
                    {/* a scoped percentage that does not name its scope reads as
                        a claim about the whole rollup */}
                    {summary.deltaPctScope && (
                      <span className="font-normal text-ink-faint"> {summary.deltaPctScope}</span>
                    )}
                    )
                  </span>
                )}
              </span>
              <span className="font-normal text-ink-faint">
                · {frameLabel(primary)} · {context}
              </span>
              {transit !== 0 && (
                <span className="font-normal text-ink-faint">
                  · {transit > 0
                    ? `includes ${formatCents(transit)} in transit`
                    : `excludes ${formatCents(-transit)} posted twice`}
                </span>
              )}
            </header>
          );
        }}
      />
      {tooSmallToSee.length > 0 && (
        /* The chart admitting what it cannot draw. One shared linear axis is the
           right frame for lines — a second scale in the same frame is a dual
           axis, which misleads worse — so the honest move is to name the series
           it is failing to show and point at the fix that already exists. */
        <p className="mt-2 text-xs text-ink-faint">
          Too small to see beside the rest:{" "}
          {tooSmallToSee.map((t, i) => (
            <span key={t.key}>
              {i > 0 && ", "}
              {t.label} <span className="figures">{formatCents(t.cents)}</span>
            </span>
          ))}
          .{" "}
          {tooSmallToSee.length === 1
            ? "Pick it on its own above to read the line."
            : "Pick them on their own above to read the lines."}
        </p>
      )}
    </div>
  );
}
