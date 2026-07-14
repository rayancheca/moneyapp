"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  applyMerchantDefaultAction,
  setMerchantDefaultCategoryAction,
} from "@/app/merchants/actions";
import { CategoryPicker, type CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { offerUndoToast } from "@/components/transactions/undo-toast";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";

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
  const [busy, setBusy] = useState(false);

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  function pick(categoryId: string): void {
    if (busy) return;
    setBusy(true);
    const label = categories.find((c) => c.id === categoryId)?.label ?? "category";
    void setMerchantDefaultCategoryAction({ merchantId, categoryId }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({
        title: `Default set to ${label}`,
        action: {
          label: "Undo",
          onAction: () =>
            void setMerchantDefaultCategoryAction({ merchantId, categoryId: defaultCategoryId }).then(refresh),
        },
      });
      refresh();
    });
  }

  function applyToUncategorized(): void {
    if (busy) return;
    setBusy(true);
    void applyMerchantDefaultAction({ merchantId }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      if (r.data.affected === 0) {
        toast({ title: "Nothing uncategorized to fill" });
        return;
      }
      offerUndoToast(`Categorized · ${r.data.affected}`, r.data.undo, refresh);
      refresh();
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
