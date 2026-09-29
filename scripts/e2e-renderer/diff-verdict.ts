/**
 * Is a failed visual baseline RENDERER DRIFT, or did the page change?
 *
 * e2e compares 202 PNG baselines at `maxDiffPixels: 0` on one Mac. When macOS went 25.5 to
 * 27.2 the gate failed 107 of them with no UI change: the new text rasteriser draws each glyph
 * a fraction of a pixel differently, and at zero tolerance that fails every page with text.
 * c3b9a59 re-based 111 files by hand after proving it. `pnpm e2e:rebase-renderer` does the
 * same only when EVERY diff is that drift, and refuses anything else — a changed glyph, a 1px
 * layout shift, a size or colour change. This is the judge it asks.
 *
 * THE RULE, in order:
 *   1. a different width or height is content — no renderer resizes a page;
 *   2. when no pixel differs, identical;
 *   3. otherwise four ink measures (INK_MEASURES), each seeing a change re-rasterising never
 *      makes: ink moved a whole pixel (ink-fine) or changed in amount or colour over a
 *      word-sized area (ink-coarse), both in `ink-shift.ts`; ink drawn on or taken off bare paper
 *      (`ink-lone.ts`); a word's ink re-toned all together (`ink-tone.ts`). Above any limit is
 *      content; at or below all four is renderer drift.
 *
 * Calibrated on real history, not guesses; `tsx scripts/e2e-renderer/calibrate-diff-verdict.ts`
 * re-runs it and prints the table. Measured 2026-09-29, with `--all`:
 *
 *   renderer   c3b9a59's 111 pairs            111 renderer-only   worst 1.74x under a limit
 *   content    1,023 changed baselines, the   1,023 content       weakest 1.85x over a limit
 *              46 UI commits since 803eeb2    (449 by size)
 *   synthetic  164 edits of real baselines    164 content         weakest 1.72x over a limit
 *
 * The synthetic edits are a 1px shift of text, two digits swapped, a money amount's "," and "."
 * swapped (14px and 11px figures), text recoloured, dimmed by a tenth or given the next colour
 * token (faint and bold, light and dark), a region erased, a panel tinted and a page one pixel
 * taller — each also judged against the pre-upgrade baseline, the OS drift and the change
 * landing in the same run.
 */
import sharp from "sharp";
import { inkLone, LONE_LIMIT } from "./ink-lone";
import { INK_SCALES, inkShift, type InkShift } from "./ink-shift";
import { inkTone, TONE_LIMIT } from "./ink-tone";

export type RawImage = { width: number; height: number; data: Uint8Array }; // RGBA

export type InkId = "ink-fine" | "ink-coarse" | "ink-lone" | "ink-tone";

/** One way ink changes that re-rasterising never changes it, and how much of it is content. */
export interface InkMeasure {
  id: InkId;
  /** above this, the difference is content */
  limit: number;
  /** what it sums or averages over, for the calibration table */
  shape: string;
  /** what a value over the limit says happened, in a content verdict's reasons */
  meaning: string;
  measure: (expected: RawImage, actual: RawImage) => InkShift;
}

/**
 * Every measure the judge asks, each blind to what the others see: ink moved a whole pixel
 * (ink-fine), ink whose amount or colour changed over a word-sized area (ink-coarse), ink drawn on
 * or taken off bare paper (ink-lone, see ink-lone.ts), and a word's ink re-toned all together
 * (ink-tone, see ink-tone.ts).
 */
export const INK_MEASURES: readonly InkMeasure[] = [
  ...INK_SCALES.map((scale): InkMeasure => {
    const side = `${2 * scale.radius + 1}x${2 * scale.radius + 1}`;
    return {
      id: scale.id,
      limit: scale.limit,
      shape: scale.passes === 1 ? `${side} box` : `${side} box x${scale.passes}`,
      meaning:
        scale.id === "ink-fine"
          ? "ink moved, appeared or vanished here, further than re-rasterising moves it"
          : "the amount or colour of ink over a word-sized area changed",
      measure: (expected, actual) => inkShift(expected, actual, scale),
    };
  }),
  {
    id: "ink-lone",
    limit: LONE_LIMIT,
    shape: "3x3 sum on bare paper",
    meaning: "ink was drawn on bare paper here, or taken off it, where re-rasterising puts none",
    measure: inkLone,
  },
  {
    id: "ink-tone",
    limit: TONE_LIMIT,
    shape: "share of a word's solid ink",
    meaning: "a word's ink got lighter, darker or another colour, all of it together",
    measure: inkTone,
  },
];

/**
 * `decidingMeasure` is "size", "pixels" (identical), or the ink measure furthest past its limit
 * — or, for renderer-only, the one that came closest to it. `reasons` carries one line per
 * ink measure, `<id> <value> <relation> <limit> at (x,y)`.
 */
