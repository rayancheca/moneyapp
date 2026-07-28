"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  applyMerchantDefaultAction,
  setMerchantDefaultCategoryAction,
} from "@/app/merchants/actions";
import { CategoryPicker, type CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { offerUndoToast } from "@/components/transactions/undo-toast";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { settleAction, useAction } from "@/hooks/useAction";

/**
 * The merchant→category rule, editable where the merchant lives (S6): pick a
 * default and every FUTURE import of this merchant categorizes to it
 * (merchant-map precedence). The explicit backfill button applies it to the
 * merchant's still-uncategorized rows — never overwriting an existing
 * categorization, always with a lossless Undo.
 */
export function MerchantDefaultCategory({
  merchantId,
  defaultCategoryId,
  uncategorizedCount,
  categories,
}: {
  merchantId: string;
  defaultCategoryId: string | null;
  uncategorizedCount: number;
  categories: readonly CategoryPickerOption[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // one runner for both mutations: `pending` is cleared in a finally (the old
  // hand-rolled flag stayed stuck on if the call rejected, and `if (busy)
  // return` then disabled the picker until a reload) and no failure is silent
  const { run, pending: busy } = useAction();

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  function pick(categoryId: string): void {
    if (busy) return;
    const label = categories.find((c) => c.id === categoryId)?.label ?? "category";
    void run(() => setMerchantDefaultCategoryAction({ merchantId, categoryId }), {
      onSuccess: () => {
        toast({
          title: `Default set to ${label}`,
          action: {
            label: "Undo",
            // settle and RETURN: the card keeps itself (and the previous
            // category in this closure) alive when the undo fails, instead of
            // dismissing on click and reverting nothing without saying so
            onAction: async () => {
              const result = await settleAction(
                () => setMerchantDefaultCategoryAction({ merchantId, categoryId: defaultCategoryId }),
                "Couldn’t put the default back — try again",
              );
              if (result.ok) refresh();
              return result;
            },
          },
        });
        refresh();
      },
    });
  }

  function applyToUncategorized(): void {
    if (busy) return;
    void run(() => applyMerchantDefaultAction({ merchantId }), {
      onSuccess: ({ affected, undo }) => {
        if (affected === 0) {
          toast({ title: "Nothing uncategorized to fill" });
          return;
        }
        offerUndoToast(`Categorized · ${affected}`, undo, refresh);
        refresh();
      },
    });
  }

  return (
    <section className="flex flex-wrap items-center gap-3">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        Default category
      </span>
      <CategoryPicker options={categories} currentId={defaultCategoryId} onPick={pick} />
      {defaultCategoryId && uncategorizedCount > 0 ? (
        <Button variant="ghost" size="sm" pending={busy} onClick={applyToUncategorized}>
          Apply to {uncategorizedCount} uncategorized →
        </Button>
      ) : null}
    </section>
  );
}
