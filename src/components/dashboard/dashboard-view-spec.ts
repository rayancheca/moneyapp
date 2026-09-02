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
 * `bridge` is likewise APPENDED: it is not a drawing of the net-worth SERIES at
 * all but a decomposition of the DIFFERENCE between its two ends — earned, spent,
 * moved, market, in transit and whatever is left over. It builds no multi-series
 * (`dashboardSeriesMode` returns null) and, like `sankey`, carries its own range
 * pills because it has no scrubbable time axis.
 *
 * `terrain` (Direction A+, "Two years of every account") is APPENDED, never a
 * replacement: it is a second DRAWING of the per-account series — one ribbon
 * per account over time, assets above the zero plane and what is owed below it.
 * It is therefore URL-addressable (`/?chart=terrain`) and persisted like every
 * other view, and it builds from mode "accounts" (see `dashboardSeriesMode`).
 */
/**
 * How the twelve decision cards are laid out.
 *
 * A separate dimension from the hero chart because it is a separate question,
 * and the DEFAULT is the deck: the owner asked for it on 2026-08-27 after the
 * grid ran the dashboard past three screens. `grid` is kept, not as a fallback
 * but as the honest second lens — it is the one you print, the one you scan all
 * of at once, and the one a keyboard reader may simply prefer.
 */
export const DECISIONS_VIEW_SPEC: ViewSpec = [{ key: "cards", options: ["deck", "grid"] }];

export const DECISIONS_VIEW_LABELS: Record<string, string> = {
  deck: "Deck",
  grid: "Grid",
};

/**
 * The terrain's own two dimensions — its LENS (relief or table) and the CAMERA
 * it is drawn from.
 *
 * 🔴 Both lived in `useState` and both declared a URL key they never honoured:
 * `/?chart=terrain&terrainLens=table` opened on the relief, measured
 * 2026-09-02, and the choice was lost on reload. The owner asked for them to
 * become real on 2026-09-02 — URL-addressable AND remembered between visits,
 * like every other dimension on this surface.
 *
 * ⛔ `viewpoint` was declared by THREE components (this one, `CategoryMassif`
 * and `TransferTower`), so wiring them naively would have put three surfaces on
 * one param. Each carries its own name now, and no two can collide.
 *
 * ⚠️ QUARTER LEADS, and that is not a style choice: `options[0]` IS the default
 * (`dimensionDefault`), and the terrain has always opened on the quarter view.
 * Keeping the old switcher order would have silently changed the default view
 * of the chart to "front". The pills reorder; what you see on a cold load does
 * not.
 */
export const DASHBOARD_VIEW_SPEC: ViewSpec = [
  {
    key: "chart",
    options: ["combined", "assets", "liabilities", "split", "accounts", "sankey", "terrain", "bridge"],
  },
  { key: "terrainLens", options: ["relief", "table"] },
  { key: "terrainView", options: ["quarter", "front", "side", "plan"] },
  { key: "sankeyLens", options: ["flow", "table"] },
  { key: "bridgeLens", options: ["chart", "table"] },
];

/**
 * ⚠️ NAMED, never indexed at the call site. This spec grew from one dimension
 * to five in one sitting, and `DASHBOARD_VIEW_SPEC[0]` in a component would
 * silently repoint the day anything is inserted ahead of `chart` — the exact
 * bug `transfer-flow-view-spec` documents and its test forbids.
 */
export const DASHBOARD_CHART_DIMENSION = DASHBOARD_VIEW_SPEC[0]!;
export const TERRAIN_LENS_DIMENSION = DASHBOARD_VIEW_SPEC[1]!;
export const TERRAIN_VIEW_DIMENSION = DASHBOARD_VIEW_SPEC[2]!;
/**
 * The money-flow diagram's flow/table lens, and the bridge's.
 *
 * 🔴 The bridge's was the SIXTH of these, and it was not on the list the last
 * session compiled: it declared `key: "bridge"` over a `useState`, and `bridge`
 * is already a VALUE of the `chart` dimension above — so the one name it chose
 * was the one guaranteed to read as something else.
 *
 * ⛔ The diagram's declared key had the SAME flaw and it was not noticed until
 * the wiring guard enumerated the registry: `sankey` is also a value of
 * `chart`, so `?chart=sankey&sankey=table` names one word twice meaning two
 * things. Both carry the `…Lens` suffix now, matching `terrainLens`, and the
 * test forbids the shape rather than the two instances of it.
 */
export const SANKEY_LENS_DIMENSION = DASHBOARD_VIEW_SPEC[3]!;
export const BRIDGE_LENS_DIMENSION = DASHBOARD_VIEW_SPEC[4]!;
export const SANKEY_LENS_LABELS: Record<string, string> = { flow: "Flow", table: "Table" };
export const BRIDGE_LENS_LABELS: Record<string, string> = { chart: "Chart", table: "Table" };
export const TERRAIN_LENS_LABELS: Record<string, string> = { relief: "Terrain", table: "Table" };
export const TERRAIN_VIEW_LABELS: Record<string, string> = {
  quarter: "Quarter",
  front: "Front",
  side: "Side",
  plan: "Plan",
};

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
