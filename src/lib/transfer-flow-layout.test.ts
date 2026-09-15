import { describe, expect, test } from "vitest";

import { computeSpineLayout, spineDescription, spineNodeLabel } from "./transfer-flow-layout";
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

function edge(from: string, to: string, cents: number, count = 1): TransferEdge {
  return {
    id: `${from}>${to}`,
    fromAccountId: from,
    toAccountId: to,
    cents,
    count,
    grossCents: cents,
    returnedCents: 0,
    monthCents: [cents],
    monthCounts: [count],
  };
}

function data(partial: Partial<TransferFlowData> = {}): TransferFlowData {
  const accounts = partial.accounts ?? [account("a", -100_00), account("b", 100_00)];
  const edges = partial.edges ?? [edge("a", "b", 100_00)];
  return {
    accounts,
    edges,
    netEdges: partial.netEdges ?? edges,
    months: partial.months ?? ["2026-01"],
    totals: {
      grossCents: edges.reduce((s, e) => s + e.cents, 0),
      netCents: edges.reduce((s, e) => s + e.cents, 0),
      churnCents: 0,
      pairedGroupCount: edges.reduce((s, e) => s + e.count, 0),
      groupCount: edges.reduce((s, e) => s + e.count, 0),
      unattributedGroupCount: 0,
      unattributedCents: 0,
      unattributedByReason: { "single-leg": 0, "multi-leg": 0, "same-account": 0, cancelled: 0 },
      ...partial.totals,
    },
  };
}

const OPTS = { width: 900 };

describe("determinism", () => {
  test("identical input yields byte-identical geometry", () => {
    const d = data();
    expect(computeSpineLayout(d, "gross", OPTS)).toEqual(computeSpineLayout(d, "gross", OPTS));
  });

  test("path strings are rounded, never full-precision floats", () => {
    const layout = computeSpineLayout(data(), "gross", { width: 733 });
    for (const arc of layout.arcs) {
      for (const n of arc.path.match(/-?\d+\.?\d*/g) ?? []) {
        expect(n).toMatch(/^-?\d+(\.\d{1,2})?$/);
      }
    }
  });
});

describe("node placement", () => {
  test("nodes sit in the order the service gave them, evenly spaced", () => {
    const layout = computeSpineLayout(
      data({ accounts: [account("a", -50_00), account("b", 0), account("c", 50_00)] }),
      "gross",
      OPTS,
    );
    const ys = layout.nodes.map((n) => n.y);
    expect(ys).toEqual([...ys].sort((x, y) => x - y));
    expect(ys).toHaveLength(3);
    expect(ys[1]! - ys[0]!).toBe(ys[2]! - ys[1]!);
  });

  test("height grows with the account count", () => {
    const two = computeSpineLayout(data(), "gross", OPTS).height;
    const three = computeSpineLayout(
      data({ accounts: [account("a", -50_00), account("b", 0), account("c", 50_00)] }),
      "gross",
      OPTS,
    ).height;
    expect(three).toBeGreaterThan(two);
  });

  test("radius follows |net|, and a zero-net node still renders a visible dot", () => {
    const layout = computeSpineLayout(
      data({ accounts: [account("a", -100_00), account("b", 0), account("c", 100_00)] }),
      "gross",
      OPTS,
    );
    const mid = layout.nodes.find((n) => n.id === "b")!;
    expect(mid.weight).toBe(0);
    expect(mid.radius).toBeGreaterThan(0);
  });
});

describe("the left region is exactly the return flow", () => {
  test("moving DOWN the ladder bulges right (onward)", () => {
    const layout = computeSpineLayout(data(), "gross", OPTS);
    expect(layout.arcs[0]!.isOnward).toBe(true);
    expect(layout.rightRegion).toBeGreaterThan(0);
    expect(layout.leftRegion).toBe(0);
  });

  test("moving back UP the ladder bulges left (returning)", () => {
    const accounts = [account("a", -100_00), account("b", 100_00)];
    const edges = [edge("a", "b", 100_00), edge("b", "a", 40_00)];
    const layout = computeSpineLayout(data({ accounts, edges }), "gross", OPTS);

    const back = layout.arcs.find((x) => x.id === "b>a")!;
    expect(back.isOnward).toBe(false);
    expect(layout.leftRegion).toBeGreaterThan(0);
  });

  test("switching gross → net empties the left region", () => {
    const accounts = [account("a", -60_00), account("b", 60_00)];
    const grossEdges = [edge("a", "b", 100_00), edge("b", "a", 40_00)];
    const netEdges = [{ ...edge("a", "b", 60_00, 2), grossCents: 100_00, returnedCents: 40_00 }];
    const d = data({ accounts, edges: grossEdges, netEdges });

    expect(computeSpineLayout(d, "gross", OPTS).leftRegion).toBeGreaterThan(0);
    expect(computeSpineLayout(d, "net", OPTS).leftRegion).toBe(0);
    expect(computeSpineLayout(d, "net", OPTS).arcs).toHaveLength(1);
  });
});

