"use client";

import { type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { categoryHueVar, isCategoryHueName } from "@/lib/category-palette";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { ledgerHref } from "@/lib/ledger-href";
import { paceReadout } from "@/lib/pace-readout";
import {
  cashFlowSegmentHref,
  type CashFlow,
  type CashFlowSeries,
  type SpendingProjection,
} from "@/services/spending";

/**
 * The combined cash-flow chart (ux-overhaul-plan §5.2): income stacked ABOVE the
 * axis, spending stacked BELOW, a net line across, and — for the in-progress
 * period — a dotted "typical pace" reference plus an on-pace projection. Every
 * bar segment click drills to that category+window's ledger; every axis label
 * click drills to the whole window. Values are integer cents; colors ride the
 * category hue identity (§2.5), so a slice's color matches its chip everywhere.
 */

const FALLBACK_SPEND = "var(--line-strong)";
const FALLBACK_UNCAT = "var(--ink-faint)";
const FALLBACK_INCOME = "var(--chart-2)";
const OTHER_KEY = "__other";

function colorFor(series: CashFlowSeries, fallback: string): string {
  if (series.key === "__uncat") return FALLBACK_UNCAT;
  if (series.key === "__other") return FALLBACK_SPEND;
  if (isCategoryHueName(series.hue)) return categoryHueVar(series.hue);
  return fallback;
}

function formatTick(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const sign = cents < 0 ? "-" : "";
  if (dollars >= 1000) return `${sign}$${Math.round(dollars / 100) / 10}k`;
  return `${sign}$${Math.round(dollars)}`;
}

interface Row {
  key: string;
  label: string;
  from: string;
  to: string;
  net: number;
  /** last period's gross spend for this bucket, drawn below the axis (faint ghost) */
  ghost?: number | null;
  [seriesKey: string]: number | string | null | undefined;
}

const GHOST_KEY = "__ghost";

interface CashFlowChartProps {
  data: CashFlow;
  /** the estimate companion (North Star #2): pace + prior-period ghost. */
  projection?: SpendingProjection | null;
  /** what the unimported days are "of" (`paceWindowName`) — "2 days of September 2026 not imported yet" */
  paceWindowName: string | null;
}

export function CashFlowChart({ data, projection, paceWindowName }: CashFlowChartProps) {
  const router = useRouter();
  const { buckets, incomeSeries, spendingSeries, pace } = data;

  /*
   * ⛔ `prior.aligned`, never `prior.ghost`. The ghost is a nearest-fraction
   * SHAPE resample: on June(30) → July(31) it slides every bucket from June 19
   * up, so the value under a point is not what the prior period spent in that
   * bucket. The line is one thing, but the TOOLTIP prints it as a dollar figure
   * ("Prior period, this point · $1,984.89" where June 20 was $89.71) — and a
   * figure in a tooltip is a fact, whatever the label around it hedges.
   *
   * `aligned` compares the same day of the month against the same day, which is
   * the comparison this overlay exists to make. A prior period with no such
   * bucket leaves the key UNSET so the line breaks there, rather than drawing a
   * zero it never spent.
   */
  const ghost = projection?.prior?.aligned ?? null;
  const hasGhost = ghost !== null && ghost.length === buckets.length;

  const rows: Row[] = buckets.map((b, i) => {
    const row: Row = { key: b.key, label: b.label, from: b.from, to: b.to, net: b.netCents };
    for (const s of incomeSeries) row[s.key] = b.income[s.key] ?? 0; // above axis
    for (const s of spendingSeries) row[s.key] = -(b.spending[s.key] ?? 0); // below axis
    // below the axis, and only where the prior period HAS that bucket
    if (hasGhost && ghost![i] !== null) row[GHOST_KEY] = -ghost![i]!;
    return row;
  });

  const incomeColor = new Map(incomeSeries.map((s, i) => [s.key, colorFor(s, i === 0 ? FALLBACK_INCOME : `var(--chart-${(i % 6) + 1})`)]));
  const spendColor = new Map(spendingSeries.map((s, i) => [s.key, colorFor(s, `var(--chart-${(i % 6) + 1})`)]));

  const bucketByKey = new Map(buckets.map((b) => [b.key, b]));
  // month buckets ("YYYY-MM") get keyboard-operable axis labels (year/quarter
  // views have no other keyboard route to a single month's ledger); day buckets
  // stay pointer-only since the heatmap already drills days by keyboard.
  const monthBuckets = (buckets[0]?.key.length ?? 10) === 7;
  function goToWindow(key: string) {
    const b = bucketByKey.get(key);
    if (b) router.push(ledgerHref({ from: b.from, to: b.to }));
  }
  function goToSegment(seriesKey: string, categoryId: string | null, key: string, flow?: "in" | "out") {
    const b = bucketByKey.get(key);
    if (b) router.push(cashFlowSegmentHref(seriesKey, categoryId, { from: b.from, to: b.to }, flow));
  }

  const hasData = incomeSeries.length > 0 || spendingSeries.length > 0;
  if (!hasData) return null;

  const ghostByKey = new Map(buckets.map((b, i) => [b.key, hasGhost ? ghost![i] : null]));
  const priorLabel = projection?.prior?.label ?? null;

  // The honest projection readout: "on pace for ~$Y · $X so far · $Z last period".
  // A low-confidence pace (early in the period) reads muted and says so.
  const projected = projection?.projectedSpendCents ?? null;
  const lowConfidence = projection?.paceConfidence != null && projection.paceConfidence < 0.5;
  /*
   * 🔴 S12. "On pace for ~$3,066.54 · $1,431.05 so far" over a September two of
   * whose elapsed days nobody had imported, beside a dashboard tile saying "at
   * least" of the same figures. `paceReadout` is those words for both states.
   */
  const words = paceReadout({
    projectedCents: projected ?? 0,
    actualToDateCents: pace?.actualToDateCents ?? 0,
    uncoveredDays: projection?.paceUncoveredDays ?? 0,
    windowName: paceWindowName,
  });
  /*
   * 🔴 The basis carried the not-imported clause as well, and the basis is ALSO
   * the sr-only span after the figure. On 2026-09-14 a screen reader heard "On
   * pace for at least $3,066.54 — pace from 14 of 30 days elapsed; 2 days of
   * September 2026 not imported yet spent this period · at least $1,431.05 so
   * far · 2 days of September 2026 not imported yet". The clause is its own
   * visible part below; the basis is the method alone.
   */
  const basis = projection?.paceBasis ?? null;
  const readoutParts: ReactNode[] = [];
  if (projected !== null) {
    readoutParts.push(
      <>
        On pace for{" "}
        {/* the ~ (or "at least") + dotted underline mark it an estimate; the
            method/basis is on demand via hover (title) and always available to
            screen readers (sr-only). */}
        <span
          className={`figures font-medium underline decoration-dotted underline-offset-2 cursor-help ${lowConfidence ? "text-ink-muted" : "text-ink"}`}
          title={basis ?? undefined}
        >
          {words.projected}
        </span>
        {basis ? <span className="sr-only"> — {basis}</span> : null} spent
        this period{lowConfidence ? " (early estimate)" : ""}
      </>,
    );
  }
  if (pace) {
    readoutParts.push(<span className="text-ink-faint">{words.soFar}</span>);
  }
  if (pace && words.notImported) {
    readoutParts.push(<span className="text-ink-faint">{words.notImported}</span>);
  }
  if (projection?.prior) {
    readoutParts.push(
      <span className="text-ink-faint">
        {formatCents(projection.prior.spentCents)} in {projection.prior.label}
      </span>,
    );
  }

  return (
    <figure className="m-0" aria-label="Income above the axis and spending below, by period">
      {readoutParts.length > 0 && (
        <p className="mb-2 text-xs text-ink-muted">
          {readoutParts.map((node, i) => (
            <span key={i}>
              {i > 0 ? " · " : ""}
              {node}
            </span>
          ))}
        </p>
      )}
      <div className="h-72 md:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 4 }} stackOffset="sign">
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="key"
              tick={(props) => (
                <ClickableTick
                  {...props}
                  onLabelClick={goToWindow}
                  labelOf={(k) => bucketByKey.get(k)?.label ?? k}
                  focusable={monthBuckets}
                />
              )}
              tickLine={false}
              axisLine={{ stroke: "var(--line)" }}
              interval="preserveStartEnd"
              minTickGap={12}
            />
            <YAxis
              tickFormatter={formatTick}
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ReferenceLine y={0} stroke="var(--line-strong)" />
            {pace && (
              <ReferenceLine
                y={-pace.avgPerBucketCents}
                stroke="var(--warning)"
                strokeDasharray="4 3"
                strokeWidth={1}
              />
            )}
            <Tooltip
              cursor={{ fill: "var(--surface-sunken)", opacity: 0.5 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const b = bucketByKey.get(String(label));
                if (!b) return null;
                return (
                  <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs shadow-sm">
                    <div className="text-ink-faint">{b.label}</div>
                    <div className="mt-1 flex items-center justify-between gap-4">
                      <span className="text-positive">Earned</span>
                      <span className="figures">{formatCents(b.incomeCents)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-negative">Spent</span>
                      <span className="figures">{formatCents(b.spendingCents)}</span>
                    </div>
                    {/* a refund is money in and never nets "Spent" down, so without
                        this line Earned − Spent does not make the Net below it */}
                    {b.refundsCents !== 0 && (
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-positive">Refunded</span>
                        <span className="figures">{formatCents(b.refundsCents)}</span>
                      </div>
                    )}
                    <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 font-medium">
                      <span>Net</span>
                      <span className="figures">{formatCentsSigned(b.netCents)}</span>
                    </div>
                    {ghostByKey.get(String(label)) != null && (
                      <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 text-ink-faint">
                        {/* a single re-indexed bucket of the prior period — NOT its whole-period
                            total (that lives in the readout as "$Z in {label}"). */}
                        <span>Prior period, this point</span>
                        <span className="figures">{formatCents(ghostByKey.get(String(label))!)}</span>
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {incomeSeries.map((s) => (
              <Bar
                key={`in-${s.key}`}
                dataKey={s.key}
                name={s.label}
                stackId="flow"
                fill={incomeColor.get(s.key)}
                isAnimationActive={false}
                maxBarSize={40}
                cursor="pointer"
                onClick={(entry: { payload?: { key?: string } }) => {
                  const key = entry.payload?.key;
                  if (key) goToSegment(s.key, s.categoryId, key, "in"); // income is positive-only
                }}
              />
            ))}
            {spendingSeries.map((s) => {
              // "Other" aggregates categories with no single exact filter, so it
              // is intentionally not clickable (a drill would not reconcile).
              const clickable = s.key !== OTHER_KEY;
              return (
                <Bar
                  key={`out-${s.key}`}
                  dataKey={s.key}
                  name={s.label}
                  stackId="flow"
                  fill={spendColor.get(s.key)}
                  isAnimationActive={false}
                  maxBarSize={40}
                  cursor={clickable ? "pointer" : "default"}
                  onClick={
                    clickable
                      ? (entry: { payload?: { key?: string } }) => {
                          const key = entry.payload?.key;
                          // ⛔ "out": these bars are GROSS spending — debits only,
                          // per cashFlowByPeriod's sign convention — so the drill
                          // must exclude the credits the segment excludes. The
                          // Uncategorized branch of `cashFlowSegmentHref` already
                          // said so ("negatives-only → drill to outflows so it
                          // reconciles") and the named categories did not: 47 of
                          // 2,415 drawn segments opened rows the bar never drew.
                          if (key) goToSegment(s.key, s.categoryId, key, "out");
                        }
                      : undefined
                  }
                />
              );
            })}
            {hasGhost && (
              <Line
                type="monotone"
                dataKey={GHOST_KEY}
                name={`Spent in ${priorLabel ?? "the prior period"}`}
                stroke="var(--ink-faint)"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                strokeDasharray="2 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              type="monotone"
              dataKey="net"
              name="Net"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {incomeSeries.map((s) => (
          <Swatch key={`li-${s.key}`} color={incomeColor.get(s.key)!} label={s.label} />
        ))}
        {spendingSeries.map((s) => (
          <Swatch key={`ls-${s.key}`} color={spendColor.get(s.key)!} label={s.label} />
        ))}
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3 bg-accent" />
          Net
        </span>
        {hasGhost && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0 w-3 border-t border-dashed border-ink-faint"
            />
            Spent in {priorLabel}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

interface TickProps {
  x?: number | string;
  y?: number | string;
  payload?: { value: string };
  onLabelClick: (key: string) => void;
  labelOf: (key: string) => string;
  /** month buckets are keyboard-operable (year/quarter views have no other
   *  keyboard route to a single month's ledger); day buckets are pointer-only */
  focusable: boolean;
}

/** X-axis label that drills to its whole window (§5.2 "click an axis label"). */
function ClickableTick({ x = 0, y = 0, payload, onLabelClick, labelOf, focusable }: TickProps) {
  const key = payload?.value ?? "";
  const label = labelOf(key);
  return (
    <text
      x={Number(x)}
      y={Number(y) + 12}
      textAnchor="middle"
      fontSize={11}
      fill="var(--ink-faint)"
      className="cursor-pointer"
      role={focusable ? "button" : undefined}
      aria-label={focusable ? `View ${label} transactions` : undefined}
      tabIndex={focusable ? 0 : undefined}
      onClick={() => onLabelClick(key)}
      onKeyDown={
        focusable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onLabelClick(key);
              }
            }
          : undefined
      }
    >
      {label}
    </text>
  );
}
