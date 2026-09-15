import { cancelledTransferNote } from "./cancelled-transfer-note";
import { renderPercent } from "@/lib/insight-facts";
import type { TransferEdge, TransferFlowData } from "@/services/transfer-flow";

/**
 * Pure geometry for the transfer-flow view — "The Spine".
 *
 * No React, no DOM, no `Date`, no `Math.random`. Same contract as
 * `sankey-layout.ts`: the renderer decides colour and interaction, this decides
 * where everything sits. Determinism is not a nicety here — the visual
 * baselines depend on identical input producing byte-identical geometry.
 *
 * THE FORM. Accounts are fixed nodes on a vertical spine, ordered by net
 * position: the biggest net SOURCE at the top, the biggest net SINK at the
 * bottom. Every edge is a cubic lobe leaving and re-entering that spine:
 *
 *   - bulging RIGHT when money moves DOWN the ladder — toward its net destination
 *   - bulging LEFT  when it moves back UP
 *
 * That is the whole argument for this form. The left region is, by construction,
 * exactly the round-trip return flow, so switching gross → net visibly empties
 * it. Churn stops being a number in a tooltip and becomes the shape of the chart.
 *
 * BULGE IS A FUNCTION OF SPAN, NEVER OF VALUE. Two edges spanning the same
 * distance share a curve family; two spanning different distances can never
 * collide and hide one another. Crucially it also means the layout cannot shift
 * when the amounts change — only the stroke widths do.
 *
 * TWO CHANNELS, TWO STORIES. Stroke width encodes DOLLARS; dash gap encodes
 * TRANSFER COUNT. They must not be collapsed into one: on the real data
 * SoFi Savings→SoFi Checking is 299 transfers averaging ~$327 while
 * Chase→SoFi Savings is 23 averaging ~$3,435. Near-identical totals, opposite
 * behaviour — a single ribbon width would say they are the same thing.
 */

export interface SpineLayoutOptions {
  width: number;
  /** below this width the labels tuck inline and the lobes shrink */
  compactBelow?: number;
}

export interface SpineNode {
  id: string;
  label: string;
  color: string;
  netCents: number;
  inCents: number;
  outCents: number;
  href: string;
  y: number;
  labelX: number;
  /** |net| as a fraction of the largest |net| — drives the node dot radius */
  weight: number;
  radius: number;
}

export interface SpineArc {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  cents: number;
  count: number;
  grossCents: number;
  returnedCents: number;
  /** SVG cubic; both control points share an x, which makes a clean lobe */
  path: string;
  /** px — encodes DOLLARS */
  width: number;
  /** px — encodes TRANSFER COUNT (tighter dashes = more transfers) */
  dashGap: number;
  dashLength: number;
  /** seconds for one dash-drift cycle; motion is decorative and may be disabled */
  dashDurationS: number;
  /** true when the arc bulges right — money moving toward its net destination */
  isOnward: boolean;
  /** the cubic's midpoint (t = 0.5), for hover labels */
  labelX: number;
  labelY: number;
}

export interface SpineLayout {
  width: number;
  height: number;
  spineX: number;
  /** x extents actually used by returning (left) and onward (right) lobes */
  leftRegion: number;
  rightRegion: number;
  nodes: SpineNode[];
  arcs: SpineArc[];
  compact: boolean;
}

const NODE_GAP = 74;
const PAD_Y = 34;
/** room reserved LEFT of everything for the account name + its net figure */
const LABEL_GUTTER = 132;
const COMPACT_LABEL_GUTTER = 96;
const MIN_STROKE = 2;
const MAX_STROKE = 26;
const MIN_RADIUS = 4;
const MAX_RADIUS = 11;
const MIN_BULGE = 46;
const MAX_BULGE = 190;
const COMPACT_BULGE_SCALE = 0.56;
const DEFAULT_COMPACT_BELOW = 560;
/** how far the span-derived lobes may be stretched to fill a wide canvas */
const MAX_FIT_SCALE = 2.4;

