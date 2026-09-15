import type { DateRange } from "@/services/analytics";

/**
 * Pure /transactions deep-link builder (ux-overhaul-plan §5). Lives in lib — not
 * in the DB-coupled analytics service — so `"use client"` components (charts,
 * calendars, stat cards) can import it without pulling drizzle-orm and the whole
 * transactions/categories/merchants/recurring schema graph into their browser
 * bundle. analytics.ts re-exports it, so server callers are unaffected. Mirrors
 * the transactions query parser's param names exactly, so a link lands on
 * precisely the rows behind the number clicked.
 */

/**
 * `?merchant=` sentinel for "rows with NO merchant" — the mirror of
 * `?category=uncategorized`.
 *
 * 🔴 `topMerchants` defines an "unlinked" group as rows that have no merchant,
 * and the link it published could not say so: /transactions had no filter for
 * it, so the drill carried the category, the window and a literal description
 * anchor and silently included the LINKED rows that share that description.
 * Measured on the real ledger, 2026-09-11: "LA PISCINE MIAMI BEACH · 26
 * transactions · unlinked · $730.15" opened 29 rows totalling $857.06.
 *
 * ⛔ Not a merchant id: ids here are UUIDv7 and this is the literal word, the
 * same shape `category=uncategorized` uses.
 */
export const NO_MERCHANT = "none";

export interface LedgerHrefParams {
  /** category id, `null` for the Uncategorized bucket, or omit for any category */
  category?: string | null;
  /** a merchant id, or `NO_MERCHANT` for the rows that have none */
  merchant?: string;
  /** a stripped description key — a merchantless group's identity (`TxnFilters.key`) */
  key?: string;
  /** scope to one account (investment drill-downs: a day's trades, a symbol's events) */
  account?: string;
  from?: string;
  to?: string;
  q?: string;
  view?: "excluded";
  /** direction: 'out' = money out, 'in' = money in */
  flow?: "in" | "out";
}

export function ledgerHref(params: LedgerHrefParams): string {
  const sp = new URLSearchParams();
  if (params.view) sp.set("view", params.view);
  if (params.category === null) sp.set("category", "uncategorized");
  else if (params.category !== undefined) sp.set("category", params.category);
  if (params.merchant) sp.set("merchant", params.merchant);
  if (params.key) sp.set("key", params.key);
  if (params.account) sp.set("account", params.account);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.q) sp.set("q", params.q);
  if (params.flow) sp.set("flow", params.flow);
  const query = sp.toString();
  return query ? `/transactions?${query}` : "/transactions";
}

/**
 * The two cash-flow series that are not one category: the keys `cashFlowByPeriod`
 * gives them, and that the chart and its drill-down read back. They live here,
 * beside the link, so a `"use client"` chart can know them without importing the
 * service that builds the series — see `client-bundle-graph.ts` for what that
 * import once dragged into the browser.
 */
export const OTHER_SERIES_KEY = "__other";
export const UNCATEGORIZED_SERIES_KEY = "__uncat";

/** `/transactions?from=D&to=D` — the literal "tap any day" destination. */
export function dayLedgerHref(iso: string): string {
  return ledgerHref({ from: iso, to: iso });
}

/**
 * The exact ledger link behind a clicked chart segment. A real category (income
 * or spending) drills to that category + bucket window; the Uncategorized
 * aggregate drills to the category-less bucket rows; Other (an aggregate of
 * many small categories) drills to the whole bucket window.
 */
export function cashFlowSegmentHref(
  seriesKey: string,
  categoryId: string | null,
  bucket: DateRange,
  /** 'in' for income segments (positive-only), so the drill matches the bar */
  flow?: "in" | "out",
): string {
  // Uncategorized spending is negatives-only → drill to outflows so it reconciles
  if (seriesKey === UNCATEGORIZED_SERIES_KEY) return ledgerHref({ category: null, from: bucket.from, to: bucket.to, flow: "out" });
  // Other is an aggregate of many small categories with no single exact filter —
  // it is not clickable in the chart, so this path is unused; kept honest anyway.
  if (seriesKey === OTHER_SERIES_KEY) return ledgerHref({ from: bucket.from, to: bucket.to });
  return ledgerHref({ category: categoryId ?? undefined, from: bucket.from, to: bucket.to, flow });
}
