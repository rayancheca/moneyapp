import { type ViewSpec } from "@/lib/view-state";

/**
 * The /investments portfolio chart's switchable-view registry (NS#2 Pillar 2).
 * The hero chart flips between the raw VALUE line (positions market value — it
 * climbs with every deposit) and the flow-adjusted RETURN line (deposits removed,
 * so only market P/L moves it — the Robinhood-style performance view). Grows here
 * as more lenses land (benchmark overlay, $/% framing), one dimension at a time.
 */
export const INVESTMENTS_SURFACE = "investments";

/** the portfolio hero: market value, or flow-adjusted return (deposits stripped) */
export const PORTFOLIO_VIEW_SPEC: ViewSpec = [{ key: "view", options: ["value", "returns"] }];

export const PORTFOLIO_VIEW_LABELS: Record<string, string> = { value: "Value", returns: "Return" };
