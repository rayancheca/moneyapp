/**
 * A measure behind `diffVerdict`: ink that APPEARED ON BARE PAPER, or vanished and left it bare.
 *
 * Re-rasterising text moves ink a fraction of a pixel and re-shades the pixels where a glyph's
 * strokes overlap; every pixel it touches has ink beside it in both images. A comma swapped for a
 * period is not like that: the comma's tail hangs below the baseline, where the period leaves
 * bare paper. In the app's 11px `.figures` amounts that tail is 1.2 px² of ink, which ink-fine's
 * 3x3 box dilutes to 0.15 (c3b9a59's drift reached 0.098, and its limit is 0.18) and ink-coarse
 * to 0.013.
 *
 * So at every pixel, per channel: where ONE image is flat around it — its 3x3 neighbourhood varies
 * by no more than a tenth of the local contrast, so there is no ink within a pixel — and the other
 * differs there by more than that, the difference is ink drawn on bare paper or taken off it. The
 * measure sums it over a 3x3 box, each pixel as a fraction of the local contrast: pixels' worth of
 * full-contrast ink, px². The 11px comma's tail reads 0.59, the part of it more than a pixel below
 * the head, and the 14px one's 1.23; the 111 drift pairs of c3b9a59 read 0.
 *
 * It sees nothing ink-fine is for: ink that moved a whole pixel lands beside where it was, and a
 * shifted line of text reads 0 here. Nor does it see text re-coloured (ink-tone): ink re-coloured
 * in place has itself beside it. A flat area re-coloured whole, a panel tinted, is change on
 * "bare paper" here too, and content, as ink-coarse already says.
 */
import type { RawImage } from "./diff-verdict";
import { CONTRAST_FLOOR, channelsThatVary, type InkShift } from "./ink-shift";

/**
 * Flat: the 3x3 neighbourhood varies by at most this fraction of the local contrast. A tenth
 * lets the paper's grain and the faintest anti-aliasing fringe count as bare, and nothing a
 * glyph's edge draws. The change must also be larger than this, so that a flat area re-drawn a
 * level or two lighter (dithering, grain) is not ink.
 */
export const LONE_FLAT = 0.1;
/** How far the local contrast is looked for: far enough to reach the glyph a tail hangs from. */
export const LONE_REACH = 3;
/**
 * Above this many px², the difference is content. No drift pair reads above 0 (re-rasterising
 * draws nothing on bare paper), so the limit is set from below: a quarter of a pixel's worth of
 * ink, under half the 11px comma's 0.59.
 */
export const LONE_LIMIT = 0.25;

/**
 * The largest 3x3 sum of ink drawn on, or taken off, bare paper. Both images the same size.
 * Only a pixel that changed can hold any, so only those are looked at: a page of drift changes a
 * few percent of its pixels, and this reads it in a few tens of milliseconds.
 */
export function inkLone(expected: RawImage, actual: RawImage): InkShift {
  const { width: w, height: h } = expected;
  const changed = changedPixels(expected, actual);
  if (changed.length === 0) return { value: 0, x: 0, y: 0 };
  const lone = new Float32Array(w * h);
  let best = 0;
  let at = 0;
  for (const channel of channelsThatVary(expected, actual)) {
    for (const i of changed) lone[i] = loneInk(expected, actual, channel, i);
    // every 3x3 box holding a lone pixel: its centre is within a pixel of one
    for (const i of changed) {
      if (lone[i] === 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      for (let cy = Math.max(0, y - 1); cy <= Math.min(h - 1, y + 1); cy++) {
        for (let cx = Math.max(0, x - 1); cx <= Math.min(w - 1, x + 1); cx++) {
          const sum = sum3x3(lone, w, h, cx, cy);
          const j = cy * w + cx;
          // the first box in reading order among equals, so a verdict names one place
          if (sum > best || (sum === best && j < at)) {
            best = sum;
            at = j;
          }
        }
      }
    }
  }
  return { value: best, x: at % w, y: Math.floor(at / w) };
}

/** The index of every pixel whose RGBA differs. */
function changedPixels(expected: RawImage, actual: RawImage): number[] {
  const e = expected.data;
  const a = actual.data;
  const out: number[] = [];
  for (let i = 0, k = 0; k < e.length; i++, k += 4) {
    if (e[k] !== a[k] || e[k + 1] !== a[k + 1] || e[k + 2] !== a[k + 2] || e[k + 3] !== a[k + 3]) {
      out.push(i);
    }
  }
  return out;
}

/** One pixel's ink drawn on or taken off bare paper, as a fraction of the local contrast. */
function loneInk(e: RawImage, a: RawImage, channel: number, i: number): number {
  const moved = Math.abs(a.data[i * 4 + channel]! - e.data[i * 4 + channel]!);
  if (moved === 0) return 0;
  const x = i % e.width;
  const y = (i - x) / e.width;
  const k = Math.max(
    rangeAround(e, channel, x, y, LONE_REACH),
    rangeAround(a, channel, x, y, LONE_REACH),
    CONTRAST_FLOOR,
  );
  const bare = LONE_FLAT * k;
  if (moved <= bare) return 0;
  const flat = rangeAround(e, channel, x, y, 1) <= bare || rangeAround(a, channel, x, y, 1) <= bare;
  return flat ? moved / k : 0;
}

/** Max minus min of one channel over the (2r+1)² square around (x, y), clipped at the edge. */
function rangeAround(img: RawImage, channel: number, x: number, y: number, r: number): number {
  const { width: w, height: h, data } = img;
  let hi = 0;
  let lo = 255;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    const end = (yy * w + Math.min(w - 1, x + r)) * 4 + channel;
    for (let k = (yy * w + Math.max(0, x - r)) * 4 + channel; k <= end; k += 4) {
      const v = data[k]!;
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
  }
  return hi - lo;
}

/** The sum of `values` over the 3x3 box around (x, y), clipped at the edge. */
function sum3x3(values: Float32Array, w: number, h: number, x: number, y: number): number {
  let sum = 0;
  for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) sum += values[yy * w + xx]!;
  }
  return sum;
}
