/**
 * Crop a Playwright visual diff to the region that actually changed.
 *
 * A full-page baseline is mostly unchanged pixels, so opening the raw `-diff.png`
 * tells you almost nothing — the changed region can be 96x201 inside 1440x1173.
 * This finds the bounding box of the red pixels Playwright paints over the
 * difference and writes cropped `expected` and `actual` pairs beside each other,
 * which is what makes a stale baseline explainable instead of merely red.
 *
 * ⛔ EXPLAIN A DIFF BEFORE REGENERATING IT. Regenerating a baseline you cannot
 * account for converts a bug report into a bug (pass 45). Every one of the 23
 * baselines regenerated in this pass was first cropped and read: a `Categories`
 * item added to the sidebar, a `Duplicates` filter tab on /transactions, and the
 * dashboard's committed-bills figure moving when recurring absorption shipped.
 *
 *   node scripts/crop-visual-diff.mjs test-results/<dir> <baseline-name>
 *
 * Writes /tmp/crop-<name>-expected.png and /tmp/crop-<name>-actual.png.
 * ⚠️ `sharp` is a transitive dependency here, not a direct one, so it is resolved
 * from the pnpm store rather than imported by name.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharpDir = fs
  .readdirSync("node_modules/.pnpm")
  .find((d) => d.startsWith("sharp@"));
if (!sharpDir) throw new Error("sharp not found in node_modules/.pnpm — run pnpm install");
const sharp = require(path.resolve("node_modules/.pnpm", sharpDir, "node_modules/sharp"));

const [dir, base] = process.argv.slice(2);
if (!dir || !base) {
  console.error("usage: node scripts/crop-visual-diff.mjs <test-results-dir> <baseline-name>");
  process.exit(1);
}

const { data, info } = await sharp(`${dir}/${base}-diff.png`).raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

let x0 = width, y0 = height, x1 = -1, y1 = -1, changed = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    // Playwright paints differing pixels bright red/magenta over the base image.
    if (data[i] > 180 && data[i + 1] < 110 && data[i + 2] < 130) {
      changed++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
}
if (x1 < 0) {
  console.log(`${base}: no changed pixels found in the diff`);
  process.exit(0);
}

const PAD = 24;
const left = Math.max(0, x0 - PAD);
const top = Math.max(0, y0 - PAD);
const box = {
  left,
  top,
  width: Math.min(width - left, x1 - x0 + 1 + PAD * 2),
  height: Math.min(height - top, y1 - y0 + 1 + PAD * 2),
};
console.log(`${base}: ${changed} changed px · bbox x${x0}-${x1} y${y0}-${y1} (page ${width}x${height})`);

for (const tag of ["expected", "actual"]) {
  const file = `${dir}/${base}-${tag}.png`;
  if (!fs.existsSync(file)) continue;
  const out = `/tmp/crop-${base}-${tag}.png`;
  await sharp(file).extract(box).toFile(out);
  console.log(`  ${out}`);
}
