"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { BRIDGE_LENS_DIMENSION } from "@/components/dashboard/dashboard-view-spec";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  ATTRIBUTION_BAND_LABEL,
  ATTRIBUTION_BAND_MEANING,
  type Attribution,
  type AttributionBandKey,
} from "@/lib/attribution";
import { magnitudeTiers } from "@/lib/magnitude-tiers";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { computeWaterfallLayout, type WaterfallStep } from "@/lib/waterfall-layout";

/**
 * The net-worth bridge: how a period got from one total to the other.
 *
 * ## The two things that make this drawable at all
 *
 * **Direction is never carried by hue alone.** Measured with the repo's own
 * contrast math, `--positive` and `--negative` sit at a contrast ratio of 1.00
 * against each other in light theme and 1.35 in dark — matched lightness, which
 * is right for numerals in a column and useless for two shapes side by side. So
 * every band states its direction three ways: where it sits relative to the
 * running total, an aria-hidden ▲/▼ in its legend row, and a signed amount.
 * Colour is the last of the four, not the first. (`PnlCalendar` established this;
 * `category-palette.test.ts` now pins the ratio as a limit so nobody "fixes" it.)
 *
 * **A band too small to draw gets its own axis rather than a lie.** On the real
 * July–August window `earned` is $52.95 against an $18,870.53 largest band —
 * 0.18px at this height. The bridge draws NO rectangle for it (a floored bar is
 * the thing `waterfall-layout` exists to refuse) and marks its position with a
 * glyph; underneath, those bands are redrawn on an axis scaled to their own
 * largest member, with BOTH ceilings printed so the stated factor can be checked
 * against two numbers on the page rather than taken on trust.
 *
 * **A total is a LEVEL, drawn as a rule with no height.** Review measured what
 * the first version did instead: the all-time window rendered the opening total
 * as a 77.97px bar labelled "$0.00", and whenever the opening was also the
 * lowest running total its height came out constant at 24.00px whatever the
 * value. A rectangle's height is a magnitude; the distance from a padded floor
 * up to a level is not one.
 */

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 240;
/** half-width of the diamond that marks a band too small to draw as an area */
const MARKER = 3.5;
const DIM_OPACITY = 0.28;
/** room under the bars for the two printed totals */
const TOTAL_LABEL_ROW = 16;
/**
 * How many named restatements to print before summarising the rest.
 *
 * Six because the real ledger's all-time window has exactly six and they carry
 * BOTH reasons — five balances restated by an anchor and one account entering
 * coverage. Cutting at five hid the only "entered coverage" row behind "and 1
 * more", which is the one a reader has not seen before.
 */
const RESTATEMENTS_SHOWN = 6;

// 🔴 This declared `key: "bridge"` while holding its value in `useState` — and
// `bridge` is already a VALUE of the surface's `chart` dimension, so the one
// name it chose was the one guaranteed to read as something else. The dimension
// and its labels now live with the surface that owns them, as `bridgeLens`.
const TABLE_LABELS = { chart: "Bridge", table: "Table" };

const GLYPH: Record<string, string> = { up: "▲", down: "▼", flat: "–" };

export interface NetWorthBridgeProps {
  attribution: Attribution & { openingCents: number; closingCents: number };
  windowLabel: string;
  heightClass?: string;
  /**
   * The bridge⇄table lens, when the SURFACE owns it. Omit it and no toggle
   * renders — a control the surface cannot remember is what was wrong before.
   */
  lens?: string;
  onSelectLens?: (value: string) => void;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  amount: string;
  meaning: string;
}

/** Bands only — a total is a rule, not a fill. */
function fillOf(step: WaterfallStep): string {
  if (step.direction === "up") return "var(--gain)";
  if (step.direction === "down") return "var(--loss)";
  return "var(--ink-faint)";
}

