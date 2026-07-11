import { toast } from "@/components/ui/Toast";
import { correctCategory, createRuleAction, retroApplyRuleAction } from "@/app/transactions/actions";
import type { RulePromptTarget } from "@/app/transactions/action-types";
import { offerUndoToast } from "./undo-toast";

/**
 * The one category-correction flow (ux-overhaul-plan §3.2/§3.4): correct a
 * transaction's category, then — via a smart snackbar — offer to apply that
 * category to every OTHER transaction with the same name, past AND future.
 * "Same name" keys on the linked merchant when there is one, else the stripped
 * description key, so the offer reaches the ~47% of rows with no merchant.
 * Accepting creates the rule (future imports auto-categorize) and retro-applies
 * it (the past); Undo reverts both the categorize AND the rule. Shared by the
 * transaction sheet, the inline ledger-row chip picker, and the spending page
 * so the surfaces never drift.
 */
export function runCategoryCorrection(params: {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  /** re-fetch after a mutation (router.refresh) */
  onChanged: () => void;
}): void {
  const { transactionId, categoryId, categoryName, onChanged } = params;
  void correctCategory({ transactionId, categoryId }).then((r) => {
    if (!r.ok) {
      toast({ title: r.error, tone: "negative" });
      return;
    }
    onChanged();
    const { rulePrompt, undo } = r.data;
    if (rulePrompt && rulePrompt.matchCount > 0) {
      const n = rulePrompt.matchCount;
      toast({
        title: `Categorized as ${categoryName}`,
        description: `Also apply to ${n} other ${n === 1 ? "transaction" : "transactions"} named “${rulePrompt.subjectLabel}” — past & future?`,
        action: {
          label: `Apply to ${n}`,
          onAction: () => applyToAll(rulePrompt.target, categoryId, onChanged),
        },
      });
    } else {
      offerUndoToast(`Categorized as ${categoryName}`, undo, onChanged);
    }
  });
}

/** Create the merchant/name rule and retro-apply it; Undo reverts both. */
function applyToAll(target: RulePromptTarget, categoryId: string, onChanged: () => void): void {
  const ruleInput =
    target.kind === "merchant"
      ? { merchantId: target.merchantId, categoryId }
      : { descriptionKey: target.descriptionKey, categoryId };
  void createRuleAction(ruleInput).then((rr) => {
    if (!rr.ok) {
      toast({ title: rr.error, tone: "negative" });
      return;
    }
    void retroApplyRuleAction(rr.data.ruleId).then((applied) => {
      if (!applied.ok) {
        toast({ title: applied.error, tone: "negative" });
        return;
      }
      onChanged();
      const affected = applied.data.affected;
      offerUndoToast(
        `${affected} recategorized · rule created`,
        applied.data.undo,
        onChanged,
        { deleteRuleId: rr.data.ruleId },
      );
    });
  });
}