describe("bulge depends on SPAN only", () => {
  test("two edges of very different value spanning the same distance share a curve", () => {
    const accounts = [account("a", -100_00), account("b", 0), account("c", 100_00)];
    const edges = [edge("a", "b", 90_000_00), edge("b", "c", 1_00)];
    const layout = computeSpineLayout(data({ accounts, edges }), "gross", OPTS);

    const wide = layout.arcs.find((x) => x.id === "a>b")!;
    const thin = layout.arcs.find((x) => x.id === "b>c")!;
    // same span ⇒ same horizontal extent; only the stroke differs
    expect(wide.labelX).toBe(thin.labelX);
    expect(wide.width).toBeGreaterThan(thin.width);
  });

  test("a longer span bulges further than a shorter one", () => {
    const accounts = [account("a", -100_00), account("b", 0), account("c", 100_00)];
    const edges = [edge("a", "c", 10_00), edge("a", "b", 10_00)];
    const layout = computeSpineLayout(data({ accounts, edges }), "gross", OPTS);

    const long = layout.arcs.find((x) => x.id === "a>c")!;
    const short = layout.arcs.find((x) => x.id === "a>b")!;
    expect(long.labelX).toBeGreaterThan(short.labelX);
  });

  test("changing only the amounts leaves every path string untouched", () => {
    // A second, larger edge keeps the width scale non-degenerate — with one edge
    // alone `cents === maxCents`, so it is correctly always drawn at max stroke
    // and the width could not vary no matter what the amount was.
    const accounts = [account("a", -100_00), account("b", 0), account("c", 100_00)];
    const anchor = edge("a", "c", 1_000_00);
    const before = computeSpineLayout(
      data({ accounts, edges: [edge("a", "b", 10_00), anchor] }),
      "gross",
      OPTS,
    );
    const after = computeSpineLayout(
      data({ accounts, edges: [edge("a", "b", 900_00), anchor] }),
      "gross",
      OPTS,
    );

    const pathOf = (l: typeof before, id: string) => l.arcs.find((x) => x.id === id)!.path;
    const widthOf = (l: typeof before, id: string) => l.arcs.find((x) => x.id === id)!.width;

    // geometry is pinned to the node span, so it cannot move
    expect(pathOf(after, "a>b")).toBe(pathOf(before, "a>b"));
    expect(pathOf(after, "a>c")).toBe(pathOf(before, "a>c"));
    // only the stroke responds to the money
    expect(widthOf(after, "a>b")).toBeGreaterThan(widthOf(before, "a>b"));
  });
});

describe("the two encodings stay independent", () => {
  test("width tracks dollars", () => {
    const accounts = [account("a", -100_00), account("b", 0), account("c", 100_00)];
    const edges = [edge("a", "b", 100_00, 5), edge("b", "c", 1_00, 5)];
    const layout = computeSpineLayout(data({ accounts, edges }), "gross", OPTS);
    expect(layout.arcs.find((x) => x.id === "a>b")!.width).toBeGreaterThan(
      layout.arcs.find((x) => x.id === "b>c")!.width,
    );
  });

  test("dash gap tracks COUNT, not dollars — the 299-vs-23 case", () => {
    // near-identical money, opposite behaviour: this is the whole reason the
    // cadence channel exists
    const accounts = [account("a", -100_00), account("b", 0), account("c", 100_00)];
    const edges = [edge("a", "b", 97_921_99, 299), edge("b", "c", 78_995_61, 23)];
    const layout = computeSpineLayout(data({ accounts, edges }), "gross", OPTS);

    const busy = layout.arcs.find((x) => x.id === "a>b")!;
    const rare = layout.arcs.find((x) => x.id === "b>c")!;
    expect(busy.dashGap).toBeLessThan(rare.dashGap); // tighter cadence = busier
    expect(Math.abs(busy.width - rare.width)).toBeLessThan(6); // similar money
  });

  test("a one-transfer edge is solid, not dashed", () => {
    const layout = computeSpineLayout(data(), "gross", OPTS);
    expect(layout.arcs[0]!.dashGap).toBe(0);
  });
});

