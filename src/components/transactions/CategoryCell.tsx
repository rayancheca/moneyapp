"use client";

import { createContext, useContext, useState } from "react";
import { correctCategoryAction } from "@/app/transactions/actions";

/**
 * Compact in-table category editor. Display mode is a button showing the
 * current category; clicking swaps to a select + merchant checkboxes that
 * post applyCorrection. Options are provided once via context so 50 rows
 * don't serialize the taxonomy 50 times.
 */

export interface CategoryOption {
  id: string;
  label: string;
}

const CategoryOptionsContext = createContext<readonly CategoryOption[]>([]);

export function CategoryOptionsProvider({
  options,
  children,
}: {
  options: readonly CategoryOption[];
  children: React.ReactNode;
}) {
  return <CategoryOptionsContext.Provider value={options}>{children}</CategoryOptionsContext.Provider>;
}

interface CategoryCellProps {
  transactionId: string;
  categoryId: string | null;
  categoryLabel: string | null;
  hasMerchant: boolean;
  lowConfidence: boolean;
  /** current filter query string — the action returns the user here */
  returnQuery: string;
}

const SELECT_FIELD =
  "w-full min-w-44 rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs transition-colors duration-(--duration-fast) hover:border-line-strong focus:border-accent";

export function CategoryCell({
  transactionId,
  categoryId,
  categoryLabel,
  hasMerchant,
  lowConfidence,
  returnQuery,
}: CategoryCellProps) {
  const options = useContext(CategoryOptionsContext);
  const [isEditing, setIsEditing] = useState(false);

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        aria-expanded={false}
        aria-label={`Change category (currently ${categoryLabel ?? "uncategorized"})`}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-left text-xs transition-colors duration-(--duration-fast) hover:border-line hover:bg-surface-sunken"
      >
        <span className={`truncate ${categoryLabel ? "" : "italic text-ink-faint"}`}>
          {categoryLabel ?? "Uncategorized"}
        </span>
        {lowConfidence ? (
          <span title="Categorization confidence below 0.8">
            <span aria-hidden className="inline-block size-1.5 rounded-full bg-warning" />
            <span className="sr-only">Low confidence</span>
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <form
      action={correctCategoryAction}
      onKeyDown={(e) => {
        if (e.key === "Escape") setIsEditing(false);
      }}
      className="grid min-w-52 gap-1.5"
    >
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="returnTo" value={returnQuery} />
      <label className="sr-only" htmlFor={`category-${transactionId}`}>
        Category
      </label>
      <select
        id={`category-${transactionId}`}
        name="categoryId"
        defaultValue={categoryId ?? ""}
        required
        autoFocus
        className={SELECT_FIELD}
      >
        <option value="" disabled>
          Pick a category…
        </option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <label
        className={`flex items-center gap-1.5 text-[11px] ${hasMerchant ? "text-ink-muted" : "text-ink-faint"}`}
        title={hasMerchant ? undefined : "No merchant on this transaction"}
      >
        <input type="checkbox" name="applyToMerchant" disabled={!hasMerchant} />
        Remember for this merchant
      </label>
      <label
        className={`flex items-center gap-1.5 text-[11px] ${hasMerchant ? "text-ink-muted" : "text-ink-faint"}`}
        title={hasMerchant ? "Recategorizes this merchant's past transactions (your own fixes stay)" : "No merchant on this transaction"}
      >
        <input type="checkbox" name="retroactive" disabled={!hasMerchant} />
        Apply to history
      </label>
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setIsEditing(false)}
          className="rounded-md border border-line px-2.5 py-1 text-xs transition-colors duration-(--duration-fast) hover:border-line-strong"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
