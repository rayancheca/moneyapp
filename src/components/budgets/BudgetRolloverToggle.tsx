"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setBudgetRolloverAction } from "@/app/budgets/actions";
import { Icon } from "@/components/shell/Icon";
import { toast } from "@/components/ui/Toast";

interface BudgetRolloverToggleProps {
  budgetId: string;
  enabled: boolean;
  categoryPath: string;
  /** report the flag upward so the row's details panel reacts without a refetch */
  onChange?: (enabled: boolean) => void;
}

/**
 * Opt a single budget into rollover (schema/budgets.ts). Deliberately a plain
 * per-row toggle rather than a global setting: lumpy categories want a sinking
 * fund and steady ones want a monthly reset, and only the owner knows which is
 * which — Travel and Rent are the same shape to the code and nothing alike to him.
 *
 * Optimistic, with a rollback on failure. The carry is derived at read time, so
 * the refresh is what makes the new number appear; the local flag only keeps the
 * control from flickering back while the server round-trips.
 */
export function BudgetRolloverToggle({
  budgetId,
  enabled,
  categoryPath,
  onChange,
}: BudgetRolloverToggleProps) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !on;
    setOn(next);
    onChange?.(next);
    startTransition(async () => {
      const result = await setBudgetRolloverAction({ budgetId, enabled: next });
      if (!result.ok) {
        setOn(!next);
        onChange?.(!next);
        toast({ title: result.error, tone: "negative" });
        return;
      }
      toast({
        title: next
          ? `${categoryPath} now carries unspent budget forward`
          : `${categoryPath} resets each period`,
      });
      router.refresh();
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={on}
      title={
        on
          ? "Unspent budget carries into the next period"
          : "Unspent budget is forgotten at the end of each period"
      }
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs transition-colors duration-(--duration-fast) hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 ${
        on ? "text-accent" : "text-ink-faint hover:text-ink"
      }`}
    >
      <Icon name="repeat" className="size-3.5" />
      {on ? "Rolls over" : "Roll over"}
    </button>
  );
}
