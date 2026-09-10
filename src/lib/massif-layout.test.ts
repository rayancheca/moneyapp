import { describe, expect, test } from "vitest";
import {
  MASSIF_OTHER_ID,
  MASSIF_VIEW_DIMENSION,
  MASSIF_VIEW_LABELS,
  MASSIF_VIEWPOINTS,
  WHERE_VIEW_LABELS,
  WHERE_VIEW_SPEC,
  computeMassifLayout,
  pointsAttr,
  reconcileMassif,
  type MassifBlock,
  type MassifCategoryInput,
  type MassifLayoutOptions,
} from "./massif-layout";
import { resolveViewState } from "./view-state";

/**
 * The massif is a money figure before it is a drawing, so the reconciliation
 * tests come first: a chart that disagrees with the ledger is worse than no
 * chart. The geometry tests then pin the three encodings (footprint width =
 * share, footprint depth = entries, height = change against the prior period)
 * and the determinism the visual baselines depend on.
 */

const OPTS: MassifLayoutOptions = {
  width: 720,
  height: 320,
  camera: MASSIF_VIEWPOINTS.quarter,
};

function cat(over: Partial<MassifCategoryInput> & { id: string }): MassifCategoryInput {
  return {
    label: over.id,
    hue: "green",
    spentCents: 10_000,
    priorCents: 10_000,
    txnCount: 4,
    ...over,
  };
}

/** Rent flat, Groceries up, Health halved — one of each relief. */
const ROWS: MassifCategoryInput[] = [
  cat({ id: "rent", label: "Rent", hue: "brown", spentCents: 215_000, priorCents: 215_000, txnCount: 1 }),
  cat({ id: "groceries", label: "Groceries", hue: "lime", spentCents: 68_432, priorCents: 58_010, txnCount: 14 }),
  cat({ id: "health", label: "Health", hue: "red", spentCents: 8_720, priorCents: 17_440, txnCount: 3, href: "/categories/health" }),
];

function byId(blocks: readonly MassifBlock[], id: string): MassifBlock {
  const found = blocks.find((b) => b.id === id);
  if (!found) throw new Error(`no block ${id}`);
  return found;
}

describe("reconcileMassif", () => {
  test("balances when the blocks plus uncategorized equal gross spend less refunds", () => {
    // Arrange — the identity categoryBreakdown and periodTotals jointly satisfy
    const totals = {
      blocksCents: 292_152,
      uncategorizedCents: 4_100,
      grossSpentCents: 300_252,
      refundsCents: 4_000,
    };

    // Act
    const result = reconcileMassif(totals);

    // Assert
    expect(result.balanced).toBe(true);
    expect(result.residualCents).toBe(0);
    expect(result.netOutCents).toBe(296_252);
  });

  test("reports the exact residual when the two sources count different rows", () => {
    const result = reconcileMassif({
      blocksCents: 292_152,
      uncategorizedCents: 0,
      grossSpentCents: 300_252,
      refundsCents: 4_000,
    });

    expect(result.balanced).toBe(false);
    expect(result.residualCents).toBe(-4_100);
  });
});

