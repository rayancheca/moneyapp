/**
 * Pure Sankey layout geometry — money-flow diagrams (income sources → total
 * income hub → spending categories → subcategories) for the dashboard and
 * /spending surfaces. No React, no DOM, no Date/random: a graph of
 * {nodes, links} in, positioned rectangles and cubic-bezier link ribbons out.
 *
 * Deterministic by construction — a single left-to-right barycenter ordering
 * pass, no randomized iterative relaxation — so the same graph always lays out
 * identically and the e2e visual baselines stay stable. The renderer
 * (SankeyChart.tsx) owns colour resolution, tooltips, and interaction; this
 * file owns only where each thing sits.
 *
 * Layering: nodes are placed in columns. A caller may pin a node's `column`
 * (the spending flow does: income=0, hub=1, category=2, subcategory=3); any
 * node without one is assigned by longest path from a source, so a generic
 * graph still lays out. Link thickness and node height share ONE vertical scale
 * (`ky`), so on every node face the incoming widths and the outgoing widths each
 * sum to that node's height — the diagram visibly conserves money.
 */

/** opaque passthrough the renderer reads (category id, kind flags, …) */
export type SankeyMeta = Record<string, string | number | boolean | null>;

export interface SankeyNodeInput {
  id: string;
  label: string;
  /** node fill (CSS colour or `var(--…)`); outgoing links inherit it unless overridden */
  color?: string;
  /** pin the node to a column (layer); omitted → derived by longest path from a source */
  column?: number;
  /** click-through target (a ledger href) */
  href?: string;
  meta?: SankeyMeta;
}

export interface SankeyLinkInput {
  /** source node id */
  source: string;
  /** target node id */
  target: string;
  valueCents: number;
  /** override the source-inherited colour for this ribbon */
  color?: string;
}

export interface SankeyGraph {
  nodes: readonly SankeyNodeInput[];
  links: readonly SankeyLinkInput[];
}

export interface SankeyLayoutOptions {
  width: number;
  height: number;
  /** node rectangle thickness in px (default 16) */
  nodeWidth?: number;
  /** vertical gap between stacked nodes in a column, px (default 14) */
  nodePadding?: number;
}

export interface SankeyLayoutNode {
  id: string;
  label: string;
  color?: string;
  href?: string;
  meta?: SankeyMeta;
  column: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** throughput = max(incoming, outgoing) cents */
  valueCents: number;
}

export interface SankeyLayoutLink {
  source: string;
  target: string;
  valueCents: number;
  color?: string;
  /** ribbon thickness in px */
  width: number;
  /** centre y where the ribbon meets the source's right face */
  sourceY: number;
  /** centre y where the ribbon meets the target's left face */
  targetY: number;
  /** SVG path — a horizontal cubic-bezier ribbon centreline */
  path: string;
}

export interface SankeyLayout {
  nodes: SankeyLayoutNode[];
  links: SankeyLayoutLink[];
  width: number;
  height: number;
  columns: number;
}

const DEFAULT_NODE_WIDTH = 16;
const DEFAULT_NODE_PADDING = 14;

interface WorkNode {
  input: SankeyNodeInput;
  index: number;
  column: number;
  value: number;
  x0: number;
  x1: number;
  y0: number;
  height: number;
  in: WorkLink[];
  out: WorkLink[];
}

interface WorkLink {
  input: SankeyLinkInput;
  source: WorkNode;
  target: WorkNode;
  value: number;
  width: number;
  sy: number;
  ty: number;
}

export function computeSankeyLayout(graph: SankeyGraph, options: SankeyLayoutOptions): SankeyLayout {
  const { width, height } = options;
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const nodePadding = options.nodePadding ?? DEFAULT_NODE_PADDING;

  const nodes: WorkNode[] = graph.nodes.map((input, index) => ({
    input,
    index,
    column: 0,
    value: 0,
    x0: 0,
    x1: 0,
    y0: 0,
    height: 0,
    in: [],
    out: [],
  }));

  if (nodes.length === 0) {
    return { nodes: [], links: [], width, height, columns: 0 };
  }

  const byId = new Map(nodes.map((n) => [n.input.id, n]));
  const links: WorkLink[] = [];
  for (const input of graph.links) {
    const source = byId.get(input.source);
    const target = byId.get(input.target);
    if (source === undefined || target === undefined) continue; // dangling reference
    if (!(input.valueCents > 0)) continue; // drop zero / negative / NaN
    const link: WorkLink = { input, source, target, value: input.valueCents, width: 0, sy: 0, ty: 0 };
    links.push(link);
    source.out.push(link);
    target.in.push(link);
  }

  for (const n of nodes) {
    n.value = Math.max(sumValue(n.in), sumValue(n.out));
  }

  assignColumns(nodes);
  const columns = Math.max(...nodes.map((n) => n.column)) + 1;

  // horizontal placement — evenly spread columns across the width
  for (const n of nodes) {
    n.x0 = columns > 1 ? (n.column * (width - nodeWidth)) / (columns - 1) : (width - nodeWidth) / 2;
    n.x1 = n.x0 + nodeWidth;
  }

  const grouped = groupByColumn(nodes, columns);
  const ky = verticalScale(grouped, height, nodePadding);
  for (const n of nodes) n.height = n.value * ky;

  layoutColumns(grouped, height, nodePadding);
  assignLinkGeometry(nodes, ky);

  const outNodes: SankeyLayoutNode[] = nodes.map((n) => ({
    id: n.input.id,
    label: n.input.label,
    color: n.input.color,
    href: n.input.href,
    meta: n.input.meta,
    column: n.column,
    x0: n.x0,
    x1: n.x1,
    y0: n.y0,
    y1: n.y0 + n.height,
    valueCents: n.value,
  }));

  const outLinks: SankeyLayoutLink[] = links.map((l) => ({
    source: l.source.input.id,
    target: l.target.input.id,
    valueCents: l.value,
    color: l.input.color ?? l.source.input.color,
    width: l.width,
    sourceY: l.sy,
    targetY: l.ty,
    path: linkPath(l.source.x1, l.sy, l.target.x0, l.ty),
  }));

  return { nodes: outNodes, links: outLinks, width, height, columns };
}

