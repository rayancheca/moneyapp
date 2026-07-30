import type { TransferEdge, TransferFlowData } from "@/services/transfer-flow";

/**
 * Pure geometry for "The Tower" — the 3D transfer view on `/flow`.
 *
 * No React, no DOM, no `Date`, no `Math.random`. Same contract as
 * `transfer-flow-layout.ts` and `terrain-layout.ts`: this decides where every
 * vertex sits, the renderer decides colour and interaction.
 *
 * THE FORM. Account pillars stand on a deterministic ring at fixed angles. The
 * **Y axis is time** — the oldest month at the base, the newest at the top —
 * and every (edge, month) bucket that carries money is one quadratic arc from
 * source pillar to destination pillar, at that month's height.
 *
 * WHY 3D IS JUSTIFIED AT ALL. The third dimension buys the one thing the spine
 * genuinely cannot: topology and time *simultaneously*. A 299-transfer edge
 * reads as a woven rope running the tower's full height; a handful of large
 * one-off pulls read as sparse struts at particular altitudes. Those are
 * different shapes of behaviour and no 2D panel in this app separates them.
 *
 * SVG WITH REAL PROJECTION MATHS, NOT WEBGL — the same call `NetWorthTerrain`
 * made, for the same reasons: deterministic (the visual baselines hold),
 * axe-inspectable, and free at the bundle. It also means the browser does the
 * hit-testing, and because the paint order is back-to-front the topmost element
 * under the cursor IS the nearest arc — so no hand-rolled picker is needed.
 *
 * ORTHOGRAPHIC, NO PERSPECTIVE DIVIDE. A stroke width encodes dollars, so it
 * must mean the same thing at the front of the ring as at the back. A
 * perspective projection would quietly inflate whatever happened to be near the
 * camera, which on a ring is just "whichever account the azimuth favours".
 *
 * NO FREE TUMBLE — four named viewpoints, exactly as the terrain offers. A
 * camera that lies about which pillar is in front is not offered, the figure is
 * reachable from the keyboard because the control is a set of buttons, and the
 * geometry stays snapshot-stable.
 *
 * ── THREE INVARIANTS THIS MODULE EXISTS TO HOLD ───────────────────────────────
 *
 * 1. **Y IS TIME AND NOTHING ELSE.** An arc arches upward so it reads as a
 *    solid rather than a flat smear, but the arch is BOUNDED BY THE MONTH
 *    SPACING, so an arc can never appear to sit at a month it does not belong
 *    to. The prototype's chord-derived arch had no such bound and on a short
 *    window could lift an arc clean past its neighbour.
 *
 * 2. **A→B AND B→A NEVER COINCIDE.** Both run between the same two pillars at
 *    the same height, so a purely inward control point would draw them exactly
 *    on top of each other — hiding the round-trip churn this whole surface
 *    exists to reveal. Each arc is bowed sideways with the sign fixed by the
 *    ORDERED pair, so the two directions curve apart into a lens.
 *
 * 3. **THE SKELETON DOES NOT MOVE WHEN THE MEASURE DOES.** Pillar angles,
 *    radii and the time rings come from GROSS throughput and are identical in
 *    both measures. Switching gross → net changes which arcs are drawn and
 *    nothing else, so the eye tracks the change instead of re-acquiring the
 *    scene.
 */

// ── the world ─────────────────────────────────────────────────────────────────
const RING_RADIUS = 1;
/** the floor rings sit outside the pillars, so they frame rather than cross */
const FLOOR_RADIUS = 1.2;
const BASE_Y = -1;
const TOP_Y = 1;
/** a floor ring, and its month label, every N months */
const RING_EVERY = 6;
const ARC_SEGMENTS = 20;
/** how far an arc's control point is pulled toward the tower's axis */
const ARC_INWARD = 0.46;
/** lateral bow, so the two directions of a pair separate into a lens */
const ARC_BOW = 0.18;
/**
 * INVARIANT 1. A quadratic's apex is HALF its control offset, so a control
 * lifted by `2 · f · monthStep` rises `f · monthStep`. At 0.4 of one month an
 * arc can never be misread as belonging to its neighbour.
 */
