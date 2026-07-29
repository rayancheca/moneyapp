/**
 * Pure category-massif geometry — "Where it went", set in relief (Direction A+).
 * Categories in, positioned polygons out. No React, no DOM, no Date, no random:
 * the same rows always produce byte-identical points, which is what lets the
 * Playwright visual baselines hold over an SVG figure.
 *
 * THE ENCODINGS, all carrying real data, all restated in words by the renderer:
 *   · footprint WIDTH  — the category's share of the period's spend
 *   · footprint DEPTH  — how many ledger entries it holds, on a floored scale
 *     (see `minDepthRatio`): monotonic in the count, never zero
 *   · HEIGHT off the plane — the change against the PRIOR period. A block that
 *     sank below the plane cost LESS than it did last period.
 *   · COLOUR — category identity (never the only carrier of a fact)
 *
 * The projector is orthographic — no perspective divide — so a value's projected
 * extent stays proportional to the value at every camera angle. Three named
 * viewpoints, no free tumble: at a steep azimuth the category axis collapses onto
 * itself and blocks occlude each other, and a camera that lies is not offered.
 *
 * RECONCILIATION IS PART OF THE GEOMETRY: `totalSpentCents` is the sum of the
 * blocks by construction (the tail aggregate is a sum, not a truncation), and
 * `reconcileMassif` proves that sum against the period totals the StatCards show.
 */

import { type ViewSpec } from "./view-state";

// ── Inputs ───────────────────────────────────────────────────────────

export interface MassifCategoryInput {
  /** category id — the stable key and the drill-through target */
  id: string;
  label: string;
  /** category hue name (categories.color), or null for a neutral block */
  hue: string | null;
  /** net money out this period (outflows − refunds), from categoryBreakdown */
  spentCents: number;
  /** the same figure for the previous period — drives the relief height */
  priorCents: number;
  /** ledger entries behind spentCents — drives the footprint depth */
  txnCount: number;
  /** click-through target (the category page) */
  href?: string;
}

export interface MassifCamera {
  azimuthDeg: number;
  elevationDeg: number;
}

export type MassifViewpoint = "quarter" | "front" | "plan";

/**
 * Front folds the depth away and reads as a pure deviation chart; plan looks
 * straight down and reads as pure footprint (share against entries); quarter
 * shows all three encodings at once. A "side" view is deliberately absent.
 */
export const MASSIF_VIEWPOINTS: Record<MassifViewpoint, MassifCamera> = {
  quarter: { azimuthDeg: 32, elevationDeg: 26 },
  front: { azimuthDeg: 0, elevationDeg: 0 },
  plan: { azimuthDeg: 0, elevationDeg: 82 },
};

export interface MassifLayoutOptions {
  width: number;
  height: number;
  camera: MassifCamera;
  /** blocks drawn before the tail is aggregated into one "smaller categories" block */
  maxBlocks?: number;
  /** world px the footprints share between them (default 74% of width) */
  span?: number;
  /** world px between neighbouring footprints (default 14) */
  gap?: number;
  /** world px of half-depth for the block with the most entries (default ≤34) */
  maxDepth?: number;
  /**
   * Fraction of `maxDepth` a block with ZERO entries would still occupy (0..1,
   * default 0.25). Depth stays monotonic in the entry count above this floor.
   * Without it a one-entry category — Rent, usually the widest block on the
   * sheet — collapses to a rule and reads as part of the plane. The exact count
   * is stated beside every block, so the floor costs no fact.
   */
  minDepthRatio?: number;
  /** world px of relief for the biggest change (default ≤64) */
  maxRelief?: number;
}

// ── Outputs ──────────────────────────────────────────────────────────

export interface MassifPoint {
  x: number;
  y: number;
}

export type MassifFaceKind =
  | "plate"
  | "top"
  | "front"
  | "side"
  | "floor"
  | "back-wall"
  | "left-wall";

