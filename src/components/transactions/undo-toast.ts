import { toast } from "@/components/ui/Toast";
import { undoAction } from "@/app/transactions/actions";
import type { ActionResult, UndoPatch } from "@/app/transactions/action-types";
import { settleAction } from "@/hooks/useAction";

/** What a failed undo says: the patch is still here, the change still stands. */
export const UNDO_FAILED = "Couldn’t undo that — the change is still in place";

/**
 * The one "Undo" toast for every value-returning transaction mutation
 * (ux-overhaul-plan §3.0): a lossless inverse patch behind an Undo action.
 * Shared by the ledger, the review inbox, and the transaction sheet so the
 * toast shape and undo wiring never drift. `deleteRuleId` reverts an accepted
 * rule-prompt along with its recategorization (§3.4).
 *
 * The action RETURNS its result rather than swallowing it: the card keeps
 * itself alive on failure, so the patch captured in this closure survives and
 * the owner can try again. Undoing a 300-row recategorization is the one
 * moment where "it silently didn't work" is unaffordable.
 */
export function offerUndoToast(
  title: string,
  undo: UndoPatch,
  onUndone: () => void,
  options?: { deleteRuleId?: string },
): void {
  offerUndoToastWith(title, () => undoAction(undo, options), onUndone);
}

/**
 * The same card for an undo that is not the bare patch: "Make recurring" undoes a series it CREATED by deleting it
 * (`undoCreateSeriesAction`). 🔴 Review of c3d804e (batch 6): that card was hand-rolled as `() => void (…).then(…)`,
 * which resolves with nothing, so `settleToastAction` dismissed it on the press — a refused undo took its patch with
 * it, and a rejected call (server restarted, wifi down) reached no one. One card, so no undo can drift from it again.
 */
export function offerUndoToastWith(
  title: string,
  undoIt: () => Promise<ActionResult<unknown>>,
  onUndone: () => void,
): void {
  toast({
    title,
    action: {
      label: "Undo",
      onAction: async () => {
        const result = await settleAction(undoIt, UNDO_FAILED);
        if (result.ok) onUndone();
        return result;
      },
    },
  });
}