const ARCH_MONTH_FRACTION = 0.4;
const ARCH_BASE = 0.06;
const ARCH_PER_CHORD = 0.08;

// ── the plate ─────────────────────────────────────────────────────────────────
/**
 * The month labels live in a reserved LEFT GUTTER rather than floating at a
 * fixed x. Drawn at x = 8 with the figure free to fill the plate, they landed
 * on top of the leftmost pillar at 375px — and at 1440px they stranded
 * themselves ~380px from a figure that had centred itself. A gutter keeps them
 * beside the figure at every width and every viewpoint, which is the only way
 * a time axis is any use.
 */
// = MONTH_LABEL_WIDTH + MONTH_LABEL_GAP, so `fit.left − GAP` can never fall
// below the label's own width and the clamp below is a belt, not the mechanism.
const PAD_LEFT = 48;
const PAD_RIGHT = 12;
/** room above for the pillar labels, and below for the time caption */
const PAD_TOP = 34;
const PAD_BOTTOM = 20;
/** gap between a month label's right edge and the figure's leftmost ink */
const MONTH_LABEL_GAP = 8;
/** a "2026-04" at 9px is ~40px wide; PAD_LEFT must leave room for it plus the gap */
const MONTH_LABEL_WIDTH = 40;
const MIN_ARC_WIDTH = 0.7;
const MAX_ARC_WIDTH = 7;
const MIN_PILLAR_WIDTH = 3;
const MAX_PILLAR_WIDTH = 13;
/** below this stroke an arrowhead is noise rather than direction */
const ARROW_MIN_WIDTH = 1.6;
const ARROW_LENGTH_FACTOR = 2.4;
const ARROW_SPREAD = 0.42;
/** deterministic label de-collision: push up in fixed steps */
const LABEL_LIFT = 15;
const LABEL_STEP = 26;
const LABEL_MIN_Y = 14;
const LABEL_HALF_WIDTH = 46;
/** guards every division; never a branch, so degenerate input cannot NaN */
const EPS = 1e-9;
const DEG = Math.PI / 180;

export interface TowerCamera {
  azimuthDeg: number;
  elevationDeg: number;
}

export type TowerViewpoint = "quarter" | "front" | "side" | "plan";

/**
 * Quarter is the reading view and the frozen default every baseline is captured
 * from. Front looks straight at the tower, where time reads most cleanly as
 * height and the rope-versus-struts contrast is sharpest. Side turns a
 * quarter-circle so arcs hidden behind a pillar come forward. Plan looks down
 * the time axis at the ring itself — topology with time nearly folded away.
 *
 * ⚠️ QUARTER'S ELEVATION IS 27°, NOT THE HANDOFF'S 16°. That figure (az −0.62
 * rad, el 0.28 rad) came from the prototype, which projected in PERSPECTIVE —
 * and perspective supplies depth on its own, so a shallow angle still read as a
 * ring. This renderer is orthographic, deliberately, so that a stroke encoding
 * dollars means the same thing at the front and the back of the ring. Under
 * orthographic projection 16° squashes the ring to 28% of its width and the
 * pillars line up as a flat picket fence: the tower stops looking like a tower.
 * 27° is the terrain's own quarter elevation, so the two 3D figures in this app
 * are now read from the same angle. Verified by screenshot, which is the only
 * instrument that can see this at all.
 */
export const TOWER_VIEWPOINTS: Record<TowerViewpoint, TowerCamera> = {
  quarter: { azimuthDeg: -35.5, elevationDeg: 27 },
  front: { azimuthDeg: 0, elevationDeg: 8 },
  side: { azimuthDeg: 90, elevationDeg: 20 },
  plan: { azimuthDeg: 0, elevationDeg: 74 },
};

export const TOWER_VIEWPOINT_ORDER: readonly TowerViewpoint[] = [
  "quarter",
  "front",
  "side",
  "plan",
];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TowerPoint {
  x: number;
  y: number;
}

// ── world-space geometry ──────────────────────────────────────────────────────