/**
 * The chart's one sentence — its SVG `<title>`, and the table lens's caption.
 *
 * 🔴 It asked `closes` (`unexplainedCents === 0`) while the residual note three
 * lines below it asks `unattributedCents === 0` — the strictly different
 * question, and the one that note's own docstring calls "the whole reason
 * `attribute` keeps `attributedCents` and `unattributedCents` apart instead of
 * collapsing them into one boolean". Measured on the owner's dashboard
 * 2026-09-10: unexplained $5,000.00, attributed $5,000.00, unattributed $0.00,
 * so the card read
 *
 *     +$5,000.00 no transaction explains — and all of it has a name.
 *     Cash on Hand · balance restated · +$5,000.00
 *
 * under a title reading "…+$47,069.06, $5,000.00 of it unexplained." One card,
 * two answers, and the accessible name — the only reading a screen reader gets
 * of a chart it cannot see — took the harsher and wrong one.
 *
 * Three states, the same three the note draws.
 */
export function bridgeSummary(
  attribution: Pick<Attribution, "deltaCents" | "closes" | "unexplainedCents" | "unattributedCents"> & {
    openingCents: number;
    closingCents: number;
  },
  windowLabel: string,
): string {
  const delta = formatCentsSigned(attribution.deltaCents);
  const close = attribution.closes
    ? "every cent of it accounted for"
    : attribution.unattributedCents === 0
      ? `${formatCents(Math.abs(attribution.unexplainedCents))} of it named by a restatement rather than a transaction`
      : `${formatCents(Math.abs(attribution.unattributedCents))} of it with no explanation at all`;
  return `Net worth ${windowLabel}: ${formatCents(attribution.openingCents)} to ${formatCents(
    attribution.closingCents,
  )}, ${delta}, ${close}.`;
}

