import { describe, expect, test } from "vitest";
import { sparklineGeometry } from "./sparkline";

describe("sparklineGeometry", () => {
  test("returns null for fewer than 2 points", () => {
    expect(sparklineGeometry([], 100, 32)).toBeNull();
    expect(sparklineGeometry([5], 100, 32)).toBeNull();
  });

  test("maps min to the bottom and max to the top inside padding", () => {
    // Arrange: strictly rising series in a 100×32 box, pad 2
    const geo = sparklineGeometry([0, 50, 100], 100, 32, 2);

    // Assert: first point at (2, 30) — min at bottom; last at (98, 2) — max at top
    expect(geo).not.toBeNull();
    expect(geo!.linePath).toBe("M2,30L50,16L98,2");
    expect(geo!.lastX).toBe(98);
    expect(geo!.lastY).toBe(2);
  });

  test("flat series draws a horizontal midline (no divide-by-zero)", () => {
    const geo = sparklineGeometry([7, 7, 7], 100, 32, 2);
    expect(geo!.linePath).toBe("M2,16L50,16L98,16");
    expect(geo!.lastY).toBe(16);
  });

  test("area path closes down to the baseline and back to the start", () => {
    const geo = sparklineGeometry([0, 100], 100, 32, 2);
    expect(geo!.areaPath).toBe("M2,30L98,2L98,30L2,30Z");
  });

  test("negative values map correctly (liability balances)", () => {
    const geo = sparklineGeometry([-100, -50], 100, 32, 2);
    // -100 is the min (bottom), -50 the max (top)
    expect(geo!.linePath).toBe("M2,30L98,2");
  });

  test("coordinates are rounded to two decimals", () => {
    const geo = sparklineGeometry([0, 1, 3], 90, 30, 2);
    for (const match of geo!.linePath.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const decimals = match[0].split(".")[1] ?? "";
      expect(decimals.length).toBeLessThanOrEqual(2);
    }
  });
});