/** Round to 2dp so the emitted path strings are stable across platforms. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Perceptual width scale. sqrt, not linear: the real data spans $100 to $97,922
 * on one chart, and a linear map renders every edge but the largest as a
 * hairline. sqrt keeps the small edges legible while preserving the ordering.
 */
function strokeFor(cents: number, maxCents: number): number {
  if (maxCents <= 0 || cents <= 0) return MIN_STROKE;
  const t = Math.sqrt(cents / maxCents);
  return r2(MIN_STROKE + t * (MAX_STROKE - MIN_STROKE));
}

/**
 * Dash cadence from transfer COUNT. More transfers ⇒ tighter gaps, so a busy
 * edge reads as a dotted rope and a rare one as a long solid stroke. The gap is
 * static, so the meaning survives `prefers-reduced-motion` with the drift off.
 */
function cadenceFor(count: number, maxCount: number): { dashGap: number; dashLength: number; dashDurationS: number } {
  if (maxCount <= 1 || count <= 1) return { dashGap: 0, dashLength: 0, dashDurationS: 0 };
  const t = Math.min(1, count / maxCount);
  const dashGap = r2(14 - t * 10); // 14px at the rarest → 4px at the busiest
  const dashLength = r2(10 + t * 12);
  const dashDurationS = r2(3.4 - t * 1.9);
  return { dashGap, dashLength, dashDurationS };
}

