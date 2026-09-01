/**
 * Pure net-worth-terrain geometry — "Two years of every account" (Direction A+).
 * Per-account daily balances in, projected polygons out. No React, no DOM, no
 * Date, no random: the same rows always produce byte-identical points, which is
 * what lets the Playwright visual baselines hold over an SVG figure.
 *
 * THE ENCODINGS, all carrying real data, all restated in words by the renderer:
 *   · one RIBBON per account, drawn along time
 *   · HEIGHT off the zero plane — that account's balance. Assets RISE above the
 *     rule; liabilities EXTRUDE BELOW it (values arrive net-worth-signed).
 *   · DEPTH — which account it is: each ribbon sits on its own plane rule
 *   · COLOUR — account identity (never the only carrier of a fact)
 *
 * The projector is orthographic — no perspective divide — so a balance's
 * projected extent stays proportional to the balance at every camera angle.
 * Four named viewpoints, no free tumble (see `TERRAIN_VIEWPOINTS`).
 *
 * TWO HONESTY RULES ARE PART OF THE GEOMETRY, not of the styling:
 *
 * 1. A SPAN THE LEDGER COULD NOT VERIFY IS NEVER DRAWN AS A SURFACE. derivation
 *    marks a span it cannot reconstruct as `gap` and refuses to publish it, and
 *    multi-series flags every carried/estimated day `complete: false`. Sampling
 *    a long axis down to drawable columns could hide exactly those days between
 *    two samples, so a column's span is verified only when EVERY day it stands
 *    for is (`spanVerification`) — and an unverified span comes back as its own
 *    segment for the renderer to break and say so.
 *
 * 2. THE SCALE BELOW THE RULE IS BROKEN OUT LOUD. A $1.4k card balance under
 *    $112k of assets is a hairline at a shared scale, so the debt side gets its
 *    own scale — and `debtMultiple` states the factor, for the renderer to
 *    print. A silently broken scale is a lie with a straight face.
 *
 * RECONCILIATION IS PART OF THE MODULE: `reconcileTerrain` proves the summed
 * ribbons equal the net-worth series the hero chart draws, to the cent, on every
 * day that series calls complete.
 */

import { CATEGORY_HUE_NAMES, categoryHueVar } from "./category-palette";
import { compareDates } from "./dates";

// ── Inputs ───────────────────────────────────────────────────────────

/** One account-day. `valueCents` is NET-WORTH-SIGNED: a liability is negative. */
export interface TerrainDayInput {
  day: string;
  valueCents: number;
  /** false for any day the ledger cannot stand behind — a day carried across a
   *  gap, or an estimated basis. Exactly multi-series' `complete` flag. */
  verified: boolean;
}

export interface TerrainRibbonInput {
  id: string;
  label: string;
  isLiability: boolean;
  /** CSS colour for this account's identity; defaults to `terrainColor(index)` */
  color?: string;
  /** oldest-first, day-unique. Days the account does not cover are ABSENT. */
  points: readonly TerrainDayInput[];
}

export interface TerrainCamera {
  azimuthDeg: number;
  elevationDeg: number;
}

export type TerrainViewpoint = "front" | "quarter" | "side" | "plan";

/**
 * Front folds the depth away and reads as a plain balance chart; quarter shows
 * height and depth at once; side looks along time and ranks the accounts; plan
 * looks straight down at the account planes. No free tumble: a camera that lies
 * about which ribbon is in front is not offered.
 */
export const TERRAIN_VIEWPOINTS: Record<TerrainViewpoint, TerrainCamera> = {
  front: { azimuthDeg: 0, elevationDeg: 0 },
  quarter: { azimuthDeg: 34, elevationDeg: 27 },
  side: { azimuthDeg: 78, elevationDeg: 10 },
  plan: { azimuthDeg: 0, elevationDeg: 82 },
};

export interface TerrainLayoutOptions {
  width: number;
  height: number;
  camera: TerrainCamera;
  /** drawable columns along time (default 104 — one per fortnight over 4 years) */
  maxColumns?: number;
  /** world px the time axis spans (default 82% of width) */
  span?: number;
  /** world px between neighbouring account planes (default ≤26) */
  depthStep?: number;
  /** world px of relief for the largest asset balance (default 42% of height) */
  upPx?: number;
  /** world px the debt side may claim once its scale is broken (default 14%) */
  downPx?: number;
}