export interface TowerArcGeometry {
  /** `${edgeId}@${month}` — unique per (edge, month) bucket */
  key: string;
  edgeId: string;
  fromAccountId: string;
  toAccountId: string;
  monthIndex: number;
  month: string;
  cents: number;
  count: number;
  points: readonly Vec3[];
  /** 0…1 — this bucket against the largest bucket drawn */
  weight: number;
}

export interface TowerPillarGeometry {
  id: string;
  label: string;
  /** an OKLCH palette var; hue is always the SENDING account where it is used */
  color: string;
  /** position on the ring, in the service's source→sink order */
  ringIndex: number;
  x: number;
  z: number;
  netCents: number;
  /** in + out, always GROSS, so the skeleton is measure-invariant */
  throughputCents: number;
  weight: number;
  href: string;
}

export interface TowerRingGeometry {
  monthIndex: number;
  month: string;
  y: number;
}

export interface TowerGeometry {
  arcs: TowerArcGeometry[];
  pillars: TowerPillarGeometry[];
  rings: TowerRingGeometry[];
  months: readonly string[];
  baseY: number;
  topY: number;
  /** world distance between consecutive months */
  monthStep: number;
  peakMonthCents: number;
}

function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * World-space geometry. Pure in `data` and `measure` alone — no canvas size, no
 * camera — so the invariants above can be asserted without projecting anything.
 */
export function computeTowerGeometry(
  data: TransferFlowData,
  measure: "gross" | "net",
): TowerGeometry {
  const edges: readonly TransferEdge[] = measure === "net" ? data.netEdges : data.edges;
  const months = data.months;
  const span = TOP_Y - BASE_Y;
  const steps = Math.max(months.length - 1, 1);
  const monthStep = r4(span / steps);
  const yOf = (i: number): number => r4(BASE_Y + i * monthStep);

  // ── pillars: fixed ring, GROSS throughput, invariant across the measure ─────
  const maxThroughput = data.accounts.reduce((m, a) => Math.max(m, a.inCents + a.outCents), 0);
  const pillars: TowerPillarGeometry[] = data.accounts.map((a, i) => {
    const theta = (i / Math.max(data.accounts.length, EPS)) * Math.PI * 2;
    const throughputCents = a.inCents + a.outCents;
    return {
      id: a.id,
      label: a.label,
      color: a.color,
      ringIndex: i,
      x: r4(Math.cos(theta) * RING_RADIUS),
      z: r4(Math.sin(theta) * RING_RADIUS),
      netCents: a.netCents,
      throughputCents,
      weight: r4(Math.sqrt(throughputCents / Math.max(maxThroughput, EPS))),
      href: a.href,
    };
  });
  const pillarById = new Map(pillars.map((p) => [p.id, p]));

  // ── arcs: one per (edge, month) bucket that actually carries money ──────────
  let peakMonthCents = 0;
  for (const e of edges) {
    for (const c of e.monthCents) peakMonthCents = Math.max(peakMonthCents, c);
  }
  const archLimit = 2 * ARCH_MONTH_FRACTION * monthStep;

  const arcs: TowerArcGeometry[] = [];
  for (const e of edges) {
    const from = pillarById.get(e.fromAccountId);
    const to = pillarById.get(e.toAccountId);
    // An edge naming an account the service did not emit is skipped, never
    // guessed — the same rule the spine follows.
    if (from === undefined || to === undefined) continue;
    // A group whose legs share an account is not a transfer between accounts;
    // the service already counts it as unattributed, and a self-loop on a ring
    // has no geometry.
    if (from.id === to.id) continue;

    // INVARIANT 2. The perpendicular MUST be taken along the pair's canonical
    // direction (low ring index → high), never along this edge's own direction.
    // Reversing an edge flips the perpendicular AND the sign, and the two
    // cancel: computed the obvious way, A→B and B→A land on exactly the same
    // control point and draw one on top of the other. Anchoring the
    // perpendicular to the pair and taking the sign from the direction is what
    // actually separates them.
    const forward = from.ringIndex < to.ringIndex;
    const low = forward ? from : to;
    const high = forward ? to : from;
    const bowSign = forward ? 1 : -1;
    const dx = high.x - low.x;
    const dz = high.z - low.z;
    const chord = Math.hypot(dx, dz);
    const px = -dz / Math.max(chord, EPS);
    const pz = dx / Math.max(chord, EPS);
    const cx = ((from.x + to.x) / 2) * ARC_INWARD + px * ARC_BOW * bowSign;
    const cz = ((from.z + to.z) / 2) * ARC_INWARD + pz * ARC_BOW * bowSign;
    // INVARIANT 1: a longer chord arches a little more, but never past the bound.
    const arch = Math.min(archLimit, ARCH_BASE + ARCH_PER_CHORD * chord);

    for (const [i, month] of months.entries()) {
      const cents = e.monthCents[i] ?? 0;
      if (cents <= 0) continue;
      const y = yOf(i);
      const cy = y + arch;
      const points: Vec3[] = [];
      for (let s = 0; s <= ARC_SEGMENTS; s += 1) {
        const t = s / ARC_SEGMENTS;
        const u = 1 - t;
        const a = u * u;
        const b = 2 * u * t;
        const c = t * t;
        points.push({
          x: r4(a * from.x + b * cx + c * to.x),
          // both endpoints are `y`, so the arc begins and ends exactly on its month
          y: r4(a * y + b * cy + c * y),
          z: r4(a * from.z + b * cz + c * to.z),
        });
      }
      arcs.push({
        key: `${e.id}@${month}`,
        edgeId: e.id,
        fromAccountId: e.fromAccountId,
        toAccountId: e.toAccountId,
        monthIndex: i,
        month,
        cents,
        count: e.monthCounts[i] ?? 0,
        points,
        weight: r4(Math.sqrt(cents / Math.max(peakMonthCents, EPS))),
      });
    }
  }
  // A total order, so the paint list's tie-break is meaningful and the output
  // does not depend on the service's iteration order.
  arcs.sort((a, b) => a.key.localeCompare(b.key));

  const rings: TowerRingGeometry[] = [];
  for (const [i, month] of months.entries()) {
    if (i % RING_EVERY !== 0) continue;
    rings.push({ monthIndex: i, month, y: yOf(i) });
  }

  return { arcs, pillars, rings, months, baseY: BASE_Y, topY: TOP_Y, monthStep, peakMonthCents };
}

