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

import { spendingShare, spendingShareBase, sumOfPrintedShares } from "./insight-facts";
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
  /**
   * The same figure for the previous period — drives the relief height.
   *
   * ⛔ NULL when there is no comparable prior window (`lib/compared-windows`):
   * the block then stands level and carries no delta. Never `spentCents` in its
   * place — a zero change is a measurement, and "level with" a window nobody
   * imported would be a fabricated one.
   */
  priorCents: number | null;
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
  priorCents: number | null;
  /** spentCents − priorCents; positive = spent MORE than last period; null with no prior */
  deltaCents: number | null;
  /** percentage change, or null when there is no prior base to divide by */
  deltaPct: number | null;
  txnCount: number;
  /** 0..1 of the period's positive category spend — the table's own denominator */
  share: number;
  /**
   * The share as the rail and the readout PRINT it: a category's own Table
   * label, "—" when it netted money back; for the tail, the sum of its members'
   * Table labels. See `printedShareOf`.
   */
  shareLabel: string;
  /** why a block prints no share — `spendingShare`'s refusal — or null */
  shareTitle: string | null;
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
  /**
   * The denominator the footprint WIDTHS divide — `spendingShareBase` over the
   * categories fed in, the one the Table and List lenses divide too.
   *
   * 🔴 It was Σ max(0, spent) over the rows actually DRAWN, and a comment here
   * said that was the table's figure. It was, until a refund was folded into the
   * tail: then the clamp saw the netted tail instead of its members, and on
   * `?period=2025-02&where=relief` the widths divided $5,500.44 beside a table
   * dividing $5,585.07 (see `groupTail`).
   *
   * 🔴 Published because the chart's `<desc>` named `totalSpentCents` as "the
   * $X spent" whose share a width is, and the two are different numbers
   * wherever a refund lands. Measured 2026-09-10:
   * `/spending?period=2024-05&where=relief` said "its share of the $675.87
   * spent" while the widths divided $2,220.45 — Food is 43.3% of the plane and
   * its own figure beside it reads $960.60, where 43.3% of $675.87 is $292.65.
   */
  shareBaseCents: number;
  /**
   * null the moment any input has no prior — a sum cannot stand on a missing term.
   * Summed over EVERY input, the `absent` ones included: the prior window's total
   * is the prior window's, not the part of it that still spends.
   */
  totalPriorCents: number | null;
  /**
   * Σ spent − Σ prior over every input: the blocks' heights AND the `absent`
   * categories' falls. ⛔ Never the heights alone — see `absent`.
   */
  totalDeltaCents: number | null;
  totalTxnCount: number;
  /** how many real categories are behind the blocks — the ones with entries this period */
  categoryCount: number;
  /**
   * The categories fed in with NO ENTRIES this period — compared against a prior
   * window they spent in, and drawn nowhere.
   *
   * 🔴 Measured on the owner's ledger 2026-09-15, `/spending?period=2026-07`:
   * Government $2,250.00, Personal Care $375.89 and Gambling $20.00 spent in June
   * 2026 and nothing in July, and the relief never saw them. Its readout said
   * "+$588.75 against June 2026" — spending ROSE — beside a "What moved" counting
   * 9 of 15 categories down, over a change of -$2,057.14. 50 of the ledger's 62
   * whole comparisons left at least one out; 5 printed the wrong sign.
   *
   * ⛔ Not drawn, because a period with no entries in a category gives it no
   * footprint: a zero-width well would set the height scale for every block while
   * nobody could see it, and `groupTail` would fold it into "N smaller
   * categories" beside real spending. Its change is in `totalDeltaCents`, and the
   * renderer names it.
   */
  absent: MassifAbsentCategory[];
}

/** A compared category with no entries this period — see `MassifLayout.absent`. */
export interface MassifAbsentCategory {
  id: string;
  label: string;
  priorCents: number | null;
  /** 0 − prior: its whole prior net, as a change; null with no prior */
  deltaCents: number | null;
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

/** A row as the plate draws it: a category, or the tail standing for several. */
type DrawnRow = MassifCategoryInput & {
  memberCount: number;
  /** each member's own spend — one entry for a category, every folded one for the tail */
  memberSpentCents: readonly number[];
};

/** A written share: the label a figure prints, and the refusal when it prints none. */
interface PrintedShare {
  label: string;
  title: string | null;
}

interface WorldBlock {
  row: DrawnRow;
  share: number;
  printed: PrintedShare;
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
  // no entries and no spend: nothing of this period to stand on (`MassifLayout.absent`)
  const isAbsent = (r: MassifCategoryInput): boolean => r.txnCount === 0 && r.spentCents === 0;
  const drawn = inputs.filter((r) => !isAbsent(r));
  const rows = groupTail(drawn, options.maxBlocks ?? DEFAULT_MAX_BLOCKS);

