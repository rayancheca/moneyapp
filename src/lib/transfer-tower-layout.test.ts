import { describe, expect, test } from "vitest";

import {
  TOWER_VIEWPOINTS,
  TOWER_VIEWPOINT_ORDER,
  arrowheadFor,
  computeTowerGeometry,
  computeTowerLayout,
  pointsAttr,
  towerDescription,
  type TowerViewpoint,
} from "./transfer-tower-layout";
import type { TransferAccount, TransferEdge, TransferFlowData } from "@/services/transfer-flow";

const fmt = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function account(id: string, netCents: number, extra: Partial<TransferAccount> = {}): TransferAccount {
  return {
    id,
    label: id.toUpperCase(),
    color: "var(--cat-blue)",
    netCents,
    inCents: netCents > 0 ? netCents : 0,
    outCents: netCents < 0 ? -netCents : 0,
    href: `/transactions?account=${id}`,
    ...extra,
  };
}

/** The tower is driven by the MONTH series, so the fixture takes it directly. */
function edge(from: string, to: string, monthCents: number[], monthCounts?: number[]): TransferEdge {
  const counts = monthCounts ?? monthCents.map((c) => (c > 0 ? 1 : 0));
  const cents = monthCents.reduce((s, c) => s + c, 0);
  return {
    id: `${from}>${to}`,
    fromAccountId: from,
    toAccountId: to,
    cents,
    count: counts.reduce((s, c) => s + c, 0),
    grossCents: cents,
    returnedCents: 0,
    monthCents,
    monthCounts: counts,
  };
}

function data(partial: Partial<TransferFlowData> = {}): TransferFlowData {
  const accounts = partial.accounts ?? [account("a", -100_00), account("b", 100_00)];
  const months = partial.months ?? ["2026-01", "2026-02", "2026-03"];
  const edges = partial.edges ?? [edge("a", "b", [40_00, 0, 60_00])];
  return {
    accounts,
    edges,
    netEdges: partial.netEdges ?? edges,
    months,
    totals: {
      grossCents: edges.reduce((s, e) => s + e.cents, 0),
      netCents: edges.reduce((s, e) => s + e.cents, 0),
      churnCents: 0,
      pairedGroupCount: edges.reduce((s, e) => s + e.count, 0),
      groupCount: edges.reduce((s, e) => s + e.count, 0),
      unattributedGroupCount: 0,
      unattributedCents: 0,
      unattributedByReason: { "single-leg": 0, "multi-leg": 0, "same-account": 0 },
      ...partial.totals,
    },
  };
}

/** Six accounts and both directions on two pairs — the shape of the real data. */
function busy(): TransferFlowData {
  const accounts = [
    account("chase", -112_880_48, { label: "Chase Checking" }),
    account("savings", -31_659_12, { label: "SoFi Savings" }),
    account("venture", 14_007_87, { label: "Venture X" }),
    account("discover", 17_254_57, { label: "Discover" }),
    account("robinhood", 54_080_52, { label: "Robinhood Cash" }),
    account("checking", 59_196_64, { label: "SoFi Checking" }),
  ];
  const months = [
    "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
  ];
  const edges = [
    // the woven rope: constant, small, very frequent
    edge("savings", "checking", [9_00, 12_00, 8_00, 20_00, 15_00, 11_00, 9_00, 14_00], [40, 52, 38, 61, 44, 33, 31, 47]),
    // the sparse struts: rare, enormous
    edge("chase", "savings", [500_00, 0, 900_00, 0, 0, 700_00, 0, 0], [1, 0, 2, 0, 0, 1, 0, 0]),
    edge("checking", "savings", [3_00, 0, 5_00, 0, 2_00, 0, 0, 1_00]),
    edge("robinhood", "chase", [0, 100_00, 0, 0, 0, 40_00, 0, 0]),
    edge("chase", "venture", [30_00, 25_00, 0, 40_00, 0, 0, 22_00, 0]),
    edge("savings", "discover", [4_00, 4_00, 4_00, 4_00, 4_00, 4_00, 4_00, 4_00], [3, 3, 3, 3, 3, 3, 3, 3]),
  ];
  return data({ accounts, months, edges });
}

