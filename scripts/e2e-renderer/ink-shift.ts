/**
 * The measure behind `diffVerdict`: how much ink moved, relative to the contrast it has there.
 *
 * A text rasteriser that changes between OS versions re-draws every glyph a fraction of a
 * pixel differently. That moves coverage between NEIGHBOURING pixels: averaged over a small
 * window the difference nearly cancels, and what is left is small next to the local contrast —
 * as small for faint text as for bold, because both scale with the contrast. A real change
 * moves ink a whole pixel or more, adds or removes it, or changes its colour, and the average
 * keeps that.
 *
 * So at every pixel, per channel: `actual - expected` averaged over a window, divided by that
 * channel's contrast where the window reaches (its max minus its min, in whichever image has
 * more). The value is a fraction of the local contrast. A sharp edge moved one whole pixel
 * reads exactly 1/3 in a 3x3 box, whatever its colour.
 *
 * Why not a per-pixel maximum: the drift of c3b9a59 moved single pixels by up to 76 of 255,
 * and real changes to faint content move them by less. e818154 re-drew the dark spending
 * page's faint prior-period ghost line — a genuine change — and its largest pixel moved 67.
 * Against its own contrast it reads 0.348; no drift pair read more than 0.098.
 *
 * Lives in `scripts/` rather than `src/lib/` for the reason `scripts/settlement-lag.ts` gives:
 * `e2e/global-setup.ts` refuses to run when anything under `src` is newer than the build.
 */
import type { RawImage } from "./diff-verdict";

export interface InkScale {
  /** names the measure in a verdict's reasons and in the calibration table */
  id: "ink-fine" | "ink-coarse";
  /** half-width of the averaging box: 1 is 3x3, 3 is 7x7 */
  radius: number;
  /** how many times the box is applied; three passes are close to a Gaussian */
  passes: number;
  /** how far from a pixel its contrast is looked for: as far as its average reaches, or more */
  reach: number;
  /** above this, the difference is content */
  limit: number;
}

/**
 * TWO SCALES, because the two kinds of real change that hide from a per-pixel maximum hide at
 * different sizes. `calibrate-diff-verdict.ts` measured every number here.
 *
 * ink-fine — a 3x3 box — sees ink that MOVED or changed shape: a 1px shift reads 1/3 and the
 * ghost line's re-drawn dots 0.348, while the worst of the 111 drift pairs reads 0.098.
 *
 * ink-coarse — a 7x7 box applied three times, a near-Gaussian reaching 9px — sees ink that
 * changed COLOUR or amount without moving. Its window is smooth on purpose. A box has a hard
 * edge, and a glyph cut by that edge moves ink in or out of it when it shifts a fraction of a
 * pixel; a smooth window has no edge to cut. A recolour changes the ink everywhere, which no
 * window shape hides. On the same pairs an 11x11 box read the worst drift at 0.0196 and faint
 * text made 30 levels brighter at 0.0558, 2.85x apart; this window reads 0.0158 and 0.0535,
 * 3.39x apart.
 *
 * Each limit sits at the geometric mean of the worst drift and the weakest change it exists
 * to catch, so both sides get the same margin: 1.8x for either scale.
 */
export const INK_SCALES: readonly InkScale[] = [
  { id: "ink-fine", radius: 1, passes: 1, reach: 2, limit: 0.18 },
  { id: "ink-coarse", radius: 3, passes: 3, reach: 9, limit: 0.029 },
];

/**
 * Where a channel is nearly flat, divide by this many levels instead of its own contrast. A
 * 1-level rounding change in an almost uniform area would otherwise read as a change of 100%.
 * It still lets a flat area that changed colour through: a panel tinted by one level reads
 * 1/24 = 0.042 at ink-coarse, over its limit.
 */
export const CONTRAST_FLOOR = 24;

