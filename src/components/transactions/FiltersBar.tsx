import Link from "next/link";
import { humanizeDescriptionKey } from "@/lib/description-key";
import { NO_MERCHANT } from "@/lib/ledger-href";
import { Field, Input, Select } from "@/components/ui/Field";
import { formatCents } from "@/lib/money";
import { filtersToQuery, type TxnFilters } from "./query";

export interface AccountOption {
  id: string;
  name: string;
}

export interface RootCategoryOption {
  id: string;
  name: string;
}

/**
 * One entry of the Category dropdown. `label` is what the option reads — a
 * root's name, or a child's full path ("Food & Drink > Coffee") so the choice
 * is unambiguous at any depth. Structurally satisfied by the shared
 * CategoryPickerOption, so a page can pass its picker options straight through.
 */
export interface CategoryFilterOption {
  id: string;
  label: string;
}

/**
 * The four non-category values `?category=` accepts (transactions-query
 * §filterConditions): the Uncategorized honesty bucket and the three
 * kind-scoped StatCard drill-downs. They are real, applied filters, so the
 * control has to be able to display and re-submit them.
 *
 * ⛔ `cashflow` is spending ∪ income — the population the Net and Savings-rate
 * cards are figures over. A sentinel the query layer honours but this list does
 * not is worse than no sentinel at all: the rows would be filtered while the
 * control said "All categories", and the first edit of any other filter would
 * silently drop the scope.
 *
 * 🔴 S22: its label said "earning" after the cards that open it were renamed to
 * "income" (owner decision 2026-09-14) — one population, two words, one click
 * apart. /summary's narrow "Earned" is a different set and never lands here.
 */
export const CATEGORY_SENTINEL_OPTIONS: readonly CategoryFilterOption[] = [
  { id: "uncategorized", label: "Uncategorized" },
  { id: "spending", label: "All spending" },
  { id: "income", label: "All income" },
  { id: "cashflow", label: "All income and spending" },
];

/**
 * Options for the Category select: the sentinels, then the category tree the
 * page supplied. An applied value the list does not contain (a child id from a
 * drill-down when only roots were passed, or a stale id from a bookmark) is
 * appended so the select shows the ledger IS filtered and re-submits the value
 * instead of silently resetting it to "All categories".
 */
export function categorySelectOptions(
  selected: string | null,
  tree: readonly CategoryFilterOption[],
): CategoryFilterOption[] {
  const options = [...CATEGORY_SENTINEL_OPTIONS, ...tree];
  if (selected && !options.some((o) => o.id === selected)) {
    options.push({ id: selected, label: "Filtered category" });
  }
  return options;
}

/** True when any URL filter is applied — including the ones with no control. */
export function hasAnyFilter(filters: TxnFilters): boolean {
  return Boolean(
    filters.account ||
      filters.category ||
      filters.merchant ||
      filters.key ||
      filters.from ||
      filters.to ||
      filters.q ||
      filters.flow ||
      filters.amountMinCents !== null ||
      filters.amountMaxCents !== null,
  );
}

/**
 * formatCents throws outside the safe-integer range, and parseFilters admits
 * any non-negative integer (a hand-typed `?amountMin=1e21` among them), so an
 * absurd bound degrades to raw cents rather than throwing in a server render.
 */
function centsLabel(cents: number): string {
  return Number.isSafeInteger(cents) ? formatCents(cents) : `${cents}¢`;
}

/** "$15.00–$60.00" / "$15.00+" / "up to $60.00", or null when unbounded. */
export function amountRangeLabel(minCents: number | null, maxCents: number | null): string | null {
  if (minCents !== null && maxCents !== null) {
    return `${centsLabel(minCents)}–${centsLabel(maxCents)}`;
  }
  if (minCents !== null) return `${centsLabel(minCents)}+`;
  if (maxCents !== null) return `up to ${centsLabel(maxCents)}`;
  return null;
}

export interface FilterChip {
  key: string;
  label: string;
  /** filtersToQuery override that drops just this filter */
  clear: Partial<TxnFilters>;
}

const FLOW_LABEL = { in: "Money in", out: "Money out" } as const;

