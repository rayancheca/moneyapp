import { type ViewSpec } from "@/lib/view-state";

/**
 * The /spending surface's switchable-view registry (NS#2 Pillar 2). Starts with
 * the cash-flow card's renderer — chart or raw-number table — and grows here as
 * more lenses (donut, stacked, group-by, framing) land, one dimension at a time.
 */
export const SPENDING_SURFACE = "spending";

/** the cash-flow card: a vivid chart, or the same numbers as a table */
export const CASH_VIEW_SPEC: ViewSpec = [{ key: "cash", options: ["chart", "table"] }];

export const CASH_VIEW_LABELS: Record<string, string> = { chart: "Chart", table: "Table" };
