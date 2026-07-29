import type { DashboardMode } from "@/lib/multi-series";
import type { ViewSpec, ViewState } from "@/lib/view-state";

/**
 * The dashboard hero chart's switchable dimension (pass-17 ask C). Shared by
 * the RSC (resolves URL > persisted > default) and the client switcher —
 * no "use client" directive so the server page can import it without pulling
 * component code across the boundary. The per-account selection travels in a
 * sibling `accts` URL param (dynamic ids can't be enumerated as spec options)
 * and persists under the same surface key.
 */
export const DASHBOARD_SURFACE = "dashboard";

/**
 * `terrain` (Direction A+, "Two years of every account") is APPENDED, never a
 * replacement: it is a second DRAWING of the per-account series — one ribbon
 * per account over time, assets above the zero plane and what is owed below it.
 * It is therefore URL-addressable (`/?chart=terrain`) and persisted like every
 * other view, and it builds from mode "accounts" (see `dashboardSeriesMode`).
 */
export const DASHBOARD_VIEW_SPEC: ViewSpec = [
  {
    key: "chart",
    options: ["combined", "assets", "liabilities", "split", "accounts", "sankey", "terrain"],
  },
];

/**
 * Which net-worth SERIES mode a hero view is drawn from — the one place that
 * knows a view is not the same thing as a series:
 *
 *   · `combined` renders through the richer netWorthSummary path, and `sankey`
 *     draws its own flow, so neither builds a multi-series (null);
 *   · `terrain` draws the SAME per-account series as `accounts`, spatially;
 *   · everything else names its own mode.
 *
 * The page used to reach `dashboardChartData` through an `as DashboardMode`
 * cast justified by a comment ("adding a spec option without updating
 * DashboardMode would need updating here too"). This function is that comment,
 * enforced: a new spec option that is not a DashboardMode returns null here
 * rather than reaching the series builder as an unhandled string.
 */
export function dashboardSeriesMode(chart: string | undefined): DashboardMode | null {
  switch (chart) {
    case "assets":
    case "liabilities":
    case "split":
    case "accounts":
      return chart;
    case "terrain":
      return "accounts";
    default:
      return null;
  }
}

/** The hero view a resolved dashboard view-state is showing. */
export function dashboardChartView(state: ViewState): string {
  return state.chart ?? "combined";
}