export function NetWorthBridge({
  attribution,
  windowLabel,
  heightClass = "h-[15rem]",
  lens,
  onSelectLens,
}: NetWorthBridgeProps) {
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const mode = lens === "table" ? "table" : "chart";
  const titleId = useId();

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: Math.max(el.clientWidth, 240), h: Math.max(el.clientHeight, 120) });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () =>
      computeWaterfallLayout(
        {
          openingCents: attribution.openingCents,
          closingCents: attribution.closingCents,
          bands: attribution.bands.map((b) => ({
            key: b.key,
            label: ATTRIBUTION_BAND_LABEL[b.key],
            cents: b.cents,
          })),
        },
        { width: size.w, height: Math.max(size.h - TOTAL_LABEL_ROW, 40) },
      ),
    [attribution.openingCents, attribution.closingCents, attribution.bands, size.w, size.h],
  );

  /*
   * The bands the bridge could NOT draw, regrouped onto axes they can fill.
   *
   * ⚠️ Driven by `belowHairline` — the very flag that decided the bridge would
   * not draw them — so the caption "too small to draw above" is true by
   * construction. It was first driven by `magnitudeTiers` over ALL the bands,
   * which is a different denominator, and review measured the consequence: the
   * strip printed "too small to see above" over a band the bridge had drawn as a
   * perfectly visible 2.6px bar.
   */
  const smallSteps = useMemo(
    () => layout.steps.filter((s) => s.kind === "band" && s.belowHairline && s.cents !== 0),
    [layout.steps],
  );
  const largestBandCents = useMemo(
    () => Math.max(0, ...attribution.bands.map((b) => Math.abs(b.cents))),
    [attribution.bands],
  );
  const smallTiering = useMemo(
    () => magnitudeTiers(smallSteps.map((s) => ({ key: s.key, cents: s.cents }))),
    [smallSteps],
  );

  const summary = useMemo(() => bridgeSummary(attribution, windowLabel), [attribution, windowLabel]);

  function moveTooltip(e: ReactPointerEvent, step: WaterfallStep) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      title: step.label,
      amount: step.kind === "total" ? formatCents(step.cents) : formatCentsSigned(step.cents),
      meaning:
        step.kind === "total"
          ? `Net worth ${step.key === "opening" ? "at the start" : "at the end"} of the window.`
          : ATTRIBUTION_BAND_MEANING[step.key as AttributionBandKey],
    });
  }

  const motion = reducedMotion ? "" : "transition-opacity duration-(--duration-fast)";

  const diagram = (
    <div ref={containerRef} className={`relative w-full ${heightClass}`}>
      <svg
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        aria-labelledby={titleId}
        className="block max-w-full overflow-visible"
        onPointerLeave={() => {
          setHovered(null);
          setTooltip(null);
        }}
      >
        {/* a <title>, not role="img": the legend rows below are the accessible
            reading of every band, and role="img" would prune them */}
        <title id={titleId}>{summary}</title>

        {/* connectors, drawn first so the bars sit over them */}
        <g aria-hidden="true" stroke="var(--line-strong)" strokeDasharray="2 3" strokeWidth={1}>
          {layout.steps.map((s, i) => {
            const next = layout.steps[i + 1];
            if (s.connectorY === null || next === undefined) return null;
            return (
              <line key={`c-${s.key}`} x1={s.x} y1={s.connectorY} x2={next.x + next.width} y2={s.connectorY} />
            );
          })}
        </g>

        <g aria-hidden="true">
          {layout.steps.map((s) => {
            const dim = hovered !== null && hovered !== s.key;
            const clear = () => {
              setHovered(null);
              setTooltip(null);
            };
            /*
             * A TOTAL is a level: a rule at its value, spanning the column, with
             * no area. Drawn from the floor it was a magnitude nobody had —
             * 77.97px of "$0.00" on the all-time window.
             */
            if (s.kind === "total") {
              return (
                <g
                  key={s.key}
                  className={motion}
                  style={{ opacity: dim ? DIM_OPACITY : 1 }}
                  onPointerMove={(e) => {
                    setHovered(s.key);
                    moveTooltip(e, s);
                  }}
                  onPointerLeave={clear}
                >
                  {/* a wide invisible target so a 2px rule is still hoverable */}
                  <rect x={s.x} y={s.y - 8} width={s.width} height={16} fill="transparent" />
                  <line
                    x1={s.x}
                    y1={s.y}
                    x2={s.x + s.width}
                    y2={s.y}
                    stroke="var(--ink-display)"
                    strokeWidth={2}
                  />
                </g>
              );
            }
            /*
             * A band the bridge cannot draw as an area gets NO rectangle. A
             * floored bar would assert a size it does not have and would make
             * drawn height non-monotone in value — a $130 band drawing shorter
             * than a $52.95 one. The glyph marks WHERE it happened; the strip
             * below carries HOW BIG. A band of exactly zero gets neither,
             * because nothing happened.
             */
            if (s.belowHairline) {
              if (s.cents === 0) return null;
              const cx = s.x + s.width / 2;
              return (
                <g
                  key={s.key}
                  className={motion}
                  style={{ opacity: dim ? DIM_OPACITY : 1 }}
                  onPointerMove={(e) => {
                    setHovered(s.key);
                    moveTooltip(e, s);
                  }}
                  onPointerLeave={clear}
                >
                  <rect x={s.x} y={s.y - 8} width={s.width} height={16} fill="transparent" />
                  <path
                    d={`M ${cx} ${s.y - MARKER} L ${cx + MARKER} ${s.y} L ${cx} ${s.y + MARKER} L ${cx - MARKER} ${s.y} Z`}
                    fill={s.direction === "up" ? "var(--gain)" : "var(--loss)"}
                  />
                </g>
              );
            }
            return (
              <rect
                key={s.key}
                x={s.x}
                y={s.y}
                width={s.width}
                height={s.height}
                rx={1.5}
                fill={fillOf(s)}
                className={motion}
                style={{ opacity: dim ? DIM_OPACITY : 1 }}
                onPointerMove={(e) => {
                  setHovered(s.key);
                  moveTooltip(e, s);
                }}
                onPointerLeave={clear}
              />
            );
          })}
        </g>

        {/* The two totals are the question the chart answers — "from X to Y" —
            so they are printed, not left to a hover. Bands are not labelled
            here: ten columns at the 320px floor is 20px each, and the legend
            below carries every band's exact amount anyway. */}
        <g aria-hidden="true" className="fill-ink-muted text-[10px]">
          {[layout.steps[0], layout.steps.at(-1)].map((s, i) =>
            s === undefined ? null : (
              <text
                key={s.key}
                x={i === 0 ? s.x : s.x + s.width}
                y={size.h - 2}
                textAnchor={i === 0 ? "start" : "end"}
                className="figures"
              >
                {formatCents(s.cents)}
              </text>
            ),
          )}
        </g>
      </svg>

      {tooltip ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 max-w-64 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs shadow-md"
          style={{ left: Math.min(tooltip.x + 12, size.w - 200), top: Math.max(tooltip.y - 8, 0) }}
        >
          <div className="font-medium">{tooltip.title}</div>
          <div className="figures mt-0.5">{tooltip.amount}</div>
          <div className="mt-1 text-ink-faint">{tooltip.meaning}</div>
        </div>
      ) : null}
    </div>
  );

  /**
   * The axis does not start at zero, and it has to say so.
   *
   * `computeWaterfallLayout` has published `axisStartsAtZero` from the start and
   * nothing rendered it — review grepped and found the flag's only consumers
   * were its own unit tests, on a chart whose module docstring promises the
   * omission is "said out loud". A zero-anchored axis would make every band a
   * sliver here; omitting zero is the right call and an undisclosed one is not.
   */
  const axisNote = layout.axisStartsAtZero ? null : (
    <p className="mt-2 text-xs text-ink-faint">
      Bar heights are measured from{" "}
      <span className="figures">{formatCents(layout.axisMinCents)}</span>, not from zero, so the
      period&rsquo;s movement is visible. The two rules mark the opening and closing totals.
    </p>
  );

  const legend = (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {attribution.bands.map((b) => (
        <li key={b.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2 rounded-[2px]"
            style={{
              background:
                b.direction === "up" ? "var(--gain)" : b.direction === "down" ? "var(--loss)" : "var(--ink-faint)",
            }}
          />
          <span className={b.isZero ? "text-ink-faint" : "text-ink-muted"}>
            {ATTRIBUTION_BAND_LABEL[b.key]}
          </span>
          {/* the glyph is the non-chromatic carrier of direction, and it is
              aria-hidden because the signed amount beside it already says it */}
          <span aria-hidden="true" className="text-ink-faint">
            {GLYPH[b.direction]}
          </span>
          <span className={`figures ${b.isZero ? "text-ink-faint" : ""}`}>
            {formatCentsSigned(b.cents)}
          </span>
        </li>
      ))}
    </ul>
  );

  /**
   * What the residual IS.
   *
   * A bridge whose last band reads "Unexplained $61,765.55" and stops there has
   * reported a hole. Usually there is no hole — that figure is five accounts
   * opening with a balance and a portfolio's first day — and the difference
   * between "unaccounted for" and "accounted for, just not by a transaction" is
   * the whole reason `attribute` keeps `attributedCents` and `unattributedCents`
   * apart instead of collapsing them into one boolean.
   */
  const residual =
    attribution.unexplainedCents === 0 ? null : (
      <div className="mt-4 border-t border-line pt-3 text-xs">
        <p className={attribution.unattributedCents === 0 ? "text-ink-muted" : "text-danger"}>
          {attribution.unattributedCents === 0 ? (
            <>
              <span className="figures">{formatCentsSigned(attribution.unexplainedCents)}</span> no
              transaction explains — and all of it has a name.
            </>
          ) : (
            <>
              <span className="figures">{formatCentsSigned(attribution.unattributedCents)}</span> of
              this window has no explanation at all.
            </>
          )}
        </p>
        {attribution.restatements.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {attribution.restatements.slice(0, RESTATEMENTS_SHOWN).map((r) => (
              <li key={`${r.accountName}-${r.reason}`} className="flex justify-between gap-4">
                <span className="truncate text-ink-muted">
                  {r.accountName}
                  <span className="ml-1.5 text-ink-faint">
                    {r.reason === "anchor" ? "balance restated" : "entered coverage"}
                  </span>
                </span>
                <span className="figures">{formatCentsSigned(r.cents)}</span>
              </li>
            ))}
            {attribution.restatements.length > RESTATEMENTS_SHOWN && (
              <li className="text-ink-faint">
                and {attribution.restatements.length - RESTATEMENTS_SHOWN} more
              </li>
            )}
          </ul>
        )}
      </div>
    );

  const magnifier =
    smallTiering.tiers.length === 0 && smallTiering.negligible.length === 0 ? null : (
      <div className="mt-4 border-t border-line pt-3">
        {smallTiering.tiers.map((tier) => {
          // stated against the bridge's OWN tallest band, which is the thing a
          // reader is comparing to — and both ceilings are printed below, so the
          // factor can be checked against two numbers on the page
          const factor = Math.max(1, Math.round(largestBandCents / tier.maxCents));
          return (
            <div key={tier.index} className="mb-2 last:mb-0">
              <p className="text-xs text-ink-faint">
                Too small to draw above. This row&rsquo;s full width is{" "}
                <span className="figures">{formatCents(tier.maxCents)}</span>; the tallest band above
                is <span className="figures">{formatCents(largestBandCents)}</span> —{" "}
                {factor.toLocaleString("en-US")}× larger.
              </p>
              <ul className="mt-2 space-y-1">
                {tier.keys.map((rawKey) => {
                  const key = rawKey as AttributionBandKey;
                  const band = attribution.bands.find((b) => b.key === key)!;
                  const pct = (Math.abs(band.cents) / tier.maxCents) * 100;
                  return (
                    <li key={key} className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-xs">
                      <span className="truncate text-ink-muted">{ATTRIBUTION_BAND_LABEL[key]}</span>
                      <span className="h-2 rounded-sm bg-surface-sunken">
                        <span
                          className="block h-full rounded-sm"
                          style={{
                            width: `${pct}%`,
                            background: band.direction === "up" ? "var(--gain)" : "var(--loss)",
                          }}
                        />
                      </span>
                      <span className="figures">{formatCentsSigned(band.cents)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {smallTiering.negligible.length > 0 && (
          /* Too small to magnify honestly either — past the cap a bar stops
             being a comparison. Named in prose instead, which is information a
             700,000× bar is not. */
          <p className="text-xs text-ink-faint">
            {smallTiering.negligible
              .map((k) => ATTRIBUTION_BAND_LABEL[k as AttributionBandKey])
              .join(", ")}{" "}
            {smallTiering.negligible.length === 1 ? "is" : "are"} too small to draw even magnified —
            the exact amounts are in the list above.
          </p>
        )}
      </div>
    );

  const table = (
    <DataTable
      columns={BAND_COLUMNS}
      rows={attribution.bands.map((b) => ({
        key: b.key,
        label: ATTRIBUTION_BAND_LABEL[b.key],
        cents: b.cents,
        sharePct: b.sharePct,
      }))}
      rowKey={(r) => r.key}
      caption={summary}
      emptyState="Nothing moved in this window."
    />
  );

  const body = (
    <div>
      {mode === "table" ? (
        table
      ) : (
        <>
          {diagram}
          {axisNote}
          {legend}
          {magnifier}
          {residual}
        </>
      )}
    </div>
  );

  if (lens === undefined || onSelectLens === undefined) return body;

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <ViewSwitcher
          dimension={BRIDGE_LENS_DIMENSION}
          value={mode}
          onSelect={onSelectLens}
          labels={TABLE_LABELS}
          ariaLabel="Bridge view"
        />
      </div>
      {body}
    </div>
  );
}

type BandRow = { key: string; label: string; cents: number; sharePct: number };

const BAND_COLUMNS: Column<BandRow>[] = [
  { key: "label", header: "Part", render: (r) => r.label },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    render: (r) => <span className="figures">{formatCentsSigned(r.cents)}</span>,
  },
  {
    key: "share",
    header: "Share of movement",
    align: "right",
    render: (r) => <span className="text-ink-faint">{r.sharePct.toFixed(1)}%</span>,
  },
];