  // the WIDTH denominator — the Table lens's own author, over the same categories
  // (an absent category adds max(0, 0) to it, so it divides the same total either way)
  const shareBaseCents = spendingShareBase(inputs);
  // ⛔ every total over ALL inputs: the change covers the categories that stopped too
  const totals = {
    totalSpentCents: sumBy(inputs, (r) => r.spentCents),
    shareBaseCents,
    totalPriorCents: sumPriors(inputs),
    totalDeltaCents: deltaOf(sumBy(inputs, (r) => r.spentCents), sumPriors(inputs)),
    totalTxnCount: sumBy(inputs, (r) => r.txnCount),
    categoryCount: drawn.length,
    absent: inputs.filter(isAbsent).map((r) => ({
      id: r.id,
      label: r.label,
      priorCents: r.priorCents,
      deltaCents: deltaOf(r.spentCents, r.priorCents),
    })),
  };

  if (rows.length === 0) {
    return { blocks: [], plane: null, width, height, liftPerUnit: 0, ...totals };
  }

  const world = buildWorld(rows, shareBaseCents, {
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
 * Keep the largest `maxBlocks - 1` categories that SPENT and fold the rest of
 * them into ONE block that states how many it stands for. A truncation would
 * make the figure disagree with the ledger; a sum cannot. The aggregate always
 * stands for at least two rows: when the spending categories fit the cap they
 * are returned whole, so the tail can never be a single category wearing the
 * name "smaller categories".
 *
 * 🔴 A CATEGORY THAT NETTED MONEY BACK IS NEVER FOLDED. It ranks last, so it
 * landed in the tail whenever one formed, and the tail summed it SIGNED — its
 * refund netted against the spending beside it before any clamp could see it.
 * Measured on the owner's ledger 2026-09-15, relief at the 8-block budget:
 * `?period=2025-02` drew "4 smaller categories 0.8% $44.31" over members the
 * Table lens prints at 1.3% + 0.7% + 0.3%, and every width divided $5,500.44
 * where the table divides $5,585.07 — "Travel 47.1%" beside the table's 46.4%.
 * `?period=2024-05`'s tail read -$1,544.58 and swallowed $60.53 of spending;
 * `?period=2025-Q1` read "Food 40.1%" against 39.8%. Exactly the three periods
 * whose tail held a refund.
 *
 * ⚖️ Owner decision 2026-09-14 (F1): each such category stands as its own "—"
 * block with its own figure, exactly as the Table lens shows it, even past the
 * budget. The tail then sums only non-negative members, so max(0, Σ tail) is
 * Σ max(0, member) and no width can divide a different total from the table's.
 */
function groupTail(inputs: readonly MassifCategoryInput[], maxBlocks: number): DrawnRow[] {
  const ranked: DrawnRow[] = [...inputs]
    .sort((a, b) => b.spentCents - a.spentCents)
    .map((r) => ({ ...r, memberCount: 1, memberSpentCents: [r.spentCents] }));
  if (maxBlocks < 1) return ranked;
  const spent = ranked.filter((r) => r.spentCents >= 0);
  if (spent.length <= maxBlocks) return ranked;
  const tail = spent.slice(maxBlocks - 1);
  return [
    ...spent.slice(0, maxBlocks - 1),
    {
      id: MASSIF_OTHER_ID,
      label: `${tail.length} smaller categories`,
      hue: null,
      spentCents: sumBy(tail, (r) => r.spentCents),
      priorCents: sumPriors(tail),
      txnCount: sumBy(tail, (r) => r.txnCount),
      memberCount: tail.length,
      memberSpentCents: tail.map((r) => r.spentCents),
    },
    // ranked last already: the refunds follow the tail, never inside it
    ...ranked.filter((r) => r.spentCents < 0),
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

/** A category's share of the positive spend — the Table lens's arithmetic, operation for operation. */
function shareOf(spentCents: number, shareBase: number): number {
  return shareBase > 0 ? Math.max(0, spentCents) / shareBase : 0;
}

/**
 * The share a drawn block PRINTS. One category prints `spendingShare` of its
 * own share, exactly as its Table row does, refusal and all; the tail prints the
 * SUM of its members' Table labels.
 *
 * 🔴 The rail and the readout each wrote the tail's share as its own sum
 * rounded ONCE, beside a Table lens printing its members rounded EACH. Measured
 * on the owner's ledger 2026-09-15 over 72 periods at budgets 6, 8 and 12: 53
 * of 216 layouts disagreed — `?period=2022-10` at six blocks read 9.9% over
 * Table rows of 3.4% + 3.3% + 3.1%.
 *
 * ⚖️ Owner decision 2026-09-14 (F2) — a subtotal of shares printed elsewhere is
 * the sum of those rows as printed — taken for the tail, which is that shape.
 * The tail never holds a refund (`groupTail`), so it never refuses.
 */
function printedShareOf(row: DrawnRow, shareBase: number): PrintedShare {
  if (row.memberCount === 1) return spendingShare(row.spentCents, shareOf(row.spentCents, shareBase) * 100);
  return { label: sumOfPrintedShares(row.memberSpentCents.map((c) => shareOf(c, shareBase) * 100)), title: null };
}

function buildWorld(
  rows: readonly DrawnRow[],
  /**
   * The share denominator, passed in rather than summed here. `spendingShareBase`
   * over the categories is the Table lens's own, and it equals the same sum over
   * these drawn rows only because `groupTail` never folds a refund. Summed here
   * over `rows`, it quietly divided a different total the moment one was folded.
   * A category that net-refunded gets no footprint width; its figure still shows.
   */
  shareBase: number,
  geom: Geometry,
): World {
  const maxEntries = Math.max(0, ...rows.map((r) => r.txnCount));
  const maxDelta = Math.max(0, ...rows.map((r) => Math.abs(deltaOf(r.spentCents, r.priorCents) ?? 0)));
  const reliefScale = maxDelta > 0 ? geom.maxRelief / maxDelta : 0;
  // depth = floor + the rest shared out by entry count (see minDepthRatio)
  const depthFloor = geom.maxDepth * geom.minDepthRatio;
  const depthScale = maxEntries > 0 ? (geom.maxDepth - depthFloor) / maxEntries : 0;

  const totalGap = geom.gap * Math.max(rows.length - 1, 0);
  let x = -(geom.span + totalGap) / 2;
  let maxHalfDepth = 0;
  const blocks: WorldBlock[] = [];

  for (const row of rows) {
    const share = shareOf(row.spentCents, shareBase);
    const x0 = x;
    const x1 = x + share * geom.span;
    const halfDepth = depthFloor + row.txnCount * depthScale;
    // no comparable prior window: no height at all, rather than a measured zero
    const relief = (deltaOf(row.spentCents, row.priorCents) ?? 0) * reliefScale;
    maxHalfDepth = Math.max(maxHalfDepth, halfDepth);
    blocks.push(buildBlock(row, share, printedShareOf(row, shareBase), { x0, x1, halfDepth, relief }));
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

function buildBlock(row: DrawnRow, share: number, printed: PrintedShare, slab: Slab): WorldBlock {
  const relief: MassifRelief =
    Math.abs(slab.relief) < LEVEL_EPS ? "level" : slab.relief > 0 ? "raised" : "sunken";
  const shell = relief === "raised" ? raisedShell(slab) : relief === "sunken" ? sunkenShell(slab) : plateShell(slab);
  const top = Math.max(0, slab.relief) + LABEL_LIFT;
  return {
    row,
    share,
    printed,
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
  const delta = deltaOf(row.spentCents, row.priorCents);
  const ends = b.footprintEnds.map(project);
  return {
    id: row.id,
    label: row.label,
    hue: row.hue,
    ...(row.href === undefined ? {} : { href: row.href }),
    spentCents: row.spentCents,
    priorCents: row.priorCents,
    deltaCents: delta,
    deltaPct:
      delta === null || row.priorCents === null || row.priorCents === 0
        ? null
        : round((delta / Math.abs(row.priorCents)) * 100),
    txnCount: row.txnCount,
    share: b.share,
    shareLabel: b.printed.label,
    shareTitle: b.printed.title,
    relief: b.relief,
    faces: b.faces.map((f) => ({ kind: f.kind, tone: f.tone, points: f.points.map(project) })),
    rim: b.rim.map(project),
    hairline: b.hairline.map(project),
    labelAnchor: project(b.labelAnchor),
    footprintPx: round(Math.abs(ends[1]!.x - ends[0]!.x)),
    memberCount: row.memberCount,
  };
}

/** Σ priors, or null when any row has none — see `MassifCategoryInput.priorCents`. */
function sumPriors(rows: readonly { priorCents: number | null }[]): number | null {
  let total = 0;
  for (const r of rows) {
    if (r.priorCents === null) return null;
    total += r.priorCents;
  }
  return total;
}

/** spent − prior, or null when there is no prior to take it from. */
function deltaOf(spentCents: number, priorCents: number | null): number | null {
  return priorCents === null ? null : spentCents - priorCents;
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
/**
 * ⚠️ TWO dimensions, and the second is the relief's CAMERA.
 *
 * 🔴 It used to live in `useState` inside `CategoryMassif` while declaring a
 * URL key named `viewpoint` that nothing read — a key `NetWorthTerrain` and
 * `TransferTower` also declared, so three surfaces would have collided on one
 * param had any of them been wired. Each carries its own name now, and this one
 * is `massifView`. Made real on the owner's instruction, 2026-09-02: linkable
 * and remembered, like the "where" dimension beside it.
 *
 * ⚠️ `quarter` LEADS because `options[0]` is the default and that is the camera
 * the relief has always opened on. Reading the spec off the old switcher order
 * would have changed it.
 */
export const WHERE_VIEW_SPEC: ViewSpec = [
  { key: "where", options: ["list", "relief", "table"] },
  { key: "massifView", options: ["quarter", "front", "plan"] },
];

export const WHERE_VIEW_LABELS: Record<string, string> = {
  list: "List",
  relief: "Relief",
  table: "Table",
};

export const MASSIF_VIEW_DIMENSION = WHERE_VIEW_SPEC[1]!;

export const MASSIF_VIEW_LABELS: Record<string, string> = {
  quarter: "Quarter",
  front: "Front",
  plan: "Plan",
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