// ── Outputs ──────────────────────────────────────────────────────────

export interface TerrainPoint {
  x: number;
  y: number;
}

export type TerrainLine = [TerrainPoint, TerrainPoint];

export interface TerrainVertex {
  day: string;
  valueCents: number;
  /** this DAY's own verification (the span behind it lives on the segment) */
  verified: boolean;
  /** the crest — the balance */
  point: TerrainPoint;
  /** the foot on the zero plane, directly under (or over) the crest */
  foot: TerrainPoint;
}

export interface TerrainSegment {
  /** false ⇒ every day this span stands for is NOT verified: draw it broken */
  verified: boolean;
  /** the closed curtain: crest, then the feet back again */
  face: TerrainPoint[];
  /** the top edge alone */
  crest: TerrainPoint[];
}

export interface TerrainRibbon {
  id: string;
  label: string;
  color: string;
  isLiability: boolean;
  /** contiguous drawable spans; a break or a change of verification ends one */
  segments: TerrainSegment[];
  /** every drawn column, for hover, the mark and the readout */
  vertices: TerrainVertex[];
  firstDay: string | null;
  lastDay: string | null;
  firstCents: number;
  lastCents: number;
  /** lastCents − firstCents over the drawn span */
  deltaCents: number;
  /** how many drawn spans the ledger could not verify */
  unverifiedSpanCount: number;
  /** true when every drawn span is verified (vacuously true with nothing drawn) */
  fullyVerified: boolean;
}

export interface TerrainPlane {
  sheet: TerrainPoint[];
  /** rules across time */
  timeRules: TerrainLine[];
  /** one rule per account plane, back → front */
  depthRules: TerrainLine[];
  /** the zero rule: structural, the line the whole figure is read against */
  zeroRule: TerrainLine;
  /** the account axis along the sheet's left edge */
  depthAxis: TerrainLine;
}

export interface TerrainValueTick {
  valueCents: number;
  point: TerrainPoint;
}

export interface TerrainTimeTick {
  day: string;
  point: TerrainPoint;
}

