"use client";

import Link from "next/link";
import { Money } from "@/components/ui/Money";
import { CategoryPicker, type CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { runCategoryCorrection } from "@/components/transactions/correct-category";
import type { SpendingCategoryTxns } from "@/app/spending/actions";

/**
 * The inline editable transaction list under an expanded Spending bucket
 * (ux-overhaul-plan §5.4): each row carries the same category picker as the
 * ledger and routes through `runCategoryCorrection`, so categorizing from
 * Spending gets the identical smart "apply to all with this name" snackbar and
 * Undo. A capped page with a link to the full filtered ledger for the rest.
 */
export function InlineCategorizeList({
  data,
  categories,
  onChanged,
}: {
  data: SpendingCategoryTxns;
  categories: readonly CategoryPickerOption[];
  onChanged: () => void;
}) {
  if (data.rows.length === 0) {
    return <p className="px-1 py-3 text-xs text-ink-faint">Nothing left to categorize here.</p>;
  }

  function recategorize(id: string, categoryId: string): void {
    const option = categories.find((c) => c.id === categoryId);
    runCategoryCorrection({
      transactionId: id,
      categoryId,
      categoryName: option?.name ?? "category",
      onChanged,
    });
  }

  return (
    <div className="space-y-1.5 py-1">
      <ul className="space-y-0.5">
        {data.rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-3 rounded-md px-1 py-1.5 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
          >
            <span className="figures w-16 shrink-0 text-xs text-ink-muted">{r.postedOn.slice(5)}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{r.description}</span>
            <span className="hidden whitespace-nowrap text-xs text-ink-faint md:inline">{r.accountName}</span>
            <Money cents={r.amountCents} flow className="w-24 shrink-0 text-right text-sm" />
            <div className="shrink-0">
              <CategoryPicker
                options={categories}
                currentId={r.categoryId}
                onPick={(cid) => recategorize(r.id, cid)}
              />
            </div>
          </li>
        ))}
      </ul>
      {data.total > data.rows.length ? (
        <Link
          href={data.href}
          className="inline-block px-1 text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          View all {data.total} →
        </Link>
      ) : null}
    </div>
  );
}
