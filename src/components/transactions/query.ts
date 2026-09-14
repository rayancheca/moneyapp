import { isValidIsoDate } from "@/lib/dates";

/**
 * URL is the state: every filter, tab, and page lives in searchParams so
 * views are shareable and the back button works. These helpers parse the
 * raw params defensively and rebuild canonical query strings.
 */

export const TXN_VIEWS = ["all", "review", "duplicates", "quarantined", "excluded"] as const;
export type TxnView = (typeof TXN_VIEWS)[number];

export const TXN_NOTICES = ["direction-guard", "no-api-key"] as const;
export type TxnNotice = (typeof TXN_NOTICES)[number];

const MAX_SEARCH_LENGTH = 200;

// A hand-typed ?page= is unbounded, and `page` becomes a SQL OFFSET. Cap it far
// above any real ledger (50M rows at a 50-row page) so a pasted `?page=1e21`
// can never reach the driver as an absurd offset. The real bound is the page
// count, which only the querying page knows — see clampPage.
const MAX_PAGE = 1_000_000;

export interface TxnFilters {
  view: TxnView;
  account: string | null;
  category: string | null;
  merchant: string | null;
  /**
   * a stripped description key (`lib/description-key`): only rows whose
   * descriptor strips to exactly this — a merchantless group's identity, which
   * no literal `q` can express
   */
  key: string | null;
  from: string | null;
  to: string | null;
  q: string | null;
  /** magnitude filter (abs of amount_cents), URL params amountMin/amountMax in cents */
  amountMinCents: number | null;
  amountMaxCents: number | null;
  /** direction filter: 'out' = money out (amount<0), 'in' = money in (amount>0) */
  flow: "in" | "out" | null;
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

/** non-negative integer cents, or null for anything malformed */
function parseCents(value: string | string[] | undefined): number | null {
  const s = first(value);
  if (s === null) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function parseFilters(params: SearchParams): TxnFilters {
  const view = first(params.view);
  const from = first(params.from);
  const to = first(params.to);
  const q = first(params.q)?.trim().slice(0, MAX_SEARCH_LENGTH) ?? null;
  const flow = first(params.flow);
  const page = Number(first(params.page) ?? "1");

  return {
    view: view && isTxnView(view) ? view : "all",
    account: first(params.account),
    category: first(params.category),
    merchant: first(params.merchant),
    key: first(params.key),
    from: from && isValidIsoDate(from) ? from : null,
    to: to && isValidIsoDate(to) ? to : null,
    q: q === "" ? null : q,
    amountMinCents: parseCents(params.amountMin),
    amountMaxCents: parseCents(params.amountMax),
    flow: flow === "in" || flow === "out" ? flow : null,
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1,
  };
}

/**
 * Pages needed to show `totalRows` — never 0, so an empty result set still
 * reads "Page 1 of 1" instead of "Page 1 of 0".
 */
export function pageCount(totalRows: number, pageSize: number): number {
  if (!Number.isFinite(totalRows) || !Number.isFinite(pageSize) || pageSize < 1) return 1;
  return Math.max(1, Math.ceil(totalRows / pageSize));
}

/**
 * Clamp `filters.page` into [1, pageCount] for a known result size. parseFilters
 * can only enforce the lower bound (it has no counts), so `?page=99999` survives
 * it and would otherwise render "Page 99999 of 194" over an empty page with a
 * working Previous link. Callers that know the total pass it through here after
 * counting. Returns the same object when nothing needs clamping.
 */
export function clampPage(filters: TxnFilters, totalRows: number, pageSize: number): TxnFilters {
  const last = pageCount(totalRows, pageSize);
  return filters.page <= last ? filters : { ...filters, page: last };
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
  for (const key of ["account", "category", "merchant", "key", "from", "to", "q"] as const) {
    const value = merged[key];
    if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (typeof merged.amountMinCents === "number") parts.push(`amountMin=${merged.amountMinCents}`);
  if (typeof merged.amountMaxCents === "number") parts.push(`amountMax=${merged.amountMaxCents}`);
  if (merged.flow) parts.push(`flow=${merged.flow}`);
  if (merged.page > 1) parts.push(`page=${merged.page}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