describe("degenerate states", () => {
  test("no edges: no arcs, no regions, and no crash", () => {
    const layout = computeSpineLayout(data({ edges: [], netEdges: [] }), "gross", OPTS);
    expect(layout.arcs).toEqual([]);
    expect(layout.leftRegion).toBe(0);
    expect(layout.rightRegion).toBe(0);
  });

  test("no accounts at all", () => {
    const layout = computeSpineLayout(
      data({ accounts: [], edges: [], netEdges: [] }),
      "gross",
      OPTS,
    );
    expect(layout.nodes).toEqual([]);
    expect(layout.height).toBeGreaterThan(0);
  });

  test("a single edge does not divide by zero on maxSpan", () => {
    const layout = computeSpineLayout(data(), "gross", OPTS);
    expect(Number.isFinite(layout.arcs[0]!.labelX)).toBe(true);
    expect(layout.arcs[0]!.path).not.toContain("NaN");
  });

  test("an edge naming an unknown account is skipped, never guessed", () => {
    const layout = computeSpineLayout(
      data({ edges: [edge("a", "b", 10_00), edge("a", "ghost", 10_00)] }),
      "gross",
      OPTS,
    );
    expect(layout.arcs.map((x) => x.id)).toEqual(["a>b"]);
  });
});

describe("everything fits, and nothing sits on top of anything else", () => {
  // These are the two defects the first version shipped: node labels drawn
  // under the returning arcs, and lobes running off the canvas. Neither was
  // visible to any assertion above — only to a screenshot.
  const busy = () => {
    const accounts = [
      account("a", -300_00),
      account("b", -100_00),
      account("c", 0),
      account("d", 50_00),
      account("e", 150_00),
      account("f", 200_00),
    ];
    const edges = [
      edge("a", "f", 500_00, 40),
      edge("f", "a", 200_00, 12),
      edge("b", "e", 300_00, 9),
      edge("e", "b", 90_00, 3),
      edge("c", "d", 40_00, 2),
    ];
    return data({ accounts, edges });
  };

  for (const width of [320, 375, 440, 768, 1024, 1440, 2560]) {
    test(`@${width}: labels clear the return region and no lobe leaves the canvas`, () => {
      const layout = computeSpineLayout(busy(), "gross", { width });

      // the label anchor is to the LEFT of every returning lobe
      for (const n of layout.nodes) {
        expect(n.labelX).toBeLessThanOrEqual(layout.spineX - layout.leftRegion);
        expect(n.labelX).toBeGreaterThanOrEqual(0);
      }
      // and both lobe regions are inside the canvas
      expect(layout.spineX - layout.leftRegion).toBeGreaterThanOrEqual(0);
      expect(layout.spineX + layout.rightRegion).toBeLessThanOrEqual(width);
    });
  }

  test("a label gutter is reserved even when nothing returns", () => {
    const accounts = [account("a", -100_00), account("b", 100_00)];
    const layout = computeSpineLayout(
      data({ accounts, edges: [edge("a", "b", 100_00)] }),
      "gross",
      { width: 900 },
    );
    expect(layout.leftRegion).toBe(0);
    expect(layout.spineX).toBeGreaterThan(0); // room for the account names
    expect(layout.nodes[0]!.labelX).toBeGreaterThan(0);
  });

  test("lobes grow to use the canvas, and stop growing once capped", () => {
    const narrow = computeSpineLayout(busy(), "gross", { width: 480 });
    const wide = computeSpineLayout(busy(), "gross", { width: 1440 });
    expect(wide.rightRegion).toBeGreaterThan(narrow.rightRegion);

    // past the cap the geometry stops stretching, so an ultrawide window does
    // not flatten the lobes into indistinguishable sweeps
    const huge = computeSpineLayout(busy(), "gross", { width: 2560 });
    const huger = computeSpineLayout(busy(), "gross", { width: 4000 });
    expect(huger.rightRegion).toBe(huge.rightRegion);
  });

  test("a wide canvas is actually used, not left half empty", () => {
    const layout = computeSpineLayout(busy(), "gross", { width: 1200 });
    const used = layout.spineX + layout.rightRegion;
    expect(used / 1200).toBeGreaterThan(0.7);
  });

  test("height follows the account count so the last node is never clipped", () => {
    const layout = computeSpineLayout(busy(), "gross", { width: 900 });
    const lastY = Math.max(...layout.nodes.map((n) => n.y));
    expect(lastY).toBeLessThanOrEqual(layout.height);
  });
});