// ── projection ────────────────────────────────────────────────────────────────

interface Fit {
  scale: number;
  cx: number;
  cy: number;
  /** the leftmost projected x of the whole figure — the month axis hangs off it */
  left: number;
}

/**
 * Orthographic: no perspective divide, so a stroke that encodes dollars means
 * the same thing wherever it sits on the ring.
 */
function projectPoint(v: Vec3, cam: TowerCamera, fit: Pick<Fit, "scale" | "cx" | "cy">): TowerPoint {
  const ca = Math.cos(cam.azimuthDeg * DEG);
  const sa = Math.sin(cam.azimuthDeg * DEG);
  const ce = Math.cos(cam.elevationDeg * DEG);
  const se = Math.sin(cam.elevationDeg * DEG);
  const x1 = v.x * ca - v.z * sa;
  const z1 = v.x * sa + v.z * ca;
  const y2 = v.y * ce - z1 * se;
  return { x: r2(fit.cx + x1 * fit.scale), y: r2(fit.cy - y2 * fit.scale) };
}

/** Distance from the camera — the painter's-algorithm sort key. */
function depthOf(v: Vec3, cam: TowerCamera): number {
  const ce = Math.cos(cam.elevationDeg * DEG);
  const se = Math.sin(cam.elevationDeg * DEG);
  const z1 = v.x * Math.sin(cam.azimuthDeg * DEG) + v.z * Math.cos(cam.azimuthDeg * DEG);
  return v.y * se + z1 * ce;
}

/**
 * Centre the figure and scale it to the plate — measured from the ACTUAL
 * projected bounding box, so the tower frames itself at every camera angle and
 * every width instead of trusting a hard-coded guess. That guess is what let
 * the spine ship clipped.
 */
