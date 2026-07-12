import { describe, expect, test } from "vitest";
import { intensityStep, pnlDirection } from "./pnl-intensity";

describe("pnlDirection", () => {
  test("classifies sign", () => {
    expect(pnlDirection(120)).toBe("up");
    expect(pnlDirection(-3)).toBe("down");
    expect(pnlDirection(0)).toBe("flat");
  });
});

describe("intensityStep", () => {
  test("a zero-magnitude day is step 0", () => {
    expect(intensityStep(0, 10_000)).toBe(0);
  });

  test("buckets magnitude against the month scale into 1..4", () => {
    // scale 1000: quarters map to ceil(ratio*4)
    expect(intensityStep(1, 1_000)).toBe(1); // tiny → 1
    expect(intensityStep(250, 1_000)).toBe(1);
    expect(intensityStep(260, 1_000)).toBe(2);
    expect(intensityStep(500, 1_000)).toBe(2);
    expect(intensityStep(510, 1_000)).toBe(3);
    expect(intensityStep(750, 1_000)).toBe(3);
    expect(intensityStep(760, 1_000)).toBe(4);
    expect(intensityStep(1_000, 1_000)).toBe(4);
  });

  test("magnitude above the scale clamps to the top step", () => {
    expect(intensityStep(5_000, 1_000)).toBe(4);
  });

  test("uses absolute magnitude so losses bucket like gains", () => {
    expect(intensityStep(-1_000, 1_000)).toBe(4);
  });

  test("a month with no movement collapses any non-zero day to step 1", () => {
    expect(intensityStep(500, 0)).toBe(1);
    expect(intensityStep(500, -5)).toBe(1);
  });
});