describe("compact mode", () => {
  test("narrow viewports shrink the lobes so they stay on screen", () => {
    const wide = computeSpineLayout(data(), "gross", { width: 900 });
    const narrow = computeSpineLayout(data(), "gross", { width: 380 });

    expect(narrow.compact).toBe(true);
    expect(wide.compact).toBe(false);
    expect(narrow.rightRegion).toBeLessThan(wide.rightRegion);
  });

  test("every arc stays within the canvas at 320px", () => {
    const accounts = [account("a", -100_00), account("b", 0), account("c", 100_00)];
    const edges = [edge("a", "c", 100_00), edge("c", "a", 20_00)];
    const layout = computeSpineLayout(data({ accounts, edges }), "gross", { width: 320 });

    expect(layout.spineX - layout.leftRegion).toBeGreaterThanOrEqual(0);
    expect(layout.spineX + layout.rightRegion).toBeLessThanOrEqual(320);
  });
});

describe("spineDescription", () => {
  test("states the totals, the churn and both extremes", () => {
    const d = data({
      accounts: [account("chase", -112_880_48, { label: "Chase Checking" }), account("sofi", 112_880_48, { label: "SoFi Checking" })],
      edges: [edge("chase", "sofi", 330_513_57, 516)],
    });
    const desc = spineDescription(
      { ...d, totals: { ...d.totals, churnCents: 96_482_26, netCents: 234_031_31, pairedGroupCount: 516 } },
      fmt,
    );

    expect(desc).toContain("$330,513.57 moved between 2 accounts");
    expect(desc).toContain("across 516 transfers");
    expect(desc).toContain("$96,482.26");
    expect(desc).toContain("Chase Checking");
    expect(desc).toContain("SoFi Checking");
  });

  test("names the unattributed remainder rather than hiding it", () => {
    const d = data();
    const desc = spineDescription(
      {
        ...d,
        totals: { ...d.totals, unattributedGroupCount: 134, unattributedCents: 50_390_97 },
      },
      fmt,
    );
    expect(desc).toContain("134 further transfer groups");
    expect(desc).toContain("$50,390.97");
  });

  test("the empty state reads as a sentence, not a blank", () => {
    expect(spineDescription(data({ edges: [], netEdges: [] }), fmt)).toBe(
      "No transfers between your accounts in this period.",
    );
  });
});

/**
 * Degenerate inputs. Every guard below is a real `?:` or early return in the
 * layout, and each was previously unexercised — invisible in the coverage text
 * report, which only lists files with uncovered LINES and so never showed a file
 * whose gaps are all branches.
 *
 * These are not hypothetical shapes. A period in which every account's inflows
 * exactly cancel its outflows makes every `netCents` zero, and that is the
 * ordinary result of a pure round-trip month.
 */
