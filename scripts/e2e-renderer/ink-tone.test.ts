import { describe, expect, test } from "vitest";
import type { RawImage } from "./diff-verdict";
import { inkTone, TONE_LIMIT, TONE_MIN_SOLID } from "./ink-tone";

const PAPER = 250;
const INK = 20;

function paper(width = 40, height = 24): RawImage {
  const data = new Uint8Array(width * height * 4).fill(PAPER);
  for (let k = 3; k < data.length; k += 4) data[k] = 255;
  return { width, height, data };
}

/** `cover` of the way from the paper to `ink`, in every channel. */
function ink(img: RawImage, x: number, y: number, cover: number, level = INK): void {
  const k = (y * img.width + x) * 4;
  img.data.fill(Math.round(PAPER + cover * (level - PAPER)), k, k + 3);
}

/** A word: `n` stems 2px wide and 12px tall, 2px apart, drawn in `level`. */
function word(img: RawImage, n: number, level = INK, x0 = 6): void {
  for (let s = 0; s < n; s++) {
    for (let y = 6; y < 18; y++) {
      ink(img, x0 + 4 * s, y, 1, level);
      ink(img, x0 + 4 * s + 1, y, 1, level);
    }
  }
}

/** A "+" of 2px strokes, 10px across; `crossing` is the ink left where the strokes overlap. */
function plus(img: RawImage, crossing = 1): void {
  for (let t = 0; t < 10; t++) {
    for (const d of [0, 1]) {
      ink(img, 10 + t, 11 + d, 1);
      ink(img, 14 + d, 7 + t, 1);
    }
  }
  for (const [x, y] of [
    [14, 11],
    [15, 11],
    [14, 12],
    [15, 12],
  ] as const) {
    ink(img, x, y, crossing);
  }
}

describe("inkTone", () => {
  test("reads a word dimmed by a tenth as all of it moved together", () => {
    const before = paper();
    const after = paper();
    word(before, 4);
    word(after, 4, Math.round(INK + 0.1 * (PAPER - INK)));
    const v = inkTone(before, after);
    expect(v.value).toBe(1);
    expect(v.value).toBeGreaterThan(TONE_LIMIT);
  });

  test("reads a word given another colour as all of it moved together", () => {
    const before = paper();
    const after = paper();
    word(before, 4, 110);
    word(after, 4, 94);
    expect(inkTone(before, after).value).toBe(1);
  });

  test("reads a crossing re-shaded by re-rasterising as the few pixels it is", () => {
    const before = paper();
    const after = paper();
    plus(before);
    plus(after, 0.8);
    const v = inkTone(before, after);
    // four of the "+"'s 36 solid pixels
    expect(v.value).toBeCloseTo(4 / 36, 6);
    expect(v.value).toBeLessThan(TONE_LIMIT);
  });

  test("reads a thin stem that lands on one pixel instead of two as ink passed along, not re-toned", () => {
    const before = paper();
    const after = paper();
    for (const [img, cover] of [
      [before, [0.66, 0.25]],
      [after, [0.91, 0]],
    ] as const) {
      for (let s = 0; s < 5; s++) {
        for (let y = 6; y < 18; y++) {
          ink(img, 6 + 3 * s, y, cover[0]);
          ink(img, 7 + 3 * s, y, cover[1]);
        }
      }
    }
    expect(inkTone(before, after).value).toBe(0);
  });

  test(`judges no word with fewer than ${TONE_MIN_SOLID} solid pixels`, () => {
    const before = paper();
    const after = paper();
    for (const [img, level] of [
      [before, INK],
      [after, 120],
    ] as const) {
      for (const [x, y] of [
        [10, 10],
        [11, 10],
        [10, 11],
      ] as const) {
        ink(img, x, y, 1, level);
      }
    }
    expect(inkTone(before, after).value).toBe(0);
  });

  test("reads nothing for a flat panel tinted, where there is no ink: ink-coarse is for that", () => {
    const before = paper();
    const after = paper();
    after.data.fill(PAPER - 6);
    for (let k = 3; k < after.data.length; k += 4) after.data[k] = 255;
    expect(inkTone(before, after).value).toBe(0);
  });
});