function fitCamera(points: readonly Vec3[], cam: TowerCamera, width: number, height: number): Fit {
  const unit = { scale: 1, cx: 0, cy: 0 };
  const raw = points.map((p) => projectPoint(p, cam, unit));
  const xs = raw.map((p) => p.x);
  const ys = raw.map((p) => p.y);
  const x0 = Math.min(...xs, 0);
  const x1 = Math.max(...xs, 0);
  const y0 = Math.min(...ys, 0);
  const y1 = Math.max(...ys, 0);
  const usableW = Math.max(width - PAD_LEFT - PAD_RIGHT, EPS);
  const usableH = Math.max(height - PAD_TOP - PAD_BOTTOM, EPS);
  const scale = Math.min(usableW / Math.max(x1 - x0, EPS), usableH / Math.max(y1 - y0, EPS));
  const cx = PAD_LEFT + (usableW - (x1 - x0) * scale) / 2 - x0 * scale;
  return {
    scale,
    cx,
    cy: PAD_TOP + (usableH - (y1 - y0) * scale) / 2 - y0 * scale,
    // where the figure actually begins. The tower is ~1.2× taller than wide, so
    // on any plate wider than that the HEIGHT binds and the centred figure
    // drifts right — 175px clear of the month labels at 1440px, 570px at 2560px.
    // Pinning the labels to a fixed gutter fixed them landing ON the figure at
    // 375px and left them STRANDED from it here. They have to follow it.
    left: r2(cx + x0 * scale),
  };
}

// ── projected layout ──────────────────────────────────────────────────────────

export interface TowerArcShape {
  key: string;
  edgeId: string;
  fromAccountId: string;
  toAccountId: string;
  monthIndex: number;
  month: string;
  cents: number;
  count: number;
  points: readonly TowerPoint[];
  /** an SVG polyline `points` attribute */
  polyline: string;
  /** px — encodes DOLLARS in that month on that edge */
  width: number;
  depth: number;
  /** 0 (farthest) … 1 (nearest) — the depth cue, never the only encoding */
  nearness: number;
  /** the destination arrowhead as an SVG polygon, or null when it would be noise */
  arrowhead: string | null;
}

export interface TowerPillarShape {
  id: string;
  label: string;
  color: string;
  netCents: number;
  throughputCents: number;
  href: string;
  top: TowerPoint;
  bottom: TowerPoint;
  /** px — encodes GROSS throughput */
  width: number;
  depth: number;
  /** the de-collided label anchor, above the pillar's top */
  labelX: number;
  labelY: number;
}

export interface TowerRingShape {
  monthIndex: number;
  month: string;
  /** the floor circle as an SVG polyline `points` attribute */
  outline: string;
  centre: TowerPoint;
  /** the month label's anchor, in the reserved left gutter (`text-anchor: end`) */
  label: TowerPoint;
}

export type TowerPaintItem =
  | { kind: "pillar"; depth: number; sortKey: string; id: string }
  | { kind: "arc"; depth: number; sortKey: string; id: string };

export interface TowerLayoutOptions {
  width: number;
  height: number;
  camera: TowerCamera;
}

export interface TowerLayout {
  width: number;
  height: number;
  arcs: TowerArcShape[];
  pillars: TowerPillarShape[];
  rings: TowerRingShape[];
  /** FARTHEST FIRST, tie-broken by id — paint in exactly this order */
  order: TowerPaintItem[];
  months: readonly string[];
  peakMonthCents: number;
  /** the figure's leftmost ink — the month labels hang immediately off this */
  figureLeft: number;
  /** the tower's own axis, for the "time runs upward" caption */
  axisTop: TowerPoint;
  axisBottom: TowerPoint;
}

/**
 * The projected, renderer-ready layout. Pure in every argument: camera and
 * plate size are just numbers, so the framing is as testable as the geometry.
 */
