import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { decodePng, diffVerdict, type RawImage } from "./diff-verdict";

/**
 * Text drawn the way a rasteriser draws it — exact area coverage, blended between ink and
 * paper — so a stem can be moved a fraction of a pixel, which is what an OS upgrade does to
 * every glyph, or a whole pixel, which is what a layout change does. The glyphs are
 * seven-segment digits: enough of a font to change one character for another.
 */
type Rgb = readonly [number, number, number];

interface Theme {
  paper: Rgb;
  ink: Rgb;
  faint: Rgb;
}

interface Bar {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Line {
  text: string;
  x: number;
  y: number;
  ink: Rgb;
}

const LIGHT: Theme = { paper: [254, 254, 252], ink: [31, 26, 19], faint: [109, 104, 97] };
/** The dark theme's surface, --ink and --ink-faint, as the baselines render them. */
const DARK: Theme = { paper: [33, 28, 22], ink: [234, 231, 225], faint: [144, 140, 133] };
const ACCENT: Rgb = [95, 196, 160];

const [WIDTH, HEIGHT] = [120, 60];
const ADVANCE = 8.4;
const SEGMENTS: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
  "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};

function glyph(ch: string, x: number, y: number): Bar[] {
  const [w, h, s] = [6, 10, 1.3];
  const bars: Record<string, Bar> = {
    a: { x0: x, y0: y, x1: x + w, y1: y + s },
    b: { x0: x + w - s, y0: y, x1: x + w, y1: y + h / 2 },
    c: { x0: x + w - s, y0: y + h / 2, x1: x + w, y1: y + h },
    d: { x0: x, y0: y + h - s, x1: x + w, y1: y + h },
    e: { x0: x, y0: y + h / 2, x1: x + s, y1: y + h },
    f: { x0: x, y0: y, x1: x + s, y1: y + h / 2 },
    g: { x0: x, y0: y + (h - s) / 2, x1: x + w, y1: y + (h + s) / 2 },
  };
  return [...(SEGMENTS[ch] ?? "")].map((k) => bars[k]!);
}

/** `nudge` moves every glyph sideways by a fraction of a pixel. */
function render(lines: Line[], paper: Rgb, nudge = 0): RawImage {
  const coverage = new Float64Array(WIDTH * HEIGHT);
  const ink = Array.from({ length: WIDTH * HEIGHT }, () => paper);
  for (const line of lines) {
    for (const [n, ch] of [...line.text].entries()) {
      for (const b of glyph(ch, line.x + n * ADVANCE + nudge, line.y)) {
        for (let y = Math.floor(b.y0); y < Math.ceil(b.y1); y++) {
          for (let x = Math.floor(b.x0); x < Math.ceil(b.x1); x++) {
            const across = Math.min(b.x1, x + 1) - Math.max(b.x0, x);
            const down = Math.min(b.y1, y + 1) - Math.max(b.y0, y);
            coverage[y * WIDTH + x] = coverage[y * WIDTH + x]! + across * down;
            ink[y * WIDTH + x] = line.ink;
          }
        }
      }
    }
  }
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let p = 0; p < WIDTH * HEIGHT; p++) {
    const c = Math.min(1, coverage[p]!);
    const [from, to] = [paper, ink[p]!];
    for (let k = 0; k < 3; k++) data[p * 4 + k] = Math.round(from[k]! + c * (to[k]! - from[k]!));
    data[p * 4 + 3] = 255;
  }
  return { width: WIDTH, height: HEIGHT, data };
}

type Changes = Partial<Record<"top" | "faint", Partial<Line>>>;

function page(theme: Theme, changes: Changes = {}): Line[] {
  return [
    { text: "5070147", x: 10.3, y: 8, ink: theme.ink, ...changes.top },
    { text: "1041290", x: 10.3, y: 26, ink: theme.faint, ...changes.faint },
    { text: "39", x: 90.6, y: 44, ink: theme.ink },
  ];
}

/**
 * What the OS upgrade did, a little past its worst: every glyph re-drawn a quarter of a pixel
 * from where it was. That reads 0.120 on the fine scale and 0.016 on the coarse one; the worst
 * of c3b9a59's 111 real pairs read 0.098 and 0.016.
 */
const RE_RASTERISED = 0.25;

function edit(img: RawImage, change: (data: Uint8Array, k: number, x: number, y: number) => void) {
  const out = { ...img, data: new Uint8Array(img.data) };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) change(out.data, (y * img.width + x) * 4, x, y);
  }
  return out;
}