describe("computeMassifLayout — the figure sums to the ledger", () => {
  test("block totals equal the sum of the rows fed in", () => {
    const layout = computeMassifLayout(ROWS, OPTS);

    const spent = layout.blocks.reduce((s, b) => s + b.spentCents, 0);
    const prior = layout.blocks.reduce((s, b) => s + b.priorCents, 0);
    const entries = layout.blocks.reduce((s, b) => s + b.txnCount, 0);
    expect(spent).toBe(292_152);
    expect(spent).toBe(layout.totalSpentCents);
    expect(prior).toBe(layout.totalPriorCents);
    expect(entries).toBe(layout.totalTxnCount);
    expect(layout.totalDeltaCents).toBe(layout.totalSpentCents - layout.totalPriorCents);
    expect(layout.categoryCount).toBe(3);
  });

  test("aggregating the tail keeps the total intact — it sums, it never truncates", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      cat({ id: `c${i}`, spentCents: (9 - i) * 1_000, priorCents: 500, txnCount: i + 1 }),
    );

    const layout = computeMassifLayout(many, { ...OPTS, maxBlocks: 4 });

    expect(layout.blocks).toHaveLength(4);
    const other = byId(layout.blocks, MASSIF_OTHER_ID);
    expect(other.memberCount).toBe(6);
    expect(other.label).toBe("6 smaller categories");
    expect(other.hue).toBeNull();
    expect(other.href).toBeUndefined();
    expect(layout.blocks.reduce((s, b) => s + b.spentCents, 0)).toBe(layout.totalSpentCents);
    expect(layout.blocks.reduce((s, b) => s + b.txnCount, 0)).toBe(layout.totalTxnCount);
    expect(layout.categoryCount).toBe(9);
  });

  test("a list at the cap is returned whole — the aggregate never stands for one row", () => {
    const four = Array.from({ length: 4 }, (_, i) => cat({ id: `c${i}`, spentCents: (4 - i) * 1_000 }));

    const atCap = computeMassifLayout(four, { ...OPTS, maxBlocks: 4 });
    expect(atCap.blocks.map((b) => b.id).includes(MASSIF_OTHER_ID)).toBe(false);
    expect(atCap.blocks).toHaveLength(4);

    // one over the cap: the aggregate appears and already stands for two rows
    const overCap = computeMassifLayout(four, { ...OPTS, maxBlocks: 3 });
    expect(byId(overCap.blocks, MASSIF_OTHER_ID).memberCount).toBe(2);
    expect(overCap.blocks.reduce((s, b) => s + b.spentCents, 0)).toBe(10_000);
  });

  test("a maxBlocks below one is ignored rather than emptying the figure", () => {
    const layout = computeMassifLayout(ROWS, { ...OPTS, maxBlocks: 0 });

    expect(layout.blocks).toHaveLength(3);
  });

  test("no rows yields an empty figure with no plane and zero totals", () => {
    const layout = computeMassifLayout([], OPTS);

    expect(layout.blocks).toEqual([]);
    expect(layout.plane).toBeNull();
    expect(layout.liftPerUnit).toBe(0);
    expect(layout.totalSpentCents).toBe(0);
    expect(layout.categoryCount).toBe(0);
  });
});