describe("degenerate data", () => {
  test("all-zero net balances give every node zero weight instead of dividing by zero", () => {
    const layout = computeSpineLayout(
      data({
        accounts: [account("a", 0), account("b", 0)],
        edges: [edge("a", "b", 100_00)],
        netEdges: [edge("a", "b", 100_00)],
      }),
      "gross",
      { width: 900 },
    );
    expect(layout.nodes).toHaveLength(2);
    for (const n of layout.nodes) {
      expect(n.weight).toBe(0);
      expect(Number.isFinite(n.radius)).toBe(true);
      expect(n.radius).toBeGreaterThan(0); // a zero-weight node still has to be visible
    }
  });

  test("a zero-dollar edge draws at the minimum stroke, not at zero or NaN", () => {
    const layout = computeSpineLayout(
      data({
        accounts: [account("a", 0), account("b", 0)],
        edges: [edge("a", "b", 0)],
        netEdges: [edge("a", "b", 0)],
      }),
      "gross",
      { width: 900 },
    );
    expect(layout.arcs).toHaveLength(1);
    expect(layout.arcs[0]!.width).toBe(2); // MIN_STROKE
  });

  test("a self-referential edge has zero span and still produces a finite path", () => {
    // span = |toIdx - fromIdx| = 0, so maxSpan is 0 and the bulge ratio would be
    // 0/0 without its guard. The detector does not emit self-transfers today, but
    // the type permits one and a NaN in a path string blanks the whole chart.
    const layout = computeSpineLayout(
      data({
        accounts: [account("a", -100_00), account("b", 100_00)],
        edges: [edge("a", "a", 100_00)],
        netEdges: [edge("a", "a", 100_00)],
      }),
      "gross",
      { width: 900 },
    );
    expect(layout.arcs).toHaveLength(1);
    expect(layout.arcs[0]!.path).not.toContain("NaN");
    // "M x y C x1 y1, x2 y2, x y" — every coordinate a finite number
    expect(layout.arcs[0]!.path).toMatch(/^M -?[\d.]+ -?[\d.]+ C( -?[\d.]+ -?[\d.]+,?){3}$/);
  });

  test("zero gross with edges present reports 0% churn rather than NaN%", () => {
    const d = data({ edges: [edge("a", "b", 0)], netEdges: [edge("a", "b", 0)] });
    const text = spineDescription({ ...d, totals: { ...d.totals, grossCents: 0, churnCents: 0 } }, fmt);
    expect(text).not.toContain("NaN");
    expect(text).toContain("(0%)");
  });
});

/*
 * 🔴 The label divided an account's NET by the whole ledger's GROSS and
 * announced the result as its share of that gross. Real figures, /flow's Table
 * lens, 2026-09-11: Chase Checking sent $172,517.92 of the $415,945.05 that
 * moved between these accounts — 41.5% — and was announced as "33%". The eight
 * labels summed to 91.06% and can never sum to 100, because account nets sum
 * to zero.
 */
describe("spineNodeLabel", () => {
  const ledger = () =>
    data({
      accounts: [
        account("chase", -136_433_19, { label: "Chase Checking", inCents: 36_084_73, outCents: 172_517_92 }),
        account("wf", -1_096_97, { label: "Wells Fargo Everyday Checking", inCents: 225_00, outCents: 1_321_97 }),
        account("sofi", 34_433_89, { label: "SoFi Checking", inCents: 103_694_88, outCents: 69_260_99 }),
      ],
      // the single edge exists only to make totals.grossCents the real figure
      edges: [edge("chase", "sofi", 415_945_05, 753)],
    });

  const nodeFor = (d: TransferFlowData, id: string) => {
    const n = computeSpineLayout(d, "gross", OPTS).nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  };

  test("the share is the LEG the sentence names, over the gross it names", () => {
    const d = ledger();
    expect(spineNodeLabel(nodeFor(d, "chase"), d, fmt)).toBe(
      "Chase Checking, net source -$136,433.19 — sent $172,517.92, received $36,084.73;" +
        " 41.5% of the $415,945.05 that moved between these 3 accounts left from here — view transactions",
    );
    // a net destination is measured by what ARRIVED
    expect(spineNodeLabel(nodeFor(d, "sofi"), d, fmt)).toBe(
      "SoFi Checking, net destination $34,433.89 — sent $69,260.99, received $103,694.88;" +
        " 24.9% of the $415,945.05 that moved between these 3 accounts arrived here — view transactions",
    );
  });

  test("a share under a tenth of a percent is not rounded to a measured zero", () => {
    const d = ledger();
    // $1,321.97 of $415,945.05 is 0.3178% — `Math.round(x * 100)` printed "0%"
    expect(spineNodeLabel(nodeFor(d, "wf"), d, fmt)).toContain("0.3% of the $415,945.05");
    expect(spineNodeLabel(nodeFor(d, "wf"), d, fmt)).not.toContain("0% of");
  });

  test("no volume means no share at all, rather than a 0% that states a measurement", () => {
    const d = data({
      accounts: [account("a", 0, { label: "A", inCents: 0, outCents: 0 })],
      edges: [],
    });
    const n = computeSpineLayout(d, "gross", OPTS).nodes[0]!;
    expect(spineNodeLabel(n, d, fmt)).toBe("A, net flat $0.00 — sent $0.00, received $0.00 — view transactions");
  });
});