export interface TerrainLayout {
  /** painter's order, far → near: render in array order */
  ribbons: TerrainRibbon[];
  plane: TerrainPlane | null;
  valueTicks: TerrainValueTick[];
  timeTicks: TerrainTimeTick[];
  width: number;
  height: number;
  /** the days actually drawn, oldest first */
  columnDays: string[];
  firstDay: string | null;
  lastDay: string | null;
  /** projected px between two neighbouring account planes */
  separationPx: number;
  /** 0..1 — how far apart the depth axis has actually pushed the ribbons on
   *  screen. A filled curtain only tells the truth when they ARE apart; dead-on
   *  they land on each other and the fills must give way to the crests. */
  fillClarity: number;
  maxAssetCents: number;
  minLiabilityCents: number;
  /**
   * false once the camera is steep enough that the value axis has collapsed
   * onto itself — MEASURED, from Plan the ticks land within 7px of each other,
   * and a stack of figures on one point is not a scale. The renderer drops
   * them; the exact balances were always in the rail and the Table lens.
   */
  valueAxisLegible: boolean;
  /** How many times larger a px is below the rule than above it — printed by
   *  the renderer. 1 = one shared scale; null = nothing to compare against. */
  debtMultiple: number | null;
  /** Σ every ribbon's last known balance — the ledger's net worth today */
  totalLatestCents: number;
  assetsLatestCents: number;
  owedLatestCents: number;
  ribbonCount: number;
  columnCount: number;
  /** Σ every ribbon's unverified spans */
  unverifiedSpanCount: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEG = Math.PI / 180;
const MIN_CANVAS = 80;
const DEFAULT_MAX_COLUMNS = 104;
const SPAN_RATIO = 0.82;
const UP_RATIO = 0.42;
const DOWN_RATIO = 0.14;
const DEPTH_RATIO = 0.055;
const MAX_DEPTH_STEP = 26;
const PLANE_MARGIN_X = 10;
const PLANE_MARGIN_Z = 10;
/**
 * The gutter the value axis is SET in. MEASURED: the fit only ever sees a
 * tick's anchor POINT, so a right-anchored "$51k" hangs ~37px left of it and
 * was clipped clean off the plate at every viewpoint until this existed.
 */
const PAD_LEFT = 44;
const PAD_RIGHT = 10;
const PAD_TOP = 16;
const PAD_BOTTOM = 22;
/** past this elevation the value axis has collapsed onto itself (see layout) */
const VALUE_AXIS_MAX_ELEVATION = 55;
/** rules across the sheet: TIME_RULES + 1 lines */
const TIME_RULES = 6;
/** value ticks above the rule: VALUE_STEPS + 1 (0 included) */
const VALUE_STEPS = 3;
/** labelled days, and the same on a plate too narrow for five: a 10.5px
 *  "Aug 2024" is ~45px wide, so five collide below ~560px — which is exactly
 *  the width he reads this on most. */
const TIME_TICKS = 5;
const TIME_TICKS_NARROW = 3;
const NARROW_PLATE = 560;
/** projected separation at which a filled curtain has fully earned its ink */
const SEPARATION_FULL_PX = 8;
/** guards every fit division; never a branch, so degenerate input cannot NaN */
const EPS = 1e-6;

/**
 * Account identity colour: a stride-5 walk over the 12-hue ramp, so adjacent
 * accounts get distant hues. MUST match `accountColor` in DashboardChartSection
 * — a ribbon that changes colour when the reader switches lens is a different
 * account to the eye. Callers holding a colour map pass `color` per ribbon.
 */
export function terrainColor(index: number): string {
  const hues = CATEGORY_HUE_NAMES;
  // a negative index would wrap the wrong way; clamp rather than throw at render
  const i = Math.max(0, Math.floor(index));
  return categoryHueVar(hues[(i * 5) % hues.length]!);
}

// ── Layout ───────────────────────────────────────────────────────────

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface WorldVertex {
  day: string;
  valueCents: number;
  verified: boolean;
  /** position in the sampled column list — adjacency is how a break is found */
  col: number;
  crest: Vec3;
  foot: Vec3;
}

interface WorldRibbon {
  input: TerrainRibbonInput;
  color: string;
  vertices: WorldVertex[];
  runs: { from: number; to: number; verified: boolean }[];
  unverifiedSpanCount: number;
  centre: Vec3;
}

export function computeTerrainLayout(
  inputs: readonly TerrainRibbonInput[],
  options: TerrainLayoutOptions,
): TerrainLayout {
  const width = Math.max(options.width, MIN_CANVAS);
  const height = Math.max(options.height, MIN_CANVAS);
  const days = unionDays(inputs);

  if (days.length === 0) {
    return {
      ribbons: [],
      plane: null,
      valueTicks: [],
      timeTicks: [],
      width,
      height,
      columnDays: [],
      firstDay: null,
      lastDay: null,
      separationPx: 0,
      fillClarity: 0,
      maxAssetCents: 0,
      minLiabilityCents: 0,
      valueAxisLegible: options.camera.elevationDeg < VALUE_AXIS_MAX_ELEVATION,
      debtMultiple: null,
      totalLatestCents: 0,
      assetsLatestCents: 0,
      owedLatestCents: 0,
      ribbonCount: inputs.length,
      columnCount: 0,
      unverifiedSpanCount: 0,
    };
  }

  const cols = sampleIndices(days.length, options.maxColumns ?? DEFAULT_MAX_COLUMNS);
  const span = options.span ?? width * SPAN_RATIO;
  const halfX = span / 2;
  const depthStep = options.depthStep ?? Math.min(MAX_DEPTH_STEP, height * DEPTH_RATIO);
  const scale = valueScale(inputs, {
    upPx: options.upPx ?? height * UP_RATIO,
    downPx: options.downPx ?? height * DOWN_RATIO,
  });

  const denom = Math.max(days.length - 1, 1);
  const xAt = (dayIndex: number): number => -halfX + (dayIndex / denom) * halfX * 2;
  const zAt = (ribbonIndex: number): number => (ribbonIndex - (inputs.length - 1) / 2) * depthStep;

  const world: WorldRibbon[] = inputs.map((input, ri) =>
    buildRibbon(input, ri, { days, cols, xAt, zAt, scale }),
  );

  const zBack = zAt(0) - PLANE_MARGIN_Z;
  const zFront = zAt(Math.max(inputs.length - 1, 0)) + PLANE_MARGIN_Z;
  const sheet: Vec3[] = [
    { x: -halfX - PLANE_MARGIN_X, y: 0, z: zBack },
    { x: halfX + PLANE_MARGIN_X, y: 0, z: zBack },
    { x: halfX + PLANE_MARGIN_X, y: 0, z: zFront },
    { x: -halfX - PLANE_MARGIN_X, y: 0, z: zFront },
  ];
  const timeRules: [Vec3, Vec3][] = [];
  for (let k = 0; k <= TIME_RULES; k++) {
    const x = -halfX + halfX * 2 * (k / TIME_RULES);
    timeRules.push([
      { x, y: 0, z: zBack },
      { x, y: 0, z: zFront },
    ]);
  }
  const depthRules: [Vec3, Vec3][] = inputs.map((_, ri) => [
    { x: -halfX, y: 0, z: zAt(ri) },
    { x: halfX, y: 0, z: zAt(ri) },
  ]);
  const zeroRule: [Vec3, Vec3] = [sheet[3]!, sheet[2]!];
  const depthAxis: [Vec3, Vec3] = [
    { x: -halfX - PLANE_MARGIN_X, y: 0, z: zBack },
    { x: -halfX - PLANE_MARGIN_X, y: 0, z: zFront },
  ];

  const valueWorldTicks = tickValues(scale.maxAssetCents, scale.minLiabilityCents).map((cents) => ({
    valueCents: cents,
    world: { x: -halfX, y: scale.toY(cents), z: zBack },
  }));
  const timeWorldTicks = tickIndices(days.length, width).map((i) => ({
    day: days[i]!,
    world: { x: xAt(i), y: 0, z: zFront },
  }));

  const worldPoints: Vec3[] = [
    ...sheet,
    ...timeRules.flat(),
    ...depthRules.flat(),
    ...depthAxis,
    ...valueWorldTicks.map((t) => t.world),
    ...timeWorldTicks.map((t) => t.world),
    ...world.flatMap((r) => r.vertices.flatMap((v) => [v.crest, v.foot])),
  ];
  const fit = fitCamera(worldPoints, options.camera, width, height);
  const project = (v: Vec3): TerrainPoint => projectPoint(v, options.camera, fit);
  const line = (l: [Vec3, Vec3]): TerrainLine => [project(l[0]), project(l[1])];

  const p0 = project({ x: 0, y: 0, z: 0 });
  const p1 = project({ x: 0, y: 0, z: depthStep });
  const separationPx = round(Math.hypot(p1.x - p0.x, p1.y - p0.y));

  const ordered = [...world].sort(
    (a, b) => depthOf(a.centre, options.camera) - depthOf(b.centre, options.camera),
  );

  const latest = world.map((r) => r.vertices.at(-1)?.valueCents ?? 0);
  return {
    ribbons: ordered.map((r) => toRibbon(r, project)),
    plane: {
      sheet: sheet.map(project),
      timeRules: timeRules.map(line),
      depthRules: depthRules.map(line),
      zeroRule: line(zeroRule),
      depthAxis: line(depthAxis),
    },
    valueTicks: valueWorldTicks.map((t) => ({ valueCents: t.valueCents, point: project(t.world) })),
    timeTicks: timeWorldTicks.map((t) => ({ day: t.day, point: project(t.world) })),
    width,
    height,
    columnDays: cols.map((i) => days[i]!),
    firstDay: days[0]!,
    lastDay: days.at(-1)!,
    separationPx,
    fillClarity: round(Math.min(1, separationPx / SEPARATION_FULL_PX)),
    maxAssetCents: scale.maxAssetCents,
    minLiabilityCents: scale.minLiabilityCents,
    valueAxisLegible: options.camera.elevationDeg < VALUE_AXIS_MAX_ELEVATION,
    debtMultiple: scale.debtMultiple,
    totalLatestCents: sum(latest),
    assetsLatestCents: sum(latest.map((v) => Math.max(0, v))),
    owedLatestCents: -sum(latest.map((v) => Math.min(0, v))),
    ribbonCount: inputs.length,
    columnCount: cols.length,
    unverifiedSpanCount: sum(world.map((r) => r.unverifiedSpanCount)),
  };
}

/** Sorted unique union of every ribbon's days — the shared time axis. */
export function unionDays(inputs: readonly TerrainRibbonInput[]): string[] {
  const set = new Set<string>();
  for (const input of inputs) for (const p of input.points) set.add(p.day);
  return [...set].sort((a, b) => compareDates(a, b));
}

/**
 * Which day indices become drawn columns: evenly spaced, ALWAYS including the
 * first and last day — so the figure's ends are the ledger's ends, and the
 * sampling depends on nothing but the two counts.
 */
export function sampleIndices(count: number, max: number): number[] {
  if (count <= 0) return [];
  const wanted = Math.max(2, Math.floor(max));
  if (count <= wanted) return Array.from({ length: count }, (_, i) => i);
  // count > wanted ⇒ the stride is strictly greater than 1, so rounding a
  // strictly increasing sequence cannot repeat an index — no dedupe needed.
  return Array.from({ length: wanted }, (_, k) => Math.round((k * (count - 1)) / (wanted - 1)));
}

interface ValueScale {
  toY: (cents: number) => number;
  maxAssetCents: number;
  minLiabilityCents: number;
  debtMultiple: number | null;
}

/**
 * The two-sided scale. Assets get the whole up-side; the debt side keeps the
 * SAME scale whenever that already reads, and is blown up to the reserved depth
 * otherwise — with `debtMultiple` stating the factor. Never break it silently.
 */
function valueScale(
  inputs: readonly TerrainRibbonInput[],
  px: { upPx: number; downPx: number },
): ValueScale {
  let maxAssetCents = 0;
  let minLiabilityCents = 0;
  for (const input of inputs) {
    for (const p of input.points) {
      if (p.valueCents > maxAssetCents) maxAssetCents = p.valueCents;
      if (p.valueCents < minLiabilityCents) minLiabilityCents = p.valueCents;
    }
  }
  const upPerCent = maxAssetCents > 0 ? px.upPx / maxAssetCents : 0;
  const owed = Math.abs(minLiabilityCents);
  const naturalDownPx = owed * upPerCent;
  const downPx = owed > 0 ? Math.max(naturalDownPx, px.downPx) : 0;
  const downPerCent = owed > 0 ? downPx / owed : 0;
  const debtMultiple =
    upPerCent > 0 && downPerCent > 0 ? round(downPerCent / upPerCent) : null;
  return {
    toY: (cents) => (cents >= 0 ? cents * upPerCent : cents * downPerCent),
    maxAssetCents,
    minLiabilityCents,
    debtMultiple,
  };
}

interface RibbonGeometry {
  days: readonly string[];
  cols: readonly number[];
  xAt: (dayIndex: number) => number;
  zAt: (ribbonIndex: number) => number;
  scale: ValueScale;
}

function buildRibbon(
  input: TerrainRibbonInput,
  ribbonIndex: number,
  geom: RibbonGeometry,
): WorldRibbon {
  const byDay = new Map(input.points.map((p) => [p.day, p] as const));
  const z = geom.zAt(ribbonIndex);
  const spanVerified = spanVerification(byDay, geom.days, geom.cols);

  const vertices: WorldVertex[] = [];
  for (let k = 0; k < geom.cols.length; k++) {
    const dayIndex = geom.cols[k]!;
    const day = geom.days[dayIndex]!;
    const point = byDay.get(day);
    if (point === undefined) continue; // the account does not cover this column
    const x = geom.xAt(dayIndex);
    vertices.push({
      day,
      valueCents: point.valueCents,
      verified: point.verified,
      col: k,
      crest: { x, y: geom.scale.toY(point.valueCents), z },
      foot: { x, y: 0, z },
    });
  }

  const runs: WorldRibbon["runs"] = [];
  let unverifiedSpanCount = 0;
  for (let i = 1; i < vertices.length; i++) {
    const prev = vertices[i - 1]!;
    const here = vertices[i]!;
    if (here.col !== prev.col + 1) continue; // a hole in coverage breaks the ribbon
    const verified = spanVerified[here.col]!;
    if (!verified) unverifiedSpanCount += 1;
    const last = runs.at(-1);
    if (last !== undefined && last.to === i - 1 && last.verified === verified) last.to = i;
    else runs.push({ from: i - 1, to: i, verified });
  }

  return {
    input,
    color: input.color ?? terrainColor(ribbonIndex),
    vertices,
    runs,
    unverifiedSpanCount,
    centre: { x: 0, y: 0, z },
  };
}

/**
 * Honesty rule 1, in code. A drawn span stands for every day between its two
 * sampled columns, so it is verified only when ALL of those days are covered
 * AND verified — otherwise sampling would smooth a gap the ledger refused.
 */
function spanVerification(
  byDay: ReadonlyMap<string, TerrainDayInput>,
  days: readonly string[],
  cols: readonly number[],
): boolean[] {
  const out = new Array<boolean>(cols.length).fill(true);
  for (let k = 1; k < cols.length; k++) {
    let ok = true;
    for (let i = cols[k - 1]!; i <= cols[k]!; i++) {
      const point = byDay.get(days[i]!);
      if (point === undefined || !point.verified) {
        ok = false;
        break;
      }
    }
    out[k] = ok;
  }
  return out;
}

function toRibbon(r: WorldRibbon, project: (v: Vec3) => TerrainPoint): TerrainRibbon {
  const vertices: TerrainVertex[] = r.vertices.map((v) => ({
    day: v.day,
    valueCents: v.valueCents,
    verified: v.verified,
    point: project(v.crest),
    foot: project(v.foot),
  }));
  const segments: TerrainSegment[] = r.runs.map((run) => {
    const slice = vertices.slice(run.from, run.to + 1);
    const crest = slice.map((v) => v.point);
    const feet = slice.map((v) => v.foot).reverse();
    return { verified: run.verified, face: [...crest, ...feet], crest };
  });
  const first = r.vertices[0];
  const last = r.vertices.at(-1);
  const firstCents = first?.valueCents ?? 0;
  const lastCents = last?.valueCents ?? 0;
  return {
    id: r.input.id,
    label: r.input.label,
    color: r.color,
    isLiability: r.input.isLiability,
    segments,
    vertices,
    firstDay: first?.day ?? null,
    lastDay: last?.day ?? null,
    firstCents,
    lastCents,
    deltaCents: lastCents - firstCents,
    unverifiedSpanCount: r.unverifiedSpanCount,
    fullyVerified: r.unverifiedSpanCount === 0,
  };
}

// ── Projection ───────────────────────────────────────────────────────

interface Fit {
  scale: number;
  cx: number;
  cy: number;
}

/**
 * Direction C's orthographic projector: no perspective divide, so a balance's
 * projected extent is proportional to the balance at every camera angle.
 */
function projectPoint(v: Vec3, cam: TerrainCamera, fit: Fit): TerrainPoint {
  const ca = Math.cos(cam.azimuthDeg * DEG);
  const sa = Math.sin(cam.azimuthDeg * DEG);
  const ce = Math.cos(cam.elevationDeg * DEG);
  const se = Math.sin(cam.elevationDeg * DEG);
  const x1 = v.x * ca - v.z * sa;
  const z1 = v.x * sa + v.z * ca;
  const y2 = v.y * ce - z1 * se;
  return { x: round(fit.cx + x1 * fit.scale), y: round(fit.cy - y2 * fit.scale) };
}

/** Distance from the camera of a world point — the painter's-algorithm sort key. */
function depthOf(v: Vec3, cam: TerrainCamera): number {
  const ce = Math.cos(cam.elevationDeg * DEG);
  const se = Math.sin(cam.elevationDeg * DEG);
  const z1 = v.x * Math.sin(cam.azimuthDeg * DEG) + v.z * Math.cos(cam.azimuthDeg * DEG);
  return v.y * se + z1 * ce;
}

/** Centre the figure and scale it to the plate — the same fit at every angle. */
function fitCamera(points: readonly Vec3[], cam: TerrainCamera, width: number, height: number): Fit {
  const unit: Fit = { scale: 1, cx: 0, cy: 0 };
  const raw = points.map((p) => projectPoint(p, cam, unit));
  const xs = raw.map((p) => p.x);
  const ys = raw.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const usableW = Math.max(width - PAD_LEFT - PAD_RIGHT, EPS);
  const usableH = Math.max(height - PAD_TOP - PAD_BOTTOM, EPS);
  const scale = Math.min(usableW / Math.max(x1 - x0, EPS), usableH / Math.max(y1 - y0, EPS));
  return {
    scale,
    cx: PAD_LEFT + (usableW - (x1 - x0) * scale) / 2 - x0 * scale,
    cy: PAD_TOP + (usableH - (y1 - y0) * scale) / 2 - y0 * scale,
  };
}

// ── Ticks ────────────────────────────────────────────────────────────

/** 0 → the largest balance in VALUE_STEPS, plus the deepest debt when there is one. */
function tickValues(maxAssetCents: number, minLiabilityCents: number): number[] {
  const up =
    maxAssetCents > 0
      ? Array.from({ length: VALUE_STEPS + 1 }, (_, k) => Math.round((maxAssetCents / VALUE_STEPS) * k))
      : [0];
  return minLiabilityCents < 0 ? [...up, minLiabilityCents] : up;
}

/** Evenly spaced labelled days, first and last always among them. */
function tickIndices(dayCount: number, width: number): number[] {
  return sampleIndices(dayCount, width < NARROW_PLATE ? TIME_TICKS_NARROW : TIME_TICKS);
}

// ── Reconciliation ───────────────────────────────────────────────────

/** A day of the series the hero net-worth chart draws. */
export interface TerrainReferencePoint {
  day: string;
  /** the chart's total — IN-FLIGHT BRIDGED, so `inTransitCents` is inside it */
  totalCents: number;
  /** derivation's coverage flag: every active account covered that day */
  complete: boolean;
  /** the bridge applied that day (docs/inflight-dips.md); absent ⇒ 0 */
  inTransitCents?: number;
}

export interface TerrainResidual {
  day: string;
  terrainCents: number;
  referenceCents: number;
  /** terrain − reference; zero on every day the two agree */
  residualCents: number;
}

export interface TerrainReconciliation {
  balanced: boolean;
  /** days compared (complete) and days skipped (the reference calls them partial) */
  checkedDays: number;
  skippedDays: number;
  /** every disagreement, oldest first — empty when the figure reconciles */
  residuals: TerrainResidual[];
  worstResidualCents: number;
}

/**
 * The identity every net-worth terrain owes the chart above it:
 *
 *   Σ ribbons(day)  =  heroTotal(day) − inTransit(day)
 *
 * on every day derivation calls COMPLETE. The subtraction is the whole point:
 * the hero line is in-flight bridged and money in the air is in NO account's
 * ledger, so the ribbons are short by exactly the bridge — saying so beats
 * fabricating a tenth ribbon or quietly disagreeing. Partial days are SKIPPED,
 * not silently counted: netWorthSeries drops an uncovered account from its
 * total that day while each ribbon keeps its own last statement — two
 * different, both-honest questions.
 */
export function reconcileTerrain(
  ribbons: readonly TerrainRibbonInput[],
  reference: readonly TerrainReferencePoint[],
): TerrainReconciliation {
  const byDay = ribbons.map((r) => new Map(r.points.map((p) => [p.day, p.valueCents] as const)));
  const residuals: TerrainResidual[] = [];
  let checkedDays = 0;
  let skippedDays = 0;
  let worstResidualCents = 0;

  for (const point of reference) {
    if (!point.complete) {
      skippedDays += 1;
      continue;
    }
    checkedDays += 1;
    let terrainCents = 0;
    for (const map of byDay) terrainCents += map.get(point.day) ?? 0;
    const referenceCents = point.totalCents - (point.inTransitCents ?? 0);
    const residualCents = terrainCents - referenceCents;
    if (residualCents === 0) continue;
    residuals.push({ day: point.day, terrainCents, referenceCents, residualCents });
    if (Math.abs(residualCents) > Math.abs(worstResidualCents)) worstResidualCents = residualCents;
  }

  return {
    balanced: residuals.length === 0,
    checkedDays,
    skippedDays,
    residuals,
    worstResidualCents,
  };
}

// ── Adapting the dashboard's per-account series ───────────────────────

/**
 * Structural shape of one per-account line from `buildDashboardSeries`
 * (mode "accounts"). Typed structurally so this module stays free of the
 * series/bridge modules — one direction of dependency, one place to change.
 */
export interface TerrainSeriesLike {
  key: string;
  label: string;
  /** true when the values are in the positive "amount owed" frame */
  owedFrame: boolean;
  points: readonly { day: string; valueCents: number | null; complete: boolean }[];
}

/**
 * The ONE conversion from the dashboard's per-account series to terrain
 * ribbons, so the drawing and the reconciliation test can never disagree about
 * what a ribbon is: an owed-frame line is NEGATED back to the net-worth sign
 * (which is what puts the cards below the rule and makes Σ ribbons comparable
 * with the net-worth series); a null day is DROPPED rather than zeroed (no
 * shown account covers it, and a zero would draw a balance nobody claimed);
 * and `complete: false` becomes `verified: false`, which the geometry refuses
 * to smooth over.
 */
export function ribbonsFromSeries(
  series: readonly TerrainSeriesLike[],
  colorByKey?: Readonly<Record<string, string>>,
): TerrainRibbonInput[] {
  return series.map((s, i) => {
    const sign = s.owedFrame ? -1 : 1;
    const points: TerrainDayInput[] = [];
    for (const p of s.points) {
      if (p.valueCents === null) continue;
      points.push({ day: p.day, valueCents: sign * p.valueCents, verified: p.complete });
    }
    return {
      id: s.key,
      label: s.label,
      isLiability: s.owedFrame,
      color: colorByKey?.[s.key] ?? terrainColor(i),
      points,
    };
  });
}

// ── Renderer helpers ─────────────────────────────────────────────────

/** An SVG `points` attribute for a polygon/polyline. */
export function pointsAttr(points: readonly TerrainPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/**
 * The ribbon whose crest is nearest a point on the plate, and the vertex on it:
 * the hover pick, which has to work at EVERY camera angle (there is no x-only
 * axis left to search once the figure is rotated).
 */
export function nearestVertex(
  ribbons: readonly TerrainRibbon[],
  at: TerrainPoint,
): { ribbon: TerrainRibbon; vertex: TerrainVertex } | null {
  let best: { ribbon: TerrainRibbon; vertex: TerrainVertex } | null = null;
  let bestD = Infinity;
  for (const ribbon of ribbons) {
    for (const vertex of ribbon.vertices) {
      const dx = vertex.point.x - at.x;
      const dy = vertex.point.y - at.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { ribbon, vertex };
      }
    }
  }
  return best;
}

// ── Small pure helpers ───────────────────────────────────────────────

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * What the terrain's TABLE lens prints for one ribbon.
 *
 * 🔴 A RIBBON WITH NOTHING DRAWN IS NOT A BALANCE OF ZERO. An account the
 * ledger cannot reconstruct a single day for has no vertices, so `lastCents`
 * and `deltaCents` are both the zero they were initialised to — and the table
 * printed "$0.00" under a header that says "Today" and "$0.00" under "Change".
 * Two claims about money, made about an account nobody has any figure for.
 *
 * The "First day" column already refused to answer, which is what made the
 * other two visible: three columns of one row disagreed about whether there
 * was anything to say. Measured on the owner's ledger 2026-09-01: Capital One
 * 360 Checking is active with zero balances and zero transactions, and read
 * "— · $0.00 · $0.00" across the row.
 *
 * ⛔ `lastDay`, not `lastCents === 0`, is the test. A real account can sit at
 * exactly zero, and that zero is worth printing.
 */
export interface TerrainRowFigures {
  first: string;
  today: string;
  change: string;
  /** sign of the change for colour, or null when there is no change to colour */
  changeSign: -1 | 0 | 1 | null;
}

export function terrainRowFigures(
  r: Pick<TerrainRibbon, "firstDay" | "firstCents" | "lastDay" | "lastCents" | "deltaCents">,
  fmt: { cents: (c: number) => string; signed: (c: number) => string; monthYear: (day: string) => string },
): TerrainRowFigures {
  if (r.firstDay === null || r.lastDay === null) {
    return { first: "—", today: "—", change: "—", changeSign: null };
  }
  return {
    first: `${fmt.monthYear(r.firstDay)} · ${fmt.cents(r.firstCents)}`,
    today: fmt.cents(r.lastCents),
    change: fmt.signed(r.deltaCents),
    changeSign: r.deltaCents === 0 ? 0 : r.deltaCents > 0 ? 1 : -1,
  };
}

/**
 * The table's caption. Says how many accounts it could reconstruct nothing for
 * rather than claiming a first day for every one of them — the row for such an
 * account is three em dashes, and a caption that promises "every account from
 * its first reconstructed day" does not describe it. One of the owner's twelve
 * active accounts was in that state when this was written.
 */
export function terrainTableCaption(ribbons: readonly Pick<TerrainRibbon, "firstDay">[], todayLabel: string): string {
  const blank = ribbons.filter((r) => r.firstDay === null).length;
  const base = `Every account from its first reconstructed day to ${todayLabel} — the same numbers the terrain is drawn from.`;
  if (blank === 0) return base;
  return `${base} ${blank} ${blank === 1 ? "account has" : "accounts have"} no reconstructed day at all, and ${blank === 1 ? "its row is" : "their rows are"} left blank rather than read as zero.`;
}
