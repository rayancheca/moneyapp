import { describe, expect, test } from "vitest";
import { formatCents } from "@/lib/money";
import { sankeyFrameNote, sankeyNodeLabel, sankeySummary } from "./SankeyChart";

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

describe("sankeyNodeLabel", () => {
  const share = () => "26.7%";

  test("a spending destination says which frame its figure is in", () => {
    expect(sankeyNodeLabel({ label: "Housing", valueCents: 276_379, meta: { kind: "category" } }, formatCents, share)).toBe(
      "Housing, $2,763.79 charged, 26.7% of the flow — view transactions",
    );
    // the honesty bucket is a spending destination too
    expect(
      sankeyNodeLabel({ label: "Uncategorized", valueCents: 4_24, meta: { kind: "uncategorized" } }, formatCents, share),
    ).toContain("$4.24 charged");
  });

  test("a source is not 'charged', and every node names what its percent is OF", () => {
    expect(sankeyNodeLabel({ label: "Salary", valueCents: 500_000, meta: { kind: "income" } }, formatCents, share)).toBe(
      "Salary, $5,000.00, 26.7% of the flow — view transactions",
    );
    expect(sankeyNodeLabel({ label: "Refunds", valueCents: 11_311, meta: { kind: "refund" } }, formatCents, share)).toBe(
      "Refunds, $113.11, 26.7% of the flow — view transactions",
    );
  });
});
