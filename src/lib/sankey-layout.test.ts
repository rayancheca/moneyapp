import { describe, expect, test } from "vitest";
import { computeSankeyLayout, type SankeyGraph, type SankeyLinkInput, type SankeyNodeInput } from "./sankey-layout";

const OPTS = { width: 800, height: 400 } as const;

/** a balanced 4-column flow: two income sources → hub → two categories → subcats */
function balancedFlow(): SankeyGraph {
  return {
    nodes: [
      { id: "inc:salary", label: "Salary", column: 0, color: "var(--cat-green)" },
      { id: "inc:cash", label: "Cash", column: 0, color: "var(--cat-lime)" },
      { id: "hub", label: "Total income", column: 1 },
      { id: "cat:food", label: "Food", column: 2, color: "var(--cat-orange)", href: "/x" },
      { id: "cat:rent", label: "Housing", column: 2, color: "var(--cat-blue)" },
      { id: "sub:groceries", label: "Groceries", column: 3 },
      { id: "sub:dining", label: "Dining", column: 3 },
    ],
    links: [
      { source: "inc:salary", target: "hub", valueCents: 6000 },
      { source: "inc:cash", target: "hub", valueCents: 4000 },
      { source: "hub", target: "cat:food", valueCents: 3000 },
      { source: "hub", target: "cat:rent", valueCents: 7000 },
      { source: "cat:food", target: "sub:groceries", valueCents: 1800 },
      { source: "cat:food", target: "sub:dining", valueCents: 1200 },
    ],
  };
}

describe("computeSankeyLayout — degenerate inputs", () => {
  test("empty graph returns an empty, zero-column layout", () => {
    const l = computeSankeyLayout({ nodes: [], links: [] }, OPTS);
    expect(l.nodes).toEqual([]);
    expect(l.links).toEqual([]);
    expect(l.columns).toBe(0);
    expect(l.width).toBe(800);
    expect(l.height).toBe(400);
  });

  test("single node, no links: value 0, centred horizontally, one column", () => {
    const l = computeSankeyLayout({ nodes: [{ id: "a", label: "A" }], links: [] }, OPTS);
    expect(l.columns).toBe(1);
    expect(l.nodes).toHaveLength(1);
    const a = l.nodes[0]!;
    expect(a.valueCents).toBe(0);
    // single column → centred: x0 = (width - nodeWidth) / 2 = (800 - 16) / 2
    expect(a.x0).toBe((800 - 16) / 2);
    expect(a.x1).toBe(a.x0 + 16);
    // no links → ky is 0 (non-finite guard) → zero-height node
    expect(a.y1 - a.y0).toBe(0);
  });

  test("height too small to fit padding clamps ky and start-y to 0 (no negative coords)", () => {
    const graph: SankeyGraph = {
      nodes: [
        { id: "a", label: "A", column: 0 },
        { id: "b", label: "B", column: 0 },
        { id: "c", label: "C", column: 0 },
        { id: "sink", label: "S", column: 1 },
      ],
      links: [
        { source: "a", target: "sink", valueCents: 100 },
        { source: "b", target: "sink", valueCents: 100 },
        { source: "c", target: "sink", valueCents: 100 },
      ],
    };
    // height 10 < padding*(3-1) = 28 → avail negative → ky clamps to 0
    const l = computeSankeyLayout(graph, { width: 200, height: 10 });
    for (const n of l.nodes) {
      expect(n.y0).toBeGreaterThanOrEqual(0);
      expect(n.y1 - n.y0).toBe(0);
      expect(n.y1).toBeLessThanOrEqual(10 + 1e-6); // never escapes the canvas
    }
  });

  test("a crowded column (more nodes than padding fits) stays inside the canvas", () => {
    // regression: 15 destinations at the 200px floor with 16px padding — before
    // the gap-compression fix the padding alone (14×16=224) marched the last
    // node to y=224, 24px past the bottom edge (SVG is overflow-visible)
    const nodes: SankeyNodeInput[] = [{ id: "hub", label: "Hub", column: 0 }];
    const links: SankeyLinkInput[] = [];
    for (let i = 0; i < 15; i += 1) {
      nodes.push({ id: `c${i}`, label: `Category ${i}`, column: 1 });
      links.push({ source: "hub", target: `c${i}`, valueCents: 100 + i });
    }
    const l = computeSankeyLayout({ nodes, links }, { width: 400, height: 200, nodePadding: 16 });
    for (const n of l.nodes) {
      expect(n.y0).toBeGreaterThanOrEqual(-1e-6);
      expect(n.y1).toBeLessThanOrEqual(200 + 1e-6);
    }
  });
});