function sumValue(links: WorkLink[]): number {
  let s = 0;
  for (const l of links) s += l.value;
  return s;
}

/**
 * Longest-path layering. Pinned columns are authoritative; every other node
 * sits one column right of its furthest source. `nodes.length` relaxation
 * passes always suffice for a DAG (the longest chain has < n edges) and need no
 * change-detection / cycle guard, which keeps every branch reachable.
 */
function assignColumns(nodes: WorkNode[]): void {
  for (const n of nodes) n.column = n.input.column ?? 0;
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const n of nodes) {
      if (n.input.column !== undefined) continue; // pinned
      let col = 0;
      for (const l of n.in) col = Math.max(col, l.source.column + 1);
      n.column = col;
    }
  }
}

function groupByColumn(nodes: WorkNode[], columns: number): WorkNode[][] {
  const cols: WorkNode[][] = [];
  for (let c = 0; c < columns; c++) cols.push([]);
  for (const n of nodes) cols[n.column]!.push(n);
  return cols;
}

/**
 * One vertical scale (px per cent) shared across every column — the min over
 * columns of the height available to that column's value. Guards keep it finite
 * and non-negative for degenerate inputs (no links, or a height too small to
 * fit the padding).
 */
function verticalScale(cols: WorkNode[][], height: number, padding: number): number {
  let ky = Infinity;
  for (const col of cols) {
    if (col.length === 0) continue;
    let value = 0;
    for (const n of col) value += n.value;
    if (value <= 0) continue;
    const avail = height - (col.length - 1) * padding;
    ky = Math.min(ky, avail / value);
  }
  return Number.isFinite(ky) ? Math.max(ky, 0) : 0;
}

/**
 * Order and stack each column top-to-bottom. Column 0 keeps input order; every
 * later column is ordered by the barycentre of its already-placed source
 * neighbours (a single left→right pass — deterministic, no iteration). Each
 * column's block is centred vertically.
 */
function layoutColumns(cols: WorkNode[][], height: number, padding: number): void {
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c]!;
    if (c === 0) {
      col.sort((a, b) => a.index - b.index);
    } else {
      col.sort((a, b) => barycentre(a) - barycentre(b) || a.index - b.index);
    }
    stackColumn(col, height, padding);
  }
}

function barycentre(n: WorkNode): number {
  if (n.in.length === 0) return n.y0;
  let s = 0;
  for (const l of n.in) s += l.source.y0 + l.source.height / 2;
  return s / n.in.length;
}

function stackColumn(col: WorkNode[], height: number, padding: number): void {
  let sumH = 0;
  for (const n of col) sumH += n.height;
  const gaps = Math.max(col.length - 1, 0);
  // Compress the gap padding when a crowded column can't fit it — otherwise the
  // nodes march past `height` even though the vertical scale already collapsed
  // their heights toward 0 (padding alone exceeded the canvas). This keeps every
  // node inside [0, height] regardless of node count.
  const pad = gaps > 0 ? Math.min(padding, Math.max((height - sumH) / gaps, 0)) : 0;
  const total = sumH + gaps * pad;
  let y = Math.max((height - total) / 2, 0);
  for (const n of col) {
    n.y0 = y;
    y += n.height + pad;
  }
}

/**
 * Stack each node's ribbons down its faces: outgoing links order by target
 * centre (down the right face), incoming by source centre (down the left face),
 * so on both faces the widths sum to the node height and crossings are reduced.
 */
function assignLinkGeometry(nodes: WorkNode[], ky: number): void {
  for (const n of nodes) {
    const out = [...n.out].sort((a, b) => nodeCentre(a.target) - nodeCentre(b.target) || a.target.index - b.target.index);
    let oy = n.y0;
    for (const l of out) {
      l.width = l.value * ky;
      l.sy = oy + l.width / 2;
      oy += l.width;
    }
    const inc = [...n.in].sort((a, b) => nodeCentre(a.source) - nodeCentre(b.source) || a.source.index - b.source.index);
    let iy = n.y0;
    for (const l of inc) {
      l.width = l.value * ky;
      l.ty = iy + l.width / 2;
      iy += l.width;
    }
  }
}

function nodeCentre(n: WorkNode): number {
  return n.y0 + n.height / 2;
}

function linkPath(x0: number, y0: number, x1: number, y1: number): string {
  const xm = (x0 + x1) / 2;
  return `M${round(x0)},${round(y0)}C${round(xm)},${round(y0)} ${round(xm)},${round(y1)} ${round(x1)},${round(y1)}`;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
