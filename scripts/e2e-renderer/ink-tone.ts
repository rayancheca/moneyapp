/**
 * A measure behind `diffVerdict`: the TONE of a word — its ink made lighter, darker or another
 * colour, all of it together.
 *
 * ink-coarse divides a smoothed difference by the local contrast, so what it reads for a recolour
 * scales with how much of its window is ink. opacity 0.9 on the accounts page's heading reads
 * 0.056 there; on the page's 11px faint "as of" line it reads 0.027, under the 0.029 limit, and so
 * does the light theme's --ink-faint swapped for --ink-muted on that line. A colour or opacity
 * change on small text is exactly such a change.
 *
 * Tone does not depend on how much ink there is. It finds the WORDS — ink whose glyphs lie within
 * 2px of one another — and in each, the SOLID pixels: at least half the local contrast from the
 * paper, in either image. A recolour moves every one of them by the same fraction of its ink.
 * Re-rasterising moves few of them, and not together: it shifts a glyph a fraction of a pixel,
 * one edge gaining ink and the other losing it, and re-shades where strokes overlap (the crossing
 * of a "+", the bar through a "$"). The measure is the share of a word's solid pixels whose ink
 * moved by at least TONE_STEP of itself one way, with their neighbours' ink moving the same way
 * (ink passed from a pixel to the next is not a re-toning), net of those that moved the other.
 *
 * `calibrate-diff-verdict.ts` measured it: a tenth off a faint line, or a colour token swapped
 * on it, reads 1 on every page, in either theme, with the OS drift beside it or not. The worst
 * word in c3b9a59's 111 drift pairs reads 1/3: the lone "+" of budgets' "plan + $133.00", whose
 * crossing was re-shaded, four of its twelve solid pixels. Without the neighbours' agreement, a
 * thin stem landing on one pixel instead of two reads as a word darkened: diff-verdict.test.ts's
 * small faint line re-drawn a quarter of a pixel away read 0.5.
 */
import type { RawImage } from "./diff-verdict";
import {
  CONTRAST_FLOOR,
  boxMean,
  changedBox,
  channelExtremes,
  channelsThatVary,
  crop,
  grow,
  type InkShift,
} from "./ink-shift";

/**
 * Above this share, the difference is content: the geometric mean of the worst drift (1/3) and a
 * recolour (1), so both sides get the same margin, 1.7x.
 */
export const TONE_LIMIT = 0.58;
/** A solid pixel has moved when its ink changed by at least this fraction of itself. */
export const TONE_STEP = 0.05;
/** Solid: at least this fraction of the local contrast away from the paper. */
export const TONE_SOLID = 0.5;
/** Ink, for finding the words: at least this fraction of the local contrast. */
const INK = 0.25;
/** Ink this close joins one word: glyphs 2px apart do, words 3px apart at 11px do not. */
const JOIN = 1;
/** A word is judged only with this many solid pixels: fewer, and one re-shaded crossing is most. */
export const TONE_MIN_SOLID = 12;
/** How far the local contrast is looked for: a glyph's paper is within 3px of its every pixel. */
const REACH = 3;
/** The 9x9 mean that says which side of the contrast the paper is on: most of it is paper. */
const PAPER_RADIUS = 4;
/**
 * The words around a change are judged whole, which needs them inside the crop: this far past the
 * change, about seven glyphs of 11px text. A longer word is judged on what lies within it.
 */
const MARGIN = 48;

/** The word whose solid pixels moved most together, as a share of them. Both images one size. */
export function inkTone(expected: RawImage, actual: RawImage): InkShift {
  const changed = changedBox(expected, actual);
  if (changed === null) return { value: 0, x: 0, y: 0 };
  const box = grow(changed, MARGIN, expected.width, expected.height);
  const e = crop(expected, box);
  const a = crop(actual, box);
  const n = box.w * box.h;
  const ink = new Uint8Array(n);
  const channels = channelsThatVary(e, a).map((c) => classify(e, a, c, ink));
  const words = labelWords(ink, box.w, box.h);
  let best = 0;
  let at = 0;
  const solid = new Int32Array(n);
  const net = new Int32Array(n);
  for (const { isSolid, moved } of channels) {
    solid.fill(0);
    net.fill(0);
    for (let i = 0; i < n; i++) {
      const word = words[i]!;
      if (word < 0 || isSolid[i] === 0) continue;
      solid[word]!++;
      net[word]! += moved[i]!;
    }
    for (let word = 0; word < n; word++) {
      if (solid[word]! < TONE_MIN_SOLID) continue;
      const share = Math.abs(net[word]!) / solid[word]!;
      if (share > best) {
        best = share;
        at = word;
      }
    }
  }
  return { value: best, x: box.x + (at % box.w), y: box.y + Math.floor(at / box.w) };
}

