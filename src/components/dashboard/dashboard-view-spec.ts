import type { ViewSpec } from "@/lib/view-state";

/**
 * The dashboard hero chart's switchable dimension (pass-17 ask C). Shared by
 * the RSC (resolves URL > persisted > default) and the client switcher —
 * no "use client" directive so the server page can import it without pulling
 * component code across the boundary. The per-account selection travels in a
 * sibling `accts` URL param (dynamic ids can't be enumerated as spec options)
 * and persists under the same surface key.
 */
export const DASHBOARD_SURFACE = "dashboard";

export const DASHBOARD_VIEW_SPEC: ViewSpec = [
  { key: "chart", options: ["combined", "assets", "liabilities", "split", "accounts", "sankey"] },
];
