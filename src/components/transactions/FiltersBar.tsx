import Link from "next/link";
import { filtersToQuery, type TxnFilters } from "./query";

export interface AccountOption {
  id: string;
  name: string;
}

export interface RootCategoryOption {
  id: string;
  name: string;
}

interface FiltersBarProps {
  filters: TxnFilters;
  accounts: readonly AccountOption[];
  rootCategories: readonly RootCategoryOption[];
}

const FIELD =
  "rounded-md border border-line bg-surface-raised px-2.5 py-1.5 text-sm transition-colors duration-(--duration-fast) placeholder:text-ink-faint hover:border-line-strong focus:border-accent";

/**
 * GET form — submitting writes the filters into the URL (page resets to 1;
 * the active view tab is carried via a hidden input).
 */
export function FiltersBar({ filters, accounts, rootCategories }: FiltersBarProps) {
  const hasActiveFilters = Boolean(
    filters.account || filters.category || filters.from || filters.to || filters.q,
  );

  return (
    <form method="get" action="/transactions" className="flex flex-wrap items-end gap-3">
      {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Account
        <select name="account" defaultValue={filters.account ?? ""} className={FIELD}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        Category
        <select name="category" defaultValue={filters.category ?? ""} className={FIELD}>
          <option value="">All categories</option>
          {rootCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        From
        <input type="date" name="from" defaultValue={filters.from ?? ""} className={`${FIELD} figures`} />
      </label>
      <label className="grid gap-1 text-xs font-medium text-ink-muted">
        To
        <input type="date" name="to" defaultValue={filters.to ?? ""} className={`${FIELD} figures`} />
      </label>
      <label className="grid min-w-48 flex-1 gap-1 text-xs font-medium text-ink-muted">
        Search descriptions
        <input
          type="search"
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="e.g. STARBUCKS"
          className={FIELD}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md border border-line bg-surface-raised px-3.5 py-1.5 text-sm font-medium transition-colors duration-(--duration-fast) hover:border-line-strong"
        >
          Filter
        </button>
        {hasActiveFilters ? (
          <Link
            href={`/transactions${filtersToQuery(filters, {
              account: null,
              category: null,
              from: null,
              to: null,
              q: null,
              page: 1,
            })}`}
            className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Reset
          </Link>
        ) : null}
      </div>
    </form>
  );
}