export type DiffVerdict = {
  verdict: "identical" | "renderer-only" | "content";
  reasons: string[];
  metrics: {
    changedPixels: number;
    changedFraction: number;
    maxDelta: number;
    meanDelta: number;
    bbox: { x: number; y: number; w: number; h: number } | null;
    decidingMeasure: string;
  };
};

/**
 * Decodes a PNG (a path or its bytes) to 8-bit RGBA. sharp turns greyscale into RGB and adds an
 * opaque alpha where there is none; the size check refuses anything else it might hand back,
 * because every measure here reads exactly four bytes a pixel.
 */
export async function decodePng(input: string | Buffer): Promise<RawImage> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
  checkImage(image, typeof input === "string" ? input : "PNG buffer");
  return image;
}

export function diffVerdict(expected: RawImage, actual: RawImage): DiffVerdict {
  checkImage(expected, "expected");
  checkImage(actual, "actual");

  if (expected.width !== actual.width || expected.height !== actual.height) {
    const size = (img: RawImage) => `${img.width}x${img.height}`;
    return {
      verdict: "content",
      reasons: [
        `size changed: ${size(expected)} -> ${size(actual)}; a renderer does not resize a page`,
        "pixel metrics compare the overlapping top-left region only",
      ],
      metrics: { ...pixelStats(expected, actual), decidingMeasure: "size" },
    };
  }

  const stats = pixelStats(expected, actual);
  if (stats.changedPixels === 0) {
    return {
      verdict: "identical",
      reasons: ["no pixel differs"],
      metrics: { ...stats, decidingMeasure: "pixels" },
    };
  }

  // The measure nearest its limit, or furthest past it, decides and is reported first. Every
  // measure gets a line that starts "<id> <value>", which the calibration table reads back.
  const measured = INK_MEASURES.map((m) => ({ m, ...m.measure(expected, actual) }))
    .sort((p, q) => q.value / q.m.limit - p.value / p.m.limit);
  const lines = measured.map(({ m, value, x, y }) => {
    const over = value > m.limit;
    const line = `${m.id} ${value.toFixed(4)} ${over ? ">" : "<="} ${m.limit}`;
    return over ? `${line} at (${x},${y}): ${m.meaning}` : `${line} at (${x},${y})`;
  });
  const decider = measured[0]!;

  if (decider.value > decider.m.limit) {
    return {
      verdict: "content",
      reasons: lines,
      metrics: { ...stats, decidingMeasure: decider.m.id },
    };
  }
  return {
    verdict: "renderer-only",
    reasons: [RENDERER_ONLY, ...lines],
    metrics: { ...stats, decidingMeasure: decider.m.id },
  };
}

/**
 * Re-rasterising moves ink by a fraction of a pixel, among pixels that already had ink, and
 * keeps its colour; each measure sees a different way of breaking that.
 */
const RENDERER_ONLY =
  "every change is re-rasterising: no ink moved a whole pixel, landed on bare paper or changed tone";

/**
 * Counts over the region both images share. A pixel is changed when any RGBA channel differs;
 * its delta is the largest channel difference, and `meanDelta` averages that over changed
 * pixels only.
 */
type PixelStats = Omit<DiffVerdict["metrics"], "decidingMeasure">;

function pixelStats(expected: RawImage, actual: RawImage): PixelStats {
  const w = Math.min(expected.width, actual.width);
  const h = Math.min(expected.height, actual.height);
  let changedPixels = 0;
  let maxDelta = 0;
  let deltaSum = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = (y * expected.width + x) * 4;
      const a = (y * actual.width + x) * 4;
      let delta = 0;
      for (let c = 0; c < 4; c++) {
        const d = Math.abs(expected.data[e + c]! - actual.data[a + c]!);
        if (d > delta) delta = d;
      }
      if (delta === 0) continue;
      changedPixels++;
      deltaSum += delta;
      if (delta > maxDelta) maxDelta = delta;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return {
    changedPixels,
    changedFraction: w * h === 0 ? 0 : changedPixels / (w * h),
    maxDelta,
    meanDelta: changedPixels === 0 ? 0 : deltaSum / changedPixels,
    bbox: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
  };
}

/** Refuses an image whose buffer does not hold exactly width x height RGBA pixels. */
function checkImage(img: RawImage, label: string): void {
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`${label}: width and height must be positive integers, got ${width}x${height}`);
  }
  if (data.length !== width * height * 4) {
    throw new Error(
      `${label}: ${data.length} bytes is not ${width}x${height} RGBA (${width * height * 4} bytes)`,
    );
  }
}
