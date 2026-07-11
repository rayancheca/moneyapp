import { toast } from "@/components/ui/Toast";
import { undoAction } from "@/app/transactions/actions";
import type { UndoPatch } from "@/app/transactions/action-types";

/**
 * The one "Undo" toast for every value-returning transaction mutation
 * (ux-overhaul-plan §3.0): a lossless inverse patch behind an Undo action.
 * Shared by the ledger, the review inbox, and the transaction sheet so the
 * toast shape and undo wiring never drift. `deleteRuleId` reverts an accepted
 * rule-prompt along with its recategorization (§3.4).
 */
export function offerUndoToast(
  title: string,
  undo: UndoPatch,
  onUndone: () => void,
  options?: { deleteRuleId?: string },
): void {
  toast({
    title,
    action: {
      label: "Undo",
      onAction: () =>
        void undoAction(undo, options).then((r) => {
          if (r.ok) onUndone();
        }),
    },
  });
}
