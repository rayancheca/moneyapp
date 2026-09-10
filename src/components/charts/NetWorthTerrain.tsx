"use client";

import Link from "next/link";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import {
  TERRAIN_LENS_DIMENSION,
  TERRAIN_LENS_LABELS,
  TERRAIN_VIEW_DIMENSION,
  TERRAIN_VIEW_LABELS,
} from "@/components/dashboard/dashboard-view-spec";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { formatDayLong, formatMonthYear } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import {
  TERRAIN_VIEWPOINTS,
  computeTerrainLayout,
  drawnRibbonCount,
  nearestVertex,
  pointsAttr,
  reconcileTerrain,
  ribbonsFromSeries,
  terrainRowFigures,
  terrainTableCaption,
  type TerrainLayout,
  type TerrainReferencePoint,
  type TerrainRibbon,
  type TerrainRowFigures,
  type TerrainSeriesLike,
  type TerrainVertex,
  type TerrainViewpoint,
} from "@/lib/terrain-layout";

/**
 * "Two years of every account", set as a terrain (Direction A+). The dashboard
 * hero's SPATIAL lens: every account is a ribbon drawn along time on its own
 * plane, and every dimension of it carries money.
 *
 *   HEIGHT off the zero rule   that account's balance on that day
 *   ABOVE / BELOW the rule     held / owed — the debt side on its own,
 *                              STATED, scale (a $1.4k card under $112k of
 *                              assets is a hairline at one shared scale)
 *   DEPTH                      which account it is
 *   COLOUR                     account identity, never the only carrier
 *
 * SVG with real projection maths, not WebGL: deterministic (the visual
 * baselines hold), axe-inspectable, and free at the bundle. The geometry is
 * pure and unit-tested (`lib/terrain-layout.ts`); this file owns colour, the
 * readout, hover, and the two escape hatches legibility demands — a rail beside
 * the plate that states every account's exact figures and is the keyboard/AT
 * path to each account page, and a Table lens with the whole span in full.
 *
 * THE HONESTY THE FIGURE IS BUILT ON. derivation refuses to publish a span it
 * cannot reconstruct, so a span the ledger could not verify is drawn BROKEN
 * here — hatched, with a dashed crest — never as a smooth surface. And the
 * figure states, under the plate, how it reconciles with the net-worth line
 * above it, loudest when it does not.
 */

export interface NetWorthTerrainProps {
  /** the per-account lines from `dashboardChartData(db, "accounts")` */
  series: readonly TerrainSeriesLike[];
  /** the hero net-worth series (in-flight bridged) — what this must reconcile with */
  reference: readonly TerrainReferencePoint[];
  today: string;
  /** the dashboard's own account→colour map, so a ribbon keeps its identity */
  colorByKey?: Readonly<Record<string, string>>;
  /** drill-through per account; defaults to the account page */
  hrefById?: Readonly<Record<string, string>>;
  /** override the plate height (the focus modal renders it taller) */
  heightClass?: string;
  /**
   * The two dimensions are OWNED BY THE SURFACE, not by this component: they
   * are real view state now (URL > persisted > default), so the values arrive
   * resolved and every change goes back through the surface's `setView`. Held
   * in `useState` they were lost on reload and unlinkable, while both
   * declarations named a URL param nothing read.
   */
  lens: string;
  viewpoint: string;
  onSelectLens: (value: string) => void;
  onSelectViewpoint: (value: string) => void;
}

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 340;

/**
 * How many columns a plate of this width can hold and still read. Fewer columns
 * only coarsen the drawing, they never hide a hole (a column's span is verified
 * only when every day behind it is). Deterministic in the measured width.
 */
function columnBudget(width: number): number {
  if (width < 560) return 44;
  if (width < 820) return 72;
  return 104;
}

// The two dimensions and their labels live with the SURFACE that owns them
// (`dashboard-view-spec`), so the spec the RSC resolves and the pills this file
// renders cannot name different options.