export function computeSpineLayout(
  data: TransferFlowData,
  measure: "gross" | "net",
  options: SpineLayoutOptions,
): SpineLayout {
  const edges: readonly TransferEdge[] = measure === "net" ? data.netEdges : data.edges;
  const compactBelow = options.compactBelow ?? DEFAULT_COMPACT_BELOW;
  const compact = options.width < compactBelow;
  const bulgeScale = compact ? COMPACT_BULGE_SCALE : 1;

  const nodeOrder = new Map(data.accounts.map((a, i) => [a.id, i]));
  const height = PAD_Y * 2 + Math.max(0, data.accounts.length - 1) * NODE_GAP;

  const maxCents = edges.reduce((m, e) => Math.max(m, e.cents), 0);
  const maxCount = edges.reduce((m, e) => Math.max(m, e.count), 0);
  // Span drives the bulge, so it must be the span of the EDGES actually drawn.
  const maxSpan = edges.reduce((m, e) => {
    const from = nodeOrder.get(e.fromAccountId);
    const to = nodeOrder.get(e.toAccountId);
    if (from === undefined || to === undefined) return m;
    return Math.max(m, Math.abs(to - from));
  }, 0);

  // ---- FIT THE SPINE TO THE CANVAS BEFORE PLACING ANYTHING ------------------
  // Two passes are required. The unscaled bulges tell us how far the lobes want
  // to reach on each side; only then can the spine's x be chosen so that the
  // label gutter, the return lobes and the onward lobes all fit the real width.
  // Doing this in one pass (a fixed fraction of the width) put the labels
  // underneath the returning arcs and let the widest lobes run off the canvas.
  const unscaledBulge = (span: number) => {
    const t = maxSpan > 0 ? span / maxSpan : 1;
    return MIN_BULGE + t * (MAX_BULGE - MIN_BULGE);
  };
  let wantLeft = 0;
  let wantRight = 0;
  for (const e of edges) {
    const from = nodeOrder.get(e.fromAccountId);
    const to = nodeOrder.get(e.toAccountId);
    if (from === undefined || to === undefined) continue;
    const b = unscaledBulge(Math.abs(to - from));
    if (to > from) wantRight = Math.max(wantRight, b);
    else wantLeft = Math.max(wantLeft, b);
  }

  const gutter = compact ? COMPACT_LABEL_GUTTER : LABEL_GUTTER;
  const wanted = wantLeft + wantRight;
  const available = Math.max(1, options.width - gutter);
  // Fill the canvas rather than sitting in the middle of it. A fixed MAX_BULGE
  // left roughly half the width empty on a desktop card — the same dead
  // horizontal space the shell was widened to reclaim. Growth is capped so a
  // very wide screen stretches the lobes into flat, indistinguishable sweeps.
  const fitScale = Math.min(MAX_FIT_SCALE, available / Math.max(1, wanted));
  const bulgeScaleFinal = bulgeScale * fitScale;

  const leftMax = r2(wantLeft * bulgeScaleFinal);
  const rightMax = r2(wantRight * bulgeScaleFinal);
  // Everything left of the spine — the return lobes AND the labels beyond them.
  const spineX = r2(gutter + leftMax);

  const maxAbsNet = data.accounts.reduce((m, a) => Math.max(m, Math.abs(a.netCents)), 0);
  const nodes: SpineNode[] = data.accounts.map((a, i) => {
    const weight = maxAbsNet > 0 ? Math.abs(a.netCents) / maxAbsNet : 0;
    return {
      id: a.id,
      label: a.label,
      color: a.color,
      netCents: a.netCents,
      inCents: a.inCents,
      outCents: a.outCents,
      href: a.href,
      y: PAD_Y + i * NODE_GAP,
      // clear of the return region, not merely clear of the spine
      labelX: r2(spineX - leftMax - 12),
      weight: r2(weight),
      radius: r2(MIN_RADIUS + Math.sqrt(weight) * (MAX_RADIUS - MIN_RADIUS)),
    };
  });

  let leftRegion = 0;
  let rightRegion = 0;

  const arcs: SpineArc[] = [];
  for (const e of edges) {
    const fromIdx = nodeOrder.get(e.fromAccountId);
    const toIdx = nodeOrder.get(e.toAccountId);
    if (fromIdx === undefined || toIdx === undefined) continue; // unknown account: skip, never guess

    const y1 = PAD_Y + fromIdx * NODE_GAP;
    const y2 = PAD_Y + toIdx * NODE_GAP;
    const span = Math.abs(toIdx - fromIdx);
    // Guard the single-edge / single-span case: t = 1 rather than 0/0.
    const bulge = r2(unscaledBulge(span) * bulgeScaleFinal);

    // Down the ladder = toward the net destination = onward = bulge RIGHT.
    const isOnward = toIdx > fromIdx;
    const dir = isOnward ? 1 : -1;
    const cx = r2(spineX + dir * bulge);

    if (isOnward) rightRegion = Math.max(rightRegion, bulge);
    else leftRegion = Math.max(leftRegion, bulge);

    // Cubic with both control points at the same x — a clean, symmetric lobe.
    const path = `M ${spineX} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${spineX} ${y2}`;

    // Midpoint of a cubic at t = 0.5: (P0 + 3·P1 + 3·P2 + P3) / 8.
    const labelX = r2((spineX + 3 * cx + 3 * cx + spineX) / 8);
    const labelY = r2((y1 + 3 * y1 + 3 * y2 + y2) / 8);

    arcs.push({
      id: e.id,
      fromAccountId: e.fromAccountId,
      toAccountId: e.toAccountId,
      cents: e.cents,
      count: e.count,
      grossCents: e.grossCents,
      returnedCents: e.returnedCents,
      path,
      width: strokeFor(e.cents, maxCents),
      ...cadenceFor(e.count, maxCount),
      isOnward,
      labelX,
      labelY,
    });
  }

  return {
    width: options.width,
    height,
    spineX,
    leftRegion: r2(leftRegion),
    rightRegion: r2(rightRegion),
    nodes,
    arcs,
    compact,
  };
}

/**
 * The chart's own one-sentence summary, used verbatim as the SVG `<desc>`.
 * Generated from the data so it can never drift from what is drawn.
 */
