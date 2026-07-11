"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { retroApplyRule } from "@/services/rule-corrections";
import {
  deleteRuleCapturing,
  moveRule,
  restoreRule,
  ruleSnapshotSchema,
  setRuleEnabled,
  type RuleSnapshot,
} from "@/services/rules-manager";
import type { ActionResult, BulkMutationData } from "@/app/transactions/action-types";

/**
 * Value-returning actions for the rules manager (ux-overhaul-plan §3.4): toggle,
 * reorder, delete, and re-apply. Re-apply returns the standard {affected, undo}
 * so the manager can offer an Undo toast just like the ledger. All revalidate
 * Settings plus the surfaces a rule change can move (the ledger + the nav badge).
 */

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "Unexpected error" };
}

function revalidateRules(): void {
  revalidatePath("/settings");
  revalidatePath("/transactions");
  revalidatePath("/");
}

const setEnabledSchema = z.object({ ruleId: z.string().min(1), enabled: z.boolean() });

export async function setRuleEnabledAction(input: {
  ruleId: string;
  enabled: boolean;
}): Promise<ActionResult<{ changed: boolean }>> {
  try {
    const parsed = setEnabledSchema.parse(input);
    const changed = setRuleEnabled(getDb(), parsed.ruleId, parsed.enabled);
    revalidateRules();
    return { ok: true, data: { changed } };
  } catch (error: unknown) {
    return fail(error);
  }
}

const moveSchema = z.object({ ruleId: z.string().min(1), direction: z.enum(["up", "down"]) });

export async function moveRuleAction(input: {
  ruleId: string;
  direction: "up" | "down";
}): Promise<ActionResult<{ moved: boolean }>> {
  try {
    const parsed = moveSchema.parse(input);
    const moved = moveRule(getDb(), parsed.ruleId, parsed.direction);
    revalidateRules();
    return { ok: true, data: { moved } };
  } catch (error: unknown) {
    return fail(error);
  }
}

export async function deleteRuleAction(
  ruleId: string,
): Promise<ActionResult<{ snapshot: RuleSnapshot | null }>> {
  try {
    const parsed = z.string().min(1).parse(ruleId);
    const snapshot = deleteRuleCapturing(getDb(), parsed);
    revalidateRules();
    return { ok: true, data: { snapshot } };
  } catch (error: unknown) {
    return fail(error);
  }
}

export async function restoreRuleAction(
  snapshot: RuleSnapshot,
): Promise<ActionResult<{ restored: boolean }>> {
  try {
    const parsed = ruleSnapshotSchema.parse(snapshot);
    const restored = restoreRule(getDb(), parsed);
    revalidateRules();
    return { ok: true, data: { restored } };
  } catch (error: unknown) {
    return fail(error);
  }
}

export async function reapplyRuleAction(ruleId: string): Promise<ActionResult<BulkMutationData>> {
  try {
    const parsed = z.string().min(1).parse(ruleId);
    const result = retroApplyRule(getDb(), parsed);
    revalidateRules();
    return { ok: true, data: result };
  } catch (error: unknown) {
    return fail(error);
  }
}