/**
 * Chips for the applied filters this bar has no visible control for. Account /
 * Category / From / To / Search each show their own value in a field; merchant,
 * a description group, flow and the amount range would otherwise be invisible
 * while still narrowing the ledger (and the bulk action bar's blast radius).
 */
export function preservedFilterChips(filters: TxnFilters, merchantName?: string): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.merchant) {
    chips.push({
      key: "merchant",
      // ⛔ the no-merchant sentinel is not "one merchant" — a chip that named it
      // wrongly would let the next filter edit silently drop the scope
      label:
        filters.merchant === NO_MERCHANT
          ? "No merchant"
          : merchantName
            ? `Merchant: ${merchantName}`
            : "One merchant",
      clear: { merchant: null },
    });
  }
  if (filters.key) {
    // a group's identity, not a search — the Search field cannot show it, and
    // a next filter edit must not quietly widen it back to a text match
    chips.push({
      key: "key",
      label: `Same description: ${humanizeDescriptionKey(filters.key)}`,
      clear: { key: null },
    });
  }
  if (filters.flow) {
    chips.push({ key: "flow", label: FLOW_LABEL[filters.flow], clear: { flow: null } });
  }
  const amount = amountRangeLabel(filters.amountMinCents, filters.amountMaxCents);
  if (amount) {
    chips.push({
      key: "amount",
      label: amount,
      clear: { amountMinCents: null, amountMaxCents: null },
    });
  }
  return chips;
}

interface FiltersBarProps {
  filters: TxnFilters;
  accounts: readonly AccountOption[];
  rootCategories: readonly RootCategoryOption[];
  /**
   * Full one-deep category tree (roots + children, each with a path label).
   * Falls back to `rootCategories` when omitted, in which case a drilled-in
   * child id still round-trips via the appended "Filtered category" option.
   */
  categoryOptions?: readonly CategoryFilterOption[];
  /** display name for an active `?merchant=` drill-down */
  merchantName?: string;
}

/**
 * GET form — submitting writes the filters into the URL (page resets to 1;
 * the active view tab is carried via a hidden input). Controls use the
 * compact "sm" field size, this bar's pre-existing geometry.
 *
 * A GET form serializes ONLY its own controls, so every filter the URL supports
 * but this bar has no field for must ride along as a hidden input. Without them
 * pressing Filter widened a merchant/flow/amount drill-down back to the whole
 * ledger while the user believed it was still scoped — and the bulk action bar
 * would then operate on that wider set.
 */
export function FiltersBar({
  filters,
  accounts,
  rootCategories,
  categoryOptions,
  merchantName,
}: FiltersBarProps) {
  const hasActiveFilters = hasAnyFilter(filters);
  const categoryChoices =
    categoryOptions ?? rootCategories.map((c) => ({ id: c.id, label: c.name }));
  const categories = categorySelectOptions(filters.category, categoryChoices);
  const chips = preservedFilterChips(filters, merchantName);

  return (
    <form method="get" action="/transactions" className="flex flex-wrap items-end gap-3">
      {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
      {filters.merchant ? <input type="hidden" name="merchant" value={filters.merchant} /> : null}
      {filters.key ? <input type="hidden" name="key" value={filters.key} /> : null}
      {filters.flow ? <input type="hidden" name="flow" value={filters.flow} /> : null}
      {filters.amountMinCents !== null ? (
        <input type="hidden" name="amountMin" value={filters.amountMinCents} />
      ) : null}
      {filters.amountMaxCents !== null ? (
        <input type="hidden" name="amountMax" value={filters.amountMaxCents} />
      ) : null}
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
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
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
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken py-0.5 pr-1 pl-2 text-xs text-ink-muted"
            >
              {chip.label}
              <Link
                href={`/transactions${filtersToQuery(filters, { ...chip.clear, page: 1 })}`}
                aria-label={`Remove filter ${chip.label}`}
                className="rounded-full px-1 leading-none text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink"
              >
                <span aria-hidden>×</span>
              </Link>
            </span>
          ))}
        </div>
      ) : null}
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
              merchant: null,
              key: null,
              from: null,
              to: null,
              q: null,
              amountMinCents: null,
              amountMaxCents: null,
              flow: null,
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