/** a crest narrower than a hairline reads as noise, not as a balance */
const CREST_WIDTH = 1.75;
const CREST_WIDTH_ON = 2.75;
const DIM_OPACITY = 0.14;

export function NetWorthTerrain({
  series,
  reference,
  today,
  colorByKey,
  hrefById,
  heightClass = "h-[19rem] sm:h-[24rem]",
  lens,
  viewpoint: viewpointValue,
  onSelectLens,
  onSelectViewpoint,
}: NetWorthTerrainProps) {
  const reducedMotion = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const hatchId = useId();
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  /*
   * The resolver only ever hands back a declared option, so this narrowing
   * cannot invent a camera — and a value that somehow is not one falls to the
   * default rather than indexing `TERRAIN_VIEWPOINTS` with `undefined`.
   */
  const viewpoint: TerrainViewpoint =
    viewpointValue in TERRAIN_VIEWPOINTS ? (viewpointValue as TerrainViewpoint) : "quarter";
  const [hovered, setHovered] = useState<{ id: string; day: string } | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setSize({ w: Math.max(el.clientWidth, 240), h: Math.max(el.clientHeight, 180) });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // `lens` is load-bearing, not decoration: the stage UNMOUNTS in the Table
    // lens, so an empty dep list would leave the observer watching a detached
    // node after a table → terrain round trip and the plate would stop
    // responding to the window.
  }, [lens]);

  const ribbons = useMemo(() => ribbonsFromSeries(series, colorByKey), [series, colorByKey]);
  const layout = useMemo(
    () =>
      computeTerrainLayout(ribbons, {
        width: size.w,
        height: size.h,
        camera: TERRAIN_VIEWPOINTS[viewpoint],
        maxColumns: columnBudget(size.w),
      }),
    [ribbons, size.w, size.h, viewpoint],
  );
  const check = useMemo(() => reconcileTerrain(ribbons, reference), [ribbons, reference]);

  /**
   * `url(#…)` is a fragment reference, so the id must be URL-safe. `useId` is
   * (`_r_0_`) and today's account ids are UUIDv7 — but a series key is the
   * CALLER's string, and one space in it would silently kill every hatch on the
   * plate. Index into the input order instead: URL-safe by construction, and
   * stable across viewpoints (the layout re-sorts into painter's order).
   */
  const hatchIdByRibbon = useMemo(
    () => new Map(ribbons.map((r, i) => [r.id, `${hatchId}h${i}`] as const)),
    [ribbons, hatchId],
  );

  // input order is account identity order; the layout hands back painter's order
  const railOrder = useMemo(() => {
    const byId = new Map(layout.ribbons.map((r) => [r.id, r] as const));
    const out: TerrainRibbon[] = [];
    for (const r of ribbons) {
      const found = byId.get(r.id);
      if (found) out.push(found);
    }
    return out;
  }, [ribbons, layout]);

  const active = hovered === null ? null : (layout.ribbons.find((r) => r.id === hovered.id) ?? null);
  const hoveredDay = hovered?.day ?? null;
  const activeVertex =
    active === null
      ? null
      : (active.vertices.find((v) => v.day === hoveredDay) ?? active.vertices.at(-1) ?? null);
  const motion = reducedMotion ? "" : "transition-opacity duration-(--duration-fast) ease-(--ease-ink)";

  const pick = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const hit = nearestVertex(layout.ribbons, {
      x: (event.clientX - rect.left) * (size.w / rect.width),
      y: (event.clientY - rect.top) * (size.h / rect.height),
    });
    if (hit) setHovered({ id: hit.ribbon.id, day: hit.vertex.day });
  };

  if (layout.plane === null) {
    return <p className="text-sm text-ink-muted">No account history to draw yet.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <Slug layout={layout} ribbon={active} vertex={activeVertex} today={today} />
        <div className="flex flex-wrap items-center gap-2">
          <ViewSwitcher
            dimension={TERRAIN_LENS_DIMENSION}
            value={lens}
            onSelect={onSelectLens}
            labels={TERRAIN_LENS_LABELS}
            ariaLabel="Terrain lens"
          />
          <ViewSwitcher
            dimension={TERRAIN_VIEW_DIMENSION}
            value={viewpoint}
            onSelect={onSelectViewpoint}
            labels={TERRAIN_VIEW_LABELS}
            ariaLabel="Terrain viewpoint"
            disabled={lens !== "relief"}
          />
        </div>
      </div>

      {/* `*:min-w-0` is load-bearing below `lg`, gated by NetWorthTerrain.test.ts:
          the stage carries a literal `width={720}` <svg> until the ResizeObserver
          has measured, and a grid item's automatic minimum is its min-content
          size — without this the track floors at 720px and the dashboard scrolls
          sideways on a phone. */}
      <div className="grid gap-4 *:min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div>
          {lens === "relief" ? (
            <>
              <div
                ref={stageRef}
                className={`relative w-full overflow-hidden rounded-card border border-line bg-surface-sunken shadow-press-2 ${heightClass}`}
                onPointerLeave={() => setHovered(null)}
              >
                <svg
                  ref={svgRef}
                  width={size.w}
                  height={size.h}
                  viewBox={`0 0 ${size.w} ${size.h}`}
                  role="img"
                  aria-label={terrainDescription(layout, check.balanced)}
                  focusable="false"
                  className="block touch-pan-y"
                  onPointerMove={pick}
                >
                  <defs>
                    {/* the mark of an unverified span: hatched, never filled.
                        One pattern per identity colour so a broken span still
                        says which account it belongs to. */}
                    {layout.ribbons.map((r) => (
                      <pattern
                        key={r.id}
                        id={hatchIdByRibbon.get(r.id)}
                        width={6}
                        height={6}
                        patternUnits="userSpaceOnUse"
                        patternTransform="rotate(45)"
                      >
                        <line x1={0} y1={0} x2={0} y2={6} stroke={r.color} strokeWidth={1.4} opacity={0.55} />
                      </pattern>
                    ))}
                  </defs>

                  <g aria-hidden="true">
                    {/* the sheet the whole figure is printed on */}
                    <polygon
                      points={pointsAttr(layout.plane.sheet)}
                      fill="var(--surface-leaf)"
                      stroke="var(--line)"
                      strokeWidth={1}
                    />
                    {layout.plane.timeRules.map((rule, i) => (
                      <line
                        key={`t${i}`}
                        x1={rule[0].x}
                        y1={rule[0].y}
                        x2={rule[1].x}
                        y2={rule[1].y}
                        stroke="var(--line)"
                        strokeWidth={1}
                      />
                    ))}
                    {layout.fillClarity > 0 &&
                      layout.plane.depthRules.map((rule, i) => (
                        <line
                          key={`d${i}`}
                          x1={rule[0].x}
                          y1={rule[0].y}
                          x2={rule[1].x}
                          y2={rule[1].y}
                          stroke="var(--line)"
                          strokeWidth={0.75}
                          opacity={0.7}
                        />
                      ))}
                    {/* the zero rule is structural — it gets the strong ink */}
                    <line
                      x1={layout.plane.zeroRule[0].x}
                      y1={layout.plane.zeroRule[0].y}
                      x2={layout.plane.zeroRule[1].x}
                      y2={layout.plane.zeroRule[1].y}
                      stroke="var(--line-strong)"
                      strokeWidth={1.4}
                    />
                  </g>

                  {layout.ribbons.map((r) => (
                    <Ribbon
                      key={r.id}
                      ribbon={r}
                      hatchId={hatchIdByRibbon.get(r.id) ?? ""}
                      clarity={layout.fillClarity}
                      dimmed={hovered !== null && hovered.id !== r.id}
                      on={hovered?.id === r.id}
                      motion={motion}
                    />
                  ))}

                  {active && activeVertex && <Mark ribbon={active} vertex={activeVertex} />}

                  <g aria-hidden="true">
                    {/* from Plan the value axis has collapsed onto itself —
                        four figures stacked on one point are not a scale, so
                        they give way and the rail keeps the exact balances */}
                    {layout.valueAxisLegible &&
                      layout.valueTicks.map((tick) => (
                        <text
                          key={`v${tick.valueCents}`}
                          x={tick.point.x - 7}
                          y={tick.point.y + 3.5}
                          textAnchor="end"
                          className="figures text-[10.5px]"
                          fill={tick.valueCents < 0 ? "var(--negative)" : "var(--ink-faint)"}
                          style={HALO}
                        >
                          {tickLabel(tick.valueCents)}
                        </text>
                      ))}
                    {layout.timeTicks.map((tick) => (
                      <text
                        key={tick.day}
                        x={tick.point.x}
                        y={tick.point.y + 16}
                        textAnchor="middle"
                        className="figures text-[10.5px]"
                        fill="var(--annotation)"
                        style={HALO}
                      >
                        {formatMonthYear(tick.day)}
                      </text>
                    ))}
                    {layout.fillClarity > 0.35 && (
                      <>
                        <line
                          x1={layout.plane.depthAxis[0].x}
                          y1={layout.plane.depthAxis[0].y}
                          x2={layout.plane.depthAxis[1].x}
                          y2={layout.plane.depthAxis[1].y}
                          stroke="var(--line-strong)"
                          strokeWidth={1}
                        />
                        <text
                          x={(layout.plane.depthAxis[0].x + layout.plane.depthAxis[1].x) / 2 - 10}
                          y={(layout.plane.depthAxis[0].y + layout.plane.depthAxis[1].y) / 2}
                          textAnchor="end"
                          className="text-[9.5px] font-semibold uppercase tracking-eyebrow"
                          fill="var(--annotation)"
                          style={HALO}
                        >
                          Accounts
                        </text>
                      </>
                    )}
                  </g>
                </svg>
              </div>

              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-micro text-ink-faint">
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                  <li>
                    <b className="text-eyebrow font-semibold uppercase tracking-eyebrow text-ink-muted">Height</b>{" "}
                    balance
                  </li>
                  <li>
                    <b className="text-eyebrow font-semibold uppercase tracking-eyebrow text-ink-muted">Depth</b>{" "}
                    account
                  </li>
                  <li>
                    <b className="text-eyebrow font-semibold uppercase tracking-eyebrow text-ink-muted">Below rule</b>{" "}
                    owed{scaleBreakNote(layout)}
                  </li>
                  <li>
                    <b className="text-eyebrow font-semibold uppercase tracking-eyebrow text-ink-muted">Hatched</b>{" "}
                    span the ledger could not verify
                  </li>
                  <li>
                    <b className="text-eyebrow font-semibold uppercase tracking-eyebrow text-ink-muted">Colour</b>{" "}
                    account
                  </li>
                </ul>
                <span className="text-annotation">Hover a ribbon to read any day</span>
              </div>
            </>
          ) : (
            <TerrainTable ribbons={railOrder} layout={layout} today={today} />
          )}
        </div>

        <TerrainRail
          ribbons={railOrder}
          layout={layout}
          today={today}
          hovered={hovered?.id ?? null}
          onHover={(id) => setHovered(id === null ? null : { id, day: layout.lastDay ?? today })}
          hrefById={hrefById}
        />
      </div>

      <p className="mt-3 border-t border-line pt-2 text-micro text-ink-faint">{reconciliationNote(layout, check)}</p>
    </div>
  );
}