export function computeTowerLayout(
  data: TransferFlowData,
  measure: "gross" | "net",
  options: TowerLayoutOptions,
): TowerLayout {
  const geometry = computeTowerGeometry(data, measure);
  const { camera, width, height } = options;

  // Everything that will be drawn takes part in the fit, so nothing can be
  // framed out — including the floor rings, which reach furthest.
  const axisPoints: Vec3[] = [
    { x: 0, y: geometry.baseY, z: 0 },
    { x: 0, y: geometry.topY, z: 0 },
  ];
  const ringPoints: Vec3[] = [];
  for (const ring of geometry.rings) {
    for (let k = 0; k <= RING_OUTLINE_SEGMENTS; k += 1) {
      const theta = (k / RING_OUTLINE_SEGMENTS) * Math.PI * 2;
      ringPoints.push({
        x: Math.cos(theta) * FLOOR_RADIUS,
        y: ring.y,
        z: Math.sin(theta) * FLOOR_RADIUS,
      });
    }
  }
  const pillarPoints: Vec3[] = geometry.pillars.flatMap((p) => [
    { x: p.x, y: geometry.baseY, z: p.z },
    { x: p.x, y: geometry.topY, z: p.z },
  ]);
  const arcPoints: Vec3[] = geometry.arcs.flatMap((a) => [...a.points]);
  const fit = fitCamera(
    [...axisPoints, ...ringPoints, ...pillarPoints, ...arcPoints],
    camera,
    width,
    height,
  );

  // ── depth range, for the near/far cue ──────────────────────────────────────
  // Measured across the arcs' MEAN depths, which is the quantity `nearness`
  // actually normalises. Taken across every vertex instead, no arc ever reaches
  // either end of the scale and the cue silently loses a quarter of its range
  // at both ends.
  //
  // ⚠️ NORMALISE AGAINST THE SAME NUMBERS YOU PUBLISH. `depth` is r4-rounded, so
  // taking min/max over the UNROUNDED means compares two different quantities.
  // On a tower with exactly one arc that is catastrophic rather than merely
  // sloppy: the true range is 0, `depthRange` falls back to EPS = 1e-9, and the
  // numerator is the rounding residual (up to 5e-5) — nearness comes out around
  // ±10⁴, the renderer turns it into opacity ≈ −3484, and SVG clamps that to 0.
  // The tower's only arc becomes INVISIBLE while the caption still says "1 arcs".
  // Carried WITH the arc rather than looked up by index — an index lookup into
  // a parallel array needs a `?? 0` that can never fire, which is an untestable
  // branch standing in for a guarantee the shape can just express.
  const withDepth = geometry.arcs.map((arc) => {
    let sum = 0;
    for (const p of arc.points) sum += depthOf(p, camera);
    return { arc, depth: r4(sum / Math.max(arc.points.length, EPS)) };
  });
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const { depth } of withDepth) {
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);
  }
  const depthRange = maxDepth - minDepth;
  // When every arc sits at the same depth — one arc, or a perfectly flat set —
  // there is no farther-and-nearer to encode. They are all foreground: nearness
  // 1, full presence. Falling back to 0 instead would render the tower's only
  // arc at the FAINTEST resting opacity, which is the opposite of the truth.
  const hasDepthSpread = depthRange > EPS;

  const arcs: TowerArcShape[] = withDepth.map(({ arc, depth }) => {
    const points = arc.points.map((p) => projectPoint(p, camera, fit));
    const strokeWidth = r2(MIN_ARC_WIDTH + arc.weight * (MAX_ARC_WIDTH - MIN_ARC_WIDTH));
    return {
      key: arc.key,
      edgeId: arc.edgeId,
      fromAccountId: arc.fromAccountId,
      toAccountId: arc.toAccountId,
      monthIndex: arc.monthIndex,
      month: arc.month,
      cents: arc.cents,
      count: arc.count,
      points,
      polyline: pointsAttr(points),
      width: strokeWidth,
      depth,
      nearness: hasDepthSpread
        ? r4(Math.min(1, Math.max(0, (depth - minDepth) / depthRange)))
        : 1,
      arrowhead: arrowheadFor(points, strokeWidth),
    };
  });

  const pillars: TowerPillarShape[] = geometry.pillars.map((p) => {
    const top = projectPoint({ x: p.x, y: geometry.topY, z: p.z }, camera, fit);
    const bottom = projectPoint({ x: p.x, y: geometry.baseY, z: p.z }, camera, fit);
    return {
      id: p.id,
      label: p.label,
      color: p.color,
      netCents: p.netCents,
      throughputCents: p.throughputCents,
      href: p.href,
      top,
      bottom,
      width: r2(MIN_PILLAR_WIDTH + p.weight * (MAX_PILLAR_WIDTH - MIN_PILLAR_WIDTH)),
      depth: r4(
        (depthOf({ x: p.x, y: geometry.topY, z: p.z }, camera) +
          depthOf({ x: p.x, y: geometry.baseY, z: p.z }, camera)) /
          2,
      ),
      // CLAMP FIRST. The de-collision loop below reasons about horizontal
      // distance, so it has to see the FINAL x. Clamping afterwards pulls an
      // outer label inward — straight into a neighbour it was just cleared
      // against. On the real seven-account graph that lands three 10px labels
      // 12.7px apart at 432–471px wide, which is the owner's own phone.
      labelX: r2(
        Math.min(
          Math.max(top.x, LABEL_HALF_WIDTH),
          Math.max(width - LABEL_HALF_WIDTH, LABEL_HALF_WIDTH),
        ),
      ),
      labelY: top.y - LABEL_LIFT,
    };
  });
  decollideLabels(pillars, height);

  // Hard floor at MONTH_LABEL_WIDTH so a `text-anchor: end` label can never run
  // off the left edge, which is the other half of the same defect.
  const monthLabelX = Math.max(r2(fit.left - MONTH_LABEL_GAP), MONTH_LABEL_WIDTH);

  const rings: TowerRingShape[] = geometry.rings.map((ring) => {
    const outline: TowerPoint[] = [];
    for (let k = 0; k <= RING_OUTLINE_SEGMENTS; k += 1) {
      const theta = (k / RING_OUTLINE_SEGMENTS) * Math.PI * 2;
      outline.push(
        projectPoint(
          { x: Math.cos(theta) * FLOOR_RADIUS, y: ring.y, z: Math.sin(theta) * FLOOR_RADIUS },
          camera,
          fit,
        ),
      );
    }
    const centre = projectPoint({ x: 0, y: ring.y, z: 0 }, camera, fit);
    return {
      monthIndex: ring.monthIndex,
      month: ring.month,
      outline: pointsAttr(outline),
      centre,
      label: { x: monthLabelX, y: centre.y },
    };
  });

  const order: TowerPaintItem[] = [
    ...pillars.map(
      (p): TowerPaintItem => ({
        kind: "pillar",
        depth: p.depth,
        sortKey: `pillar:${p.id}`,
        id: p.id,
      }),
    ),
    ...arcs.map(
      (a): TowerPaintItem => ({ kind: "arc", depth: a.depth, sortKey: `arc:${a.key}`, id: a.key }),
    ),
  ];
  // Farthest first. The id tie-break is what makes the paint order — and so the
  // pixels — reproducible when two items share a depth exactly.
  order.sort((a, b) => a.depth - b.depth || a.sortKey.localeCompare(b.sortKey));

  return {
    width,
    height,
    arcs,
    pillars,
    rings,
    order,
    months: geometry.months,
    peakMonthCents: geometry.peakMonthCents,
    figureLeft: fit.left,
    axisTop: projectPoint({ x: 0, y: geometry.topY, z: 0 }, camera, fit),
    axisBottom: projectPoint({ x: 0, y: geometry.baseY, z: 0 }, camera, fit),
  };
}