export interface InkShift {
  /** the largest value anywhere, as a fraction of the local contrast */
  value: number;
  /** where it was found, in image coordinates */
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest ink shift at one scale. Both images must be the same size. */
export function inkShift(expected: RawImage, actual: RawImage, scale: InkScale): InkShift {
  const changed = changedBox(expected, actual);
  if (changed === null) return { value: 0, x: 0, y: 0 };
  // The average is non-zero only within `passes * radius` of a change, and the contrast there
  // is looked for `reach` further, so this crop gives the same answer as the whole page. (With
  // reach > radius, a box that the crop's edge clips only ever averages zeros.)
  const spread = scale.passes * scale.radius;
  const box = grow(changed, spread + scale.reach, expected.width, expected.height);
  const e = crop(expected, box);
  const a = crop(actual, box);
  let best = 0;
  let at = 0;
  for (const channel of channelsThatVary(e, a)) {
    const contrast = channelRange(e, channel, scale.reach);
    maxInto(contrast, channelRange(a, channel, scale.reach));
    let moved = difference(e, a, channel);
    for (let pass = 0; pass < scale.passes; pass++) {
      moved = boxMean(moved, box.w, box.h, scale.radius);
    }
    for (let i = 0; i < moved.length; i++) {
      const k = contrast[i]!;
      const v = Math.abs(moved[i]!) / (k > CONTRAST_FLOOR ? k : CONTRAST_FLOOR);
      if (v > best) {
        best = v;
        at = i;
      }
    }
  }
  return { value: best, x: box.x + (at % box.w), y: box.y + Math.floor(at / box.w) };
}

/** The bounding box of every pixel whose RGBA differs, or null when none does. */
function changedBox(expected: RawImage, actual: RawImage): Box | null {
  const { width: w, height: h } = expected;
  const e = expected.data;
  const a = actual.data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const same =
        e[k] === a[k] && e[k + 1] === a[k + 1] && e[k + 2] === a[k + 2] && e[k + 3] === a[k + 3];
      if (same) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function grow(box: Box, by: number, width: number, height: number): Box {
  const x = Math.max(0, box.x - by);
  const y = Math.max(0, box.y - by);
  return {
    x,
    y,
    w: Math.min(width, box.x + box.w + by) - x,
    h: Math.min(height, box.y + box.h + by) - y,
  };
}

function crop(img: RawImage, box: Box): RawImage {
  const data = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const from = ((box.y + y) * img.width + box.x) * 4;
    data.set(img.data.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  return { width: box.w, height: box.h, data };
}

/**
 * RGB always; alpha only when some pixel is not opaque. Playwright screenshots are opaque, and
 * skipping a constant channel saves a quarter of the work.
 */
function channelsThatVary(e: RawImage, a: RawImage): number[] {
  for (let k = 3; k < e.data.length; k += 4) {
    if (e.data[k] !== 255 || a.data[k] !== 255) return [0, 1, 2, 3];
  }
  return [0, 1, 2];
}

function maxInto(target: Uint8Array, other: Uint8Array): void {
  for (let i = 0; i < target.length; i++) if (other[i]! > target[i]!) target[i] = other[i]!;
}

function difference(e: RawImage, a: RawImage, channel: number): Float32Array {
  const out = new Float32Array(e.width * e.height);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i * 4 + channel]! - e.data[i * 4 + channel]!;
  return out;
}

/**
 * Each value's mean over the (2r+1)² box around it, the box clipped at the edge. Two
 * running-sum passes, so the cost does not grow with r.
 */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const rows = new Float32Array(w * h);
  const prefix = new Float64Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x]! + src[y * w + x]!;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      rows[y * w + x] = (prefix[x1]! - prefix[x0]!) / (x1 - x0);
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) prefix[y + 1] = prefix[y]! + rows[y * w + x]!;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      out[y * w + x] = (prefix[y1]! - prefix[y0]!) / (y1 - y0);
    }
  }
  return out;
}

/** Each pixel's max minus min of one channel over the (2r+1)² square around it. */
function channelRange(img: RawImage, channel: number, r: number): Uint8Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const rowMax = new Uint8Array(n);
  const rowMin = new Uint8Array(n);
  const longest = Math.max(w, h) + 2 * r;
  const scratch = { work: new Uint8Array(longest), spare: new Uint8Array(longest) };
  for (let y = 0; y < h; y++) {
    const line: Lane = { data, offset: y * w * 4 + channel, stride: 4, length: w };
    const row = (to: Uint8Array): Lane => ({ data: to, offset: y * w, stride: 1, length: w });
    slidingExtreme(line, r, true, row(rowMax), scratch);
    slidingExtreme(line, r, false, row(rowMin), scratch);
  }
  const range = new Uint8Array(n);
  const colMin = new Uint8Array(n);
  for (let x = 0; x < w; x++) {
    const column = (data: Uint8Array): Lane => ({ data, offset: x, stride: w, length: h });
    slidingExtreme(column(rowMax), r, true, column(range), scratch);
    slidingExtreme(column(rowMin), r, false, column(colMin), scratch);
  }
  for (let i = 0; i < n; i++) range[i] = range[i]! - colMin[i]!;
  return range;
}

/** One row or column of a plane: `length` values at `data[offset + i * stride]`. */
interface Lane {
  data: Uint8Array;
  offset: number;
  stride: number;
  length: number;
}

/**
 * The max (or min) of a lane over [i - r, i + r] at every i. The lane is padded by repeating
 * its end values, which gives the same answer as clipping the window at the edge. Built by
 * doubling — after each pass every entry holds the extreme of a span twice as long — so a
 * window of 19 costs five passes instead of nineteen comparisons per pixel.
 */
function slidingExtreme(
  from: Lane,
  r: number,
  takeMax: boolean,
  to: Lane,
  scratch: { work: Uint8Array; spare: Uint8Array },
): void {
  const padded = from.length + 2 * r;
  let cur = scratch.work;
  let next = scratch.spare;
  for (let i = 0; i < padded; i++) {
    const j = Math.min(from.length - 1, Math.max(0, i - r));
    cur[i] = from.data[from.offset + j * from.stride]!;
  }
  const window = 2 * r + 1;
  for (let span = 1; span < window; ) {
    const step = Math.min(span, window - span);
    const end = padded - step;
    if (takeMax) {
      for (let i = 0; i < end; i++) next[i] = cur[i]! > cur[i + step]! ? cur[i]! : cur[i + step]!;
    } else {
      for (let i = 0; i < end; i++) next[i] = cur[i]! < cur[i + step]! ? cur[i]! : cur[i + step]!;
    }
    span += step;
    const done = next;
    next = cur;
    cur = done;
  }
  for (let i = 0; i < to.length; i++) to.data[to.offset + i * to.stride] = cur[i]!;
}