/** text over geometry is unreadable without a halo — that is how a 3D chart quietly fails */
const HALO: CSSProperties = {
  paintOrder: "stroke",
  stroke: "var(--surface-leaf)",
  strokeWidth: 3.5,
  strokeLinejoin: "round",
};

/**
 * One account's ribbon. A filled curtain only tells the truth when the ribbons
 * are actually apart on screen: dead on (Front) every ribbon lands in the same
 * place and depth carries nothing, so the fills give way and the crests do the
 * work. Rotate, and the fills earn their ink back — `fillClarity` is that
 * measurement, made in the pure layer.
 */
function Ribbon({
  ribbon,
  hatchId,
  clarity,
  dimmed,
  on,
  motion,
}: {
  ribbon: TerrainRibbon;
  hatchId: string;
  clarity: number;
  dimmed: boolean;
  on: boolean;
  motion: string;
}) {
  const earned = 0.1 + 0.5 * clarity;
  return (
    <g aria-hidden="true" className={motion} style={{ opacity: dimmed ? DIM_OPACITY : 1 }}>
      {ribbon.segments.map((segment, i) => (
        <g key={i}>
          <polygon
            points={pointsAttr(segment.face)}
            fill={segment.verified ? ribbon.color : `url(#${hatchId})`}
            fillOpacity={segment.verified ? earned : 0.5}
          />
          <polyline
            points={pointsAttr(segment.crest)}
            fill="none"
            stroke={ribbon.color}
            strokeWidth={on ? CREST_WIDTH_ON : CREST_WIDTH}
            strokeLinejoin="round"
            strokeLinecap="round"
            {...(segment.verified ? {} : { strokeDasharray: "3 3" })}
          />
        </g>
      ))}
      {/* a single covered day is a mark, not a curtain — draw it, or the
          account silently disappears from a figure that lists it */}
      {ribbon.segments.length === 0 &&
        ribbon.vertices.map((v) => (
          <circle key={v.day} cx={v.point.x} cy={v.point.y} r={2.4} fill={ribbon.color} />
        ))}
    </g>
  );
}

