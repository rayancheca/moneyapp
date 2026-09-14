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