describe("computeSankeyLayout — link filtering", () => {
  test("drops links with dangling endpoints and non-positive/NaN values", () => {
    const graph: SankeyGraph = {
      nodes: [
        { id: "a", label: "A", column: 0 },
        { id: "b", label: "B", column: 1 },
      ],
      links: [
        { source: "a", target: "b", valueCents: 500 }, // kept
        { source: "a", target: "ghost", valueCents: 100 }, // dangling target
        { source: "ghost", target: "b", valueCents: 100 }, // dangling source
        { source: "a", target: "b", valueCents: 0 }, // zero
        { source: "a", target: "b", valueCents: -50 }, // negative
        { source: "a", target: "b", valueCents: Number.NaN }, // NaN
      ],
    };
    const l = computeSankeyLayout(graph, OPTS);
    expect(l.links).toHaveLength(1);
    expect(l.links[0]!.valueCents).toBe(500);
  });
});

describe("computeSankeyLayout — column derivation", () => {
  test("derives columns by longest path when none are pinned", () => {
    const graph: SankeyGraph = {
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      links: [
        { source: "a", target: "b", valueCents: 100 },
        { source: "b", target: "c", valueCents: 100 },
      ],
    };
    const l = computeSankeyLayout(graph, OPTS);
    expect(l.columns).toBe(3);
    const col = Object.fromEntries(l.nodes.map((n) => [n.id, n.column]));
    expect(col).toEqual({ a: 0, b: 1, c: 2 });
  });

  test("longest path wins when a node has two source depths", () => {
    // a→c (depth1) and a→b→c (depth2): c must land at column 2
    const graph: SankeyGraph = {
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      links: [
        { source: "a", target: "b", valueCents: 100 },
        { source: "a", target: "c", valueCents: 100 },
        { source: "b", target: "c", valueCents: 100 },
      ],
    };
    const l = computeSankeyLayout(graph, OPTS);
    const col = Object.fromEntries(l.nodes.map((n) => [n.id, n.column]));
    expect(col.c).toBe(2);
  });

  test("a pinned column gap leaves an empty middle column (skipped by the scale)", () => {
    const graph: SankeyGraph = {
      nodes: [
        { id: "a", label: "A", column: 0 },
        { id: "c", label: "C", column: 2 },
      ],
      links: [{ source: "a", target: "c", valueCents: 100 }],
    };
    const l = computeSankeyLayout(graph, OPTS);
    expect(l.columns).toBe(3);
    // both nodes have real height (the empty column 1 didn't starve the scale)
    for (const n of l.nodes) expect(n.y1 - n.y0).toBeGreaterThan(0);
  });
});

