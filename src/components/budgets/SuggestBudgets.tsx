"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSuggestedBudgetsAction, suggestBudgetsAction } from "@/app/budgets/actions";
import { Icon } from "@/components/shell/Icon";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/money";
import type { SuggestedBudget } from "@/services/budgets";

/**
 * "Suggest budgets" (user ask: budgets from predictions): loads suggestions —
 * each the average of the last 3 complete months' subtree spending, rounded up
 * to the nearest $10 — into a review sheet. Nothing is created until the user
 * confirms the checked set; every row names its basis, because a suggestion
 * DESCRIBES recent behavior, it doesn't predict next month.
 */
export function SuggestBudgets() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedBudget[] | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  function load(): void {
    startTransition(async () => {
      const result = await suggestBudgetsAction();
      if (!result.ok) {
        toast({ title: result.error, tone: "negative" });
        return;
      }
      setSuggestions(result.data);
      setChecked(new Set(result.data.map((s) => s.categoryId)));
      setOpen(true);
    });
  }

  function toggle(categoryId: string): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  function createChecked(): void {
    const picked = (suggestions ?? []).filter((s) => checked.has(s.categoryId));
    if (picked.length === 0) return;
    startTransition(async () => {
      const result = await createSuggestedBudgetsAction(
        picked.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents })),
      );
      if (!result.ok) {
        toast({ title: result.error, tone: "negative" });
        return;
      }
      const { created, errors } = result.data;
      toast({
        title: `Created ${created} monthly budget${created === 1 ? "" : "s"}${
          errors.length > 0 ? ` — ${errors.length} failed` : ""
        }`,
        tone: errors.length > 0 ? "negative" : "positive",
      });
      setOpen(false);
      router.refresh();
    });
  }

  const windowLabel = suggestions?.[0]?.windowLabel ?? null;

  return (
    <>
      <button
        type="button"
        onClick={load}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink disabled:opacity-60"
      >
        <Icon name="sparkles" className="size-3.5" />
        {isPending && !open ? "Reading your history…" : "Suggest budgets"}
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Suggested budgets"
        footer={
          suggestions !== null && suggestions.length > 0 ? (
            <button
              type="button"
              onClick={createChecked}
              disabled={isPending || checked.size === 0}
              className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-surface-raised transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {isPending
                ? "Creating…"
                : `Create ${checked.size} monthly budget${checked.size === 1 ? "" : "s"}`}
            </button>
          ) : undefined
        }
      >
        {suggestions === null || suggestions.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing to suggest — every category with steady recent spending already has a budget,
            or there isn&rsquo;t enough history yet (a category needs spending in at least 2 of the
            last 3 complete months).
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-ink-muted">
              Each amount is your average month over {windowLabel}, rounded up to the nearest $10 —
              a description of recent spending, not a prediction. Uncheck what you don&rsquo;t want.
            </p>
            <ul className="divide-y divide-line">
              {suggestions.map((s) => (
                <li key={s.categoryId} className="py-2.5">
                  <label className="flex cursor-pointer items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked.has(s.categoryId)}
                        onChange={() => toggle(s.categoryId)}
                        className="size-4 shrink-0 accent-(--accent)"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{s.label}</span>
                        <span className="block text-[11px] text-ink-faint">
                          avg {formatCents(s.avgCents)} · spending in {s.activeMonths} of 3 months
                        </span>
                      </span>
                    </span>
                    <span className="figures shrink-0 text-sm">{formatCents(s.amountCents)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Sheet>
    </>
  );
}
