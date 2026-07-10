import Link from "next/link";
import { Field, Input, Select } from "@/components/ui/Field";
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

/**
 * GET form — submitting writes the filters into the URL (page resets to 1;
 * the active view tab is carried via a hidden input). Controls use the
 * compact "sm" field size, this bar's pre-existing geometry.
 */
export function FiltersBar({ filters, accounts, rootCategories }: FiltersBarProps) {
  const hasActiveFilters = Boolean(
    filters.account || filters.category || filters.from || filters.to || filters.q,
  );

  return (
    <form method="get" action="/transactions" className="flex flex-wrap items-end gap-3">
      {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
      <Field label="Account">
        <Select name="account" defaultValue={filters.account ?? ""} fieldSize="sm">
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Category">
        <Select name="category" defaultValue={filters.category ?? ""} fieldSize="sm">
          <option value="">All categories</option>
          {rootCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="From">
        <Input
          type="date"
          name="from"
          defaultValue={filters.from ?? ""}
          fieldSize="sm"
          className="figures"
        />
      </Field>
      <Field label="To">
        <Input
          type="date"
          name="to"
          defaultValue={filters.to ?? ""}
          fieldSize="sm"
          className="figures"
        />
      </Field>
      <Field label="Search descriptions" className="min-w-48 flex-1">
        <Input
          type="search"
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="e.g. STARBUCKS"
          fieldSize="sm"
        />
      </Field>
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
