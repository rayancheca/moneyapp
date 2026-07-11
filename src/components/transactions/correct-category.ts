import { toast } from "@/components/ui/Toast";
import { correctCategory, createRuleAction, retroApplyRuleAction } from "@/app/transactions/actions";
import { offerUndoToast } from "./undo-toast";

/**
 * The one category-correction flow (ux-overhaul-plan §3.2/§3.4): correct a
 * transaction's category, then offer "Always {merchant} → {category}? · Create
 * rule → applies to N" when a merchant rule would help — accepting it creates
 * the rule and retro-applies it, and Undo reverts both the categorize AND the
 * rule. Shared by the transaction sheet and the inline ledger-row chip picker
 * so the two never drift.
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
      toast({
        title: `Categorized as ${categoryName}`,
        description: `Always ${rulePrompt.merchantName} → ${rulePrompt.categoryLabel}? Applies to ${rulePrompt.matchCount} existing.`,
        action: {
          label: `Create rule (${rulePrompt.matchCount})`,
          onAction: () =>
            void createRuleAction({ merchantId: rulePrompt.merchantId, categoryId }).then((rr) => {
              if (!rr.ok) {
                toast({ title: rr.error, tone: "negative" });
                return;
              }
              void retroApplyRuleAction(rr.data.ruleId).then((applied) => {
                if (!applied.ok) return;
                onChanged();
                offerUndoToast(
                  `Rule created · ${applied.data.affected} recategorized`,
                  applied.data.undo,
                  onChanged,
                  { deleteRuleId: rr.data.ruleId },
                );
              });
            }),
        },
      });
    } else {
      offerUndoToast(`Categorized as ${categoryName}`, undo, onChanged);
    }
  });
}