const RING_OUTLINE_SEGMENTS = 48;

/** An SVG `points` attribute for a polyline or polygon. */
export function pointsAttr(points: readonly TowerPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/**
 * The destination arrowhead. Direction is the one thing a gradient provably
 * fails to convey (Wang et al., VINCI 2024 — only 4 of 24 readers got it), so
 * it is drawn explicitly. Below `ARROW_MIN_WIDTH` it is omitted: on a hairline
 * an arrowhead is a blob, not a direction.
 */
export function arrowheadFor(points: readonly TowerPoint[], strokeWidth: number): string | null {
  if (strokeWidth < ARROW_MIN_WIDTH) return null;
  const tip = points[points.length - 1];
  const before = points[points.length - 2];
  if (tip === undefined || before === undefined) return null;
  const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
  const size = strokeWidth * ARROW_LENGTH_FACTOR;
  return pointsAttr([
    tip,
    {
      x: r2(tip.x - size * Math.cos(angle - ARROW_SPREAD)),
      y: r2(tip.y - size * Math.sin(angle - ARROW_SPREAD)),
    },
    {
      x: r2(tip.x - size * Math.cos(angle + ARROW_SPREAD)),
      y: r2(tip.y - size * Math.sin(angle + ARROW_SPREAD)),
    },
  ]);
}

/**
 * Push overlapping pillar labels apart, deterministically. Sorted by x then id
 * so the result depends only on the geometry, never on array order, and lifted
 * in fixed steps so a label never lands at an arbitrary height.
 *
 * MUTATES IN PLACE, deliberately: these objects were built one statement ago
 * inside this module and have not escaped it, so there is no shared state to
 * surprise. Rebuilding the array to move two numbers would be ceremony.
 */
function decollideLabels(pillars: TowerPillarShape[], height: number): void {
  const byX = [...pillars].sort((a, b) => a.labelX - b.labelX || a.id.localeCompare(b.id));
  const placed: { x: number; y: number }[] = [];
  const floor = LABEL_MIN_Y;
  const ceiling = Math.max(height - LABEL_MIN_Y, floor);
  const clashes = (x: number, y: number) =>
    placed.some(
      (q) => Math.abs(q.y - y) < LABEL_STEP - 1 && Math.abs(q.x - x) < LABEL_HALF_WIDTH,
    );

  for (const p of byX) {
    // Search UP first, then DOWN, alternating outward from the anchor. Lifting
    // only upward runs out of plate: at 300×360 the top pillars sit ~50px down,
    // so the third label hits LABEL_MIN_Y and simply stops, landing 17px from
    // its neighbour — inside the clash box this function exists to empty.
    let chosen = Math.min(Math.max(p.labelY, floor), ceiling);
    for (let step = 0; step < 8; step += 1) {
      const candidates =
        step === 0 ? [p.labelY] : [p.labelY - step * LABEL_STEP, p.labelY + step * LABEL_STEP];
      const fits = candidates
        .map((y) => Math.min(Math.max(y, floor), ceiling))
        .find((y) => !clashes(p.labelX, y));
      if (fits !== undefined) {
        chosen = fits;
        break;
      }
    }
    p.labelY = r2(chosen);
    placed.push({ x: p.labelX, y: p.labelY });
  }
}

/**
 * The tower's own one-sentence summary, used verbatim as the figure's
 * description. Generated from the data so it can never drift from what is
 * drawn, and it always names where the same facts are reachable WITHOUT sight
 * or a pointer — the tower is never the only path to anything.
 */
export function towerDescription(
  data: TransferFlowData,
  measure: "gross" | "net",
  fmt: (cents: number) => string,
): string {
  const months = data.months;
  const first = months[0];
  const last = months[months.length - 1];
  const edges = measure === "net" ? data.netEdges : data.edges;
  if (first === undefined || last === undefined || edges.length === 0) {
    return "No transfers between your accounts in this period.";
  }
  const total = edges.reduce((s, e) => s + e.cents, 0);
  const buckets = edges.reduce((s, e) => s + e.monthCents.filter((c) => c > 0).length, 0);
  return (
    `Transfers between ${data.accounts.length} accounts as a tower, with time running upward ` +
    `from ${first} at the base to ${last} at the top. Each arc is one month of one route: ` +
    `${buckets} arcs carrying ${measure === "net" ? "net" : "gross"} ${fmt(total)} across ` +
    `${edges.length} routes. A thick rope running the full height is a route used constantly; ` +
    `a lone strut is a one-off. The same figures are in the Spine and Table views.`
  );
}
