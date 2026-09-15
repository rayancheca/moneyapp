import { describe, expect, test } from "vitest";
import { formatCents } from "@/lib/money";
import {
  sankeyFrameNote,
  sankeyLinkSide,
  sankeyNodeLabel,
  sankeyNodeSide,
  sankeyShareCell,
  sankeyShareClause,
  sankeySummary,
} from "./SankeyChart";

type Node = { column: number; valueCents: number; meta?: { kind?: string } };

const income = (cents: number): Node => ({ column: 0, valueCents: cents, meta: { kind: "income" } });
const cat = (cents: number): Node => ({ column: 2, valueCents: cents, meta: { kind: "category" } });
const plug = (cents: number): Node => ({ column: 0, valueCents: cents, meta: { kind: "drawdown" } });
const refund = (cents: number): Node => ({ column: 0, valueCents: cents, meta: { kind: "refund" } });

const say = (nodes: Node[], totalFlow: number) =>
  sankeySummary(nodes, totalFlow, "Money flow for All time", formatCents);

/**
 * 🔴 `sankey.ts` adds the `drawdown` node — "From outside this period" — only
 * when the window spent more than its recorded income, and its own comment says
 * "all this node knows is that the balancing amount came from outside it."
 * The summary counted it among the sources and folded its cents into "flows in".
 *
 * Measured 2026-09-10 over all time: Earned $117,925.41 + Refunds $7,031.51 =
 * $124,956.92 actually came in, and the sentence said "$176,762.37 flows in
 * from 9 sources" — the GROSS SPEND, which the stat card beside it labels
 * "Spent". 117,925.41 + 7,031.51 + 51,805.45 = 176,762.37.
 */
describe("sankeySummary", () => {
  test("a window that lived within its income names only what came in", () => {
    expect(say([income(10_000), income(5_000), cat(9_000), cat(6_000)], 15_000)).toBe(
      "Money flow for All time: $150.00 flows in from 2 sources across 2 spending categories.",
    );
  });

  test("the drawdown plug is neither a source nor money that flowed in", () => {
    const nodes = [income(11_792_541), income(703_151), plug(5_180_545), cat(17_676_237)];
    const out = say(nodes, 17_676_237);
    expect(out).toContain("$124,956.92 flows in from 2 sources");
    expect(out).not.toContain("$176,762.37 flows in");
    expect(out).not.toContain("3 sources");
  });

  test("and it says what the plug is, rather than hiding it", () => {
    const nodes = [income(11_792_541), income(703_151), plug(5_180_545), cat(17_676_237)];
    expect(say(nodes, 17_676_237)).toContain(
      "A further $51,805.45 is drawn from outside this period — it did not flow in.",
    );
  });

  test("no plug, no extra sentence", () => {
    expect(say([income(10_000), cat(9_000)], 10_000)).not.toContain("drawn from outside");
  });

  test("one source and one category are singular", () => {
    expect(say([income(10_000), cat(10_000)], 10_000)).toBe(
      "Money flow for All time: $100.00 flows in from 1 source across 1 spending category.",
    );
  });
});

/*
 * ⚖️ OWNER DECISION 2026-09-11. One page, one month, two figures for Housing:
 * `/spending?period=2026-07` drew **$2,763.79 · 26.7%** here while the insight
 * sentence, the Where-it-went list, the relief, the table lens and every
 * `/categories` page read **$2,653.58 · 25.9%**. SQL over the Housing subtree
 * for July: gross out $2,763.79, refunds $110.21, net $2,653.58 over 7 rows —
 * so both are right, and the chart is self-consistent because it draws the
 * $113.11 that came back (110.21 + 2.90) as its own inflow. The figure was
 * right and the label was silent about its frame. He chose "Label the frame".
 */
describe("sankeyFrameNote", () => {
  test("names the frame and the refund that explains the difference", () => {
    expect(sankeyFrameNote([cat(276_379), refund(11_311)], formatCents)).toBe(
      "Categories here are what was charged. The $113.11 that came back is its own source rather " +
        "than a subtraction, so these run above the netted figures elsewhere.",
    );
  });

  test("no refund means gross IS net — a note explaining nothing is noise", () => {
    expect(sankeyFrameNote([income(10_000), cat(10_000)], formatCents)).toBeNull();
    expect(sankeyFrameNote([cat(10_000), refund(0)], formatCents)).toBeNull();
  });

  test("the summary carries it, because that is the <title> and the table caption", () => {
    expect(say([income(10_000), refund(11_311), cat(21_311)], 21_311)).toContain(
      "Categories here are what was charged.",
    );
    expect(say([income(10_000), cat(10_000)], 10_000)).not.toContain("what was charged");
  });
});

/*
 * 🔴 BOTH COLUMNS PARTITION THE SAME THROUGHPUT. The in-flow (income + refunds
 * + the drawdown plug) and the out-flow (categories + uncategorized + net
 * saved) are each the whole of it, so a bare "of the flow" on every node
 * invites an addition that comes to 200% — the identical defect fixed on the
 * transfer spine the same day, whose remedy was to make each share name its
 * leg. Caught by a second reader, not by a gate.
 */
