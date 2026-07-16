import { type ViewSpec } from "@/lib/view-state";

/**
 * The /investments portfolio chart's switchable-view registry (NS#2 Pillar 2).
 * The hero chart flips between the raw VALUE line (positions market value — it
 * climbs with every deposit) and the flow-adjusted RETURN line (deposits removed,
 * so only market P/L moves it — the Robinhood-style performance view). The RETURN
 * view has a second `unit` dimension: dollars (cumulative flow-adjusted P/L) or
 * percent (compounding time-weighted return). Grows here one dimension at a time.
 */
export const INVESTMENTS_SURFACE = "investments";

/**
 * The portfolio hero dimensions:
 * - `view`: market value, or flow-adjusted return (deposits stripped)
 * - `unit`: (return view only) dollar P/L, or time-weighted percent
 */
export const PORTFOLIO_VIEW_SPEC: ViewSpec = [
  { key: "view", options: ["value", "returns"] },
  { key: "unit", options: ["dollar", "percent"] },
];

export const PORTFOLIO_VIEW_LABELS: Record<string, string> = { value: "Value", returns: "Return" };
export const PORTFOLIO_UNIT_LABELS: Record<string, string> = { dollar: "$", percent: "%" };