describe("diffVerdict", () => {
  test("calls two equal images identical, with nothing measured", () => {
    const v = diffVerdict(render(page(LIGHT), LIGHT.paper), render(page(LIGHT), LIGHT.paper));
    expect(v.verdict).toBe("identical");
    expect(v.metrics).toEqual({
      changedPixels: 0,
      changedFraction: 0,
      maxDelta: 0,
      meanDelta: 0,
      bbox: null,
      decidingMeasure: "pixels",
    });
  });

  test.each([
    ["light", LIGHT],
    ["dark", DARK],
  ])("accepts every glyph re-rasterised a fraction of a pixel away (%s)", (_name, theme) => {
    const before = render(page(theme), theme.paper);
    const v = diffVerdict(before, render(page(theme), theme.paper, RE_RASTERISED));
    expect(v.verdict).toBe("renderer-only");
    expect(v.metrics.changedPixels).toBeGreaterThan(50);
    expect(v.reasons[0]).toMatch(/^every change is sub-pixel/);
    // one line per scale, in the "<id> <value>" form the calibration table reads back
    expect(v.reasons.slice(1)).toEqual([
      expect.stringMatching(/^ink-(fine|coarse) 0\.\d{4} <= 0\.\d+ at \(\d+,\d+\)$/),
      expect.stringMatching(/^ink-(fine|coarse) 0\.\d{4} <= 0\.\d+ at \(\d+,\d+\)$/),
    ]);
  });

  test("refuses a line of text moved one whole pixel: a sharp edge moved 1px reads 1/3", () => {
    const before = render(page(LIGHT), LIGHT.paper);
    const v = diffVerdict(before, render(page(LIGHT, { faint: { x: 11.3 } }), LIGHT.paper));
    expect(v.verdict).toBe("content");
    expect(v.reasons).toContainEqual(expect.stringMatching(/^ink-fine 0\.3333 > 0\.18 at /));
  });

  test("refuses one digit changed for another even while every glyph drifts", () => {
    const before = render(page(DARK), DARK.paper);
    const after = render(page(DARK, { faint: { text: "1041280" } }), DARK.paper, RE_RASTERISED);
    expect(diffVerdict(before, after).verdict).toBe("content");
  });

  test("refuses faint dark-mode text recoloured by less than the drift moved any pixel", () => {
    const before = render(page(DARK), DARK.paper);
    const v = diffVerdict(before, render(page(DARK, { faint: { ink: ACCENT } }), DARK.paper));
    // the drift of c3b9a59 moved single pixels by up to 76; this recolour moves none that far
    expect(v.metrics.maxDelta).toBeLessThan(76);
    expect(v.verdict).toBe("content");
    expect(v.metrics.decidingMeasure).toBe("ink-coarse");
  });

  test("refuses a glyph erased", () => {
    const before = render(page(LIGHT), LIGHT.paper);
    const after = render(page(LIGHT, { top: { text: "507014" } }), LIGHT.paper);
    expect(diffVerdict(before, after).verdict).toBe("content");
  });

  test("refuses a flat panel tinted by two levels, where no text is", () => {
    const before = render(page(DARK), DARK.paper);
    const after = edit(before, (d, k, x, y) => {
      if (x >= 60 && x < 80 && y >= 44) for (let c = 0; c < 3; c++) d[k + c] = d[k + c]! + 2;
    });
    const v = diffVerdict(before, after);
    expect(v.verdict).toBe("content");
    expect(v.metrics.decidingMeasure).toBe("ink-coarse");
    expect(v.metrics.bbox).toEqual({ x: 60, y: 44, w: 20, h: 16 });
  });

  test("refuses a change of transparency alone", () => {
    const before = render(page(LIGHT), LIGHT.paper);
    const after = edit(before, (d, k, x, y) => {
      if (x < 30 && y < 30) d[k + 3] = 0;
    });
    expect(diffVerdict(before, after).verdict).toBe("content");
  });

  test("refuses a page one pixel taller, whatever the pixels say", () => {
    const before = render(page(LIGHT), LIGHT.paper);
    const data = new Uint8Array(WIDTH * (HEIGHT + 1) * 4).fill(255);
    data.set(before.data);
    const v = diffVerdict(before, { ...before, height: HEIGHT + 1, data });
    expect(v.verdict).toBe("content");
    expect(v.metrics.decidingMeasure).toBe("size");
    expect(v.reasons[0]).toBe("size changed: 120x60 -> 120x61; a renderer does not resize a page");
    // the overlapping region is identical, so the pixel metrics say so
    expect(v.metrics.changedPixels).toBe(0);
  });

  test("counts changed pixels, their largest and mean channel delta, and their bounds", () => {
    const before = render([], LIGHT.paper);
    const after = edit(before, (d, k, x, y) => {
      if (x === 3 && y === 4) d[k] = d[k]! - 40;
      if (x === 9 && y === 7) d[k + 2] = d[k + 2]! - 10;
    });
    const v = diffVerdict(before, after);
    expect(v.metrics.changedPixels).toBe(2);
    expect(v.metrics.changedFraction).toBeCloseTo(2 / (WIDTH * HEIGHT), 12);
    expect(v.metrics.maxDelta).toBe(40);
    expect(v.metrics.meanDelta).toBe(25);
    expect(v.metrics.bbox).toEqual({ x: 3, y: 4, w: 7, h: 4 });
  });

  test("throws on a buffer that is not width x height RGBA", () => {
    const img = render([], LIGHT.paper);
    const short = { ...img, data: img.data.subarray(4) };
    expect(() => diffVerdict(img, short)).toThrow(/actual: 28796 bytes is not 120x60 RGBA/);
    expect(() => diffVerdict({ ...img, width: 0 }, img)).toThrow(/positive integers/);
  });
});

describe("decodePng", () => {
  test("decodes a PNG's bytes to RGBA, adding an opaque alpha", async () => {
    const rgb = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const png = await sharp(rgb, { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();
    const img = await decodePng(png);
    expect([img.width, img.height]).toEqual([2, 2]);
    expect([...img.data]).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ]);
  });

  test("reads a path as well as bytes, and a greyscale PNG still comes back RGBA", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-verdict-"));
    const file = path.join(dir, "grey.png");
    try {
      const grey = sharp(Buffer.from([0, 128]), { raw: { width: 2, height: 1, channels: 1 } });
      await grey.png().toFile(file);
      expect([...(await decodePng(file)).data]).toEqual([0, 0, 0, 255, 128, 128, 128, 255]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
