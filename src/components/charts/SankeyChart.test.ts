import { describe, expect, test } from "vitest";
import { formatCents } from "@/lib/money";
import { sankeySummary } from "./SankeyChart";

type Node = { column: number; valueCents: number; meta?: { kind?: string } };

const income = (cents: number): Node => ({ column: 0, valueCents: cents, meta: { kind: "income" } });
const cat = (cents: number): Node => ({ column: 2, valueCents: cents, meta: { kind: "category" } });
const plug = (cents: number): Node => ({ column: 0, valueCents: cents, meta: { kind: "drawdown" } });

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
