import { describe, expect, test } from "vitest";

import { computeDeviationLayout, deviationDescription, type DeviationInput } from "./deviation-layout";

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
const OPTS = { width: 600 };

function row(key: string, currentCents: number, previousCents: number): DeviationInput {
  return { key, label: key.toUpperCase(), currentCents, previousCents };
}

describe("ranking", () => {
  test("orders by the SIZE of the move, not by the amount spent", () => {
    const layout = computeDeviationLayout(
      [
        row("big-spend-tiny-move", 900_00, 895_00), // huge category, $5 move
        row("small-spend-big-move", 40_00, 5_00), // small category, $35 move
      ],
      OPTS,
    );
    expect(layout.bars.map((b) => b.key)).toEqual(["small-spend-big-move", "big-spend-tiny-move"]);
  });

  test("a category that did not move at all is omitted", () => {
    const layout = computeDeviationLayout([row("flat", 50_00, 50_00), row("moved", 60_00, 50_00)], OPTS);
    expect(layout.bars.map((b) => b.key)).toEqual(["moved"]);
  });

  test("ties break by label so the order is total", () => {
    const layout = computeDeviationLayout([row("zeta", 20_00, 10_00), row("alpha", 20_00, 10_00)], OPTS);
    expect(layout.bars.map((b) => b.key)).toEqual(["alpha", "zeta"]);
  });

  test("the limit caps the rows drawn", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`c${i}`, (i + 1) * 100, 0));
    expect(computeDeviationLayout(rows, { ...OPTS, limit: 5 }).bars).toHaveLength(5);
  });
});

describe("the rule is zero, and sides mean direction", () => {
  test("spending MORE grows right from the rule", () => {
    const layout = computeDeviationLayout([row("up", 80_00, 50_00)], OPTS);
    const bar = layout.bars[0]!;
    expect(bar.isIncrease).toBe(true);
    expect(bar.x).toBe(layout.centreX);
    expect(bar.width).toBeGreaterThan(0);
  });

  test("spending LESS grows left from the rule", () => {
    const layout = computeDeviationLayout([row("down", 20_00, 50_00)], OPTS);
    const bar = layout.bars[0]!;
    expect(bar.isIncrease).toBe(false);
    expect(bar.x + bar.width).toBeCloseTo(layout.centreX, 1);
    expect(bar.x).toBeLessThan(layout.centreX);
  });

  test("both sides get the same scale, so a rise and an equal fall are equal bars", () => {
    const layout = computeDeviationLayout([row("up", 80_00, 50_00), row("down", 20_00, 50_00)], OPTS);
    const [a, b] = layout.bars;
    expect(a!.width).toBe(b!.width);
  });

  test("no bar ever crosses the rule", () => {
    const layout = computeDeviationLayout(
      [row("up", 90_00, 10_00), row("down", 10_00, 90_00), row("small", 11_00, 10_00)],
      OPTS,
    );
    for (const b of layout.bars) {
      if (b.isIncrease) expect(b.x).toBeGreaterThanOrEqual(layout.centreX);
      else expect(b.x + b.width).toBeLessThanOrEqual(layout.centreX + 0.01);
    }
  });

  test("every bar stays inside the canvas", () => {
    const layout = computeDeviationLayout(
      [row("up", 900_00, 0), row("down", 0, 900_00)],
      { width: 320 },
    );
    for (const b of layout.bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(320);
    }
  });
});

describe("scale", () => {
  test("the biggest move sets the scale and fills its half", () => {
    const layout = computeDeviationLayout([row("a", 100_00, 0), row("b", 50_00, 0)], OPTS);
    const half = (600 - layout.labelWidth - 92) / 2;
    expect(layout.bars[0]!.width).toBeCloseTo(half, 1);
    expect(layout.bars[1]!.width).toBeCloseTo(half / 2, 1);
  });

  test("linear, not sqrt: twice the move is twice the bar", () => {
    const layout = computeDeviationLayout([row("a", 40_00, 0), row("b", 20_00, 0)], OPTS);
    expect(layout.bars[0]!.width / layout.bars[1]!.width).toBeCloseTo(2, 2);
  });

  test("a tiny move is still visible", () => {
    const layout = computeDeviationLayout([row("huge", 10_000_00, 0), row("tiny", 1, 0)], OPTS);
    expect(layout.bars[1]!.width).toBeGreaterThan(0);
  });
});

describe("ratios", () => {
  test("a category with no previous spend has no ratio, rather than a fake infinity", () => {
    const layout = computeDeviationLayout([row("new", 50_00, 0)], OPTS);
    expect(layout.bars[0]!.deltaRatio).toBeNull();
  });

  test("an ordinary move reports its share of the previous period", () => {
    const layout = computeDeviationLayout([row("c", 150_00, 100_00)], OPTS);
    expect(layout.bars[0]!.deltaRatio).toBeCloseTo(0.5, 2);
  });
});