/** The scrub mark: a dropped line to the plane and a ring on the crest. */
function Mark({ ribbon, vertex }: { ribbon: TerrainRibbon; vertex: TerrainVertex }) {
  return (
    <g aria-hidden="true">
      <line
        x1={vertex.foot.x}
        y1={vertex.foot.y}
        x2={vertex.point.x}
        y2={vertex.point.y}
        stroke="var(--ink-display)"
        strokeWidth={1}
        strokeDasharray="2 3"
        opacity={0.7}
      />
      <circle
        cx={vertex.point.x}
        cy={vertex.point.y}
        r={4.2}
        fill="var(--surface-leaf)"
        stroke={ribbon.color}
        strokeWidth={2.5}
      />
    </g>
  );
}

/** The printed slug — the whole figure, or whatever the pointer is on. */
function Slug({
  layout,
  ribbon,
  vertex,
  today,
}: {
  layout: TerrainLayout;
  ribbon: TerrainRibbon | null;
  vertex: TerrainVertex | null;
  today: string;
}) {
  // NOT a live region: this changes on every ribbon the pointer crosses, and AT
  // would announce a new account each time. The figure's own aria-label and the
  // rail carry these numbers for a screen reader.
  if (ribbon === null || vertex === null) {
    return (
      <div className="min-w-0">
        <div className="text-eyebrow uppercase tracking-eyebrow text-ink-faint">Net worth · {formatDayLong(today)}</div>
        <div className="figures text-display-2 font-medium text-ink-display">
          {formatCents(layout.totalLatestCents)}
        </div>
        <div className="text-micro text-ink-faint">
          {formatCents(layout.assetsLatestCents)} held, {formatCents(layout.owedLatestCents)} owed, across{" "}
          {layout.ribbonCount} {layout.ribbonCount === 1 ? "account" : "accounts"}
        </div>
      </div>
    );
  }
  const since = vertex.valueCents - ribbon.firstCents;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-eyebrow text-ink-faint">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-[2px]"
          style={{ background: ribbon.color, boxShadow: "inset 0 1px 0 var(--emboss-hi)" }}
        />
        <span className="truncate">{ribbon.label}</span>
      </div>
      <div className="figures text-display-2 font-medium text-ink-display">{formatCents(vertex.valueCents)}</div>
      <div className="text-micro text-ink-faint">
        {formatDayLong(vertex.day)} · {formatCentsSigned(since)} since{" "}
        {ribbon.firstDay === null ? "the start" : formatMonthYear(ribbon.firstDay)}
        {vertex.verified ? "" : " · this day is estimated"}
      </div>
    </div>
  );
}