describe("sankeyNodeLabel", () => {
  const share = () => "26.7%";
  const TOTAL = 1_035_396;

  test("a spending destination says which frame its figure is in, and which side", () => {
    expect(
      sankeyNodeLabel({ label: "Housing", valueCents: 276_379, column: 2, meta: { kind: "category" } }, formatCents, share, TOTAL),
    ).toBe(
      "Housing, $2,763.79 charged, 26.7% of the $10,353.96 that passed through, on the way out — view transactions",
    );
    // the honesty bucket is a spending destination too
    expect(
      sankeyNodeLabel({ label: "Uncategorized", valueCents: 4_24, column: 2, meta: { kind: "uncategorized" } }, formatCents, share, TOTAL),
    ).toContain("$4.24 charged, 26.7% of the $10,353.96 that passed through, on the way out");
  });

  test("a source is not 'charged', and says the other side", () => {
    expect(
      sankeyNodeLabel({ label: "Salary", valueCents: 500_000, column: 0, meta: { kind: "income" } }, formatCents, share, TOTAL),
    ).toBe(
      "Salary, $5,000.00, 26.7% of the $10,353.96 that passed through, on the way in — view transactions",
    );
  });

  test("the two sides never share a bare denominator, so nothing invites the 200% addition", () => {
    const out = sankeyNodeLabel({ label: "Housing", valueCents: 276_379, column: 2, meta: { kind: "category" } }, formatCents, share, TOTAL);
    const inn = sankeyNodeLabel({ label: "Salary", valueCents: 500_000, column: 0, meta: { kind: "income" } }, formatCents, share, TOTAL);
    expect(out).toContain("on the way out");
    expect(inn).toContain("on the way in");
    expect(out).not.toContain("of the flow —");
    expect(inn).not.toContain("of the flow —");
  });

  test("no throughput means no share at all, rather than a 0% that states a measurement", () => {
    expect(
      sankeyNodeLabel({ label: "Housing", valueCents: 0, column: 2, meta: { kind: "category" } }, formatCents, share, 0),
    ).toBe("Housing, $0.00 charged — view transactions");
  });
});

/*
 * 🔴 THE TOOLTIP AND THE TABLE LENS KEPT THE BARE SHARE. `sankeyNodeLabel` was
 * made to name its leg, and only the aria-label took it: the pointer tooltip on
 * the same node printed "26.7% of flow", and the dashboard's table lens printed
 * a Share column with no leg at all. Measured on the owner's ledger 2026-09-15,
 * `/spending?period=2026-07`: the left column's tooltips sum to 100.0%, the
 * right column's to 100.0%, and the table's Share column over its 17 flow rows
 * to 200.0% — structural, because every ribbon either enters or leaves the hub.
 */
describe("the side a share is on", () => {
  const nodes = [
    { id: "hub", column: 1, meta: { kind: "hub" } },
    { id: "inc:1", column: 0, meta: { kind: "income" } },
    { id: "refunds", column: 0, meta: { kind: "refund" } },
    { id: "drawdown", column: 0, meta: { kind: "drawdown" } },
    { id: "cat:1", column: 2, meta: { kind: "category" } },
    { id: "uncat", column: 2, meta: { kind: "uncategorized" } },
    { id: "saved", column: 2, meta: { kind: "saved" } },
  ];

  test("sources are on the way in; every destination, net saved included, on the way out", () => {
    expect(nodes.map((n) => sankeyNodeSide(n))).toEqual([null, "in", "in", "in", "out", "out", "out"]);
  });

  test("a ribbon is on the side of whichever end is not the hub", () => {
    expect(sankeyLinkSide({ source: "drawdown", target: "hub" }, nodes)).toBe("in");
    expect(sankeyLinkSide({ source: "hub", target: "cat:1" }, nodes)).toBe("out");
    expect(sankeyLinkSide({ source: "hub", target: "saved" }, nodes)).toBe("out");
  });

  test("net saved is money leaving the hub, and its label says so", () => {
    // it read "on the way in": the side was inferred from `kind === category`, and saved is not one
    expect(
      sankeyNodeLabel({ label: "Net saved", valueCents: 10_000, column: 2, meta: { kind: "saved" } }, formatCents, () => "1.0%", 1_000_000),
    ).toContain("on the way out");
  });
});

describe("sankeyShareClause — the tooltip's share line", () => {
  const share = () => "26.7%";
  const TOTAL = 1_035_396;

  test("names the denominator and the leg, in the aria-label's own words", () => {
    expect(sankeyShareClause(276_379, "out", formatCents, share, TOTAL)).toBe(
      "26.7% of the $10,353.96 that passed through, on the way out",
    );
    expect(sankeyShareClause(1_018_790, "in", formatCents, () => "98.4%", TOTAL)).toBe(
      "98.4% of the $10,353.96 that passed through, on the way in",
    );
  });

  test("the spoken label and the pointer tooltip are one clause, not two phrasings", () => {
    const node = { label: "Housing", valueCents: 276_379, column: 2, meta: { kind: "category" } };
    const clause = sankeyShareClause(node.valueCents, sankeyNodeSide(node), formatCents, share, TOTAL);
    expect(clause).not.toBeNull();
    expect(sankeyNodeLabel(node, formatCents, share, TOTAL)).toContain(clause!);
  });

  test("no throughput means no share line, rather than a 0% that states a measurement", () => {
    expect(sankeyShareClause(100, "in", formatCents, share, 0)).toBeNull();
  });

  test("the hub IS the throughput, so it has no share of it to state", () => {
    expect(sankeyShareClause(TOTAL, null, formatCents, share, TOTAL)).toBeNull();
  });
});

describe("sankeyShareCell — the table lens", () => {
  test("each row names its leg, so the column cannot be read as one 100%", () => {
    expect(sankeyShareCell(1_018_790, "in", () => "98.4%")).toBe("98.4% in");
    expect(sankeyShareCell(276_379, "out", () => "26.7%")).toBe("26.7% out");
  });
});