export interface MassifFace {
  kind: MassifFaceKind;
  /** fill-opacity — the iso shading that makes a form read as pressed paper */
  tone: number;
  points: MassifPoint[];
}

export type MassifRelief = "raised" | "level" | "sunken";

export interface MassifBlock {
  id: string;
  label: string;
  hue: string | null;
  href?: string;
  spentCents: number;
  priorCents: number;
  /** spentCents − priorCents; positive = spent MORE than last period */
  deltaCents: number;
  /** percentage change, or null when there is no prior base to divide by */
  deltaPct: number | null;
  txnCount: number;
  /** 0..1 of the period's positive category spend — the table's own denominator */
  share: number;
  relief: MassifRelief;
  faces: MassifFace[];
  /** the light-catching embossed edge */
  rim: MassifPoint[];
  /** the pressed hairline on the far side of a well */
  hairline: MassifPoint[];
  /** text baseline for the block's name, clear of the block */
  labelAnchor: MassifPoint;
  /** projected footprint width in px — a name narrower than this fits */
  footprintPx: number;
  /** categories this block stands for (>1 only for the aggregated tail) */
  memberCount: number;
}

export interface MassifPlane {
  sheet: MassifPoint[];
  frontEdge: MassifPoint[];
}

export interface MassifLayout {
  /** painter's order, far → near: render in array order */
  blocks: MassifBlock[];
  plane: MassifPlane | null;
  width: number;
  height: number;
  /** screen-px of Y per world unit of lift — a hover lift is a pure translate */
  liftPerUnit: number;
  /** Σ blocks — equal to Σ inputs by construction */
  totalSpentCents: number;
  totalPriorCents: number;
  totalDeltaCents: number;
  totalTxnCount: number;
  /** how many real categories are behind the blocks */
  categoryCount: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEG = Math.PI / 180;
const DEFAULT_MAX_BLOCKS = 12;
const DEFAULT_GAP = 14;
const SPAN_RATIO = 0.74;
const MAX_DEPTH_CAP = 34;
const DEPTH_RATIO = 0.12;
const DEFAULT_MIN_DEPTH_RATIO = 0.25;
const MAX_RELIEF_CAP = 64;
const RELIEF_RATIO = 0.2;
/** a relief thinner than this is visually indistinguishable from the sheet */
const LEVEL_EPS = 0.6;
const PLANE_MARGIN_X = 14;
const PLANE_MARGIN_Z = 8;
/** clear of the tallest point, where the block's name is set */
const LABEL_LIFT = 13;
const PAD_X = 8;
const PAD_TOP = 18;
const PAD_BOTTOM = 10;
const MIN_CANVAS = 80;
/** guards every fit division; never a branch, so degenerate input cannot NaN */
const EPS = 1e-6;

const TONE_TOP = 1;
const TONE_FRONT = 0.78;
const TONE_SIDE = 0.5;
const TONE_PLATE = 0.92;
const TONE_FLOOR = 0.46;
const TONE_BACK = 0.62;
const TONE_LEFT = 0.34;

/** id of the aggregated tail block — not a category, so it never drills */
export const MASSIF_OTHER_ID = "__massif_other__";

// ── Layout ───────────────────────────────────────────────────────────

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface WorldFace {
  kind: MassifFaceKind;
  tone: number;
  points: Vec3[];
}

interface WorldBlock {
  row: MassifCategoryInput & { memberCount: number };
  share: number;
  relief: MassifRelief;
  faces: WorldFace[];
  rim: Vec3[];
  hairline: Vec3[];
  labelAnchor: Vec3;
  footprintEnds: [Vec3, Vec3];
  /** projected depth of the footprint centre — the painter's sort key */
  centre: Vec3;
}

export function computeMassifLayout(
  inputs: readonly MassifCategoryInput[],
  options: MassifLayoutOptions,
): MassifLayout {
  const width = Math.max(options.width, MIN_CANVAS);
  const height = Math.max(options.height, MIN_CANVAS);
  const rows = groupTail(inputs, options.maxBlocks ?? DEFAULT_MAX_BLOCKS);

  const totals = {
    totalSpentCents: sumBy(inputs, (r) => r.spentCents),
    totalPriorCents: sumBy(inputs, (r) => r.priorCents),
    totalDeltaCents: sumBy(inputs, (r) => r.spentCents - r.priorCents),
    totalTxnCount: sumBy(inputs, (r) => r.txnCount),
    categoryCount: inputs.length,
  };

  if (rows.length === 0) {
    return { blocks: [], plane: null, width, height, liftPerUnit: 0, ...totals };
  }

  const world = buildWorld(rows, {
    span: options.span ?? width * SPAN_RATIO,
    gap: options.gap ?? DEFAULT_GAP,
    maxDepth: options.maxDepth ?? Math.min(MAX_DEPTH_CAP, height * DEPTH_RATIO),
    minDepthRatio: options.minDepthRatio ?? DEFAULT_MIN_DEPTH_RATIO,
    maxRelief: options.maxRelief ?? Math.min(MAX_RELIEF_CAP, height * RELIEF_RATIO),
  });

  const fit = fitCamera(world, options.camera, width, height);
  const project = (v: Vec3): MassifPoint => projectPoint(v, options.camera, fit);

  const blocks = [...world.blocks]
    .sort((a, b) => depthOf(a.centre, options.camera) - depthOf(b.centre, options.camera))
    .map((b) => toBlock(b, project));

  return {
    blocks,
    plane: { sheet: world.plane.sheet.map(project), frontEdge: world.plane.frontEdge.map(project) },
    width,
    height,
    liftPerUnit: Math.cos(options.camera.elevationDeg * DEG) * fit.scale,
    ...totals,
  };
}

/**
 * Keep the largest `maxBlocks - 1` categories and fold everything past them into
 * ONE block that states how many it stands for. A truncation would make the
 * figure disagree with the ledger; a sum cannot. The aggregate always stands for
 * at least two rows: a list SHORTER than the cap is returned whole, so the tail
 * can never be a single category wearing the name "smaller categories".
 */
function groupTail(
  inputs: readonly MassifCategoryInput[],
  maxBlocks: number,
): (MassifCategoryInput & { memberCount: number })[] {
  const ranked = [...inputs].sort((a, b) => b.spentCents - a.spentCents);
  const named = ranked.map((r) => ({ ...r, memberCount: 1 }));
  if (maxBlocks < 1 || ranked.length <= maxBlocks) return named;
  const head = named.slice(0, maxBlocks - 1);
  const tail = ranked.slice(maxBlocks - 1);
  return [
    ...head,
    {
      id: MASSIF_OTHER_ID,
      label: `${tail.length} smaller categories`,
      hue: null,
      spentCents: sumBy(tail, (r) => r.spentCents),
      priorCents: sumBy(tail, (r) => r.priorCents),
      txnCount: sumBy(tail, (r) => r.txnCount),
      memberCount: tail.length,
    },
  ];
}

interface Geometry {
  span: number;
  gap: number;
  maxDepth: number;
  minDepthRatio: number;
  maxRelief: number;
}

interface World {
  blocks: WorldBlock[];
  plane: { sheet: Vec3[]; frontEdge: Vec3[] };
  points: Vec3[];
}

function buildWorld(
  rows: readonly (MassifCategoryInput & { memberCount: number })[],
  geom: Geometry,
): World {
  // The share denominator is the sum of POSITIVE spends — the same denominator
  // the categories table uses, so the massif's percentages equal the table's.
  // A category that net-refunded gets no footprint width; its figure still shows.
  const shareBase = sumBy(rows, (r) => Math.max(0, r.spentCents));
  const maxEntries = Math.max(0, ...rows.map((r) => r.txnCount));
  const maxDelta = Math.max(0, ...rows.map((r) => Math.abs(r.spentCents - r.priorCents)));
  const reliefScale = maxDelta > 0 ? geom.maxRelief / maxDelta : 0;
  // depth = floor + the rest shared out by entry count (see minDepthRatio)
  const depthFloor = geom.maxDepth * geom.minDepthRatio;
  const depthScale = maxEntries > 0 ? (geom.maxDepth - depthFloor) / maxEntries : 0;

  const totalGap = geom.gap * Math.max(rows.length - 1, 0);
  let x = -(geom.span + totalGap) / 2;
  let maxHalfDepth = 0;
  const blocks: WorldBlock[] = [];

  for (const row of rows) {
    const share = shareBase > 0 ? Math.max(0, row.spentCents) / shareBase : 0;
    const x0 = x;
    const x1 = x + share * geom.span;
    const halfDepth = depthFloor + row.txnCount * depthScale;
    const relief = (row.spentCents - row.priorCents) * reliefScale;
    maxHalfDepth = Math.max(maxHalfDepth, halfDepth);
    blocks.push(buildBlock(row, share, { x0, x1, halfDepth, relief }));
    x = x1 + geom.gap;
  }

  const span = { x0: -(geom.span + totalGap) / 2 - PLANE_MARGIN_X, x1: x - geom.gap + PLANE_MARGIN_X };
  const dz = maxHalfDepth + PLANE_MARGIN_Z;
  const sheet: Vec3[] = [
    { x: span.x0, y: 0, z: -dz },
    { x: span.x1, y: 0, z: -dz },
    { x: span.x1, y: 0, z: dz },
    { x: span.x0, y: 0, z: dz },
  ];
  const frontEdge: Vec3[] = [sheet[3]!, sheet[2]!];
  const points = [...sheet, ...blocks.flatMap(blockPoints)];
  return { blocks, plane: { sheet, frontEdge }, points };
}

interface Slab {
  x0: number;
  x1: number;
  halfDepth: number;
  relief: number;
}

function buildBlock(
  row: MassifCategoryInput & { memberCount: number },
  share: number,
  slab: Slab,
): WorldBlock {
  const relief: MassifRelief =
    Math.abs(slab.relief) < LEVEL_EPS ? "level" : slab.relief > 0 ? "raised" : "sunken";
  const shell = relief === "raised" ? raisedShell(slab) : relief === "sunken" ? sunkenShell(slab) : plateShell(slab);
  const top = Math.max(0, slab.relief) + LABEL_LIFT;
  return {
    row,
    share,
    relief,
    faces: shell.faces,
    rim: shell.rim,
    hairline: shell.hairline,
    labelAnchor: { x: (slab.x0 + slab.x1) / 2, y: top, z: 0 },
    footprintEnds: [
      { x: slab.x0, y: 0, z: 0 },
      { x: slab.x1, y: 0, z: 0 },
    ],
    centre: { x: (slab.x0 + slab.x1) / 2, y: 0, z: 0 },
  };
}

interface Shell {
  faces: WorldFace[];
  rim: Vec3[];
  hairline: Vec3[];
}

/** Nothing moved: a flat plate flush with the sheet — a plinth would be height that means nothing. */
function plateShell({ x0, x1, halfDepth: d }: Slab): Shell {
  const face = [
    { x: x0, y: 0, z: -d },
    { x: x1, y: 0, z: -d },
    { x: x1, y: 0, z: d },
    { x: x0, y: 0, z: d },
  ];
  return {
    faces: [{ kind: "plate", tone: TONE_PLATE, points: face }],
    rim: [],
    hairline: [...face, face[0]!],
  };
}

/** Spent MORE: embossed off the sheet. Iso shading — top 1, front .78, side .5. */
function raisedShell({ x0, x1, halfDepth: d, relief: h }: Slab): Shell {
  const A = { x: x0, y: h, z: -d };
  const B = { x: x1, y: h, z: -d };
  const C = { x: x1, y: h, z: d };
  const E = { x: x0, y: h, z: d };
  const F = { x: x0, y: 0, z: d };
  const G = { x: x1, y: 0, z: d };
  const H = { x: x1, y: 0, z: -d };
  return {
    faces: [
      { kind: "front", tone: TONE_FRONT, points: [E, F, G, C] },
      { kind: "side", tone: TONE_SIDE, points: [C, G, H, B] },
      { kind: "top", tone: TONE_TOP, points: [A, B, C, E] },
    ],
    rim: [A, B, C, E, A],
    hairline: [],
  };
}

/**
 * Spent LESS: pressed INTO the sheet. You see the floor and the two far inner
 * walls; the bright rim on the near edge of the opening is what makes a well
 * read as a well instead of a box floating below the paper.
 */
function sunkenShell({ x0, x1, halfDepth: d, relief: h }: Slab): Shell {
  return {
    faces: [
      {
        kind: "back-wall",
        tone: TONE_BACK,
        points: [
          { x: x0, y: h, z: -d },
          { x: x1, y: h, z: -d },
          { x: x1, y: 0, z: -d },
          { x: x0, y: 0, z: -d },
        ],
      },
      {
        kind: "left-wall",
        tone: TONE_LEFT,
        points: [
          { x: x0, y: h, z: -d },
          { x: x0, y: h, z: d },
          { x: x0, y: 0, z: d },
          { x: x0, y: 0, z: -d },
        ],
      },
      {
        kind: "floor",
        tone: TONE_FLOOR,
        points: [
          { x: x0, y: h, z: -d },
          { x: x1, y: h, z: -d },
          { x: x1, y: h, z: d },
          { x: x0, y: h, z: d },
        ],
      },
    ],
    rim: [
      { x: x0, y: 0, z: -d },
      { x: x0, y: 0, z: d },
      { x: x1, y: 0, z: d },
    ],
    hairline: [
      { x: x0, y: 0, z: -d },
      { x: x1, y: 0, z: -d },
      { x: x1, y: 0, z: d },
    ],
  };
}

function blockPoints(b: WorldBlock): Vec3[] {
  return [...b.faces.flatMap((f) => f.points), ...b.rim, ...b.hairline, b.labelAnchor, ...b.footprintEnds];
}

// ── Projection ───────────────────────────────────────────────────────

interface Fit {
  scale: number;
  cx: number;
  cy: number;
}

/**
 * Direction C's orthographic projector: no perspective divide, so a value's
 * projected extent is proportional to the value at every camera angle.
 */
function projectPoint(v: Vec3, cam: MassifCamera, fit: Fit): MassifPoint {
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
function depthOf(v: Vec3, cam: MassifCamera): number {
  const ce = Math.cos(cam.elevationDeg * DEG);
  const se = Math.sin(cam.elevationDeg * DEG);
  const z1 = v.x * Math.sin(cam.azimuthDeg * DEG) + v.z * Math.cos(cam.azimuthDeg * DEG);
  return v.y * se + z1 * ce;
}

/**
 * Centre the figure and, only if it would otherwise spill, shrink it to fit.
 * Never magnifies past 1: an upscaled two-block month would read as a different
 * chart from a twelve-block one, and the reader compares months.
 */
function fitCamera(world: World, cam: MassifCamera, width: number, height: number): Fit {
  const unit: Fit = { scale: 1, cx: 0, cy: 0 };
  const raw = world.points.map((p) => projectPoint(p, cam, unit));
  const xs = raw.map((p) => p.x);
  const ys = raw.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const usableW = Math.max(width - PAD_X * 2, EPS);
  const usableH = Math.max(height - PAD_TOP - PAD_BOTTOM, EPS);
  const scale = Math.min(1, usableW / Math.max(x1 - x0, EPS), usableH / Math.max(y1 - y0, EPS));
  return {
    scale,
    cx: PAD_X + (usableW - (x1 - x0) * scale) / 2 - x0 * scale,
    cy: PAD_TOP + (usableH - (y1 - y0) * scale) / 2 - y0 * scale,
  };
}

function toBlock(b: WorldBlock, project: (v: Vec3) => MassifPoint): MassifBlock {
  const { row } = b;
  const delta = row.spentCents - row.priorCents;
  const ends = b.footprintEnds.map(project);
  return {
    id: row.id,
    label: row.label,
    hue: row.hue,
    ...(row.href === undefined ? {} : { href: row.href }),
    spentCents: row.spentCents,
    priorCents: row.priorCents,
    deltaCents: delta,
    deltaPct: row.priorCents !== 0 ? round((delta / Math.abs(row.priorCents)) * 100) : null,
    txnCount: row.txnCount,
    share: b.share,
    relief: b.relief,
    faces: b.faces.map((f) => ({ kind: f.kind, tone: f.tone, points: f.points.map(project) })),
    rim: b.rim.map(project),
    hairline: b.hairline.map(project),
    labelAnchor: project(b.labelAnchor),
    footprintPx: round(Math.abs(ends[1]!.x - ends[0]!.x)),
    memberCount: row.memberCount,
  };
}

// ── Reconciliation ───────────────────────────────────────────────────

export interface MassifTotalsInput {
  /** Σ the massif's blocks (net per category: outflows − refunds) */
  blocksCents: number;
  /** the Uncategorized bucket's net outflow — same breakdown, its own honesty card */
  uncategorizedCents: number;
  /** StatCards: GROSS debits landing in spending categories */
  grossSpentCents: number;
  /** StatCards: credits landing in spending categories (refunds) */
  refundsCents: number;
}

export interface MassifReconciliation {
  balanced: boolean;
  /** blocks + uncategorized + refunds − gross; zero when the figure reconciles */
  residualCents: number;
  /** the identity's own left-hand side: what the massif claims is money out */
  netOutCents: number;
}

/**
 * The identity every "Where it went" figure owes the ledger:
 *
 *   Σ blocks + uncategorized  =  gross spent − refunds
 *
 * categoryBreakdown books an outflow as +magnitude and a refund as −magnitude in
 * the same bucket, so its rows sum to NET money out; periodTotals keeps the two
 * sides apart. A non-zero residual means the chart and the stat cards are
 * counting different transactions, and the renderer says so out loud rather than
 * drawing a figure that quietly disagrees with the numbers above it.
 */
export function reconcileMassif(t: MassifTotalsInput): MassifReconciliation {
  const residual = t.blocksCents + t.uncategorizedCents + t.refundsCents - t.grossSpentCents;
  return {
    balanced: residual === 0,
    residualCents: residual,
    netOutCents: t.grossSpentCents - t.refundsCents,
  };
}

// ── Renderer helpers ─────────────────────────────────────────────────

/** An SVG `points` attribute for a polygon/polyline. */
export function pointsAttr(points: readonly MassifPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

// ── The /spending "Where it went" view dimension ──────────────────────

/**
 * Declared HERE rather than beside the card's components because the RSC page
 * and the client panel both need the literal value, and every export of a
 * `"use client"` module is a client reference on the server — a spec imported
 * from one would reach `resolveViewState` as a proxy, not an array.
 *
 * `list` is FIRST, so it is the default: the ranked list that has always been in
 * this card keeps rendering for anyone who never picks a lens.
 */
export const WHERE_VIEW_SPEC: ViewSpec = [{ key: "where", options: ["list", "relief", "table"] }];

export const WHERE_VIEW_LABELS: Record<string, string> = {
  list: "List",
  relief: "Relief",
  table: "Table",
};

// ── Small pure helpers ───────────────────────────────────────────────

function sumBy<T>(rows: readonly T[], of: (row: T) => number): number {
  let total = 0;
  for (const row of rows) total += of(row);
  return total;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