describe("degenerate states", () => {
  test("no rows", () => {
    const layout = computeDeviationLayout([], OPTS);
    expect(layout.bars).toEqual([]);
    expect(layout.height).toBe(0);
    expect(layout.peakCents).toBe(0);
  });

  test("every row flat", () => {
    expect(computeDeviationLayout([row("a", 10_00, 10_00)], OPTS).bars).toEqual([]);
  });

  test("determinism", () => {
    const rows = [row("a", 10_00, 5_00), row("b", 1_00, 9_00)];
    expect(computeDeviationLayout(rows, OPTS)).toEqual(computeDeviationLayout(rows, OPTS));
  });
});

describe("deviationDescription", () => {
  test("counts both directions and names the largest move", () => {
    const layout = computeDeviationLayout(
      [row("rent", 200_00, 100_00), row("food", 10_00, 40_00)],
      OPTS,
    );
    const desc = deviationDescription(layout, fmt);
    expect(desc).toContain("2 categories moved");
    expect(desc).toContain("1 up, 1 down");
    expect(desc).toContain("RENT");
    expect(desc).toContain("$100.00");
  });

  test("the empty state is a sentence", () => {
    expect(deviationDescription(computeDeviationLayout([], OPTS), fmt)).toBe(
      "Nothing changed against the previous period.",
    );
  });

  /**
   * The sentence says "down" when the biggest mover fell. The test above has a
   * decrease in it, but the LARGEST move there is the increase, so the "down"
   * wording of `biggest` was never produced — a screen-reader user hearing this
   * summary on a month where the headline was a big cut would have been told it
   * went "up". Ordering matters here: FOOD's $300 drop has to outrank RENT's $100
   * rise for `bars[0]` to be the decrease.
   */
  test("names the largest move as down when the biggest mover fell", () => {
    const layout = computeDeviationLayout(
      [row("rent", 200_00, 100_00), row("food", 10_00, 310_00)],
      OPTS,
    );
    expect(layout.bars[0]!.key).toBe("food"); // guards the premise
    const desc = deviationDescription(layout, fmt);
    expect(desc).toContain("FOOD, down $300.00");
    expect(desc).not.toContain("FOOD, up");
  });
});

/*
 * ⛔ `bars.length` IS WHAT WAS DRAWN. Counting the drawn bars and calling them
 * the categories that moved is the defect this session kept finding: a count
 * taken from one collection standing over another.
 *
 * 🔴 Measured on the real ledger, `/spending?period=2026` against 2025: the
 * caption read "8 up · 0 down" and the accessible description read "8
 * categories moved against the previous period: 8 up, 0 down" — while TWENTY
 * moved, fifteen up and FIVE down. Every one of the five falls was outside the
 * eight biggest moves, so a spending card said nothing had fallen in a year
 * when five things had.
 */
describe("the counts are of what moved, not of what was drawn", () => {
  /** 12 risers of decreasing size, then 5 small fallers — the real shape. */
  const manyMoves = () => {
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push({ key: `up${i}`, label: `Up ${i}`, currentCents: 100_00 * (12 - i), previousCents: 0 });
    }
    for (let i = 0; i < 5; i++) {
      rows.push({ key: `dn${i}`, label: `Down ${i}`, currentCents: 0, previousCents: 1_00 });
    }
    // …and one that did not move at all
    rows.push({ key: "flat", label: "Flat", currentCents: 50_00, previousCents: 50_00 });
    return rows;
  };

  test("movedCount counts every mover, and the bars are only the biggest", () => {
    const layout = computeDeviationLayout(manyMoves(), { width: 640 });
    expect(layout.bars).toHaveLength(8); // DEFAULT_LIMIT
    expect(layout.movedCount).toBe(17); // 12 up + 5 down; the flat one is not a mover
    expect(layout.upCount).toBe(12);
    expect(layout.downCount).toBe(5);
    // the drawn bars really are all risers — which is exactly why the old count lied
    expect(layout.bars.every((b) => b.isIncrease)).toBe(true);
  });

  test("the description reports the movers and names the cut", () => {
    const d = deviationDescription(computeDeviationLayout(manyMoves(), { width: 640 }), (c) => `$${c / 100}`);
    expect(d).toContain("17 categories moved");
    expect(d).toContain("12 up, 5 down");
    expect(d).toContain("Showing the 8 biggest");
  });

  test("nothing is cut when everything fits, and the cut is not mentioned", () => {
    const layout = computeDeviationLayout(
      [
        { key: "a", label: "A", currentCents: 500, previousCents: 0 },
        { key: "b", label: "B", currentCents: 0, previousCents: 300 },
      ],
      { width: 640 },
    );
    expect(layout.movedCount).toBe(2);
    expect(layout.bars).toHaveLength(2);
    expect(deviationDescription(layout, (c) => `$${c / 100}`)).not.toContain("Showing");
  });
});
