/*
 * Here rather than in `services/insights` because `/settings` renders this list
 * from `InsightsManager`, a `"use client"` component, and importing a value from
 * the service put the service's import graph in the browser bundle — see
 * `client-bundle-graph.ts`.
 */

/**
 * Every place in the app that speaks, as a closed list.
 *
 * ⛔ The list exists so the kill switch can be exhaustive rather than a set of
 * booleans that grew one page at a time. `/settings` renders it, the per-surface
 * switch is keyed by it, and a surface added later that forgets to appear here
 * is a surface the owner cannot turn off.
 *
 * ⚠️ Measured before it was written (`scripts/probe-insight-pool.ts`, 533
 * surfaces on the real ledger): 364 of them say nothing at all, and no page in
 * the ledger has ever had more than four things to say. So the entity surfaces
 * below are one page SHAPE, not one page — 399 merchant pages share `merchant`.
 */
export const INSIGHT_SURFACES = [
  { id: "spending", label: "Spending", where: "/spending" },
  { id: "category", label: "A category", where: "/categories/[id]" },
  { id: "budgets", label: "Budgets", where: "/budgets" },
  { id: "year", label: "A year in review", where: "/summary/[year]" },
  { id: "account", label: "An account", where: "/accounts/[id]" },
  { id: "merchant", label: "A merchant", where: "/merchants/[id]" },
  { id: "recurring", label: "A commitment", where: "/recurring/[id]" },
  { id: "notices", label: "Notices", where: "the dashboard" },
] as const;

export type InsightSurfaceId = (typeof INSIGHT_SURFACES)[number]["id"];