describe("computeMassifLayout — the encodings", () => {
  test("footprint width is share of the period's positive spend", () => {
    const layout = computeMassifLayout(ROWS, OPTS);

    const rent = byId(layout.blocks, "rent");
    const groceries = byId(layout.blocks, "groceries");
    expect(rent.share).toBeCloseTo(215_000 / 292_152, 10);
    expect(layout.blocks.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 10);
    // and the drawn width follows the share, not just the datum
    expect(rent.footprintPx / groceries.footprintPx).toBeCloseTo(215_000 / 68_432, 2);
  });

  test("a category that net-refunded takes no footprint but keeps its figure", () => {
    const layout = computeMassifLayout(
      [cat({ id: "shopping", spentCents: 20_000 }), cat({ id: "returns", spentCents: -5_000, priorCents: 0 })],
      OPTS,
    );

    const returns = byId(layout.blocks, "returns");
    expect(returns.share).toBe(0);
    expect(returns.footprintPx).toBe(0);
    expect(returns.spentCents).toBe(-5_000);
  });

  test("height is the change against the prior period, signed by direction", () => {
    const layout = computeMassifLayout(ROWS, OPTS);

    expect(byId(layout.blocks, "rent").relief).toBe("level");
    expect(byId(layout.blocks, "rent").deltaCents).toBe(0);
    expect(byId(layout.blocks, "groceries").relief).toBe("raised");
    expect(byId(layout.blocks, "groceries").deltaCents).toBe(10_422);
    // spent LESS than last period → the block is pressed below the plane
    expect(byId(layout.blocks, "health").relief).toBe("sunken");
    expect(byId(layout.blocks, "health").deltaCents).toBe(-8_720);
  });

  test("a raised block stands off the sheet and a sunken block is pressed into it", () => {
    const layout = computeMassifLayout(ROWS, OPTS);

    // the raised front face runs top-corner → base-corner at the SAME x and z,
    // so the pair isolates the relief exactly (SVG y grows downward: up = less)
    const front = byId(layout.blocks, "groceries").faces.find((f) => f.kind === "front")!;
    const [topCorner, baseCorner] = [front.points[0]!, front.points[1]!];
    expect(topCorner.y).toBeLessThan(baseCorner.y);

    // the sunken back wall runs floor-corner → rim-corner: the floor is BELOW
    const back = byId(layout.blocks, "health").faces.find((f) => f.kind === "back-wall")!;
    expect(back.points[0]!.y).toBeGreaterThan(back.points[3]!.y);
  });

  test("each relief kind carries the faces its form needs", () => {
    const layout = computeMassifLayout(ROWS, OPTS);

    expect(byId(layout.blocks, "rent").faces.map((f) => f.kind)).toEqual(["plate"]);
    expect(byId(layout.blocks, "rent").rim).toEqual([]);
    expect(byId(layout.blocks, "groceries").faces.map((f) => f.kind)).toEqual(["front", "side", "top"]);
    expect(byId(layout.blocks, "groceries").hairline).toEqual([]);
    expect(byId(layout.blocks, "health").faces.map((f) => f.kind)).toEqual([
      "back-wall",
      "left-wall",
      "floor",
    ]);
    // the bright near rim is what makes a pressed well read as a well
    expect(byId(layout.blocks, "health").rim).toHaveLength(3);
    expect(byId(layout.blocks, "health").hairline).toHaveLength(3);
  });

  test("relief height is proportional to the change in dollars", () => {
    const layout = computeMassifLayout(
      [
        cat({ id: "big", spentCents: 30_000, priorCents: 10_000, txnCount: 5 }),
        cat({ id: "small", spentCents: 15_000, priorCents: 10_000, txnCount: 5 }),
      ],
      OPTS,
    );

    const reliefPx = (id: string) => {
      const front = byId(layout.blocks, id).faces.find((f) => f.kind === "front")!;
      return front.points[1]!.y - front.points[0]!.y;
    };
    // +$200.00 against +$50.00 → four times the relief, at the same camera
    expect(reliefPx("big") / reliefPx("small")).toBeCloseTo(4, 6);
  });

  test("footprint depth follows the entry count, and never collapses to a rule", () => {
    // every delta zero, so plan-view screen height is PURE footprint depth
    const level = [
      cat({ id: "many", spentCents: 40_000, priorCents: 40_000, txnCount: 20 }),
      cat({ id: "few", spentCents: 20_000, priorCents: 20_000, txnCount: 4 }),
      cat({ id: "one", spentCents: 60_000, priorCents: 60_000, txnCount: 1 }),
    ];
    const layout = computeMassifLayout(level, { ...OPTS, camera: MASSIF_VIEWPOINTS.plan });
    const depthOf = (l: typeof layout, id: string) => {
      const ys = byId(l.blocks, id).faces.flatMap((f) => f.points.map((p) => p.y));
      return Math.max(...ys) - Math.min(...ys);
    };

    expect(depthOf(layout, "many")).toBeGreaterThan(depthOf(layout, "few"));
    expect(depthOf(layout, "few")).toBeGreaterThan(depthOf(layout, "one"));
    // the floor: a one-entry category is still a block, not part of the plane
    expect(depthOf(layout, "one")).toBeGreaterThan(0);

    // pinned AT the floor every footprint is identical — which proves the
    // spread above comes from the entry count and not from the floor
    const pinned = computeMassifLayout(level, {
      ...OPTS,
      camera: MASSIF_VIEWPOINTS.plan,
      minDepthRatio: 1,
    });
    expect(depthOf(pinned, "many")).toBeCloseTo(depthOf(pinned, "one"), 6);
  });

  test("a change of zero across every row leaves the whole massif level", () => {
    const layout = computeMassifLayout(
      [cat({ id: "a", spentCents: 5_000, priorCents: 5_000 }), cat({ id: "b", spentCents: 3_000, priorCents: 3_000 })],
      OPTS,
    );

    expect(layout.blocks.every((b) => b.relief === "level")).toBe(true);
  });

  test("rows with no entries and no spend still lay out without dividing by zero", () => {
    const layout = computeMassifLayout(
      [cat({ id: "a", spentCents: 0, priorCents: 0, txnCount: 0 }), cat({ id: "b", spentCents: 0, priorCents: 0, txnCount: 0 })],
      OPTS,
    );

    const coords = layout.blocks.flatMap((b) => b.faces.flatMap((f) => f.points.flatMap((p) => [p.x, p.y])));
    expect(coords.every(Number.isFinite)).toBe(true);
    expect(layout.blocks.every((b) => b.share === 0)).toBe(true);
  });

  test("percentage change divides by the prior magnitude, and is null with no base", () => {
    const layout = computeMassifLayout(
      [
        cat({ id: "up", spentCents: 15_000, priorCents: 10_000 }),
        cat({ id: "new", spentCents: 4_000, priorCents: 0 }),
      ],
      OPTS,
    );

    expect(byId(layout.blocks, "up").deltaPct).toBe(50);
    expect(byId(layout.blocks, "new").deltaPct).toBeNull();
  });

  test("href rides through for drill-through and is absent when there is none", () => {
    const layout = computeMassifLayout(ROWS, OPTS);

    expect(byId(layout.blocks, "health").href).toBe("/categories/health");
    expect(byId(layout.blocks, "rent").href).toBeUndefined();
  });
});