const PLATE = { width: 900, height: 520, camera: TOWER_VIEWPOINTS.quarter };

/** World coordinates are quantised to 4dp, so an exact bound needs one quantum of slack. */
const ARCH_TOLERANCE = 1e-4;

describe("determinism", () => {
  test("identical input yields deeply-equal geometry", () => {
    const d = busy();
    expect(computeTowerGeometry(d, "gross")).toEqual(computeTowerGeometry(d, "gross"));
  });

  test("identical input yields deeply-equal layout", () => {
    const d = busy();
    expect(computeTowerLayout(d, "gross", PLATE)).toEqual(computeTowerLayout(d, "gross", PLATE));
  });

  test("world coordinates are rounded, never full-precision floats", () => {
    for (const arc of computeTowerGeometry(busy(), "gross").arcs) {
      for (const p of arc.points) {
        for (const n of [p.x, p.y, p.z]) expect(String(n)).toMatch(/^-?\d+(\.\d{1,4})?$/);
      }
    }
  });

  test("every emitted SVG attribute is rounded to 2dp", () => {
    const layout = computeTowerLayout(busy(), "gross", PLATE);
    const attrs = [
      ...layout.arcs.map((a) => a.polyline),
      ...layout.arcs.flatMap((a) => (a.arrowhead === null ? [] : [a.arrowhead])),
      ...layout.rings.map((r) => r.outline),
    ];
    expect(attrs.length).toBeGreaterThan(0);
    for (const attr of attrs) {
      for (const n of attr.match(/-?\d+\.?\d*/g) ?? []) {
        expect(n).toMatch(/^-?\d+(\.\d{1,2})?$/);
      }
    }
  });

  test("arcs come out in a total order, independent of edge iteration order", () => {
    const keys = computeTowerGeometry(busy(), "gross").arcs.map((a) => a.key);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("pointsAttr emits the SVG points form", () => {
    expect(pointsAttr([{ x: 1, y: 2 }, { x: 3.5, y: -4 }])).toBe("1,2 3.5,-4");
    expect(pointsAttr([])).toBe("");
  });
});

describe("INVARIANT 1 — the Y axis is time, and nothing else", () => {
  test("months map monotonically upward, oldest at the base and newest at the top", () => {
    const geo = computeTowerGeometry(busy(), "gross");
    const yByMonth = new Map<number, number>();
    for (const arc of geo.arcs) yByMonth.set(arc.monthIndex, arc.points[0]!.y);

    const ys = [...yByMonth.keys()].sort((a, b) => a - b).map((i) => yByMonth.get(i)!);
    expect(ys.length).toBeGreaterThan(1);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(geo.baseY);
    expect(Math.max(...ys)).toBeLessThanOrEqual(geo.topY);
  });

  test("an arc begins and ends at exactly its own month's height", () => {
    for (const arc of computeTowerGeometry(busy(), "gross").arcs) {
      expect(arc.points[0]!.y).toBe(arc.points[arc.points.length - 1]!.y);
    }
  });

  test("no arc arches more than 0.4 of one month — it can never read at the wrong altitude", () => {
    // The bound that stops the third dimension from lying about the second.
    // The prototype's unbounded chord-derived arch failed this on short windows.
    const geo = computeTowerGeometry(busy(), "gross");
    expect(geo.arcs.length).toBeGreaterThan(0);
    for (const arc of geo.arcs) {
      const apex = Math.max(...arc.points.map((p) => p.y));
      expect(apex - arc.points[0]!.y).toBeLessThanOrEqual(0.4 * geo.monthStep + ARCH_TOLERANCE);
    }
  });

  test("the bound holds on a two-month window, where the spacing is widest", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01", "2026-02"], edges: [edge("a", "b", [10_00, 10_00])] }),
      "gross",
    );
    expect(geo.arcs).toHaveLength(2);
    for (const arc of geo.arcs) {
      expect(Math.max(...arc.points.map((p) => p.y)) - arc.points[0]!.y).toBeLessThanOrEqual(
        0.4 * geo.monthStep + ARCH_TOLERANCE,
      );
    }
  });

  test("and on a 60-month window, where it is tightest", () => {
    const months = Array.from(
      { length: 60 },
      (_, i) => `20${20 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
    );
    const geo = computeTowerGeometry(
      data({ months, edges: [edge("a", "b", months.map(() => 10_00))] }),
      "gross",
    );
    expect(geo.arcs).toHaveLength(60);
    for (const arc of geo.arcs) {
      expect(Math.max(...arc.points.map((p) => p.y)) - arc.points[0]!.y).toBeLessThanOrEqual(
        0.4 * geo.monthStep + ARCH_TOLERANCE,
      );
    }
  });
});

describe("INVARIANT 2 — the two directions of a pair never coincide", () => {
  test("A→B and B→A bow to opposite sides, so the round-trip stays visible", () => {
    const geo = computeTowerGeometry(
      data({
        accounts: [account("a", -100_00), account("b", 100_00)],
        months: ["2026-01"],
        edges: [edge("a", "b", [100_00]), edge("b", "a", [40_00])],
      }),
      "gross",
    );
    const mid = (id: string) => {
      const arc = geo.arcs.find((x) => x.edgeId === id)!;
      return arc.points[Math.floor(arc.points.length / 2)]!;
    };
    const f = mid("a>b");
    const b = mid("b>a");
    expect(f.y).toBe(b.y); // same month, so the same altitude
    expect(Math.hypot(f.x - b.x, f.z - b.z)).toBeGreaterThan(0.1);
  });

  test("every counter-directed pair sharing a month stays separated", () => {
    const geo = computeTowerGeometry(busy(), "gross");
    let checked = 0;
    for (const a of geo.arcs) {
      for (const b of geo.arcs) {
        if (a.key >= b.key || a.monthIndex !== b.monthIndex) continue;
        if (a.fromAccountId !== b.toAccountId || a.toAccountId !== b.fromAccountId) continue;
        const am = a.points[Math.floor(a.points.length / 2)]!;
        const bm = b.points[Math.floor(b.points.length / 2)]!;
        expect(Math.hypot(am.x - bm.x, am.z - bm.z)).toBeGreaterThan(0.1);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0); // guards the guard
  });
});

describe("INVARIANT 3 — the skeleton does not move when the measure does", () => {
  const paired = () =>
    data({
      accounts: [account("a", -60_00), account("b", 60_00)],
      months: ["2026-01", "2026-02"],
      edges: [edge("a", "b", [100_00, 0]), edge("b", "a", [40_00, 0])],
      netEdges: [{ ...edge("a", "b", [60_00, 0]), grossCents: 100_00, returnedCents: 40_00 }],
    });

  test("pillars and time rings are identical in gross and net", () => {
    const gross = computeTowerGeometry(paired(), "gross");
    const net = computeTowerGeometry(paired(), "net");
    expect(net.pillars).toEqual(gross.pillars);
    expect(net.rings).toEqual(gross.rings);
    expect(net.monthStep).toBe(gross.monthStep);
    expect(net.arcs.length).toBeLessThan(gross.arcs.length); // only the arcs respond
  });

  test("the projected pillars land in exactly the same place too", () => {
    const gross = computeTowerLayout(paired(), "gross", PLATE);
    const net = computeTowerLayout(paired(), "net", PLATE);
    expect(net.pillars.map((p) => [p.top, p.bottom, p.width])).toEqual(
      gross.pillars.map((p) => [p.top, p.bottom, p.width]),
    );
  });
});

describe("arcs are one per (edge, month) bucket that carries money", () => {
  test("a month with no volume produces no arc", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01", "2026-02", "2026-03"], edges: [edge("a", "b", [10_00, 0, 5_00])] }),
      "gross",
    );
    expect(geo.arcs.map((a) => a.monthIndex)).toEqual([0, 2]);
  });

  test("the arc carries its OWN month's cents and count, not the edge total", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01", "2026-02"], edges: [edge("a", "b", [10_00, 90_00], [3, 7])] }),
      "gross",
    );
    expect(geo.arcs.map((a) => [a.cents, a.count])).toEqual([
      [10_00, 3],
      [90_00, 7],
    ]);
  });

  test("a series shorter than the month span is padded, never read off the end", () => {
    // the service always aligns them; this proves a malformed edge cannot NaN
    const geo = computeTowerGeometry(
      data({ months: ["2026-01", "2026-02", "2026-03"], edges: [edge("a", "b", [10_00])] }),
      "gross",
    );
    expect(geo.arcs).toHaveLength(1);
    expect(geo.arcs[0]!.monthIndex).toBe(0);
  });

  test("a bucket with a value but no count still draws, reporting zero transfers", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01", "2026-02"], edges: [edge("a", "b", [10_00, 20_00], [1])] }),
      "gross",
    );
    expect(geo.arcs.map((a) => a.count)).toEqual([1, 0]);
  });

  test("stroke width tracks the month's dollars", () => {
    const layout = computeTowerLayout(
      data({ months: ["2026-01", "2026-02"], edges: [edge("a", "b", [1_00, 100_00])] }),
      "gross",
      PLATE,
    );
    expect(layout.arcs[1]!.width).toBeGreaterThan(layout.arcs[0]!.width);
  });

  test("an edge naming an unknown SENDER is skipped, never guessed", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01"], edges: [edge("a", "b", [10_00]), edge("ghost", "b", [10_00])] }),
      "gross",
    );
    expect(geo.arcs.map((a) => a.edgeId)).toEqual(["a>b"]);
  });

  test("an edge naming an unknown RECIPIENT is skipped too", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01"], edges: [edge("a", "b", [10_00]), edge("a", "ghost", [10_00])] }),
      "gross",
    );
    expect(geo.arcs.map((a) => a.edgeId)).toEqual(["a>b"]);
  });

  test("a self-loop has no geometry on a ring and is dropped", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01"], edges: [edge("a", "a", [10_00]), edge("a", "b", [5_00])] }),
      "gross",
    );
    expect(geo.arcs.map((a) => a.edgeId)).toEqual(["a>b"]);
  });

  test("a floor ring every six months, always including the first", () => {
    const geo = computeTowerGeometry(busy(), "gross"); // 8 months
    expect(geo.rings.map((r) => r.monthIndex)).toEqual([0, 6]);
    expect(geo.rings[0]!.month).toBe("2026-01");
  });
});

describe("the tower frames itself at every breakpoint and every viewpoint", () => {
  // The lesson the spine paid for: tsc and 2,100 unit tests all passed while the
  // chart was clipped on screen. These assert what a screenshot would show.
  for (const [width, height] of [
    [320, 360],
    [375, 400],
    [440, 440],
    [768, 500],
    [1024, 540],
    [1440, 600],
    [2560, 640],
  ] as const) {
    for (const viewpoint of TOWER_VIEWPOINT_ORDER) {
      test(`@${width}x${height} ${viewpoint}: nothing is drawn outside the plate`, () => {
        const layout = computeTowerLayout(busy(), "gross", {
          width,
          height,
          camera: TOWER_VIEWPOINTS[viewpoint],
        });
        const inside = (p: { x: number; y: number }) =>
          p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height;

        for (const arc of layout.arcs) for (const p of arc.points) expect(inside(p)).toBe(true);
        for (const p of layout.pillars) {
          expect(inside(p.top)).toBe(true);
          expect(inside(p.bottom)).toBe(true);
          expect(p.labelY).toBeGreaterThanOrEqual(0);
        }
        expect(inside(layout.axisTop)).toBe(true);
        expect(inside(layout.axisBottom)).toBe(true);
      });
    }
  }

  test("a month label never lands on the figure, at any width or viewpoint", () => {
    // At 375px the labels were drawn at a fixed x = 8 and the figure grew left
    // over the top of them; at 1440px the figure centred itself and stranded
    // them 380px away. Both are the same defect: a time axis that is not beside
    // the thing it measures. Only a screenshot found it — this keeps it found.
    for (const width of [320, 375, 768, 1440, 2560]) {
      for (const viewpoint of TOWER_VIEWPOINT_ORDER) {
        const layout = computeTowerLayout(busy(), "gross", {
          width,
          height: 520,
          camera: TOWER_VIEWPOINTS[viewpoint],
        });
        const drawn = [
          ...layout.arcs.flatMap((a) => a.points.map((p) => p.x)),
          ...layout.pillars.flatMap((p) => [p.top.x, p.bottom.x]),
        ];
        const leftmost = Math.min(...drawn);
        for (const ring of layout.rings) {
          // never ON the figure …
          expect(ring.label.x).toBeLessThanOrEqual(leftmost);
          // … and never STRANDED from it either. Asserting only the first half
          // is what let the stranding survive: the labels were pinned to a
          // fixed gutter while `fitCamera` centred a figure that is taller than
          // it is wide, so the two drifted apart by 175px at 1440 and 570px at
          // 2560 — a time axis 570px from the thing it measures is not an axis.
          expect(layout.figureLeft - ring.label.x).toBe(8);
          // and it still has room for its own text at the narrowest plate
          expect(ring.label.x).toBeGreaterThanOrEqual(40);
          expect(ring.label.y).toBe(ring.centre.y); // it labels its own ring
        }
      }
    }
  });

  test("the tower grows until it touches one edge of the plate — it is never left small", () => {
    // The tower is a roughly square object, so on a wide short plate the HEIGHT
    // binds and horizontal room is genuinely left over. That is the fit being
    // right, not the figure being lazy — the panel puts the account rail in
    // that space, exactly as the terrain does. What must always hold is that
    // one axis is filled: a figure that fills neither is simply too small.
    for (const [width, height] of [
      [1024, 540],
      [420, 700],
      [900, 520],
    ] as const) {
      const layout = computeTowerLayout(busy(), "gross", {
        width,
        height,
        camera: TOWER_VIEWPOINTS.quarter,
      });
      const xs = layout.arcs.flatMap((a) => a.points.map((p) => p.x));
      const ys = layout.arcs.flatMap((a) => a.points.map((p) => p.y));
      const usedW = (Math.max(...xs) - Math.min(...xs)) / width;
      const usedH = (Math.max(...ys) - Math.min(...ys)) / height;
      expect(Math.max(usedW, usedH)).toBeGreaterThan(0.55);
    }
  });

  test("front looks along the ring; plan looks down at it", () => {
    const geo = (viewpoint: TowerViewpoint) =>
      computeTowerLayout(busy(), "gross", { ...PLATE, camera: TOWER_VIEWPOINTS[viewpoint] });
    const spread = (v: TowerViewpoint) => {
      const ys = geo(v).pillars.flatMap((p) => [p.top.y, p.bottom.y]);
      return Math.max(...ys) - Math.min(...ys);
    };
    // in plan the pillars are nearly end-on, so their projected height collapses
    expect(spread("plan")).toBeLessThan(spread("front"));
  });

  test("a plate too small to draw in still produces finite geometry", () => {
    const layout = computeTowerLayout(busy(), "gross", { width: 0, height: 0, camera: TOWER_VIEWPOINTS.quarter });
    for (const arc of layout.arcs) {
      for (const p of arc.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });
});

describe("pillar labels are de-collided deterministically", () => {
  test("no two labels ever share a box, at any plate a phone or a desktop can make", () => {
    // ⚠️ THE FIRST VERSION OF THIS TEST ASSERTED NOTHING. It looped adjacent
    // pairs, computed `overlapping`, and only called `expect` inside
    // `if (overlapping)` — so on a plate where no pair happened to be close the
    // body never ran and the test passed vacuously. It sampled ONE plate
    // (420×380, plan) and missed a real clash band at 279–332px, which on the
    // seven-account graph is 432–471px — the owner's own phone. Sweep, compare
    // EVERY pair rather than adjacent ones, and count the comparisons.
    let compared = 0;
    let clashes = 0;
    for (const width of [260, 279, 300, 310, 332, 375, 390, 440, 768, 1024, 1440]) {
      for (const height of [360, 416, 544, 608]) {
        for (const viewpoint of TOWER_VIEWPOINT_ORDER) {
          const layout = computeTowerLayout(busy(), "gross", {
            width,
            height,
            camera: TOWER_VIEWPOINTS[viewpoint],
          });
          for (const a of layout.pillars) {
            for (const b of layout.pillars) {
              if (a.id >= b.id) continue;
              compared += 1;
              const overlapping =
                Math.abs(a.labelX - b.labelX) < 46 && Math.abs(a.labelY - b.labelY) < 25;
              if (overlapping) {
                clashes += 1;
                // eslint-disable-next-line no-console
                console.error(
                  `clash @${width}x${height} ${viewpoint}: ${a.label}(${a.labelX},${a.labelY}) vs ${b.label}(${b.labelX},${b.labelY})`,
                );
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1_000); // guards the guard
    expect(clashes).toBe(0);
  });

  test("a centred label never hangs off the side of the plate", () => {
    for (const width of [320, 440, 900]) {
      const layout = computeTowerLayout(busy(), "gross", {
        width,
        height: 420,
        camera: TOWER_VIEWPOINTS.side,
      });
      for (const p of layout.pillars) {
        expect(p.labelX).toBeGreaterThanOrEqual(0);
        expect(p.labelX).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a lifted label never leaves the top of the plate", () => {
    const layout = computeTowerLayout(busy(), "gross", {
      width: 320,
      height: 360,
      camera: TOWER_VIEWPOINTS.plan,
    });
    for (const p of layout.pillars) expect(p.labelY).toBeGreaterThanOrEqual(14);
  });

  test("two well-separated pillars are left exactly where they were", () => {
    const layout = computeTowerLayout(
      data({ accounts: [account("a", -100_00), account("b", 100_00)] }),
      "gross",
      { width: 900, height: 520, camera: TOWER_VIEWPOINTS.front },
    );
    for (const p of layout.pillars) expect(p.labelY).toBe(p.top.y - 15);
  });
});

describe("the paint order is a stable depth sort", () => {
  test("farthest first", () => {
    const depths = computeTowerLayout(busy(), "gross", PLATE).order.map((o) => o.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  test("equal depths break by a stable key, never by insertion order", () => {
    // ⚠️ THE FIRST VERSION NEVER RAN ITS `expect`. It guarded on
    // `prev.depth === cur.depth`, and on the quarter camera no two items tie —
    // so the tie-break, which is the entire reason this test exists, went
    // unasserted. Ties DO exist and are constructible: a pillar's depth averages
    // its top and base, so the ±y terms cancel and only `z1` survives; at
    // azimuth 0 that is just `z`, and on a four-account ring the accounts at
    // angle 0 and angle π both sit at z = 0. Front is azimuth 0.
    const square = data({
      accounts: [
        account("a", -30_00),
        account("b", -10_00),
        account("c", 10_00),
        account("d", 30_00),
      ],
      months: ["2026-01", "2026-02"],
      edges: [edge("a", "c", [10_00, 5_00]), edge("b", "d", [7_00, 3_00])],
    });
    const order = computeTowerLayout(square, "gross", {
      width: 900,
      height: 520,
      camera: TOWER_VIEWPOINTS.front,
    }).order;

    let ties = 0;
    for (let i = 1; i < order.length; i += 1) {
      const prev = order[i - 1]!;
      const cur = order[i]!;
      if (prev.depth !== cur.depth) continue;
      ties += 1;
      expect(prev.sortKey.localeCompare(cur.sortKey)).toBeLessThan(0);
    }
    expect(ties, "no depth ties occurred, so the tie-break went unexercised").toBeGreaterThan(0);
  });

  test("every arc and every pillar is in the paint list exactly once", () => {
    const layout = computeTowerLayout(busy(), "gross", PLATE);
    expect(layout.order).toHaveLength(layout.arcs.length + layout.pillars.length);
    expect(new Set(layout.order.map((o) => o.sortKey)).size).toBe(layout.order.length);
  });

  test("nearness spans the full range, so the depth cue is actually used", () => {
    const layout = computeTowerLayout(busy(), "gross", PLATE);
    const values = layout.arcs.map((a) => a.nearness);
    expect(Math.min(...values)).toBeCloseTo(0, 5);
    expect(Math.max(...values)).toBeCloseTo(1, 5);
  });

  test("nearness stays inside 0…1 for EVERY tower, including a one-arc one", () => {
    // The renderer turns nearness straight into opacity. It was normalised
    // against the UNROUNDED depth means while `depth` itself was rounded, so on
    // a single-arc tower — true range 0, divisor falling back to EPS = 1e-9,
    // numerator a rounding residual — it came out around ±10⁴. The renderer
    // computed opacity ≈ −3484, SVG clamped that to 0, and the tower's only arc
    // was INVISIBLE while the caption still read "1 arcs".
    const towers: [string, TransferFlowData][] = [
      ["one arc", data({ months: ["2026-01"], edges: [edge("a", "b", [10_00])] })],
      ["two arcs, one route", data({ months: ["2026-01", "2026-02"], edges: [edge("a", "b", [10_00, 10_00])] })],
      ["six accounts", busy()],
    ];
    for (const [name, d] of towers) {
      for (const viewpoint of TOWER_VIEWPOINT_ORDER) {
        const layout = computeTowerLayout(d, "gross", { ...PLATE, camera: TOWER_VIEWPOINTS[viewpoint] });
        expect(layout.arcs.length, name).toBeGreaterThan(0);
        for (const arc of layout.arcs) {
          expect(arc.nearness, `${name} @${viewpoint}`).toBeGreaterThanOrEqual(0);
          expect(arc.nearness, `${name} @${viewpoint}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("a lone arc reads as fully present, not as an outlier at the back", () => {
    const layout = computeTowerLayout(
      data({ months: ["2026-01"], edges: [edge("a", "b", [10_00])] }),
      "gross",
      PLATE,
    );
    expect(layout.arcs).toHaveLength(1);
    // With nothing to be nearer or farther THAN, the one arc IS the foreground.
    // 0 would be the far end of the scale, which the renderer draws at its
    // faintest resting opacity — technically visible, and still a lie.
    expect(layout.arcs[0]!.nearness).toBe(1);
  });
});

describe("arrowheads state direction where they can be read", () => {
  test("a hairline arc gets no arrowhead — it would be a blob, not a direction", () => {
    expect(arrowheadFor([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1)).toBeNull();
  });

  test("a substantial arc gets a three-point head at its destination", () => {
    const head = arrowheadFor([{ x: 0, y: 0 }, { x: 10, y: 0 }], 4);
    expect(head).not.toBeNull();
    expect(head!.split(" ")).toHaveLength(3);
    expect(head!.startsWith("10,0")).toBe(true); // the tip is the destination
  });

  test("a degenerate polyline cannot produce a head", () => {
    expect(arrowheadFor([], 4)).toBeNull();
    expect(arrowheadFor([{ x: 1, y: 1 }], 4)).toBeNull();
  });

  test("the real layout puts heads on the heavy arcs and not the hairlines", () => {
    const layout = computeTowerLayout(busy(), "gross", PLATE);
    const withHead = layout.arcs.filter((a) => a.arrowhead !== null);
    const without = layout.arcs.filter((a) => a.arrowhead === null);
    expect(withHead.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    expect(Math.min(...withHead.map((a) => a.width))).toBeGreaterThanOrEqual(
      Math.max(...without.map((a) => a.width)),
    );
  });
});

describe("the viewpoints", () => {
  test("quarter is the default, and its elevation clears the flat-ring floor", () => {
    expect(TOWER_VIEWPOINT_ORDER[0]).toBe("quarter");
    // Under ORTHOGRAPHIC projection the ring's projected depth is sin(elevation),
    // so a shallow angle collapses the ring into a picket fence — the prototype
    // got away with 16° only because it projected in perspective. Pin the floor.
    expect(TOWER_VIEWPOINTS.quarter.elevationDeg).toBeGreaterThanOrEqual(24);
    expect(TOWER_VIEWPOINTS.quarter).toEqual({ azimuthDeg: -35.5, elevationDeg: 27 });
  });

  test("every declared viewpoint has a camera, and no camera is orphaned", () => {
    expect([...TOWER_VIEWPOINT_ORDER].sort()).toEqual(Object.keys(TOWER_VIEWPOINTS).sort());
  });

  test("the four viewpoints are genuinely different angles", () => {
    const seen = new Set(
      TOWER_VIEWPOINT_ORDER.map((v) => `${TOWER_VIEWPOINTS[v].azimuthDeg}/${TOWER_VIEWPOINTS[v].elevationDeg}`),
    );
    expect(seen.size).toBe(TOWER_VIEWPOINT_ORDER.length);
  });
});

describe("degenerate states", () => {
  test("no edges: the pillars and rings still stand, and nothing throws", () => {
    const geo = computeTowerGeometry(data({ edges: [], netEdges: [] }), "gross");
    expect(geo.arcs).toEqual([]);
    expect(geo.pillars).toHaveLength(2);
    expect(geo.rings.length).toBeGreaterThan(0);
    expect(geo.peakMonthCents).toBe(0);

    const layout = computeTowerLayout(data({ edges: [], netEdges: [] }), "gross", PLATE);
    expect(layout.arcs).toEqual([]);
    expect(layout.pillars).toHaveLength(2);
  });

  test("no accounts at all", () => {
    const empty = data({ accounts: [], edges: [], netEdges: [], months: [] });
    const geo = computeTowerGeometry(empty, "gross");
    expect(geo.pillars).toEqual([]);
    expect(geo.arcs).toEqual([]);
    expect(geo.rings).toEqual([]);
    expect(() => computeTowerLayout(empty, "gross", PLATE)).not.toThrow();
  });

  test("one account cannot transfer to itself, so the tower stands empty", () => {
    const geo = computeTowerGeometry(
      data({ accounts: [account("a", 0)], months: ["2026-01"], edges: [edge("a", "a", [10_00])] }),
      "gross",
    );
    expect(geo.pillars).toHaveLength(1);
    expect(geo.arcs).toEqual([]);
  });

  test("a single month does not divide by zero", () => {
    const geo = computeTowerGeometry(
      data({ months: ["2026-01"], edges: [edge("a", "b", [10_00])] }),
      "gross",
    );
    expect(geo.monthStep).toBeGreaterThan(0);
    expect(geo.arcs).toHaveLength(1);
    for (const p of geo.arcs[0]!.points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    }
  });
});

describe("towerDescription", () => {
  test("names the span, the arc count, and how to read a rope against a strut", () => {
    const desc = towerDescription(busy(), "gross", fmt);
    expect(desc).toContain("6 accounts");
    expect(desc).toContain("2026-01 at the base");
    expect(desc).toContain("2026-08 at the top");
    expect(desc).toContain("gross");
    expect(desc).toContain("rope running the full height");
    expect(desc).toContain("Spine and Table views");
  });

  test("net mode reports the net total, not the gross one", () => {
    const d = data({
      months: ["2026-01"],
      edges: [edge("a", "b", [100_00]), edge("b", "a", [40_00])],
      netEdges: [edge("a", "b", [60_00])],
    });
    expect(towerDescription(d, "net", fmt)).toContain("net $60.00");
    expect(towerDescription(d, "gross", fmt)).toContain("gross $140.00");
  });

  test("the empty states read as a sentence, not a blank", () => {
    const EMPTY = "No transfers between your accounts in this period.";
    // no months at all
    expect(towerDescription(data({ accounts: [], edges: [], netEdges: [], months: [] }), "gross", fmt)).toBe(EMPTY);
    // months, but nothing moved in them
    expect(towerDescription(data({ edges: [], netEdges: [] }), "gross", fmt)).toBe(EMPTY);
  });
});
