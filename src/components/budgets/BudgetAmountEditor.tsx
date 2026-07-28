"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateBudgetAmountAction } from "@/app/budgets/actions";
import { Popover, usePopover } from "@/components/ui/Popover";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/shell/Icon";
import { toast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/money";
import type { BudgetPeriodKind } from "@/db/schema/budgets";

interface BudgetAmountEditorProps {
  budgetId: string;
  amountCents: number;
  guidanceCents: number;
  period: BudgetPeriodKind;
  categoryPath: string;
}

/** "$600.00 / month" — the noun every budget surface says the period with. */
export const PERIOD_WORD: Record<BudgetPeriodKind, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  annual: "year",
};

/** "600.00" from cents — the plain decimal parseAmountToCents round-trips. */
function toAmountField(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Inline budget-amount edit (ux-overhaul §8): a popover on the amount that
 * shows a 6-month spend guide and writes through updateBudgetAmountAction — no
 * more deactivate-and-recreate. The guide is one tap to adopt.
 */
export function BudgetAmountEditor({
  budgetId,
  amountCents,
  guidanceCents,
  period,
  categoryPath,
}: BudgetAmountEditorProps) {
  const router = useRouter();
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const [amount, setAmount] = useState(() => toAmountField(amountCents));
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // reset the draft to the live amount every time the editor opens, so a
  // cancelled edit never leaks into the next one
  useEffect(() => {
    if (open) {
      setAmount(toAmountField(amountCents));
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open, amountCents]);

  function save(): void {
    // both the Save button and the Enter keydown call this — guard so a slow
    // round-trip can't be double-submitted while the button shows its spinner.
    if (saving) return;
    setSaving(true);
    void updateBudgetAmountAction({ budgetId, amount })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        toast({ title: `${categoryPath} budget updated` });
        close();
        startTransition(() => router.refresh());
      })
      .finally(() => setSaving(false));
  }

  return (
    <>
      <button
        type="button"
        {...triggerProps}
        aria-label={`Edit ${categoryPath} budget amount`}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Icon name="edit" className="size-3" />
        Edit
      </button>
      <Popover anchorRef={anchorRef} open={open} onClose={close} placement="bottom-end" className="w-64">
        <div className="p-3">
          <label className="grid gap-1 text-xs font-medium text-ink-muted">
            {`Budget per ${PERIOD_WORD[period]}`}
            <input
              ref={inputRef}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              inputMode="decimal"
              aria-label={`${categoryPath} budget amount`}
              className="figures w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm transition-colors duration-(--duration-fast) hover:border-line-strong focus:border-accent"
            />
          </label>
          {guidanceCents > 0 && (
            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
              <span>
                6-mo avg ≈ <span className="text-ink-muted">{formatCents(guidanceCents)}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setAmount(toAmountField(guidanceCents));
                  inputRef.current?.focus();
                }}
                className="rounded-md border border-line px-2 py-0.5 text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
              >
                Use
              </button>
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} pending={saving}>
              Save
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}