describe("computeSankeyLayout — geometry & conservation", () => {
  const layout = computeSankeyLayout(balancedFlow(), OPTS);
  const node = (id: string) => layout.nodes.find((n) => n.id === id)!;

  test("four columns, spread across the width", () => {
    expect(layout.columns).toBe(4);
    expect(node("inc:salary").x0).toBe(0);
    expect(node("sub:dining").x1).toBe(800);
  });

  test("carries node metadata through (colour, href, value)", () => {
    expect(node("inc:salary").color).toBe("var(--cat-green)");
    expect(node("cat:food").href).toBe("/x");
    // hub throughput = max(in 10000, out 10000)
    expect(node("hub").valueCents).toBe(10000);
    expect(node("inc:salary").valueCents).toBe(6000);
  });

  test("all nodes stay within the viewport", () => {
    for (const n of layout.nodes) {
      expect(n.x0).toBeGreaterThanOrEqual(0);
      expect(n.x1).toBeLessThanOrEqual(800 + 1e-6);
      expect(n.y0).toBeGreaterThanOrEqual(-1e-6);
      expect(n.y1).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  test("on every face the ribbon widths sum to the node height (money conserved)", () => {
    for (const n of layout.nodes) {
      const outW = layout.links.filter((l) => l.source === n.id).reduce((s, l) => s + l.width, 0);
      const inW = layout.links.filter((l) => l.target === n.id).reduce((s, l) => s + l.width, 0);
      const h = n.y1 - n.y0;
      if (outW > 0) expect(outW).toBeCloseTo(h, 5);
      if (inW > 0) expect(inW).toBeCloseTo(h, 5);
    }
  });

  test("ribbon width is proportional to value under the shared scale", () => {
    const food = layout.links.find((l) => l.target === "cat:food")!;
    const rent = layout.links.find((l) => l.target === "cat:rent")!;
    // hub→rent is 7000, hub→food is 3000 → widths in the same ratio
    expect(rent.width / food.width).toBeCloseTo(7000 / 3000, 5);
  });

  test("links inherit their source node colour and carry a well-formed bezier path", () => {
    const food = layout.links.find((l) => l.source === "cat:food" && l.target === "sub:groceries")!;
    expect(food.color).toBe("var(--cat-orange)"); // inherited from cat:food
    expect(food.path).toMatch(/^M[\d.]+,[\d.]+C[\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
    // path begins at the source's right face (rounded to 2dp by the renderer)
    const startX = Number.parseFloat(food.path.slice(1).split(",")[0]!);
    expect(startX).toBeCloseTo(node("cat:food").x1, 1);
  });

  test("a link can override the inherited colour", () => {
    const graph: SankeyGraph = {
      nodes: [
        { id: "a", label: "A", column: 0, color: "red" },
        { id: "b", label: "B", column: 1 },
      ],
      links: [{ source: "a", target: "b", valueCents: 100, color: "blue" }],
    };
    const l = computeSankeyLayout(graph, OPTS);
    expect(l.links[0]!.color).toBe("blue");
  });
});

describe("computeSankeyLayout — ordering", () => {
  test("barycentre ordering reduces crossings; equal centres fall back to input order", () => {
    // two sources feed two targets straight across; targets should keep the
    // order that matches their sources (no crossing)
    const graph: SankeyGraph = {
      nodes: [
        { id: "s0", label: "S0", column: 0 },
        { id: "s1", label: "S1", column: 0 },
        { id: "t0", label: "T0", column: 1 },
        { id: "t1", label: "T1", column: 1 },
      ],
      links: [
        { source: "s0", target: "t0", valueCents: 100 },
        { source: "s1", target: "t1", valueCents: 100 },
      ],
    };
    const l = computeSankeyLayout(graph, OPTS);
    const t0 = l.nodes.find((n) => n.id === "t0")!;
    const t1 = l.nodes.find((n) => n.id === "t1")!;
    const s0 = l.nodes.find((n) => n.id === "s0")!;
    const s1 = l.nodes.find((n) => n.id === "s1")!;
    // s0 above s1 (input order) → t0 above t1 (barycentre follows)
    expect(s0.y0).toBeLessThan(s1.y0);
    expect(t0.y0).toBeLessThan(t1.y0);
  });

  test("orders a later-column node that has no incoming links (barycentre falls back to its own y)", () => {
    // `b` is pinned into column 1 but is a pure source (only outgoing) — the
    // barycentre order must still place it without dividing by zero neighbours.
    // column 1 holds TWO nodes so the sort comparator actually runs: `b` is a
    // pure source (no incoming, hits the barycentre fallback), `d` has incoming.
    const graph: SankeyGraph = {
      nodes: [
        { id: "a", label: "A", column: 0 },
        { id: "b", label: "B", column: 1 },
        { id: "d", label: "D", column: 1 },
        { id: "c", label: "C", column: 2 },
      ],
      links: [
        { source: "a", target: "d", valueCents: 100 },
        { source: "b", target: "c", valueCents: 60 },
        { source: "d", target: "c", valueCents: 100 },
      ],
    };
    const l = computeSankeyLayout(graph, OPTS);
    const b = l.nodes.find((n) => n.id === "b")!;
    expect(b.column).toBe(1);
    expect(b.y0).toBeGreaterThanOrEqual(0);
  });

  test("respects explicit nodeWidth and nodePadding options", () => {
    const l = computeSankeyLayout(balancedFlow(), { width: 800, height: 400, nodeWidth: 24, nodePadding: 8 });
    const salary = l.nodes.find((n) => n.id === "inc:salary")!;
    expect(salary.x1 - salary.x0).toBe(24);
  });
});
