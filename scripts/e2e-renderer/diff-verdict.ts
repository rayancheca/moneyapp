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
 *   3. otherwise the ink shift (see `ink-shift.ts`) at two scales: above either limit is
 *      content, at or below both is renderer drift.
 *
 * Calibrated on real history, not guesses; `tsx scripts/e2e-renderer/calibrate-diff-verdict.ts`
 * re-runs it and prints the table. Measured 2026-09-28, with `--all`:
 *
 *   renderer   c3b9a59's 111 pairs            111 renderer-only   worst 1.83x under a limit
 *   content    1,023 changed baselines, the   1,023 content       weakest 1.85x over a limit
 *              46 UI commits since 803eeb2    (449 by size)
 *   synthetic  98 edits of real baselines     98 content          weakest 1.82x over a limit
 *
 * The synthetic edits are a 1px shift of text, two digits swapped, faint dark-mode text
 * recoloured, a region erased, a panel tinted and a page one pixel taller — each also judged
 * against the pre-upgrade baseline, the OS drift and the change landing in the same run.
 */
import sharp from "sharp";
import { INK_SCALES, inkShift, type InkScale } from "./ink-shift";

export type RawImage = { width: number; height: number; data: Uint8Array }; // RGBA

/**
 * `decidingMeasure` is "size", "pixels" (identical), or the ink scale furthest past its limit
 * — or, for renderer-only, the one that came closest to it. `reasons` carries one line per
 * ink scale, `<id> <value> <relation> <limit> at (x,y)`.
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
  // scale gets a line that starts "<id> <value>", which the calibration table reads back.
  const measured = INK_SCALES.map((scale) => ({ scale, ...inkShift(expected, actual, scale) }))
    .sort((p, q) => q.value / q.scale.limit - p.value / p.scale.limit);
  const lines = measured.map(({ scale, value, x, y }) => {
    const over = value > scale.limit;
    const line = `${scale.id} ${value.toFixed(4)} ${over ? ">" : "<="} ${scale.limit}`;
    return over ? `${line} at (${x},${y}): ${MEANING[scale.id]}` : `${line} at (${x},${y})`;
  });
  const decider = measured[0]!;

  if (decider.value > decider.scale.limit) {
    return {
      verdict: "content",
      reasons: lines,
      metrics: { ...stats, decidingMeasure: decider.scale.id },
    };
  }
  return {
    verdict: "renderer-only",
    reasons: [RENDERER_ONLY, ...lines],
    metrics: { ...stats, decidingMeasure: decider.scale.id },
  };
}

/**
 * Re-rasterising moves ink by a fraction of a pixel and keeps its amount and colour; each scale
 * sees a different way of breaking that.
 */
const RENDERER_ONLY = "every change is sub-pixel: no ink moved a whole pixel or changed colour";
const MEANING: Record<InkScale["id"], string> = {
  "ink-fine": "ink moved, appeared or vanished here, further than re-rasterising moves it",
  "ink-coarse": "the amount or colour of ink over a word-sized area changed",
};

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
