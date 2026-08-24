"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
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
 * 0.18px at this height. The main bridge draws it at its true (invisible) size
 * and marks it; underneath, `magnitudeTiers` regroups the small bands onto an
 * axis scaled to THEIR largest member and prints the magnification. Nothing is
 * rescaled silently and nothing is floored, because a waterfall's whole claim is
 * that the parts add up.
 */

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 240;
/** what a sub-hairline band is drawn as instead: a visible mark at the true y */
const TICK_HEIGHT = 2.5;
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

const TABLE_DIMENSION = { key: "bridge", options: ["chart", "table"] } as const;
const TABLE_LABELS = { chart: "Bridge", table: "Table" };

const GLYPH: Record<string, string> = { up: "▲", down: "▼", flat: "–" };

export interface NetWorthBridgeProps {
  attribution: Attribution & { openingCents: number; closingCents: number };
  windowLabel: string;
  heightClass?: string;
  showTableToggle?: boolean;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  amount: string;
  meaning: string;
}

/**
 * A total is a REFERENCE, not a movement, and it must not be the loudest thing
 * on the chart. Drawn in a muted neutral so the eye reads the coloured bands as
 * the story and the two columns as the posts they hang between — `--ink-display`
 * was tried first and the closing column simply dominated the frame.
 */
function fillOf(step: WaterfallStep): string {
  if (step.kind === "total") return "var(--chart-band, var(--surface-sunken))";
  if (step.direction === "up") return "var(--gain)";
  if (step.direction === "down") return "var(--loss)";
  return "var(--ink-faint)";
}

export function NetWorthBridge({
  attribution,
  windowLabel,
  heightClass = "h-[15rem]",
  showTableToggle = false,
}: NetWorthBridgeProps) {
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [mode, setMode] = useState<"chart" | "table">("chart");
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
   * The small bands, regrouped onto axes they can actually fill. Tier 0 is
   * already legible in the bridge above, so only the magnified tiers are drawn
   * again — redrawing tier 0 would be the same picture twice.
   */
  const tiering = useMemo(
    () => magnitudeTiers(attribution.bands.map((b) => ({ key: b.key, cents: b.cents }))),
    [attribution.bands],
  );
  const magnified = tiering.tiers.filter((t) => t.magnification > 1);

  const summary = useMemo(() => {
    const delta = formatCentsSigned(attribution.deltaCents);
    const close = attribution.closes
      ? "every cent of it accounted for"
      : `${formatCents(Math.abs(attribution.unexplainedCents))} of it unexplained`;
    return `Net worth ${windowLabel}: ${formatCents(attribution.openingCents)} to ${formatCents(
      attribution.closingCents,
    )}, ${delta}, ${close}.`;
  }, [attribution, windowLabel]);

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
            /* A band under a pixel is drawn as a TICK at its true position, not
               as a floored bar: the position is honest, the mark is visible, and
               the magnified row below carries the size. */
            const isTick = s.kind === "band" && s.belowHairline;
            return (
              <rect
                key={s.key}
                x={s.x}
                y={isTick ? s.y - TICK_HEIGHT / 2 : s.y}
                width={s.width}
                height={isTick ? TICK_HEIGHT : s.height}
                rx={1.5}
                fill={fillOf(s)}
                stroke={s.kind === "total" ? "var(--line-strong)" : "none"}
                strokeWidth={s.kind === "total" ? 1 : 0}
                className={motion}
                style={{ opacity: dim ? DIM_OPACITY : 1 }}
                onPointerMove={(e) => {
                  setHovered(s.key);
                  moveTooltip(e, s);
                }}
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
    magnified.length === 0 ? null : (
      <div className="mt-4 border-t border-line pt-3">
        {magnified.map((tier) => (
          <div key={tier.index}>
            <p className="text-xs text-ink-faint">
              Too small to see above — shown at {tier.magnification.toLocaleString("en-US")}× against{" "}
              {formatCents(tier.maxCents)}.
            </p>
            <ul className="mt-2 space-y-1">
              {tier.keys.map((rawKey) => {
                const key = rawKey as AttributionBandKey;
                // read the band itself rather than a parallel lookup map: one
                // source, and no fallback that can never fire
                const band = attribution.bands.find((b) => b.key === key)!;
                const cents = band.cents;
                const pct = (Math.abs(cents) / tier.maxCents) * 100;
                return (
                  <li key={key} className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-xs">
                    <span className="truncate text-ink-muted">
                      {ATTRIBUTION_BAND_LABEL[key]}
                    </span>
                    <span className="h-2 rounded-sm bg-surface-sunken">
                      <span
                        className="block h-full rounded-sm"
                        style={{
                          width: `${pct}%`,
                          background: band.direction === "up" ? "var(--gain)" : "var(--loss)",
                        }}
                      />
                    </span>
                    <span className="figures">{formatCentsSigned(cents)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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
          {legend}
          {magnifier}
          {residual}
        </>
      )}
    </div>
  );

  if (!showTableToggle) return body;

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <ViewSwitcher
          dimension={TABLE_DIMENSION}
          value={mode}
          onSelect={(v) => setMode(v as "chart" | "table")}
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
