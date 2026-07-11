/**
 * Result types for the value-returning transaction actions (ux-overhaul-plan
 * §3.0). Pure types — client packages import from here without pulling any
 * server code (the service imports below are type-only and fully erased).
 */

import type { UndoPatch } from "@/services/bulk-edit";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * What a post-correction rule keys on (§3.2/§3.4): a linked merchant when the
 * row has one, else the stripped name key — so "apply to every transaction with
 * this name, past & future" works for the ~47% of rows with no merchant too.
 */
export type RulePromptTarget =
  | { kind: "merchant"; merchantId: string }
  | { kind: "name"; descriptionKey: string };

/** Payload for the post-correction "Apply to all with this name" toast (§3.4). */
export interface RulePromptPreview {
  target: RulePromptTarget;
  /** readable subject for the toast, e.g. "Netflix" or "COKE dividends" */
  subjectLabel: string;
  categoryLabel: string;
  /**
   * server-computed retro count — how many OTHER active, non-user rows a retro
   * apply would recategorize (the just-corrected row and prior user decisions
   * are excluded, so the number is exactly what will change).
   */
  matchCount: number;
}

export interface CorrectCategoryData {
  rulePrompt: RulePromptPreview | null;
  undo: UndoPatch;
}

/** Every bulk mutation returns its blast radius and a lossless inverse. */
export interface BulkMutationData {
  affected: number;
  undo: UndoPatch;
}

/**
 * "Recategorize all N" (sheet same-merchant/name panel): recategorizes the whole
 * server-recomputed group (past) and creates the forward rule (future) in one
 * gesture. `ruleId` is null when the row has no rule-able identity; the client's
 * Undo reverts the recategorize AND deletes the rule.
 */
export interface RecategorizeGroupData {
  affected: number;
  undo: UndoPatch;
  ruleId: string | null;
}

export interface CreatedRuleData {
  ruleId: string;
  name: string;
  priority: number;
  /** matches at creation time under the retro-apply predicate */
  matchCount: number;
}

export type { TxnPatch, TxnFlags, UndoPatch } from "@/services/bulk-edit";
export type { ManualTxnInput } from "@/services/manual-transactions";
