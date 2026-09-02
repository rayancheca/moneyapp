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
  /*
   * 🔴 "Nothing left to categorize here" ANSWERED A QUESTION NOBODY ASKED.
   *
   * This list is every transaction in the category for the period — not a queue
   * of uncategorized ones — and its only caller is the category page. So an
   * empty list means the period holds nothing, and the old message told the
   * owner his categorizing was finished on a page whose own header two sections
   * up read "$0.00 · 0 transactions". Measured on `/categories/…` for September
   * 2026, a month with no imported rows at all.
   *
   * ⚠️ The docstring above still describes an expanded `/spending` bucket. That
   * caller is gone; this component has exactly one, and the message now says
   * what an empty list means for that one.
   */
  if (data.rows.length === 0) {
    return <p className="px-1 py-3 text-xs text-ink-faint">No transactions in this period.</p>;
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
            key={r.rowKey}
            className="flex items-center gap-3 rounded-md px-1 py-1.5 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
          >
            <span className="figures w-16 shrink-0 text-xs text-ink-muted">{r.postedOn.slice(5)}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{r.description}</span>
            <span className="hidden whitespace-nowrap text-xs text-ink-faint md:inline">{r.accountName}</span>
            <Money cents={r.amountCents} flow className="w-24 shrink-0 text-right text-sm" />
            <div className="shrink-0">
              {r.splitId !== null ? (
                // one part of a split — its category is edited in the transaction
                // sheet, not inline (recategorizing here would hit the parent row)
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
                  {r.categoryName ?? "Split"}
                  <span className="text-ink-faint">· split</span>
                </span>
              ) : (
                <CategoryPicker
                  options={categories}
                  currentId={r.categoryId}
                  onPick={(cid) => recategorize(r.id, cid)}
                />
              )}
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
