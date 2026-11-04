import { toast } from "@/components/ui/Toast";
import { correctCategory, createRuleAction, retroApplyRuleAction } from "@/app/transactions/actions";
import type { ActionResult, RulePromptTarget } from "@/app/transactions/action-types";
import { settleAction } from "@/hooks/useAction";
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
 *
 * Settled (`settleAction`): a correction that never reached the server says so in a toast, and what this returns
 * never rejects.
 */
export function runCategoryCorrection(params: {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  /** re-fetch after a mutation (router.refresh) */
  onChanged: () => void;
}): Promise<void> {
  const { transactionId, categoryId, categoryName, onChanged } = params;
  return settleAction(() => correctCategory({ transactionId, categoryId })).then((r) => {
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
          onAction: applyToAll(rulePrompt.target, categoryId, onChanged),
        },
      });
    } else {
      offerUndoToast(`Categorized as ${categoryName}`, undo, onChanged);
    }
  });
}

/**
 * "Apply to N": create the merchant/name rule and retro-apply it; Undo reverts both. The action RETURNS what it did
 * (`offerUndoToast` is the model): a refused or failed step keeps the card, saying why on it, to be pressed again —
 * and a rule a press made is never made twice: pressed again, the card applies that rule to the past.
 *
 * 🔴 Review of 43a66c99 (batch 8): the sweep that made every Undo card settle missed this card. Its action was
 * `() => applyToAll(…)` over `void createRuleAction(…).then(…)`, which returns nothing, so Toast's
 * `settleToastAction` dismissed the card on the press — a refused rule raised a toast beside a card already gone, and
 * a call that never reached the server rejected with no catch: nothing reached him (re-read on b86f4e88, 2026-10-30).
 */
function applyToAll(
  target: RulePromptTarget,
  categoryId: string,
  onChanged: () => void,
): () => Promise<ActionResult<unknown>> {
  const ruleInput =
    target.kind === "merchant"
      ? { merchantId: target.merchantId, categoryId }
      : { descriptionKey: target.descriptionKey, categoryId };
  // the rule a press made — a retry of what failed after it applies this one rather than making a second
  let made: string | null = null;
  return async () => {
    if (made === null) {
      const rule = await settleAction(() => createRuleAction(ruleInput));
      if (!rule.ok) return rule;
      made = rule.data.ruleId;
    }
    const ruleId = made;
    const applied = await settleAction(() => retroApplyRuleAction(ruleId));
    if (!applied.ok) return applied;
    onChanged();
    offerUndoToast(`${applied.data.affected} recategorized · rule created`, applied.data.undo, onChanged, {
      deleteRuleId: ruleId,
    });
    return applied;
  };
}