export function spineDescription(data: TransferFlowData, fmt: (cents: number) => string): string {
  const source = data.accounts[0];
  const sink = data.accounts[data.accounts.length - 1];
  if (data.edges.length === 0 || source === undefined || sink === undefined) {
    return "No transfers between your accounts in this period.";
  }
  const churnPct =
    data.totals.grossCents > 0
      ? Math.round((data.totals.churnCents / data.totals.grossCents) * 1000) / 10
      : 0;

  const parts = [
    `${fmt(data.totals.grossCents)} moved between ${data.accounts.length} accounts`,
    ` across ${data.totals.pairedGroupCount} transfers; `,
    `${fmt(data.totals.churnCents)} of that returned to where it came from (${churnPct}%),`,
    ` leaving ${fmt(data.totals.netCents)} net.`,
    ` Largest net source ${source.label} at ${fmt(source.netCents)};`,
    ` largest net destination ${sink.label} at ${fmt(sink.netCents)}.`,
  ];
  if (data.totals.unattributedGroupCount > 0) {
    parts.push(
      ` ${data.totals.unattributedGroupCount} further transfer groups (${fmt(data.totals.unattributedCents)})` +
        ` could not be matched to a pair of accounts and are excluded from the diagram.`,
    );
  }
  const cancelled = cancelledTransferNote(data.totals.cancelledGroupCount, data.totals.cancelledCents, fmt, "in the diagram");
  if (cancelled !== null) parts.push(` ${cancelled}`);
  return parts.join("");
}

/**
 * One node's complete spoken label. The visible node text is only the account
 * name and its net, so this is the ONLY sentence a screen-reader user gets —
 * and, like `spineDescription` above it, it is generated from the data so it
 * cannot drift from what is drawn.
 *
 * 🔴 The percent was `Math.abs(n.netCents) / data.totals.grossCents` — an
 * account's NET (in − out) over the WHOLE ledger's GROSS volume, two different
 * quantities, announced as "N% of all transfer volume". Measured 2026-09-11:
 * Chase Checking sent $172,517.92 of the $415,945.05 that moved between these
 * accounts and was announced as "33%". The eight labels summed to 91.06% and
 * CAN NEVER sum to 100 — account nets sum to zero, so no set of |net| shares
 * has a fixed total at all.
 *
 * The numerator is the LEG the sentence names, and gross is the sum of exactly
 * those legs (Σ out = Σ in = grossCents, which the Table lens's own footer
 * prints: "Out $415,945.05 = In $415,945.05"), so every share is a share of a
 * total this page really shows and a reader can check it against that column.
 *
 * ⛔ `renderPercent`, never `Math.round`: Wells Fargo sent $1,321.97, which is
 * 0.3178% of the volume, and `Math.round` printed it "0%" — a measured zero
 * about money that really moved.
 *
 * ⚠️ The eight shares still do not sum to 100, and must not be made to: half
 * measure the out leg and half the in leg, each a complete partition of gross
 * on its own. That is why every share now NAMES its leg — "left from here" /
 * "arrived here". The old sentence said "of all transfer volume" for all eight
 * and invited exactly the addition it could never satisfy.
 */
export function spineNodeLabel(
  node: SpineNode,
  data: TransferFlowData,
  fmt: (cents: number) => string,
): string {
  const direction = node.netCents < 0 ? "net source" : node.netCents > 0 ? "net destination" : "net flat";
  // measure the leg the direction word names: a net destination is interesting
  // for what ARRIVED, a net source for what LEFT. Either leg is a true part of
  // grossCents; |net| is a part of neither.
  const arriving = node.netCents > 0;
  const legCents = arriving ? node.inCents : node.outCents;
  const verb = arriving ? "arrived here" : "left from here";
  const head = `${node.label}, ${direction} ${fmt(node.netCents)} — sent ${fmt(node.outCents)}, received ${fmt(node.inCents)}`;
  // no volume ⇒ no share, rather than a 0% that states a measurement
  if (data.totals.grossCents <= 0) return `${head} — view transactions`;
  return (
    `${head}; ${renderPercent(legCents / data.totals.grossCents)}` +
    ` of the ${fmt(data.totals.grossCents)} that moved between these ${data.accounts.length} accounts` +
    ` ${verb} — view transactions`
  );
}
