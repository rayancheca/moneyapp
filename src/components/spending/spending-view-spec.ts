import { type ViewSpec } from "@/lib/view-state";

/**
 * The /spending surface's switchable-view registry (NS#2 Pillar 2). Starts with
 * the cash-flow card's renderer — chart or raw-number table — and grows here as
 * more lenses (donut, stacked, group-by, framing) land, one dimension at a time.
 */
export const SPENDING_SURFACE = "spending";

/** the cash-flow card: the composition chart, cumulative-line graph, a
 *  money-flow Sankey, or the same numbers as a table — one dataset, several
 *  lenses, always reconciling */
export const CASH_VIEW_SPEC: ViewSpec = [{ key: "cash", options: ["chart", "graph", "sankey", "table"] }];

export const CASH_VIEW_LABELS: Record<string, string> = {
  chart: "Chart",
  graph: "Graph",
  sankey: "Sankey",
  table: "Table",
};
