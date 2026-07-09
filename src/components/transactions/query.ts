import { isValidIsoDate } from "@/lib/dates";

/**
 * URL is the state: every filter, tab, and page lives in searchParams so
 * views are shareable and the back button works. These helpers parse the
 * raw params defensively and rebuild canonical query strings.
 */

export const TXN_VIEWS = ["all", "review", "quarantined", "excluded"] as const;
export type TxnView = (typeof TXN_VIEWS)[number];

export const TXN_NOTICES = ["direction-guard", "no-api-key"] as const;
export type TxnNotice = (typeof TXN_NOTICES)[number];

const MAX_SEARCH_LENGTH = 200;

export interface TxnFilters {
  view: TxnView;
  account: string | null;
  category: string | null;
  from: string | null;
  to: string | null;
  q: string | null;
  page: number;
}

export type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  const s = Array.isArray(value) ? value[0] : value;
  return typeof s === "string" && s !== "" ? s : null;
}

function isTxnView(s: string): s is TxnView {
  return (TXN_VIEWS as readonly string[]).includes(s);
}

export function parseFilters(params: SearchParams): TxnFilters {
  const view = first(params.view);
  const from = first(params.from);
  const to = first(params.to);
  const q = first(params.q)?.trim().slice(0, MAX_SEARCH_LENGTH) ?? null;
  const page = Number(first(params.page) ?? "1");

  return {
    view: view && isTxnView(view) ? view : "all",
    account: first(params.account),
    category: first(params.category),
    from: from && isValidIsoDate(from) ? from : null,
    to: to && isValidIsoDate(to) ? to : null,
    q: q === "" ? null : q,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function parseNotice(params: SearchParams): TxnNotice | null {
  const raw = first(params.notice);
  return raw && (TXN_NOTICES as readonly string[]).includes(raw) ? (raw as TxnNotice) : null;
}

/**
 * Canonical "?a=b&c=d" (or "") for a filter set — defaults are omitted so
 * URLs stay clean. `overrides` swaps individual params (tab links, paging).
 */
export function filtersToQuery(filters: TxnFilters, overrides: Partial<TxnFilters> = {}): string {
  const merged = { ...filters, ...overrides };
  const parts: string[] = [];
  if (merged.view !== "all") parts.push(`view=${merged.view}`);
  for (const key of ["account", "category", "from", "to", "q"] as const) {
    const value = merged[key];
    if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (merged.page > 1) parts.push(`page=${merged.page}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
