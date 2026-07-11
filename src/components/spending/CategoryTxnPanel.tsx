"use client";

import { useRouter } from "next/navigation";
import { InlineCategorizeList } from "@/components/spending/InlineCategorizeList";
import type { CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import type { SpendingCategoryTxns } from "@/app/spending/actions";

/**
 * The category page's transaction list with inline recategorize (ux-overhaul-plan
 * §5.4). Reuses the Spending inline categorizer; after any correction it refreshes
 * the server component so the page's aggregates re-reconcile with the new state.
 */
export function CategoryTxnPanel({
  data,
  categories,
}: {
  data: SpendingCategoryTxns;
  categories: readonly CategoryPickerOption[];
}) {
  const router = useRouter();
  return <InlineCategorizeList data={data} categories={categories} onChanged={() => router.refresh()} />;
}
