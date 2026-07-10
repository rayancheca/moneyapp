import { describe, expect, test } from "vitest";
import { computePosition, type Rect, type Size } from "./positioning";

// Anchor sits comfortably mid-viewport: every side fits, nothing clamps.
const VIEWPORT: Size = { width: 800, height: 600 };
const ANCHOR: Rect = { x: 100, y: 100, width: 50, height: 20 };
const FLOATING: Size = { width: 40, height: 30 };

describe("computePosition — sides with default offset and center alignment", () => {
  test("bottom places below the anchor, horizontally centered", () => {
    // Arrange / Act
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "bottom" });

    // Assert: y = 100 + 20 + 6, x = 100 + 25 − 20
    expect(result).toEqual({ x: 105, y: 126, placement: "bottom" });
  });

  test("top places above the anchor, horizontally centered", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "top" });

    // y = 100 − 6 − 30
    expect(result).toEqual({ x: 105, y: 64, placement: "top" });
  });

  test("left places before the anchor, vertically centered", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "left" });

    // x = 100 − 6 − 40, y = 100 + 10 − 15
    expect(result).toEqual({ x: 54, y: 95, placement: "left" });
  });

  test("right places after the anchor, vertically centered", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "right" });

    // x = 100 + 50 + 6
    expect(result).toEqual({ x: 156, y: 95, placement: "right" });
  });
});

describe("computePosition — alignments", () => {
  test("bottom-start aligns leading edges on the horizontal axis", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "bottom-start" });

    expect(result).toEqual({ x: 100, y: 126, placement: "bottom-start" });
  });

  test("bottom-center matches the implicit center alignment but echoes the suffix", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "bottom-center" });

    expect(result).toEqual({ x: 105, y: 126, placement: "bottom-center" });
  });

  test("bottom-end aligns trailing edges on the horizontal axis", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "bottom-end" });

    // x = 100 + 50 − 40
    expect(result).toEqual({ x: 110, y: 126, placement: "bottom-end" });
  });

  test("right-start aligns leading edges on the vertical axis", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "right-start" });

    expect(result).toEqual({ x: 156, y: 100, placement: "right-start" });
  });

  test("right-end aligns trailing edges on the vertical axis", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, { placement: "right-end" });

    // y = 100 + 20 − 30
    expect(result).toEqual({ x: 156, y: 90, placement: "right-end" });
  });
});

describe("computePosition — flipping", () => {
  test("flips bottom to top when there is no room below", () => {
    // Arrange: anchor near the bottom edge — below needs 616 > 592 available
    const anchor: Rect = { x: 100, y: 560, width: 50, height: 20 };

    const result = computePosition(anchor, FLOATING, VIEWPORT, { placement: "bottom" });

    // y = 560 − 6 − 30
    expect(result).toEqual({ x: 105, y: 524, placement: "top" });
  });

  test("flips top to bottom and preserves the alignment suffix", () => {
    const anchor: Rect = { x: 100, y: 10, width: 50, height: 20 };

    const result = computePosition(anchor, FLOATING, VIEWPORT, { placement: "top-start" });

    // y = 10 + 20 + 6
    expect(result).toEqual({ x: 100, y: 36, placement: "bottom-start" });
  });

  test("flips left to right when there is no room before the anchor", () => {
    const anchor: Rect = { x: 10, y: 100, width: 50, height: 20 };

    const result = computePosition(anchor, FLOATING, VIEWPORT, { placement: "left" });

    // x = 10 + 50 + 6
    expect(result).toEqual({ x: 66, y: 95, placement: "right" });
  });

  test("flips right to left when there is no room after the anchor", () => {
    const anchor: Rect = { x: 750, y: 100, width: 50, height: 20 };

    const result = computePosition(anchor, FLOATING, VIEWPORT, { placement: "right" });

    // x = 750 − 6 − 40
    expect(result).toEqual({ x: 704, y: 95, placement: "left" });
  });

  test("keeps the preferred side when neither side fits, then clamps", () => {
    // Arrange: floating element larger than the padded viewport on both axes
    const viewport: Size = { width: 100, height: 100 };
    const anchor: Rect = { x: 40, y: 40, width: 20, height: 20 };
    const floating: Size = { width: 90, height: 90 };

    const result = computePosition(anchor, floating, viewport, { placement: "bottom" });

    // near-edge padding wins on both axes
    expect(result).toEqual({ x: 8, y: 8, placement: "bottom" });
  });
});

describe("computePosition — viewport clamping", () => {
  test("clamps x so the floating element stays inside the right edge", () => {
    const anchor: Rect = { x: 760, y: 100, width: 30, height: 20 };
    const floating: Size = { width: 100, height: 30 };

    const result = computePosition(anchor, floating, VIEWPORT, { placement: "bottom" });

    // raw x = 725 → clamped to 800 − 100 − 8
    expect(result).toEqual({ x: 692, y: 126, placement: "bottom" });
  });

  test("clamps x up to the left padding", () => {
    const anchor: Rect = { x: 0, y: 100, width: 10, height: 20 };
    const floating: Size = { width: 100, height: 30 };

    const result = computePosition(anchor, floating, VIEWPORT, { placement: "bottom" });

    // raw x = −45 → clamped to padding
    expect(result).toEqual({ x: 8, y: 126, placement: "bottom" });
  });

  test("clamps y down to the top padding", () => {
    const anchor: Rect = { x: 100, y: 0, width: 50, height: 10 };
    const floating: Size = { width: 40, height: 80 };

    const result = computePosition(anchor, floating, VIEWPORT, { placement: "right" });

    // raw y = −35 → clamped to padding
    expect(result).toEqual({ x: 156, y: 8, placement: "right" });
  });

  test("clamps y so the floating element stays inside the bottom edge", () => {
    const anchor: Rect = { x: 100, y: 590, width: 50, height: 10 };
    const floating: Size = { width: 40, height: 80 };

    const result = computePosition(anchor, floating, VIEWPORT, { placement: "right" });

    // raw y = 555 → clamped to 600 − 80 − 8
    expect(result).toEqual({ x: 156, y: 512, placement: "right" });
  });
});

describe("computePosition — option overrides", () => {
  test("applies a custom offset instead of the 6px default", () => {
    const result = computePosition(ANCHOR, FLOATING, VIEWPORT, {
      placement: "bottom",
      offset: 12,
    });

    // y = 100 + 20 + 12
    expect(result).toEqual({ x: 105, y: 132, placement: "bottom" });
  });

  test("applies a custom padding instead of the 8px default when clamping", () => {
    const anchor: Rect = { x: 0, y: 100, width: 10, height: 20 };
    const floating: Size = { width: 100, height: 30 };

    const result = computePosition(anchor, floating, VIEWPORT, {
      placement: "bottom",
      padding: 20,
    });

    expect(result).toEqual({ x: 20, y: 126, placement: "bottom" });
  });
});
