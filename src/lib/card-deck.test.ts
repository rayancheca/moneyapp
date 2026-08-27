import { describe, expect, test } from "vitest";
import {
  COMMIT_FRACTION,
  FLING_VELOCITY,
  LAYER_OFFSET_PX,
  MAX_TILT_DEGREES,
  VISIBLE_DEPTH,
  clampIndex,
  deckDepth,
  deckSlot,
  dragOutcome,
  dragTilt,
  stepIndex,
} from "./card-deck";

describe("where each card sits in the stack", () => {
  test("the active card is at the front, undimmed and unmoved", () => {
    const slot = deckSlot(3, 3, 12);
    expect(slot).toMatchObject({ depth: 0, translateY: 0, scale: 1, opacity: 1, parked: false });
  });

  test("depth grows FORWARD around the ring, never backwards", () => {
    // the card you are about to see next is the one directly behind the front;
    // a signed distance would put half the deck at negative depth and paint it
    // in front of the card being read
    expect(deckDepth(4, 3, 12)).toBe(1);
    expect(deckDepth(2, 3, 12)).toBe(11);
    expect(deckDepth(0, 11, 12)).toBe(1);
    expect(deckDepth(3, 3, 12)).toBe(0);
  });

  test("each layer steps down, shrinks and fades", () => {
    const front = deckSlot(0, 0, 5);
    const second = deckSlot(1, 0, 5);
    const third = deckSlot(2, 0, 5);
    expect(second.translateY).toBe(LAYER_OFFSET_PX);
    expect(third.translateY).toBe(LAYER_OFFSET_PX * 2);
    expect(second.scale).toBeLessThan(front.scale);
    expect(third.scale).toBeLessThan(second.scale);
    expect(second.opacity).toBeLessThan(front.opacity);
  });

  test("the front card always paints above the rest", () => {
    const z = [0, 1, 2, 3].map((i) => deckSlot(i, 0, 4).zIndex);
    expect(z[0]).toBeGreaterThan(z[1]!);
    expect(z[1]).toBeGreaterThan(z[2]!);
    expect(z[2]).toBeGreaterThan(z[3]!);
  });

  test("cards past the visible depth are parked, not unmounted", () => {
    /*
     * ⛔ Parked means transparent and pushed down — never `display: none`. A
     * hidden card is gone from the accessibility tree and from anything that
     * reads the page's text, and the stack is a PRESENTATION of twelve cards,
     * not a filter that leaves eleven of them out of the document.
     */
    expect(deckSlot(VISIBLE_DEPTH, 0, 12).parked).toBe(false);
    expect(deckSlot(VISIBLE_DEPTH + 1, 0, 12).parked).toBe(true);
    expect(deckSlot(VISIBLE_DEPTH + 1, 0, 12).opacity).toBe(0);
  });

  test("a parked card stops sinking further, however deep the deck", () => {
    // otherwise a hundred-card deck would translate the last one 1,600px down
    // and stretch the page it was built to shorten
    const near = deckSlot(VISIBLE_DEPTH + 1, 0, 100);
    const far = deckSlot(80, 0, 100);
    expect(far.translateY).toBe(near.translateY);
  });

  test("a deck of one is just a card", () => {
    expect(deckSlot(0, 0, 1)).toMatchObject({ depth: 0, opacity: 1, parked: false });
    expect(deckDepth(0, 0, 0)).toBe(0);
  });
});

describe("stepping", () => {
  test("wraps in both directions", () => {
    expect(stepIndex(11, 12, 1)).toBe(0);
    expect(stepIndex(0, 12, -1)).toBe(11);
    expect(stepIndex(5, 12, 1)).toBe(6);
    expect(stepIndex(5, 12, -1)).toBe(4);
  });

  test("an empty deck cannot be stepped off the end", () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
  });

  test("clamps a stale index into the deck", () => {
    // a shared URL from when the deck had twelve cards, opened when it has four
    expect(clampIndex(9, 4)).toBe(3);
    expect(clampIndex(-2, 4)).toBe(0);
    expect(clampIndex(Number.NaN, 4)).toBe(0);
    expect(clampIndex(2.7, 4)).toBe(2);
  });
});

describe("what releasing a drag does", () => {
  const W = 800;

  test("⚠️ dragging LEFT advances", () => {
    // the direction a page of text moves when you go forward. Backwards here is
    // the single most common way a carousel feels wrong, and it is invisible in
    // a screenshot
    expect(dragOutcome(-W * COMMIT_FRACTION, W, 0)).toBe("next");
    expect(dragOutcome(W * COMMIT_FRACTION, W, 0)).toBe("previous");
  });

  test("a short drag snaps back", () => {
    expect(dragOutcome(-40, W, 0)).toBe("stay");
    expect(dragOutcome(40, W, 0)).toBe("stay");
    expect(dragOutcome(0, W, 0)).toBe("stay");
  });

  test("a fast flick counts even when it barely moved", () => {
    // a distance threshold alone always gets this half of the feel wrong
    expect(dragOutcome(-12, W, -FLING_VELOCITY)).toBe("next");
    expect(dragOutcome(12, W, FLING_VELOCITY)).toBe("previous");
  });

  test("⛔ a flick that reverses at the end goes where the LAST motion pointed", () => {
    /*
     * Net distance says the card travelled right; the velocity says the hand
     * was moving left when it let go. The intent is the last motion — honouring
     * the distance makes a flick-back advance the wrong way.
     */
    expect(dragOutcome(60, W, -FLING_VELOCITY * 2)).toBe("next");
    expect(dragOutcome(-60, W, FLING_VELOCITY * 2)).toBe("previous");
  });

  test("a deck with no width cannot be dragged", () => {
    // it has not been measured yet; acting on a fraction of zero would flip the
    // card on the first pixel of movement
    expect(dragOutcome(-500, 0, -1)).toBe("stay");
  });
});

describe("the tilt", () => {
  test("pivots with the drag and is capped", () => {
    expect(dragTilt(0, 800)).toBe(0);
    expect(dragTilt(800, 800)).toBe(MAX_TILT_DEGREES);
    expect(dragTilt(-800, 800)).toBe(-MAX_TILT_DEGREES);
    // a drag past the deck's own width does not keep spinning it
    expect(dragTilt(4000, 800)).toBe(MAX_TILT_DEGREES);
    expect(dragTilt(400, 800)).toBeCloseTo(MAX_TILT_DEGREES / 2);
  });

  test("an unmeasured deck does not tilt", () => {
    expect(dragTilt(100, 0)).toBe(0);
  });
});