/**
 * ⛔ ONE ANSWER FOR THE WHOLE ROW — and for BOTH lenses of it. Columns used to
 * decide separately whether a ribbon had anything to say; two of them said
 * "$0.00", and the legend beside the relief kept a third opinion after the
 * table was fixed. Everything either lens prints about a row comes from here.
 */
const rowFigures = (r: TerrainRibbon): TerrainRowFigures =>
  terrainRowFigures(r, { cents: formatCents, signed: formatCentsSigned, monthYear: formatMonthYear });

/**
 * The rail beside the plate. This is where the exact numbers are, and where the
 * keyboard and a screen reader reach each account page — the drawing itself is
 * one labelled figure, so it can never be the only route.
 */
/**
 * Which side of the rule a row sits on — ONE rule, because two surfaces on this
 * card print it.
 *
 * ⛔ A card the bank owes on is still on the owed side; it is just in credit.
 * The Table lens has said so since it shipped and the rail beside it printed a
 * bare "owed" over a positive figure — `Chase Sapphire`, +$82.72 since Feb
 * 2025, measured 2026-09-10.
 */
export function sideLabel(r: { isLiability: boolean; lastCents: number }): string {
  if (!r.isLiability) return "Held";
  return r.lastCents > 0 ? "Owed · in credit" : "Owed";
}

