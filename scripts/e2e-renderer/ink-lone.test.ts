import { describe, expect, test } from "vitest";
import type { RawImage } from "./diff-verdict";
import { inkLone, LONE_LIMIT } from "./ink-lone";

const PAPER = 250;
const INK = 20;

function paper(width = 24, height = 24, level = PAPER): RawImage {
  const data = new Uint8Array(width * height * 4).fill(level);
  for (let k = 3; k < data.length; k += 4) data[k] = 255;
  return { width, height, data };
}

/** Ink laid on a pixel: `cover` of the way from the paper to the ink, in every channel. */
function ink(img: RawImage, x: number, y: number, cover: number): void {
  const k = (y * img.width + x) * 4;
  const level = Math.round(PAPER + cover * (INK - PAPER));
  img.data.fill(level, k, k + 3);
}

/** A stem 1px wide from y0 to y1, its coverage split between two columns by `phase`. */
function stem(img: RawImage, x: number, phase: number, y0 = 4, y1 = 20): void {
  for (let y = y0; y < y1; y++) {
    ink(img, x, y, 1 - phase);
    if (phase > 0) ink(img, x + 1, y, phase);
  }
}

describe("inkLone", () => {
  test("reads ink drawn on bare paper, in px² of full-contrast ink", () => {
    const before = paper();
    const after = paper();
    ink(after, 12, 12, 1);
    ink(after, 13, 12, 0.5);
    const v = inkLone(before, after);
    expect(v.value).toBeCloseTo(1.5, 2);
    expect(v.value).toBeGreaterThan(LONE_LIMIT);
    // the centre of a 3x3 box holding both pixels
    expect(Math.abs(v.x - 12.5)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(v.y - 12)).toBeLessThanOrEqual(1);
  });

  test("reads ink taken off bare paper the same way", () => {
    const before = paper();
    ink(before, 12, 12, 1);
    expect(inkLone(before, paper()).value).toBeCloseTo(1, 2);
  });

  test("reads a comma's tail but not its head: the tail hangs where a period leaves paper", () => {
    const period = paper();
    for (const [x, y] of [
      [10, 10],
      [11, 10],
      [10, 11],
      [11, 11],
    ] as const) {
      ink(period, x, y, 1);
    }
    const comma: RawImage = { ...period, data: new Uint8Array(period.data) };
    ink(comma, 11, 12, 0.6); // beside the dot: another pixel of the glyph's edge
    ink(comma, 10, 13, 0.5); // a pixel below it: nothing of the period within a pixel
    const v = inkLone(period, comma);
    expect(v.value).toBeCloseTo(0.5, 2);
  });

  test("reads nothing for a stem moved a fraction of a pixel, or a whole one", () => {
    const before = paper();
    stem(before, 8, 0.25);
    for (const [x, phase] of [
      [8, 0.6],
      [9, 0.25],
    ] as const) {
      const after = paper();
      stem(after, x, phase);
      expect(inkLone(before, after).value).toBe(0);
    }
  });

  test("reads nothing for a flat area re-drawn a level or two away, as dithering or grain would", () => {
    expect(inkLone(paper(), paper(24, 24, PAPER - 2)).value).toBe(0);
  });

  test("reads nothing for two equal images", () => {
    expect(inkLone(paper(), paper())).toEqual({ value: 0, x: 0, y: 0 });
  });
});