describe("computeMassifLayout — the camera", () => {
  test("everything drawn stays inside the canvas at every viewpoint", () => {
    for (const camera of Object.values(MASSIF_VIEWPOINTS)) {
      const layout = computeMassifLayout(ROWS, { ...OPTS, camera });
      const points = [
        ...layout.plane!.sheet,
        ...layout.blocks.flatMap((b) => [...b.faces.flatMap((f) => f.points), ...b.rim, ...b.hairline, b.labelAnchor]),
      ];
      expect(points.every((p) => p.x >= 0 && p.x <= OPTS.width)).toBe(true);
      expect(points.every((p) => p.y >= 0 && p.y <= OPTS.height)).toBe(true);
    }
  });

  test("a canvas far too small for the figure shrinks it instead of clipping", () => {
    const layout = computeMassifLayout(ROWS, { ...OPTS, width: 120, height: 100 });

    const xs = layout.blocks.flatMap((b) => b.faces.flatMap((f) => f.points.map((p) => p.x)));
    expect(Math.max(...xs)).toBeLessThanOrEqual(120);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });

  test("a degenerate canvas is floored rather than producing negative geometry", () => {
    const layout = computeMassifLayout(ROWS, { ...OPTS, width: 0, height: 0 });

    expect(layout.width).toBe(80);
    expect(layout.height).toBe(80);
    expect(layout.blocks.every((b) => b.faces.every((f) => f.points.every((p) => Number.isFinite(p.x))))).toBe(true);
  });

  test("blocks come back in painter's order, far to near", () => {
    const layout = computeMassifLayout(ROWS, OPTS);

    // the quarter camera puts the left-most footprint furthest away
    expect(layout.blocks.map((b) => b.id)).toEqual(["rent", "groceries", "health"]);
  });

  test("front folds the depth away; plan folds the relief away", () => {
    const front = computeMassifLayout(ROWS, { ...OPTS, camera: MASSIF_VIEWPOINTS.front });
    const plan = computeMassifLayout(ROWS, { ...OPTS, camera: MASSIF_VIEWPOINTS.plan });

    // front: the flat plate has no visible extent in y at all
    const plate = byId(front.blocks, "rent").faces[0]!;
    expect(new Set(plate.points.map((p) => p.y)).size).toBe(1);
    // plan: looking down, a raised top face and the sheet share a y band
    const topYs = byId(plan.blocks, "groceries").faces.find((f) => f.kind === "top")!.points.map((p) => p.y);
    expect(Math.max(...topYs) - Math.min(...topYs)).toBeGreaterThan(0);
  });

  test("lift is a pure screen translation, so hover never re-lays out", () => {
    const quarter = computeMassifLayout(ROWS, OPTS);
    const plan = computeMassifLayout(ROWS, { ...OPTS, camera: MASSIF_VIEWPOINTS.plan });

    expect(quarter.liftPerUnit).toBeGreaterThan(0);
    // looking almost straight down, a lift barely moves anything on screen
    expect(plan.liftPerUnit).toBeLessThan(quarter.liftPerUnit);
  });

  test("explicit geometry options override every default", () => {
    const tight = computeMassifLayout(ROWS, {
      ...OPTS,
      maxBlocks: 12,
      span: 200,
      gap: 4,
      maxDepth: 6,
      minDepthRatio: 0.1,
      maxRelief: 10,
    });
    const loose = computeMassifLayout(ROWS, OPTS);

    const widthOf = (l: typeof tight) => {
      const xs = l.blocks.flatMap((b) => b.faces.flatMap((f) => f.points.map((p) => p.x)));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(widthOf(tight)).toBeLessThan(widthOf(loose));
  });

  test("the same rows always produce identical points — the visual baselines rely on it", () => {
    const a = computeMassifLayout(ROWS, OPTS);
    const b = computeMassifLayout([...ROWS], { ...OPTS });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // and coordinates are rounded, so no float tail can churn a snapshot
    const coords = a.blocks.flatMap((k) => k.faces.flatMap((f) => f.points.flatMap((p) => [p.x, p.y])));
    expect(coords.every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9)).toBe(true);
  });
});