/** The rail's lower-case tag, blank for an asset — the same rule as `sideLabel`. */
export function sideTag(r: { isLiability: boolean; lastCents: number }): string {
  return r.isLiability ? sideLabel(r).toLowerCase() : "";
}

function TerrainRail({
  ribbons,
  layout,
  today,
  hovered,
  onHover,
  hrefById,
}: {
  ribbons: readonly TerrainRibbon[];
  layout: TerrainLayout;
  today: string;
  hovered: string | null;
  onHover: (id: string | null) => void;
  hrefById?: Readonly<Record<string, string>>;
}) {
  const widest = Math.max(1, ...ribbons.map((r) => Math.abs(r.lastCents)));
  return (
    <div className="rounded-card border border-line bg-surface-leaf p-3 shadow-press-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-eyebrow uppercase tracking-eyebrow text-ink-muted">
          {layout.ribbonCount} {layout.ribbonCount === 1 ? "account" : "accounts"}
        </span>
        <span className="text-eyebrow uppercase tracking-eyebrow text-annotation">{formatDayLong(today)}</span>
      </div>
      <ul className="mt-2 divide-y divide-line lg:max-h-[24rem] lg:overflow-y-auto">
        {ribbons.map((r, i) => {
          const on = hovered === r.id;
          const href = hrefById?.[r.id] ?? `/accounts/${encodeURIComponent(r.id)}`;
          return (
            <li key={r.id} onPointerEnter={() => onHover(r.id)} onPointerLeave={() => onHover(null)}>
              <Link
                href={href}
                onFocus={() => onHover(r.id)}
                onBlur={() => onHover(null)}
                className={`flex w-full items-start gap-2 rounded px-1 py-2 text-left hover:bg-surface-sunken ${
                  on ? "bg-surface-sunken" : ""
                }`}
              >
                <span className="figures w-5 shrink-0 text-eyebrow text-ink-faint">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  aria-hidden
                  className="mt-1 size-2.5 shrink-0 rounded-[2px]"
                  style={{ background: r.color, boxShadow: "inset 0 1px 0 var(--emboss-hi)" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-sm">{r.label}</span>
                    {/* 🔴 "owed" beside a POSITIVE figure. The table lens sixty
                        lines below has had the rule since it shipped — "a card
                        the bank owes on is still on the owed side, it is just
                        in credit" — and this rail, over the same rows, printed
                        the bare word. Measured 2026-09-10: `Chase Sapphire`
                        reads "owed +$82.72 since Feb 2025" and its own row in
                        the Table lens reads "Owed · in credit". */}
                    <span className="shrink-0 text-eyebrow text-ink-faint">{sideTag(r)}</span>
                  </span>
                  {/* ⛔ THE SAME ANSWER THE TABLE GIVES. This built its own
                      sentence and its own figure, so the row the table lens
                      prints as three em dashes read "level since — · $0.00"
                      here — a date that is not there and a balance nobody has.
                      Both come from `terrainRowFigures` now. */}
                  <span className="block text-micro text-ink-faint">
                    {rowFigures(r).since}
                    {r.fullyVerified ? "" : ` · ${r.unverifiedSpanCount} unverified`}
                  </span>
                  {/* decorative: the balance is already set in figures beside it */}
                  <span aria-hidden className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-sunken">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${(Math.abs(r.lastCents) / widest) * 100}%`,
                        background: r.color,
                        opacity: r.isLiability ? 0.55 : 1,
                      }}
                    />
                  </span>
                </span>
                <span className="figures shrink-0 text-sm font-medium">{rowFigures(r).today}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 *:min-w-0 border-t-2 border-ink-display pt-2 text-micro">
        <span>
          Net worth <span className="text-ink-faint">· held less owed</span>
        </span>
        <b className="figures font-semibold text-ink-display">{formatCents(layout.totalLatestCents)}</b>
      </div>
    </div>
  );
}

// ── The table lens ───────────────────────────────────────────────────

function TerrainTable({
  ribbons,
  layout,
  today,
}: {
  ribbons: readonly TerrainRibbon[];
  layout: TerrainLayout;
  today: string;
}) {
  const cells = rowFigures;
  const columns: Column<TerrainRibbon>[] = [
    {
      key: "account",
      header: "Account",
      render: (r) => (
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: r.color }} />
          <span className="truncate">{r.label}</span>
        </span>
      ),
    },
    { key: "side", header: "Side", render: (r) => sideLabel(r) },
    {
      key: "from",
      header: "First day",
      align: "right",
      render: (r) => <span className="figures text-ink-faint">{cells(r).first}</span>,
    },
    {
      key: "today",
      header: "Today",
      align: "right",
      render: (r) => <span className="figures font-medium">{cells(r).today}</span>,
    },
    {
      key: "change",
      header: "Change",
      align: "right",
      render: (r) => {
        const c = cells(r);
        return (
          <span className={`figures ${!c.changeSign ? "" : c.changeSign > 0 ? "text-positive" : "text-negative"}`}>
            {c.change}
          </span>
        );
      },
    },
    {
      key: "verified",
      header: "Verified",
      align: "right",
      render: (r) => <span className="figures text-ink-faint">{cells(r).verified}</span>,
    },
  ];
  return (
    <div>
      <DataTable
        columns={columns}
        rows={ribbons}
        rowKey={(r) => r.id}
        rowHref={(r) => `/accounts/${encodeURIComponent(r.id)}`}
        caption={terrainTableCaption(ribbons, formatDayLong(today))}
        emptyState="No account history to draw yet."
      />
      <p className="mt-2 text-micro text-ink-faint">
        Net worth today <b className="figures text-ink-display">{formatCents(layout.totalLatestCents)}</b> —{" "}
        {formatCents(layout.assetsLatestCents)} held less {formatCents(layout.owedLatestCents)} owed.
      </p>
    </div>
  );
}

// ── Words ────────────────────────────────────────────────────────────

/** Compact axis figure: "$21k" / "$840" / "−$1k". Deterministic, no locale. */
function tickLabel(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const sign = cents < 0 ? "−" : "";
  return dollars >= 1000 ? `${sign}$${Math.round(dollars / 1000)}k` : `${sign}$${Math.round(dollars)}`;
}

/** "· scale broken ×11" — never a broken scale without the factor beside it. */
function scaleBreakNote(layout: TerrainLayout): string {
  if (layout.debtMultiple === null || layout.debtMultiple <= 1) return "";
  return ` · scale broken ×${Math.round(layout.debtMultiple)}`;
}

/** The figure, described. Names every encoding and points at the exact numbers. */
function terrainDescription(layout: TerrainLayout, balanced: boolean): string {
  /* ⛔ the ribbons DRAWN, not the accounts fed in — see `drawnRibbonCount` for
     the twelfth one this used to promise a reader who cannot see the figure */
  const n = drawnRibbonCount(layout.ribbons);
  const blank = layout.ribbonCount - n;
  const undrawn =
    blank === 0
      ? ""
      : ` ${blank} ${blank === 1 ? "account has" : "accounts have"} no reconstructed day at all and ${
          blank === 1 ? "is" : "are"
        } not drawn.`;
  const span =
    layout.firstDay === null || layout.lastDay === null
      ? ""
      : ` from ${formatMonthYear(layout.firstDay)} to ${formatMonthYear(layout.lastDay)}`;
  const owed =
    layout.owedLatestCents === 0
      ? "Nothing is owed, so nothing extrudes below the plane."
      : `What is owed extrudes below the plane${
          layout.debtMultiple !== null && layout.debtMultiple > 1
            ? ` on a scale broken ${Math.round(layout.debtMultiple)} times`
            : ""
        }, because the ${formatCents(layout.owedLatestCents)} owed sits under ${formatCents(
          layout.assetsLatestCents,
        )} held.`;
  const holes =
    layout.unverifiedSpanCount === 0
      ? "Every drawn span is verified against the ledger."
      : `${layout.unverifiedSpanCount} span${
          layout.unverifiedSpanCount === 1 ? " is" : "s are"
        } drawn broken, because the ledger cannot verify them.`;
  const sum = balanced
    ? `The ribbons sum to ${formatCents(layout.totalLatestCents)}, the same net worth as the chart above.`
    : `The ribbons sum to ${formatCents(layout.totalLatestCents)}, which does NOT match the net-worth chart above — read the ledger.`;
  return (
    `Net worth terrain. ${n} account ribbon${n === 1 ? "" : "s"} across ${layout.columnCount} drawn day${
      layout.columnCount === 1 ? "" : "s"
    }${span}.${undrawn} Height above the zero plane is the account's balance and depth separates the accounts. ${owed} ${holes} ` +
    `${sum} Exact figures for every account are in the list beside the chart and in the Table lens.`
  );
}

/**
 * The figure says out loud how it relates to the net-worth line above it, and
 * says so LOUDEST when it does not balance. A silent disagreement between two
 * charts of the same money is the failure this line exists to prevent.
 */
function reconciliationNote(
  layout: TerrainLayout,
  check: ReturnType<typeof reconcileTerrain>,
): string {
  const head = `${formatCents(layout.totalLatestCents)} across these ${layout.ribbonCount} accounts`;
  if (!check.balanced) {
    // the FIRST disagreement with its OWN figure (not the worst one's amount
    // pinned to the first one's date — that pairing would itself be a lie)
    const first = check.residuals[0]!;
    const more = check.residuals.length - 1;
    const rest =
      more === 0
        ? ""
        : ` and on ${more} other day${more === 1 ? "" : "s"} (worst ${formatCentsSigned(check.worstResidualCents)})`;
    return `${head}. These ribbons disagree with the net-worth chart above by ${formatCentsSigned(first.residualCents)} on ${formatDayLong(first.day)}${rest} — the two figures are counting different rows, so read the ledger.`;
  }
  const skipped =
    check.skippedDays === 0
      ? ""
      : ` ${check.skippedDays} partial day${check.skippedDays === 1 ? " is" : "s are"} not compared: the net-worth line drops an account it cannot cover that day, while each ribbon keeps its own last statement.`;
  return `${head} — summed day by day, these ribbons equal the net-worth chart above on all ${check.checkedDays} day${check.checkedDays === 1 ? "" : "s"} it calls complete.${skipped}`;
}