interface Classified {
  /** 1 where the pixel is solid in either image */
  isSolid: Uint8Array;
  /**
   * -1 toward the paper, +1 away from it: by TONE_STEP of its ink or more, with its neighbours'
   * ink moving the same way. 0 otherwise.
   */
  moved: Int8Array;
}

/** One channel's solid pixels and which way each moved; marks the ink it finds into `ink`. */
function classify(e: RawImage, a: RawImage, channel: number, ink: Uint8Array): Classified {
  const { width: w, height: h } = e;
  const n = w * h;
  const extremesE = channelExtremes(e, channel, REACH);
  const extremesA = channelExtremes(a, channel, REACH);
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = e.data[i * 4 + channel]!;
  const mean = boxMean(values, w, h, PAPER_RADIUS);
  // each pixel's ink in either image, as a fraction of the local contrast from the paper
  const inkE = new Float32Array(n);
  const inkA = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const hi = Math.max(extremesE.max[i]!, extremesA.max[i]!);
    const lo = Math.min(extremesE.min[i]!, extremesA.min[i]!);
    const k = hi - lo;
    if (k < CONTRAST_FLOOR) continue;
    const paper = mean[i]! > (hi + lo) / 2 ? hi : lo;
    inkE[i] = Math.abs(e.data[i * 4 + channel]! - paper) / k;
    inkA[i] = Math.abs(a.data[i * 4 + channel]! - paper) / k;
    if (Math.max(inkE[i]!, inkA[i]!) >= INK) ink[i] = 1;
  }
  const isSolid = new Uint8Array(n);
  const moved = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const most = Math.max(inkE[i]!, inkA[i]!);
    if (most < TONE_SOLID) continue;
    isSolid[i] = 1;
    const change = (inkA[i]! - inkE[i]!) / most;
    const way = change <= -TONE_STEP ? -1 : change >= TONE_STEP ? 1 : 0;
    if (way !== 0 && Math.sign(neighbourChange(inkE, inkA, i, w, h)) === way) moved[i] = way;
  }
  return { isSolid, moved };
}

/**
 * How the ink of a pixel's eight neighbours changed, together. A recolour moves them with it.
 * A glyph re-drawn a fraction of a pixel away moves ink between them: the pixel a thin stem
 * moved onto gains what its neighbour lost, which is not a word re-toned.
 */
function neighbourChange(
  inkE: Float32Array,
  inkA: Float32Array,
  i: number,
  w: number,
  h: number,
): number {
  const x = i % w;
  const y = (i - x) / w;
  let sum = 0;
  for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
      const j = yy * w + xx;
      if (j !== i) sum += inkA[j]! - inkE[j]!;
    }
  }
  return sum;
}

/**
 * The words: 8-connected groups of ink once each ink pixel is grown by JOIN. Each pixel of a word
 * holds the word's lowest pixel index, and every other pixel -1.
 */
function labelWords(ink: Uint8Array, w: number, h: number): Int32Array {
  const grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ink[y * w + x] === 0) continue;
      for (let yy = Math.max(0, y - JOIN); yy <= Math.min(h - 1, y + JOIN); yy++) {
        grown.fill(1, yy * w + Math.max(0, x - JOIN), yy * w + Math.min(w - 1, x + JOIN) + 1);
      }
    }
  }
  const parent = new Int32Array(w * h).fill(-1);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const join = (i: number, j: number): void => {
    const p = find(i);
    const q = find(j);
    if (p < q) parent[q] = p;
    else if (q < p) parent[p] = q;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (grown[i] === 0) continue;
      parent[i] = i;
      if (x > 0 && grown[i - 1] === 1) join(i, i - 1);
      if (y === 0) continue;
      if (grown[i - w] === 1) join(i, i - w);
      if (x > 0 && grown[i - w - 1] === 1) join(i, i - w - 1);
      if (x < w - 1 && grown[i - w + 1] === 1) join(i, i - w + 1);
    }
  }
  for (let i = 0; i < parent.length; i++) if (parent[i] !== -1) parent[i] = find(i);
  return parent;
}