describe("pointsAttr", () => {
  test("renders an SVG points list", () => {
    expect(pointsAttr([{ x: 1.5, y: 2 }, { x: 3, y: 4.25 }])).toBe("1.5,2 3,4.25");
  });

  test("an empty polygon is an empty attribute, not the string undefined", () => {
    expect(pointsAttr([])).toBe("");
  });
});

describe("WHERE_VIEW_SPEC", () => {
  test("defaults to the list this card has always shown", () => {
    expect(resolveViewState(WHERE_VIEW_SPEC, {}, undefined)).toMatchObject({ where: "list" });
  });

  test("the URL selects a lens and an unknown value falls back", () => {
    expect(resolveViewState(WHERE_VIEW_SPEC, { where: "relief" }, undefined)).toMatchObject({ where: "relief" });
    expect(resolveViewState(WHERE_VIEW_SPEC, { where: "massif" }, undefined)).toMatchObject({ where: "list" });
  });

  test("every option is labelled", () => {
    for (const option of WHERE_VIEW_SPEC[0]!.options) {
      expect(WHERE_VIEW_LABELS[option]).toBeTruthy();
    }
    for (const option of MASSIF_VIEW_DIMENSION.options) {
      expect(MASSIF_VIEW_LABELS[option]).toBeTruthy();
    }
  });

  /*
   * 🔴 The relief's CAMERA declared a URL key named `viewpoint` and held its
   * value in `useState`, so the param did nothing and the choice was lost on
   * reload — and `NetWorthTerrain` and `TransferTower` declared the same word,
   * three surfaces on one param had any of them been wired. It is `massifView`
   * now, and it is real.
   */
  test("the relief's camera is addressable, persisted, and falls back on a typo", () => {
    expect(resolveViewState(WHERE_VIEW_SPEC, { massifView: "plan" }, undefined)).toMatchObject({
      massifView: "plan",
    });
    expect(resolveViewState(WHERE_VIEW_SPEC, {}, { massifView: "front" })).toMatchObject({
      massifView: "front",
    });
    expect(resolveViewState(WHERE_VIEW_SPEC, { massifView: "orbit" }, undefined)).toMatchObject({
      massifView: "quarter",
    });
  });

  /* ⚠️ `options[0]` IS the default, and the relief has always opened on the
     quarter camera. Reading the spec off the old switcher order would have been
     a silent change to what the card draws on a cold load. */
  test("the camera the relief opens on is the one it always opened on", () => {
    expect(MASSIF_VIEW_DIMENSION.options[0]).toBe("quarter");
    for (const option of MASSIF_VIEW_DIMENSION.options) {
      expect(Object.keys(MASSIF_VIEWPOINTS)).toContain(option);
    }
  });

  test("no two dimensions on this surface share a key", () => {
    const keys = WHERE_VIEW_SPEC.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("shareBaseCents — the denominator the WIDTHS divide", () => {
  /*
   * 🔴 The chart's `<desc>` named `totalSpentCents`, the NET, as "the $X spent"
   * whose share a footprint is. They are different numbers wherever a refund
   * lands: `/spending?period=2024-05&where=relief` said "its share of the
   * $675.87 spent" while the widths divided $2,220.45 — Food is 43.3% of the
   * plane beside its own figure of $960.60, and 43.3% of $675.87 is $292.65.
   */
  test("with no refunds the two agree, which is why this went unnoticed", () => {
    const layout = computeMassifLayout(ROWS, OPTS);
    expect(layout.shareBaseCents).toBe(layout.totalSpentCents);
  });

  test("a net-refunded category is dropped from the denominator, not subtracted", () => {
    const rows = [
      cat({ id: "food", spentCents: 96_060, priorCents: 0, txnCount: 3 }),
      cat({ id: "shopping", spentCents: -152_458, priorCents: 0, txnCount: 1 }),
    ];
    const layout = computeMassifLayout(rows, OPTS);
    expect(layout.totalSpentCents).toBe(-56_398);
    expect(layout.shareBaseCents).toBe(96_060);
    // and a width really is a share of THAT
    expect(byId(layout.blocks, "food").share).toBeCloseTo(1, 10);
    expect(byId(layout.blocks, "shopping").share).toBe(0);
  });

  test("every block's share sums to one against shareBaseCents", () => {
    const rows = [
      cat({ id: "a", spentCents: 30_000 }),
      cat({ id: "b", spentCents: 10_000 }),
      cat({ id: "c", spentCents: -5_000 }),
    ];
    const layout = computeMassifLayout(rows, OPTS);
    expect(layout.shareBaseCents).toBe(40_000);
    expect(layout.blocks.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 10);
  });
});
