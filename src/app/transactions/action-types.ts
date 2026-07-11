/**
 * Result types for the value-returning transaction actions (ux-overhaul-plan
 * §3.0). Pure types — client packages import from here without pulling any
 * server code (the service imports below are type-only and fully erased).
 */

import type { UndoPatch } from "@/services/bulk-edit";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Payload for the post-correction "Always? Create rule" toast (§3.4). */
export interface RulePromptPreview {
  merchantId: string;
  merchantName: string;
  categoryLabel: string;
  /** server-computed retro count — the toast's "applies to N existing" */
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

export interface CreatedRuleData {
  ruleId: string;
  name: string;
  priority: number;
  /** matches at creation time under the retro-apply predicate */
  matchCount: number;
}

export type { TxnPatch, TxnFlags, UndoPatch } from "@/services/bulk-edit";
export type { ManualTxnInput } from "@/services/manual-transactions";
