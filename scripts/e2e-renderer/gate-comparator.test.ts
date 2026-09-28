import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { loadGateComparator } from "./gate-comparator";

/** A flat 8x8 grey square, with one pixel `delta` levels brighter when asked. */
async function square(grey: number, delta = 0): Promise<Buffer> {
  const data = Buffer.alloc(8 * 8 * 4, 255);
  for (let i = 0; i < 64; i++) data.fill(grey, i * 4, i * 4 + 3);
  data.fill(grey + delta, 27 * 4, 27 * 4 + 3);
  return sharp(data, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
}

describe("loadGateComparator", () => {
  const gate = loadGateComparator({ maxDiffPixels: 0 });
  const strict = loadGateComparator({ maxDiffPixels: 0, threshold: 0 });

  test("finds Playwright's own comparator in the installed version", () => {
    expect(gate).toHaveProperty("fails");
    expect(strict).toHaveProperty("fails");
  });

  test("identical images pass, whatever the threshold", async () => {
    const a = await square(40);
    if (!("fails" in gate) || !("fails" in strict)) throw new Error("no comparator");
    expect(gate.fails(a, await square(40))).toBe(false);
    expect(strict.fails(a, await square(40))).toBe(false);
  });

  /**
   * Why a re-base can move more files than the gate failed: at maxDiffPixels 0 the gate still
   * passes a pixel 30 grey levels off, because Playwright's default threshold is 0.2 in YIQ.
   */
  test("at maxDiffPixels 0 the gate passes a 30-level change, fails a 100-level one", async () => {
    if (!("fails" in gate) || !("fails" in strict)) throw new Error("no comparator");
    const base = await square(40);
    expect(gate.fails(base, await square(40, 30))).toBe(false);
    expect(strict.fails(base, await square(40, 30))).toBe(true);
    expect(gate.fails(base, await square(40, 100))).toBe(true);
  });
});
