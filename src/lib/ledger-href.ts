/**
 * Pure /transactions deep-link builder (ux-overhaul-plan §5). Lives in lib — not
 * in the DB-coupled analytics service — so `"use client"` components (charts,
 * calendars, stat cards) can import it without pulling drizzle-orm and the whole
 * transactions/categories/merchants/recurring schema graph into their browser
 * bundle. analytics.ts re-exports it, so server callers are unaffected. Mirrors
 * the transactions query parser's param names exactly, so a link lands on
 * precisely the rows behind the number clicked.
 */

export interface LedgerHrefParams {
  /** category id, `null` for the Uncategorized bucket, or omit for any category */
  category?: string | null;
  merchant?: string;
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
  if (params.account) sp.set("account", params.account);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.q) sp.set("q", params.q);
  if (params.flow) sp.set("flow", params.flow);
  const query = sp.toString();
  return query ? `/transactions?${query}` : "/transactions";
}
